/**
 * The AI dispatcher's turn loop.
 *
 * One keyed transmission in, at most one spoken reply out:
 *
 *   packets → transmission → clip → transcript → decision → tool → reply → air
 *
 * Every stage is allowed to decide the turn is over. Most radio traffic is units
 * talking to each other, so "say nothing" is the common outcome and never an
 * error — a dispatcher that answers things it was not asked is worse than one
 * that misses a call.
 *
 * A channel runs one turn at a time, because a dispatcher has one mouth. Units
 * who key up mid-turn are queued rather than dropped, and named to the model on
 * the following turn so they get answered instead of ignored — the closest we can
 * get to "standby" without talking over ourselves.
 *
 * Everything heard on a monitored channel is logged to that channel's history,
 * including traffic not addressed to the dispatcher, because that is what makes
 * the second transmission of an exchange comprehensible. Only addressed traffic —
 * or a reply from a unit the dispatcher just spoke to — actually runs a turn.
 *
 * Nothing here runs on the voice path's tick beyond appending a string to an
 * array. The turn itself is async and independent, so a slow provider delays a
 * reply and nothing else.
 */

import {
  type AnsweredCall,
  answeredByCaller,
  answeredCount,
  answeredOn,
  forgetCall,
  isAnsweredCall,
  noteAnswered,
  resetCalls,
} from "./calls";
import { noteTurn, resetBudget, turnAllowed } from "./budget";
import {
  aiConfig,
  applyAiConfig,
  endpointFor,
  monitorsFrequency,
  providerPlan,
  resetAiConfig,
} from "./config";
import {
  clearExpectation,
  clearWaiting,
  expectReplyFrom,
  forgetChannel,
  history,
  isExpected,
  noteWaiting,
  recordHeard,
  recordSaid,
  resetConversations,
  waiting,
} from "./conversation";
import { buildDirectory, type ChannelEntry } from "./directory";
import { aiLog } from "./logger";
import { outcomeReadback } from "./outcome-reply";
import { humanDispatcherOn, humanDispatcherPresent } from "./presence";
import {
  addressesAnotherUnit,
  addressesDispatcher,
  buildCallTakerPrompt,
  buildOutcomePrompt,
  buildSystemPrompt,
  buildTurnPrompt,
  callTranscriptionBias,
  echoesInstructions,
  echoesTheQuestion,
  isBareCallUp,
  isTrafficSignal,
  opensWithOwnCallsign,
  transcriptionBias,
  unitNamedIn,
} from "./prompt";
import { provider } from "./provider";
import { createReadiness, hasAudience } from "./readiness";
import { saysTheSameThing } from "./repeat";
import { buildRoster, type Point, type RosterUnit, type UnitInfo } from "./roster";
import { recordedSelfReport } from "./self-report";
import { airReply, resetSpeaker, warmSpeech } from "./speak";
import { closeStation, forgetStation, stationId, syncStation } from "./station";
import { callLuaSafely, describeTools, isLiftedExample, resolveTool, runTool } from "./tools";
import * as tradio from "./tradio-hooks";
import { describeTurn, finishTurn, recordOutcomes, startTurn, type TurnJournal } from "./turnlog";
import type { AiCallInfo, AiOutcome, AiTurnContext, AudioClip } from "./types";
import { registerWeightsCommand, resetWeights, syncWeights, weightsState } from "./weights";

type Call911 = tradio.Call911;
type Transmission = tradio.Transmission;

/** How often the tap, the station and the engines are brought in line with the config and with tRadio. */
const SWEEP_MS = 500;

/**
 * How long a unit waits before being told to stand by.
 *
 * Set at the point where silence stops reading as "thinking" and starts reading
 * as "nobody is there". A dispatcher who has not answered in a second has not
 * heard you, as far as the unit is concerned, and the second transmission of the
 * same traffic is what follows.
 *
 * Deliberately longer than the whole of the no-model path — a bare call-up airs
 * in about a second — so the quick answers never collide with a hold.
 */
const STALL_MS = 1200;

/**
 * How long a unit waits before a hold is worth saying at all.
 *
 * `STALL_MS` is when the hold is PREPARED; this is the floor under saying it, and the
 * two are different because the hold turned out to be the single most repetitive thing
 * the dispatcher does. Decode has never come back under 1.2 s, so a hold fired on
 * every turn: "King 41, stand by" before all seven transmissions of a traffic stop.
 *
 * Counted in `assets/reference/real-radio-traffix.txt`, "stand by" and "standby"
 * appear **8 times in 4,183 transmissions — 0.2%**. A real dispatcher does not fill
 * every gap; radio silence for a few seconds is ordinary and carries no meaning. A
 * hold on every turn is therefore not realism, it is a tell, and it costs about two
 * seconds of airtime each time on a channel where airtime is capacity.
 *
 * So the hold is reserved for when it means something — see `worthHolding`.
 */
const HOLD_AFTER_MS = 4000;

/**
 * Is "stand by" worth saying to this unit, on this turn?
 *
 * Two cases, and both are times the phrase carries information rather than filling a
 * gap:
 *
 *  - **Somebody else is waiting.** "Stand by" then means what it says — I heard you,
 *    I am working through traffic — which is exactly when a real dispatcher says it.
 *  - **The wait is genuinely long** (`HOLD_AFTER_MS`). Past a few seconds a unit
 *    starts to assume they were not heard and keys again, and the hold is cheaper
 *    than the re-transmission it prevents.
 *
 * Otherwise the channel stays quiet and the answer arrives when it arrives, which is
 * what the reference corpus does 99.8% of the time.
 */
function worthHolding(frequency: number, waitedMs: number): boolean {
  if (waiting(frequency).length > 0) return true;
  return waitedMs >= HOLD_AFTER_MS;
}

/** Frequencies with a turn in flight. A dispatcher has one mouth. */
const busy = new Set<number>();

/**
 * Transmissions that arrived while their channel was busy.
 *
 * Still shallow — replaying stale traffic minutes later is worse than having missed
 * it, and `MAX_QUEUE_AGE_MS` is the other half of that. Raised from 2 to 4 on
 * 2026-10-04 against a measured 20-unit channel, where a depth of two left 12 of 20
 * units never answered once across three minutes.
 *
 * Depth is the smaller half of that fix; **which transmission is sacrificed is the
 * larger one.** See `onTransmission`.
 */
const MAX_QUEUED = 4;
const queues = new Map<number, Transmission[]>();

/** Positions are read from the game, so they are cached for the length of a turn. */
const POSITION_TTL_MS = 2000;
const positions = new Map<number, { at: number; point: Point | null }>();

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let installed = false;

/**
 * How many units' stock phrases are synthesised ahead of time.
 *
 * Five lines each — see `stockPhrasesFor` — and each one is a Piper spawn running
 * alongside a model load. A channel with thirty units on it does not want a
 * hundred and fifty Piper runs before it will answer anybody, and the units that
 * will key up first are the ones already sitting on it.
 *
 * Six of them plus the two 911 lines is 32 entries, which is what `speak.ts`'s
 * `SPEECH_CACHE_MAX` has to clear: below that, warming evicts its own earliest
 * entries and the first units on the channel pay for a cache miss anyway.
 */
const WARM_UNITS = 6;

/**
 * The two lines the dispatcher says to a unit before it has decided anything.
 *
 * Built here rather than written out at each use because pre-warming them is
 * keyed on the exact text: a hold that said "stand by" where the warm said
 * "standby" would miss its own cache entry and be slower than doing nothing.
 */
const holdLine = (name: string) => `${name}, stand by`;
const goAheadLine = (name: string) => `Go ahead, ${name}`;
/**
 * What a unit hears when an action did not work.
 *
 * Fixed, and generated from nothing, because the alternative put a tool's
 * internal message on the air. Measured 2026-10-04 on the shift script: a status
 * tool that validated its input refused a plate number, and the unit who had
 * asked for a plate check heard "Copy, King 22, status too long." That is a
 * developer's sentence read out as radio traffic, and it is worse than the silent
 * wrong data it replaced.
 *
 * The reason it cannot be fixed by asking the model for better wording: the
 * failure text is in the outcome prompt, and a small model repeats the concrete
 * string it is shown. The same lesson is recorded three times in `prompt.ts`.
 *
 * The real reason stays in the journal (`journal.actions[].message`) and in the
 * dropped list, which is where an operator looks and where a unit cannot hear it.
 */
const negativeLine = (name: string) => `${name}, negative`;
/**
 * The smallest honest transmission there is.
 *
 * Substituted when the model's reply would repeat something just said. It claims
 * nothing beyond "heard you", which is the only claim still safe to make at that
 * point, and a second "copy" on a channel is ordinary radio rather than a tell.
 */
const copyLine = (name: string) => `${name}, copy`;
const tenFourLine = (name: string) => `${name}, 10-4`;
const stockPhrasesFor = (name: string) => [
  holdLine(name),
  goAheadLine(name),
  negativeLine(name),
  copyLine(name),
  tenFourLine(name),
];

/** How many of the dispatcher's own recent lines a new one is checked against. */
const REPEAT_LOOKBACK = 3;

/**
 * Has the dispatcher just said this?
 *
 * The failure this exists for, measured on `--only shift`: three unrelated
 * transmissions in one run were all answered "copy, K<unit>, you still there". That
 * is the loop `probe-echo-loop.ts` was written for, which was diagnosed as the 1.7B
 * model and fixed by moving to the 4B — and the 4B does it too, once a shift has
 * accumulated enough history for a phrase to look like the thing it says here.
 *
 * `collapseOwnRepeats` already removes consecutive duplicates from the PROMPT so
 * the pattern is not reinforced, and that was not enough: it shapes what the model
 * is shown and cannot stop what it writes. This is the other half, on the way out.
 *
 * Compared with `saysTheSameThing`, so a reworded repeat counts — the loop does not
 * always come back byte-identical.
 */
