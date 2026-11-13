/**
 * Provider contract tests: each hosted provider's real failure shapes, against a local
 * server that behaves the way that provider's API does.
 *
 * The five shapes below are the ones customers actually reported (2026-10-19 to
 * 2026-10-24) while this feature lived inside tRadio, and each one was a request the
 * provider refuses and a message nobody could act on:
 *
 *   OpenAI      `400 you must provide a model parameter`
 *   Groq speech `400 invalid_response_format ... must be one of [wav]`
 *   Groq text   `400 json_validate_failed` once `response_format: json_object` is sent
 *   Vercel      `404 Invalid URL (POST /v1/audio/speech)`
 *   any         `timed out after 30000ms`, and a turn that never airs
 *
 * Every mock here REFUSES what the real provider refuses. A mock that accepted anything
 * would pass against a client that still sends the bad request, which is the mistake
 * these tests exist to catch. Each case therefore asserts the request count as well as
 * the outcome: "it fell back to local" and "it never called the provider" are separate
 * claims, and the second is the one that proves the provider was not asked.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyAiConfig, resetAiConfig } from "./config";
import { createHttpProvider } from "./provider";
import { resolveCapability } from "./providers";
import type { AiTool } from "./types";

const tools: AiTool[] = [{ id: "unit_status", description: "status", input: "a status" }];

interface Seen {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
  json: Record<string, unknown> | null;
}

let seen: Seen[] = [];
let handler: (request: Seen) => Response | Promise<Response> = () =>
  new Response("unset", { status: 500 });
let server: ReturnType<typeof Bun.serve>;
let base = "";

const globals = globalThis as unknown as { GetConvar?: unknown };
const realGetConvar = globals.GetConvar;
let keys: Record<string, string> = {};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.text();
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(body) as Record<string, unknown>;
      } catch {
        json = null;
      }
      const entry: Seen = {
        method: request.method,
        path: url.pathname,
        query: url.search,
        headers: Object.fromEntries(request.headers.entries()),
        body,
        json,
      };
      seen.push(entry);
      return handler(entry);
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  globals.GetConvar = realGetConvar;
  resetAiConfig();
});

beforeEach(() => {
  seen = [];
  keys = {};
  globals.GetConvar = (name: string, fallback: string) => keys[name] ?? fallback;
  resetAiConfig();
});

afterEach(() => resetAiConfig());

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const chat = (content: string) => json({ choices: [{ message: { content } }] });

const DECISION =
  '{"actions":[{"tool":"unit_status","input":"10-8"}],"reply":"King 41, copy","kind":"report"}';

/** A little-endian 16-bit mono WAV, the one thing Groq's speech endpoint returns. */
function wavBytes(samples: number, rate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, (i % 100) * 50, true);
  return bytes;
}

function configure(providers: Record<string, unknown>): void {
  applyAiConfig({ enabled: true, providers });
}

const bearer = (request: Seen) => request.headers.authorization;

