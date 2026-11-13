/**
 * The bridge between the model's decision and whatever the server can actually do.
 *
 * Two layers, presented to the model as one list:
 *
 *   - **Built-ins** (`builtins.ts`) — things tRadio itself can do on any server:
 *     patch channels, put traffic out on another channel, raise and lift the
 *     operator's own alerts, send a tone.
 *   - **Lua tools** — the dispatcher's built-in unit-status tool in
 *     `server/sv_ai_dispatch.lua`, and customer tools through the
 *     `Config.tools` hook in `config/sv_functions.lua`. Nothing about
 *     those is known here beyond what Lua describes, which is the point:
 *     shipping a new capability must not require touching escrowed TypeScript.
 *
 * Built-ins are listed first and win a name collision, so an operator cannot
 * shadow `patch_channels` with something that merely sounds like it.
 *
 * A tool is a name, a line saying when it applies, and a line saying what its
 * argument is. The model names one and writes the argument; the tool accepts or
 * rejects it, and a rejection comes back as a sentence the dispatcher can say on
 * the air. Enumerating every legal argument server-side was the earlier design
 * and it was wrong — it made the operator declare twice what the tool already
 * knows, and left the model no way to pass anything the list did not anticipate.
 *
 * Tool names must be declared. Unit status also requires a quote from the current
 * transmission: invented status must not become authoritative roster data.
 *
 * Every call into Lua is wrapped: a customer's tool function throwing is a bad
 * turn, never a dead radio.
 */

import { aiLog } from "./logger";
import { builtinTools, findBuiltin } from "./builtins";
import { callLuaSafely } from "./lua";
import type { AiTool, AiTurnContext, ToolResult } from "./types";

export type { ToolResult };
export { callLuaSafely };


/**
 * Ceiling on the tool list handed to the model.
 *
 * Every tool costs prompt tokens on every turn, and a list longer than this is
 * one a model picks out of badly anyway. Tools are taken in declaration order so
 * the built-ins (declared first) survive an operator who registers a hundred of
 * their own.
 */
const MAX_TOOLS = 32;

/** Long enough for an address or a plate, short enough that a runaway model cannot pay for a paragraph. */
const MAX_INPUT_CHARS = 160;

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

/** Lua sends a sequential table; anything else means the hook returned something odd. */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  // A Lua table with non-sequential keys arrives as an object. Its values are
  // still the tools the operator meant to register, so take them rather than
  // silently dropping the whole registration over a table literal's shape.
  if (value && typeof value === "object") return Object.values(value as object);
  return [];
}

/**
 * Everything the dispatcher may do this turn.
 *
 * Asked per turn rather than cached, because whether a tool applies is Lua's call
 * and can depend on the unit, their job or a CAD being reachable.
 */
