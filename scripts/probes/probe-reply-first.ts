/**
 * Does putting `reply` before `actions` cost the dispatcher its judgement?
 *
 *   bun run scripts/probe-reply-first.ts [--runs 2]
 *
 * Development only. `probe-decide-tokens.ts` established that a decision is
 * decode-bound: ~955 prompt tokens prefill in under 200 ms against a warm cache,
 * and then 34 answer tokens take about 1.4 seconds at ~23 tokens a second. Of
 * those 34, the spoken reply is about four. The rest is JSON scaffolding and the
 * tool call — and because `reply` is emitted *last*, nothing downstream can start
 * until the slowest stage is completely finished. Streaming the current shape
 * would buy exactly nothing.
 *
 * Emitting `reply` first would make it available roughly a second earlier, which
 * is a second of synthesis that happens while the actions are still decoding.
 *
 * The reason this is a probe and not a patch: an autoregressive model conditions
 * what it writes next on what it has already written. Deciding the words before
 * the action means the action is chosen to fit a sentence already committed to,
 * instead of the sentence describing the action. That could plausibly cost tool
 * accuracy, and tool accuracy is worth more than a second — a dispatcher who
 * answers fast and marks the wrong unit out of service is worse than a slow one.
 *
 * So both orderings run against the same lines, including lines that must
 * produce no action at all, and the comparison is over tool choice as well as
 * timing. Each line runs `--runs` times because temperature is 0.2, not 0.
 */

import { applyAiConfig } from "../../server/lib/config";
import { postStream } from "../../server/lib/http";
import { configureLocal, localEndpoint, stopLocalEngines } from "../../server/lib/local-engine";
import { buildSystemPrompt, buildTurnPrompt } from "../../server/lib/prompt";
import { createSseParser } from "../../server/lib/sse";
import type { AiTool, AiTurnContext } from "../../server/lib/types";
import { installSpawnBroker } from "../sim/spawn-broker";

const g = globalThis as Record<string, unknown>;
g.GetConvar = (_name: string, fallback: string) => fallback;
g.GetCurrentResourceName = () => "tRadioAI";
g.GetResourcePath = () => process.cwd();

const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const runs = runsAt >= 0 ? Number(args[runsAt + 1] ?? 2) : 2;
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("--runs takes 1..10");

/**
 * A different GGUF to answer with, absolute path. Off by default.
 *
 * Here because the ordering question turned out to be entangled with a model
 * question: both orderings scored the same, and both produced replies lifted out
 * of another unit's history. Comparing orderings on a model that cannot follow
 * the prompt measures the model, not the ordering.
 */
const modelAt = args.indexOf("--model");
const model = modelAt >= 0 ? (args[modelAt + 1] ?? "") : "";

applyAiConfig({ enabled: true, channels: [460.125], voiceGender: "female" });
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
  { id: "play_tone", description: "Play an alert tone on the channel", input: "tone name" },
];

/**
 * `expect` is what the traffic actually calls for, so a faster ordering that
 * also stops reaching for tools reads as a regression rather than as a win.
 */
