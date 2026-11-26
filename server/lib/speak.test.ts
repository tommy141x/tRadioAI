import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { applyAiConfig, resetAiConfig } from "./config";
import { aiLog } from "./logger";
import { setProvider } from "./provider";
import { resetSpeaker, sayable, warmSpeech } from "./speak";
import type { AiProvider } from "./types";

describe("sayable", () => {
  it("strips markdown a model slipped into spoken text", () => {
    expect(sayable("**LSPD** copy, `10-4`")).toBe("LSPD copy, 10 4");
  });

  it("turns line breaks into a pause", () => {
    expect(sayable("Units responding:\n- 1-Adam-12\n- 2-Boy-4")).toBe(
      "Units responding:, - 1-Adam-12, - 2-Boy-4",
    );
  });

  it("splits ten-codes so a voice does not read the hyphen as a minus", () => {
    expect(sayable("show me 10-8")).toBe("show me 10 8");
    expect(sayable("11-99 traffic")).toBe("11 99 traffic");
  });

  it("leaves callsigns and ranges alone", () => {
    expect(sayable("1-Adam-12 en route, 20-30 minutes")).toBe("1-Adam-12 en route, 20-30 minutes");
  });

  it("keeps a frequency intact", () => {
    expect(sayable("switch to 460.2500")).toBe("switch to 460.2500");
  });

  it("collapses an em dash into a comma", () => {
    expect(sayable("copy — stand by")).toBe("copy, stand by");
  });
});

describe("warmSpeech", () => {
  const FIRST = { enabled: true };
  const OTHER_VOICE = { enabled: true, provider: { voices: { female: ["some-other-voice"] } } };
  let spoken = 0;
  let speak: AiProvider["speak"] = async () => ({ pcm: new Int16Array(0), sampleRate: 24000 });
  const signal = new AbortController().signal;
  const quiet: Array<ReturnType<typeof spyOn>> = [];

  function install(): void {
    setProvider({
      name: "t",
      transcribe: async () => "",
      decide: async () => ({ actions: [], reply: "" }),
      compose: async () => "",
      speak: (text, gender, s) => {
        spoken += 1;
        return speak(text, gender, s);
      },
    });
  }

  beforeEach(() => {
    for (const level of ["debug", "info", "warn"] as const) {
      quiet.push(spyOn(aiLog, level).mockImplementation(() => {}));
    }
    spoken = 0;
    speak = async () => ({ pcm: new Int16Array(2400).fill(1000), sampleRate: 24000 });
    resetSpeaker();
    resetAiConfig();
    install();
  });

  afterEach(() => {
    resetSpeaker();
    resetAiConfig();
    setProvider(null);
    for (const spy of quiet.splice(0)) spy.mockRestore();
  });

  it("is keyed on the voice, so a changed voice is synthesised afresh", async () => {
    applyAiConfig(FIRST);
    await warmSpeech(["King 41, stand by"], "female", signal);
    await warmSpeech(["King 41, stand by"], "female", signal);
    expect(spoken).toBe(1);

    applyAiConfig(OTHER_VOICE);
    await warmSpeech(["King 41, stand by"], "female", signal);
    expect(spoken).toBe(2);

    // The first voice's entry is still cached.
    applyAiConfig(FIRST);
    await warmSpeech(["King 41, stand by"], "female", signal);
    expect(spoken).toBe(2);
  });

  it("stops at the first failure instead of failing once per line", async () => {
    applyAiConfig(FIRST);
    speak = async () => {
      throw new Error("no voice installed");
    };
    await warmSpeech(["a b", "c d", "e f"], "female", signal);
    expect(spoken).toBe(1);
  });
});
