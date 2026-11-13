/**
 * Small audio helpers for the AI dispatcher path.
 *
 * Pure and dependency-free on purpose: everything here runs on FXServer's tick,
 * so the only acceptable cost is a pass over a few seconds of 8 kHz mono.
 */

/** Null rather than throwing — a malformed packet is a dropped packet, not a crash. */
export function base64ToBytes(value: string): Uint8Array | null {
  try {
    const buf = Buffer.from(value, "base64");
    // Buffer.from silently ignores garbage rather than failing, so an input that
    // decoded to nothing was not base64 in any useful sense.
    if (buf.length === 0) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/**
 * Linear resampling.
 *
 * Not a windowed sinc, and deliberately so. The two conversions this does are
 * 8 kHz up to whatever the transcriber wants and the synthesiser's rate down to
 * 8 kHz, and in both cases the signal has already been through a 3.4 kHz vocoder
 * or is about to be. Interpolation artefacts land far above anything that
 * survives that, and an FIR pass over every transmission would not.
 */
export function resamplePcm(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    out[i] = Math.round(input[left]! * (1 - fraction) + input[right]! * fraction);
  }
  return out;
}

/** Mono 16-bit PCM in a RIFF container — the one format every transcriber reads. */
export function buildWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);

  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk length
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i]!, true);
  return out;
}

/**
 * Peak-normalise toward a target, but never amplify noise.
 *
 * The synthesiser's output level is its own business and varies between voices
 * and backends; the vocoder takes full-scale int16 and its reconstruction quality
 * depends on getting near it. The gain ceiling stops a near-silent clip from
 * being multiplied into a hiss, and the headroom stops a frame reaching 0 dBFS,
 * which the encoder handles badly.
 */
export function normalisePeak(pcm: Int16Array, targetPeak = 0.89, maxGain = 8): Int16Array {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const magnitude = Math.abs(pcm[i]!);
    if (magnitude > peak) peak = magnitude;
  }
  if (peak === 0) return pcm;

  const gain = Math.min(maxGain, (targetPeak * 32767) / peak);
  if (gain >= 0.99 && gain <= 1.01) return pcm;

  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i]! * gain)));
  }
  return out;
}

/** Duration in milliseconds, for budget checks and log lines. */
export function pcmDurationMs(pcm: Int16Array, sampleRate: number): number {
  return sampleRate > 0 ? Math.round((pcm.length / sampleRate) * 1000) : 0;
}

/**
 * Trim the dead air off the end of a synthesised transmission.
 *
 * Piper pads every utterance: `--sentence_silence` defaults to 0.2 s and the model
 * adds its own tail on top. Measured across six real readbacks at the shipped
 * settings, the trailing silence was 0.28-0.42 s while the leading silence was
 * 0.00-0.08 s — so the end is worth trimming and the start is not.
 *
 * It matters because airtime is capacity. A dispatcher has one mouth, so every
 * second it spends transmitting is a second a queued unit waits: a measured 30-unit
 * channel cleared a burst of four in 45 s, of which roughly a third was the
 * dispatcher talking. A third of a second on every transmission is not large, and it
 * is free and certain, which the alternatives are not.
 *
 * **`keepMs` exists so this cannot clip a word.** The threshold is relative to the
 * clip's own peak, and a fricative or a trailing consonant can sit under it, so the
 * cut is made `keepMs` after the last sample that was clearly audible rather than at
 * it. 60 ms is about a short consonant; going to zero makes speech end abruptly,
 * which sounds like a dropped transmission rather than a brisk one.
 *
 * Returns the input unchanged when there is nothing to trim, including for an
 * all-silent clip — a caller asking to trim silence has not asked to be handed an
 * empty buffer, and `speak.ts` treats empty audio as a failed transmission.
 */
export function trimTrailingSilence(
  pcm: Int16Array,
  sampleRate: number,
  keepMs = 60,
  threshold = 0.02,
): Int16Array {
  if (pcm.length === 0 || sampleRate <= 0) return pcm;

  let peak = 0;
  for (const sample of pcm) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  if (peak === 0) return pcm;

  const floor = peak * threshold;
  let last = -1;
  for (let i = pcm.length - 1; i >= 0; i--) {
    if (Math.abs(pcm[i] as number) > floor) {
      last = i;
      break;
    }
  }
  if (last < 0) return pcm;

  const keep = Math.max(0, Math.round((keepMs / 1000) * sampleRate));
  const end = Math.min(pcm.length, last + 1 + keep);
  return end >= pcm.length ? pcm : pcm.slice(0, end);
}
