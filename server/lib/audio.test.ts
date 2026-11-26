import { describe, expect, test } from "bun:test";
import { buildWav, normalisePeak, pcmDurationMs, resamplePcm, trimTrailingSilence } from "./audio";

describe("resamplePcm", () => {
  test("returns the input untouched when the rates match", () => {
    const pcm = new Int16Array([1, 2, 3]);
    expect(resamplePcm(pcm, 8000, 8000)).toBe(pcm);
  });

  test("halves the sample count going 16k to 8k", () => {
    const pcm = new Int16Array(160).fill(1000);
    expect(resamplePcm(pcm, 16000, 8000).length).toBe(80);
  });

  test("doubles it going 8k to 16k and interpolates between samples", () => {
    const out = resamplePcm(new Int16Array([0, 1000]), 8000, 16000);
    expect(out.length).toBe(4);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(500);
  });
});

describe("buildWav", () => {
  test("writes a RIFF header the sample rate and length agree with", () => {
    const wav = buildWav(new Int16Array([0, -1, 32767]), 16000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(6);
    expect(wav.length).toBe(50);
    expect(view.getInt16(44 + 4, true)).toBe(32767);
  });
});

describe("normalisePeak", () => {
  test("lifts a quiet clip toward full scale", () => {
    const out = normalisePeak(new Int16Array([8000, -8000]));
    expect(Math.abs(out[0]!)).toBe(29163);
  });

  test("will not amplify near-silence into hiss", () => {
    // The gain ceiling, not the target, is what decides here.
    expect(normalisePeak(new Int16Array([2, -2]))[0]).toBe(16);
  });

  test("leaves silence and an already-normalised clip alone", () => {
    const silence = new Int16Array([0, 0]);
    expect(normalisePeak(silence)).toBe(silence);
    const loud = new Int16Array([29163, -29163]);
    expect(normalisePeak(loud)).toBe(loud);
  });
});

describe("pcmDurationMs", () => {
  test("reports whole-second and sub-second lengths", () => {
    expect(pcmDurationMs(new Int16Array(8000), 8000)).toBe(1000);
    expect(pcmDurationMs(new Int16Array(4000), 8000)).toBe(500);
    expect(pcmDurationMs(new Int16Array(10), 0)).toBe(0);
  });
});

describe("trimming the dead air off a transmission", () => {
  const RATE = 22050;
  /** Loud for `speechMs`, then silence. */
  function clip(speechMs: number, silenceMs: number): Int16Array {
    const speech = Math.round((speechMs / 1000) * RATE);
    const silence = Math.round((silenceMs / 1000) * RATE);
    const pcm = new Int16Array(speech + silence);
    for (let i = 0; i < speech; i++) pcm[i] = i % 2 === 0 ? 12000 : -12000;
    return pcm;
  }

  test("cuts the silence and keeps a short tail", () => {
    // Piper pads 0.28-0.42s; the keep window is there so a trailing consonant under
    // the threshold is not clipped.
    const trimmed = trimTrailingSilence(clip(1000, 400), RATE);
    const ms = (trimmed.length / RATE) * 1000;
    expect(ms).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(1000 + 100);
  });

  test("leaves a clip that has no trailing silence alone, by identity", () => {
    // Returning the same object matters: this runs on every transmission and a copy
    // per call would be pure waste.
    const tight = clip(800, 0);
    expect(trimTrailingSilence(tight, RATE)).toBe(tight);
  });

  test("never returns empty audio, even for pure silence", () => {
    // `speak.ts` treats empty audio as a failed transmission, so an all-silent clip
    // must come back unchanged rather than as nothing.
    const silent = new Int16Array(RATE);
    expect(trimTrailingSilence(silent, RATE)).toBe(silent);
    expect(trimTrailingSilence(new Int16Array(0), RATE).length).toBe(0);
  });

  test("keeps quiet speech that sits under the threshold of a loud clip", () => {
    // The clipping risk this is most likely to get wrong: a fricative at the end of
    // a loud line. The keep window has to carry it.
    const pcm = clip(500, 0);
    const quietTail = new Int16Array(pcm.length + Math.round(0.04 * RATE));
    quietTail.set(pcm);
    for (let i = pcm.length; i < quietTail.length; i++) quietTail[i] = i % 2 === 0 ? 120 : -120;
    const trimmed = trimTrailingSilence(quietTail, RATE);
    expect(trimmed.length).toBe(quietTail.length);
  });

  test("a stricter threshold trims more, so the knob is real", () => {
    const pcm = clip(500, 300);
    const gentle = trimTrailingSilence(pcm, RATE, 0, 0.5);
    expect(gentle.length).toBeLessThan(pcm.length);
  });
});
