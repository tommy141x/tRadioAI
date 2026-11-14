/**
 * Does the dispatcher use a tool when it is the only one it has?
 *
 *   bun run scripts/probe-self-report.ts [--runs 2]
 *
 * Development only. This started as a probe for a narrower defect and the first run
 * replaced the question, so the docblock records both — the wrong question is the more
 * useful half.
 *
 * ## What it was written to measure, and why that was wrong
 *
 * Three harness cases fail by not reaching `unit_status`: `handshake` turn 3,
 * `send-another-unit` turns 1 and 3. All three carry the status as narrative ("traffic
 * stop at Grove and Jefferson", "10-4, I'm en route") rather than as a request ("show me
 * 10-8"), so the defect looked like a classification failure — the model not recognising
 * a self-report as something to record. The control was going to be the asked forms,
 * which `probe-tool-generalisation.ts` measures passing.
 *
 * The control failed. With the harness's three tools, `unit_status` was chosen **0 times
 * in 24**, including on "King 41, show me 10-8." — the one case I had a passing
 * measurement for. That measurement was real: with the eight invented tools of
 * `probe-tool-generalisation.ts`, the same system prompt and the same transmission pick
 * `unit_status` correctly. Same model, same prompt, same declaration, same traffic; the
 * only difference is **how many other tools were on the list**.
 *
 * So the variable is the tool list, and the direction is the one that matters most: a
 * SHORT list suppresses tool use. That is not a corner — **tRadio ships exactly one
 * tool.** A server that installs the resource and enables the dispatcher gets the
 * one-tool column, so if that column is empty, the feature does not work out of the box
 * and every measurement taken against a richer harness set has been flattering it.
 *
 * ## So it is a matrix
 *
 * The same traffic against three tool sets: the shipped one, the harness's three, and the
 * eight from the generalisation probe. Columns, not a single number, because the
 * hypothesis under test is about the list and a total would average it away.
 *
 * Decision only — one decode per cell, no Piper, no vocoder, no whisper. The harness
 * already asserts the whole turn; this exists to iterate a prompt sentence in minutes
 * instead of the quarter-hour three audio cases cost, and because a failure in one of
 * those four other stages would otherwise land on this verdict.
 *
 * ## The controls
 *
 * Two, and they point opposite ways. `ASKED` holds traffic for the *other* tools, so a
 * change that lifts `unit_status` by making the model reach for it indiscriminately shows
 * up as a loss there. `King 41 to control.` wants no tool at all, so a prompt that simply
 * makes the model tool-happy cannot pass. A probe whose score can only go up is not
 * measuring anything.
 */

import { applyAiConfig } from "../../server/lib/config";
import { configureLocal, stopLocalEngines } from "../../server/lib/local-engine";
import { buildSystemPrompt, buildTurnPrompt } from "../../server/lib/prompt";
import { provider } from "../../server/lib/provider";
import { recordedSelfReport } from "../../server/lib/self-report";
import { argumentRefusal } from "../../server/lib/tools";
import type { AiTool, AiTurnContext } from "../../server/lib/types";
import { installSpawnBroker } from "../sim/spawn-broker";

const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const runs = runsAt >= 0 ? Number(args[runsAt + 1] ?? 2) : 2;
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("--runs takes 1..10");

/**
 * `--cases en route,traffic stop` — substring match against what the unit says.
 *
 * For iterating on the two or three lines that are still wrong without paying for the
 * ones that are right. The totals are then over the filtered set, which is why the
 * footer says so rather than letting a 2-case run read as a suite result.
 */
/**
 * `--set shipped` — one column instead of three.
 *
 * The shipped column is the only one that decides anything, and it is a third of the
 * cost, so iterating a framing sentence against it alone is the difference between a
 * two-minute loop and a nine-minute one. Run all three before believing a result: a
 * sentence that fixes one tool and breaks eight is a worse trade than it looks.
 */
const setAt = args.indexOf("--set");
const onlySet = setAt >= 0 ? (args[setAt + 1] ?? "").toLowerCase() : "";

