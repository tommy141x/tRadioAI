/**
 * How closely does our dispatcher SOUND like a real one?
 *
 *   bun run scripts/dispatch-style.ts /e/tradio-ai-runs/<run>/harness.log
 *
 * Development only. `dispatch-harness.ts` says whether a turn was correct; this
 * says whether the traffic reads like radio, by measuring our transmissions
 * against `assets/reference/real-radio-traffix.txt` — ~4,200 transmissions of real
 * police, fire and EMS traffic from a scanner feed.
 *
 * It exists because "sounds like a bot" was the one judgement in this whole area
 * being made by eye, and eye-judgements of style are exactly what drift. Every
 * number below is computed the same way on both sides, so a prompt change can be
 * argued from the gap rather than from taste.
 *
 * ## What the reference can and cannot settle
 *
 * The corpus is a single unlabelled stream: dispatcher and unit traffic are
 * interleaved in one transcript with no speaker tags, and it is itself
 * speech-to-text output with its own errors. So it supports *distributional*
 * comparison — how long a transmission is, which acknowledgement words occur, how
 * often an acknowledgement carries a detail — and it cannot support anything
 * needing to know who spoke. The echo metric is therefore reported for us alone,
 * with the bare-acknowledgement share as the reference-backed proxy beside it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const REFERENCE = path.join(import.meta.dir, "..", "assets", "reference", "real-radio-traffix.txt");

const logPath = process.argv[2];
if (!logPath) throw new Error("usage: dispatch-style.ts <harness.log>");

/** Words, lowercased, punctuation gone. Hyphenated codes kept whole so 10-4 is one token. */
function words(line: string): string[] {
  return line
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const NOISE = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "to",
  "on",
  "at",
  "of",
  "and",
  "or",
  "i",
  "m",
  "it",
  "that",
  "this",
  "you",
  "your",
  "me",
  "my",
  "we",
  "be",
  "for",
  "in",
  "s",
]);
const content = (line: string) => words(line).filter((w) => w.length > 1 && !NOISE.has(w));

interface Shape {
  label: string;
  lines: string[];
  /** Unit transmissions paired with our replies, where the source provides them. */
  pairs?: { heard: string; said: string }[];
}

