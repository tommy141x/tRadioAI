/**
 * Can one AI dispatcher hold a channel with twenty or thirty people on it?
 *
 *   bun run scripts/dispatch-load.ts --units 20 --rate 0.5 --minutes 3
 *
 * Development only. `dispatch-harness.ts` asks whether a turn is correct and
 * `dispatch-style.ts` whether it sounds right; both drive one unit at a time into an
 * idle channel. This asks the question neither can: what happens when more traffic
 * arrives than the dispatcher can answer.
 *
 * The arithmetic is not close. A measured turn is 8-16 seconds wall, 5-8 of it the
 * model decoding and the rest airtime, so one dispatcher serves roughly five
 * transmissions a minute. Thirty units transmitting once a minute each offer thirty.
 * So the interesting question is not "is it fast enough" — it is not — but **how it
 * fails**: which traffic is dropped, how long the answered units waited, and whether
 * the dispatcher stays coherent while it is behind.
 *
 * ## What is real and what is not
 *
 * The whole pipeline is real: the same vocoder, whisper, model, tools and turn loop
 * the resource runs. Two economies, neither touching what is being measured:
 *
 *  - **Speech is cached per distinct line** (`dispatch-sim.ts`), so thirty units
 *    saying "10-8" cost one Piper run. The audio and its pacing are identical.
 *  - **Transmissions are serialised on the air**, one unit keying at a time, because
 *    that is what half-duplex RF enforces. What overlaps is a unit transmitting
 *    while the dispatcher is still answering an earlier one, which is the subject.
 *
 * `--rate` is offered load in transmissions per unit per minute. The airtime of the
 * transmissions themselves is part of the budget, exactly as on a real channel: a
 * channel cannot offer more traffic than it has seconds for, so a run may deliver
 * fewer than intended and that is reported rather than corrected for.
 */

import { type SimUnit, startDispatchSim } from "./dispatch-sim";