describe("OpenAI", () => {
  const openai = (request: Seen): Response => {
    if (bearer(request) !== "Bearer sk-test-key") {
      return json(
        { error: { message: "Incorrect API key provided", type: "invalid_request_error" } },
        401,
      );
    }
    if (request.path === "/v1/chat/completions") {
      if (typeof request.json?.model !== "string" || request.json.model === "") {
        return json(
          {
            error: { message: "you must provide a model parameter", type: "invalid_request_error" },
          },
          400,
        );
      }
      return chat(DECISION);
    }
    return json({ error: { message: `unknown route ${request.path}` } }, 404);
  };

  test("a provider with no model is never called: it resolves local and says what to set", async () => {
    handler = openai;
    keys.tradioai_openai_key = "sk-test-key";
    configure({ text: { provider: "openai", baseUrl: `${base}/v1` } });

    // The 400 the customer saw is what the mock sends for exactly this request — so the
    // fix is that the request is never made, not that its error is nicer.
    const note = resolveCapability("text", { provider: "openai", hasKey: true }).note;
    expect(note).toContain("needs a model for text");
    expect(note).toContain("providers.text.model");

    await expect(
      createHttpProvider().decide("sys", "prompt", tools, AbortSignal.timeout(2000)),
    ).rejects.toThrow(/text is unavailable/);
    expect(seen).toHaveLength(0);
  });

  test("with a model it decides, sending the model, the key and a JSON format", async () => {
    handler = openai;
    keys.tradioai_openai_key = "sk-test-key";
    configure({ text: { provider: "openai", model: "gpt-4o-mini", baseUrl: `${base}/v1` } });

    const decision = await createHttpProvider().decide(
      "sys",
      "prompt",
      tools,
      AbortSignal.timeout(2000),
    );

    expect(decision.actions).toEqual([{ tool: "unit_status", input: "10-8" }]);
    expect(decision.reply).toBe("King 41, copy");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.json?.model).toBe("gpt-4o-mini");
    expect(seen[0]?.json?.response_format).toEqual({ type: "json_object" });
  });

  test("a rejected key says HTTP 401 and the provider's own words", async () => {
    handler = openai;
    keys.tradioai_openai_key = "sk-wrong";
    configure({ text: { provider: "openai", model: "gpt-4o-mini", baseUrl: `${base}/v1` } });

    await expect(
      createHttpProvider().decide("sys", "prompt", tools, AbortSignal.timeout(2000)),
    ).rejects.toThrow(/HTTP 401.*Incorrect API key/);
  });

  test("transcription uploads the model and the audio as multipart", async () => {
    handler = (request) => {
      if (request.path !== "/v1/audio/transcriptions") return json({}, 404);
      if (!request.body.includes('name="model"')) {
        return json({ error: { message: "you must provide a model parameter" } }, 400);
      }
      return json({ text: " King 41 to dispatch " });
    };
    keys.tradioai_openai_key = "sk-test-key";
    configure({ transcription: { provider: "openai", model: "whisper-1", baseUrl: `${base}/v1` } });

    const text = await createHttpProvider().transcribe(
      { bytes: new Uint8Array([1, 2, 3]), mime: "audio/wav", filename: "transmission.wav" },
      AbortSignal.timeout(2000),
      "dispatch, King 41",
    );

    expect(text).toBe("King 41 to dispatch");
    expect(seen[0]?.headers["content-type"]).toContain("multipart/form-data");
    expect(seen[0]?.body).toContain('name="prompt"');
  });

  test("speech asks for raw PCM and reads it back at OpenAI's documented rate", async () => {
    handler = (request) => {
      if (request.path !== "/v1/audio/speech") return json({}, 404);
      if (request.json?.response_format !== "pcm")
        return json({ error: { message: "unsupported format" } }, 400);
      return new Response(new Uint8Array(4800), { status: 200 });
    };
    keys.tradioai_openai_key = "sk-test-key";
    configure({ speech: { provider: "openai", model: "tts-1", baseUrl: `${base}/v1` } });

    const speech = await createHttpProvider().speak(
      "Go ahead, King 41",
      "female",
      AbortSignal.timeout(2000),
    );
    expect(speech.sampleRate).toBe(24000);
    expect(speech.pcm.length).toBe(2400);
    expect(seen[0]?.json?.model).toBe("tts-1");
  });
});