function describe(shape: Shape): { total: number; acks: number; bare: number } {
  const { label, lines } = shape;
  const counts = lines.map((l) => words(l).length).sort((a, b) => a - b);
  const total = counts.length;
  if (total === 0) {
    console.log(`\n${label}: nothing to measure`);
    return { total: 0, acks: 0, bare: 0 };
  }
  const median = counts[Math.floor(total / 2)] as number;
  const mean = counts.reduce((sum, n) => sum + n, 0) / total;
  const p90 = counts[Math.min(total - 1, Math.floor(total * 0.9))] as number;

  // Token sets, not regex word boundaries. Every `` written into this file from
  // a shell heredoc arrived as a literal backspace (0x08) and silently matched
  // nothing, which reported 0% on both sides and read like a finding. `grep` and
  // `cat -n` both hide the character, so the only safe move is not to need it.
  const tokensOf = (line: string) => new Set(words(line));
  const saysPhrase = (line: string, phrase: string) => line.toLowerCase().includes(phrase);
  const saysWord = (line: string, word: string) => tokensOf(line).has(word);
  const anyTenCode = (line: string) => /10[- ]?[0-9]{1,2}/.test(line);
  const says1004 = (line: string) => saysPhrase(line, "10-4") || saysPhrase(line, "10 4");

  const ACK_OPENERS = ["copy", "10-4", "10 4", "go ahead", "negative", "received", "roger"];
  /**
   * An acknowledgement, allowing the callsign to come first.
   *
   * Ours are "22, copy" because the system prompt requires the callsign first;
   * the reference has "Copy." The first anchored-only version therefore counted
   * 11 of our transmissions against 275 of the reference's and reported our bare
   * share as 0%, which was an artifact of the detector rather than a difference in
   * behaviour.
   */
  const isAck = (line: string) => {
    const flat = line
      .toLowerCase()
      .replace(/[^a-z0-9\s-]+/g, " ")
      .trim();
    const withoutCallsign = flat.replace(/^[a-z]?[0-9]{1,4}[a-z]?[\s,]+/, "");
    return ACK_OPENERS.some((o) => flat.startsWith(o) || withoutCallsign.startsWith(o));
  };

  const per100 = (n: number) => ((n / total) * 100).toFixed(1).padStart(5);
  const countBy = (pred: (line: string) => boolean) => lines.filter(pred).length;
  const acks = lines.filter(isAck);
  /**
   * Bare: the acknowledgement word, optionally a callsign, and nothing else.
   *
   * The callsign has to come off before counting, and that is the whole subtlety.
   * Ours are "22, copy" because the system prompt requires the callsign first; the
   * reference's bare lines are "Copy." with no callsign at all. Counting raw content
   * words therefore scored every one of ours as NOT bare and reported 0% against a
   * reference 42% — twice — which read as a behavioural gap when it was a definition
   * mismatch. A callsign is not a read-back detail.
   */
  const bare = acks.filter((line) => {
    const stripped = line
      .toLowerCase()
      .replace(/[^a-z0-9\s-]+/g, " ")
      .trim()
      .replace(/^[a-z]?[0-9]{1,4}[a-z]?[\s,]+/, "")
      .replace(/[\s,]+[a-z]?[0-9]{1,4}[a-z]?$/, "");
    return content(stripped).length <= 1;
  }).length;

  console.log(`
${label}  (${total} transmissions)`);
  console.log(`  words           median ${median}   mean ${mean.toFixed(1)}   p90 ${p90}`);
  console.log(`  per 100 transmissions:`);
  console.log(`    copy          ${per100(countBy((l) => saysWord(l, "copy")))}`);
  console.log(`    10-4          ${per100(countBy(says1004))}`);
  console.log(`    go ahead      ${per100(countBy((l) => saysPhrase(l, "go ahead")))}`);
  console.log(`    negative      ${per100(countBy((l) => saysWord(l, "negative")))}`);
  console.log(`    any ten-code  ${per100(countBy(anyTenCode))}`);
  console.log(
    `  acknowledgements ${acks.length}, of which BARE ${bare}` +
      (acks.length > 0 ? `  (${((bare / acks.length) * 100).toFixed(0)}%)` : ""),
  );
  // The per-100 rates share a denominator with UNIT traffic on the reference side,
  // because the corpus is one unlabelled stream — indicative, not comparable. This
  // is the fair version: among the transmissions that ARE acknowledgements, which
  // word was used. Those are overwhelmingly a dispatcher's line on both sides.
  if (acks.length > 0) {
    const share = (pred: (line: string) => boolean) =>
      `${((acks.filter(pred).length / acks.length) * 100).toFixed(0)}%`;
    console.log(
      `  mix within acknowledgements: copy ${share((l) => saysWord(l, "copy"))}` +
        `, 10-4 ${share(says1004)}` +
        `, go ahead ${share((l) => saysPhrase(l, "go ahead"))}` +
        `, negative ${share((l) => saysWord(l, "negative"))}`,
    );
  }

  if (shape.pairs && shape.pairs.length > 0) {
    // The tell. A reply built mostly out of the words just said to it is the thing
    // a player reads as "it did not understand me, it repeated me".
    let echoed = 0;
    let heavy = 0;
    for (const pair of shape.pairs) {
      const said = content(pair.said);
      if (said.length === 0) continue;
      const heard = new Set(content(pair.heard));
      const share = said.filter((w) => heard.has(w)).length / said.length;
      echoed += share;
      if (share >= 0.6) heavy++;
    }
    const n = shape.pairs.length;
    console.log(
      `  echo of the unit's own words: mean ${((echoed / n) * 100).toFixed(0)}%` +
        `, and ${heavy} of ${n} replies are 60%+ the unit's words`,
    );
  }

  return { total, acks: acks.length, bare };
}

// ── the reference ────────────────────────────────────────────────────────────
const refBody = readFileSync(REFERENCE, "utf8")
  .split(/\r?\n/)
  .filter((line) => !/^[\d.]+\s*-\s*[\d.]+$/.test(line.trim()))
  .join("\n");
const refLines = refBody
  .split(/(?<=[.?!])\s+/)
  .map((u) => u.trim())
  .filter((u) => u && u !== "...");

