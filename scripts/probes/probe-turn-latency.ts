/**
 * Where a dispatcher turn's time actually goes.
 *
 *   bun run scripts/probe-turn-latency.ts [--turns 5]
 *
 * Development only. `smoke-local-engine.ts` proves the path answers; this one
 * asks how long each part of it takes, because the speed work needs to be aimed
 * rather than sprayed. Same code the resource runs, same provider, same prompt
 * builders — a shorter or tidier prompt than the real one would understate
 * prefill, which is the term most likely to be large.
 *
 * Reports per stage, and separates the first turn from the rest. The first pays
 * model load and an empty prefix cache and is not what a player experiences;
 * every turn after it is. Both are printed because the cold number is what an
 * owner meets on the first transmission after a restart.
 *
 * Deliberately NOT measured here: the wait between the player finishing a word
 * and the key coming up. That is the player's thumb, and PTT makes it exact —
 * which is the one latency advantage tRadio has over a voice-activity system,
 * and it is free.
 */

import { buildWav, resamplePcm } from "../../server/lib/audio";
import { applyAiConfig } from "../../server/lib/config";
import { configureLocal, stopLocalEngines } from "../../server/lib/local-engine";
import {
  buildOutcomePrompt,
  buildSystemPrompt,
  buildTurnPrompt,
  transcriptionBias,
} from "../../server/lib/prompt";
import { provider } from "../../server/lib/provider";
import { saysTheSameThing } from "../../server/lib/repeat";
import type { AiTool, AiTurnContext } from "../../server/lib/types";
import { STT_SAMPLE_RATE } from "../../server/lib/tradio-hooks";
import { installSpawnBroker } from "../sim/spawn-broker";

const g = globalThis as Record<string, unknown>;
g.GetConvar = (_name: string, fallback: string) => fallback;
g.GetCurrentResourceName = () => "tRadioAI";
g.GetResourcePath = () => process.cwd();

const args = process.argv.slice(2);
const turnsAt = args.indexOf("--turns");
const turns = turnsAt >= 0 ? Number(args[turnsAt + 1] ?? 5) : 5;
if (!Number.isInteger(turns) || turns < 1 || turns > 50) throw new Error("--turns takes 1..50");

applyAiConfig({ enabled: true, channels: [460.125], voiceGender: "female" });
// Offline there is no `exports.tLib`, so every engine `spawn.ts` starts would be
// refused. This stands tLib's REAL broker up in this process; see the module docblock.
await installSpawnBroker();
configureLocal({ root: process.cwd() });

const TOOLS: AiTool[] = [
  {
    id: "unit_status",
    description: "the unit is telling you their status, availability or location code",
    input: "the status the unit just gave, in the words they used for it",
  },
  { id: "play_tone", description: "Play an alert tone on the channel", input: "tone name" },
];

/**
 * Varied on purpose. One line repeated would sit in the prefix cache and report
 * a decode cost the game never sees.
 */
const LINES = [
  "Dispatch, King 41, show me out at the corner of Grove and Jefferson.",
  "Dispatch, King 41, I need a second unit to my location.",
  "Dispatch, King 41, show me back in service.",
  "Dispatch, King 41, can you run a plate for me when you get a chance?",
  "Dispatch, King 41, I am out with a vehicle, two occupants.",
];

/** A turn context with the roster and history a live channel carries. */
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
        serverId: 1,
        callsign: "King 41",
        unitId: "K41",
        status: "10-8",
        distance: 0,
        note: "",
        talking: false,
      },
      {
        serverId: 2,
        callsign: "King 22",
        unitId: "K22",
        status: "10-6",
        distance: 820,
        note: "",
        talking: false,
      },
    ] as AiTurnContext["roster"],
    history: [
      { who: "King 22", text: "Dispatch, King 22, show me out at the station." },
      { who: "Dispatch", text: "King 22, copy, out at the station." },
    ] as AiTurnContext["history"],
    waiting: [],
    channels: [],
  };
}

const system = buildSystemPrompt("Dispatch");
const signal = AbortSignal.timeout(600_000);

/** Milliseconds, per stage, per turn. */
const timings: Record<string, number>[] = [];

function since(at: number): number {
  return Date.now() - at;
}

