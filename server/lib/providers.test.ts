import { describe, expect, it } from "bun:test";
import {
  describePlan,
  keyConvar,
  parseCapability,
  resolveCapability,
  resolveProviders,
} from "./providers";

describe("resolveProviders", () => {
  it("is fully local when nothing is configured", () => {
    const plan = resolveProviders();
    expect(plan.text.provider).toBe("local");
    expect(plan.speech.provider).toBe("local");
    expect(plan.transcription.provider).toBe("local");
  });

  it("resolves each capability independently", () => {
    const plan = resolveProviders({
      text: { provider: "groq", model: "llama-3.3-70b", key: "sk-test" },
    });
    expect(plan.text.hosted).toBe(true);
    expect(plan.text.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(plan.speech.hosted).toBe(false);
    expect(plan.transcription.hosted).toBe(false);
  });
});

describe("resolveCapability", () => {
  it("treats an explicit 'local' as local without a complaint", () => {
    expect(resolveCapability("text", { provider: "local" }).note).toBe("");
  });

  it("falls back to local for an unknown provider", () => {
    const resolved = resolveCapability("text", { provider: "nonesuch", hasKey: true });
    expect(resolved.provider).toBe("local");
    expect(resolved.note).toContain('unknown provider "nonesuch"');
  });

  it("falls back to local when the provider does not serve the capability", () => {
    const resolved = resolveCapability("speech", { provider: "openrouter", hasKey: true });
    expect(resolved.provider).toBe("local");
    expect(resolved.note).toContain("does not serve speech");
  });

  it("falls back to local when a key is needed and missing, naming the convar", () => {
    const resolved = resolveCapability("text", { provider: "openai" });
    expect(resolved.provider).toBe("local");
    expect(resolved.note).toContain("tradioai_openai_key");
  });

  it("lets an explicit baseUrl override the provider's own", () => {
    const resolved = resolveCapability("text", {
      provider: "openai",
      model: "gpt-4o-mini",
      hasKey: true,
      baseUrl: "http://127.0.0.1:8080/v1",
    });
    expect(resolved.baseUrl).toBe("http://127.0.0.1:8080/v1");
  });

  /**
   * OpenAI answers a request with no model with `400 you must provide a model
   * parameter`, and that is what an operator who wrote only `provider = 'openai'` got on
   * every turn. It is refused here instead, at configuration time, naming the fix.
   */
  it("falls back to local when a hosted provider is given no model, naming the setting", () => {
    for (const provider of ["openai", "groq", "openrouter", "vercel"] as const) {
      const resolved = resolveCapability("text", { provider, hasKey: true });
      expect(resolved.provider).toBe("local");
      expect(resolved.note).toContain("needs a model for text");
      expect(resolved.note).toContain("providers.text.model");
    }
  });

  it("does not ask ElevenLabs for a model: it picks its own", () => {
    const resolved = resolveCapability("speech", { provider: "elevenlabs", hasKey: true });
    expect(resolved.provider).toBe("elevenlabs");
    expect(resolved.hosted).toBe(true);
  });

  it("a missing key is reported before a missing model", () => {
    // Fix the first problem the operator has; the second follows once it is fixed.
    expect(resolveCapability("text", { provider: "openai" }).note).toContain("API key");
  });
});

describe("parseCapability", () => {
  it("reduces a key to a boolean and never carries the string", () => {
    const parsed = parseCapability({ provider: "groq", key: "sk-secret" });
    expect(parsed.hasKey).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("sk-secret");
  });

  it("does not claim a key for an empty string", () => {
    expect(parseCapability({ provider: "groq", key: "   " }).hasKey).toBe(false);
  });

  it("lower-cases the provider name and strips a trailing slash from baseUrl", () => {
    const parsed = parseCapability({ provider: "GroQ", baseUrl: "https://x.test/v1/" });
    expect(parsed.provider).toBe("groq");
    expect(parsed.baseUrl).toBe("https://x.test/v1");
  });

  it("returns nothing useful for a non-object", () => {
    expect(parseCapability("groq")).toEqual({});
  });
});

describe("keyConvar", () => {
  it("is derived from the provider name", () => {
    expect(keyConvar("groq")).toBe("tradioai_groq_key");
  });
});

describe("describePlan", () => {
  it("reports the fallback reason alongside the capability", () => {
    const lines = describePlan(resolveProviders({ speech: { provider: "openai" } }));
    expect(lines.find((line) => line.startsWith("speech"))).toContain("tradioai_openai_key");
  });

  it("never contains a key", () => {
    const lines = describePlan(resolveProviders({ text: { provider: "groq", key: "sk-secret" } }));
    expect(lines.join(" ")).not.toContain("sk-secret");
  });
});