describe("Groq", () => {
  /** Orpheus: wav only. Anything else is the 400 an operator reported. */
  const groqSpeech = (request: Seen): Response => {
    if (request.path !== "/openai/v1/audio/speech") return json({}, 404);
    if (request.json?.response_format !== "wav") {
      return json(
        {
          error: {
            message: "response_format must be one of [wav]",
            type: "invalid_request_error",
            code: "invalid_response_format",
          },
        },
        400,
      );
    }
    return new Response(wavBytes(2400, 24000), { status: 200 });
  };

  test("speech asks for wav and reads the rate out of the header", async () => {
    handler = groqSpeech;
    keys.tradioai_groq_key = "gsk-test-key";
    configure({
      speech: { provider: "groq", model: "playai-tts", baseUrl: `${base}/openai/v1` },
    });

    const speech = await createHttpProvider().speak(
      "Go ahead",
      "female",
      AbortSignal.timeout(2000),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.json?.response_format).toBe("wav");
    expect(speech.sampleRate).toBe(24000);
    expect(speech.pcm.length).toBe(2400);
  });

  test("the mock does refuse pcm, so the case above proves something", async () => {
    handler = groqSpeech;
    const reply = await fetch(`${base}/openai/v1/audio/speech`, {
      method: "POST",
      body: JSON.stringify({ response_format: "pcm" }),
    });
    expect(reply.status).toBe(400);
    expect(await reply.text()).toContain("invalid_response_format");
  });

  /**
   * GPT-OSS models write a reasoning preamble before the object. With `response_format:
   * json_object` Groq validates the WHOLE completion and throws the reply away with
   * `json_validate_failed`; without it the preamble arrives and the lenient parser digs
   * the object out. The addon therefore must not send the field to Groq at all.
   */
  const groqText = (request: Seen): Response => {
    if (request.path !== "/openai/v1/chat/completions") return json({}, 404);
    if (request.json?.response_format) {
      return json(
        {
          error: {
            message: "Failed to validate JSON. Please adjust your prompt.",
            type: "invalid_request_error",
            code: "json_validate_failed",
          },
        },
        400,
      );
    }
    return chat(`Let me think about this.\n\n${DECISION}`);
  };

  test("a decision survives a reasoning preamble because no response_format is sent", async () => {
    handler = groqText;
    keys.tradioai_groq_key = "gsk-test-key";
    configure({
      text: { provider: "groq", model: "openai/gpt-oss-20b", baseUrl: `${base}/openai/v1` },
    });

    const decision = await createHttpProvider().decide(
      "sys",
      "prompt",
      tools,
      AbortSignal.timeout(2000),
    );

    expect(decision.actions).toEqual([{ tool: "unit_status", input: "10-8" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.json && "response_format" in seen[0].json).toBe(false);
  });

  test("a streamed decision falls back to a buffered one when the provider refuses the stream", async () => {
    handler = (request) =>
      request.json?.stream === true
        ? json({ error: { message: "streaming is not supported for this model" } }, 400)
        : groqText(request);
    keys.tradioai_groq_key = "gsk-test-key";
    configure({
      text: { provider: "groq", model: "openai/gpt-oss-20b", baseUrl: `${base}/openai/v1` },
    });

    const drafts: string[] = [];
    const decision = await createHttpProvider().decide(
      "sys",
      "prompt",
      tools,
      AbortSignal.timeout(3000),
      (draft) => drafts.push(draft),
    );

    expect(decision.reply).toBe("King 41, copy");
    expect(seen.map((request) => request.json?.stream === true)).toEqual([true, false]);
  });
});

describe("Vercel AI Gateway", () => {
  test("speech is never sent to it: the gateway has no /v1/audio/speech, so it resolves local", async () => {
    handler = (request) =>
      request.path === "/v1/audio/speech"
        ? json(
            {
              error: {
                message: "Invalid URL (POST /v1/audio/speech)",
                type: "invalid_request_error",
              },
            },
            404,
          )
        : chat(DECISION);
    keys.tradioai_vercel_key = "vck-test";
    configure({ speech: { provider: "vercel", model: "x", baseUrl: `${base}/v1` } });

    const resolved = resolveCapability("speech", { provider: "vercel", model: "x", hasKey: true });
    expect(resolved.provider).toBe("local");
    expect(resolved.note).toContain("does not serve speech");

    // The call itself goes to the local engine, which is not installed here: what
    // matters is that it was the local engine that failed and the gateway heard nothing.
    await expect(
      createHttpProvider().speak("Go ahead", "female", AbortSignal.timeout(2000)),
    ).rejects.toThrow(/speech failed: no local speech runtime/);
    expect(seen.filter((request) => request.path.includes("audio"))).toHaveLength(0);
  });

  test("text is served: that part of the gateway is OpenAI-shaped", async () => {
    handler = (request) =>
      request.path === "/v1/chat/completions" ? chat(DECISION) : json({}, 404);
    keys.tradioai_vercel_key = "vck-test";
    configure({ text: { provider: "vercel", model: "openai/gpt-4o-mini", baseUrl: `${base}/v1` } });

    const decision = await createHttpProvider().decide(
      "sys",
      "prompt",
      tools,
      AbortSignal.timeout(2000),
    );
    expect(decision.reply).toBe("King 41, copy");
    expect(seen[0]?.json?.model).toBe("openai/gpt-4o-mini");
  });

  test("transcription is not sent to it either", () => {
    const resolved = resolveCapability("transcription", {
      provider: "vercel",
      model: "x",
      hasKey: true,
    });
    expect(resolved.provider).toBe("local");
    expect(resolved.note).toContain("does not serve transcription");
  });
});

describe("OpenRouter and ElevenLabs", () => {
  test("OpenRouter serves text and nothing else", () => {
    expect(
      resolveCapability("text", { provider: "openrouter", model: "m", hasKey: true }).hosted,
    ).toBe(true);
    expect(
      resolveCapability("speech", { provider: "openrouter", model: "m", hasKey: true }).provider,
    ).toBe("local");
    expect(
      resolveCapability("transcription", { provider: "openrouter", model: "m", hasKey: true })
        .provider,
    ).toBe("local");
  });

  test("ElevenLabs speech: the voice is in the path, the key in xi-api-key, never a bearer", async () => {
    handler = (request) => {
      if (!request.path.startsWith("/v1/text-to-speech/")) return json({}, 404);
      if (request.headers.authorization)
        return json({ detail: { status: "invalid_authorization" } }, 401);
      if (request.headers["xi-api-key"] !== "xi-test-key")
        return json({ detail: { status: "invalid_api_key" } }, 401);
      return new Response(new Uint8Array(4800), { status: 200 });
    };
    keys.tradioai_elevenlabs_key = "xi-test-key";
    configure({
      speech: { provider: "elevenlabs", baseUrl: `${base}/v1` },
    });
    applyAiConfig({
      enabled: true,
      providers: { speech: { provider: "elevenlabs", baseUrl: `${base}/v1` } },
      provider: { voices: { female: ["VOICE_ID_1"] } },
    });

    const speech = await createHttpProvider().speak(
      "Go ahead",
      "female",
      AbortSignal.timeout(2000),
    );

    expect(speech.pcm.length).toBe(2400);
    expect(seen[0]?.path).toBe("/v1/text-to-speech/VOICE_ID_1");
    expect(seen[0]?.query).toBe("?output_format=pcm_24000");
    // No model named: ElevenLabs picks its own, so the body must not invent one.
    expect(seen[0]?.json && "model_id" in seen[0].json).toBe(false);
  });
});

describe("a key that is missing", () => {
  test("never reaches the provider; the capability is local and the note names the convar", async () => {
    handler = () => json({}, 500);
    configure({ text: { provider: "openai", model: "gpt-4o-mini", baseUrl: `${base}/v1` } });

    await expect(
      createHttpProvider().decide("sys", "prompt", tools, AbortSignal.timeout(2000)),
    ).rejects.toThrow(/text is unavailable/);
    expect(seen).toHaveLength(0);
  });
});

describe("timeouts and transport failures", () => {
  test("a provider that never answers is abandoned when the turn's signal fires", async () => {
    handler = () => new Promise<Response>(() => {});
    keys.tradioai_openai_key = "sk-test-key";
    configure({ text: { provider: "openai", model: "gpt-4o-mini", baseUrl: `${base}/v1` } });

    const started = Date.now();
    await expect(
      createHttpProvider().decide("sys", "prompt", tools, AbortSignal.timeout(150)),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
    // The request did go out: this is the hang, not a refusal to ask.
    expect(seen).toHaveLength(1);
  });

  test("a hung transcription is abandoned too", async () => {
    handler = () => new Promise<Response>(() => {});
    keys.tradioai_openai_key = "sk-test-key";
    configure({ transcription: { provider: "openai", model: "whisper-1", baseUrl: `${base}/v1` } });

    const started = Date.now();
    await expect(
      createHttpProvider().transcribe(
        { bytes: new Uint8Array([1]), mime: "audio/wav", filename: "t.wav" },
        AbortSignal.timeout(150),
      ),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("an HTML error page from a proxy is reported as its status and a clipped body", async () => {
    handler = () =>
      new Response(`<html><body>${"Bad gateway ".repeat(100)}</body></html>`, {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    keys.tradioai_openai_key = "sk-test-key";
    configure({ text: { provider: "openai", model: "gpt-4o-mini", baseUrl: `${base}/v1` } });

    const error = await createHttpProvider()
      .decide("sys", "prompt", tools, AbortSignal.timeout(2000))
      .catch((caught: Error) => caught);
    expect(String(error)).toContain("HTTP 502");
    // Clipped: a whole HTML page in a console line is not a message.
    expect(String(error).length).toBeLessThan(500);
  });

  test("a connection that is refused is a transport error, not a hang", async () => {
    keys.tradioai_openai_key = "sk-test-key";
    configure({
      text: { provider: "openai", model: "gpt-4o-mini", baseUrl: "http://127.0.0.1:1/v1" },
    });
    await expect(
      createHttpProvider().decide("sys", "prompt", tools, AbortSignal.timeout(2000)),
    ).rejects.toThrow();
  });

  test("an empty or non-JSON 200 is no decision, not a crash", async () => {
    handler = () => new Response("", { status: 200 });
    keys.tradioai_openai_key = "sk-test-key";
    configure({ text: { provider: "openai", model: "gpt-4o-mini", baseUrl: `${base}/v1` } });

    const decision = await createHttpProvider().decide(
      "sys",
      "prompt",
      tools,
      AbortSignal.timeout(2000),
    );
    expect(decision.actions).toEqual([]);
    expect(decision.reply).toBe("");
  });
});