export function describeTools(context: AiTurnContext): AiTool[] {
  const tools: AiTool[] = [];
  const seen = new Set<string>();

  /**
   * The operator's own tools are asked for FIRST, but still added second.
   *
   * Order of assembly and order of precedence are two different things here and
   * both matter. Built-ins are added first so a long operator registration cannot
   * push them past MAX_TOOLS — that is why they led originally. But a built-in
   * marked `yieldsToLua` has to know whether Lua is offering the same id before it
   * decides to appear at all, so the Lua list is fetched up front and only the
   * membership test happens early.
   *
   * Without this, the ImperialCAD tools silently replaced an operator's own
   * `create_call` / `attach_unit` / `close_call` — the exact ids the
   * `Config.incidents` hooks use — because built-ins win a duplicate.
   * An explicit configuration must beat an integration we merely detected.
   *
   * Still one Lua round trip: `luaOffered` is the same call the loop below used to
   * make, hoisted rather than repeated.
   */
  const callTurn = context.trigger === "call_intake" || context.serverId <= 0;
  const luaOffered = callTurn
    ? []
    : asArray(callLuaSafely<unknown>("getTools", [context], []));
  const luaIds = new Set<string>();
  for (const entry of luaOffered) {
    if (!entry || typeof entry !== "object") continue;
    const id = text((entry as Record<string, unknown>).id, 48);
    if (id) luaIds.add(id);
  }

  for (const tool of builtinTools(context)) {
    if (tool.yieldsToLua === true && luaIds.has(tool.id)) {
      aiLog.debug(`tools: ${tool.id} left to the operator's own registration`);
      continue;
    }
    seen.add(tool.id);
    // `recognizes` is carried through deliberately. This is the object `runTool`
    // and `argumentRefusal` are handed — `index.ts` resolves the tool out of this
    // list, not out of the built-in registry — so a field dropped here is a field
    // the guards never see.
    tools.push({
      id: tool.id,
      description: tool.description,
      input: tool.input,
      ...(tool.recognizes ? { recognizes: tool.recognizes } : {}),
    });
  }

  // Lua tools are radio tools, and a 911 call gets none of them.
  //
  // Not a judgement about any particular one. The whole hook is documented and
  // written against a unit on a channel — every tool an operator has shipped
  // takes a callsign, a status or a plate, and on a call there is no unit, no
  // callsign and nothing the caller said that belongs in a CAD field. Offering
  // them anyway would not produce a refused tool call; it would produce a
  // plausible one, made about a member of the public, from a sentence they said
  // while frightened.
  //
  // Nothing about this is permanent. When a server wants call-taking tools they
  // should be declared as such, the way `onCall` marks a built-in — a flag on the
  // registration, not an inference from the shape of the context.
  if (context.trigger === "call_intake") return tools;

  // And neither does an announcement, for the same reason one step further on.
  //
  // A call put out on the air is the dispatcher talking to a channel about
  // something nobody transmitted: `serverId` is 0 because there is no unit on
  // the other end of it. Measured 2026-09-21 on the first 911 harness run, with
  // the tools still offered: the dispatcher announced the call and called
  // `set_unit_status("bad crash")` against unit 0, which the operator's own Lua
  // then had to refuse — and the refusal became a second transmission
  // explaining to nobody that nobody's status had not been updated.
  //
  // The built-ins above are unaffected and should be: patching, alerts and
  // tones are things done to a *channel*, and a channel is exactly what an
  // announcement has.
  if (context.serverId <= 0) return tools;

  for (const entry of luaOffered) {
    if (tools.length >= MAX_TOOLS) break;
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = text(record.id, 48);
    const description = text(record.description, 240);
    if (!id || !description) {
      aiLog.warn("tools: skipping a tool with no id or description");
      continue;
    }
    if (seen.has(id)) {
      aiLog.warn(`tools: duplicate tool id "${id}" ignored`);
      continue;
    }
    seen.add(id);
    tools.push({ id, description, input: text(record.input, 120) ?? "" });
  }
  return tools;
}

/** `null` for a name that was never declared, including the "do nothing" empty string. */
export function resolveTool(id: string, tools: readonly AiTool[]): AiTool | null {
  if (!id) return null;
  const wanted = id.trim().toLowerCase();
  return tools.find((tool) => tool.id.toLowerCase() === wanted) ?? null;
}

/**
 * Did the model hand a tool a phrase out of the tool's own description?
 *
 * Measured, with a 1.7B local model and a status tool whose input line ended
 * "…such as 10-8, 10-97 or out at lunch": every unit on the channel was put out
 * at lunch, including one who had said "Hello dispatch". The example read as the
 * answer. The descriptions no longer carry example values, but an operator's own
 * tool can, and a wrong status a unit never gave is worse than no status.
 *
 * Three conditions together, because each alone has honest counter-examples:
 *
 *  - **More than one word.** A bare code is not a lifted phrase, and "10-8"
 *    appearing in a description must never stop a unit from going 10-8.
 *  - **Present in the tool's own text.** Otherwise it came from somewhere, and
 *    the somewhere is almost always the traffic.
 *  - **Absent from what the unit said.** A unit who genuinely says "out at lunch"
 *    means it, whatever the description happens to contain.
 */
/**
 * Words that are never a value, whatever the tool.
 *
 * A pronoun or a bare determiner is the unit referring to something, not naming it.
 */
const PLACEHOLDER_WORDS = new Set([
  "me",
  "my",
  "mine",
  "it",
  "its",
  "this",
  "that",
  "them",
  "they",
  "him",
  "her",
  "us",
  "one",
  "some",
  "any",
  "the",
  "a",
  "an",
  "there",
  "here",
  "something",
  "anything",
  "please",
  "when",
  "ready",
  "now",
  "for",
  "you",
  "your",
]);