/**
 * A bare acknowledgement that is not the one just used.
 *
 * The substitutions above all reached for `copyLine`, and three of them in a row
 * produced "King 41, copy" three times — trading the loop they were added to stop
 * for a loop of their own. Real traffic alternates: in
 * `assets/reference/real-radio-traffix.txt`, acknowledgements are 35% `copy` and 33%
 * `10-4`, so the two are near-interchangeable on a real channel and picking the one
 * not just said is both honest and more realistic than either alone.
 *
 * Falls back to `copy` when both have been said recently. Two identical bare
 * acknowledgements are ordinary radio; the point is not to make them impossible,
 * only not to manufacture them.
 */
function bareAck(frequency: number, name: string): string {
  const first = copyLine(name);
  if (!repeatsRecentLine(frequency, first)) return first;
  const second = tenFourLine(name);
  return repeatsRecentLine(frequency, second) ? first : second;
}

function repeatsRecentLine(frequency: number, line: string): boolean {
  if (!line.trim()) return false;
  const mine = history(frequency)
    .filter((entry) => entry.own)
    .slice(-REPEAT_LOOKBACK);
  return mine.some((entry) => saysTheSameThing(entry.text, line));
}

/**
 * The two fixed lines of a 911 call, said without asking the model anything.
 *
 * The greeting is the whole of the dispatcher's first turn. There is nothing to
 * decide — nobody has said anything yet — so generating it would be several
 * seconds of silence on a line somebody dialled in an emergency, in exchange for
 * a sentence that is the same every time on every real call-taking floor.
 *
 * The hold is the call's equivalent of "stand by", and it is name-free for a
 * reason: on the radio the unit's callsign is how they know the hold was meant
 * for them, and a caller has no callsign. What it says instead is the only thing
 * that matters while they wait, which is that the line is still open.
 *
 * Both are pre-warmed, so both cost one cache lookup rather than a Piper spawn.
 */
const CALL_GREETING = "Nine one one, what is your emergency?";
const CALL_HOLD = "Stay on the line with me.";

/**
 * How many 911 calls the dispatcher will be on at once.
 *
 * One, and not as a placeholder. A call is a channel with a turn loop on it, and
 * two live calls means two model decodes racing for the same cores — which on a
 * CPU-only box does not halve the latency of one call, it roughly doubles the
 * latency of both. A second caller waiting in the queue for thirty seconds and
 * then being answered properly is a better call than two answered at once and
 * neither listened to.
 */
const MAX_ANSWERED_CALLS = 1;

/** Milliseconds between checks for the caller's client joining the line. */
const CALL_JOIN_POLL_MS = 100;

/**
 * How long the greeting waits for the caller's client to actually join.
 *
 * Accepting a call tells the caller's client to switch to the call's frequency;
 * it does not do it. Anything aired before that lands on a channel with nobody
 * on it and is simply lost, and the caller hears an answered call that opens
 * with silence. Well inside `calls911`'s own 20 s answer watchdog, which is what
 * handles a client that never arrives at all.
 */
const CALL_JOIN_WAIT_MS = 6000;

/**
 * How long picking up waits for the caller's client to be reachable at all.
 *
 * A step before {@link CALL_JOIN_WAIT_MS}: that one waits for the caller to join
 * the line, this one waits for them to have a socket to be told about it on. Ten
 * seconds because the client's own connection-info fetch polls on a 2 s beat
 * before the socket is even opened, and it is well inside the queue's 5-minute
 * timeout — a caller rings for a few seconds longer, which is what a real 911
 * call does anyway.
 */
const CALLER_CONNECT_WAIT_MS = 10_000;

/**
 * Channels the dispatcher listens to: the configured ones, plus any live call.
 *
 * A call's frequency is minted at runtime and is in no config file, so every
 * gate that asks `monitorsFrequency` would refuse the caller's own voice. Not
 * folded into `monitorsFrequency` itself, because that function answers a
 * question about configuration and is what `directory()` builds the channel list
 * from — a call appearing there would put a member of the public in the radio
 * system's channel directory, on every unrelated turn.
 */
function monitored(frequency: number): boolean {
  return monitorsFrequency(frequency) || isAnsweredCall(frequency);
}

const readiness = createReadiness(async () => {
  // Start independent local engines together, before a unit keys up. Never send
  // a synthetic request to a paid provider just to warm a local channel.
  const config = aiConfig();
  const plan = providerPlan();
  // A local engine cannot be warmed before its model files exist, and on a fresh
  // install they never do — the weights are a 2.5 GB download the operator opts
  // into from the admin panel. Starting them anyway is what produced "no local
  // text model installed" / "no local transcription model installed" on first
  // launch: a warning about the absence of something nobody asked for yet.
  //
  // `ready` also covers the all-hosted setup, where there is nothing to fetch
  // (see syncWeights), so this does not skip warming for an operator on keys.
  const localReady = weightsState().state === "ready";
  await Promise.all([
    ...(["transcription", "text"] as const)
      .filter((capability) => !plan[capability].hosted && localReady)
      .map((capability) => endpointFor(capability)),
  ]);

  // Speech last, and only when it is local. A hosted voice bills per character
  // and its first call is a network round trip, not a model load — there is
  // nothing to warm and it would be someone's money spent on silence.
  if (plan.speech.hosted) return;
  // Same reason as above, for the same first launch: no voice on disk means
  // there is nothing to warm, not that warming failed.
  if (!localReady) return;
  const names: string[] = [];
  for (const frequency of config.channels) {
    for (const unit of rosterFor(frequency, null)) {
      const name = unit.callsign || unit.unitId;
      if (name && !names.includes(name)) names.push(name);
      if (names.length >= WARM_UNITS) break;
    }
    if (names.length >= WARM_UNITS) break;
  }
  // The call lines first when the dispatcher takes calls, because they are the
  // ones with no fallback. A unit who waits on a cold "stand by" is a unit on a
  // radio; a caller who waits on a cold greeting has dialled 911 and heard
  // nothing back, and that is the first second of the call.
  const lines = config.answer911 ? [CALL_GREETING, CALL_HOLD] : [];
  lines.push(...names.flatMap(stockPhrasesFor));
  await warmSpeech(lines, config.voiceGender, AbortSignal.timeout(60_000));
});

function syncReadiness(): void {
  const config = aiConfig();
  const covered = config.enabled ? config.channels.filter((frequency) => !yielding(frequency)) : [];
  readiness.update(
    hasAudience(
      covered,
      covered.flatMap((frequency) => tradio.usersOn(frequency)),
      tradio.isStationId,
    ),
  );
}

function channelName(frequency: number): string {
  return tradio.channels().find((channel) => channel.frequency === frequency)?.name ?? "";
}

function native(name: string, ...args: unknown[]): any {
  const fn = (globalThis as any)[name];
  return typeof fn === "function" ? fn(...args) : undefined;
}

/**
 * Server-read position, never a client-reported one.
 *
 * Same route `scanner.ts` takes for scanner reach, for the same reason: a unit
 * that could report its own position to the dispatcher could report itself onto
 * every call in the city.
 */
function playerPoint(serverId: number): Point | null {
  const now = Date.now();
  const cached = positions.get(serverId);
  if (cached && now - cached.at < POSITION_TTL_MS) return cached.point;

  let point: Point | null = null;
  try {
    const ped = native("GetPlayerPed", String(serverId));
    const xyz = ped && native("GetEntityCoords", ped);
    if (xyz) {
      const [x, y] = Array.isArray(xyz) ? xyz : [xyz.x, xyz.y];
      if (Number.isFinite(x) && Number.isFinite(y)) point = { x, y };
    }
  } catch {
    /* No position is a knowable answer: the roster says "position unknown". */
  }
  positions.set(serverId, { at: now, point });
  return point;
}

const IDENTITY_TTL_MS = 2000;
const identities = new Map<number, { at: number; callsign: string; unitId: string }>();

/** Who a unit is, read from tRadio at most once per turn's worth of time. */
function identity(serverId: number): { callsign: string; unitId: string } {
  const now = Date.now();
  const cached = identities.get(serverId);
  if (cached && now - cached.at < IDENTITY_TTL_MS) return cached;
  const fresh = {
    at: now,
    callsign: tradio.playerName(serverId),
    unitId: tradio.unitId(serverId),
  };
  identities.set(serverId, fresh);
  return fresh;
}

/** Callsign, unit id, last status and whatever a CAD wants to add. */
function unitInfo(serverId: number): UnitInfo {
  const extra = callLuaSafely<unknown>("getUnitInfo", [serverId], null);
  const record = (extra ?? {}) as Record<string, unknown>;
  return {
    // tRadio's player name already is the callsign when its callsign system is on.
    callsign: identity(serverId).callsign,
    unitId: identity(serverId).unitId,
    status: typeof record.status === "string" ? record.status.slice(0, 48) : "",
    note: typeof record.note === "string" ? record.note.slice(0, 120) : "",
    point: playerPoint(serverId),
  };
}

function rosterFor(frequency: number, origin: Point | null): RosterUnit[] {
  return buildRoster(frequency, tradio.usersOn(frequency), unitInfo, origin);
}

/**
 * The whole system as the dispatcher sees it, rebuilt each turn.
 *
 * Rebuilt rather than cached because everything in it moves: units join
 * channels, alerts go up, patches come and go. It is a walk over the zone
 * configuration and a handful of map lookups, once per spoken reply.
 */
function directory(origin: Point | null): ChannelEntry[] {
  const live = tradio.patches();
  const zones: Record<
    string,
    { name: string; Channels: Array<{ frequency: number; name: string }> }
  > = {};
  for (const channel of tradio.channels()) {
    const zone = zones[channel.zoneName] ?? { name: channel.zoneName, Channels: [] };
    zones[channel.zoneName] = zone;
    zone.Channels.push({ frequency: channel.frequency, name: channel.name });
  }
  return buildDirectory({
    zones,
    monitors: monitorsFrequency,
    roster: (frequency) => rosterFor(frequency, origin),
    alertOn: tradio.alertOn,
    patchOf: (frequency) =>
      live
        .filter((patch) => patch.frequencies.includes(frequency))
        .flatMap((patch) => patch.frequencies),
  });
}

