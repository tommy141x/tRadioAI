/**
 * The dispatcher, stood up outside the game, driven by audio.
 *
 * This is the substrate; `dispatch-harness.ts` is the thing you run. It exists so that
 * testing a dispatcher change does not mean loading GTA, joining, and keying a radio for
 * every iteration.
 *
 * **It runs the real turn loop.** The same `installDispatcher` the resource calls, the
 * same transcriber, model, prompt builders, tool dispatch and turn journal. What is
 * replaced is tRadio: `StubTradio` (server/lib/stub-tradio.ts) implements the integration
 * contract, so a unit's transmission arrives on the tap as a 16 kHz WAV exactly as the
 * contract says tRadio delivers it, and the dispatcher's reply is read off the station as
 * 8 kHz PCM.
 *
 * What this loses against the old in-process sim, and it is one thing that matters:
 * **there is no IMBE vocoder round trip on the unit's audio.** tRadio owns the vocoder,
 * so the unit's synthesised voice goes to the recogniser clean, not decoded from P25
 * parameters. Speech-to-text accuracy measured here is therefore optimistic — it is the
 * ceiling, not the expectation. Latency, the model's decisions, tool use and multi-turn
 * behaviour are unaffected.
 *
 * Also not real: FiveM (no natives, so every unit reads "position unknown"), and tRadio's
 * per-channel queue, which is approximated below by serialising airtime per frequency.
 * The reply is held on the air for its real duration, because a four-second answer takes
 * four seconds and the turn's "did the follow-up finish inside the airtime" questions
 * depend on it.
 *
 * `lua` in {@link SimOptions} is this resource's own Lua export bag (`getTools`,
 * `runTool`, `getLocation`, ...): the seam for custom tools and unit statuses.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildWav, resamplePcm } from "../../server/lib/audio";
import { applyAiConfig } from "../../server/lib/config";
import { forgetChannel } from "../../server/lib/conversation";
import { installDispatcher } from "../../server/lib/index";
import { configureLocal, stopLocalEngines } from "../../server/lib/local-engine";
import { createHttpProvider, provider, setProvider } from "../../server/lib/provider";
import { StubTradio } from "../../server/lib/stub-tradio";
import { STT_SAMPLE_RATE } from "../../server/lib/tradio-hooks";
import { setTurnLogFile, type TurnJournal } from "../../server/lib/turnlog";
import type { AiProvider } from "../../server/lib/types";
import { installSpawnBroker } from "../sim/spawn-broker";

/** How long to wait for a turn to reach the journal before calling it lost. */
const TURN_TIMEOUT_MS = 120_000;

export interface SimUnit {
  serverId: number;
  /** What the roster calls them — tRadio's player name. */
  callsign: string;
  unitId?: string;
  /** Reported through the `getUnitInfo` Lua stub. */
  status?: string;
  note?: string;
}

/**
 * Somebody on the phone rather than on the radio.
 *
 * A separate type from {@link SimUnit} because the difference is the whole
 * subject of a 911 test: a caller is seated with no speaker channel at all, so
 * anything that reaches them had to go through the call's own frequency. Seat
 * one as a unit by mistake and the dispatcher answers them on the air, which is
 * exactly the failure the intake path exists to prevent.
 */
export interface SimCaller {
  serverId: number;
  /** What the queue records as `callerName` — the name a dispatcher sees. */
  name: string;
}

/** A 911 call that has been raised, answered, and greeted. */
export interface SimCall {
  id: string;
  frequency: number;
  /** The greeting turn — no model in it, so this is the floor for call latency. */
  greeting: SimTurn;
}

