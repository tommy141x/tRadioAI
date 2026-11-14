/**
 * Splits the decision's 2.3 seconds into prompt and answer.
 *
 *   bun run scripts/probe-decide-tokens.ts
 *
 * Development only. `probe-turn-latency.ts` says `decide` is over half a warm
 * turn; it cannot say why, and the two causes want opposite fixes. If the time
 * is *prefill* — reading the roster, the history and the tool list — the answer
 * is to send less of it, or to arrange it so llama-server's prefix cache keeps
 * it. If the time is *decode*, the prompt is innocent and the answer is fewer
 * generated tokens or a different model. Guessing between those would be a
 * coin flip on a day of work.
 *
 * Asks llama-server for its own timings rather than wrapping a stopwatch round
 * the call, because the stopwatch cannot see the split.
 */

import { applyAiConfig } from "../../server/lib/config";
import { post } from "../../server/lib/http";
import { configureLocal, localEndpoint, stopLocalEngines } from "../../server/lib/local-engine";
import { buildSystemPrompt, buildTurnPrompt } from "../../server/lib/prompt";
import type { AiTool, AiTurnContext } from "../../server/lib/types";
import { installSpawnBroker } from "../sim/spawn-broker";

const g = globalThis as Record<string, unknown>;
g.GetConvar = (_name: string, fallback: string) => fallback;
g.GetCurrentResourceName = () => "tRadioAI";
g.GetResourcePath = () => process.cwd();

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

const LINES = [
  "Dispatch, King 41, show me out at the corner of Grove and Jefferson.",
  "Dispatch, King 41, I need a second unit to my location.",
  "Dispatch, King 41, show me back in service.",
  "Dispatch, King 41, can you run a plate for me when you get a chance?",
];

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

// The same extra framing `provider().decide` appends, so the prompt measured is
// the prompt that runs.
const decideSystem =
  `${system}\n\n` +
  'Answer with JSON. Most traffic needs no action at all, and that is: {"actions": [], "reply": "<what you say>"}\n' +
  'When the unit did ask for something you have a tool for: {"actions": [{"tool": "<tool name>", "input": "<the value the unit gave>"}], "reply": "<what you say>"}\n' +
  "List more than one action only when the traffic genuinely needs it. Never copy an example from a tool's description — the input is what this unit said, or the tool does not apply.";

try {
  // Through the resource's own resolver rather than a hardcoded port: this is
  // what starts the engine, and a port guessed here would silently measure
  // whatever else happened to be listening.
  const route = await localEndpoint("text", signal);
  if (!route) throw new Error("the local text engine would not start");

  for (const [index, line] of LINES.entries()) {
    const body = {
      model: route.model,
      temperature: 0.2,
      max_tokens: 160,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: decideSystem },
        { role: "user", content: buildTurnPrompt(context(line), TOOLS) },
      ],
    };

    const started = Date.now();
    const reply = await post({
      url: route.url,
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify(body),
    });
    const wall = Date.now() - started;
    if (!reply.ok) throw new Error(`decide probe failed: ${reply.text().slice(0, 300)}`);

    const json = JSON.parse(reply.text()) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      timings?: Record<string, number>;
      choices?: { message?: { content?: string } }[];
    };
    const t = json.timings ?? {};
    console.log(
      JSON.stringify({
        turn: index,
        wallMs: wall,
        promptTokens: json.usage?.prompt_tokens ?? null,
        answerTokens: json.usage?.completion_tokens ?? null,
        prefillMs: t.prompt_ms != null ? Math.round(t.prompt_ms) : null,
        decodeMs: t.predicted_ms != null ? Math.round(t.predicted_ms) : null,
        prefillTps: t.prompt_per_second != null ? +t.prompt_per_second.toFixed(1) : null,
        decodeTps: t.predicted_per_second != null ? +t.predicted_per_second.toFixed(1) : null,
        content: json.choices?.[0]?.message?.content ?? "",
      }),
    );
  }
} finally {
  await stopLocalEngines();
}