try {
  for (let turn = 0; turn < turns; turn++) {
    const line = LINES[turn % LINES.length] as string;
    const stage: Record<string, number> = {};

    // Piper speaks the *player's* line here, purely to have realistic audio to
    // turn into the clip. Its cost is not one of the numbers being reported.
    const source = await provider().speak(line, "male", signal);

    // The clip as tRadio's tap delivers it. The vocoder is tRadio's, so the decode that
    // used to be a stage here is not this resource's cost and is not measured.
    const clipAt = Date.now();
    const clip = {
      bytes: buildWav(resamplePcm(source.pcm, source.sampleRate, STT_SAMPLE_RATE), STT_SAMPLE_RATE),
      mime: "audio/wav",
      filename: "transmission.wav",
    };
    stage.clip = since(clipAt);

    const heardAt = Date.now();
    const heard = await provider().transcribe(
      clip,
      signal,
      transcriptionBias(["dispatch"], ["King 41", "King 22"]),
    );
    stage.transcription = since(heardAt);

    const turnContext = context(heard || line);
    const decideAt = Date.now();

    // The speculative path, measured rather than modelled: the draft reply is
    // synthesised the moment it is complete, while the actions are still
    // decoding. On a turn that runs no tool the draft is the final reply and
    // this audio is the audio that airs; on one that does, it is thrown away and
    // the cost was CPU spent during a wait, not extra latency.
    let speculation: Promise<{ pcm: Int16Array; sampleRate: number }> | null = null;
    let draft = "";
    // Stamped inside the chain rather than at the await below, which is the only
    // way to see it: awaiting the speculation *after* awaiting the decision
    // reports the decision's wall clock, not the acknowledgement's, and would
    // have made the reordering look like it bought nothing.
    let ackReadyAt = 0;
    const decision = await provider().decide(
      system,
      buildTurnPrompt(turnContext, TOOLS),
      TOOLS,
      signal,
      (reply) => {
        draft = reply;
        stage.draftAt = since(decideAt);
        speculation = provider()
          .speak(reply, "female", signal)
          .then((audio) => {
            ackReadyAt = Date.now();
            return audio;
          });
      },
    );
    stage.decision = since(decideAt);

    // The acknowledgement, which is the transmission the unit actually waits on.
    // Awaited against the *draft*, because that is where `index.ts` airs it: the
    // rest of the decision is still decoding at this point and none of it is
    // needed to say "King 41, copy".
    const spoken = await (speculation ??
      provider().speak(decision.reply || "Copy.", "female", signal));
    stage.ackReady = ackReadyAt ? ackReadyAt - decideAt : since(decideAt);
    stage.spokenMs = Math.round((spoken.pcm.length / spoken.sampleRate) * 1000);
    stage.draftHeld = draft === decision.reply ? 1 : 0;

    // Everything the unit waits through before hearing a word. Neither the rest
    // of the decision nor `compose` is in it: both run while this is on the air,
    // which is the whole of what the reordering bought.
    stage.toFirstWord = stage.clip + stage.transcription + stage.ackReady;

    // The report-back, started where `index.ts` starts it — after the
    // acknowledgement is under way, not before it. Timed to answer one question:
    // does it finish inside the acknowledgement's own airtime? If it does, the
    // second transmission costs the unit nothing at all.
    let composed = "";
    if (decision.actions.length > 0) {
      const composeAt = Date.now();
      composed = await provider().compose(
        system,
        // The real action, with the real argument the model chose, and a success
        // message shaped like one a tool actually returns. An earlier version of
        // this passed `detail` where `AiOutcome` declares `message`, behind an
        // `as never` cast — so the prompt read "succeeded — undefined" and the
        // dispatcher sensibly replied "King 41, go ahead." on every turn. That
        // looked like a `compose` defect and was not one.
        buildOutcomePrompt(
          turnContext,
          decision.actions.map((action) => ({
            ...action,
            ok: true,
            message: `${action.tool.replace(/_/g, " ")} applied`,
          })),
        ),
        signal,
      );
      stage.compose = since(composeAt);
      // 1 when the report-back was ready before the acknowledgement finished
      // airing, i.e. the unit never waited for it.
      stage.composeHidden = stage.compose <= stage.spokenMs ? 1 : 0;
      stage.followUpAirs = saysTheSameThing(draft || decision.reply, composed) ? 0 : 1;
    }

    stage.total = stage.toFirstWord;
    timings.push(stage);
    console.log(
      JSON.stringify({
        turn,
        actions: decision.actions.length,
        draft,
        reply: decision.reply,
        composed,
        ...stage,
      }),
    );
  }

  const keys = [
    "clip",
    "transcription",
    "draftAt",
    "ackReady",
    "toFirstWord",
    "decision",
    "compose",
    "spokenMs",
  ];
  const warm = timings.slice(1);
  console.log("\nstage            cold      warm median   warm max");
  for (const key of keys) {
    const values = warm.map((t) => t[key]).filter((v): v is number => v !== undefined);
    if (values.length === 0) continue;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] as number;
    const cold = timings[0]?.[key];
    console.log(
      `${key.padEnd(15)} ${String(cold ?? "-").padStart(6)}ms ${String(median).padStart(9)}ms ` +
        `${String(sorted[sorted.length - 1]).padStart(9)}ms`,
    );
  }
} finally {
  await stopLocalEngines();
}
