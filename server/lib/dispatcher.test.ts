/**
 * The dispatcher end to end: a stand-in tRadio on one side, a scripted provider on the
 * other, the real turn loop in between.
 *
 * What is proven here that no unit test can: that the pieces agree with each other and
 * with the contract. A transmission arrives on the tap, is transcribed, decided, spoken
 * and handed to tRadio as PCM on the station that covers the channel; a human
 * dispatcher signing on takes the channel back; a 911 call is picked up through
 * `answer911`, greeted once the caller is on the line, and ended through `end911`.
 *
 * Time is real but short: the turn loop's own timers (a hold after 1.2 s) are not
 * waited for, because every case here answers faster than that.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCad } from "./cad";
import { answeredCount, resetCalls } from "./calls";
import { resetAiConfig } from "./config";
import { history, resetConversations } from "./conversation";
import { installDispatcher } from "./index";
import { aiLog } from "./logger";
import { setProvider } from "./provider";
import { resetSpeaker } from "./speak";
import { StubTradio } from "./stub-tradio";
import * as tradio from "./tradio-hooks";
import type { AiDecision, AiProvider, AiTool } from "./types";

const FREQ = 154.755;
const CALL_FREQ = 880.0001;

const stub = new StubTradio();
let scratch = "";

interface Script {
  transcripts: string[];
  decisions: AiDecision[];
  heard: Array<{ mime: string; bias: string }>;
  spoken: string[];
  toolsSeen: string[][];
  /** One per transcribe call; a defined entry holds that call until it settles. */
  gates: Array<Promise<void> | undefined>;
  /** One per decide call; a defined entry is thrown. */
  decideErrors: Array<Error | undefined>;
}

let script: Script;

function newScript(): Script {
  return {
    transcripts: [],
    decisions: [],
    heard: [],
    spoken: [],
    toolsSeen: [],
    gates: [],
    decideErrors: [],
  };
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const provider: AiProvider = {
  name: "scripted",
  async transcribe(clip, _signal, bias = "") {
    script.heard.push({ mime: clip.mime, bias });
    const held = script.gates.shift();
    if (held) await held;
    return script.transcripts.shift() ?? "";
  },
  async decide(_system, _prompt, tools: readonly AiTool[]) {
    script.toolsSeen.push(tools.map((tool) => tool.id));
    const failure = script.decideErrors.shift();
    if (failure) throw failure;
    return script.decisions.shift() ?? { actions: [], reply: "" };
  },
  async compose() {
    return "";
  },
  async speak(text) {
    script.spoken.push(text);
    return { pcm: new Int16Array(24000).fill(1000), sampleRate: 24000 };
  },
};

async function until(condition: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The settled quiet after something that should NOT happen. */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 120));

/** All three capabilities hosted, so nothing local is downloaded or warmed. */
function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    channels: [FREQ],
    callsign: "Dispatch",
    wakePhrases: ["dispatch"],
    yieldToDispatcher: true,
    auto911: true,
    answer911: false,
    providers: {
      text: { provider: "groq", model: "m", baseUrl: "http://127.0.0.1:1/v1" },
      speech: { provider: "openai", model: "m", baseUrl: "http://127.0.0.1:1/v1" },
      transcription: { provider: "openai", model: "m", baseUrl: "http://127.0.0.1:1/v1" },
    },
    ...overrides,
  };
}

/** Apply a config the way sv_config.lua does, and let tRadio be (re)discovered. */
function start(overrides: Record<string, unknown> = {}): void {
  stub.fire("onResourceStart", "tRadio");
  stub.fire("tradioai:config", config(overrides));
}

function world(): void {
  stub.channels = [
    { zoneName: "Blaine County", name: "DISP", frequency: FREQ },
    { zoneName: "Blaine County", name: "FIRE", frequency: 460.25 },
  ];
  stub.put(FREQ, 7, { name: "King 41", unitId: "K41" });
  stub.put(FREQ, 8, { name: "King 42", unitId: "K42" });
}

const globals = globalThis as unknown as Record<string, unknown>;
const savedConvar = globals.GetConvar;
const savedPath = globals.GetResourcePath;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "tradioai-dispatcher-"));
  globals.GetResourcePath = () => scratch;
  globals.GetConvar = (name: string, fallback: string) =>
    name.endsWith("_key") ? "test-key-value" : fallback;
  stub.install();
  tradio.resetWiring();
  setProvider(provider);
});

