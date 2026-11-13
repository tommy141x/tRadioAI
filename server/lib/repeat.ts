/**
 * Whether a follow-up transmission would be saying the same thing twice.
 *
 * The dispatcher now acknowledges a unit before running their request and
 * reports back after — which is what a real one does, and is what takes the
 * rewrite off the critical path. The cost of that shape is a second
 * transmission, and a second transmission is only worth keying the channel for
 * if it carries something the first did not.
 *
 * Note which way the question is asked. This is *not* "are these two sentences
 * similar". It is "is everything in the follow-up already in the acknowledgement"
 * — containment, not similarity — because the two lines are deliberately
 * different lengths. "King 41, copy, back in service" followed by "K41, status
 * is now back in service" is a repeat and should not air; the same
 * acknowledgement followed by "King 41, plate returns a 2019 Ford, no wants" is
 * the answer the unit asked for and must.
 *
 * Getting this wrong is cheap in both directions, which is why it is allowed to
 * be a heuristic at all: a false "repeat" loses a confirmation the unit mostly
 * already has, and a false "new" airs one redundant sentence. Neither costs
 * latency — by the time this is consulted the unit has already been answered.
 *
 * Pure: no clock, no IO, no randomness.
 */

/**
 * Words that carry no information on a radio.
 *
 * Deliberately short, and deliberately not a general English stopword list. Two
 * groups: grammar that any paraphrase will shuffle, and the procedural filler a
 * dispatcher says in every single transmission — "copy", "roger", "go ahead" —
 * which would otherwise make every pair of lines look like it shared content.
 */
const NOISE = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "by",
  "copy",
  "copies",
  "for",
  "from",
  "go",
  "has",
  "have",
  "in",
  "is",
  "it",
  "its",
  "now",
  "of",
  "off",
  "on",
  "ok",
  "okay",
  "out",
  "received",
  "roger",
  "show",
  "showing",
  "that",
  "the",
  "there",
  "this",
  "to",
  "up",
  "was",
  "we",
  "were",
  "will",
  "with",
  "you",
  "your",
]);

/**
 * The words in a line that would tell a unit something.
 *
 * Punctuation goes, case goes, and a hyphen becomes a space so that `10-8` and
 * `10 8` are the same two tokens — which matters, because `sayable` rewrites
 * ten-codes on the way to the voice and the two lines being compared here may
 * have been through it a different number of times.
 */
function content(line: string): Set<string> {
  const words = line
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    // A letter glued to a number is an identifier written short — `K41` for
    // `King 41` — and splitting it is what lets the two spellings of the same
    // unit compare equal. Single characters then drop out below, leaving the
    // number, which is the part that identifies anyone.
    .replace(/([a-z])(?=[0-9])|([0-9])(?=[a-z])/g, "$1$2 ")
    .split(" ")
    .filter((word) => word.length > 1 && !NOISE.has(word));
  return new Set(words);
}

/**
 * How much of a follow-up must already have been said for it to be a repeat.
 *
 * Two thirds, and the margin around it is **thin** — which is worth writing down
 * because an earlier version of this comment claimed the opposite and was wrong
 * within the hour. Measured pairs: "K41, second unit requested acknowledged."
 * against "King 41, copy, second unit requested." scores 0.80 and is suppressed;
 * "K41, status updated to back in service." against "King 41, copy, back in
 * service." scores 0.60 and airs, on the strength of one word. Only the
 * genuinely-new cases sit clear — "King 41, plate returns a 2019 Ford, no
 * wants." scores 0.25, and anything carrying an unsaid number never reaches the
 * ratio at all.
 *
 * So do not read a verdict near the line as meaningful. What keeps that
 * acceptable is the asymmetry of the two mistakes: the expensive direction —
 * suppressing an outcome the unit needed — is guarded separately, because a
 * failed action always airs and a new number always airs. What is left to get
 * wrong is whether a confirmation the unit mostly already has gets said twice,
 * and a dispatcher confirming something twice is not a defect.
 */
const REPEAT_RATIO = 2 / 3;

/**
 * True when `followUp` tells the unit nothing `acknowledged` did not.
 *
 * An empty follow-up is a repeat by definition — there is nothing in it — which
 * is the answer that keeps the caller from keying an empty transmission.
 */
export function saysTheSameThing(acknowledged: string, followUp: string): boolean {
  const already = content(acknowledged);
  const saying = content(followUp);
  if (saying.size === 0) return true;

  let shared = 0;
  for (const word of saying) {
    if (already.has(word)) {
      shared++;
      continue;
    }
    // A number nobody has said yet is never a paraphrase. A plate, a time, a
    // case number or another unit's callsign is the entire reason a follow-up
    // exists, and one digit's difference is a different answer — so this
    // short-circuits the ratio rather than being counted by it.
    if (/[0-9]/.test(word)) return false;
  }
  return shared / saying.size >= REPEAT_RATIO;
}
