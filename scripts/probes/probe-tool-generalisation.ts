/**
 * Can the dispatcher use a tool it has never been shown, from its declaration alone?
 *
 *   bun run scripts/probe-tool-generalisation.ts [--runs 2] [--sweep]
 *
 * `--sweep` re-runs every case at 1, 3, 6 and 8 offered tools instead of only at the
 * full list. That exists to check the claim the tool-selection cluster rests on — that
 * accuracy falls as the number of registered tools grows — before anything is built to
 * work around it. At a single length the over-reach direction is invisible, because a
 * tool that is never withheld can never be shown to have been wrongly offered.
 *
 * Development only, and it measures the bet the whole feature rests on.
 *
 * tRadio ships one tool. Everything else a server wants — a tow, a BOLO, a supervisor,
 * fire or EMS, a CAD call — is registered by the operator in `config/sv_functions.lua`
 * and auto-discovered, with no prompt written for it. So the dispatcher never gets a
 * per-scenario playbook: it gets a name, a one-line description and a description of the
 * input, and has to work out from the traffic which tool this is and what to put in it.
 *
 * If that generalises, a server can add any capability and the dispatcher handles
 * scenarios nobody enumerated. If it does not, the feature only works for the cases
 * somebody wrote down, which is the opposite of the intent.
 *
 * ## What this measures, and what it deliberately does not
 *
 * It asks only the question the model is actually responsible for: **given traffic and a
 * list of tool declarations, which tool and what argument.** It does not synthesise
 * speech, does not run the tools, and does not go near the vocoder — so it costs one
 * decode per case instead of a full turn, and a failure here cannot be blamed on
 * speech-to-text.
 *
 * The tools below are plausible but invented, and none of them appears anywhere in the
 * prompts. That is the point: they stand in for whatever a server will add, so a pass
 * means the mechanism generalises rather than that these particular tools were
 * anticipated.
 *
 * Two things are scored separately, because they fail independently and want different
 * fixes:
 *
 *  - **choice** — was the right tool picked (or correctly none at all)
 *  - **argument** — was the value sane for that tool's declared input
 *
 * A right tool with a nonsense argument is the failure mode already measured in the
 * harness: `run_plate("me")` from "can you run a plate for me", which a grounding check
 * passes because "me" really was said.
 */

import { applyAiConfig } from "../../server/lib/config";
import { configureLocal, stopLocalEngines } from "../../server/lib/local-engine";
import { buildSystemPrompt, buildTurnPrompt } from "../../server/lib/prompt";
import { provider } from "../../server/lib/provider";
import { isPlaceholderValue } from "../../server/lib/tools";
import type { AiTool, AiTurnContext } from "../../server/lib/types";
import { installSpawnBroker } from "../sim/spawn-broker";

const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const runs = runsAt >= 0 ? Number(args[runsAt + 1] ?? 2) : 2;
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("--runs takes 1..10");
const sweep = args.includes("--sweep");

/**
 * A plausible server's tool set. Invented, and named/described the way an operator would.
 *
 * Deliberately overlapping in places — `request_tow` and `request_fire` are both "call
 * another service", `attach_unit` and `request_cover` both involve sending somebody — so
 * the model has to discriminate rather than pick the only candidate.
 */
const TOOLS: AiTool[] = [
  {
    id: "unit_status",
    description: "the unit is telling you their status, availability or location code",
    input: "the status the unit just gave, in the words they used for it",
  },
  {
    id: "run_plate",
    description: "the unit is asking you to run a plate, or has read one to you",
    input: "the plate only, in the letters and numbers the unit gave",
  },
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
  {
    id: "create_call",
    description: "the unit is reporting something that should become a call in the CAD",
    input: "what the call is and where, in the unit's own words",
  },
] as unknown as AiTool[];

interface Probe {
  say: string;
  /** The tool the traffic calls for, or "" for none. */
  want: string;
  /**
   * Words a sane argument would contain AT LEAST ONE of. Empty when any value is fine.
   *
   * Any rather than all, which it was first: "blocking the lane" is a perfectly good tow
   * argument and failed for not also saying "vehicle", so the probe was marking the model
   * down for my wording rather than for a mistake.
   */
  argumentHas?: string[];
  /** Words that mean the argument is the wrong KIND of thing. */
  argumentNot?: string[];
  why: string;
}

/**
 * Traffic the dispatcher has never been shown, for tools it has never been shown.
 *
 * Phrasings follow `assets/reference/real-radio-traffix.txt` rather than being written to
 * suit the tools — a probe whose traffic quotes the tool descriptions back would measure
 * nothing but string matching.
 */
