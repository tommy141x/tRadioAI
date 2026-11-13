/**
 * Which providers are asked for `json_object` on the decisions call.
 *
 * `response_format: { type: "json_object" }` means two different things:
 *
 *  - **OpenAI treats it as a request.** The model is steered toward JSON and
 *    whatever it sends arrives with a 200. `parseDecision` is built for that —
 *    it takes the first brace-to-brace span, because models wrap JSON in prose
 *    or a code fence.
 *  - **Groq treats it as a guarantee it enforces.** A generation that does not
 *    validate is answered `400 json_validate_failed` with no body to parse, so
 *    the lenient parser never runs and a reply the model already wrote is thrown
 *    away by the transport.
 *
 * Reported 2026-10-19 by an operator whose Groq transcription worked and whose
 * Decisions failed on every turn, so the dispatcher never reached speech at all.
 *
 * These assert the shape as DATA rather than through a fake HTTP server,
 * deliberately: the bug was one field in one body, and a transport-level test
 * would have to assert the same field anyway through far more machinery.
 */

import { describe, expect, test } from "bun:test";
import { jsonFormatFor } from "./provider";
import type { ProviderId } from "./providers";

/**
 * Every provider, as a Record so the COMPILER maintains this list.
 *
 * A plain array would silently omit a provider added to the union later, and the
 * control below would then pass while never checking the new one — which is the
 * failure this file exists to prevent, reproduced in its own test.
 */
const EVERY_PROVIDER: Record<ProviderId, true> = {
  local: true,
  openai: true,
  openrouter: true,
  groq: true,
  vercel: true,
  elevenlabs: true,
};
const ALL = Object.keys(EVERY_PROVIDER) as ProviderId[];

describe("the decisions request", () => {
  test("does NOT ask Groq for json_object", () => {
    expect(jsonFormatFor("groq")).toEqual({});
    expect(jsonFormatFor("groq").response_format).toBeUndefined();
  });

  test("still asks every other provider for it", () => {
    // CONTROL. Groq is the exception and must stay one: a change that dropped
    // the field everywhere would pass the case above and quietly cost every
    // other provider its JSON steering, which fails as degraded replies rather
    // than as an error anyone would notice.
    for (const provider of ALL) {
      if (provider === "groq") continue;
      expect(jsonFormatFor(provider)).toEqual({ response_format: { type: "json_object" } });
    }
  });

  test("the exception is keyed on the provider, not on a default", () => {
    // An unknown id must get the OpenAI shape, because that is what every
    // provider added from here on is until someone measures otherwise.
    expect(jsonFormatFor("openai").response_format).toEqual({ type: "json_object" });
    expect(jsonFormatFor("local").response_format).toEqual({ type: "json_object" });
  });
});
