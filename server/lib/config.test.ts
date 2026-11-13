import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  aiConfig,
  applyAiConfig,
  endpointFailure,
  monitorsFrequency,
  providerConfig,
  providerPlan,
  resetAiConfig,
  voiceFor,
} from "./config";
import { DEFAULT_DEMEANOR, DEMEANORS } from "./prompt";

beforeEach(() => {
  resetAiConfig();
});

// Module-scope state is shared with every other test in the run.
afterAll(() => {
  resetAiConfig();
});

describe("applyAiConfig", () => {
  test("defaults everything a partial payload leaves out", () => {
    applyAiConfig({ enabled: true });
    const config = aiConfig();
    expect(config.enabled).toBe(true);
    expect(config.channels).toEqual([]);
    expect(config.yieldToDispatcher).toBe(true);
    expect(config.callsign).toBe("Dispatch");
    expect(config.voiceGender).toBe("female");
    expect(config.wakePhrases).toEqual(["dispatch"]);
  });

  test("normalizes channels and drops the unusable ones", () => {
    applyAiConfig({ enabled: true, channels: ["460.12504", 155.475, "not a frequency", 155.475] });
    expect(aiConfig().channels).toEqual([460.125, 155.475]);
  });

  test("clamps the turn timeout to a workable range", () => {
    applyAiConfig({ turnTimeoutMs: 10 });
    expect(aiConfig().turnTimeoutMs).toBe(2000);
    applyAiConfig({ turnTimeoutMs: 999999 });
    expect(aiConfig().turnTimeoutMs).toBe(60000);
    applyAiConfig({ turnTimeoutMs: "nonsense" });
    expect(aiConfig().turnTimeoutMs).toBe(30000);
  });

  test("parses the panel's code sheet, and a config.lua table just the same", () => {
    applyAiConfig({ tenCodes: "10-4 = acknowledged, 10-50=traffic accident" });
    expect(aiConfig().tenCodes).toEqual({ "10-4": "acknowledged", "10-50": "traffic accident" });

    applyAiConfig({ tenCodes: { "10-4": "acknowledged" } });
    expect(aiConfig().tenCodes).toEqual({ "10-4": "acknowledged" });
  });

  test("drops code-sheet entries that say nothing and caps the sheet", () => {
    // No separator, no meaning, no code: each is a line an operator can type.
    applyAiConfig({ tenCodes: "10-4, = acknowledged, 10-50 =, 10-7 = out of service" });
    expect(aiConfig().tenCodes).toEqual({ "10-7": "out of service" });

    const long = Array.from({ length: 40 }, (_, i) => `10-${i} = code ${i}`).join(",");
    applyAiConfig({ tenCodes: long });
    // Capped at 24 because the codes ride in whisper's initial prompt, which is a
    // bounded window shared with the callsigns.
    expect(Object.keys(aiConfig().tenCodes)).toHaveLength(24);
  });

  /**
   * 911 answering is opt-in and not implied by turning the dispatcher on: it puts the
   * dispatcher on the line with a member of the public, which is a different consent
   * from answering units on a radio. CAD consent is not read here at all — it is
   * tRadio's `Config.cad.tools`, reported by `cadCapabilities` (see `cad.test.ts`).
   */
  test("answering 911 is off unless asked for", () => {
    applyAiConfig({ enabled: true });
    expect(aiConfig().answer911).toBe(false);
    applyAiConfig({ enabled: true, answer911: true });
    expect(aiConfig().answer911).toBe(true);
  });

  test("falls back on an unknown gender", () => {
    applyAiConfig({ voiceGender: "robot" });
    expect(aiConfig().voiceGender).toBe("female");
    applyAiConfig({ voiceGender: "male" });
    expect(aiConfig().voiceGender).toBe("male");
  });

  /**
   * The demeanor key is resolved HERE, which is the point of the feature: by the time
   * a prompt is built there is one manner and no choice left to make.
   */
  test("resolves the demeanor key, and blank is the documented default", () => {
    applyAiConfig({ demeanor: "brisk" });
    expect(aiConfig().demeanor).toBe("brisk");
    // Whatever an operator typed into a Lua table.
    applyAiConfig({ demeanor: " Veteran " });
    expect(aiConfig().demeanor).toBe("veteran");
    // The escape: unset, blank and not-a-string all mean the default rather than an
    // error or an empty manner.
    applyAiConfig({ demeanor: "" });
    expect(aiConfig().demeanor).toBe(DEFAULT_DEMEANOR);
    applyAiConfig({ demeanor: 7 });
    expect(aiConfig().demeanor).toBe(DEFAULT_DEMEANOR);
    applyAiConfig({});
    expect(aiConfig().demeanor).toBe(DEFAULT_DEMEANOR);
    // A key that is present and wrong is NOT the escape — it is a typo, and it still
    // has to leave the dispatcher speaking.
    applyAiConfig({ demeanor: "sassy" });
    expect(aiConfig().demeanor).toBe(DEFAULT_DEMEANOR);
    // Control: the default is a real key of the table, so none of the above passed by
    // comparing two absent values.
    expect(Object.keys(DEMEANORS)).toContain(DEFAULT_DEMEANOR);
  });

  test("keeps a gendered voice list", () => {
    applyAiConfig({});
    const provider = providerConfig();
    expect(provider.voices.female.length).toBeGreaterThan(0);
    expect(provider.voices.male.length).toBeGreaterThan(0);
  });

  test("speaks with the first voice of the configured gender", () => {
    applyAiConfig({
      voiceGender: "male",
      provider: { voices: { male: ["en_US-ryan-medium", "en_US-joe-medium"] } },
    });
    expect(voiceFor("male")).toBe("en_US-ryan-medium");
    // Genders are independent: an unset one still falls back to a shipped voice.
    expect(voiceFor("female")).not.toBe("");
  });

  test("names the voice when local speech is asked for one that is not installed", () => {
    // A scratch root with a (fake) Piper binary and no voices: the voice is only named
    // once the runtime exists, and the machine running this may have neither.
    const root = mkdtempSync(join(tmpdir(), "tradioai-config-"));
    const binary = join(
      root,
      "server",
      "bin",
      process.platform === "win32" ? "win" : "linux",
      "piper",
      process.platform === "win32" ? "piper.exe" : "piper"
    );
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(binary, "");
    try {
      applyAiConfig({
        voiceGender: "female",
        localEngine: { root },
        provider: { voices: { female: ["en_US-nobody-medium"] } },
      });
      const reason = endpointFailure("speech");
      expect(reason).toContain("en_US-nobody-medium");
      // The operator has to be able to find it, so the place looked is named too.
      expect(reason).toContain("voices");
    } finally {
      resetAiConfig();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is fully local when no providers are configured", () => {
    applyAiConfig({});
    const plan = providerPlan();
    expect(plan.text.hosted).toBe(false);
    expect(plan.speech.hosted).toBe(false);
    expect(plan.transcription.hosted).toBe(false);
  });

  test("takes a hosted provider for one capability and leaves the rest local", () => {
    applyAiConfig({ providers: { text: { provider: "groq", key: "sk-test" } } });
    const plan = providerPlan();
    expect(plan.text.hosted).toBe(true);
    expect(plan.text.provider).toBe("groq");
    expect(plan.speech.hosted).toBe(false);
  });

  test("falls back to local when a hosted provider has no key", () => {
    applyAiConfig({ providers: { text: { provider: "openai" } } });
    expect(providerPlan().text.provider).toBe("local");
    expect(providerPlan().text.note).toContain("tradioai_openai_key");
  });
});

describe("monitorsFrequency", () => {
  test("is false for every frequency while disabled", () => {
    applyAiConfig({ enabled: false, channels: [155.475] });
    expect(monitorsFrequency(155.475)).toBe(false);
  });

  test("matches only the configured channels", () => {
    applyAiConfig({ enabled: true, channels: [155.475] });
    expect(monitorsFrequency(155.475)).toBe(true);
    expect(monitorsFrequency(460.125)).toBe(false);
  });
});
