/**
 * Putting the dispatcher's voice on the air.
 *
 * This file makes the audio; tRadio airs it. The split is deliberate and is the point
 * of the addon boundary: tRadio keeps the vocoder (its IMBE and codec2 implementation
 * is clean-room and licensed with tRadio, not with this MIT repo), so the addon hands
 * over plain 16-bit PCM and tRadio encodes it with the channel's own codec, paces it
 * onto the channel one voice at a time, and tells us when it has finished. Anything
 * injected that way inherits tRadio's whole receive pipeline per listener — filters,
 * signal degradation, 3D position, patches, scanners — because the dispatcher is, to
 * every listener, just another talker.
 *
 * Narrowband (8 kHz) PCM is what is handed over and what the speech cache holds: it is
 * the rate every vocoded channel runs at, so there is no second conversion on tRadio's
 * side, and a two-second line is about 32 kB.
 */

import { pcmDurationMs, normalisePeak, resamplePcm } from "./audio";
import { providerPlan, voiceFor } from "./config";
import { aiLog } from "./logger";
import { provider } from "./provider";
import { MAX_REPLY_MS, transmitOn } from "./station";
import type { VoiceGender } from "./types";

/** The rate PCM is cached and handed to tRadio at. */
export const NARROWBAND_RATE = 8000;

/**
 * The lines the dispatcher says over and over, synthesised once.
 *
 * "King 41, stand by" and "Go ahead, King 41" are fixed text, and the whole
 * point of both is that they reach the unit immediately — yet each one was
 * costing a fresh Piper run. Measured: 0.8–1.3 s of the 2.4–2.9 s to first word
 * on a turn that aired a hold was spent synthesising four words it had already
 * synthesised on the previous turn.
 *
 * Narrowband PCM is what is kept, not the packets: encoding needs a vocoder
 * session and those are worth holding for no longer than a transmission, while
 * 8 kHz mono PCM for a two-second line is about 32 kB.
 *
 * Short lines only, and few of them. A cache that real replies could enter would
 * grow without bound and never hit — no unit hears the same sentence twice —
 * and this is meant to hold roughly "stand by" and "go ahead" once per callsign
 * on the channel. Oldest out when it is full, which for a fixed set of phrases
 * never happens.
 *
 * ## It has to be at least as big as the warm set, and it was not
 *
 * `index.ts` warms `WARM_UNITS` (6) units x `stockPhrasesFor` (5 lines: hold,
 * go-ahead, negative, copy, 10-4) plus the two fixed 911 lines — **32 entries**,
 * against a ceiling of 24. Eviction is oldest-first, so warming overflowed itself:
 * the first two units' lines were thrown out by the last two units' before anybody
 * had keyed up, and those units then paid a Piper run on the turn where arriving
 * immediately is the whole point. The comment on `WARM_UNITS` still said "two
 * lines each", which is where the arithmetic went stale.
 *
 * 40 leaves headroom for the handful of relay and announcement lines that qualify
 * and costs about 1.3 MB at ~32 kB for a two-second narrowband line.
 */
const SPEECH_CACHE_MAX = 40;

/** Past this it is a reply, not a stock phrase, and it will never be asked for twice. */
const SPEECH_CACHE_MAX_CHARS = 48;

const speechCache = new Map<string, Int16Array>();

/**
 * Keyed on what actually produces the sound, not on the gender that selects it.
 *
 * The key used to be gender and text, so after `tradioai_reload` changed the voice, the
 * speech provider or its model, every stock phrase went on airing in the old voice until
 * the resource restarted, while generated replies used the new one: a dispatcher with two
 * voices. Lines cached for the previous voice are simply never looked up again and age
 * out of the cache.
 */
function speechKey(spoken: string, gender: VoiceGender): string {
  const speech = providerPlan().speech;
  return [speech.provider, speech.model, voiceFor(gender), spoken].join("\u0000");
}

function cachedSpeech(spoken: string, gender: VoiceGender): Int16Array | null {
  if (spoken.length > SPEECH_CACHE_MAX_CHARS) return null;
  return speechCache.get(speechKey(spoken, gender)) ?? null;
}

function rememberSpeech(spoken: string, gender: VoiceGender, narrowband: Int16Array): void {
  if (spoken.length > SPEECH_CACHE_MAX_CHARS) return;
  if (speechCache.size >= SPEECH_CACHE_MAX) {
    const oldest = speechCache.keys().next().value;
    if (oldest !== undefined) speechCache.delete(oldest);
  }
  speechCache.set(speechKey(spoken, gender), narrowband);
}

/**
 * Narrowband PCM for a line, from the cache when it is there.
 *
 * The one place synthesis happens, so that warming and airing cannot drift into
 * caching under different keys — the key is built from `sayable()` output, and a
 * warm that skipped that normalisation would fill the cache with entries no
 * transmission ever looks up.
 */