export interface SimOptions {
  frequency: number;
  channelName: string;
  units: SimUnit[];
  /** People who call 911. Seated off the radio entirely — see {@link SimCaller}. */
  callers?: SimCaller[];
  /**
   * Whether the dispatcher picks 911 calls up instead of reading them out on the
   * air. Off by default, matching the `answer911` default, so a run that does not
   * ask for calls measures exactly the dispatcher the shipped config describes.
   */
  answer911?: boolean;
  /**
   * A second channel exists by default because two of the five built-in tools
   * are hidden without one: a dispatcher with nowhere to patch to cannot be
   * asked to patch, and a harness that silently cannot test half the tools is
   * worse than no harness.
   */
  otherChannels?: { frequency: number; name: string }[];
  /** Extra entries for this resource's own Lua exports (`getTools`, `runTool`, `getLocation`, ...). */
  lua?: Record<string, unknown>;
  /** Alert names and tone keys tRadio reports through `getAlerts` and `getToneKeys`. */
  alerts?: string[];
  tones?: string[];
  /** Hosted providers, as `Config.providers` is written. Omitted means the local engine. */
  providers?: Record<string, unknown>;
  voices?: { male?: string[]; female?: string[] };
  /** An injected provider, for a run with no engine and no network. */
  provider?: AiProvider;
  /** Where reply audio is written, one WAV per transmission. Off when unset. */
  audioDir?: string;
  /** A different GGUF for the text model, to compare candidates. */
  textModel?: string;
}

export interface AiredReply {
  text: string;
  wav: string | null;
  durationMs: number;
}

/**
 * A running offline dispatcher.
 *
 * `say`/`play` put audio on the channel and resolve with the turn the
 * dispatcher took, journal and all. `close()` must run — it stops the local
 * engines, and a harness that skips it leaves llama-server and whisper-server
 * holding their ports.
 */
export interface DispatchSim {
  say(unit: SimUnit, line: string): Promise<SimTurn>;
  play(unit: SimUnit, wavFile: string): Promise<SimTurn>;
  /**
   * Raise a 911 call and stay on the line until the dispatcher says hello.
   *
   * `message` is what the caller typed into `/911`; everything after it is
   * spoken through {@link DispatchSim.sayOnCall}. Rejects rather than resolving
   * empty if the call is never answered — a silent null here would read as "the
   * dispatcher chose not to take it", which is a different bug from "the queue
   * refused the request".
   */
  call911(
    caller: SimCaller,
    message: string,
    coords?: { x: number; y: number; z: number },
  ): Promise<SimCall>;
  /** The caller speaks, on the call's frequency rather than on the radio. */
  sayOnCall(caller: SimCaller, line: string): Promise<SimTurn>;
  /** The caller speaks, from a recording. */
  playOnCall(caller: SimCaller, wavFile: string): Promise<SimTurn>;
  /** The caller hangs up, the way the in-game HUD does. */
  hangUp(caller: SimCaller): void;
  /** How the caller's last call ended, or null while one is still up. */
  callEnded(caller: SimCaller): string | null;
  /**
   * Wait for the next turn the dispatcher takes on its own.
   *
   * The one thing `say` cannot return: the radio announcement that follows a
   * call being released happens after the call has ended, with nobody keying
   * anything. Without this the harness would have to sleep and hope.
   */
  nextTurn(timeoutMs?: number): Promise<SimTurn>;
  /**
   * Forget everything the dispatcher remembers about the channel.
   *
   * History, the live reply expectation, and the waiting list. Call it BETWEEN
   * scenarios, never inside one — a multi-turn exchange depends on exactly the
   * state this throws away.
   *
   * It exists because without it a case inherits the previous case's channel.
   * Measured: `eavesdrop` ("King 41 to King 22, you on this channel?") was
   * answered rather than ignored because the `loop` case immediately before it
   * ended with the dispatcher replying to King 41, which leaves an
   * `expectReplyFrom` window open — and inside that window the dispatcher answers
   * whatever that unit says next, wake phrase or not, by design. So the case
   * passed or failed on what ran before it and how long that took, which is the
   * same class of cross-contamination `AGENTS.md` §8 documents for the test suite.
   */
  resetChannel(): void;
  /**
   * Transmit and unkey WITHOUT waiting for the dispatcher.
   *
   * The one thing `say` cannot express, and the reason the queue has never been
   * exercised. `say` resolves on the turn reaching the journal, so a suite built
   * from it transmits strictly one unit at a time with the channel idle — which
   * is the only situation `index.ts`'s `busy` set and `queues` map do nothing in.
   * A real channel does the opposite: a turn takes several seconds, and the units
   * who key up inside that window are the whole subject of that code.
   *
   * Resolves when this unit has let go of the key, which is when a radio channel
   * is free for the next one. Half-duplex is deliberate — two units transmitting
   * over each other is a collision the RF layer prevents, not a dispatcher
   * behaviour — so callers await this before the next unit starts.
   */
  transmitOnly(unit: SimUnit, line: string): Promise<void>;
  /** Journalled-turn count right now, to pass to {@link DispatchSim.turnsSince}. */
  mark(): number;
  /**
   * Collect the next `count` turns journalled after `mark`, in order.
   *
   * `nextTurn` cannot do this: it takes its mark when it is called, so turns
   * that land while nothing is awaiting are invisible to it — and under load
   * that is most of them. Marking first and collecting afterwards is what makes
   * a queued reply observable at all.
   *
   * Resolves with fewer than `count` on timeout rather than throwing. A queue
   * that dropped a transmission is a RESULT here, not an error, and it is the
   * specific result `MAX_QUEUED` and `MAX_QUEUE_AGE_MS` exist to produce.
   */
  turnsSince(mark: number, count: number, timeoutMs?: number, quietMs?: number): Promise<SimTurn[]>;
  close(): Promise<void>;
}