const CASES: { line: string; expect: string }[] = [
  { line: "Dispatch, King 41, show me out at Grove and Jefferson.", expect: "unit_status" },
  { line: "Dispatch, King 41, show me back in service.", expect: "unit_status" },
  { line: "Dispatch, King 41, put a tone out for a pursuit.", expect: "play_tone" },
  // Must produce nothing. A model that answers first and then looks for
  // something to do is most likely to fail here.
  { line: "King 41 to dispatch.", expect: "" },
  { line: "Dispatch, King 41, traffic when ready.", expect: "" },
  { line: "Dispatch, King 41, thanks for that.", expect: "" },
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

const ACTIONS_FIRST =
  'Answer with JSON. Most traffic needs no action at all, and that is: {"actions": [], "reply": "<what you say>"}\n' +
  'When the unit did ask for something you have a tool for: {"actions": [{"tool": "<tool name>", "input": "<the value the unit gave>"}], "reply": "<what you say>"}\n' +
  "List more than one action only when the traffic genuinely needs it. Never copy an example from a tool's description — the input is what this unit said, or the tool does not apply.";

const REPLY_FIRST =
  'Answer with JSON. Most traffic needs no action at all, and that is: {"reply": "<what you say>", "actions": []}\n' +
  'When the unit did ask for something you have a tool for: {"reply": "<what you say>", "actions": [{"tool": "<tool name>", "input": "<the value the unit gave>"}]}\n' +
  "Always write the reply first, then the actions. List more than one action only when the traffic genuinely needs it. Never copy an example from a tool's description — the input is what this unit said, or the tool does not apply.";

/**
 * Finds the end of the `reply` string in a partial JSON document, or -1.
 *
 * Deliberately not `JSON.parse` on a growing prefix: an unterminated document
 * throws, so that would report nothing until the whole answer had arrived, which
 * is the thing being measured. Walks the string body instead and stops at the
 * first unescaped closing quote.
 */
function replyComplete(partial: string): boolean {
  const key = partial.indexOf('"reply"');
  if (key < 0) return false;
  const colon = partial.indexOf(":", key + 7);
  if (colon < 0) return false;
  const open = partial.indexOf('"', colon + 1);
  if (open < 0) return false;
  for (let i = open + 1; i < partial.length; i++) {
    if (partial[i] === "\\") {
      i++;
      continue;
    }
    if (partial[i] === '"') return true;
  }
  return false;
}

interface Outcome {
  ordering: string;
  line: string;
  expect: string;
  tool: string;
  reply: string;
  replyAtMs: number;
  doneAtMs: number;
}

const signal = AbortSignal.timeout(900_000);

async function ask(route: { url: string; model: string }, framing: string, line: string) {
  const started = Date.now();
  let text = "";
  let replyAt = 0;

  const parser = createSseParser();
  const stream = postStream({
    url: route.url,
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model: route.model,
      temperature: 0.2,
      max_tokens: 160,
      stream: true,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${system}\n\n${framing}` },
        { role: "user", content: buildTurnPrompt(context(line), TOOLS) },
      ],
    }),
  });

  for await (const chunk of stream) {
    for (const event of parser.push(chunk)) {
      if (!event.data || event.data === "[DONE]") continue;
      const delta = (JSON.parse(event.data) as { choices?: { delta?: { content?: string } }[] })
        .choices?.[0]?.delta?.content;
      if (!delta) continue;
      text += delta;
      if (replyAt === 0 && replyComplete(text)) replyAt = Date.now() - started;
    }
  }

  return { text, replyAt, doneAt: Date.now() - started };
}

try {
  const route = await localEndpoint("text", signal);
  if (!route) throw new Error("the local text engine would not start");

  const orderings: [string, string][] = [
    ["actions-first", ACTIONS_FIRST],
    ["reply-first", REPLY_FIRST],
  ];
  const outcomes: Outcome[] = [];

  // One throwaway call so neither ordering is charged the cold cache.
  await ask(route, ACTIONS_FIRST, "Dispatch, King 41, radio check.");

  for (let run = 0; run < runs; run++) {
    for (const testCase of CASES) {
      for (const [ordering, framing] of orderings) {
        const { text, replyAt, doneAt } = await ask(route, framing, testCase.line);
        let tool = "";
        let reply = "";
        try {
          const parsed = JSON.parse(text) as {
            reply?: string;
            actions?: { tool?: string }[];
          };
          reply = parsed.reply ?? "";
          tool = parsed.actions?.[0]?.tool ?? "";
        } catch {
          tool = "<unparseable>";
          reply = text.slice(0, 80);
        }
        outcomes.push({
          ordering,
          line: testCase.line,
          expect: testCase.expect,
          tool,
          reply,
          replyAtMs: replyAt,
          doneAtMs: doneAt,
        });
      }
    }
  }

  for (const outcome of outcomes) {
    console.log(
      JSON.stringify({
        ...outcome,
        ok: outcome.tool === outcome.expect,
        savedMs: outcome.replyAtMs > 0 ? outcome.doneAtMs - outcome.replyAtMs : null,
      }),
    );
  }

  console.log("\nordering        correct   reply at   done at   reply lands early by");
  for (const [ordering] of orderings) {
    const rows = outcomes.filter((o) => o.ordering === ordering);
    const correct = rows.filter((o) => o.tool === o.expect).length;
    const mean = (pick: (o: Outcome) => number) =>
      Math.round(rows.reduce((sum, o) => sum + pick(o), 0) / Math.max(1, rows.length));
    const replyAt = mean((o) => o.replyAtMs);
    const doneAt = mean((o) => o.doneAtMs);
    console.log(
      `${ordering.padEnd(15)} ${String(`${correct}/${rows.length}`).padStart(7)}   ` +
        `${String(replyAt).padStart(6)}ms  ${String(doneAt).padStart(6)}ms   ` +
        `${String(doneAt - replyAt).padStart(6)}ms`,
    );
  }
} finally {
  await stopLocalEngines();
}