const PROBES: Probe[] = [
  {
    say: "King 41, this vehicle is going to need a tow, it's blocking the lane.",
    want: "request_tow",
    argumentHas: ["vehicle", "lane", "blocking"],
    why: "a tow is a tow even though no prompt mentions towing",
  },
  {
    say: "King 41, we're going to need fire and EMS out here, one person trapped.",
    want: "request_fire",
    argumentHas: ["fire", "ems"],
    why: "two services named at once, and a different tool from a tow",
  },
  {
    say: "King 41, can I get a supervisor out to this scene?",
    want: "page_supervisor",
    why: "a supervisor is not cover and not a second unit",
  },
  {
    say: "King 41, suspect is a white male in a red hoodie, last seen northbound on foot.",
    want: "put_out_bolo",
    argumentHas: ["red", "hoodie"],
    why: "a description with nobody to send it to is a BOLO, not a call",
  },
  {
    say: "King 41, start me another unit, I've got one running.",
    want: "request_cover",
    why: "cover, which overlaps with every other send-somebody tool",
  },
  {
    say: "King 41, plate is 6 Alpha Lima 749.",
    want: "run_plate",
    argumentHas: ["749"],
    // The measured failure: "can you run a plate for me" produced run_plate("me").
    argumentNot: ["me", "king", "plate is"],
    why: "the argument must be the plate and nothing else",
  },
  {
    say: "King 41, show me 10-8.",
    want: "unit_status",
    argumentHas: ["10-8"],
    why: "the simplest case, and the one it gets wrong most often",
  },
  {
    say: "King 41, can you run a plate for me?",
    want: "",
    // Nothing to run yet. The right answer is a go-ahead and no tool at all.
    why: "a request with its value still missing must not be run on a placeholder",
  },
];

const g = globalThis as Record<string, unknown>;
g.GetConvar = (_name: string, fallback: string) => fallback;
g.GetCurrentResourceName = () => "tRadioAI";
g.GetResourcePath = () => process.cwd();

applyAiConfig({ enabled: true, channels: [460.125], voiceGender: "female" });
await installSpawnBroker();
configureLocal({ root: process.cwd() });

function context(transcript: string): AiTurnContext {
  return {
    trigger: "transmission",
    serverId: 1,
    callsign: "King 41",
    unitId: "K41",
    frequency: 460.125,
    channelName: "DISP",
    transcript,
    roster: [
      {
        callsign: "King 41",
        unitId: "K41",
        status: "10-8",
        note: "",
        point: null,
        serverId: 1,
        distance: null,
        talking: false,
      },
      {
        callsign: "King 22",
        unitId: "K22",
        status: "10-8",
        note: "",
        point: null,
        serverId: 2,
        distance: null,
        talking: false,
      },
    ],
    history: [],
    waiting: [],
    channels: [],
  } as unknown as AiTurnContext;
}

const system = buildSystemPrompt("Dispatch");
const signal = AbortSignal.timeout(600_000);
interface Score {
  scored: number;
  choice: number;
  argument: number;
  executed: number;
}

/**
 * Score every probe against one particular set of offered tools.
 *
 * Extracted so the same cases can be run at several list lengths. The default mode
 * offers all of them and prints exactly what it always printed.
 *
 * **A tool that is not offered cannot be the right answer.** When the wanted tool is
 * absent the expected answer becomes "no tool", so each length is measured in both
 * directions at once: whether a tool that IS offered still gets picked (under-reach),
 * and whether a tool that is NOT offered gets substituted by a nearly-right one
 * (over-reach). That second direction is the one BUG-26294 is about, and it cannot be
 * seen at a single length.
 */