function transmissionContext(transmission: Transmission, transcript: string): AiTurnContext {
  const { serverId, frequency } = transmission;
  const info = unitInfo(serverId);
  return {
    trigger: "transmission",
    serverId,
    callsign: info.callsign,
    unitId: info.unitId,
    frequency,
    channelName: channelName(frequency),
    transcript,
    // Distances are measured from the unit who called, which is the reference a
    // dispatcher actually uses when asked to send someone else to them.
    roster: rosterFor(frequency, info.point),
    history: history(frequency),
    waiting: waiting(frequency).filter((name) => name !== info.callsign),
    channels: directory(info.point),
  };
}

function callContext(frequency: number, call: AiCallInfo, origin: Point | null): AiTurnContext {
  return {
    trigger: "call",
    serverId: 0,
    callsign: "",
    unitId: "",
    frequency,
    channelName: channelName(frequency),
    transcript: "",
    roster: rosterFor(frequency, origin),
    history: history(frequency),
    waiting: waiting(frequency),
    channels: directory(origin),
    call,
  };
}

/**
 * A turn on a 911 call the dispatcher answered.
 *
 * The caller is the talker, and everything the radio context carries about the
 * radio is deliberately empty rather than merely unused. A roster on a call
 * frequency is two entries — the caller and the dispatcher's own console — and
 * the channel directory is the whole radio system, which is a page of prompt
 * spent every turn telling a call-taker about channels the person on the line
 * has never heard of. Both are latency with no answer behind it.
 *
 * `history` is per-frequency and works unchanged, which is the part that makes
 * this a conversation rather than a series of unrelated questions.
 */
function callIntakeContext(entry: AnsweredCall, transcript: string): AiTurnContext {
  return {
    trigger: "call_intake",
    serverId: entry.callerServerId,
    callsign: entry.info.caller,
    unitId: "",
    frequency: entry.frequency,
    channelName: `911 call from ${entry.info.caller || "a caller"}`,
    transcript,
    roster: [],
    history: history(entry.frequency),
    waiting: [],
    channels: [],
    call: entry.info,
  };
}

/**
 * The server's own standing orders for its dispatcher.
 *
 * Whatever `Config.instructions` returns — "if a unit calls a pursuit,
 * put SIGNAL 100 up", "units on OPS-2 are fire, not police", anything. Asked per
 * turn and given the context, so guidance can differ by channel or by who is
 * talking. Layered underneath tRadio's own rules by `buildSystemPrompt`, never
 * in place of them.
 */
function operatorInstructions(context: AiTurnContext): string {
  const raw = callLuaSafely<unknown>("getInstructions", [context], "");
  return typeof raw === "string" ? raw : "";
}

/** True when a human dispatcher is signed on to this channel and we should stay off it. */
function yielding(frequency: number): boolean {
  if (!aiConfig().yieldToDispatcher) return false;
  return humanDispatcherOn(frequency, tradio.stations().humans);
}

/**
 * Decide, act, and say the result. Shared by keyed traffic and calls.
 *
 * The shape here is a radio's, not a function's: **acknowledge, act, report
 * back.** The dispatcher answers the unit with what it heard, runs what was
 * asked for, and comes back on the air only if the outcome says something the
 * acknowledgement did not.
 *
 * It used to run the other way — decide, act, rewrite the reply against the
 * outcome, then say the rewritten one — and that put two sequential generations
 * in front of the first word the unit hears. Measured on 2026-09-19 with
 * `scripts/probe-turn-latency.ts`, a warm turn that ran a tool spent 5.2 s
 * deciding and a further 1.3 s rewriting before synthesis even began, for 7.4 s
 * end to end. Worse, the rewrite was not an improvement: on every measured turn
 * it addressed the unit by codeplug id rather than callsign, and twice it said
 * "go" — *go ahead*, asking a unit to repeat traffic it had already given.
 *
 * The reply is still handed over mid-generation (see `decide`'s `onDraftReply`) and
 * the outcome still generates during the decision's own decode tail, so neither
 * stage waits on the other.
 *
 * **What changed 2026-10-04: the acknowledgement is no longer AIRED early, and on a
 * turn that reports an outcome it is not aired at all.** It used to go out the
 * instant its closing quote arrived, which was right when it was the first word a
 * unit heard. It is not: the hold fires at `STALL_MS` and the model has never beaten
 * it, so streaming the acknowledgement bought a second transmission rather than a
 * faster one — "10-4 K13" and then "King 13 is now showing 10-6", eight seconds of
 * airtime for one fact. On a channel that cannot keep up, airtime is capacity. One
 * substantive transmission a turn; the airing block below has the measurements.
 *
 * What that costs, stated plainly: the substance lands about 1.4 s later than the
 * draft would have. What a unit hears first is unchanged, because that was already
 * the hold.
 */
