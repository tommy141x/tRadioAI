/**
 * Tools that act on the radio system itself.
 *
 * These live here rather than in Lua because what they touch — patches, the
 * channel directory, putting a voice on another channel — is backend state. The
 * operator's own tools stay in `config/sv_functions.lua`; these are the ones
 * tRadio can implement for every server without knowing anything about it.
 *
 * Nothing here is written against a particular server's channel names. A tool's
 * description is generated from the directory and the configured alerts, so a
 * server running LSPD/BCSO/fire and a server running three substations each get
 * a dispatcher that talks about their channels, not about ours.
 *
 * Every tool refuses rather than guesses. A channel name the model wrote that
 * matches two channels resolves to neither, and the refusal is spoken on the
 * air — a dispatcher saying "which channel?" is normal, a dispatcher patching
 * the wrong two systems together is not.
 */

import { aiLog } from "./logger";
import { type AnsweredCall, answeredOn, isAnsweredCall, markClosing, noteSummary } from "./calls";
import { aiConfig } from "./config";
import { recordSaid } from "./conversation";
import { type ChannelEntry, describeChannel, resolveChannel } from "./directory";
import { CAD_TOOLS } from "./cad-tools";
import { airReply } from "./speak";
import * as tradio from "./tradio-hooks";
import type { AiTool, AiTurnContext, ToolResult } from "./types";

export interface BuiltinTool extends AiTool {
  /** False hides the tool this turn — nothing to patch, no alerts configured. */
  available: (context: AiTurnContext) => boolean;
  run: (context: AiTurnContext, input: string) => ToolResult | Promise<ToolResult>;
  /**
   * True for tools that belong on a 911 call, false or absent for the radio.
   *
   * The two sets do not overlap and the separation is enforced centrally rather
   * than left to each `available`, because the failure mode is asymmetric. A
   * radio tool merely hidden from a call costs nothing — there is nothing on a
   * call for it to do. A radio tool *offered* on a call is an action the model
   * will eventually take, and "set the caller's unit status to 10-8" is not a
   * mistake that stays inside the dispatcher: it writes to the CAD.
   */
  onCall?: boolean;
  /**
   * Yield to an operator's Lua tool of the same id. See `cad-tools.ts`.
   *
   * Absent on every tool tRadio implements for itself: a server cannot opt out of
   * tRadio owning its own patches, alerts and tones by naming a tool after one.
   */
  yieldsToLua?: true;
}

/** Channels the dispatcher may talk about, minus the one the turn is already on. */
function others(context: AiTurnContext): ChannelEntry[] {
  return context.channels.filter((entry) => entry.frequency !== context.frequency);
}

/**
 * Whether a tool that takes another CHANNEL as its target should be offered.
 *
 * Not on a `call` turn — the announcement that puts a fresh 911 call out on the
 * air — and that is the whole of the extra condition.
 *
 * The reason is measured, repeatedly. On that turn the model names the UNIT it is
 * assigning the call to where a channel belongs: `call_another_channel(King 41:
 * crash reported)` on one run, and after that tool started refusing it by name,
 * `patch_channels(DISP: King 15, crash on Elgin and Vespucci)` on the next. Same
 * mistake, two different tools, every run. `buildTurnPrompt` has warned against
 * it in words since the first time it was seen ("a unit you just gave the call to
 * is not a channel, and naming one as though it were sends the call nowhere") and
 * the warning does not take.
 *
 * Nothing is lost by withholding them there, which is why this is a gate and not
 * a better sentence. The cross-channel decision has ALREADY been made before the
 * turn starts: `channelForCall` in `index.ts` picks which monitored channel to
 * announce on, scoring by how many units are near it and preferring a channel
 * whose name matches the service asked for, and it skips any channel with no
 * units at all. So by the time this turn runs, the dispatcher is on the right
 * channel with units on it, and its reply airs there. There is nothing to relay
 * and nothing to patch.
 *
 * Deliberately NOT applied to `channel_alert` or `channel_tone`: an alert tone
 * ahead of a priority call is real dispatch practice, they take no channel
 * target, and neither has been seen misused here. Withdrawing a capability
 * without evidence would be the same mistake in the other direction.
 *
 * ## The roster condition that used to be here, and why it is gone
 *
 * 287262e added `roster.filter(u => u.serverId !== serverId).length === 0`, so
 * these tools were offered ONLY when the asking unit was the sole occupant of its
 * channel. It was added for a real failure — on a 20-unit load run, asked "21, can
 * I get a second unit here?" with nineteen others on the channel, the model relayed
 * that off-channel and then told the unit help was coming from somewhere they
 * cannot hear.
 *
 * But it treats every cross-channel request as that request, and most are not: two
 * LEOs on a police channel cannot provide an ambulance. `buildRoster` also counts
 * LISTENERS, not just talkers, so one silent unit monitoring the channel disabled
 * the feature for everybody on it — which on any real server is always.
 *
 * Worse, withholding the capability could not suppress the behaviour, only the
 * outcome: the prompt still instructs the dispatcher to relay, so on a populated
 * channel it promised a relay in words with no tool to perform it, and nothing
 * reached the other channel. A customer reported exactly that shape on 2026-10-22
 * — cross-channel requests worked with one unit on the channel and failed with two,
 * in both directions, symmetrically.
 *
 * The distinction the rule actually wants ("could somebody HERE serve this?") is a
 * judgement about what was asked, which only the model can make and which it
 * therefore has to be told rather than gated on. `buildTurnPrompt` carries that
 * sentence now. That is weaker than a gate and is the honest trade: one wrong relay
 * on a busy channel, against the feature working at all.
 */