/**
 * Is this argument a placeholder rather than a value?
 *
 * Two shapes, both tool-agnostic, and both measured rather than imagined. From
 * `probe-tool-generalisation.ts` and the harness, on a turn where the unit had asked for
 * something but not yet said WHAT:
 *
 *     "King 41, can you run a plate for me?"  ->  run_plate("plate")
 *     "41, can you run a plate for me?"       ->  run_plate("me")
 *
 * Both ran a lookup on nothing and both produced a confident, fabricated vehicle return
 * on the air, because the stub answers whatever it is handed. Neither is caught by
 * grounding — "plate" and "me" were genuinely said — and neither is caught by
 * {@link isLiftedExample}, which only fires on text absent from the transcript.
 *
 *  1. **Nothing but placeholders.** "me", "it", "this one" name nothing.
 *  2. **Nothing but the tool's own subject.** `run_plate("plate")` is the tool's topic
 *     repeated back, not a plate. Measured by every content word already appearing in the
 *     tool's own id and description — so "fire and EMS, one person trapped" survives
 *     (`person`, `trapped` appear in neither) while "plate" does not.
 *
 * This is deliberately generic. A server registers its own tools with its own logic and
 * no prompt written for them, so a rule that only knew about plates would not survive the
 * first tool somebody adds.
 */
export function isPlaceholderValue(tool: AiTool, input: string): boolean {
  const words = normalize(input).split(" ").filter(Boolean);
  // An EMPTY argument is left to the tool. `hang_up` says "you did not say what the call
  // was about" and `patch_channels` "a patch needs at least two channels" — both more
  // useful than anything generic, and preempting them replaced a good message with a
  // worse one.
  if (words.length === 0) return false;

  // A COMMAND tool's own vocabulary is a value, not a placeholder — `channel_alert`
  // is written to act on "lift", and its description and input line are where "lift"
  // is declared, so the test below was refusing the one word the tool exists to
  // honour. Here rather than in `argumentRefusal` because `resolveSelfReference`
  // gates on this function too: asked "41, can you lift it for me?", it would
  // otherwise have rewritten the argument to the asker's callsign before any refusal
  // was considered. See `AiTool.recognizes`.
  if (tool.recognizes?.(input) === true) return false;

  const content = words.filter((word) => word.length > 1 && !PLACEHOLDER_WORDS.has(word));
  if (content.length === 0) return true;

  // A number is always specific — a plate, a code, a house number — so anything
  // carrying one is a value whatever else it repeats.
  if (content.some((word) => /[0-9]/.test(word))) return false;

  const declared = new Set(
    normalize(`${tool.id} ${tool.description ?? ""} ${tool.input ?? ""}`)
      .split(" ")
      .filter(Boolean)
  );
  return content.every((word) => declared.has(word));
}

/**
 * How a unit refers to themselves. Already placeholder words, which is the point:
 * they name nobody in general and exactly one person on a radio.
 */
const SELF_WORDS = new Set([
  "i",
  "me",
  "my",
  "mine",
  "myself",
  "we",
  "us",
  "our",
  "ours",
  "ourselves",
]);

/**
 * Ways a transmission says the thing being asked for is for the ASKER.
 *
 * Deliberately a short list of shapes where the first person is the OBJECT of the
 * request — "send me", "for me", "my location" — and not merely present in it. "I
 * need you to send King 22 cover" contains a first person and is a request for
 * somebody else; it matches none of these and stays refused.
 */
const SELF_REQUEST =
  /\b(?:send|get|give|start|roll|put|dispatch|need|want)\s+(?:me|us)\b|\b(?:for|to|with)\s+(?:me|us)\b|\bmy\s+(?:location|position|20|way)\b/;

/**
 * The asker, when a placeholder argument is about them, or `null` when it is not.
 *
 * ## The one class of placeholder that resolves instead of refusing (BUG-69515)
 *
 * "King 41 to control, send me another unit." comes back as `assign_unit("another
 * unit")` or `request_cover("cover")` — an argument that restates the request rather
 * than naming anyone. {@link isPlaceholderValue} is right that it is not a value, and
 * refusing it costs the unit the unit they asked for. But on a radio the asker is
 * unambiguously the subject of their own request, and tRadio already knows who that is,
 * so this one case can be answered rather than handed back.
 *
 * ## Why it is this narrow, and must stay this narrow
 *
 * Resolving arguments from context has gone wrong here before, and read as a pass: a
 * stubbed `run_plate` was called with "Grove and Jefferson", a street from two
 * transmissions earlier, and a fabricated vehicle return went out on the air. So the
 * value comes from the turn's own `callsign`/`unitId` and from nowhere else — never from
 * the transcript, and never from history. The transcript is read only for evidence of
 * WHO, never for the value.
 *
 * Four conditions, each closing a way this could send the wrong help to the wrong unit:
 *
 *  - **A placeholder only.** An argument with content in it is the model naming
 *    somebody, right or wrong, and rewriting it would discard a third party.
 *  - **Not a tool whose input is a quote.** `run_plate("me")` must still refuse: the
 *    asker's callsign is not a plate, and a lookup answered for it is the exact failure
 *    {@link inputMustBeQuoted} exists to stop.
 *  - **Evidence the asker is the subject** — a first person in the argument, or one of
 *    the {@link SELF_REQUEST} shapes in the transmission.
 *  - **Somebody to name.** A call or an announcement has no asker, and a unit with
 *    neither callsign nor unit id cannot be named in a tool argument.
 */