async function respond(
  context: AiTurnContext,
  signal: AbortSignal,
  journal: TurnJournal,
  /** Push the turn's deadline out by the length of audio just put on the air. */
  allowAirtime: (ms: number) => void,
): Promise<void> {
  const config = aiConfig();
  const onCall = context.trigger === "call_intake";
  const system = onCall
    ? buildCallTakerPrompt(config.callsign, operatorInstructions(context))
    : buildSystemPrompt(
        config.callsign,
        operatorInstructions(context),
        config.tenCodes,
        // Already resolved to a known key by `demeanorKey`, so this is a lookup and
        // not a decision. The call-taker prompt deliberately gets none of it: a radio
        // manner is wrong on a phone line, where almost every rule inverts.
        config.demeanor,
      );
  const tools = describeTools(context);

  const decisionStarted = Date.now();

  /**
   * The acknowledgement, aired from inside the decision rather than after it.
   *
   * This is the single largest saving in the turn and it is worth being explicit
   * about why it is safe. The reply is the *first* thing the model writes — the
   * prompt is ordered to make it so — and `draftReply` only hands it over once
   * its closing quote has arrived, so the text is final, not a fragment. What is
   * still decoding behind it is the tool call, and no part of the
   * acknowledgement depends on the tool call: "King 41, copy" answers the unit's
   * transmission, not the outcome of acting on it.
   *
   * Measured 2026-09-19: the reply was complete 2.96 s into a warm turn and the
   * decision finished at 5.27 s, and across six turns the finished reply was
   * byte-identical to the draft every time. Waiting for the decision meant
   * sitting on ready audio for 2.3 s.
   *
   * Not awaited here. The transmission runs while the tools do.
   */
  let acknowledged = "";

  /**
   * "King 41, stand by." — said while the model is still writing.
   *
   * Not a trick borrowed from chatbots; it is the line a real dispatcher uses
   * for exactly this situation, which is why it is safe to say. It claims
   * nothing, commits to nothing, and tells the unit they were heard — and being
   * heard within a second is most of what a unit wants from a radio.
   *
   * Armed on a timer rather than always, so it costs nothing where it is not
   * needed. A provider that answers inside {@link STALL_MS} — a hosted model, or
   * a smaller local one — never fires it and the channel stays as terse as it
   * was. On this box, at three or four tokens a second, it fires every time and
   * turns a twelve-second silence into a one-second answer with the real one
   * behind it.
   *
   * Cancelled the instant a draft arrives, and the draft queues behind it rather
   * than being dropped, which is what `claimChannel` in `speak.ts` is for.
   */
  let stalling: Promise<boolean> | null = null;
  const holdName = context.callsign || context.unitId;
  // A call always holds; a transmission holds only when there is a name to hold
  // with, since "stand by" to nobody in particular is a dispatcher talking to
  // the channel. The call's line needs no name — see {@link CALL_HOLD}.
  const held = onCall
    ? CALL_HOLD
    : context.trigger === "transmission" && holdName
      ? holdLine(holdName)
      : "";
  const armedAt = Date.now();
  const stallTimer = held
    ? setTimeout(() => {
        // Armed at `STALL_MS`, said only if it is worth saying. A call always holds —
        // somebody frightened on an open line needs to know it is still open — but on
        // the radio the phrase is reserved for the cases `worthHolding` names, because
        // a hold on every turn is a tell rather than realism.
        if (!onCall && !worthHolding(context.frequency, Date.now() - armedAt)) {
          journal.dropped.push(`hold "${held}" not said — nobody waiting and the gap was short`);
          return;
        }
        const line = held;
        journal.held = line;
        const speechStarted = Date.now();
        stalling = airReply(context.frequency, line, config.voiceGender, signal, (aired) => {
          journal.responseStartMs ??= Date.now() - journal.at;
          journal.stages.hold = Date.now() - speechStarted;
          journal.airedMs += aired;
          allowAirtime(journal.airedMs);
        });
      }, STALL_MS)
    : null;

  const decision = await provider().decide(
    system,
    buildTurnPrompt(context, tools),
    tools,
    signal,
    (draft) => {
      journal.stages.draft = Date.now() - decisionStarted;
      if (stallTimer) clearTimeout(stallTimer);
      if (echoesInstructions(draft, system)) {
        journal.dropped.push(`reply "${draft}" — copied out of the dispatcher's own instructions`);
        aiLog.warn("turn: reply was a line from the prompt, not an answer — saying nothing");
        return;
      }
      // A repeat is replaced rather than dropped: the hold has already told this
      // unit to stand by, and following that with silence is a promise broken. A
      // bare "copy" closes the exchange and cannot itself be the loop.
      let spoken = draft;
      // A question handed back is not an answer. Substituted with the bare
      // acknowledgement real dispatchers use 42% of the time — see
      // `echoesTheQuestion`, and `scripts/dispatch-style.ts` for the measurement.
      // Checked before the repeat guard so the bare form it produces is what the
      // repeat guard then sees.
      if (echoesTheQuestion(context.transcript, draft)) {
        spoken = bareAck(context.frequency, context.callsign || context.unitId || "All units");
        journal.dropped.push(`reply "${draft}" — handed the question back`);
      }
      if (repeatsRecentLine(context.frequency, spoken)) {
        spoken = bareAck(context.frequency, context.callsign || context.unitId || "All units");
        journal.dropped.push(`reply "${draft}" — the same thing it had just said`);
        aiLog.warn(`turn: reply repeated a recent transmission — saying "${spoken}" instead`);
      }
      // Chosen here, aired later — see the airing block below. This used to go out
      // the moment the reply's closing quote arrived, which was right when the reply
      // was the first word a unit heard. It no longer is: the hold fires at
      // `STALL_MS` and the model has not once beaten it, so streaming this bought a
      // second transmission rather than a faster one.
      acknowledged = spoken;
    },
    (raw) => {
      journal.decided = raw;
    },
    onCall ? "call" : "radio",
  );
  journal.stages.decision = Date.now() - decisionStarted;
  // A decision that finished without ever producing a draft — a provider that
  // will not stream — must not leave the hold armed to fire into the reply.
  if (stallTimer) clearTimeout(stallTimer);
  // Awaited before anything else is put on the air. The queue would order them
  // correctly either way; this is so the journal's own timings stay honest.
  //
  // The answer is kept, because a turn can end having said nothing BUT the hold —
  // a decision that came back empty, or an outcome that would not compose — and
  // "stand by" is still a transmission to this unit. See the tail of this function.
  const heldAired = stalling ? await stalling : false;

  let reply = decision.reply;
  journal.drafted = decision.reply;
  const outcomes: AiOutcome[] = [];

  /**
   * A self-report the model classified and then found no tool for — see
   * `self-report.ts`, which is where every condition and every measurement is.
   *
   * Only ever an addition to an EMPTY list, and the value goes through the same gate
   * `runTool` applies, so this cannot act on a turn the model acted on and cannot put a
   * value through that the model's own call could not. Logged when it fires, because a
   * status nobody chose should be as readable in the journal as one that was.
   */
  const chosen = [...decision.actions];
  const recorded = recordedSelfReport(decision, context, tools);
  if (recorded) {
    chosen.push(recorded);
    aiLog.info(
      `turn: ${recorded.tool}("${recorded.input}") recorded from kind="${decision.kind}" ` +
        "— the model classified the report and chose no tool",
    );
  }

  // Run in the order the model listed them. A dispatcher who patches two
  // channels and then puts traffic out on the patch is doing it in that order
  // for a reason, and the second action often only makes sense after the first.
  for (const action of chosen) {
    const tool = resolveTool(action.tool, tools);
    if (!tool) continue;
    if (isLiftedExample(tool, action.input, context.transcript)) {
      journal.dropped.push(`${tool.id}(${action.input}) — copied from the tool's own description`);
      aiLog.warn(`turn: ${tool.id} given "${action.input}", which nobody said — dropped`);
      continue;
    }
    const result = await runTool(tool, action.input, context);
    aiLog.info(
      `[audit] ai:action tool=${tool.id} input=${JSON.stringify(action.input)} ` +
        `unit=${context.callsign || context.serverId} freq=${context.frequency} ok=${result.ok}`,
    );
    outcomes.push({
      tool: tool.id,
      input: action.input,
      ok: result.ok,
      message: result.message,
      fault: result.fault,
    });
  }

  recordOutcomes(journal, outcomes);

  if (reply && echoesInstructions(reply, system)) {
    journal.dropped.push(`reply "${reply}" — copied out of the dispatcher's own instructions`);
    aiLog.warn(`turn: reply was a line from the prompt, not an answer — saying nothing`);
    reply = "";
  }

  // The report-back, started now rather than after the acknowledgement so it
  // generates *during* several seconds of transmission instead of after it. Not
  // awaited here: whether it is worth airing is a question for once the
  // acknowledgement is done.
  //
  // `statusOutcomeReply` answers without a model at all when a single status
  // change is the whole of the turn, which is the common case and is free.
  // A hang-up that worked is not reported back.
  //
  // Every other tool changes something the speaker cannot see — a status, a
  // patch, an alert — so the outcome is news. `hang_up` is the opposite: the
  // model asked for it *because* it had decided to close, and the draft it
  // wrote in the same breath is the closing. Measured 2026-09-21, composing
  // anyway spent 3.9 s and put a second "help is on the way" on a line that had
  // already been told, doubling a closing turn's airtime to 16.5 s. A hang-up
  // that *failed* still reports: the line is still up and the caller has just
  // been told goodbye.
  const reportable = outcomes.filter((outcome) => !(outcome.tool === "hang_up" && outcome.ok));
  const confirmed =
    reportable.length > 0 ? outcomeReadback(reportable, context.callsign || context.unitId) : null;
  const composeStarted = Date.now();
  const reporting: Promise<string> | null =
    reportable.length === 0
      ? null
      : confirmed !== null
        ? Promise.resolve(confirmed)
        : provider()
            .compose(system, buildOutcomePrompt(context, reportable), signal)
            .then((composed) => {
              journal.stages.compose = Date.now() - composeStarted;
              return composed;
            })
            .catch((err: unknown) => {
              // Never a rejection out of here: this runs unawaited for the whole
              // of the acknowledgement, and an unhandled one would take the
              // process rather than the turn.
              aiLog.debug(`turn: outcome reply failed — ${(err as Error).message}`);
              journal.skipped = `the outcome could not be put into words — ${(err as Error).message}`;
              return "";
            });

  journal.reply = reply;

  /**
   * ONE substantive transmission a turn, and this is where that is decided.
   *
   * It used to be two whenever a tool ran: the model's acknowledgement went out the
   * moment its closing quote arrived, and the outcome followed as a second
   * transmission. Measured on `scripts/dispatch-load.ts`, that reads as
   *
   *     "10-4 K13"   then   "King 13 is now showing 10-6"
   *
   * which is about eight seconds of airtime for one fact. A real dispatcher merges
   * them — "K13, copy, 10-6" — and on a channel that cannot keep up, airtime IS
   * capacity: a 20-unit run spent 6.8 s of an 11 s turn transmitting and dropped 43%
   * of its traffic.
   *
   * So when the turn is going to report an outcome, the acknowledgement is not aired
   * at all and the outcome is the whole answer. Nothing is lost by dropping it: the
   * outcome names the unit and says what happened, and the unit was already told to
   * stand by. It also takes the model's own wording off the air on exactly the turns
   * where a deterministic readback exists, which is where the echoes lived.
   *
   * The cost, stated plainly: the substantive reply lands about 1.4 s later than the
   * draft would have (measured draft-to-decision across one load run). That was the
   * whole point of streaming the draft — but the hold fires at `STALL_MS` and the
   * model has not once beaten it, so the first word a unit hears is unchanged.
   */
  const willReport = reportable.length > 0;

  // The guards run here rather than in the draft callback for the non-streaming
  // case, so a provider that does not stream — every hosted one — gets them too.
  if (reply && !acknowledged) {
    if (echoesTheQuestion(context.transcript, reply)) {
      journal.dropped.push(`reply "${reply}" — handed the question back`);
      reply = bareAck(context.frequency, context.callsign || context.unitId || "All units");
    }
    if (repeatsRecentLine(context.frequency, reply)) {
      journal.dropped.push(`reply "${reply}" — the same thing it had just said`);
      reply = bareAck(context.frequency, context.callsign || context.unitId || "All units");
    }
  }
  // The draft's guards already ran in the callback; take what they settled on.
  if (acknowledged) reply = acknowledged;
  journal.reply = reply;

  if (!willReport && reply) {
    const speechStarted = Date.now();
    if (
      await airReply(context.frequency, reply, config.voiceGender, signal, (aired) => {
        journal.responseStartMs ??= Date.now() - journal.at;
        journal.stages.speechPreparation = Date.now() - speechStarted;
        journal.airedMs += aired;
        allowAirtime(journal.airedMs);
      })
    ) {
      journal.aired = true;
      recordSaid(context.frequency, config.callsign, reply);
    }
  } else if (willReport) {
    journal.dropped.push(`acknowledgement "${reply}" merged into the outcome`);
    // Cleared, because it never went on the air. Leaving it set made every consumer
    // of the journal report a transmission the unit did not hear: the harness
    // transcript showed the dispatcher saying both lines, and
    // `scripts/dispatch-style.ts` counted the withheld one in its vocabulary
    // statistics. The reply for this turn IS the outcome, recorded as `followUp`.
    journal.reply = "";
  }

  if (reporting) {
    const followUp = await reporting;
    // A failure is always said, however much it reads like what was already
    // acknowledged: the acknowledgement promised something that did not happen,
    // and leaving that standing is the one outcome worse than a redundant
    // transmission.
    const failed = outcomes.some((outcome) => !outcome.ok);
    // A failure says so in fixed words rather than in the model's, because the
    // model's are built from the tool's own failure message and it repeats them
    // verbatim. The unit needs to know it did not happen; they do not need, and
    // must not hear, the reason a validator gave.
    // Now the only transmission of the turn, so it stamps `responseStartMs` — the
    // acknowledgement used to and no longer airs. Without this a tool turn reports
    // "never aired" to every latency measurement in the project.
    const speechStarted = Date.now();
    const air = async (spoken: string): Promise<void> => {
      if (
        await airReply(context.frequency, spoken, config.voiceGender, signal, (aired) => {
          journal.responseStartMs ??= Date.now() - journal.at;
          journal.stages.speechPreparation ??= Date.now() - speechStarted;
          journal.airedMs += aired;
          allowAirtime(journal.airedMs);
        })
      ) {
        journal.aired = true;
        recordSaid(context.frequency, config.callsign, spoken);
      }
    };

    if (failed && onCall) {
      /**
       * A caller is never told "negative", and never told to go ahead.
       *
       * Both of the fixed failure lines below are radio, and the whole of
       * `buildCallTakerPrompt` exists because radio is the wrong register on a phone
       * line — "no radio codes, no callsigns, the person on this line does not know
       * any of them". `context.callsign` on a call is the CALLER'S NAME, so the
       * untreated path said "Maria Ortiz, negative" to a frightened member of the
       * public.
       *
       * A call has exactly one tool and it is `hang_up`, so a failure here means the
       * line is still open and the model's own closing words are still the right
       * thing to say. The outcome text is not used: `buildOutcomePrompt` wrote it
       * from the tool's complaint, and on this line that is nothing the caller can
       * act on.
       */
      if (followUp) journal.dropped.push(`outcome text withheld from the line: "${followUp}"`);
      if (reply) {
        journal.followUp = reply;
        await air(reply);
      } else {
        journal.skipped = "the action failed and there was nothing plain to say about it";
      }
    } else if (failed) {
      // Same name the hold uses, so a unit hears itself addressed the same way both
      // times in one turn.
      const name = context.callsign || context.unitId || "All units";
      /**
       * "Negative" is only honest when the WORLD said no.
       *
       * When every failure is an argument fault the tool never ran, and the request may
       * have been entirely actionable — so a negative is a false no to a true request.
       * Measured on the harness 2026-10-13 (BUG-69515): "send me another unit" produced
       * `assign_unit("another unit")`, the guard refused that placeholder, and the unit
       * was told "negative" while the other unit sat idle on the same channel. The
       * withheld outcome text even gave a reason that was not true ("no other unit
       * available"), because it was written from our validator's complaint.
       *
       * "Go ahead" is the honest line for it: the dispatcher did not catch the detail,
       * which invites the unit to say it again rather than telling them no. It is
       * already a stock phrase, so this adds no new wording to the channel.
       *
       * `every`, not `some`: a turn that genuinely failed at anything still says
       * negative, because something really did not happen.
       */
      const ourFaultOnly = outcomes.every((outcome) => outcome.ok || outcome.fault === "argument");
      const spoken = ourFaultOnly ? goAheadLine(name) : negativeLine(name);
      journal.followUp = spoken;
      if (followUp) journal.dropped.push(`outcome text withheld from the air: "${followUp}"`);
      await air(spoken);
    } else if (followUp && !echoesInstructions(followUp, system)) {
      journal.followUp = followUp;
      await air(followUp);
    } else if (reply) {
      // The outcome could not be put into words — a compose that failed or came
      // back empty. The acknowledgement was held back on the assumption an outcome
      // would be said instead, so without this the unit is told to stand by and
      // then hears nothing at all.
      journal.dropped.push("outcome produced no words — airing the acknowledgement instead");
      await air(reply);
    }
  }

  // Last, and only now. `hang_up` marked the call while the tools ran, several
  // awaits above this line, and every one of those awaits was the dispatcher
  // still speaking — the acknowledgement, then the outcome. Dropping the line at
  // the moment the tool ran would have cut the caller off part-way through being
  // told that help was coming, which is the one sentence on the whole call they
  // needed to hear.
  //
  // Not conditional on the closing words having aired. A reply that failed to
  // synthesise is a bad end to a call; a call left open because of it is a line
  // nobody is on that holds the dispatcher until a sweep notices.
  if (onCall) {
    const call = answeredOn(context.frequency);
    if (call?.closing && !tradio.end911(call.callId)) {
      aiLog.warn(
        `call: ${call.callId} could not be ended — the caller will hear the line stay open`,
      );
    }
    return;
  }

  /**
   * A hold counts, and it used to not.
   *
   * `journal.aired` is only set by a SUBSTANTIVE transmission, so a turn whose
   * decision came back empty — no reply, no action — returned here having told the
   * unit "King 41, stand by" and then armed nothing. Their next transmission
   * carries no wake phrase and no callsign, because they are answering us, so
   * `addressesDispatcher` dropped it and they stayed on the waiting list for the
   * full TTL. The unit's experience is being told to stand by and then ignored
   * twice.
   *
   * The hold is a promise to come back to them, which is exactly what an
   * expectation is for.
   */
  if (!journal.aired && !heldAired) return;
  if (context.serverId > 0) {
    // Having just spoken to them, their next transmission is a reply and needs
    // no wake phrase — which is the whole "Go ahead" / "…" / traffic exchange.
    //
    // Unless the dispatcher called somebody ELSE out, in which case they are the one
    // a reply is expected from: "King 41 copy, King 15 route, assisting King 41" is a
    // question to King 15, and their "10-4, I'm en route" carries no callsign and no
    // wake phrase. Before this, that reply was dropped as not addressed — the
    // dispatcher could not hear the answer to its own callout.
    const called = unitNamedIn(
      `${journal.reply} ${journal.followUp}`,
      context.roster,
      context.serverId,
    );
    expectReplyFrom(context.frequency, called ?? context.serverId);
    clearWaiting(context.frequency, context.serverId);
  }
}