function mayTargetAnotherChannel(context: AiTurnContext): boolean {
  if (context.trigger === "call") return false;
  // Nowhere to relay TO. Counts other CHANNELS, not units on this one.
  return others(context).length > 0;
}

function channelName(entry: ChannelEntry): string {
  return describeChannel(entry.zone, entry.name, entry.frequency);
}

/** Split "Blaine County DISP: we need an engine" into its two halves. */
function splitTarget(input: string): { target: string; rest: string } {
  // The hyphen is only a separator with spaces around it, which is what the
  // second alternative is for. It used to ALSO be a bare member of the character
  // class, and since a trailing `-` in a class is a literal, every hyphen split —
  // so "1-ADAM-12: we need an engine" resolved to the target "1" and "KING-41" to
  // "KING". LAPD-style callsigns and channel names like "LSPD-1" are ordinary on
  // the servers this ships to, so both this tool and `patch_channels` were
  // unusable for them. Colon is the documented form and the em dash still splits.
  const separator = input.search(/[:,—]|\s-\s/);
  if (separator > 0) {
    return {
      target: input.slice(0, separator).trim(),
      rest: input
        .slice(separator + 1)
        .replace(/^[\s:,—-]+/, "")
        .trim(),
    };
  }
  return { target: input.trim(), rest: "" };
}

/**
 * Two names for the same thing, ignoring case, punctuation and spacing.
 *
 * "King 41", "king41" and "KING-41" are one callsign. Compared this way because
 * the target comes out of a model's free text, which punctuates inconsistently,
 * and an exact match would miss the mistake this is used to recognise.
 */
function plainlySame(a: string, b: string): boolean {
  const flatten = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const left = flatten(a);
  return left.length > 0 && left === flatten(b);
}

const PATCH_LABEL_MAX = 40;