async function synthesise(
  spoken: string,
  gender: VoiceGender,
  signal: AbortSignal,
): Promise<Int16Array | null> {
  const cached = cachedSpeech(spoken, gender);
  if (cached) return cached;

  let speech: { pcm: Int16Array; sampleRate: number };
  try {
    speech = await provider().speak(spoken, gender, signal);
  } catch (err) {
    aiLog.warn(`speak: synthesis failed — ${(err as Error).message}`);
    return null;
  }

  const synthesised = pcmDurationMs(speech.pcm, speech.sampleRate);
  if (synthesised === 0) return null;
  if (synthesised > MAX_REPLY_MS) {
    aiLog.warn(`speak: reply was ${synthesised}ms — refusing to air it`);
    return null;
  }

  const narrowband = resamplePcm(normalisePeak(speech.pcm), speech.sampleRate, NARROWBAND_RATE);
  rememberSpeech(spoken, gender, narrowband);
  return narrowband;
}

/**
 * Synthesise the stock phrases ahead of anybody needing them.
 *
 * The hold and the go-ahead are the two lines whose entire value is that they
 * arrive immediately, and both were paying a full Piper run the first time a
 * given callsign heard one — on the turn where being fast matters most, because
 * it is also the turn where nothing else is warm. Every line after that was
 * free. So the first one is moved off the turn entirely, to the moment somebody
 * appears on a covered channel, which is the same moment the engines start.
 *
 * Sequential on purpose. Piper is a process per call and this runs while
 * llama-server is loading a 2.5 GB model on a CPU box; two spawns racing that
 * load is slower overall than three spawns after it.
 *
 * Failure is nothing. An unwarmed line synthesises on demand exactly as before.
 * That was the stated contract and the code did not keep it: `synthesise` threw,
 * the rejection escaped the readiness callback, and a server with no local voice
 * installed printed five "Unhandled promise rejection" blocks and five identical
 * warnings at startup — for a feature that ships switched off and undownloaded.
 *
 * The first failure ends the warm. `synthesise` reports one as `null` rather than by
 * throwing, and the `try`/`catch` that used to stand here therefore never fired: a dead
 * Piper logged the same warning once per line, thirty-two times for a full warm set.
 */
export async function warmSpeech(
  lines: readonly string[],
  gender: VoiceGender,
  signal: AbortSignal,
): Promise<void> {
  for (const line of lines) {
    if (signal.aborted) return;
    const spoken = sayable(line);
    if (!spoken || cachedSpeech(spoken, gender)) continue;
    // Whatever makes one stock line unsynthesisable — no voice on disk, no runtime, a
    // dead Piper — is a property of the engine, not of the line.
    if (!(await synthesise(spoken, gender, signal))) return;
  }
}

/**
 * Written for a screen, said out loud.
 *
 * Models put markdown, em dashes and line breaks in text that is about to be
 * spoken, and a ten-code with a hyphen in it is read by most voices as a
 * subtraction — "ten minus eight". Nothing here changes what was said, only how
 * it lands in a vocoder.
 */
export function sayable(text: string): string {
  return (
    text
      .replace(/[*_`#]+/g, "")
      // A line break is a pause a dispatcher would take, not a list item.
      .replace(/\s*[\r\n]+\s*/g, ", ")
      .replace(/\s*[—–]\s*/g, ", ")
      // Ten-codes only. A callsign has letters in it and a range like "20-30
      // minutes" is meant as a range, so neither is touched.
      .replace(/\b(1[01])-(\d{1,2})\b/g, "$1 $2")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

/**
 * Say something on a frequency.
 *
 * Resolves when tRadio reports the transmission has finished airing. Returns false when
 * nothing was said, for any reason — every failure here is silence, never an exception.
 *
 * Safe to call before the turn that produced the text has finished deciding, and that
 * is how `index.ts` uses it: the acknowledgement is aired from the draft hook while the
 * actions behind it are still decoding. Nothing in here reads the decision, and tRadio
 * keeps a channel to one voice regardless of who calls.
 *
 * `onAudioStart` fires once tRadio has accepted the audio, which is the closest the
 * contract gets to "first packet": it has no per-packet event, so on a busy channel the
 * real first word can come a little later than the callback says.
 */
export async function airReply(
  frequency: number,
  text: string,
  gender: VoiceGender,
  signal: AbortSignal,
  onAudioStart?: (durationMs: number) => void,
): Promise<boolean> {
  const spoken = sayable(text);
  if (!spoken) return false;

  const narrowband = await synthesise(spoken, gender, signal);
  if (!narrowband) return false;

  const duration = pcmDurationMs(narrowband, NARROWBAND_RATE);
  if (duration === 0) return false;

  const result = await transmitOn(frequency, narrowband, NARROWBAND_RATE, signal, () =>
    onAudioStart?.(duration),
  );
  if (!result.ok) {
    // An abort is the turn's own deadline and already has its line; the others are
    // tRadio saying no, which is what an operator reading "never aired" needs to see.
    const line = `speak: ${frequency} not aired — ${result.reason}`;
    if (result.reason === "aborted") aiLog.debug(line);
    else aiLog.warn(line);
  }
  return result.ok;
}

/** Resource stop: the cached voices change with the configuration this drops. */
export function resetSpeaker(): void {
  speechCache.clear();
}