/**
 * "King 41 to dispatch." — answered without a model.
 *
 * A call-up has exactly one correct answer and it is the same answer every time.
 * Measured on the offline harness: the 4B spent 8.1 s writing "Go ahead, King
 * 41" and the unit waited 9.3 s to hear the first word of it. Nothing in those
 * eight seconds was a decision.
 *
 * Returns true when it handled the turn. False means the transcript was traffic
 * after all, and `respond` runs exactly as before — {@link isBareCallUp} is
 * built to fail in that direction, since a call-up sent the slow way is only
 * slow, while traffic waved through with a go-ahead is the loop this whole area
 * has been fighting.
 *
 * Still a full turn in the journal, with the same fields in the same places, so
 * a fast answer and a generated one read the same in the log.
 */
async function answerCallUp(
  context: AiTurnContext,
  signal: AbortSignal,
  journal: TurnJournal,
  allowAirtime: (ms: number) => void,
): Promise<boolean> {
  const config = aiConfig();
  const name = context.callsign || context.unitId;
  if (!name) return false;
  // Two shapes, one answer. A hail names somebody and says nothing; a traffic signal
  // says "I have something" and still does not say what. Both get the go-ahead, and
  // neither is worth a decode — which on the realistic five-transmission protocol takes
  // the model out of three turns of every exchange.
  const callsigns = [name, config.callsign];
  const hailed = isBareCallUp(context.transcript, config.wakePhrases, callsigns);
  const signalled = !hailed && isTrafficSignal(context.transcript, config.wakePhrases, callsigns);
  if (!hailed && !signalled) return false;

  const reply = goAheadLine(name);
  journal.drafted = reply;
  journal.reply = reply;
  journal.addressedBy += signalled
    ? " (traffic signal, answered directly)"
    : " (call-up, answered directly)";

  const speechStarted = Date.now();
  const aired = await airReply(context.frequency, reply, config.voiceGender, signal, (ms) => {
    journal.responseStartMs ??= Date.now() - journal.at;
    journal.stages.speechPreparation = Date.now() - speechStarted;
    journal.airedMs += ms;
    allowAirtime(journal.airedMs);
  });
  if (!aired) {
    // Say nothing rather than fall through: the model would be asked to answer a
    // transmission that carried nothing, which is where "Go <callsign>" for
    // everything came from in the first place.
    journal.skipped = "could not air the go-ahead";
    return true;
  }

  journal.aired = true;
  recordSaid(context.frequency, config.callsign, reply);
  if (context.serverId > 0) {
    expectReplyFrom(context.frequency, context.serverId);
    clearWaiting(context.frequency, context.serverId);
  }
  return true;
}

/**
 * What a transcriber is handed. tRadio has already decoded the vocoder to a 16 kHz
 * WAV, or stitched the Opus chunks into one WebM; either is a whole file a hosted or
 * local recogniser reads as it is.
 */
function clipOf(transmission: Transmission): AudioClip {
  return transmission.container === "wav"
    ? { bytes: transmission.audio, mime: "audio/wav", filename: "transmission.wav" }
    : { bytes: transmission.audio, mime: "audio/webm", filename: "transmission.webm" };
}