const patchChannels: BuiltinTool = {
  id: "patch_channels",
  description:
    "two or more channels need to hear each other — a pursuit crossing into another agency's area, a joint incident, mutual aid",
  input: "the channels to patch together, named as they are listed above, separated by 'and'",
  available: (context) => mayTargetAnotherChannel(context) && tradio.capabilities().patches,
  run: (context, input) => {
    const wanted = input
      .split(/\s+and\s+|\s*[,+]\s*|\s*&\s*/i)
      .map((part) => part.trim())
      .filter(Boolean);
    if (wanted.length < 2) return { ok: false, message: "a patch needs at least two channels" };

    const picked: ChannelEntry[] = [];
    for (const part of wanted) {
      const entry = resolveChannel(part, context.channels);
      if (!entry) return { ok: false, message: `there is no channel called "${part}"` };
      if (picked.some((chosen) => chosen.frequency === entry.frequency)) continue;
      picked.push(entry);
    }
    if (picked.length < 2) return { ok: false, message: "those are the same channel" };

    const known = tradio.channels();
    const live = tradio.patches();
    for (const entry of picked) {
      if (known.find((channel) => channel.frequency === entry.frequency)?.type === "trunked") {
        return { ok: false, message: `${channelName(entry)} is trunked and cannot be patched` };
      }
      const existing = live.find((patch) => patch.frequencies.includes(entry.frequency));
      if (existing) {
        return {
          ok: false,
          message: `${channelName(entry)} is already patched as ${existing.label || "another patch"}`,
        };
      }
    }

    const label = picked
      .map((entry) => entry.name || channelName(entry))
      .join("/")
      .slice(0, PATCH_LABEL_MAX);
    const frequencies = picked.map((entry) => entry.frequency);
    const made = tradio.createPatch(label, frequencies);
    if (!made.ok) {
      // tRadio is the authority on what can be patched, so a refusal it names is read
      // back as that channel's own reason rather than as a generic failure.
      if (
        made.reason === "direct" ||
        made.reason === "trunked" ||
        made.reason === "already_patched"
      ) {
        const entry =
          picked.find((candidate) => candidate.frequency === made.frequency) ?? picked[0];
        const name = entry ? channelName(entry) : "one of those channels";
        const why =
          made.reason === "already_patched"
            ? `is already patched as ${made.label || "another patch"}`
            : `is a ${made.reason} channel and cannot be patched`;
        return { ok: false, message: `${name} ${why}` };
      }
      if (made.reason === "disabled") {
        return { ok: false, message: "channel patching is switched off in tRadio" };
      }
      if (made.reason === "unknown_channel") {
        return { ok: false, message: "one of those channels is not in tRadio" };
      }
      return { ok: false, message: "the patch could not be made" };
    }
    aiLog.info(`[audit] ai:patch created ${label} [${frequencies.join(", ")}]`);

    return { ok: true, message: `${picked.map(channelName).join(" and ")} are patched together` };
  },
};

const unpatchChannels: BuiltinTool = {
  id: "unpatch_channels",
  description: "a patch is no longer needed and the channels should go back to standing alone",
  input: "any one of the patched channels, or the patch's name",
  available: () => tradio.capabilities().patches && tradio.patches().length > 0,
  run: (context, input) => {
    const wanted = input.trim();
    if (!wanted) return { ok: false, message: "you did not say which patch" };

    const live = tradio.patches();
    const entry = resolveChannel(wanted, context.channels);
    const byFrequency = entry
      ? live.find((patch) => patch.frequencies.includes(entry.frequency))
      : undefined;
    const byLabel = live.find((patch) => patch.label.toLowerCase() === wanted.toLowerCase());
    const patch = byFrequency ?? byLabel;
    if (!patch) return { ok: false, message: `nothing is patched to "${wanted}"` };

    if (!tradio.removePatch(patch.id))
      return { ok: false, message: "the patch could not be removed" };
    aiLog.info(`[audit] ai:patch removed ${patch.label}`);

    return { ok: true, message: `the ${patch.label} patch is down` };
  },
};

/**
 * Talk on a channel other than the one the turn is on.
 *
 * This is what lets a request cross agencies: a unit asks for fire on a police
 * channel, the dispatcher puts the request out on the fire channel, and comes
 * back to the unit having actually done it. The reply the unit hears is written
 * afterwards from this tool's result, so it can only claim what happened.
 */
const relayToChannel: BuiltinTool = {
  id: "call_another_channel",
  description:
    "something has to be put out on a different channel — asking another agency for a unit, passing a request on, advising a channel of something happening on this one",
  input:
    "the channel, then a colon, then exactly what to say on it — for example 'Blaine County DISP: LSPD requesting an engine at Vespucci and Alta'",
  available: mayTargetAnotherChannel,
  run: async (context, input) => {
    const { target, rest } = splitTarget(input);
    if (!rest) return { ok: false, message: "you did not say what to put out" };

    const entry = resolveChannel(target, context.channels);
    if (!entry) {
      // The one wrong answer this tool reliably gives, and the reason the generic
      // message was not enough. On a `call` turn the model names the UNIT it just
      // assigned the call to as though it were a channel — measured on every run
      // of `dispatch-harness.ts`'s call cases, so the air gets "Copy, King 41,
      // crash reported" followed by a transmission saying the relay failed.
      //
      // The announcement turn no longer offers this tool at all
      // (`mayTargetAnotherChannel`), which is what actually fixed that case. This
      // stays for every OTHER turn, where the tool is genuinely available and a
      // unit asking for a relay can still have its callsign land here.
      //
      // It does not prevent the mistake — nothing in a failure path can — but it
      // makes the failure legible to the model that writes the follow-up from it:
      // a reply composed against "there is no channel called King 41" reads as a
      // system fault, while one composed against this says the true thing, which
      // is that nothing needed relaying.
      const unit = context.roster.find(
        (candidate) => candidate.callsign && plainlySame(candidate.callsign, target),
      );
      if (unit) {
        return {
          ok: false,
          message:
            `${unit.callsign} is a unit on this channel, not a channel. ` +
            "They can already hear you, so there is nothing to relay — say it on the air here.",
        };
      }
      return { ok: false, message: `there is no channel called "${target}"` };
    }
    if (entry.frequency === context.frequency) {
      return { ok: false, message: "that is the channel you are already on" };
    }

    const config = aiConfig();
    const aired = await airReply(
      entry.frequency,
      rest,
      config.voiceGender,
      AbortSignal.timeout(20_000),
    );
    if (!aired) return { ok: false, message: `${channelName(entry)} is busy` };

    recordSaid(entry.frequency, config.callsign, rest);
    return {
      ok: true,
      message: entry.monitored
        ? `that went out on ${channelName(entry)}`
        : `that went out on ${channelName(entry)}, which you do not monitor, so nobody there can answer you`,
    };
  },
};

