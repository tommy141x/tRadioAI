/**
 * "Does this call have somewhere to send a unit yet?"
 *
 * Answered here, by the server, because the model cannot be relied on to answer
 * it. The call-taker prompt forbids asking for an address twice in three separate
 * places — the system prompt, the answer framing, and the last line of the turn
 * prompt, which is the position nothing else follows — and measured across three
 * calls on 2026-09-21 and again on 2026-10-04 the model still spent whole turns
 * on "You said 12 Magellan Avenue, behind the laundromat. Is that correct?" and
 * "You mentioned a crash at Elgin and Vespucci. Is that correct?". Every one of
 * those confirmations was about the LOCATION, and every one cost a turn of
 * somebody's emergency to learn nothing.
 *
 * So the question stops being the model's to reason about. The turn prompt now
 * states the answer as a fact, and this is what computes it.
 *
 * ## Which way to be wrong
 *
 * Not symmetric, so the threshold is deliberately high.
 *
 * Claiming a location exists when it does not is the worse error: the dispatcher
 * stops asking, the call ends, and a unit is sent nowhere — and as the prompt
 * says, the address is the one thing that cannot be recovered after the line
 * drops. Claiming none exists when the caller gave one costs a single turn and a
 * caller who repeats themselves.
 *
 * Therefore evidence must be POSITIVE and specific. A bare street-type word is
 * not evidence: "he ran across the road" and "I'm driving down the street" both
 * contain one, and a detector that accepted them would go quiet on exactly the
 * calls that most need the question asked.
 */

import type { AiTurnContext } from "./types";

/**
 * A street with a name on it — "Elgin Avenue", "12 Magellan Avenue".
 *
 * Two constraints, and it is worth being precise about which one earns its keep,
 * because a plausible-sounding wrong answer here was my first one.
 *
 * **The street TYPE is matched case-sensitively, and there is no `i` flag.** That
 * is the whole discriminator. Whisper capitalises the type as part of a proper
 * name — "Magellan Avenue" — and leaves the generic noun lowercase in "driving
 * down the street", so case alone separates an address from a sentence that
 * merely mentions a road. Proved by control: adding `/i` makes "down the street"
 * read as an address and `location.test.ts` catches it. **Do not add the flag**,
 * and do not add a lowercase spelling to the alternatives.
 *
 * The leading `[A-Z][\w'-]*\s+` is the secondary constraint: it requires a
 * name-shaped token in front, so a bare "Avenue" is not an address either. On its
 * own it rejects nothing the case-sensitivity does not — removing it leaves every
 * test green — so it is a narrowing, not the guard.
 *
 * Deliberately NOT anchored to a house number: an intersection has none, and an
 * intersection is a perfectly good place to send a unit.
 */
const NAMED_STREET =
  /\b[A-Z][\w'-]*\s+(?:Ave|Avenue|St|Street|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Hwy|Highway|Fwy|Freeway|Pkwy|Parkway|Plaza|Terrace|Circle|Alley|Pier|Canal)\b/;

/** "corner of Grove and Jefferson", "intersection of …" — named, not generic. */
const CROSS_STREET = /\b(?:corner|intersection|junction|crossing)\s+of\s+[A-Z]/;

/**
 * The forms that are an address without being a street.
 *
 * `mile marker` and a postal code are both things a unit can be sent to, and
 * neither carries a street name. Both are required to be followed by the digits
 * that make them specific, so "somewhere near the mile markers" is not an
 * address.
 */
const OTHER_MARKER = /\bmile\s*marker\s*\d|\bpostal\s*\d|\bblock\s+of\s+[A-Z]/i;

function looksLikeAnAddress(text: string): boolean {
  if (!text) return false;
  return NAMED_STREET.test(text) || CROSS_STREET.test(text) || OTHER_MARKER.test(text);
}

/**
 * Whether this call already has a location worth sending a unit to.
 *
 * Three sources, in order of how much they can be trusted:
 *
 *  1. `call.location` — derived server-side through the `getLocation`
 *     hook from the caller's own coordinates. Authoritative when present, and
 *     absent on a server with no postals or CAD.
 *  2. What the caller just said.
 *  3. What the caller said earlier on this call. The dispatcher's own lines are
 *     excluded: it reads back street names constantly, so counting them would let
 *     one hallucinated address convince the server it had one.
 */
export function hasLocationEvidence(context: AiTurnContext): boolean {
  if ((context.call?.location ?? "").trim()) return true;
  if (looksLikeAnAddress(context.transcript)) return true;
  return context.history.some((entry) => !entry.own && looksLikeAnAddress(entry.text));
}

/**
 * The location this call is known to have, for naming it back to the model.
 *
 * Only the server-derived one, never a string scraped out of a transcript: a
 * phrase lifted from speech-to-text and presented to the model as established
 * fact is how a mis-heard street becomes a confident address. When this is empty
 * but {@link hasLocationEvidence} is true, the caller said it and the transcript
 * above the instruction is already the better copy.
 */
export function knownLocation(context: AiTurnContext): string {
  return (context.call?.location ?? "").trim();
}
