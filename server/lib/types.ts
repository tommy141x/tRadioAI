import type { HistoryEntry } from "./conversation";
import type { ChannelEntry } from "./directory";
import type { RosterUnit } from "./roster";

export type { ChannelEntry, HistoryEntry, RosterUnit };

/**
 * Shared types for the AI dispatcher.
 *
 * The rule this subsystem is built around: **the tool decides, not the model.**
 * A tool declares what it does and what kind of input it takes; the model names
 * one of the declared tools and passes it a line of text. A name that was never
 * declared is a refusal, and the input is the tool's own problem to accept or
 * reject — which is where the knowledge to judge it actually lives.
 */

/** A tool registered from `Config.tools`, as it reaches this side. */
export interface AiTool {
  id: string;
  /** One line telling the model when this tool applies. */
  description: string;
  /**
   * What the tool's argument is, in words, e.g. "a radio status such as 10-8".
   * Empty for a tool that takes none. Never a schema — the tool validates, and
   * the model does better with a sentence than with a grammar.
   */
  input: string;
  /**
   * The tool saying "this input is one of MY OWN words", for a command tool.
   *
   * `isPlaceholderValue` refuses an argument whose every content word appears in the
   * tool's own id, description and input line, because `run_plate("plate")` is the
   * tool's subject repeated back rather than a plate. That reasoning holds for a
   * LOOKUP, whose argument must name something other than the tool itself, and
   * inverts for a COMMAND, whose legal values are a closed vocabulary that the
   * description and the input line necessarily enumerate. Measured 2026-10-17:
   * `channel_alert("lift")` was refused by the guard while `channel_alert`'s own
   * `run` matches `lift` as the word for taking an alert down, so the dispatcher
   * answered "go ahead", the unit repeated itself, and it failed identically forever.
   *
   * Answer true only for an input the tool would really act on, and from the same
   * matching the tool's `run` uses — a second, looser copy of it here would accept
   * arguments `run` then rejects, which is the guard disagreeing with the tool in
   * the other direction.
   *
   * Absent on every tool that does not say otherwise, including every tool an
   * operator registers from Lua: this is a function and nothing crosses that bridge,
   * so a server's own tools keep exactly today's behaviour.
   */
  recognizes?: (input: string) => boolean;
}

/** What a tool did, in words the dispatcher can put on the air. */
export interface ToolResult {
  ok: boolean;
  /** Short phrasing of the outcome, fed back to the model to write its reply. */
  message: string;
  /**
   * Set when the failure was OURS, not the world's.
   *
   * `"argument"` means the tool never ran because the value we extracted was unusable —
   * a placeholder, or something the unit never said. That is a different fact from the
   * world refusing, and the unit must hear a different thing: a refusal is "negative",
   * whereas not having caught the detail is "go ahead". Observed on the harness
   * 2026-10-13 (BUG-69515): a unit asked for another unit, the model passed the
   * request's own subject as the argument, the guard refused it, and the unit was told
   * "negative" with nobody sent — a true request answered with a false no.
   *
   * Absent on a genuine failure, so every existing caller keeps treating `ok: false` as
   * a failure and only the wording changes.
   */
  fault?: "argument";
}

/**
 * A call the dispatcher is being asked to put out on the air.
 *
 * Not only 911. tRadio's own 911 queue is one producer; a CAD, a job script or
 * another resource can hand the dispatcher a call through the same seam, and
 * `source` is how the dispatcher knows which it is — "911", "CAD", "Fire
 * Control" — without tRadio having to know what any of them are.
 */
export interface AiCallInfo {
  id: string;
  /** Where the call came from, said on the air as-is. */
  source: string;
  caller: string;
  message: string;
  /** Street-level description if one could be derived, else "". */
  location: string;
  /** Operator's own words for urgency, e.g. "priority 1". Empty when unranked. */
  priority: string;
  /** What kind of help was asked for, e.g. "fire", "EMS". Empty when unstated. */
  service: string;
}

/**
 * Everything a tool's `run` is told about the turn.
 *
 * Handed to Lua verbatim, so a customer's tool sees the same roster and history
 * the model does — which is what lets a tool answer "who is closest" without
 * asking the model to have got it right.
 */
export interface AiTurnContext {
  /**
   * What started this turn.
   *
   *  - `transmission` — a unit keyed up on a radio channel.
   *  - `call` — the dispatcher speaking unprompted, putting a call out on the
   *    air. No transmission and no talker behind it.
   *  - `call_intake` — the dispatcher is *on* a 911 call and the caller just
   *    spoke. A transmission like any other as far as the voice path is
   *    concerned, and nothing like one as far as the prompt is: the other end
   *    is a frightened member of the public on a phone, not a unit on a radio.
   */
  trigger: "transmission" | "call" | "call_intake";
  /** FiveM server id of the unit who keyed up, or 0 for a call-driven turn. */
  serverId: number;
  /** Their radio callsign, or "" when they have not set one. */
  callsign: string;
  /** Their codeplug unit id, or "" when unassigned. */
  unitId: string;
  /** Normalized frequency the turn is happening on. */
  frequency: number;
  /** The channel's configured alias, for the prompt only. */
  channelName: string;
  /** What STT heard. Never trusted for anything but prompting. Empty for a call. */
  transcript: string;
  /** Units on this channel, nearest first. */
  roster: RosterUnit[];
  /** What has been said on this channel recently, oldest first. */
  history: HistoryEntry[];
  /** Callsigns who keyed up while the dispatcher was mid-turn. */
  waiting: string[];
  /**
   * The rest of the system: every channel this server has, who is on it, what it
   * is running and what it is patched to. This is what lets the dispatcher send
   * a request to another agency instead of telling a unit there is nobody.
   */
  channels: ChannelEntry[];
  /** The call behind a `call` turn. */
  call?: AiCallInfo;
}

