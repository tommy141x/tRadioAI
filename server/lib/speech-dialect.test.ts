/**
 * ElevenLabs is the first provider that is not OpenAI-shaped, and these hold down
 * the four places it differs.
 *
 * Why that needs tests rather than a reading: every difference fails SOFTLY. A
 * bearer token sent to ElevenLabs is a 401; the voice id left in the body is a 422
 * about a missing path parameter; `model` instead of `model_id` is silently
 * ignored and you get the default voice model; the wrong `output_format` returns
 * mp3 bytes that `pcmFromResponse` reads as PCM and plays as noise. None of those
 * are distinguishable from "the dispatcher is quiet" without opening a log.
 */

import { describe, expect, test } from "bun:test";
import { resolveCapability } from "./providers";
import { speechRequest, speechRoute } from "./speech-dialect";

const BASE = {
  apiKey: "k-123",
  model: "eleven_turbo_v2_5",
  voice: "21m00Tcm4TlvDq8ikWAM",
  text: "King 41, copy direct.",
  sampleRate: 24000,
};

const openai = (over = {}) =>
  speechRequest({
    provider: "openai",
    url: "https://api.openai.com/v1/audio/speech",
    ...BASE,
    ...over,
  });
const eleven = (over = {}) =>
  speechRequest({
    provider: "elevenlabs",
    url: "https://api.elevenlabs.io/v1/text-to-speech",
    ...BASE,
    ...over,
  });

describe("the OpenAI shape is unchanged", () => {
  test("url is used as given, with a bearer and the pcm response format", () => {
    const r = openai();
    expect(r.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(r.headers.Authorization).toBe("Bearer k-123");
    expect(r.headers["xi-api-key"]).toBeUndefined();
    expect(JSON.parse(r.body)).toEqual({
      model: "eleven_turbo_v2_5",
      input: BASE.text,
      voice: BASE.voice,
      response_format: "pcm",
    });
  });

  test("an empty key sends NO auth header — a local engine takes none", () => {
    // An empty bearer fails less clearly than an absent one.
    expect(openai({ apiKey: "" }).headers.Authorization).toBeUndefined();
  });
});

describe("Groq asks for WAV, because it refuses anything else", () => {
  const groq = (over = {}) =>
    speechRequest({
      provider: "groq",
      url: "https://api.groq.com/openai/v1/audio/speech",
      ...BASE,
      ...over,
    });

  // The operator report this exists for: transcription and decisions worked on
  // Groq while every line of speech came back
  // `400 invalid_response_format: response_format must be one of [wav]`.
  test("the response format is wav", () => {
    expect(JSON.parse(groq().body).response_format).toBe("wav");
  });

  // Groq is OpenAI-shaped in every other respect, so the override must not have
  // turned it into its own dialect.
  test("everything else is still the OpenAI shape", () => {
    const r = groq();
    expect(r.url).toBe("https://api.groq.com/openai/v1/audio/speech");
    expect(r.headers.Authorization).toBe("Bearer k-123");
    const body = JSON.parse(r.body);
    expect(body.model).toBe(BASE.model);
    expect(body.input).toBe(BASE.text);
    expect(body.voice).toBe(BASE.voice);
  });

  // The override is per provider, not a global change of default.
  test("no other OpenAI-shaped provider is switched to wav", () => {
    for (const provider of ["openai", "openrouter", "vercel"] as const) {
      const r = speechRequest({
        provider,
        url: "https://example.invalid/v1/audio/speech",
        ...BASE,
      });
      expect(JSON.parse(r.body).response_format).toBe("pcm");
    }
  });
});

describe("ElevenLabs differs on exactly four axes", () => {
  test("1. the voice id is a PATH segment, not a body field", () => {
    const r = eleven();
    expect(r.url).toStartWith("https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM");
    expect(JSON.parse(r.body).voice).toBeUndefined();
  });

  test("2. auth is xi-api-key, and never a bearer", () => {
    const r = eleven();
    expect(r.headers["xi-api-key"]).toBe("k-123");
    // ElevenLabs rejects Authorization outright, so sending both is not a safe hedge.
    expect(r.headers.Authorization).toBeUndefined();
  });

  test("3. the body is {text, model_id} — not {model, input}", () => {
    expect(JSON.parse(eleven().body)).toEqual({
      text: BASE.text,
      model_id: "eleven_turbo_v2_5",
    });
  });

  test("4. the output format is a query parameter at tRadio's own rate", () => {
    // 24000 is SPEECH_PCM_RATE, so the ask matches what pcmFromResponse expects and
    // there is no decode step. Getting this wrong returns mp3 that plays as noise.
    expect(eleven().url).toEndWith("?output_format=pcm_24000");
  });
});

describe("edges that would otherwise be opaque HTTP errors", () => {
  test("a voice id is URI-encoded, so a stray slash cannot retarget the route", () => {
    const r = eleven({ voice: "evil/../../admin" });
    expect(r.url).toContain("evil%2F..%2F..%2Fadmin");
    expect(r.url).not.toContain("/admin?");
  });

  test("no model omits model_id entirely rather than sending an empty one", () => {
    // Absent is valid — ElevenLabs picks its default. An empty string is a 422.
    expect(JSON.parse(eleven({ model: "" }).body)).toEqual({ text: BASE.text });
  });

  test("an unsupported rate picks the nearest SUPPORTED one, not a 400", () => {
    // ElevenLabs serves 8000/16000/22050/24000/44100. The audio path resamples
    // anyway, so the nearest real rate beats an opaque rejection.
    expect(eleven({ sampleRate: 23000 }).url).toEndWith("pcm_22050");
    expect(eleven({ sampleRate: 48000 }).url).toEndWith("pcm_44100");
  });

  test("an empty key sends no xi-api-key header", () => {
    expect(eleven({ apiKey: "" }).headers["xi-api-key"]).toBeUndefined();
  });

  test("the route differs per provider, and only for speech", () => {
    expect(speechRoute("elevenlabs")).toBe("/text-to-speech");
    expect(speechRoute("openai")).toBe("/audio/speech");
    expect(speechRoute("local")).toBe("/audio/speech");
  });
});

describe("resolution treats it like any other provider", () => {
  test("it serves speech when a key is present", () => {
    const r = resolveCapability("speech", {
      provider: "elevenlabs",
      model: "eleven_turbo_v2_5",
      hasKey: true,
    });
    expect(r).toMatchObject({ provider: "elevenlabs", hosted: true, note: "" });
    expect(r.baseUrl).toBe("https://api.elevenlabs.io/v1");
  });

  test("asking it for text falls back to local and SAYS why", () => {
    // It has no chat-completions route. The operator needs the reason, not silence.
    const r = resolveCapability("text", { provider: "elevenlabs", hasKey: true });
    expect(r.provider).toBe("local");
    expect(r.note).toContain("does not serve text");
    expect(r.note).toContain("speech");
  });

  test("no key falls back to local and names the convar to set", () => {
    const r = resolveCapability("speech", { provider: "elevenlabs" });
    expect(r.provider).toBe("local");
    expect(r.note).toContain("tradioai_elevenlabs_key");
  });
});