afterAll(() => {
  stub.fire("onResourceStop", "tRadioAI");
  setProvider(null);
  stub.uninstall();
  globals.GetConvar = savedConvar;
  globals.GetResourcePath = savedPath;
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  stub.fire("onResourceStop", "tRadioAI");
  stub.reset();
  tradio.resetHooks();
  resetAiConfig();
  resetCalls();
  resetCad();
  resetConversations();
  resetSpeaker();
  script = newScript();
  installDispatcher();
});

describe("finding tRadio", () => {
  test("without tRadio it idles with one line, and starts working when tRadio starts", async () => {
    stub.state = "missing";
    const warn = spyOn(aiLog, "warn").mockImplementation(() => {});
    try {
      stub.invocations = [];
      start();
      await quiet();
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines.filter((line) => line.includes("idle"))).toHaveLength(1);
      expect(lines.join("\n")).toContain("not installed");
      expect(stub.invocations).toHaveLength(0);

      stub.state = "started";
      world();
      stub.fire("onResourceStart", "tRadio");
      await until(() => stub.taps.size === 1 && stub.stations.size === 1, "tap and station");
    } finally {
      warn.mockRestore();
    }
  });

  test("an old tRadio idles naming the hooks it lacks, then works once updated", async () => {
    world();
    stub.remove(
      "registerTransmissionTap",
      "unregisterTransmissionTap",
      "getStations",
      "closeStation",
    );
    const warn = spyOn(aiLog, "warn").mockImplementation(() => {});
    try {
      start();
      await quiet();
      const said = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(said).toContain("too old");
      expect(said).toContain("unregisterTransmissionTap");
      // Nothing was attempted against an interface that is not there.
      expect(stub.called("openStation")).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("a tRadio that refuses this resource is told once and retried on a slow beat", async () => {
    world();
    stub.permitted = false;
    const warn = spyOn(aiLog, "warn").mockImplementation(() => {});
    try {
      start();
      await quiet();
      await quiet();
      const said = warn.mock.calls.map((call) => String(call[0]));
      expect(
        said.filter((line) => line.includes("Config.integrations = { 'tRadioAI' }")).length,
      ).toBeGreaterThan(0);
      // The sweep runs twice a second; the refusal must not be re-asked on every beat.
      expect(stub.called("registerTransmissionTap").length).toBeLessThanOrEqual(1);
      expect(stub.called("openStation").length).toBeLessThanOrEqual(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("disabling the dispatcher takes the tap and the station down", async () => {
    world();
    start();
    await until(() => stub.taps.size === 1 && stub.stations.size === 1, "tap and station");
    stub.fire("tradioai:config", config({ enabled: false }));
    await until(() => stub.taps.size === 0 && stub.stations.size === 0, "everything closed");
  });

  test("tRadio restarting gets a fresh tap and a fresh station", async () => {
    world();
    start();
    await until(() => stub.taps.size === 1, "first tap");
    const first = stub.tapId();

    stub.fire("onResourceStop", "tRadio");
    stub.taps.clear();
    stub.stations.clear();
    stub.fire("onResourceStart", "tRadio");

    await until(() => stub.taps.size === 1 && stub.stations.size === 1, "re-registered");
    expect(stub.tapId()).not.toBe(first);
  });
});

describe("a transmission", () => {
  test("is heard, answered and aired as PCM on the station that covers the channel", async () => {
    world();
    script.transcripts.push("Dispatch, King 41");
    start();
    await until(() => stub.taps.size === 1 && stub.stations.size === 1, "tap and station");

    expect([...stub.stations.values()][0]).toMatchObject({
      name: "Dispatch",
      frequencies: [FREQ],
      answers911: false,
    });

    stub.transmission({ serverId: 7, frequency: FREQ, name: "King 41" });
    await until(() => stub.transmits.length === 1, "the reply to air");

    expect(script.spoken).toEqual(["Go ahead, King 41"]);
    expect(stub.transmits[0]).toMatchObject({
      stationId: stub.stationId(),
      frequency: FREQ,
      sampleRate: 8000,
      container: "pcm16",
    });
    // Narrowband, as promised: 24 kHz speech resampled to 8 kHz, one second of it.
    expect(stub.transmits[0]?.samples).toBe(8000);
    // The recogniser was handed tRadio's WAV, biased with the callsigns on the channel.
    expect(script.heard[0]?.mime).toBe("audio/wav");
    expect(script.heard[0]?.bias).toContain("King 41");
  });

  test("a WebM clip goes to the recogniser as WebM", async () => {
    world();
    script.transcripts.push("");
    start();
    await until(() => stub.taps.size === 1, "tap");
    stub.transmission({ serverId: 7, frequency: FREQ, container: "webm", codec: "opus" });
    await until(() => script.heard.length === 1, "transcription");
    expect(script.heard[0]?.mime).toBe("audio/webm");
  });

  test("traffic not addressed to the dispatcher is heard and not answered", async () => {
    world();
    script.transcripts.push("King 42, are you on scene yet");
    start();
    await until(() => stub.taps.size === 1, "tap");
    stub.transmission({ serverId: 7, frequency: FREQ });
    await until(() => script.heard.length === 1, "transcription");
    await quiet();
    expect(stub.transmits).toHaveLength(0);
    expect(script.toolsSeen).toHaveLength(0);
  });

  test("a model decision is carried out: the reply airs and the tool is offered by name", async () => {
    world();
    script.transcripts.push("Dispatch, King 41, show me ten eight");
    script.decisions.push({
      actions: [],
      reply: "King 41, copy ten eight",
      kind: "report",
      about: "status",
    });
    start();
    await until(() => stub.taps.size === 1, "tap");
    stub.transmission({ serverId: 7, frequency: FREQ, name: "King 41" });
    await until(() => stub.transmits.length >= 1, "a reply on the air", 5000);

    expect(script.spoken.some((line) => line.includes("copy ten eight"))).toBe(true);
  });

  test("a transmission on a channel that is not monitored is ignored", async () => {
    world();
    script.transcripts.push("Dispatch, King 41");
    start();
    await until(() => stub.taps.size === 1, "tap");
    stub.transmission({ serverId: 7, frequency: 460.25 });
    await quiet();
    expect(script.heard).toHaveLength(0);
  });

  test("a console's own transmission is never answered", async () => {
    world();
    script.transcripts.push("Dispatch, King 41");
    start();
    await until(() => stub.taps.size === 1, "tap");
    stub.transmission({ serverId: -890000, frequency: FREQ });
    stub.transmission({ serverId: -1001, frequency: FREQ });
    await quiet();
    expect(script.heard).toHaveLength(0);
  });

  test("a transmission carrying the wrong tap id never reaches the recogniser", async () => {
    world();
    script.transcripts.push("Dispatch, King 41");
    start();
    await until(() => stub.taps.size === 1, "tap");
    stub.transmission({ serverId: 7, frequency: FREQ }, "tap-forged");
    await quiet();
    expect(script.heard).toHaveLength(0);
  });

  test("when tRadio will not air it, the turn ends in silence rather than an error", async () => {
    world();
    stub.transmitReason = "queue_full";
    script.transcripts.push("Dispatch, King 41");
    const warn = spyOn(aiLog, "warn").mockImplementation(() => {});
    try {
      start();
      await until(() => stub.taps.size === 1, "tap");
      stub.transmission({ serverId: 7, frequency: FREQ });
      await until(() => stub.transmits.length === 1, "an attempt");
      await quiet();
      expect(
        warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("abandoned")),
      ).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a human dispatcher", () => {
  test("signing on to a channel takes it back, and signing off returns it", async () => {
    world();
    stub.channels.push({ zoneName: "Blaine County", name: "OPS", frequency: 155.1 });
    start({ channels: [FREQ, 155.1] });
    await until(() => stub.stations.size === 1, "station");
    expect([...stub.stations.values()][0]?.frequencies.sort()).toEqual([155.1, FREQ].sort());

    stub.humans = [{ serverId: -1001, selected: FREQ, listening: [] }];
    await until(
      () => [...stub.stations.values()][0]?.frequencies.join() === "155.1",
      "the station to leave the covered channel",
      3000,
    );

    stub.humans = [];
    await until(
      () => [...stub.stations.values()][0]?.frequencies.length === 2,
      "the station to return",
      3000,
    );
  });

  test("traffic on a channel a human covers is not answered", async () => {
    world();
    stub.humans = [{ serverId: -1001, selected: null, listening: [FREQ] }];
    script.transcripts.push("Dispatch, King 41");
    start();
    await until(() => stub.taps.size === 1, "tap");
    stub.transmission({ serverId: 7, frequency: FREQ });
    await quiet();
    expect(script.heard).toHaveLength(0);
    expect(stub.transmits).toHaveLength(0);
  });
});

describe("911", () => {
  const call = {
    id: "call911_a",
    callerServerId: 9,
    callerName: "Alex Vance",
    message: "break in",
    frequency: CALL_FREQ,
  };

  test("with answering off, a queued call is put out on the air and never picked up", async () => {
    world();
    script.decisions.push({
      actions: [],
      reply: "All units, a break in reported",
      kind: "request",
      about: "call",
    });
    start({ answer911: false });
    await until(() => stub.stations.size === 1, "station");
    stub.queueCall(call);
    await until(() => stub.transmits.length >= 1, "the announcement", 5000);

    expect(stub.answered911).toHaveLength(0);
    expect(stub.transmits[0]?.frequency).toBe(FREQ);
  });

  test("with answering on, the station asks to take calls and the call is picked up", async () => {
    world();
    start({ answer911: true });
    await until(
      () => [...stub.stations.values()][0]?.answers911 === true,
      "a station that takes calls",
    );

    stub.callerOfflineFor = 2;
    stub.queueCall(call);
    // The caller's client is still connecting: answer911 refuses twice, then succeeds.
    await until(() => stub.answered911.length === 1, "the call to be answered", 4000);
    expect(stub.called("answer911").length).toBe(3);
    expect(answeredCount()).toBe(1);
  });

  test("the greeting waits for the caller to be on the line, then airs on the call's frequency", async () => {
    world();
    start({ answer911: true });
    await until(() => [...stub.stations.values()][0]?.answers911 === true, "station");

    stub.queueCall(call);
    await until(() => stub.answered911.length === 1, "answer");
    await quiet();
    // Nobody is on the call frequency yet: anything aired now would be lost.
    expect(stub.transmits).toHaveLength(0);

    stub.put(CALL_FREQ, 9, { name: "Alex Vance" });
    await until(() => stub.transmits.length === 1, "the greeting", 3000);
    expect(stub.transmits[0]?.frequency).toBe(CALL_FREQ);
    expect(script.spoken[0]).toBe("Nine one one, what is your emergency?");
  });

  test("a call that tRadio refuses to hand over leaves nothing registered", async () => {
    world();
    start({ answer911: true });
    await until(() => [...stub.stations.values()][0]?.answers911 === true, "station");

    stub.answerRefusal = "unknown_call";
    stub.queueCall(call);
    await until(() => stub.called("answer911").length === 1, "the attempt");
    await quiet();
    expect(answeredCount()).toBe(0);
  });

  test("a human dispatcher on the panel stops the dispatcher answering", async () => {
    world();
    stub.humans = [{ serverId: -1001, selected: null, listening: [] }];
    start({ answer911: true });
    await until(() => stub.stations.size === 1, "station");
    // The station was not offered as one that takes calls while a human is on.
    expect([...stub.stations.values()][0]?.answers911).toBe(false);
    stub.queueCall(call);
    await quiet();
    expect(stub.answered911).toHaveLength(0);
  });

  test("hang_up ends the call through end911, and tRadio's end event clears the registry", async () => {
    world();
    script.decisions.push({
      actions: [{ tool: "hang_up", input: "a break in at the store" }],
      reply: "Help is on the way",
      kind: "done",
      about: "break in",
    });
    start({ answer911: true });
    await until(() => [...stub.stations.values()][0]?.answers911 === true, "station");
    stub.put(CALL_FREQ, 9, { name: "Alex Vance" });
    stub.queueCall(call);
    await until(() => stub.transmits.length === 1, "the greeting", 3000);

    // The caller speaks; the scripted decision hangs up.
    script.transcripts.push("someone is breaking into the store on Main street");
    stub.transmission({ serverId: 9, frequency: CALL_FREQ, name: "Alex Vance" });
    await until(() => stub.ended911.includes(call.id), "end911", 6000);

    // end911 made tRadio fire its end event with the caller's id, and that cleared it.
    await until(() => answeredCount() === 0, "the registry to clear", 3000);
  });

  test("the call ending from tRadio's side (caller hung up) clears the registry too", async () => {
    world();
    start({ answer911: true });
    await until(() => [...stub.stations.values()][0]?.answers911 === true, "station");
    stub.queueCall(call);
    await until(() => answeredCount() === 1, "answered");

    stub.fire("tradio:911:ended", 9, "caller_ended");
    await until(() => answeredCount() === 0, "release");
  });
});

describe("tools", () => {
  test("the radio tools the dispatcher offers follow what tRadio has", async () => {
    world();
    stub.alerts = [{ name: "SIGNAL 100" }];
    stub.tones = ["ATTENTION"];
    script.transcripts.push("Dispatch, King 41, I need a plate");
    start();
    await until(() => stub.taps.size === 1, "tap");
    stub.transmission({ serverId: 7, frequency: FREQ });
    await until(() => script.toolsSeen.length === 1, "a decision", 5000);

    const offered = script.toolsSeen[0] ?? [];
    expect(offered).toContain("channel_alert");
    expect(offered).toContain("channel_tone");
    expect(offered).toContain("patch_channels");
    // No CAD is connected, so none of its tools are offered.
    expect(offered).not.toContain("run_plate");
  });

  test("a tRadio without alerts or patches simply does not offer those tools", async () => {
    world();
    stub.remove("getAlerts", "getToneKeys", "getPatches", "removePatch", "createPatch");
    script.transcripts.push("Dispatch, King 41, I need a plate");
    start();
    await until(() => stub.taps.size === 1, "tap");
    stub.transmission({ serverId: 7, frequency: FREQ });
    await until(() => script.toolsSeen.length === 1, "a decision", 5000);

    const offered = script.toolsSeen[0] ?? [];
    expect(offered).not.toContain("channel_alert");
    expect(offered).not.toContain("patch_channels");
  });

  test("CAD tools appear only when tRadio reports consent and a capability", async () => {
    world();
    stub.detected = { sonoran: { writeStatus: true } };
    stub.cadSupports = ["plate"];
    script.transcripts.push("Dispatch, King 41, run a plate", "Dispatch, King 41, run a plate");
    start();
    await until(() => stub.taps.size === 1, "tap");

    stub.transmission({ serverId: 7, frequency: FREQ });
    await until(() => script.toolsSeen.length === 1, "first decision", 5000);
    expect(script.toolsSeen[0]).toContain("run_plate");

    // Consent withdrawn in tRadio: the tool is gone on the next turn, with no setting here.
    stub.cadConsent = false;
    resetCad();
    await new Promise((resolve) => setTimeout(resolve, 3200));
    stub.transmission({ serverId: 7, frequency: FREQ });
    await until(() => script.toolsSeen.length === 2, "second decision", 5000);
    expect(script.toolsSeen[1]).not.toContain("run_plate");
  });
});

describe("regressions", () => {
  const call = {
    id: "call911_r",
    callerServerId: 9,
    callerName: "Alex Vance",
    message: "break in",
    frequency: CALL_FREQ,
  };

  const onCallFreq = () => stub.transmits.filter((entry) => entry.frequency === CALL_FREQ).length;

  /** A call picked up, the caller on the line and greeted. */
  async function answeredAndGreeted(): Promise<void> {
    await until(() => [...stub.stations.values()][0]?.answers911 === true, "station");
    stub.put(CALL_FREQ, 9, { name: "Alex Vance" });
    stub.queueCall(call);
    await until(() => stub.answered911.length === 1, "answer");
    await until(() => onCallFreq() === 1, "the greeting", 3000);
  }

  test("a human dispatcher signing on mid-call does not close the station that is on the call", async () => {
    world();
    start({ answer911: true, auto911: false });
    await until(() => stub.taps.size === 1 && stub.stations.size === 1, "tap and station");
    const station = stub.stationId();
    await answeredAndGreeted();

    stub.humans = [{ serverId: -1001, selected: FREQ, listening: [] }];
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(stub.stationId()).toBe(station);
    expect(stub.called("closeStation").filter((entry) => entry.args[0] === station)).toHaveLength(
      0,
    );

    stub.fire("tradio:911:ended", 9, "caller_hangup");
    await until(() => !stub.stations.has(station as string), "the station to close", 2000);
  });

  test("a 911 call that arrives while the only channel is mid-turn is put out when the turn ends", async () => {
    world();
    script.transcripts.push("Dispatch, King 41, show me 10-8");
    script.decisions.push(
      { actions: [], reply: "King 41, copy" },
      { actions: [], reply: "King 42, respond, structure fire" },
    );
    const held = gate();
    script.gates.push(held.wait);
    start();
    await until(() => stub.taps.size === 1 && stub.stations.size === 1, "tap and station");

    stub.transmission({ serverId: 7, frequency: FREQ, name: "King 41" });
    await until(() => script.heard.length === 1, "transcription entered");
    stub.fire("tradioai:call", { source: "CAD", message: "structure fire on Elgin Avenue" });
    await quiet();
    expect(script.spoken).toHaveLength(0);
    expect(script.toolsSeen).toHaveLength(0);

    held.open();
    await until(
      () =>
        script.spoken.includes("King 41, copy") &&
        script.spoken.includes("King 42, respond, structure fire"),
      "both replies",
      5000,
    );
    expect(script.spoken.indexOf("King 41, copy")).toBeLessThan(
      script.spoken.indexOf("King 42, respond, structure fire"),
    );
    await until(() => stub.transmits.length >= 2, "both on the air");
    expect(stub.transmits.every((entry) => entry.frequency === FREQ)).toBe(true);
  });

  test("a call the dispatcher could not pick up is announced on the radio instead", async () => {
    world();
    stub.answerRefusal = "no_console";
    script.decisions.push({ actions: [], reply: "King 41, respond, break in" });
    start({ answer911: true, auto911: true });
    await until(() => [...stub.stations.values()][0]?.answers911 === true, "station");
    stub.queueCall(call);
    await until(
      () => script.spoken.includes("King 41, respond, break in"),
      "the announcement",
      5000,
    );
    await until(() => stub.transmits.length >= 1, "on the air");
    expect(stub.transmits[0]?.frequency).toBe(FREQ);
    expect(answeredCount()).toBe(0);
  });

  test("a call somebody else already has is not announced", async () => {
    world();
    stub.answerRefusal = "already_handled";
    script.decisions.push({ actions: [], reply: "King 41, respond, break in" });
    start({ answer911: true, auto911: true });
    await until(() => [...stub.stations.values()][0]?.answers911 === true, "station");
    stub.queueCall(call);
    await quiet();
    await quiet();
    expect(script.spoken).toHaveLength(0);
    expect(script.toolsSeen).toHaveLength(0);
  });

  test("a call that ends while a turn is in flight takes the turn with it and leaves no history", async () => {
    world();
    start({ answer911: true, auto911: false });
    await until(() => stub.taps.size === 1 && stub.stations.size === 1, "tap and station");
    await answeredAndGreeted();
    const before = onCallFreq();

    const held = gate();
    script.gates.push(held.wait);
    script.transcripts.push("there is a man with a gun");
    stub.transmission({ serverId: 9, frequency: CALL_FREQ, name: "Alex Vance" });
    await until(() => script.heard.length === 1, "transcription entered");

    stub.fire("tradio:911:ended", 9, "caller_hangup");
    held.open();
    await quiet();
    await quiet();
    expect(script.toolsSeen).toHaveLength(0);
    expect(onCallFreq()).toBe(before);
    expect(history(CALL_FREQ)).toEqual([]);
  });

  test("a decision that fails fast does not leave 'stand by' to go out a second later", async () => {
    world();
    script.transcripts.push("Dispatch, King 41, show me 10-8", "King 42 to King 41");
    script.decideErrors.push(new Error("HTTP 401"));
    const second = gate();
    script.gates.push(undefined, second.wait);
    const warn = spyOn(aiLog, "warn").mockImplementation(() => {});
    try {
      start();
      await until(() => stub.taps.size === 1 && stub.stations.size === 1, "tap and station");

      stub.transmission({ serverId: 7, frequency: FREQ, name: "King 41" });
      stub.transmission({ serverId: 8, frequency: FREQ, name: "King 42" });
      await until(() => script.toolsSeen.length === 1, "the failed decision");
      await until(() => script.heard.length === 2, "the queued transmission");

      await new Promise((resolve) => setTimeout(resolve, 1600));
      expect(script.spoken.filter((line) => line.endsWith("stand by"))).toEqual([]);

      second.open();
      await quiet();
      await quiet();
    } finally {
      warn.mockRestore();
    }
  });
});
