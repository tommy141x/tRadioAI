import type { AiOutcome } from "./types";

/**
 * Saying what a tool did, without asking the model to put it into words.
 *
 * Every tool's `run` already returns a message written to be spoken — the tool
 * contract in `server/sv_tools.lua` says so in as many words: "run's message
 * is read back to the model, which then says it on the air — so write it as a
 * reason, not an error code. 'the CAD is offline' becomes a sensible transmission;
 * 'ERR_TIMEOUT' does not." So for the common turn there is nothing left to decide,
 * and a generation is several seconds spent rephrasing a sentence that was already
 * correct.
 *
 * Measured, that rephrasing is not neutral. It produced "King 41, status is now out
 * at Bespucci Station" immediately after "copy, K41, out at the Bespucci Station" —
 * two transmissions, one fact — and on a bad turn it is where invented detail got
 * in. Airing the tool's own words removes a model call AND the only place in a
 * successful turn where something untrue could appear.
 *
 * **Deliberately only for a single outcome.** A turn that ran two tools needs a
 * judgement about what matters and in what order, which is what the model is for;
 * joining two messages with "and" would be a guess. Those fall through to
 * composition, and they are rare.
 */

/** Does this line already name the unit, so that prefixing would say it twice? */
function alreadyNames(message: string, callsign: string): boolean {
  const flat = message.toLowerCase();
  const name = callsign.trim().toLowerCase();
  if (!name) return true;
  if (flat.includes(name)) return true;
  // "K41" against "King 41": the digits are what identify anyone, and a message
  // built by a tool from its own roster may spell the callsign either way.
  const digits = name.replace(/[^0-9]/g, "");
  return digits.length > 0 && flat.includes(digits);
}

/**
 * The transmission for a finished action, or `null` to let the model write it.
 *
 * `callsign` is the unit being answered; an empty one is fine and simply means
 * nothing is prefixed.
 */
export function outcomeReadback(outcomes: readonly AiOutcome[], callsign = ""): string | null {
  if (outcomes.length !== 1) return null;
  const outcome = outcomes[0];
  if (!outcome || !outcome.ok) return null;

  const message = outcome.message.trim();
  if (!message) return null;

  // `hang_up`'s success message is an instruction to the model, not a line — it
  // says what to tell the caller rather than telling them. `index.ts` already
  // filters it out before reporting; this is the second lock on the same door,
  // because it is the one message in the product that must never be aired.
  if (outcome.tool === "hang_up") return null;

  // Their callsign first, every time — the rule the system prompt opens its
  // transmission shape with, applied here in code rather than hoped for.
  return alreadyNames(message, callsign) ? message : `${callsign}, ${message}`;
}

/**
 * Kept as the old name so existing callers and tests keep working.
 *
 * @deprecated Use {@link outcomeReadback}, which covers every tool rather than
 * only `unit_status`.
 */
export function statusOutcomeReply(outcomes: readonly AiOutcome[]): string | null {
  if (outcomes.length !== 1) return null;
  const outcome = outcomes[0];
  if (!outcome || outcome.tool !== "unit_status") return null;
  return outcomeReadback(outcomes);
}