const casesAt = args.indexOf("--cases");
const only =
  casesAt >= 0
    ? (args[casesAt + 1] ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [];

/** Declared exactly as the resource and the harness declare them, wording included. */
const UNIT_STATUS: AiTool = {
  id: "unit_status",
  description: "the unit is telling you their status, availability or location code",
  input: "the status the unit just gave, in the words they used for it",
} as unknown as AiTool;

const RUN_PLATE: AiTool = {
  id: "run_plate",
  description: "the unit is asking you to run a plate, or has read one to you",
  input: "the plate only, in the letters and numbers the unit gave",
} as unknown as AiTool;

const ASSIGN_UNIT: AiTool = {
  id: "assign_unit",
  description: "send another unit to assist a unit who asked for one",
  input: "the callsign of the unit who needs help",
} as unknown as AiTool;

/** The five `probe-tool-generalisation.ts` invents, to reach a list of eight. */
const INVENTED: AiTool[] = [
  {
    id: "request_tow",
    description: "a vehicle needs to be towed or recovered",
    input: "where the vehicle is and what it is",
  },
  {
    id: "request_fire",
    description: "fire or EMS is needed at a location",
    input: "which service, and where it is needed",
  },
  {
    id: "request_cover",
    description: "the unit wants another unit with them, cover, or a second car",
    input: "what they need cover for",
  },
  {
    id: "put_out_bolo",
    description: "a person or vehicle should be circulated to every unit to look out for",
    input: "the description to circulate",
  },
  {
    id: "page_supervisor",
    description: "a supervisor or sergeant is being asked for",
    input: "why the supervisor is wanted",
  },
] as unknown as AiTool[];

/**
 * The tool set an ImperialCAD server gets, which is the one most real servers will run.
 *
 * Declared from what ImperialCAD's own exports can actually do, read out of
 * `utils/imperialEmergency.lua` rather than its docs — `CreateCall` returns `callnum` and
 * `callId`, `AttachCall` takes a `callnum`, `DeleteCall` takes a `callId`, `CheckPlate`
 * takes a plate and `NewCallNote` appends to whatever call the unit is already on.
 *
 * Two deliberate omissions. There is no `clear_unit` because ImperialCAD exposes no
 * detach — the registry already handles a missing handler by not offering the tool. And
 * `Booter` (set a unit off duty, stripping every assignment) is never offered to a model:
 * it is destructive, one-way, and nothing a unit says should be able to trigger it.
 *
 * This column exists because of what the three below measured. Tool-list length changes
 * the dispatcher's behaviour, so "what does enabling ImperialCAD cost" is a question that
 * has to be answered before the integration is wired, not after — six tools is already
 * past where the over-reach in BUG-26294 appears.
 */
const IMPERIAL: AiTool[] = [
  {
    id: "create_call",
    description:
      "the unit is reporting something that should become a call — a stop, a crash, a disturbance",
    input: "what the call is and where, in the unit's own words",
  },
  {
    id: "attach_unit",
    description: "a unit is being sent to, or is arriving at, a call that already exists",
    input: "which unit, and which of the calls above they are going to",
  },
  {
    id: "close_call",
    description: "the call is finished and needs nobody else on it",
    input: "which call to close",
  },
  {
    id: "add_note",
    description: "something the unit said that should be written onto the call they are on",
    input: "what to add to the call, in their words",
  },
] as unknown as AiTool[];

/**
 * The three columns.
 *
 * `shipped` is the one that decides whether the feature works for somebody who installed
 * it and wrote no `sv_functions.lua`; the other two are there to locate the effect rather
 * than to pass.
 */
const SETS: { label: string; tools: AiTool[] }[] = [
  { label: "shipped (1 tool)", tools: [UNIT_STATUS] },
  { label: "harness (3 tools)", tools: [UNIT_STATUS, RUN_PLATE, ASSIGN_UNIT] },
  { label: "rich (8 tools)", tools: [UNIT_STATUS, RUN_PLATE, ASSIGN_UNIT, ...INVENTED] },
  // Last so a `--set imperial` run is cheap and the three reference columns stay in the
  // order their history was recorded in.
  { label: "imperial (6 tools)", tools: [UNIT_STATUS, RUN_PLATE, ...IMPERIAL] },
];

interface Probe {
  say: string;
  want: string;
  /**
   * Other tools that are also a right answer, when a column makes the choice genuinely
   * ambiguous.
   *
   * One case needs it. "send me another unit" wants `assign_unit` in the shipped and
   * harness columns because nothing else could take it — but the rich column also offers
   * `request_cover`, whose description reads "the unit wants another unit with them,
   * cover, or a second car". That is at least as good an answer to that transmission, so
   * scoring it as a miss measured my choice of `want`, not the model's judgement. Same
   * correction `probe-tool-generalisation.ts` already needed once, where requiring ALL
   * argument keywords marked a correct tow argument wrong.
   */
  alsoFine?: string[];
  /** "status" rides every column; "other" only where its tool exists. */
  group: "status" | "other";
  why: string;
  /**
   * A roster and a history of this case's own, for a case whose defect needs them.
   *
   * The default fixture is two units and no history, which is deliberately the thinnest
   * context a turn can have. One case cannot use it: BUG-69515 is filed against
   * `dispatch-harness.ts`'s `send-another-unit`, where the asking turn arrives after a
   * status turn and with five units on the channel of whom exactly one is 10-8. Scoring
   * the same sentence against two units and no history measures a different turn, and
   * the probe reported the bug FIXED on that fixture while the harness still failed.
   */
  roster?: ReturnType<typeof rosterUnit>[];
  history?: { who: string; text: string; own: boolean }[];
}

function rosterUnit(serverId: number, callsign: string, unitId: string, status: string) {
  return {
    callsign,
    unitId,
    status,
    note: "",
    point: null,
    serverId,
    distance: null,
    talking: false,
  };
}

const PROBES: Probe[] = [
  // The asked form. Not narrative at all, and it is the baseline the whole suspicion
  // rested on — it belongs first because if this one fails, nothing after it is about
  // narrative traffic.
  {
    say: "King 41, show me 10-8.",
    want: "unit_status",
    group: "status",
    why: "a bare code, asked for explicitly — the easiest status there is",
  },
  // The three below are verbatim from the failing harness turns.
  {
    say: "King 41, traffic stop at Grove and Jefferson.",
    want: "unit_status",
    // Once a CAD is registered this is legitimately a call, not just a status — a real
    // dispatcher opens one. `create_call` exists only in the imperial column, so
    // accepting it here cannot wrongly pass anywhere else.
    alsoFine: ["create_call"],
    group: "status",
    why: "what the unit is doing, reported rather than requested",
  },
  {
    say: "Dispatch, King 41, show me out at Grove and Jefferson.",
    want: "unit_status",
    group: "status",
    why: "'show me' with an activity rather than a code",
  },
  {
    say: "10-4, I'm en route.",
    want: "unit_status",
    group: "status",
    why: "a status riding on an acknowledgement, from a unit just called by name",
  },
  {
    say: "King 41, I'll be out with two at the Pink Cage.",
    want: "unit_status",
    group: "status",
    // Counted in `assets/reference/real-radio-traffix.txt`: "out with" 6, and it names
    // no code, so a model leaning on the digits has nothing to lean on.
    why: "a self-report with no code in it at all",
  },
  {
    say: "King 41, plate is 6 Alpha Lima 749.",
    want: "run_plate",
    group: "other",
    why: "control: a different tool, so a status-happy prompt shows up as a loss here",
  },
  {
    say: "King 41 to control, send me another unit.",
    want: "assign_unit",
    alsoFine: ["request_cover"],
    group: "other",
    why: "control: a request that is not a status",
  },
  /**
   * BUG-69515, posed the way `dispatch-harness.ts` poses it.
   *
   * The same sentence as the case above and a different turn, which is the whole point.
   * The harness reaches it on turn 2 of `send-another-unit`: five units on the channel,
   * only King 42 available, and a status turn already in the history. On the thin default
   * fixture the model answers `assign_unit("King 41")` and the probe reports the bug
   * fixed; the reported failure is `assign_unit("another unit")`, which
   * `isPlaceholderValue` refuses and which reaches the unit as a negative with nobody
   * sent — so the ARGUMENT is what this case is for, and it is scored in the
   * `argument kept` column rather than here.
   */
  {
    say: "King 41 to control, send me another unit.",
    want: "assign_unit",
    alsoFine: ["request_cover"],
    group: "other",
    why: "BUG-69515 on the harness's own fixture: five units, one of them available",
    roster: [
      rosterUnit(1, "King 41", "K41", "10-6"),
      rosterUnit(3, "King 15", "K15", "10-6"),
      rosterUnit(4, "King 30", "K30", "10-6"),
      rosterUnit(5, "King 42", "K42", "10-8"),
    ],
    history: [
      { who: "King 41", text: "King 41, traffic stop at Grove and Jefferson.", own: false },
      { who: "Dispatch", text: "King 41, copy, traffic stop at Grove and Jefferson", own: true },
    ],
  },
  {
    say: "King 41 to control.",
    want: "",
    group: "other",
    why: "control: a call-up is nothing to record, on any tool set",
  },
  // The two below are the controls for the OPPOSITE failure, and they are the ones
  // that matter now: the framing was loosened to stop a short tool list suppressing
  // tool use, and the way that goes wrong is a dispatcher writing everything it hears
  // into a status field. `unit_status` has measurably suffered from exactly that —
  // "10-28 on a plate" and "plate status unknown" have both been written into it as
  // statuses. Both of these ride every column, because a one-tool server is also the
  // one with nowhere else for stray traffic to go.
  {
    say: "Dispatch, is King 22 still on that call?",
    want: "",
    group: "other",
    why: "control: a question about ANOTHER unit is not this unit's status",
  },
  {
    say: "King 41, be advised there's a lot of traffic on the bridge.",
    want: "",
    group: "other",
    why: "control: a report with no status in it — a road condition is not what a unit is doing",
  },
];

const g = globalThis as Record<string, unknown>;
g.GetConvar = (_name: string, fallback: string) => fallback;
g.GetCurrentResourceName = () => "tRadioAI";
g.GetResourcePath = () => process.cwd();

applyAiConfig({ enabled: true, channels: [460.125], voiceGender: "female" });
await installSpawnBroker();
configureLocal({ root: process.cwd() });

/**
 * "10-4, I'm en route" is the one line that is unintelligible on its own.
 *
 * What makes it addressed to dispatch is that dispatch just called this unit by name, so
 * the preceding exchange has to be in the history or the probe is measuring whether the
 * model answers an unaddressed fragment — a different question, with a different right
 * answer.
 */
const CALLED_OUT = [
  { who: "King 41", text: "King 41 to control, send me another unit.", own: false },
  { who: "Dispatch", text: "King 41 copy. King 42, route to Grove and Jefferson.", own: true },
];

function context(probe: Probe): AiTurnContext {
  const isK42 = probe.say.startsWith("10-4");
  return {
    trigger: "transmission",
    serverId: isK42 ? 5 : 1,
    callsign: isK42 ? "King 42" : "King 41",
    unitId: isK42 ? "K42" : "K41",
    frequency: 460.125,
    channelName: "DISP",
    transcript: probe.say,
    // King 41 is 10-6 rather than 10-8 so that "show me 10-8" is a real change. Left at
    // 10-8 it is arguably a no-op, and a model declining to record a status a unit
    // already has would be right for a reason this probe is not asking about.
    roster: probe.roster ?? [
      rosterUnit(1, "King 41", "K41", "10-6"),
      rosterUnit(5, "King 42", "K42", "10-8"),
    ],
    history: probe.history ?? (isK42 ? CALLED_OUT : []),
    waiting: [],
    channels: [],
  } as unknown as AiTurnContext;
}

const system = buildSystemPrompt("Dispatch");
const signal = AbortSignal.timeout(900_000);

/**
 * The model's own classification, pulled back out of the raw JSON.
 *
 * Deliberately not `parseDecision` — that is the shipped parser and it keeps only what
 * the turn loop needs, dropping `kind` and `about` entirely. Reaching past it is right
 * here: the thing being diagnosed is a field the product does not retain.
 */
function describe(raw: string): string {
  try {
    const body = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as {
      kind?: unknown;
      about?: unknown;
      reply?: unknown;
    };
    return (
      `kind="${String(body.kind ?? "")}" about="${String(body.about ?? "")}"` +
      ` reply="${String(body.reply ?? "")}"`
    );
  } catch {
    return `unparsed: ${raw.slice(0, 160).replace(/\s+/g, " ")}`;
  }
}

interface Tally {
  status: [number, number];
  other: [number, number];
  /**
   * Of the tool calls this column made, how many had an argument the guards accept.
   *
   * ## Why the choice alone was the wrong thing to score
   *
   * This probe scored `picked === probe.want` and nothing else for its whole history,
   * which is the same hole `probe-tool-generalisation.ts` had to close and for the same
   * reason: a tool the model named with a value it invented is not a working turn. It
   * hid BUG-69515 completely. "King 41 to control, send me another unit." came back
   * `request_cover("cover")` and scored `ok` — `request_cover` is in `alsoFine` and
   * fairly so — while "cover" is nothing but the tool's own subject, `isPlaceholderValue`
   * refuses it, and what the unit actually hears is "King 41, negative" with nobody
   * sent. The same shape with `assign_unit("another unit")` is the filed bug.
   *
   * Counted over every turn that named a tool, right or wrong, because an argument the
   * guards reject costs a unit a negative whichever tool it was attached to.
   * {@link argumentRefusal} is imported rather than reimplemented so this measures the
   * product's guards and not a copy of them.
   */
  argument: [number, number];
}

async function measure(tools: AiTool[], label: string): Promise<Tally> {
  const tally: Tally = { status: [0, 0], other: [0, 0], argument: [0, 0] };
  const have = new Set(tools.map((tool) => tool.id));
  console.log(`\n${label}`);
  for (const probe of PROBES) {
    // A probe for a tool this column does not have would record a miss that says nothing
    // about the column. Skipped rather than scored, and the skip is visible in the n.
    if (probe.want && !have.has(probe.want)) continue;
    if (only.length > 0 && !only.some((needle) => probe.say.toLowerCase().includes(needle)))
      continue;
    for (let run = 0; run < runs; run++) {
      /**
       * `kind` and `about` are printed on a miss, and that is not decoration.
       *
       * The probe threw them away for its first three runs and every verdict was
       * therefore "it chose nothing" with no way to tell WHY — a model that labelled
       * the traffic a call-up and a model that labelled it a report and then found no
       * tool are the same line of output and want opposite fixes. `RADIO_FRAMING` makes
       * `kind` decide the actions, so `kind` is the actual decision under test.
       */
      let raw = "";
      const decision = await provider().decide(
        system,
        buildTurnPrompt(context(probe), tools),
        tools,
        signal,
        undefined,
        (text) => {
          raw = text;
        },
        "radio",
      );
      /**
       * The turn loop's own self-report step, applied here for the same reason the
       * guards are: this probe reads `provider().decide` directly, so without it the
       * column measures the decision layer and not the dispatcher.
       *
       * That is not a detail — the whole point of `recordedSelfReport` is that it takes
       * BUG-72482's decision away from the model, so a probe that only watches the model
       * would report the fix as a null result. Imported from `server/lib/ai`, never
       * restated, so the probe cannot drift from what `index.ts` runs.
       */
      const recorded = recordedSelfReport(decision, context(probe), tools);
      const action = decision.actions[0] ?? recorded ?? undefined;
      const picked = action?.tool ?? "";
      const ok = picked === probe.want || (probe.alsoFine ?? []).includes(picked);
      const slot = tally[probe.group];
      slot[1]++;
      if (ok) slot[0]++;

      // The argument, scored against the product's own guards. Only when a tool was
      // named at all: a turn that correctly chose nothing has no argument to refuse,
      // and counting it as a pass would let the "use no tool" cases inflate the column.
      let refusal: string | null = null;
      if (picked) {
        const chosen = tools.find((entry) => entry.id === picked);
        if (chosen) {
          refusal = argumentRefusal(chosen, (action?.input ?? "").trim(), context(probe));
          tally.argument[1]++;
          if (!refusal) tally.argument[0]++;
        }
      }

      console.log(
        `  ${ok ? "ok  " : "MISS"} ${probe.want || "(none)"} <- ${picked || "(none)"}` +
          `${action?.input ? ` "${action.input}"` : ""}   ${probe.say}`,
      );
      if (!ok) console.log(`       ${describe(raw)}`);
      // Printed on its own line and with the tool's own reason, because the reason IS
      // the transmission: this is the text the model is handed and the unit hears a
      // version of.
      if (refusal) console.log(`       REFUSED: ${refusal}`);
    }
  }
  return tally;
}

/**
 * `--dump "show me 10-8"` — print the prompt for that case in every column and stop.
 *
 * Added after four rounds of editing framing text without once reading what the model
 * is actually handed. Two of those rounds moved the number the wrong way, and the one
 * structural question outstanding — what differs between a one-tool prompt and a
 * three-tool one, given it flips "show me 10-8" from a status to a go-ahead — is
 * answerable by looking, for free, which is the order those two things belong in.
 *
 * Exits before any decode, so it also works with no engine on the machine.
 */
const dumpAt = args.indexOf("--dump");
if (dumpAt >= 0) {
  const needle = (args[dumpAt + 1] ?? "show me 10-8").toLowerCase();
  const probe = PROBES.find((entry) => entry.say.toLowerCase().includes(needle));
  if (!probe) throw new Error(`no probe matches "${needle}"`);
  console.log(`=== system (identical in every column) ===\n${system}\n`);
  for (const set of SETS) {
    console.log(`=== turn prompt: ${set.label} ===`);
    console.log(buildTurnPrompt(context(probe), set.tools));
    console.log("");
  }
  await stopLocalEngines();
  process.exit(0);
}

const results: { label: string; tally: Tally }[] = [];
try {
  for (const set of SETS) {
    if (onlySet && !set.label.toLowerCase().startsWith(onlySet)) continue;
    results.push({ label: set.label, tally: await measure(set.tools, set.label) });
  }
} finally {
  await stopLocalEngines();
}

const pct = ([n, of]: [number, number]) =>
  of === 0 ? " n/a" : `${((n / of) * 100).toFixed(0)}%`.padStart(4);
console.log(`\n${"-".repeat(62)}`);
console.log("tool set              unit_status        other tools (control)   argument kept");
for (const { label, tally } of results) {
  console.log(
    `${label.padEnd(20)}  ${pct(tally.status)} (${tally.status[0]}/${tally.status[1]})` +
      `        ${pct(tally.other)} (${tally.other[0]}/${tally.other[1]})` +
      `          ${pct(tally.argument)} (${tally.argument[0]}/${tally.argument[1]})`,
  );
}
console.log(
  "\nRead the COLUMN, not the total. `shipped` is what a server gets having written\n" +
    "no tools of its own, so it is the only row that decides whether the feature\n" +
    "works out of the box. A control that fell is a tool-happy prompt, not a fix.\n" +
    "`argument kept` is the OUTCOME: a tool named with a value the guards refuse is a\n" +
    "negative on the air and nobody dispatched, however defensible the choice was.",
);
const shipped = results.find((entry) => entry.label.startsWith("shipped"))?.tally;
process.exitCode =
  shipped && shipped.status[0] === shipped.status[1] && shipped.argument[0] === shipped.argument[1]
    ? 0
    : 1;