export function resolveSelfReference(
  tool: AiTool,
  argument: string,
  context: Pick<AiTurnContext, "trigger" | "transcript" | "serverId" | "callsign" | "unitId">
): string | null {
  if (!isPlaceholderValue(tool, argument)) return null;
  if (inputMustBeQuoted(tool)) return null;
  if (context.trigger !== "transmission" || context.serverId <= 0) return null;

  const words = normalize(argument).split(" ").filter(Boolean);
  const aboutTheAsker =
    words.some((word) => SELF_WORDS.has(word)) || SELF_REQUEST.test(normalize(context.transcript));
  if (!aboutTheAsker) return null;

  return context.callsign || context.unitId || null;
}

export function isLiftedExample(tool: AiTool, input: string, transcript: string): boolean {
  const value = normalize(input);
  if (!value || value.split(" ").length < 2) return false;
  if (!normalize(`${tool.description} ${tool.input}`).includes(value)) return false;
  return !normalize(transcript).includes(value);
}

/** Lowercased, punctuation dropped — but hyphenated codes left whole, so "10-8" stays one word. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Filler a dispatcher puts around a status that the unit never said.
 *
 * Only ever stripped from the FRONT of the argument, and only words that carry no
 * information on their own. "showing" is the whole reason this exists: the model
 * writes the status the way a dispatcher would record it, and the unit said it the
 * way a unit says it.
 */
const STATUS_FILLER = new Set([
  "showing",
  "show",
  "shows",
  "record",
  "recording",
  "status",
  "is",
  "as",
  "now",
  "currently",
  "unit",
  "for",
  "to",
  "me",
]);

/** Words whose presence or absence never changes which status was reported. */
const GLUE = new Set(["a", "an", "the"]);

/**
 * Whether `argument` is a status the unit actually reported in `transcript`.
 *
 * Replaces an exact contiguous-substring test, which was right about the danger
 * and too strict about the wording. Measured over one harness run, 5 of 10
 * attempts were rejected for being ONE filler word away from a correct status:
 * `showing 10-8` against "Show Me 10-8", `showing shots fired` against "shots
 * fired", `10-28 on plate` against "10-28 on a plate", `unit running on foot`
 * against "one running on foot". Every one of those was a status the unit really
 * had given, refused, and then aired to them as a negative.
 *
 * **The loosening cannot let an invented status through, which is the point.**
 * Only two things are forgiven: leading filler, and articles on either side.
 * Neither carries content, so every remaining word of the status still has to
 * appear in the transmission, contiguously and in order. "showing 10-8" passes
 * only because "10-8" is in the transcript; it still fails against a unit who
 * never mentioned a code. `tools.test.ts` holds that direction as its own case.
 */