async function measure(offered: AiTool[], label: string): Promise<Score> {
  const score: Score = { scored: 0, choice: 0, argument: 0, executed: 0 };
  const offeredIds = new Set(offered.map((tool) => tool.id));
  if (label) console.log(`\n=== ${label} ===`);

  for (const probe of PROBES) {
    const want = probe.want && offeredIds.has(probe.want) ? probe.want : "";
    for (let run = 0; run < runs; run++) {
      const decision = await provider().decide(
        system,
        buildTurnPrompt(context(probe.say), offered),
        offered,
        signal,
        undefined,
        undefined,
        "radio",
      );
      const action = decision.actions[0];
      const picked = action?.tool ?? "";
      const value = (action?.input ?? "").toLowerCase();
      const okChoice = picked === want;

      // Only meaningful when the right tool was picked; a wrong tool's argument is not a
      // separate failure, and counting it as one would double-penalise the same mistake.
      let okArgument = okChoice;
      if (okChoice && want) {
        const wanted = probe.argumentHas ?? [];
        if (wanted.length > 0 && !wanted.some((need) => value.includes(need.toLowerCase()))) {
          okArgument = false;
        }
        for (const banned of probe.argumentNot ?? []) {
          if (value.includes(banned.toLowerCase())) okArgument = false;
        }
      }

      /**
       * Would this actually have run? The model's choice is only half the outcome.
       *
       * `runTool` refuses a placeholder argument and, for a tool declaring a quoted
       * input, one the unit never said. Scoring only the decision missed that entirely:
       * the guards took `run_plate("plate")` off the air without changing this probe's
       * number at all, which made a real improvement look like a null result.
       *
       * For a case whose right answer is NO tool, a refusal counts as correct — the
       * guard reaching the same verdict the model should have is a worse route to the
       * right outcome, but it is the right outcome.
       */
      const guarded =
        !!picked &&
        !isPlaceholderValue(
          offered.find((tool) => tool.id === picked) ?? offered[0],
          action?.input ?? "",
        );
      // A tool the model invented that was never offered cannot run at all, so it is
      // the right outcome for a case whose answer is "no tool" and a wrong one
      // otherwise. Without this an off-list name scored as a pass.
      const runnable = guarded && offeredIds.has(picked);
      const okExecuted = want ? okArgument && runnable : !runnable;
      if (okExecuted) score.executed++;

      score.scored++;
      if (okChoice) score.choice++;
      if (okArgument) score.argument++;
      const mark = okExecuted ? "ok  " : okChoice ? (okArgument ? "GUARD" : "ARG ") : "TOOL";
      console.log(
        `  ${mark} ${want || "(none)"} <- ${picked || "(none)"}` +
          `${action?.input ? ` "${action.input}"` : ""}   ${probe.say}`,
      );
    }
  }
  return score;
}

/** Lengths the cluster's claim is about: accuracy is reported to fall as this grows. */
const SWEEP = [1, 3, 6, 8];

const rows: Array<{ offered: number; score: Score }> = [];
try {
  if (sweep) {
    for (const n of SWEEP) {
      if (n > TOOLS.length) continue;
      rows.push({ offered: n, score: await measure(TOOLS.slice(0, n), `${n} offered`) });
    }
  } else {
    rows.push({ offered: TOOLS.length, score: await measure(TOOLS, "") });
  }
} finally {
  await stopLocalEngines();
}

const pct = (n: number, of: number) => `${((n / of) * 100).toFixed(0)}%`;
console.log(`\n${"-".repeat(62)}`);

if (sweep) {
  console.log(`cases          ${PROBES.length} x ${runs} runs, at each length`);
  console.log("offered  right tool    sane value    right OUTCOME");
  for (const { offered, score } of rows) {
    const s = score.scored;
    console.log(
      `${String(offered).padStart(7)}  ` +
        `${`${score.choice}/${s} (${pct(score.choice, s)})`.padEnd(14)}` +
        `${`${score.argument}/${s} (${pct(score.argument, s)})`.padEnd(14)}` +
        `${score.executed}/${s} (${pct(score.executed, s)})`,
    );
  }
  console.log(
    "\nA sweep is a MEASUREMENT, not a gate: it always exits 0. The number to read is\n" +
      "the trend down the first column — whether choice really degrades with length, on\n" +
      "this model and this tree. Several of these failures are stochastic (reported at 3\n" +
      "of 6 runs), so one run per length tells you very little; use --runs 4 or more.",
  );
} else {
  const { score } = rows[0];
  const s = score.scored;
  console.log(`cases          ${PROBES.length} x ${runs} runs = ${s}`);
  console.log(`right tool     ${score.choice} of ${s}  (${pct(score.choice, s)})`);
  console.log(`and sane value ${score.argument} of ${s}  (${pct(score.argument, s)})`);
  console.log(
    `right OUTCOME  ${score.executed} of ${s}  (${pct(score.executed, s)})` +
      "   after runTool's guards",
  );
  console.log(
    "\nThese tools appear in no prompt. A low score here is the generalisation the\n" +
      "feature depends on, not a missing case — adding a case would hide it.",
  );
  process.exitCode = score.executed === s ? 0 : 1;
}