async function runTurn(transmission: Transmission): Promise<void> {
  const config = aiConfig();
  const frequency = transmission.frequency;

  const clock = turnClock(config.turnTimeoutMs);
  const controller = clock.controller;
  const onCall = isAnsweredCall(frequency);
  const journal = startTurn(
    onCall ? "call_intake" : "transmission",
    frequency,
    transmission.serverId,
  );
  try {
    const clip = clipOf(transmission);
    // Described before anything reads it, so a turn that went wrong downstream
    // still says how much audio there was to go wrong with.
    journal.clip = {
      ms: Math.max(0, transmission.endedAt - transmission.startedAt),
      bytes: clip.bytes.length,
      encoding: `${transmission.codec || "audio"}/${transmission.container}`,
    };

    // The roster is read before the words exist, because the callsigns on the
    // channel are most of what stops the transcriber inventing one.
    const roster = onCall ? [] : rosterFor(frequency, null);
    // A caller has no callsign and is not on a channel, so the radio bias is
    // vocabulary for words nobody on this line will say — and an initial prompt
    // is a claim about what came before, not a hint. Telling the recogniser to
    // expect "King 41" on a 911 call is how a caller saying "I can't find him"
    // comes back as a unit number.
    const bias = onCall
      ? callTranscriptionBias(placesForCall(frequency))
      : transcriptionBias(
          config.wakePhrases,
          roster.map((unit) => unit.callsign).filter(Boolean),
          directory(null)
            .map((channel) => channel.name)
            .filter(Boolean),
          [],
          // The server's own codes, so the recogniser expects the tokens this channel
          // actually uses rather than the ones another agency does.
          config.tenCodes,
        );
    const transcribeStarted = Date.now();
    const transcript = await provider().transcribe(clip, controller.signal, bias);
    journal.stages.transcription = Date.now() - transcribeStarted;
    if (!transcript) {
      journal.skipped = "nothing was said, or speech-to-text heard nothing";
      return;
    }

    // A 911 call skips every gate below, and each one for its own reason. The
    // wake phrase: the caller is talking to the dispatcher by definition — there
    // is nobody else on the line to be talking to, and a caller who has to say a
    // magic word to be heard has dialled 911 and been ignored. The
    // addressed-to-another-unit check: there are no other units. And `yielding`:
    // a human dispatcher signing on takes the *next* call, never this one, so a
    // call already in progress is not theirs to be stood down for. That falls
    // out of `yielding` being per-frequency and a call frequency never having a
    // human on it, and is said out loud here because it is a decision, not an
    // accident — the alternative is hanging up on somebody mid-sentence to be
    // tidy.
    const answered = answeredOn(frequency);
    if (answered) {
      const callContextNow = callIntakeContext(answered, transcript);
      journal.heard = transcript;
      journal.addressed = true;
      journal.addressedBy = "on a 911 call";
      describeTurn(journal, callContextNow);
      journal.unit = answered.info.caller || answered.callId;
      recordHeard(frequency, callContextNow.callsign || "Caller", transcript);
      journal.historyTail = callContextNow.history
        .slice(-4)
        .map((entry) => `${entry.who}: "${entry.text}"`);
      await respond(callContextNow, controller.signal, journal, clock.allowAirtime);
      return;
    }

    const context = transmissionContext(transmission, transcript);
    journal.heard = transcript;
    describeTurn(journal, context);
    // Logged whoever it was for. Unit-to-unit traffic is not answered, but a
    // dispatcher who heard it knows things the next turn needs.
    recordHeard(frequency, context.callsign, transcript);

    // Evaluated separately rather than short-circuited into one boolean, purely
    // so the journal can say which one answered. They fail in opposite
    // directions and the log is useless if it cannot tell them apart.
    const byWakePhrase = addressesDispatcher(transcript, config.wakePhrases);
    // The expectation is not unconditional. A unit we just spoke to may well turn
    // round and call another unit, and answering that is how the dispatcher ends
    // up talking over traffic it was never part of.
    const toSomeoneElse = addressesAnotherUnit(
      transcript,
      roster
        .filter((unit) => unit.serverId !== transmission.serverId)
        .flatMap((unit) => [unit.callsign, unit.unitId])
        .filter(Boolean),
    );
    // The route that carries almost all realistic traffic. Real units lead with
    // their own number rather than hailing dispatch — measured at 0.45% saying
    // "dispatch" against 12.6% opening with a callsign in the reference corpus — so
    // without this the dispatcher ignored nearly everything a unit actually says.
    // Gated on `toSomeoneElse` exactly as the expectation route is, because
    // "King 41 to King 22" also opens with King 41's own callsign.
    const byOwnCallsign =
      !byWakePhrase &&
      !toSomeoneElse &&
      opensWithOwnCallsign(transcript, context.callsign, context.unitId);
    const byExpectation =
      !byWakePhrase &&
      !byOwnCallsign &&
      !toSomeoneElse &&
      isExpected(frequency, transmission.serverId);
    const addressed = byWakePhrase || byOwnCallsign || byExpectation;
    journal.addressed = addressed;
    journal.addressedBy = byWakePhrase
      ? "wake phrase"
      : byOwnCallsign
        ? "own callsign"
        : byExpectation
          ? "expected reply"
          : "";
    journal.historyTail = context.history.slice(-4).map((entry) => `${entry.who}: "${entry.text}"`);
    if (!addressed) {
      clearWaiting(frequency, transmission.serverId);
      journal.skipped = toSomeoneElse
        ? "addressed to another unit, not to dispatch"
        : "not addressed to dispatch";
      return;
    }

    // Re-checked after transcription, not only before: a dispatcher signing on
    // during the second a clip spends in STT is exactly the race the toggle
    // exists to lose gracefully.
    if (yielding(frequency)) {
      journal.skipped = "a human dispatcher is signed on to this channel";
      return;
    }

    // This turn consumes the expectation. Whether a new one is set depends on
    // whether we actually say something back.
    clearExpectation(frequency);
    if (await answerCallUp(context, controller.signal, journal, clock.allowAirtime)) return;
    await respond(context, controller.signal, journal, clock.allowAirtime);
  } catch (err) {
    const reason = controller.signal.aborted
      ? `timed out after ${config.turnTimeoutMs}ms`
      : (err as Error).message;
    journal.error = reason;
    aiLog.warn(`turn: abandoned on ${frequency} — ${reason}`);
  } finally {
    clock.clear();
    // Every path, including the ones that ended before deciding anything: a turn
    // that said nothing is the case most in need of an explanation.
    finishTurn(journal);
  }
}

/**
 * The abort clock a turn runs under. The budget covers thinking, not talking.
 *
 * It exists to stop a hung engine holding a channel, and a transmission being
 * paced onto the air packet by packet is not hung — it is the turn working.
 * Counting airtime against the same budget means a long answer aborts itself
 * partway through, which is measurably worse than the hang it guards against:
 * `airReply` returns false, the turn books itself as having said nothing after
 * seven seconds of audio, and because nothing "aired" the expectation that
 * answers the unit's *next* transmission is never armed. The unit is talked over
 * and then ignored for the rest of the exchange.
 *
 * Measured on the offline harness before this existed: two turns of a
 * twelve-turn suite died at 15037 ms and 15038 ms against a 15000 ms budget,
 * both mid-sentence, and the turn after each went unanswered as a result.
 *
 * So the deadline is pushed out by however much audio has actually gone out.
 * The guard still holds everywhere it was meant to — nothing extends it but
 * packets leaving.
 */
function turnClock(budgetMs: number): {
  controller: AbortController;
  allowAirtime: (airedMs: number) => void;
  clear: () => void;
} {
  const controller = new AbortController();
  let deadline = setTimeout(() => controller.abort(), budgetMs);
  return {
    controller,
    allowAirtime(airedMs) {
      clearTimeout(deadline);
      deadline = setTimeout(() => controller.abort(), budgetMs + airedMs);
    },
    clear() {
      clearTimeout(deadline);
    },
  };
}

/**
 * How long a queued transmission is still worth answering.
 *
 * Past this the exchange has moved on, and answering traffic from half a minute
 * ago is worse than never having heard it.
 */
const MAX_QUEUE_AGE_MS = 30_000;

function beginTurn(transmission: Transmission): void {
  const frequency = transmission.frequency;
  // Stamped here rather than at the gate in `onTransmission`, so the cooldown measures
  // the gap between turns this unit actually GOT, not between the times they keyed up.
  // Stamping at the gate would let a unit who keys repeatedly push their own next turn
  // further away each time, which is a different and much harsher rule than the one
  // documented.
  noteTurn(transmission.serverId);
  busy.add(frequency);
  runTurn(transmission).finally(() => {
    busy.delete(frequency);
    drain(frequency);
  });
}

function drain(frequency: number): void {
  const queued = queues.get(frequency);
  if (!queued || queued.length === 0) {
    queues.delete(frequency);
    return;
  }

  const next = queued.shift() as Transmission;
  if (queued.length === 0) queues.delete(frequency);

  if (Date.now() - next.startedAt > MAX_QUEUE_AGE_MS) {
    clearWaiting(frequency, next.serverId);
    drain(frequency);
    return;
  }
  beginTurn(next);
}

function onTransmission(transmission: Transmission): void {
  const { frequency, serverId } = transmission;
  // Negative ids are dispatch consoles. tRadio never reports a station's own audio,
  // and a human dispatcher is not somebody the dispatcher answers.
  if (serverId <= 0) return;
  if (!monitored(frequency)) return;
  if (yielding(frequency)) return;

  /**
   * One unit cannot drive a turn per key-up.
   *
   * A turn spends transcription, text AND speech, so keying repeatedly is the cheapest
   * way to run up an operator's provider bill — and the only control that was in place
   * before this was a per-turn *time* limit, which bounds latency and not cost.
   *
   * **Not on a live 911 call**, and that exemption is the point of this paragraph. The
   * caller is not one talker among thirty on a channel, they are the whole
   * conversation, and a call is already bounded far harder than the cooldown bounds it:
   * `MAX_ANSWERED_CALLS` is one, and the frequency is held `busy` for the length of
   * every turn, so the spend ceiling is turn duration and not key-ups. What the
   * cooldown could still do there is drop words — a turn that ended early (speech-to-
   * text heard nothing, say, which takes about a second) leaves the caller repeating
   * themselves two seconds later into a cooldown they cannot know about, and the
   * answer is silence on a line somebody dialled in an emergency. Getting the address
   * is the one thing on a call that cannot be recovered afterwards.
   *
   * Dropped rather than queued: queuing would only postpone the identical spend, and a
   * unit inside their own cooldown is by definition someone the dispatcher answered a
   * moment ago. Their next transmission after the gap is handled normally.
   */
  const cooldown = isAnsweredCall(frequency) ? 0 : aiConfig().turnCooldownMs;
  if (!turnAllowed(serverId, cooldown)) {
    aiLog.debug(`turn: ${serverId} keyed again inside the ${cooldown}ms cooldown — not answered`);
    return;
  }

  if (!busy.has(frequency)) {
    beginTurn(transmission);
    return;
  }

  // We cannot say "standby" over our own in-flight reply, so the next best
  // thing: hold the transmission, and name the unit to the model next turn so
  // they get answered rather than having to call twice.
  const queued = queues.get(frequency) ?? [];
  if (queued.length >= MAX_QUEUED) {
    /**
     * Full, so something has to go — and it is the OLDEST, not this arrival.
     *
     * It used to refuse whatever had just arrived, which is the wrong way round on a
     * radio channel and was the single biggest cause of the worst measured result: on
     * a 20-unit run, 43% of traffic was dropped and **12 of 20 units were never
     * answered once**, because the dispatcher kept working through a stale backlog
     * while every fresh transmission was turned away at the door.
     *
     * The oldest queued item is the one nearest `MAX_QUEUE_AGE_MS`, so it is the one
     * most likely to be discarded unheard anyway, and its unit has had longest to
     * give up and key again. The newest is the traffic a unit is actively waiting on.
     * Sacrificing the former spreads the dispatcher's attention across the channel
     * instead of pinning it to whoever happened to speak first.
     *
     * Both units stay on the waiting list either way, so neither is simply forgotten.
     */
    const evicted = queued.shift();
    if (evicted) {
      noteWaiting(frequency, evicted.serverId, identity(evicted.serverId).callsign);
      aiLog.debug(
        `turn: ${frequency} is backed up — dropping the oldest queued transmission ` +
          `(${evicted.serverId}) to make room`,
      );
    }
    queued.push(transmission);
    queues.set(frequency, queued);
    noteWaiting(frequency, serverId, identity(serverId).callsign);
    return;
  }
  queued.push(transmission);
  queues.set(frequency, queued);
  noteWaiting(frequency, serverId, identity(serverId).callsign);
}