/**
 * Alerts are the operator's, not ours.
 *
 * `Config.alerts` is where a server writes what its alerts are called — SIGNAL
 * 100, strict RTO, whatever their procedure says — so the tool's description is
 * built from that list at the moment it is offered. tRadio never knows what any
 * of them mean, only that the dispatcher may raise and lift them.
 */
function alertNames(): string[] {
  return tradio.alertNames();
}

/**
 * Taking an alert down rather than putting one up, and naming one of the
 * operator's alerts. Both named because `recognizes` has to answer from the same
 * matching `run` uses: a second copy would accept arguments `run` then rejects.
 */
const LIFTING_AN_ALERT = /\b(lift|clear|cancel|off|down|resume|code 4)\b/i;

function namedAlert(names: string[], wanted: string): string | undefined {
  return names.find((name) => wanted.toLowerCase().includes(name.toLowerCase()));
}

const setAlert: BuiltinTool = {
  id: "channel_alert",
  description:
    "the channel's traffic calls for one of the alerts below — put it up, or lift it once whatever caused it is over",
  input: "",
  /**
   * Both halves of this tool's vocabulary are words it declares, so without this
   * the placeholder guard refused all of them. "lift" is in the description and
   * cost the dispatcher the "go ahead" loop; every alert NAME is in the generated
   * input line below, so `channel_alert("Ping")` — a shipped default alert — was
   * refused too, and only `SIGNAL 100` and `SIGNAL 3` worked at all, for carrying
   * a digit.
   */
  recognizes: (input) =>
    LIFTING_AN_ALERT.test(input) || namedAlert(alertNames(), input) !== undefined,
  available: () => alertNames().length > 0,
  run: (context, input) => {
    const names = alertNames();
    const wanted = input.trim();
    if (!wanted) return { ok: false, message: "you did not say which alert" };

    const lifting = LIFTING_AN_ALERT.test(wanted);
    const named = namedAlert(names, wanted);

    const target = resolveChannel(splitTarget(wanted).target, context.channels);
    const frequency =
      target && target.frequency !== context.frequency ? target.frequency : context.frequency;

    if (lifting) {
      const ok = tradio.setAlert(frequency, false, named ?? null);
      return ok
        ? { ok: true, message: `the alert is lifted${named ? ` (${named})` : ""}` }
        : { ok: false, message: "the alert could not be lifted" };
    }
    if (!named) {
      return {
        ok: false,
        message: `there is no alert called "${wanted}" — there is ${names.join(", ")}`,
      };
    }

    const ok = tradio.setAlert(frequency, true, named);
    aiLog.info(`[audit] ai:alert ${named} on ${frequency} -> ${ok}`);
    return ok
      ? { ok: true, message: `${named} is in effect` }
      : { ok: false, message: `${named} could not be put up` };
  },
};

function namedTone(names: string[], input: string): string | undefined {
  const wanted = input.trim().toUpperCase().replace(/\s+/g, "_");
  return names.find((name) => name === wanted) ?? names.find((name) => wanted.includes(name));
}

const playTone: BuiltinTool = {
  id: "channel_tone",
  description:
    "a tone should go out over the channel before an announcement, to get everyone's attention",
  input: "",
  /** Every tone name is listed in the generated input line, so every one of them was refused. */
  recognizes: (input) => namedTone(toneNames(), input) !== undefined,
  available: () => toneNames().length > 0,
  run: (context, input) => {
    const tone = namedTone(toneNames(), input);
    if (!tone) return { ok: false, message: `there is no tone called "${input.trim()}"` };

    const ok = tradio.playTone(context.frequency, tone);
    return ok
      ? { ok: true, message: "the tone went out" }
      : { ok: false, message: "the tone did not go out" };
  },
};