const args = process.argv.slice(2);
function num(flag: string, fallback: number): number {
  const at = args.indexOf(flag);
  if (at < 0) return fallback;
  const value = Number(args[at + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} wants a positive number`);
  return value;
}

const unitCount = Math.round(num("--units", 20));
const ratePerUnit = num("--rate", 0.5);
const minutes = num("--minutes", 3);

/**
 * Burst mode: the shape a real roleplay channel actually has.
 *
 *   --bursts 6 --burst 4 --gap 25
 *
 * The rate mode models a channel talking continuously, which is the wrong picture for
 * twenty or thirty people in a channel: most are listening most of the time, and
 * traffic arrives in clusters when something happens. This offers up to `--burst`
 * transmissions back to back, waits `--gap` seconds, and repeats.
 *
 * It answers a different question from the rate mode — not "where is the ceiling" but
 * "does a burst clear before the next one arrives". Both are worth having: the rate
 * mode says when it breaks, this says whether ordinary use gets anywhere near that.
 */
const burstCount = Math.round(num("--bursts", 0));
const burstSize = Math.round(num("--burst", 4));
const gapSeconds = num("--gap", 25);

/**
 * What units say, in the proportions the reference corpus shows.
 *
 * Counted in `assets/reference/real-radio-traffix.txt`: routine self-reports with no
 * question in them are ~11% of all traffic and requests ~10%, descriptions the bulk.
 * The mix follows that shape rather than being evenly spread — an all-requests
 * channel would overstate the model's share of the work and an all-status one would
 * understate it. Every line is short, which is also faithful: the corpus median is
 * five words.
 */
const ROUTINE = [
  "10-8.",
  "Show me 10-6.",
  "I will be en route.",
  "Arrived.",
  "Show me clear.",
  "Citizen contact.",
  "Code 4.",
  "Out with two.",
];
const DESCRIPTIVE = [
  "Suspect is northbound on foot.",
  "Vehicle is a grey sedan.",
  "Nothing further at this time.",
  "Still out on the traffic stop.",
  "No additional needed.",
];
const REQUESTS = [
  "Can you start me another unit?",
  "Can you pull a case for that?",
  "Can you show me en route?",
  "Can I get a second unit here?",
];

/** The mix, flattened so a draw is one index. Routine and descriptive weighted x2. */
const TRAFFIC = [...ROUTINE, ...ROUTINE, ...DESCRIPTIVE, ...DESCRIPTIVE, ...REQUESTS];

/**
 * Deterministic pseudo-random, so two runs of the same arguments compare like with
 * like. A load result that moved because the dice moved would be unreadable, and
 * comparing configurations is the entire purpose.
 */
let seed = 0x5eed1234;
function next(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
}

const FREQUENCY = 460.125;
const units: SimUnit[] = Array.from({ length: unitCount }, (_, index) => ({
  serverId: index + 1,
  callsign: `King ${11 + index}`,
  unitId: `K${11 + index}`,
  status: "10-8",
}));

const UNITS = new Map(units.map((unit) => [unit.serverId, unit]));
const LUA = {
  getTools: () => [
    {
      id: "unit_status",
      description: "the unit is telling you their status, availability or location code",
      input: "the status the unit just gave, in the words they used for it",
    },
  ],
  runTool: (id: string, argument: string, context: { serverId?: number }) => {
    if (id !== "unit_status") return null;
    const unit = UNITS.get(context?.serverId ?? -1);
    const cleaned = argument
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.,;!?]+$/, "");
    if (!cleaned || cleaned.length > 48) return { ok: false, message: "you did not give a status" };
    if (!unit) return { ok: false, message: "their unit could not be identified" };
    unit.status = cleaned;
    return { ok: true, message: `${unit.callsign} is now showing ${cleaned}` };
  },
};

// NOT installing the spawn broker here, deliberately. `startDispatchSim` installs
// it AFTER `installFivemStubs`, which is the only order that works: the stubs
// replace `globalThis.exports` wholesale, so a broker installed first is thrown
// away by them. Doing it here cost a run with a confusing "broker unavailable".
const sim = await startDispatchSim({
  frequency: FREQUENCY,
  channelName: "DISP",
  units,
  lua: LUA,
});

const offered: { unit: SimUnit; line: string; at: number }[] = [];
const startedAt = Date.now();
const mark = sim.mark();

console.log(
  burstCount > 0
    ? `${unitCount} units in channel, ${burstCount} bursts of up to ${burstSize}, ${gapSeconds}s apart`
    : `${unitCount} units, ${ratePerUnit}/unit/min offered, ${minutes} min` +
        `  =>  ${(unitCount * ratePerUnit * minutes).toFixed(0)} transmissions intended`,
);

/** One transmission, composed the way real units address dispatch. */
async function offerOne(unit: SimUnit): Promise<void> {
  const body = TRAFFIC[Math.floor(next() * TRAFFIC.length)] as string;
  const number = (unit.unitId ?? unit.callsign).replace(/^K/, "").replace(/^King /, "");
  await sim.transmitOnly(unit, `${number}, ${body}`);
  offered.push({ unit, line: `${number}, ${body}`, at: Date.now() });
}

try {
  if (burstCount > 0) {
    for (let burst = 0; burst < burstCount; burst++) {
      const talkers = 1 + Math.floor(next() * burstSize);
      const chosen = new Set<number>();
      while (chosen.size < Math.min(talkers, units.length)) {
        chosen.add(Math.floor(next() * units.length));
      }
      const before = sim.mark();
      const burstAt = Date.now();
      for (const index of chosen) await offerOne(units[index] as SimUnit);
      // Wait for the burst to clear, or for the channel to fall quiet with traffic
      // still unanswered — which is the result, not an error.
      const cleared = await sim.turnsSince(before, chosen.size, 120_000, 30_000);
      const waits = cleared
        .map((turn) => turn.toFirstWordMs)
        .filter((value): value is number => value !== null);
      console.log(
        `  burst ${burst + 1}: ${chosen.size} talker(s) -> ${cleared.length} answered in ` +
          `${((Date.now() - burstAt) / 1000).toFixed(1)}s` +
          (waits.length > 0 ? `, slowest wait ${Math.max(...waits)}ms` : "") +
          (cleared.length < chosen.size ? `  ** ${chosen.size - cleared.length} DROPPED **` : ""),
      );
      if (burst < burstCount - 1) {
        await new Promise((resolve) => setTimeout(resolve, gapSeconds * 1000));
      }
    }
  } else {
    const until = startedAt + minutes * 60_000;
    const gapMs = 60_000 / (unitCount * ratePerUnit);
    let nextAt = startedAt;

    while (Date.now() < until) {
      const unit = units[Math.floor(next() * units.length)] as SimUnit;
      // Opened with the unit's own number, which is how real units address dispatch:
      // "dispatch" appears in 0.45% of the reference corpus and a leading callsign in
      // 12.6% ("369 arrived.", "1-51, citizen contact.", "3-14, I'll be in route.").
      //
      // Not decoration — it is what makes the traffic ADDRESSED. The first version of
      // this file used bare lines and every one came back "not addressed to dispatch",
      // so the dispatcher never took a turn and the queue under test was never touched.
      // A load test whose load is all ignored measures nothing.
      const body = TRAFFIC[Math.floor(next() * TRAFFIC.length)] as string;
      const number = (unit.unitId ?? unit.callsign).replace(/^K/, "").replace(/^King /, "");
      const line = `${number}, ${body}`;
      const wait = nextAt - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const at = Date.now();
      await sim.transmitOnly(unit, line);
      offered.push({ unit, line, at });
      nextAt += gapMs;
      process.stdout.write(`  offered ${offered.length}\r`);
    }
  }

  // Drain what the queue accepted, then stop once the channel has been quiet long
  // enough that nothing more is coming.
  process.stdout.write("  draining...            \n");
  const turns = await sim.turnsSince(mark, offered.length, 180_000, 45_000);

  const answered = turns.filter((turn) => turn.journal.aired);
  const byUnit = new Map<number, number>();
  for (const turn of turns) {
    byUnit.set(turn.journal.serverId, (byUnit.get(turn.journal.serverId) ?? 0) + 1);
  }
  const waits = turns
    .map((turn) => turn.toFirstWordMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const elapsedMin = (Date.now() - startedAt) / 60_000;
  const pct = (n: number, of: number) => (of === 0 ? "n/a" : `${((n / of) * 100).toFixed(0)}%`);

  console.log("-".repeat(62));
  console.log(
    `offered        ${offered.length} over ${elapsedMin.toFixed(1)} min` +
      `  (${(offered.length / elapsedMin).toFixed(1)}/min)`,
  );
  console.log(`turns taken    ${turns.length}  (${pct(turns.length, offered.length)} of offered)`);
  console.log(
    `answered       ${answered.length}  (${pct(answered.length, offered.length)} of offered)`,
  );
  console.log(`DROPPED        ${offered.length - turns.length}  - never got a turn at all`);
  if (waits.length > 0) {
    const at = (q: number) => waits[Math.min(waits.length - 1, Math.floor(waits.length * q))];
    console.log(
      `wait to first word   median ${at(0.5)}ms   p90 ${at(0.9)}ms   worst ${waits[waits.length - 1]}ms`,
    );
  }
  // Coherence under load: the thing most likely to go wrong when behind.
  const lines = answered.map((turn) =>
    turn.journal.reply
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim(),
  );
  const distinct = new Set(lines.filter(Boolean)).size;
  console.log(`distinct replies     ${distinct} of ${lines.length} aired`);
  console.log(`units ever answered  ${byUnit.size} of ${unitCount}`);
} finally {
  await sim.close();
}