/**
 * Which monitored channel a call should be put out on.
 *
 * Where the units are, not what a config file says: a call announced on an empty
 * channel is a call nobody was assigned to. When the caller named a service, a
 * monitored channel whose own name mentions it wins any tie — which is how a
 * fire call lands on a server's fire channel without tRadio knowing that server
 * has one, or what it is called.
 */
function channelForCall(service: string, origin: Point | null): number | null {
  const wanted = service.trim().toLowerCase();
  let chosen: number | null = null;
  let best = 0;

  for (const candidate of aiConfig().channels) {
    if (busy.has(candidate) || yielding(candidate)) continue;
    const count = rosterFor(candidate, origin).length;
    if (count === 0) continue;

    const named = wanted ? channelName(candidate).toLowerCase().includes(wanted) : false;
    const score = count + (named ? 100 : 0);
    if (score > best) {
      best = score;
      chosen = candidate;
    }
  }
  return chosen;
}

/**
 * A call, put out on the air unprompted.
 *
 * Reached from tRadio's own 911 queue and from anything else that hands the
 * dispatcher a call — see `tradioai:call`.
 */
function announceCall(call: AiCallInfo, coords: { x: number; y: number; z: number } | null): void {
  const config = aiConfig();
  if (!config.enabled || !config.auto911) return;

  const origin = coords ? { x: coords.x, y: coords.y } : null;
  const frequency = channelForCall(call.service, origin);
  if (frequency === null) {
    aiLog.debug(`call: no channel with units to announce ${call.id} on`);
    return;
  }

  const context = callContext(frequency, call, origin);

  const clock = turnClock(config.turnTimeoutMs);
  const journal = startTurn("call", frequency, 0);
  journal.addressed = true;
  journal.heard = `${call.source}: ${call.message}${call.location ? ` at ${call.location}` : ""}`;
  describeTurn(journal, context);
  journal.unit = call.id;

  busy.add(frequency);
  respond(context, clock.controller.signal, journal, clock.allowAirtime)
    .catch((err) => {
      journal.error = (err as Error).message;
      aiLog.warn(`call: ${call.id} not aired — ${(err as Error).message}`);
    })
    .finally(() => {
      clock.clear();
      finishTurn(journal);
      busy.delete(frequency);
      drain(frequency);
    });
}

/**
 * May the dispatcher pick up the phone right now?
 *
 * Two halves, deliberately kept apart. The configuration half is here, because the
 * config is this module's business. The presence half is `humanDispatcherPresent` in
 * `presence.ts`, beside the per-frequency sibling this rule is the exception to — and
 * unlike this file, that module can be imported by a test without standing up a
 * provider. The reasoning for the presence rule itself is on that function.
 */