/** One thing the dispatcher decided to do. */
export interface AiAction {
  /** The id of a declared tool. Never empty — an undeclared name is dropped. */
  tool: string;
  /** Whatever the model passed the tool. Unvalidated here on purpose. */
  input: string;
}

/**
 * What the model returned, after validation.
 *
 * `actions` is empty for "do nothing" — a real and common answer, since most of
 * what crosses a dispatch channel is units talking to each other. It holds more
 * than one when the traffic genuinely calls for it: a pursuit going county-wide
 * is an alert and a patch, and making the dispatcher pick one would mean the
 * other never happens.
 *
 * Undeclared tool names are dropped rather than matched to the nearest one, so
 * an invented capability costs a reply and never an action.
 */
export interface AiDecision {
  actions: AiAction[];
  /** The words to say back, already the dispatcher's own phrasing. */
  reply: string;
  /**
   * The model's own classification of the traffic, lowercased — `call-up`, `request` or
   * `report` on the radio, `location`, `detail` or `done` on a call.
   *
   * Retained as of BUG-72482, having been parsed and thrown away since `kind` was
   * introduced. It is the field the model gets RIGHT: measured over the probe's failing
   * cases it was correct on every run, while the tool match it conditions flipped with
   * the length of the tool list. `self-report.ts` is what reads it. Optional, because a
   * provider that answers with no `kind` is still a provider and every consumer treats
   * a missing one as "decide nothing from this".
   */
  kind?: string;
  /** The traffic in four words or fewer, in the unit's own words. See `kind`. */
  about?: string;
}

/** An action and what came of it, which is what the spoken reply is written from. */
export interface AiOutcome extends AiAction {
  ok: boolean;
  message: string;
  /** Carried through from {@link ToolResult.fault}; it decides what the unit hears. */
  fault?: "argument";
}

/** Audio handed to a transcriber: a complete file, not a stream. */
export interface AudioClip {
  bytes: Uint8Array;
  /** "audio/wav" or "audio/webm". */
  mime: string;
  /** Filename the multipart upload should use; some endpoints sniff it. */
  filename: string;
}

export type VoiceGender = "male" | "female";

/** Runtime configuration, normalized from the admin panel and config.lua. */
export interface AiDispatchConfig {
  enabled: boolean;
  /** Normalized frequencies the dispatcher monitors. Empty means none. */
  channels: number[];
  /** Stand down on a channel a human dispatcher is signed on to. */
  yieldToDispatcher: boolean;
  /** Put new 911 calls out on the air unprompted and assign a unit to them. */
  auto911: boolean;
  /**
   * Pick up 911 calls and talk to the caller, when no human is on the panel.
   *
   * Off by default, and that is not timidity about the model. Answering a call
   * is the dispatcher speaking directly to a member of the public with nobody
   * else on the line, which is a different thing to consent to than answering
   * units over a radio — so it is a separate switch, and a server that turns the
   * dispatcher on does not get this with it.
   */
  answer911: boolean;
  /** How the dispatcher identifies itself, e.g. "Dispatch". */
  callsign: string;
  /** Genders only — a dispatcher has one voice and no moods. */
  voiceGender: VoiceGender;
  /**
   * Which manner the dispatcher speaks with: one key of `DEMEANORS` in `prompt.ts`.
   *
   * A `string` rather than that union on purpose. It arrives from a Lua table an
   * operator typed, so the only thing a narrower type here would buy is a cast at
   * the boundary; `demeanorKey` in `config.ts` is where the value is actually
   * checked, and an unrecognised one is named in the log and replaced with the
   * default rather than carried as a lie about its own type.
   *
   * Blank is the documented escape and means `DEFAULT_DEMEANOR`. The key is chosen
   * HERE, host-side, and becomes exactly one line of the system prompt — the model
   * is never shown the table and never picks.
   */
  demeanor: string;
  /**
   * Transcript prefixes that address the dispatcher. Matched case-insensitively
   * at the start of the transcript. Empty means answer everything on the channel,
   * which is almost never what an operator wants.
   */
  wakePhrases: string[];
  /**
   * The server's own ten-codes, as `code` -> what it means there.
   *
   * Operator-supplied because **a code sheet is local**. 10-50 is a traffic accident on
   * one agency and a vehicle pursuit on the next, and tRadio has no business asserting
   * either. Empty means the dispatcher is told no code meanings at all, which is
   * honest: it then treats a code as the opaque token it heard rather than acting on a
   * meaning nobody gave it.
   *
   * Used in two places, and both matter. The code TEXT goes into the transcription bias,
   * because a short arbitrary token with no English reading is exactly what a recogniser
   * mangles — measured, "code 4" arriving as "Recode 4" and "Workcode 4". The MEANINGS
   * go into the prompt, so the dispatcher can act on "10-50" without anyone writing a
   * 10-50 scenario.
   */
  tenCodes: Record<string, string>;
  /**
   * Which CAD the dispatcher should use, when a server runs more than one.
   *
   * Empty means "work it out" — see `cad/registry.ts`, which picks the richest
   * capability set and logs the choice once. Set deliberately only when two CADs
   * are started and the automatic choice is the wrong one, which happens during a
   * migration. A name that is not running turns the CAD tools OFF rather than
   * falling through to another system: an operator whose pinned CAD is down is far
   * better served by the tools disappearing than by their calls quietly going
   * somewhere nobody is watching.
   */
  cad: string;
  /** Whole-turn budget. A dispatcher that answers late is worse than silent. */
  turnTimeoutMs: number;
  /**
   * Smallest gap between two turns driven by the SAME unit, in milliseconds.
   *
   * The only spend control that is on by default, because it is the one that cannot
   * take the channel down: it rate-limits one talker, not the dispatcher. A unit who
   * keys up repeatedly is answered at this rate and no faster, which is also how a
   * real dispatcher behaves. 0 disables it.
   */
  turnCooldownMs: number;
  /**
   * Ceiling on HOSTED provider calls per rolling minute, across every capability.
   *
   * 0 means no ceiling, which is the default and the behaviour every existing install
   * already has — a cap that trips in the middle of an incident is a decision an
   * operator has to opt into, not one an upgrade makes for them. Above 0, a turn that
   * would exceed it is served by the local engine instead, which is the same fallback a
   * missing API key already takes, so nothing new has to be documented for the failure
   * path.
   *
   * Counted per call and not per turn: one turn spends transcription, text AND speech,
   * so a per-turn number would understate the bill by about three times.
   */
  hostedCallsPerMinute: number;
}

