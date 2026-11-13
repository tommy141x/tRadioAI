/**
 * The adapter against a stand-in that implements the contract.
 *
 * Two kinds of case. The ordinary ones prove each hook is read and written the way
 * `docs/content/tradio-contract.mdx` says. The degradation ones are the point of having an
 * adapter at all: tRadio absent, stopped, too old, or refusing must each end in ONE
 * message that says what to do, never in a thrown "No such export".
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { aiLog } from "./logger";
import { StubTradio } from "./stub-tradio";
import * as tradio from "./tradio-hooks";

let stub: StubTradio;

beforeEach(() => {
  stub = new StubTradio();
  stub.install();
  tradio.resetHooks();
  tradio.resetWiring();
  tradio.wireEvents();
});

afterEach(() => {
  tradio.resetHooks();
  stub.uninstall();
});

const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

describe("probe", () => {
  test("a tRadio with every hook is ready and says nothing", () => {
    const capabilities = tradio.probe();
    expect(capabilities).toMatchObject({
      state: "started",
      read: true,
      tap: true,
      station: true,
      calls911: true,
      alerts: true,
      patches: true,
      cad: true,
      missing: [],
    });
    expect(tradio.idleReason(capabilities)).toBe("");
  });

  test("probing creates nothing in tRadio", () => {
    tradio.probe();
    // The write-ish hooks are probed through their inverse with an id that cannot
    // exist, so a probe leaves no tap, station, patch or call behind.
    expect(stub.taps.size).toBe(0);
    expect(stub.stations.size).toBe(0);
    expect(stub.patchList).toHaveLength(0);
    expect(stub.transmits).toHaveLength(0);
    expect(stub.called("registerTransmissionTap")).toHaveLength(0);
    expect(stub.called("openStation")).toHaveLength(0);
    expect(stub.called("createPatch")).toHaveLength(0);
    expect(stub.called("stationTransmit")).toHaveLength(0);
    expect(stub.called("answer911")).toHaveLength(0);
  });

  test("tRadio not installed: one line, no export is ever called", () => {
    stub.state = "missing";
    const capabilities = tradio.probe();
    expect(capabilities.state).toBe("absent");
    expect(tradio.idleReason(capabilities)).toContain("not installed");
    expect(stub.invocations).toHaveLength(0);
  });

  test("tRadio stopped: says it will start working when tRadio does", () => {
    stub.state = "stopped";
    const capabilities = tradio.probe();
    expect(capabilities.state).toBe("stopped");
    expect(tradio.idleReason(capabilities)).toContain("not running");
    expect(stub.invocations).toHaveLength(0);
  });

  test("an older tRadio without the tap or station hooks: idle, naming exactly what is missing", () => {
    stub.remove("unregisterTransmissionTap", "getStations", "closeStation");
    const capabilities = tradio.probe();
    expect(capabilities.tap).toBe(false);
    expect(capabilities.station).toBe(false);
    expect(capabilities.read).toBe(true);
    const reason = tradio.idleReason(capabilities);
    expect(reason).toContain("too old");
    expect(reason).toContain("tap and station");
    expect(reason).toContain("unregisterTransmissionTap");
    expect(reason).toContain("getStations");
    // One message, not one per hook and not a stack trace.
    expect(reason.split("\n")).toHaveLength(1);
  });

  test("a tRadio without the 911 hooks still runs; it just does not take calls", () => {
    stub.remove("end911");
    const capabilities = tradio.probe();
    expect(capabilities.calls911).toBe(false);
    expect(tradio.idleReason(capabilities)).toBe("");
  });

  test("a tRadio without the CAD hooks still runs; CAD tools are off", () => {
    stub.remove("cadCapabilities");
    const capabilities = tradio.probe();
    expect(capabilities.cad).toBe(false);
    expect(tradio.idleReason(capabilities)).toBe("");
  });

  test("a missing export is reported as missing, never thrown", () => {
    stub.remove("getAllChannels");
    expect(() => tradio.probe()).not.toThrow();
    expect(tradio.channels()).toEqual([]);
  });
});

describe("refusal", () => {
  test("a refused tap names the exact line to add, with this resource's own name", () => {
    stub.permitted = false;
    const warn = spyOn(aiLog, "warn").mockImplementation(() => {});
    try {
      expect(tradio.registerTap([154.755], () => {})).toBe(false);
      const said = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(said).toContain("Config.integrations = { 'tRadioAI' }");
      expect(said).toContain("registerTransmissionTap");
    } finally {
      warn.mockRestore();
    }
  });

  test("a refused station, patch and 911 answer each say so and return a failure", () => {
    stub.permitted = false;
    const warn = spyOn(aiLog, "warn").mockImplementation(() => {});
    try {
      expect(
        tradio.openStation({ name: "Dispatch", frequencies: [1], answers911: false }),
      ).toBeNull();
      expect(tradio.createPatch("A/B", [1, 2])).toEqual({ ok: false, reason: "not_permitted" });
      expect(tradio.answer911("station-x", "call-1")).toEqual({
        ok: false,
        reason: "not_permitted",
      });
      expect(warn.mock.calls.length).toBe(3);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("hearing transmissions", () => {
  test("delivers an ended transmission, decoded, to the handler", () => {
    const heard: tradio.Transmission[] = [];
    expect(tradio.registerTap([154.755], (t) => heard.push(t))).toBe(true);
    expect(stub.taps.get(stub.tapId() as string)?.frequencies).toEqual([154.755]);

    stub.transmission({ serverId: 7, frequency: 154.755, name: "King 41", audio: wav });

    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({
      serverId: 7,
      name: "King 41",
      frequency: 154.755,
      container: "wav",
      sampleRate: 16000,
    });
    expect(Array.from(heard[0]?.audio ?? [])).toEqual(Array.from(wav));
  });

  test("an event that does not carry this tap's id is not heard", () => {
    const heard: tradio.Transmission[] = [];
    tradio.registerTap([154.755], (t) => heard.push(t));

    // Any resource can fire the event; only tRadio knows the id it issued.
    stub.transmission({ serverId: 7, frequency: 154.755 }, "tap-guessed");
    stub.transmission({ serverId: 7, frequency: 154.755 }, null);

    expect(heard).toHaveLength(0);
  });

  test("a WebM clip is accepted as it is", () => {
    const heard: tradio.Transmission[] = [];
    tradio.registerTap([154.755], (t) => heard.push(t));
    stub.transmission({ serverId: 7, frequency: 154.755, container: "webm", codec: "opus" });
    expect(heard[0]?.container).toBe("webm");
  });

  test("a WAV at any rate but 16 kHz is dropped, because whisper reads only that", () => {
    const heard: tradio.Transmission[] = [];
    tradio.registerTap([154.755], (t) => heard.push(t));
    const warn = spyOn(aiLog, "warn").mockImplementation(() => {});
    try {
      stub.transmission({ serverId: 7, frequency: 154.755, sampleRate: 22050 });
      expect(heard).toHaveLength(0);
      expect(String(warn.mock.calls[0]?.[0])).toContain("22050");
      stub.transmission({ serverId: 7, frequency: 154.755, sampleRate: tradio.STT_SAMPLE_RATE });
      expect(heard).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a malformed payload is dropped without throwing", () => {
    const heard: tradio.Transmission[] = [];
    tradio.registerTap([154.755], (t) => heard.push(t));
    const id = stub.tapId();
    expect(() => stub.fire("tradio:tap:transmission", id, "not json")).not.toThrow();
    expect(() => stub.fire("tradio:tap:transmission", id, { serverId: "x" })).not.toThrow();
    expect(() =>
      stub.fire("tradio:tap:transmission", id, {
        serverId: 1,
        frequency: 1,
        container: "mp3",
        audio: "AA==",
      }),
    ).not.toThrow();
    expect(heard).toHaveLength(0);
  });

  test("a handler that throws does not break delivery of the next transmission", () => {
    let calls = 0;
    const warn = spyOn(aiLog, "warn").mockImplementation(() => {});
    try {
      tradio.registerTap([154.755], () => {
        calls += 1;
        throw new Error("boom");
      });
      stub.transmission({ serverId: 7, frequency: 154.755 });
      stub.transmission({ serverId: 7, frequency: 154.755 });
      expect(calls).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("registering again replaces the tap rather than doubling it", () => {
    const heard: number[] = [];
    tradio.registerTap([1], () => heard.push(1));
    const first = stub.tapId();
    tradio.registerTap([2], () => heard.push(2));
    expect(stub.taps.has(first as string)).toBe(false);
    expect(stub.taps.size).toBe(1);
    stub.transmission({ serverId: 7, frequency: 2 });
    expect(heard).toEqual([2]);
  });

  test("events are wired once however many times wiring is asked for", () => {
    tradio.wireEvents();
    tradio.wireEvents();
    expect(stub.handlerCount("tradio:tap:transmission")).toBe(1);
  });
});

describe("speaking as a station", () => {
  test("a transmission is handed over as 8 kHz PCM and resolves when tRadio says it aired", async () => {
    const station = tradio.openStation({
      name: "Dispatch",
      frequencies: [154.755],
      answers911: false,
    });
    expect(station).toBeTruthy();

    const pcm = new Int16Array(8000);
    const sent = tradio.transmit(
      station as string,
      { frequency: 154.755, pcm, sampleRate: 8000, maxMs: 20000 },
      5000,
    );
    expect(sent.accepted).toBe(true);
    const result = await sent.done;

    expect(result).toEqual({ ok: true, reason: "aired", airedMs: 1000 });
    expect(stub.transmits[0]).toMatchObject({
      frequency: 154.755,
      sampleRate: 8000,
      container: "pcm16",
      samples: 8000,
      maxMs: 20000,
    });
  });

  test("tRadio's reason for not airing is passed through", async () => {
    const station = tradio.openStation({
      name: "Dispatch",
      frequencies: [154.755],
      answers911: false,
    }) as string;
    stub.transmitReason = "queue_full";
    const result = await tradio.transmit(
      station,
      { frequency: 154.755, pcm: new Int16Array(80), sampleRate: 8000, maxMs: 1 },
      5000,
    ).done;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("queue_full");
  });

  test("transmitting on a channel the station does not cover is not_covered", async () => {
    const station = tradio.openStation({
      name: "Dispatch",
      frequencies: [154.755],
      answers911: false,
    }) as string;
    const result = await tradio.transmit(
      station,
      { frequency: 999, pcm: new Int16Array(80), sampleRate: 8000, maxMs: 1 },
      5000,
    ).done;
    expect(result.reason).toBe("not_covered");
  });

  test("a done event for another station or an unknown request is ignored", async () => {
    stub.autoFinish = false;
    const station = tradio.openStation({
      name: "Dispatch",
      frequencies: [1],
      answers911: false,
    }) as string;
    const sent = tradio.transmit(
      station,
      { frequency: 1, pcm: new Int16Array(80), sampleRate: 8000, maxMs: 1 },
      80,
    );
    const requestId = stub.transmits[0]?.requestId as string;

    stub.fire("tradio:station:done", "station-other", requestId, {
      ok: true,
      reason: "aired",
      airedMs: 10,
    });
    stub.fire("tradio:station:done", station, "tx-unknown", {
      ok: true,
      reason: "aired",
      airedMs: 10,
    });

    // Neither resolved it, so it falls through to the timeout.
    expect((await sent.done).reason).toBe("timeout");
  });

  test("a done that never arrives times out instead of holding the turn", async () => {
    stub.autoFinish = false;
    const station = tradio.openStation({
      name: "Dispatch",
      frequencies: [1],
      answers911: false,
    }) as string;
    const started = Date.now();
    const result = await tradio.transmit(
      station,
      { frequency: 1, pcm: new Int16Array(80), sampleRate: 8000, maxMs: 1 },
      60,
    ).done;
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("losing tRadio releases waiting transmissions at once", async () => {
    stub.autoFinish = false;
    const station = tradio.openStation({
      name: "Dispatch",
      frequencies: [1],
      answers911: false,
    }) as string;
    const sent = tradio.transmit(
      station,
      { frequency: 1, pcm: new Int16Array(80), sampleRate: 8000, maxMs: 1 },
      60_000,
    );
    tradio.lostTradio();
    expect((await sent.done).ok).toBe(false);
  });

  test("a refused transmission is not accepted", async () => {
    const station = tradio.openStation({
      name: "Dispatch",
      frequencies: [1],
      answers911: false,
    }) as string;
    stub.permitted = false;
    const warn = spyOn(aiLog, "warn").mockImplementation(() => {});
    try {
      const sent = tradio.transmit(
        station,
        { frequency: 1, pcm: new Int16Array(80), sampleRate: 8000, maxMs: 1 },
        5000,
      );
      expect(sent.accepted).toBe(false);
      expect((await sent.done).reason).toBe("refused");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("stations view", () => {
  test("reads the human dispatchers and caches for a moment", () => {
    stub.humans = [{ serverId: -1001, selected: 154.755, listening: [460.25] }];
    expect(tradio.stations(1000).humans).toEqual([
      { serverId: -1001, selected: 154.755, listening: [460.25] },
    ]);
    stub.humans = [];
    // Within the cache window: the sweep and the turn do not each pay a round trip.
    expect(tradio.stations(1100).humans).toHaveLength(1);
    expect(tradio.stations(5000).humans).toHaveLength(0);
  });

  test("a dispatcher with nothing selected has a null selection, not zero", () => {
    stub.humans = [{ serverId: -1001, selected: null, listening: [] }];
    expect(tradio.stations(0).humans[0]?.selected).toBeNull();
  });

  test("station ids are told apart from people", () => {
    expect(tradio.isStationId(-890000)).toBe(true);
    expect(tradio.isStationId(-890999)).toBe(true);
    expect(tradio.isStationId(-1001)).toBe(false);
    expect(tradio.isStationId(12)).toBe(false);
  });
});

describe("911", () => {
  const call = {
    id: "call911_a",
    callerServerId: 9,
    callerName: "Caller",
    message: "help",
    frequency: 880.0001,
    coords: { x: 1, y: 2, z: 3 },
  };

  test("a queued call arrives as a typed call", () => {
    const seen: tradio.Call911[] = [];
    tradio.onCallQueued((c) => seen.push(c));
    stub.queueCall(call);
    expect(seen).toEqual([call]);
  });

  test("a malformed queued call is ignored", () => {
    const seen: tradio.Call911[] = [];
    tradio.onCallQueued((c) => seen.push(c));
    stub.fire("tradio:911:queued", "nonsense");
    stub.fire("tradio:911:queued", { message: "no id" });
    expect(seen).toHaveLength(0);
  });

  test("the end event carries the caller and tRadio's own reason", () => {
    const ended: Array<[number, string]> = [];
    tradio.onCallEnded((caller, reason) => ended.push([caller, reason]));
    stub.fire("tradio:911:ended", 9, "caller_no_answer");
    expect(ended).toEqual([[9, "caller_no_answer"]]);
  });

  test("answering passes tRadio's refusal reason through", () => {
    const station = tradio.openStation({
      name: "Dispatch",
      frequencies: [],
      answers911: true,
    }) as string;
    stub.queueCall(call);
    stub.answerRefusal = "caller_offline";
    expect(tradio.answer911(station, call.id)).toEqual({ ok: false, reason: "caller_offline" });
    stub.answerRefusal = null;
    expect(tradio.answer911(station, call.id)).toEqual({ ok: true, reason: "" });
    expect(stub.answered911).toEqual([{ stationId: station, callId: call.id }]);
    expect(tradio.answer911(station, "call-unknown").reason).toBe("unknown_call");
  });

  test("ending a call reports whether tRadio knew it", () => {
    stub.queueCall(call);
    expect(tradio.end911(call.id)).toBe(true);
    expect(tradio.end911(call.id)).toBe(false);
  });

  test("a tRadio without answer911 reports unsupported rather than throwing", () => {
    stub.remove("answer911");
    expect(tradio.answer911("s", "c")).toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("CAD", () => {
  beforeEach(() => {
    stub.detected = { sonoran: { writeStatus: true } };
    stub.cadSupports = ["plate", "createCall"];
  });

  test("an operation is answered with tRadio's reduced result", async () => {
    stub.cadAnswers.set("sonoran.plate", {
      kind: "ok",
      ok: true,
      body: { plate: "ABC123", owner: "A. Vance" },
    });
    const result = await tradio.cadOperation("sonoran", "plate", { plate: "ABC123" });
    expect(result).toEqual({
      kind: "ok",
      ok: true,
      status: undefined,
      body: { plate: "ABC123", owner: "A. Vance" },
    });
    expect(stub.cadRequests).toEqual([
      { provider: "sonoran", op: "plate", params: { plate: "ABC123" } },
    ]);
  });

  test("a failure keeps its kind, because hold and negative are different things on the air", async () => {
    stub.cadAnswers.set("sonoran.plate", { kind: "transient", ok: false, status: "429" });
    const result = await tradio.cadOperation("sonoran", "plate", { plate: "X" });
    expect(result).toMatchObject({ kind: "transient", ok: false, status: "429" });
  });

  test("an answer nobody asked for is not delivered to a waiting request", async () => {
    stub.cadHold = true;
    const waiting = tradio.cadOperation("sonoran", "plate", { plate: "X" }, 80);
    stub.fire("tradio:cad:operationResult", "cad-guessed", { kind: "ok", ok: true });
    expect((await waiting).kind).toBe("transient");
  });

  test("an unanswered request times out as transient and never rejects", async () => {
    stub.cadHold = true;
    const result = await tradio.cadOperation("sonoran", "plate", { plate: "X" }, 40);
    expect(result).toEqual({ kind: "transient", ok: false });
  });

  test("a refused operation is off, with the line to add", async () => {
    stub.permitted = false;
    const warn = spyOn(aiLog, "warn").mockImplementation(() => {});
    try {
      const result = await tradio.cadOperation("sonoran", "plate", { plate: "X" });
      expect(result.kind).toBe("off");
    } finally {
      warn.mockRestore();
    }
  });

  test("a tRadio with no cadOperation answers off", async () => {
    stub.remove("cadOperation");
    expect((await tradio.cadOperation("sonoran", "plate", {})).kind).toBe("off");
  });

  test("capabilities carry the operator's consent from tRadio", () => {
    expect(tradio.cadCapabilities("sonoran")).toEqual({
      provider: "sonoran",
      supports: ["plate", "createCall"],
      consent: true,
    });
    stub.cadConsent = false;
    expect(tradio.cadCapabilities("sonoran")).toEqual({
      provider: "sonoran",
      supports: [],
      consent: false,
    });
  });

  test("an unknown result kind is an error, not a success", async () => {
    stub.cadAnswers.set("sonoran.plate", { kind: "fine", ok: true });
    expect((await tradio.cadOperation("sonoran", "plate", {})).ok).toBe(false);
  });
});

describe("reading the radio system", () => {
  test("channels, occupancy and names", () => {
    stub.channels = [
      { zoneName: "Blaine County", name: "DISP", frequency: 154.755 },
      { zoneName: "State", name: "TRK", frequency: 856.1125, type: "trunked" },
    ];
    stub.put(154.755, 7, { name: "King 41", unitId: "K41", talking: true });
    stub.put(154.755, 8, { listening: true });

    expect(tradio.channels()).toEqual([
      { zoneName: "Blaine County", name: "DISP", frequency: 154.755, type: "conventional" },
      { zoneName: "State", name: "TRK", frequency: 856.1125, type: "trunked" },
    ]);
    const users = tradio.usersOn(154.755);
    expect(users.map((u) => [u.serverId, u.speakerChannel, u.isTalking])).toEqual([
      [7, 154.755, true],
      [8, null, false],
    ]);
    expect(users[1]?.listeningChannels.has(154.755)).toBe(true);
    expect(tradio.playerName(7)).toBe("King 41");
    expect(tradio.unitId(7)).toBe("K41");
    expect(tradio.unitId(99)).toBe("");
  });

  test("a channel nobody is on reads as empty, not as an error", () => {
    expect(tradio.usersOn(1.5)).toEqual([]);
  });

  test("alerts exclude tone-only ones, and tones come back as names", () => {
    stub.alerts = [{ name: "SIGNAL 100" }, { name: "ATTENTION", toneOnly: true }];
    stub.tones = ["ALERT_A"];
    expect(tradio.alertNames()).toEqual(["SIGNAL 100"]);
    expect(tradio.toneNames()).toEqual(["ALERT_A"]);
    expect(tradio.setAlert(154.755, true, "SIGNAL 100")).toBe(true);
    expect(tradio.alertOn(154.755)).toBe("SIGNAL 100");
    expect(tradio.setAlert(154.755, false, null)).toBe(true);
    expect(tradio.alertOn(154.755)).toBeNull();
    expect(tradio.setAlert(154.755, true, "NOPE")).toBe(false);
  });

  test("patches: create, read, refuse by channel, remove", () => {
    const made = tradio.createPatch("A/B", [1, 2]);
    expect(made.ok).toBe(true);
    expect(tradio.patches()).toHaveLength(1);
    expect(tradio.createPatch("A/C", [2, 3])).toMatchObject({
      ok: false,
      reason: "already_patched",
      frequency: 2,
      label: "A/B",
    });
    stub.patchRefusals.set(9, "direct");
    expect(tradio.createPatch("D/E", [9, 10])).toMatchObject({
      ok: false,
      reason: "direct",
      frequency: 9,
    });
    expect(tradio.removePatch((made as { id: string }).id)).toBe(true);
    expect(tradio.removePatch("patch-unknown")).toBe(false);
  });

  test("a table that arrives as an object, as Lua sends a sparse one, is still read", () => {
    const original = stub.occupancy.get(1);
    stub.occupancy.set(1, {
      speakers: { 1: 7 } as unknown as number[],
      listeners: [],
      talking: [],
    });
    expect(tradio.usersOn(1).map((u) => u.serverId)).toEqual([7]);
    expect(original).toBeUndefined();
  });
});