function shouldAnswerCalls(): boolean {
  const config = aiConfig();
  if (!config.enabled || !config.answer911) return false;
  return !humanDispatcherPresent(tradio.stations().humans);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for the caller's client to actually be on the line.
 *
 * Answering tells the caller's client to switch to the call's frequency; it does not
 * do it. Between those two things the channel has nobody on it, and anything aired
 * into it is gone — so the greeting has to wait for the caller rather than for the
 * answer. See {@link CALL_JOIN_WAIT_MS}.
 */
async function waitForCaller(call: Call911, entry: AnsweredCall): Promise<boolean> {
  const until = Date.now() + CALL_JOIN_WAIT_MS;
  for (;;) {
    // Matched on the caller's own server id: nobody else on the call's frequency
    // can stand in for them and be greeted in their place.
    const joined = tradio
      .usersOn(call.frequency)
      .some(
        (user) => user.serverId === call.callerServerId && user.speakerChannel === call.frequency,
      );
    if (joined) return true;
    // The call ended (or this resource stopped) while waiting: nobody is coming, and a
    // greeting aired afterwards would go out on a frequency that no longer exists. Matched
    // on the registry entry itself, not the frequency: a frequency can be answered again.
    if (answeredOn(call.frequency) !== entry) return false;
    if (Date.now() >= until) return false;
    await sleep(CALL_JOIN_POLL_MS);
  }
}

/**
 * Pick the call up, retrying while the caller's client is still connecting.
 *
 * tRadio refuses a call whose caller is not on the wire, and the queue event fires the
 * same tick `/911` was handled — well before a caller with no radio powered on has
 * fetched connection info and authenticated, which takes seconds. Without the retry
 * every call it tried to answer was refused as `caller_offline`, the dispatcher
 * silently put the phone back down, and the caller heard ring-out forever.
 *
 * Re-asks the two questions the wait yielded on: a human signing on, or another call
 * being picked up in the meantime, both make this the wrong call to answer now.
 */
async function pickUp(station: string, call: Call911): Promise<{ ok: boolean; reason: string }> {
  const until = Date.now() + CALLER_CONNECT_WAIT_MS;
  for (;;) {
    const result = tradio.answer911(station, call.id);
    if (result.ok || result.reason !== "caller_offline") return result;
    if (Date.now() >= until) return result;
    await sleep(CALL_JOIN_POLL_MS);
    if (!shouldAnswerCalls()) return { ok: false, reason: "no longer answering" };
  }
}

/**
 * Pick up a queued 911 call and say hello.
 *
 * The greeting is a whole turn with no model in it, and that is the point: the
 * first thing a caller hears is the one utterance on the call whose content is
 * known before they say anything. Everything after it goes through `respond`
 * like a transmission does.
 */
async function answerCall(call: Call911): Promise<void> {
  if (!shouldAnswerCalls()) return;
  if (answeredCount() >= MAX_ANSWERED_CALLS) {
    aiLog.debug(`call: ${call.id} left in the queue — already on a call`);
    return;
  }

  const station = stationId();
  if (!station) {
    aiLog.debug(`call: ${call.id} left in the queue — no station is open to answer from`);
    return;
  }

  const info: AiCallInfo = {
    id: call.id,
    source: "911",
    caller: call.callerName,
    message: call.message,
    location: locationOf(call.coords),
    priority: "",
    service: "",
  };

  // Registered before the answer, not after: tRadio starts reporting the caller's
  // transmissions the moment it accepts, and the registry is how a transmission on a
  // frequency that exists nowhere in the config is recognised as a call.
  const entry = noteAnswered(call, info);
  const refused = await pickUp(station, call);
  if (!refused.ok) {
    // The caller dropped, or a human got there first. Unwound so nothing is left
    // holding a frequency for a call that is not ours.
    forgetCall(call.id);
    aiLog.debug(`call: ${call.id} not answered — ${refused.reason}`);
    return;
  }
  aiLog.info(`[audit] ai:911-answer id=${call.id} caller=${call.callerServerId}`);

  const config = aiConfig();
  const clock = turnClock(config.turnTimeoutMs + CALL_JOIN_WAIT_MS);
  const journal = startTurn("call_intake", call.frequency, call.callerServerId);
  journal.addressed = true;
  journal.addressedBy = "911 call answered";
  journal.unit = call.callerName || call.id;
  journal.heard = `911: ${call.message}`;
  journal.drafted = CALL_GREETING;
  journal.reply = CALL_GREETING;

  busy.add(call.frequency);
  try {
    if (!(await waitForCaller(call, entry))) {
      // Said rather than left blank, because "the caller never joined" and "the
      // greeting would not synthesise" are the same silence from the outside and
      // want different fixes. The call itself is left alone: `calls911`'s answer
      // watchdog owns this case and will end it.
      journal.skipped = "the caller never joined the line";
      return;
    }
    const speechStarted = Date.now();
    const aired = await airReply(
      call.frequency,
      CALL_GREETING,
      config.voiceGender,
      clock.controller.signal,
      (ms) => {
        journal.responseStartMs ??= Date.now() - journal.at;
        journal.stages.speechPreparation = Date.now() - speechStarted;
        journal.airedMs += ms;
        clock.allowAirtime(journal.airedMs);
      },
    );
    if (aired) {
      journal.aired = true;
      recordSaid(call.frequency, config.callsign, CALL_GREETING);
    } else {
      journal.skipped = "the greeting could not be aired";
    }
  } catch (err) {
    journal.error = (err as Error).message;
    aiLog.warn(`call: ${call.id} greeting failed — ${(err as Error).message}`);
  } finally {
    clock.clear();
    finishTurn(journal);
    busy.delete(call.frequency);
    drain(call.frequency);
  }
}

/**
 * A call the dispatcher was on has ended, however it ended.
 *
 * Four of the six ways a call can end are not the dispatcher's doing — the
 * caller hangs up, their client drops, the answer watchdog fires, the sweep
 * finds the channel empty — so this is reached from tRadio's `tradio:911:ended`
 * event rather than from the hang-up path. Without it the registry says the
 * dispatcher is still on a call, which is the thing that stops it answering the
 * next one. tRadio drops the call's coverage from the station itself.
 *
 * The event names the caller, not the call, and that is enough: the dispatcher is on
 * at most one call, and a caller is on at most one.
 */
function releaseCall(callerServerId: number, reason: string): void {
  const answered = answeredByCaller(callerServerId);
  if (!answered) return;
  const entry = forgetCall(answered.callId);
  if (!entry) return;

  // The history goes with the call: a call frequency is never reused, so anything
  // left behind is a leak with a member of the public's words in it.
  forgetChannel(entry.frequency);
  busy.delete(entry.frequency);
  queues.delete(entry.frequency);
  aiLog.info(`[audit] ai:911-release id=${entry.callId} reason=${reason}`);

  // A call nobody ever spoke on has nothing to tell the units, and announcing
  // one would put a member of the public's typed sentence on the air after the
  // dispatcher had picked up and heard nothing — which reads on the channel as a
  // call that was worked when it was not.
  if (reason === "caller_offline" || reason === "caller_no_answer") return;

  // Deferred to here rather than announced when the call queued, and that is the
  // whole reason the dispatcher answering is worth anything: the radio call now
  // says what the caller actually said out loud to somebody, in the call-taker's
  // own four words, instead of the sentence they typed into /911 in a hurry
  // before anyone picked up. It also keeps the two off the air at once — a
  // radio announcement while the call was live would be a second turn decoding
  // against the call's own, on a box that has the cores for one.
  announceCall({ ...entry.info, message: entry.summary || entry.info.message }, entry.coords);
}

/**
 * A call handed over by something that is not tRadio.
 *
 * The seam any CAD, job script or other resource uses:
 *
 *   TriggerEvent("tradioai:call", { source = "CAD", caller = "...",
 *                                   message = "...", service = "fire",
 *                                   priority = "1", location = "...",
 *                                   coords = vector3(...) })
 *
 * Every field is optional but `message`. Nothing is validated beyond length and
 * type, because what a call means is the caller's business — the dispatcher
 * reads it out and works it like any other.
 */
function onExternalCall(payload: unknown): void {
  const record = (payload ?? {}) as Record<string, unknown>;
  const message = field(record.message, 400);
  if (!message) {
    aiLog.warn("call: tradioai:call ignored — no message");
    return;
  }

  const raw = record.coords as Record<string, unknown> | undefined;
  const coords =
    raw && Number.isFinite(Number(raw.x)) && Number.isFinite(Number(raw.y))
      ? { x: Number(raw.x), y: Number(raw.y), z: Number(raw.z) || 0 }
      : null;

  announceCall(
    {
      id: field(record.id, 48) || `call_${Date.now().toString(36)}`,
      source: field(record.source, 32) || "a call",
      caller: field(record.caller, 64),
      message,
      location: field(record.location, 120) || locationOf(coords),
      priority: field(record.priority, 32),
      service: field(record.service, 32),
    },
    coords,
  );
}

function field(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * A place name for the call, if the server can produce one.
 *
 * There is no server-side street lookup in FiveM, so this is a hook: a server
 * running postals or a CAD already has the answer, and one that does not gets a
 * dispatcher who describes the call without an address rather than one that
 * reads out coordinates.
 */
/**
 * Place names to bias the recogniser with on a live call.
 *
 * Read off the call's own derived location, which is the only address the server
 * has that was not itself produced by this recogniser. Biasing with words the
 * transcriber invented a turn ago would teach it to keep inventing them, so the
 * channel's heard history is deliberately NOT a source here.
 *
 * Split on the conjunctions an intersection is written with, so "Elgin Avenue
 * and Vespucci Boulevard" biases two names rather than one long phrase that
 * matches nothing a caller says on its own.
 *
 * Empty on most servers, and that is expected: `locationOf` is a Lua hook, so a
 * server without postals or a CAD has no address to offer and the bias falls
 * back to the sentence alone. The general fix — a static street table, which
 * would work with no hook at all — is carded rather than done; what is measured
 * is that naming places works, not where the names come from.
 */
function placesForCall(frequency: number): string[] {
  const call = answeredOn(frequency);
  const location = call?.info.location ?? "";
  if (!location) return [];
  return location
    .split(/\s+and\s+|[,/&]/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 2);
}

function locationOf(coords: { x: number; y: number; z: number } | null): string {
  if (!coords) return "";
  const named = callLuaSafely<unknown>("getLocation", [coords], "");
  return typeof named === "string" ? named.slice(0, 120) : "";
}

/**
 * Whether tRadio can be used right now, re-asked on a slow beat.
 *
 * `probe` makes about a dozen export calls, so it is not run per sweep: it runs when
 * tRadio changes state and otherwise every {@link PROBE_EVERY_MS} while idle, which is
 * how the dispatcher notices a tRadio that was updated, started late or told to
 * accept it.
 */
const PROBE_EVERY_MS = 30_000;
let lastProbeAt = 0;
let lastIdleReason: string | null = null;

function tradioReady(now: number, force = false): boolean {
  const known = tradio.capabilities();
  const ready = idleReason(known) === "";
  if (ready && !force) return true;
  if (!force && now - lastProbeAt < PROBE_EVERY_MS) return ready;

  lastProbeAt = now;
  const fresh = tradio.probe();
  const why = idleReason(fresh);
  if (why !== lastIdleReason) {
    lastIdleReason = why;
    if (why) aiLog.warn(`tRadioAI is idle: ${why}`);
    else aiLog.info("tRadioAI: tRadio's integration hooks found");
  }
  return why === "";
}

const idleReason = tradio.idleReason;

let tapFrequencies: number[] | null = null;
let tapFailedAt = 0;

/** Hear the channels the dispatcher monitors, and nothing else; re-register when the list changes. */
function syncTap(now: number): void {
  const config = aiConfig();
  if (!config.enabled || config.channels.length === 0) {
    if (tapFrequencies) tradio.unregisterTap();
    tapFrequencies = null;
    return;
  }
  const same =
    tapFrequencies !== null &&
    tapFrequencies.length === config.channels.length &&
    tapFrequencies.every((frequency) => config.channels.includes(frequency));
  if (same) return;
  if (tapFailedAt > 0 && now - tapFailedAt < PROBE_EVERY_MS) return;

  if (tradio.registerTap(config.channels, onTransmission)) {
    tapFrequencies = [...config.channels];
    tapFailedAt = 0;
  } else {
    tapFrequencies = null;
    tapFailedAt = now;
  }
}

/** The station follows the config: every monitored channel no human is covering. */
function syncSeat(): void {
  const config = aiConfig();
  if (!config.enabled) {
    closeStation();
    return;
  }
  syncStation({
    name: config.callsign,
    frequencies: config.channels.filter((frequency) => !yielding(frequency)),
    answers911: shouldAnswerCalls(),
  });
}

function tick(): void {
  const now = Date.now();
  if (!tradioReady(now)) {
    // A tRadio that went away takes its tap and station ids with it.
    if (tapFrequencies) {
      tradio.unregisterTap();
      tapFrequencies = null;
    }
    forgetStation();
    return;
  }
  syncTap(now);
  syncSeat();
  syncReadiness();
}

/**
 * What a queued 911 call means to the dispatcher: answer it, or put it out on the air.
 *
 * Answering wins over announcing, and they are mutually exclusive. A dispatcher that
 * put the call out on the air *and* picked it up would be two turns decoding at once
 * against each other, and would broadcast the caller's typed sentence a moment before
 * learning what the call was actually about. When the dispatcher takes the call, the
 * radio hears about it when the line goes down — see `releaseCall`.
 */
function onCallQueued(call: Call911): void {
  if (shouldAnswerCalls() && answeredCount() < MAX_ANSWERED_CALLS) {
    void answerCall(call).catch((err: unknown) => {
      aiLog.warn(`call: ${call.id} could not be answered — ${(err as Error).message}`);
    });
    return;
  }
  announceCall(
    {
      id: call.id,
      source: "911",
      caller: call.callerName,
      message: call.message,
      location: locationOf(call.coords),
      priority: "",
      service: "",
    },
    call.coords,
  );
}

export function installDispatcher(): void {
  tradio.wireEvents();
  tradio.onCallQueued(onCallQueued);
  tradio.onCallEnded(releaseCall);

  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = setInterval(tick, SWEEP_MS);
  tradioReady(Date.now(), true);
  tick();

  // Registered once per module execution. FiveM keeps handlers from superseded
  // executions alive (see tradio-hooks.ts), and a second registration would apply the
  // same config twice — harmless, but the timer would not be.
  if (!installed) {
    installed = true;
    registerWeightsCommand(() => providerPlan());
    on("tradioai:config", (payload: unknown) => {
      applyAiConfig(payload);
      // Reactive, and after the plan is resolved rather than from the raw payload: a
      // capability configured for a hosted provider with no API key resolves to
      // local, and those weights still have to be here.
      syncWeights(providerPlan());
      readiness.reset();
      // Immediately, not on the next sweep: a config change should put the dispatcher
      // on the air while the operator is still looking.
      tick();
    });
    on("tradioai:call", (payload: unknown) => onExternalCall(payload));
    on("onResourceStart", (resource: unknown) => {
      if (resource === tradio.TRADIO_RESOURCE) tradioReady(Date.now(), true);
    });
    on("onResourceStop", (resource: unknown) => {
      if (resource === tradio.TRADIO_RESOURCE) {
        // Its ids are gone with it; the next sweep re-registers against the new one.
        tapFrequencies = null;
        forgetStation();
        tradio.lostTradio();
        return;
      }
      if (resource !== GetCurrentResourceName()) return;
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      resetWeights();
      closeStation();
      forgetStation();
      tapFrequencies = null;
      tapFailedAt = 0;
      lastProbeAt = 0;
      lastIdleReason = null;
      tradio.resetHooks();
      busy.clear();
      queues.clear();
      positions.clear();
      identities.clear();
      resetConversations();
      resetCalls();
      resetSpeaker();
      resetBudget();
      resetAiConfig();
      readiness.reset();
    });
  }

  aiLog.debug("dispatcher installed");
}