export function groundedIn(transcript: string, argument: string): boolean {
  const drop = (words: string[]) => words.filter((word) => !GLUE.has(word));
  const said = drop(normalize(transcript).split(" ").filter(Boolean));

  let quoted = normalize(argument).split(" ").filter(Boolean);
  while (quoted.length > 1 && STATUS_FILLER.has(quoted[0] as string)) quoted = quoted.slice(1);
  quoted = drop(quoted);
  if (quoted.length === 0 || said.length === 0) return false;

  // Contiguous and in order, over the de-glued word lists.
  for (let at = 0; at + quoted.length <= said.length; at++) {
    let all = true;
    for (let i = 0; i < quoted.length; i++) {
      if (said[at + i] !== quoted[i]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/**
 * Phrases a tool uses to say "this value is the unit's own words".
 *
 * A declaration, not a guess. The shipped `unit_status` says "the status the unit just
 * gave, in the words they used for it"; a plate tool says "the plate, in the letters
 * and numbers the unit gave". Both are telling tRadio the value is a QUOTE, and a
 * quote can be checked against what was actually said.
 */
const QUOTE_DECLARATIONS = [
  "in the words they used",
  "the words they used",
  "in the unit's own words",
  "the unit's own words",
  "the unit just gave",
  "the unit gave",
  "they gave",
  "as they said it",
  "in their own words",
  // One word apart from the entry above it, and that word cost a tool its grounding:
  // `add_note` declares "what to add to the call, in their words", which matched nothing
  // here, so it was never treated as quote-declared. Harmless while a placeholder
  // argument was simply refused; the moment a self-reference began resolving (BUG-69515),
  // `add_note("me")` started writing the asker's callsign into a call note instead of
  // being refused. Matching is substring-based and "in their own words" does not contain
  // "in their words", so both spellings have to be listed.
  "in their words",
];

/**
 * Must this tool's input be something the unit actually said?
 *
 * ## Why this generalised, and why it had to
 *
 * Grounding used to be hardcoded to `unit_status`, on the reasoning that an invented
 * status feeds back through the roster forever. That was the right instinct and too
 * narrow a rule, and the gap only became dangerous once a tool returned DATA.
 *
 * Measured: with a stubbed `run_plate` registered, the dispatcher answered "41, can you
 * run a plate for me?" — a turn in which no plate had been read — by calling
 * `run_plate("Grove and Jefferson")`, the street from two transmissions earlier. The
 * tool dutifully returned a vehicle, and "Grove and Jefferson returns to a 2017 Nissan
 * Frontier, no wants" went out on the air. An invented status is untidy; an invented
 * plate return is a unit acting on a vehicle that does not exist.
 *
 * So any tool that DECLARES its input is a quote gets the same check. The declaration
 * is the contract: say the value comes from the unit's own words and tRadio will hold
 * you to it. A tool whose input is genuinely tRadio's to choose — a channel name, a
 * unit to send off the roster — says so differently and is not grounded, because there
 * is nothing in the transmission to match it against.
 */
function inputMustBeQuoted(tool: AiTool): boolean {
  if (tool.id === "unit_status") return true;
  const declared = `${tool.input ?? ""}`.toLowerCase();
  return QUOTE_DECLARATIONS.some((phrase) => declared.includes(phrase));
}

/**
 * Why this argument cannot be run, or `null` if it can be.
 *
 * Factored out of {@link runTool} so a probe can score the OUTCOME rather than the
 * model's choice, against the same code the product runs. That distinction has already
 * cost a measurement programme once: `probe-tool-generalisation.ts` scored only which
 * tool was named, so `run_plate("plate")` read as a pass while the guards were taking it
 * off the air — a real improvement reading as a null result. `probe-self-report.ts` had
 * the same hole in the other direction and it hid BUG-69515: `request_cover("cover")`
 * scored `ok` for having picked a defensible tool, while the argument is nothing but the
 * tool's own subject, was refused here, and reached the unit as a negative with nobody
 * dispatched. That one now resolves — see {@link resolveSelfReference} — but only when
 * the asker is the subject of their own request; the measurement hole was the lesson.
 *
 * A probe that reimplemented these three tests would be measuring its own copy of them,
 * which is the failure mode this repo calls a gate that measures nothing. One function,
 * both callers.
 *
 * `trigger` and `transcript` are taken off the context rather than passed, so there is
 * no second way to spell the call.
 */
export function argumentRefusal(
  tool: AiTool,
  argument: string,
  context: Pick<AiTurnContext, "trigger" | "transcript" | "serverId" | "callsign" | "unitId">
): string | null {
  // Before anything else, and for every tool: a placeholder is not a value. A lookup run
  // on "plate" or "me" answers with real-looking data for nothing, which is worse than
  // refusing — see `isPlaceholderValue`. Unless it is the asker referring to themselves,
  // which `runTool` resolves to their callsign rather than refusing — see
  // `resolveSelfReference`, and note this agrees with it so the gate and the run cannot
  // disagree about whether the turn was actionable.
  if (isPlaceholderValue(tool, argument) && resolveSelfReference(tool, argument, context) === null) {
    return "you have not given me that yet";
  }

  // Status is a quote from this transmission, not generated world data. An
  // invented status otherwise feeds back through the roster on every later turn.
  if (inputMustBeQuoted(tool)) {
    if (context.trigger !== "transmission" || !groundedIn(context.transcript, argument)) {
      // Worded as a reason rather than an error, because it is read back to the model
      // and may reach the air: a unit hearing "you did not give me that" understands
      // it, and a unit hearing a validator's complaint does not.
      return tool.id === "unit_status"
        ? "the unit did not report that status in this transmission"
        : "the unit did not say that in this transmission";
    }
  }
  return null;
}

export async function runTool(
  tool: AiTool,
  input: string,
  context: AiTurnContext
): Promise<ToolResult> {
  const trimmed = input.trim().slice(0, MAX_INPUT_CHARS);

  // "send me another unit" -> the asker's own callsign, before the guards see it, so the
  // tool is handed a unit rather than the word "me". Everything else passes through
  // untouched; `resolveSelfReference` answers `null` for any argument it is not certain
  // about, and `argumentRefusal` then refuses it exactly as before.
  const resolved = resolveSelfReference(tool, trimmed, context);
  const argument = resolved ?? trimmed;

  // Tagged `argument` so the turn can tell OUR failure from the world's: the tool never
  // ran, and the request may have been perfectly actionable. See ToolResult.fault.
  const refusal = argumentRefusal(tool, argument, context);
  if (refusal) return { ok: false, message: refusal, fault: "argument" };

  // A built-in may need to hold another channel while it talks on it, which is
  // why the whole path is async even though most tools answer immediately.
  //
  // `yieldsToLua` has to be honoured HERE as well as in `describeTools`, and
  // missing it would have been invisible. Suppressing the tool from the offered
  // list is not enough on its own: this lookup is by id, so a yielding built-in
  // whose id the operator also uses would still be the thing that ran — the model
  // would be shown the operator's declaration and tRadio would execute ours.
  //
  // The id's presence in Lua's registry is asked rather than assumed, because
  // `describeTools` and `runTool` are separate entry points and a caller may reach
  // this one without the other (the harness does).
  const builtin = findBuiltin(tool.id);
  const result = await (async (): Promise<ToolResult> => {
    if (builtin && builtin.yieldsToLua === true && luaOffersTool(tool.id, context)) {
      return runLuaTool(tool, argument, context);
    }
    if (builtin) {
      try {
        return await builtin.run(context, argument);
      } catch (err) {
        aiLog.warn(`tools: ${tool.id} threw — ${(err as Error).message}`);
        return { ok: false, message: "that could not be done" };
      }
    }
    return runLuaTool(tool, argument, context);
  })();

  /**
   * A refused SUBSTITUTION is still our fault, not the world's.
   *
   * `resolveSelfReference` is tool-agnostic by design, so it will hand the asker's
   * callsign to any tool whose input is not declared a quote — including tools whose
   * argument was never a unit. `patch_channels("me")` becomes
   * `patch_channels("King 41")` and comes back "there is no channel called King 41":
   * a true statement about a value the unit never said, and `index.ts` reads an
   * untagged failure as the world having said no and airs "King 41, negative".
   *
   * No wrong action can get through — every built-in resolves its argument against
   * the directory, the alert list or the tone list and refuses an unknown one — so
   * what was left was the honesty of the line. We rewrote their words; if the tool
   * rejected the rewrite, the request may still have been perfectly actionable,
   * which is exactly what `fault: "argument"` means and what makes "go ahead" the
   * line instead of "negative".
   */
  if (resolved !== null && !result.ok && !result.fault) {
    return { ...result, fault: "argument" };
  }
  return result;
}

/** Whether the operator's registry is offering this id on this turn. */
function luaOffersTool(id: string, context: AiTurnContext): boolean {
  // A call turn is never offered Lua tools at all (see `describeTools`), so there
  // is nothing to yield to and no reason to pay for the round trip.
  if (context.trigger === "call_intake" || context.serverId <= 0) return false;
  for (const entry of asArray(callLuaSafely<unknown>("getTools", [context], []))) {
    if (!entry || typeof entry !== "object") continue;
    if (text((entry as Record<string, unknown>).id, 48) === id) return true;
  }
  return false;
}

/** Hand a tool to the operator's Lua registry and normalise whatever comes back. */
function runLuaTool(tool: AiTool, argument: string, context: AiTurnContext): ToolResult {
  const raw = callLuaSafely<unknown>("runTool", [tool.id, argument, context], null);

  if (raw === true) return { ok: true, message: "done" };
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    const ok = record.ok !== false;
    return { ok, message: text(record.message, 160) ?? (ok ? "done" : "that could not be done") };
  }
  // null (no such tool, or the call threw), false, or anything else Lua returned.
  return { ok: false, message: "the action could not be completed" };
}
