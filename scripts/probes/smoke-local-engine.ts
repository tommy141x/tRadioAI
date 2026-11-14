/**
 * End-to-end check of the local dispatcher stack, through the real provider.
 *
 *   bun run scripts/smoke-local-engine.ts
 *
 * Development only. Speaks a line with Piper, hands it to whisper-server as the
 * 16 kHz mono WAV tRadio's transmission tap delivers, and asks llama-server for
 * a dispatch decision — the same path a transmission takes after the tap,
 * through the same code the resource runs, rather than through curl. There is no
 * IMBE round trip: tRadio owns the vocoder, so the audio here is cleaner than a
 * real transmission and the transcript is optimistic. Starting the engines is
 * part of what is being tested, so the first run takes as long as a model load.
 */

import { buildWav, resamplePcm } from "../../server/lib/audio";
import { applyAiConfig } from "../../server/lib/config";
import { configureLocal, stopLocalEngines } from "../../server/lib/local-engine";
import { transcriptionBias } from "../../server/lib/prompt";
import { provider } from "../../server/lib/provider";
import type { AiTool } from "../../server/lib/types";
import { STT_SAMPLE_RATE } from "../../server/lib/tradio-hooks";
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

const LINE = "All units be advised, shots fired at Grove and Jefferson.";
const TOOLS: AiTool[] = [
  {
    id: "unit_status",
    description: "the unit is telling you their status, availability or location code",
    input: "the status the unit just gave, in the words they used for it",
  },
  { id: "play_tone", description: "Play an alert tone on the channel", input: "tone name" },
];

const signal = AbortSignal.timeout(180_000);
let failures = 0;

function report(step: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${step.padEnd(14)} ${detail}`);
  if (!ok) failures++;
}

try {
  console.log("local dispatcher smoke test:");

  const spoken = await provider().speak(LINE, "female", signal);
  report(
    "speak",
    spoken.pcm.length > 0,
    `${spoken.pcm.length} samples @ ${spoken.sampleRate} Hz ` +
      `(${(spoken.pcm.length / spoken.sampleRate).toFixed(1)}s)`,
  );

  // The clip as the tap delivers it: mono 16-bit WAV at the contract's rate.
  const clip = {
    bytes: buildWav(resamplePcm(spoken.pcm, spoken.sampleRate, STT_SAMPLE_RATE), STT_SAMPLE_RATE),
    mime: "audio/wav",
    filename: "transmission.wav",
  };
  report("clip", true, `${clip.bytes.length} bytes ${clip.mime}`);

  const heard = await provider().transcribe(
    clip,
    signal,
    // Sent on every real turn, so the smoke sends it too: a transcription
    // server that rejected the field would take the whole feature down, and it
    // would do it in-game rather than here.
    transcriptionBias(["dispatch"], ["K31", "King 41"]),
  );
  report("transcribe", heard.length > 0, JSON.stringify(heard));

  const decision = await provider().decide(
    "You are a police dispatcher on a busy channel. Keep replies to one short transmission.",
    `1-Adam-12 transmits: "${heard || LINE}"`,
    TOOLS,
    signal,
  );
  report(
    "decide",
    decision.reply.length > 0,
    `reply=${JSON.stringify(decision.reply)} actions=${JSON.stringify(decision.actions)}`,
  );
} catch (error) {
  console.error(`\n  FAIL ${(error as Error).message}`);
  failures++;
} finally {
  stopLocalEngines();
}

console.log(failures === 0 ? "\nthe whole path answered." : `\n${failures} step(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
