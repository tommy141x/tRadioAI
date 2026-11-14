/**
 * Why the dispatcher answered four different transmissions with "Go Tommy".
 *
 *   bun run scripts/probe-echo-loop.ts [--model server/models/<file>.gguf]
 *
 * Development only. Written against a live journal (`logs/ai-dispatch.jsonl`,
 * 2026-09-19 21:16Z) in which the reply was pinned to one line across a call-up,
 * a traffic stop and a full vehicle description. It puts those same transmissions
 * to the model, varying one thing at a time, and it settled the question:
 *
 *   qwen3-1.7b-q4_k_m        "Go Tommy" to all three — the live loop, exactly
 *   qwen3-4b-instruct-2507   answers each one on its own terms
 *
 * Two hypotheses died here and are kept as the `history` axis, because both were
 * plausible and neither is true. The dispatcher records its own transmissions
 * into channel history (`recordSaid`), so a run of identical lines accumulates in
 * the prompt and looks exactly like something teaching the model to repeat — but
 * the 4B is unmoved by that run, and de-duplicating it does not help the 1.7B.
 * The prompt was not the fault; the weights were.
 *
 * Kept rather than deleted: the same shape will be wanted the next time a reply
 * looks stuck, and it is cheap to re-run against a candidate model.
 */

import { applyAiConfig } from "../../server/lib/config";
import { configureLocal, stopLocalEngines } from "../../server/lib/local-engine";
import { buildSystemPrompt, buildTurnPrompt } from "../../server/lib/prompt";
import { provider } from "../../server/lib/provider";
import type { AiTool, AiTurnContext } from "../../server/lib/types";
import { installSpawnBroker } from "../sim/spawn-broker";

const g = globalThis as Record<string, unknown>;
g.GetConvar = (_n: string, fallback: string) => fallback;
g.GetCurrentResourceName = () => "tRadioAI";
g.GetResourcePath = () => process.cwd();

applyAiConfig({ enabled: true, channels: [460.125], voiceGender: "female" });

// `--model models/….gguf` runs the comparison against a different weights file,
// which is how the model a deployed bundle was running gets put to the same
// turns as the current default rather than argued about.
const modelAt = process.argv.indexOf("--model");
const model = modelAt >= 0 ? (process.argv[modelAt + 1] ?? "") : "";
// Offline there is no `exports.tLib`, so every engine `spawn.ts` starts would be
// refused. This stands tLib's REAL broker up in this process; see the module docblock.
await installSpawnBroker();
configureLocal(model ? { root: process.cwd(), textModel: model } : { root: process.cwd() });

const TOOLS: AiTool[] = [
  {
    id: "unit_status",
    description: "the unit is telling you their status, availability or location code",
    input: "the status the unit just gave, in the words they used for it",
  },
];

/** The dispatcher's own line, exactly as `recordSaid` would have stored it. */
const ECHO = { who: "Dispatch", text: "Go Tommy" };

const CLEAN = [
  { who: "King 22", text: "Dispatch, King 22, show me out at the station." },
  { who: "Dispatch", text: "King 22, copy, out at the station." },
];

/** What the channel really held by the fourth turn of the live loop. */
const RUN = [
  ...CLEAN,
  { who: "Tommy", text: "King 41 to dispatch." },
  ECHO,
  { who: "Tommy", text: "King 41 to dispatch." },
  ECHO,
  { who: "Tommy", text: "I've got a traffic stop here." },
  ECHO,
];

/** The transmissions from the live journal, in the order they were made. */
const SAID = [
  "King 41 to dispatch.",
  "I've got a traffic stop here.",
  "It's going to be on a black two-door, eastbound on Route 68. No additional needed.",
];

function context(transcript: string, history: { who: string; text: string }[]): AiTurnContext {
  return {
    trigger: "transmission",
    serverId: 1,
    // The live unit really was named this: no callsign was set on the roster, so
    // the prompt called them by their player name while they called themselves
    // King 41 on the air. Reproduced rather than tidied — it is why the reply
    // reads "Tommy" and not "King 41", which is a separate complaint from the
    // repetition this probe is about.
    callsign: "Tommy",
    unitId: "",
    frequency: 460.125,
    channelName: "DISP",
    transcript,
    roster: [
      {
        serverId: 1,
        callsign: "Tommy",
        unitId: "",
        status: "",
        distance: 0,
        note: "",
        talking: false,
      },
    ] as AiTurnContext["roster"],
    history: history as AiTurnContext["history"],
    waiting: [],
    channels: [],
  };
}

const system = buildSystemPrompt("Dispatch");
const signal = AbortSignal.timeout(300_000);

try {
  for (const label of ["a clean history", "the history of the live loop"] as const) {
    console.log(`\n=== ${label} ===`);
    const history = label === "a clean history" ? CLEAN : RUN;
    for (const said of SAID) {
      const turn = context(said, history);
      const decision = await provider().decide(
        system,
        buildTurnPrompt(turn, TOOLS),
        TOOLS,
        signal,
        () => {},
      );
      console.log(
        `  heard "${said}"\n    -> "${decision.reply}"  actions=${decision.actions.length}`,
      );
    }
  }
} finally {
  await stopLocalEngines();
}