// ── ours, out of the harness log ─────────────────────────────────────────────
//
// `drafted:` is the reply and `then:` the follow-up — the two things the
// dispatcher actually decided to say. `held:` is excluded on purpose: it is a
// fixed line, so counting it would flatter every statistic it touches.
const raw = readFileSync(logPath, "utf8");
// Strips the ANSI colour the log is written with. There is no way to recognise an
// escape sequence without naming its escape character, which is what the rule below
// would otherwise object to.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC (0x1b) is the point
const plainLog = raw.replace(/\[[0-9;]*m/g, "");

/**
 * What the dispatcher actually put on the air, read per turn.
 *
 * Parsed as blocks rather than line by line, because which line aired depends on the
 * others in its turn: when a turn reports an outcome the acknowledgement is MERGED and
 * never transmitted, so a `then:` means the `drafted:`/`reply:` above it was withheld.
 * Counting both — which the first version did — measured the dispatcher saying things
 * the unit never heard, and inflated every vocabulary statistic with the model's own
 * acknowledgement on exactly the turns where it had been suppressed.
 *
 * `held:` is excluded on purpose. It is a fixed line, so counting it would flatter
 * every statistic it touches — and when it fired on every turn it was the single most
 * repetitive thing in the log, which excluding it also HID. It is reported separately
 * below for that reason.
 */
const ours: string[] = [];
const pairs: { heard: string; said: string }[] = [];
let holds = 0;
let turns = 0;

for (const block of plainLog.split(/^.*turn — /m).slice(1)) {
  turns++;
  const stop = block.indexOf("turn — ");
  const body = stop >= 0 ? block.slice(0, stop) : block;
  // Plain string parsing, not a built RegExp. A pattern assembled through a template
  // literal has to survive two layers of backslash escaping to reach the regex engine,
  // and when it did not every field came back empty and the comparison reported
  // "nothing to measure" — which looks like a quiet log rather than a broken parser.
  const grab = (label: string): string => {
    for (const line of body.split(String.fromCharCode(10))) {
      const trimmed = line.trim();
      if (!trimmed.startsWith(`${label}:`)) continue;
      const open = trimmed.indexOf('"');
      const close = trimmed.lastIndexOf('"');
      if (open >= 0 && close > open) return trimmed.slice(open + 1, close);
    }
    return "";
  };
  const heard = grab("heard");
  const held = grab("held");
  const drafted = grab("drafted");
  const settled = grab("reply");
  const followUp = grab("then");
  if (held) holds++;

  // A `then:` is the whole transmission for its turn; otherwise the reply is.
  const aired = followUp ? [followUp] : [settled || drafted].filter(Boolean);
  for (const line of aired) {
    ours.push(line);
    pairs.push({ heard, said: line });
  }
}

console.log(`reference: ${path.basename(REFERENCE)}`);
console.log(`ours:      ${logPath}`);
const ref = describe({ label: "REAL TRAFFIC (reference)", lines: refLines });
describe({ label: "tRADIO AI DISPATCHER", lines: ours, pairs });

/**
 * The instrument's own negative control, against a fixed input.
 *
 * The reference file does not change, so its numbers are known: ~4,200
 * transmissions, of which a few hundred are acknowledgements and a large minority
 * of those are bare. A run that measures zero of either has a broken detector, not
 * a quiet corpus — and that is not hypothetical. Two versions of this script
 * reported 0% on both sides and read like a finding: one because every regex word
 * boundary had arrived from a shell heredoc as a literal backspace, the other
 * because the acknowledgement test was anchored and our own lines put the callsign
 * first. Both looked like results.
 */
if (ref.total < 1000)
  throw new Error(`reference parsed as ${ref.total} transmissions — detector broken`);
if (ref.acks < 50)
  throw new Error(`reference found ${ref.acks} acknowledgements — detector broken`);
if (ref.bare < 10)
  throw new Error(`reference found ${ref.bare} bare acknowledgements — detector broken`);
// Reported separately, because excluding `held:` from the statistics above is exactly
// what hid it: a fixed line said on EVERY turn is the most repetitive thing in the
// log, and "stand by"/"standby" is 0.2% of the reference corpus (8 of 4,183).
console.log(
  `  holds: ${holds} of ${turns} turns said stand by` +
    `   (reference: 8 of 4183 transmissions, 0.2%)`,
);
console.log("\n(reference sanity check passed: the detectors are measuring something)");