/**
 * The end of a 911 call, in the dispatcher's own hands.
 *
 * The only tool a call gets in this first version, and the reason it needs one
 * at all: everything else that can end a call is a timeout or a disconnection,
 * so without this the dispatcher has no way to finish a conversation it knows is
 * finished, and the line stays open until the sweep decides nobody is talking.
 *
 * It does not hang up. It writes down what the call was and says the dispatcher
 * is done; the turn loop drops the line once the closing words have actually
 * reached the caller. See `closing` on {@link AnsweredCall}.
 *
 * The input is the summary rather than a confirmation, because this is the one
 * moment somebody who has just spoken to the caller can say what the call was in
 * four words — and that summary is what goes out over the radio afterwards, in
 * place of the sentence they typed into /911 before anyone picked up.
 */
const hangUp: BuiltinTool = {
  id: "hang_up",
  description:
    "you have the location and you know what is happening — end the call so the help can go out",
  input: "what the call was, in a few words, as you would say it on the radio",
  onCall: true,
  available: (context) => isAnsweredCall(context.frequency),
  run: (context, input) => {
    const call = answeredOn(context.frequency);
    if (!call) return { ok: false, message: "that call has already ended" };

    const summary = input.trim();
    if (!summary) return { ok: false, message: "you did not say what the call was about" };
    noteSummary(call.callId, summary);
    if (!markClosing(call.callId)) return { ok: false, message: "that call has already ended" };

    aiLog.info(`[audit] ai:call-closing id=${call.callId} "${summary}"`);
    // Phrased as the thing still left to do, because this message is the prompt
    // the closing line is written from. "The call is over" reads as licence to
    // say nothing, and a call that ends in silence reads to the caller as a
    // dropped line rather than as help being sent.
    return {
      ok: true,
      message: "the call ends as soon as you finish speaking — tell them help is being sent",
    };
  },
};

function toneNames(): string[] {
  return tradio.toneNames();
}

const ALL: BuiltinTool[] = [
  patchChannels,
  unpatchChannels,
  relayToChannel,
  setAlert,
  playTone,
  hangUp,
  // The CAD tools, last so the radio's own tools are registered first and a CAD
  // cannot crowd them out of the tool ceiling. Each one answers `available` false
  // unless a CAD is connected AND that CAD declares the matching capability, so on
  // a server with no CAD this line costs one Lua round trip per turn and nothing
  // else — and on a server WITH one, only the tools that CAD can honour appear.
  //
  // Worth knowing before adding more: tool-list length measurably changes this
  // model's behaviour. `scripts/probe-self-report.ts` has an `imperial` column
  // precisely so the cost of a CAD tool set is a number rather than a hope —
  // measured 70% status capture with controls clean, against 100%/clean for the
  // one-tool shipped set. See docs/design/dispatcher-design-notes.md.
  ...CAD_TOOLS,
];

/**
 * The built-in tools that apply this turn, with their descriptions filled in
 * from what this server actually has.
 */
export function builtinTools(context: AiTurnContext): BuiltinTool[] {
  const out: BuiltinTool[] = [];
  const onCall = context.trigger === "call_intake";
  for (const tool of ALL) {
    // Before `available` rather than after, so a call never so much as asks a
    // radio tool whether it applies — several of them answer by querying Lua.
    if ((tool.onCall === true) !== onCall) continue;

    let applies = false;
    try {
      applies = tool.available(context);
    } catch (err) {
      aiLog.warn(
        `builtins: ${tool.id} could not say whether it applies — ${(err as Error).message}`,
      );
    }
    if (!applies) continue;

    if (tool.id === setAlert.id) {
      out.push({
        ...tool,
        input: `which alert — ${alertNames().join(", ")} — or "lift" to take one down`,
      });
    } else if (tool.id === playTone.id) {
      out.push({ ...tool, input: `which tone — ${toneNames().join(", ")}` });
    } else {
      out.push(tool);
    }
  }
  return out;
}

export function findBuiltin(id: string): BuiltinTool | null {
  const wanted = id.trim().toLowerCase();
  return ALL.find((tool) => tool.id === wanted) ?? null;
}