export interface AiProvider {
  readonly name: string;
  /**
   * Audio in, words out. Empty string when nothing was recognised.
   *
   * `bias` is vocabulary the transcriber should expect to hear — the wake
   * phrases and the callsigns on the channel. Radio audio reaches here having
   * been through a vocoder, and a recogniser with no idea what words are likely
   * turns "dispatch" into "this batch". Providers that cannot bias ignore it.
   */
  transcribe(clip: AudioClip, signal: AbortSignal, bias?: string): Promise<string>;
  /**
   * Pick what to do and compose the spoken reply.
   *
   * Implementations must validate every returned tool id against `tools`,
   * because a response format that is merely requested is not a constraint.
   */
  decide(
    system: string,
    prompt: string,
    tools: readonly AiTool[],
    signal: AbortSignal,
    /**
     * Called once, as soon as the spoken reply is complete but before the rest
     * of the decision is.
     *
     * The reply is generated first and is about eight tokens; the tool call
     * behind it is the other twenty-six, and measured on the local model that
     * tail is over a second. This hook is what lets synthesis start during it
     * instead of after it.
     *
     * The text is a *draft*: on a turn that runs a tool, the reply that actually
     * airs is written again afterwards against the outcome, and this one is
     * discarded. Anything acting on it must be cancellable and must not put it
     * on the air by itself.
     *
     * Optional, and a provider is free never to call it — a hosted endpoint that
     * will not stream simply answers all at once, and the turn still completes.
     */
    onDraftReply?: (reply: string) => void,
    /**
     * The model's answer exactly as it arrived, before any parsing.
     *
     * For the turn log, and it earns its place there: every question about why a
     * turn went wrong — a tool not chosen, a reply pinned to one line, a field
     * cut off by the token cap — is answered by the raw text and by almost
     * nothing else. {@link AiDecision} has already thrown away the evidence.
     */
    onRaw?: (raw: string) => void,
    /**
     * Which answer format to ask for: the radio one, or the 911 call-taker one.
     *
     * A name rather than the text itself, because the framing and the parser are
     * one contract — a caller free to pass arbitrary instructions could ask the
     * model for fields nothing reads, and the turn would fail somewhere much
     * further along than the line that caused it. Optional and defaulting to
     * `"radio"`, so a provider written before calls existed is still a provider.
     */
    framing?: "radio" | "call"
  ): Promise<AiDecision>;
  /**
   * Plain text back, used once the action's outcome is known.
   *
   * Separate from `decide` because the reply that turn actually airs has to be
   * written after the tool ran, not before — see `buildOutcomePrompt`.
   */
  compose(system: string, prompt: string, signal: AbortSignal): Promise<string>;
  /** Text in, mono 16-bit PCM out, at `sampleRate`. */
  speak(
    text: string,
    gender: VoiceGender,
    signal: AbortSignal
  ): Promise<{ pcm: Int16Array; sampleRate: number }>;
}