export interface SimTurn {
  journal: TurnJournal;
  /** Everything the dispatcher actually put on the air for this turn. */
  aired: AiredReply[];
  /** Wall clock from the unit unkeying to the dispatcher's first voice packet. */
  toFirstWordMs: number | null;
}

/** Minimal 16-bit PCM WAV reader. Enough for a recording, not a general parser. */
export function readWav(file: string): { pcm: Int16Array; sampleRate: number } {
  const bytes = readFileSync(file);
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error(`${file} is not a RIFF/WAV file`);
  }
  let at = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      bits = bytes.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (bits !== 16) throw new Error(`${file} is ${bits}-bit; only 16-bit PCM is read here`);
      const frames = Math.floor(size / 2 / channels);
      const pcm = new Int16Array(frames);
      // Channels are averaged rather than dropped: a recording made on one side
      // of a stereo pair would otherwise come back silent.
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += bytes.readInt16LE(body + (i * channels + c) * 2);
        pcm[i] = Math.round(sum / channels);
      }
      return { pcm, sampleRate };
    }
    at = body + size + (size % 2);
  }
  throw new Error(`${file} has no data chunk`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startDispatchSim(options: SimOptions): Promise<DispatchSim> {
  const root = process.cwd();
  const frequency = options.frequency;

  const g = globalThis as unknown as Record<string, unknown>;
  g.GetCurrentResourceName = () => "tRadioAI";
  g.GetResourcePath = () => root;
  // Provider keys come from the environment here, as `server.cfg` convars do in game.
  g.GetConvar = (name: string, fallback: string) => process.env[name] ?? fallback;
  // `installDispatcher` registers the weights command, so without a stub the whole
  // harness dies on `RegisterCommand is not defined` before a single case runs.
  g.RegisterCommand = () => {};

  const tradio = new StubTradio();
  tradio.install();

  // AFTER the stub: this makes `globalThis.exports` the callable form tLib's broker
  // registers into and carries the existing bags (the stub's `tRadio`) over. Installed
  // the other way round, the bags are the ones that get lost.
  await installSpawnBroker();

  // This resource's own Lua, faked: unit statuses, tools, the location hook.
  const byId = new Map(options.units.map((unit) => [unit.serverId, unit]));
  const exportsBag = g.exports as unknown as Record<string, Record<string, unknown>>;
  exportsBag.tRadioAI = {
    getUnitInfo: (serverId: number) => {
      const unit = byId.get(serverId);
      return unit ? { status: unit.status ?? "", note: unit.note ?? "" } : null;
    },
    ...(options.lua ?? {}),
  };

  // Two channels by default, so `patch_channels` and `call_another_channel` are offered
  // rather than quietly missing.
  const others = options.otherChannels ?? [{ frequency: frequency + 0.125, name: "OPS2" }];
  tradio.channels = [
    { zoneName: "Los Santos", name: options.channelName, frequency },
    ...others.map((channel) => ({ zoneName: "Los Santos", ...channel })),
  ];
  tradio.alerts = (options.alerts ?? []).map((name) => ({ name }));
  tradio.tones = options.tones ?? [];
  tradio.patchList = [];

  for (const unit of options.units) {
    tradio.put(frequency, unit.serverId, { name: unit.callsign, unitId: unit.unitId });
  }
  // Callers are named and nothing else: on no channel, not in the roster, until a call
  // is answered for them.
  for (const caller of options.callers ?? []) tradio.names.set(caller.serverId, caller.name);

  applyAiConfig({
    enabled: true,
    channels: [frequency],
    voiceGender: "female",
    answer911: options.answer911 ?? false,
    providers: options.providers ?? {},
    ...(options.voices ? { provider: { voices: options.voices } } : {}),
  } as never);
  configureLocal(options.textModel ? { root, textModel: options.textModel } : { root });

  // Reply audio is captured by wrapping the provider: the text and the PCM are both here,
  // already paired. The clean copy is the more useful one to review.
  const aired: AiredReply[] = [];
  const real = options.provider ?? createHttpProvider();
  if (options.audioDir && !existsSync(options.audioDir)) {
    mkdirSync(options.audioDir, { recursive: true });
  }
  const capturing: AiProvider = {
    ...real,
    name: real.name,
    speak: async (text, gender, signal) => {
      const speech = await real.speak(text, gender, signal);
      const durationMs = Math.round((speech.pcm.length / speech.sampleRate) * 1000);
      let wav: string | null = null;
      if (options.audioDir) {
        wav = path.join(options.audioDir, `reply-${aired.length + 1}.wav`);
        writeFileSync(wav, buildWav(speech.pcm, speech.sampleRate));
      }
      aired.push({ text, wav, durationMs });
      return speech;
    },
  };
  setProvider(capturing);

  // tRadio holds a channel to one voice and reports when audio has finished airing.
  // The stub does neither by itself, so airtime is serialised per frequency here and
  // `tradio:station:done` is fired when the audio would really have ended.
  tradio.autoFinish = false;
  const airTail = new Map<number, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let scheduled = 0;
  const airing = setInterval(() => {
    while (scheduled < tradio.transmits.length) {
      const transmit = tradio.transmits[scheduled++] as (typeof tradio.transmits)[number];
      const duration = (transmit.samples / transmit.sampleRate) * 1000;
      const start = Math.max(Date.now(), airTail.get(transmit.frequency) ?? 0);
      const end = start + duration;
      airTail.set(transmit.frequency, end);
      const timer = setTimeout(() => {
        timers.delete(timer);
        tradio.finishTransmit(
          transmit.stationId,
          transmit.requestId,
          "aired",
          transmit.samples,
          transmit.sampleRate,
        );
      }, end - Date.now());
      timers.add(timer);
    }
  }, 10);

  // How each caller's last call ended, off the same bus a Lua integration would use.
  const endedCalls = new Map<number, string>();
  const callFrequencies = new Map<number, { id: string; frequency: number }>();
  (g.on as (event: string, cb: (...args: unknown[]) => void) => void)(
    "tradio:911:ended",
    (callerServerId: unknown, reason: unknown) => {
      endedCalls.set(Number(callerServerId), String(reason));
      // The caller's client leaves the line, as the engine does on `call911:ended`.
      const left = callFrequencies.get(Number(callerServerId));
      const entry = left ? tradio.occupancy.get(left.frequency) : undefined;
      if (entry) entry.speakers = entry.speakers.filter((id) => id !== Number(callerServerId));
      callFrequencies.delete(Number(callerServerId));
    },
  );

  installDispatcher();
  const ready = Date.now() + 10_000;
  while (!(tradio.tapId() && tradio.stationId())) {
    if (Date.now() > ready) throw new Error("the dispatcher never registered its tap and station");
    await sleep(25);
  }

  // One journal file per run, read back after each turn. `finishTurn` runs in a `finally`
  // on every path, so a line appearing is the turn being over — including the turns that
  // decided to say nothing.
  const logs = path.join(root, "server", "logs");
  mkdirSync(logs, { recursive: true });
  const journalFile = path.join(logs, `sim-${Date.now().toString(36)}.jsonl`);
  setTurnLogFile(journalFile);

  function journals(): TurnJournal[] {
    if (!existsSync(journalFile)) return [];
    const body = readFileSync(journalFile, "utf8").trim();
    if (!body) return [];
    return body.split("\n").map((line) => JSON.parse(line) as TurnJournal);
  }

  /**
   * Block until one more turn has been journalled, and describe it.
   *
   * `unkeyedAt` is the moment the speaker let go, or null for a turn nobody keyed — the
   * greeting, and the announcement that follows a released call. Those report no time to
   * first word rather than a number measured from an arbitrary instant.
   */
  async function awaitTurn(
    before: number,
    airedFrom: number,
    unkeyedAt: number | null,
    timeoutMs = TURN_TIMEOUT_MS,
  ): Promise<SimTurn> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const all = journals();
      if (all.length > before) {
        const journal = all[all.length - 1] as TurnJournal;
        return {
          journal,
          // Sliced from a mark rather than read out of an array that was emptied first: a
          // turn the dispatcher starts on its own is already speaking by the time
          // anything asks to watch it.
          aired: aired.slice(airedFrom),
          // From the journal's own air event: `responseStartMs` is stamped when tRadio
          // accepts the audio, the nearest the contract gets to the first packet.
          toFirstWordMs:
            unkeyedAt === null || journal.responseStartMs === null
              ? null
              : journal.at - unkeyedAt + journal.responseStartMs,
        };
      }
      await sleep(50);
    }
    throw new Error("the turn never reached the journal");
  }

  /**
   * A unit's voice, synthesised once per distinct line.
   *
   * Piper costs about a second a line and a load test says the same handful of things
   * across thirty units. Keyed on the text alone because every unit uses the male voice.
   */
  const speechCache = new Map<string, { pcm: Int16Array; sampleRate: number }>();
  async function unitVoice(line: string): Promise<{ pcm: Int16Array; sampleRate: number }> {
    const hit = speechCache.get(line);
    if (hit) return hit;
    const speech = await provider().speak(line, "male", AbortSignal.timeout(120_000));
    const kept = { pcm: speech.pcm, sampleRate: speech.sampleRate };
    speechCache.set(line, kept);
    return kept;
  }

  /** When each unit last let go of the key, so a turn collected later can be timed from it. */
  const lastUnkey = new Map<number, number>();

  /**
   * Hold the key for the clip's duration, then deliver the transmission to the tap.
   * Returns the unkey time.
   *
   * Holding the key is what keeps half-duplex honest: callers await this before the next
   * unit starts, so two units never overlap on the air.
   */
  async function keyAndUnkey(
    who: { serverId: number },
    pcm: Int16Array,
    sampleRate: number,
    onFrequency: number,
  ): Promise<number> {
    const narrowed = resamplePcm(pcm, sampleRate, STT_SAMPLE_RATE);
    await sleep((narrowed.length / STT_SAMPLE_RATE) * 1000);
    const unkeyedAt = Date.now();
    tradio.transmission({
      serverId: who.serverId,
      frequency: onFrequency,
      audio: buildWav(narrowed, STT_SAMPLE_RATE),
      container: "wav",
      sampleRate: STT_SAMPLE_RATE,
    });
    lastUnkey.set(who.serverId, unkeyedAt);
    return unkeyedAt;
  }

  async function transmit(
    who: { serverId: number },
    pcm: Int16Array,
    sampleRate: number,
    onFrequency = frequency,
  ): Promise<SimTurn> {
    const before = journals().length;
    const airedFrom = aired.length;
    const unkeyedAt = await keyAndUnkey(who, pcm, sampleRate, onFrequency);
    return awaitTurn(before, airedFrom, unkeyedAt);
  }

  /**
   * Turns journalled after `from`, measured from each one's own unit's unkey.
   *
   * **`aired` comes back empty, deliberately.** Captured audio cannot be attributed to a
   * turn under overlap, and a plausible-looking slice would be wrong rather than
   * approximate. The concurrency cases assert on `journal.reply`, `journal.held` and
   * `journal.skipped`, which are exact. Use `say` when the WAVs are what is wanted.
   */
  async function collectTurns(
    from: number,
    count: number,
    timeoutMs: number,
    quietMs: number,
  ): Promise<SimTurn[]> {
    const until = Date.now() + timeoutMs;
    let seen = journals().length;
    let lastChange = Date.now();
    for (;;) {
      const now = journals().length;
      if (now !== seen) {
        seen = now;
        lastChange = Date.now();
      }
      if (now >= from + count) break;
      if (Date.now() >= until) break;
      // The channel has gone quiet with turns still outstanding, which is the queue
      // having dropped them. That is an expected outcome, so it ends the wait.
      if (quietMs > 0 && now > from && Date.now() - lastChange > quietMs) break;
      await sleep(50);
    }

    return journals()
      .slice(from, from + count)
      .map((journal) => {
        const unkeyedAt = lastUnkey.get(journal.serverId);
        return {
          journal,
          aired: [],
          toFirstWordMs:
            unkeyedAt === undefined || journal.responseStartMs === null
              ? null
              : journal.at - unkeyedAt + journal.responseStartMs,
        };
      });
  }

  /** The call this caller is currently on. */
  function callFor(caller: SimCaller): { id: string; frequency: number } {
    const call = callFrequencies.get(caller.serverId);
    if (!call) throw new Error(`caller ${caller.serverId} is not on a call`);
    return call;
  }

  let callCount = 0;

  return {
    async say(unit, line) {
      // Male by default so it is not the dispatcher's voice being transcribed back.
      // Synthesising the unit's own line lands in `aired` like anything else; `transmit`
      // marks the list after this returns, so it is not captured as a dispatcher reply.
      const speech = await unitVoice(line);
      return transmit(unit, speech.pcm, speech.sampleRate);
    },
    async play(unit, wavFile) {
      const { pcm, sampleRate } = readWav(wavFile);
      return transmit(unit, pcm, sampleRate);
    },
    async call911(caller, message, coords) {
      const before = journals().length;
      const airedFrom = aired.length;
      endedCalls.delete(caller.serverId);

      callCount += 1;
      const id = `sim_call_${callCount}`;
      const callFrequency = Math.round((900 + callCount * 0.0125) * 10000) / 10000;
      tradio.queueCall({
        id,
        callerServerId: caller.serverId,
        callerName: caller.name,
        message,
        frequency: callFrequency,
        // A real /911 always carries a position; the default is somewhere ordinary in
        // Los Santos so the location hook has something to work with.
        coords: coords ?? { x: -1037.0, y: -2738.0, z: 20.0 },
      });

      // Answering is asynchronous. Wait for the accept, then join the line, which is the
      // order a real client experiences: it cannot switch frequency until told which one.
      const until = Date.now() + 10_000;
      for (;;) {
        if (tradio.answered911.some((answered) => answered.callId === id)) {
          callFrequencies.set(caller.serverId, { id, frequency: callFrequency });
          tradio.put(callFrequency, caller.serverId, { name: caller.name });
          return {
            id,
            frequency: callFrequency,
            greeting: await awaitTurn(before, airedFrom, null),
          };
        }
        if (!tradio.calls.has(id)) throw new Error(`call ${id} ended before it was answered`);
        if (Date.now() >= until) throw new Error(`call ${id} was never answered`);
        await sleep(25);
      }
    },
    async sayOnCall(caller, line) {
      const call = callFor(caller);
      const speech = await unitVoice(line);
      return transmit(caller, speech.pcm, speech.sampleRate, call.frequency);
    },
    async playOnCall(caller, wavFile) {
      const call = callFor(caller);
      const { pcm, sampleRate } = readWav(wavFile);
      return transmit(caller, pcm, sampleRate, call.frequency);
    },
    hangUp(caller) {
      const call = callFor(caller);
      tradio.calls.delete(call.id);
      tradio.fire("tradio:911:ended", caller.serverId, "caller_ended");
    },
    callEnded(caller) {
      return endedCalls.get(caller.serverId) ?? null;
    },
    async nextTurn(timeoutMs) {
      return awaitTurn(journals().length, aired.length, null, timeoutMs ?? TURN_TIMEOUT_MS);
    },
    resetChannel() {
      forgetChannel(frequency);
    },
    async transmitOnly(unit, line) {
      const speech = await unitVoice(line);
      await keyAndUnkey(unit, speech.pcm, speech.sampleRate, frequency);
    },
    mark() {
      return journals().length;
    },
    async turnsSince(mark, count, timeoutMs, quietMs) {
      return collectTurns(mark, count, timeoutMs ?? TURN_TIMEOUT_MS, quietMs ?? 0);
    },
    async close() {
      // The resource's own stop path, which owns the sweep timer `installDispatcher`
      // starts. Without it the harness finishes and then never exits.
      tradio.fire("onResourceStop", "tRadioAI");
      clearInterval(airing);
      for (const timer of timers) clearTimeout(timer);
      setProvider(null);
      setTurnLogFile(null);
      await stopLocalEngines();
      tradio.uninstall();
      try {
        rmSync(journalFile);
      } catch {
        // A journal that cannot be removed is not worth failing a run over.
      }
    },
  };
}

export type { TurnJournal };
