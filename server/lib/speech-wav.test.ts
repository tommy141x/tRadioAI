/**
 * A WAV speech response decodes to the same PCM a raw one would.
 *
 * `speech-dialect.ts` asks Groq for `wav` because its Orpheus endpoint refuses
 * every other `response_format`. That is only free if the response path takes a
 * container as readily as raw samples, and until now nothing asserted it did —
 * `pcmFromResponse` has handled RIFF since it was written, but the only WAV in
 * these tests is the one UPLOADED for transcription, which is a different path.
 *
 * So this covers the two ways a container silently corrupts audio:
 *
 *  - **The 44-byte assumption.** A fixed offset is right only when `data` is the
 *    first chunk after `fmt `. Encoders that emit `LIST` or `fact` first push the
 *    samples along, and reading the header as samples is an audible click at the
 *    start of every line the dispatcher speaks.
 *  - **The rate assumption.** A WAV states its own rate. Ignoring it and assuming
 *    SPEECH_PCM_RATE plays 24 kHz audio at 16 kHz or the reverse — speech at the
 *    wrong pitch and speed, which is worse than silence because it sounds like a
 *    model problem rather than a decode one.
 */

import { describe, expect, test } from "bun:test";
import { pcmFromResponse } from "./provider";

/** A minimal RIFF/WAVE container around `samples`, optionally with a junk chunk first. */
function wav(samples: number[], rate: number, extraChunkBefore = false): Uint8Array {
  const data = new Int16Array(samples);
  const junk = extraChunkBefore ? 8 + 4 : 0;
  const bytes = new Uint8Array(44 + junk + data.byteLength);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true); // ← the rate the decoder must read
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  let cursor = 36;
  if (extraChunkBefore) {
    // A chunk between `fmt ` and `data`, which is exactly what breaks a fixed offset.
    ascii(cursor, "LIST");
    view.setUint32(cursor + 4, 4, true);
    cursor += 12;
  }
  ascii(cursor, "data");
  view.setUint32(cursor + 4, data.byteLength, true);
  new Uint8Array(data.buffer).forEach((b, i) => {
    bytes[cursor + 8 + i] = b;
  });
  return bytes;
}

const SAMPLES = [0, 1000, -1000, 32767, -32768, 7];

describe("a WAV speech response", () => {
  test("decodes to exactly the samples it carries", () => {
    const { pcm } = pcmFromResponse(wav(SAMPLES, 24000));
    expect([...pcm]).toEqual(SAMPLES);
  });

  test("reports the rate from its own header, not the assumed one", () => {
    expect(pcmFromResponse(wav(SAMPLES, 16000)).sampleRate).toBe(16000);
    expect(pcmFromResponse(wav(SAMPLES, 44100)).sampleRate).toBe(44100);
  });

  test("a chunk before `data` does not land in the audio", () => {
    const { pcm } = pcmFromResponse(wav(SAMPLES, 24000, true));
    expect([...pcm]).toEqual(SAMPLES);
  });
});

describe("a raw PCM speech response", () => {
  // The default path for every provider that allows `response_format: pcm`;
  // asserted here so the WAV branch cannot be made to swallow it.
  test("is still read as bare little-endian samples at the assumed rate", () => {
    const raw = new Int16Array(SAMPLES);
    const { pcm, sampleRate } = pcmFromResponse(new Uint8Array(raw.buffer));
    expect([...pcm]).toEqual(SAMPLES);
    expect(sampleRate).toBe(24000);
  });
});
