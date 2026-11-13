/**
 * How to ask each hosted provider for speech.
 *
 * Every other hosted call in tRadio is OpenAI-shaped: `{baseUrl}/{route}`, a
 * `Bearer` key, and a JSON body the provider happens to accept. ElevenLabs is the
 * first provider that is worth supporting and does none of that:
 *
 *   |          | OpenAI-shaped                         | ElevenLabs                        |
 *   | url      | {base}/audio/speech                   | {base}/text-to-speech/{voiceId}   |
 *   | auth     | Authorization: Bearer <key>           | xi-api-key: <key>                 |
 *   | body     | { model, input, voice, response_format } | { text, model_id, voice_settings } |
 *   | format   | body field                            | ?output_format= query param       |
 *
 * Four differences, so four places the old code would have needed an `if`. They
 * live here instead, as one function per dialect, because the alternative is a
 * provider conditional threaded through the URL builder, the header builder, the
 * body builder and the resolver — which is how the next provider becomes a
 * refactor rather than an addition.
 *
 * What is NOT here: anything about the response. Dialects ask for raw
 * little-endian 16-bit PCM wherever the provider allows it, so `pcmFromResponse`
 * in provider.ts stays single-path. That is the one thing ElevenLabs makes easy —
 * `pcm_24000` is an exact match for what tRadio already wants, so there is no
 * decode step and no second audio path to keep in step with the first.
 *
 * Groq is the exception, and it costs nothing: see `SPEECH_RESPONSE_FORMAT`.
 *
 * Deliberately pure: no HTTP, no FiveM globals, no credential handling beyond
 * placing the key in the header the provider expects. That makes every dialect
 * testable as data in, data out.
 */

import type { ProviderId } from "./providers";

/** A ready-to-send speech request. `post()` in provider.ts takes exactly this. */
export interface SpeechRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface SpeechRouteInput {
  /** Which dialect to speak. */
  provider: ProviderId;
  /** The URL `endpointFor` composed, route already appended. */
  url: string;
  apiKey: string;
  model: string;
  /** The provider's voice id, from `Config.providers.voices`. */
  voice: string;
  text: string;
  /** Sample rate tRadio's audio path expects, so the ask matches the consumer. */
  sampleRate: number;
}

/**
 * ElevenLabs' PCM output formats, as `output_format` accepts them.
 *
 * Enumerated rather than interpolated: `pcm_${rate}` would happily build
 * `pcm_23999` and come back as an opaque 400, and the nearest SUPPORTED rate is
 * a better answer than an error — the audio path resamples anyway
 * (`resamplePcm` in audio.ts), and it already has to, because Piper's rate and
 * OpenAI's are not the same either.
 */
const ELEVENLABS_PCM_RATES = [8000, 16000, 22050, 24000, 44100] as const;

function nearestElevenLabsRate(rate: number): number {
  return ELEVENLABS_PCM_RATES.reduce((best, candidate) =>
    Math.abs(candidate - rate) < Math.abs(best - rate) ? candidate : best,
  );
}

/**
 * The audio format to ask each OpenAI-shaped provider for.
 *
 * `pcm` is the default and the one worth having: raw little-endian 16-bit samples
 * need no decode, no container walk and no second audio path.
 *
 * Groq does not offer it. Its Orpheus speech endpoint answers any other value
 * with `400 invalid_response_format: response_format must be one of [wav]` —
 * reported 2026-10-18 by an operator running `canopylabs/orpheus-v1-english`,
 * whose transcription and decisions worked while every line of speech failed.
 *
 * Asking for WAV costs nothing downstream: `pcmFromResponse` in provider.ts
 * already detects the `RIFF` header, takes the sample rate out of it rather than
 * assuming `SPEECH_PCM_RATE`, and walks the chunk list to `data` instead of
 * trusting the 44-byte offset. The audio path resamples from whatever rate comes
 * back, exactly as it does for Piper.
 *
 * A map rather than `provider === "groq" ? …`, because this is a property of each
 * provider's API and the next one that only speaks WAV is then one line.
 */
const SPEECH_RESPONSE_FORMAT: Partial<Record<ProviderId, string>> = {
  groq: "wav",
};

/** The OpenAI-shaped request every other hosted provider takes. */
function openAiSpeech(input: SpeechRouteInput): SpeechRequest {
  return {
    url: input.url,
    headers: {
      "Content-Type": "application/json",
      // Empty key = send no header: a local llama.cpp server takes none, and an
      // empty bearer fails less clearly than an absent one.
      ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: input.model,
      input: input.text,
      voice: input.voice,
      response_format: SPEECH_RESPONSE_FORMAT[input.provider] ?? "pcm",
    }),
  };
}

function elevenLabsSpeech(input: SpeechRouteInput): SpeechRequest {
  /*
   * The voice id is a PATH segment here, not a body field, which is the one
   * difference that cannot be absorbed by a header or a body key. `encodeURIComponent`
   * because the id comes from operator config: a stray slash would otherwise
   * silently retarget the request at a different route.
   */
  const voice = encodeURIComponent(input.voice);
  const rate = nearestElevenLabsRate(input.sampleRate);
  return {
    url: `${input.url}/${voice}?output_format=pcm_${rate}`,
    headers: {
      "Content-Type": "application/json",
      // NOT a bearer. ElevenLabs rejects Authorization outright.
      ...(input.apiKey ? { "xi-api-key": input.apiKey } : {}),
    },
    body: JSON.stringify({
      text: input.text,
      // `model_id`, not `model`. Absent is valid — ElevenLabs picks its default —
      // so an operator who names no model still gets speech rather than a 422.
      ...(input.model ? { model_id: input.model } : {}),
    }),
  };
}

/** Build the speech request this provider expects. */
export function speechRequest(input: SpeechRouteInput): SpeechRequest {
  return input.provider === "elevenlabs" ? elevenLabsSpeech(input) : openAiSpeech(input);
}

/**
 * The route segment a provider serves speech on.
 *
 * Exported for `config.ts`, which composes the URL before the voice is known —
 * the voice only arrives with the text. So this returns the part that is
 * voice-independent and `elevenLabsSpeech` appends the rest.
 */
export function speechRoute(provider: ProviderId): string {
  return provider === "elevenlabs" ? "/text-to-speech" : "/audio/speech";
}
