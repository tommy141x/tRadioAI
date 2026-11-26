import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { forgetCall, noteAnswered, resetCalls } from "./calls";
import { closeStation, forgetStation, stationId, syncStation, transmitOn } from "./station";
import { StubTradio } from "./stub-tradio";
import * as tradio from "./tradio-hooks";
import type { AiCallInfo } from "./types";

const stub = new StubTradio();

const CONTROL = { name: "Control", frequencies: [154.755], answers911: true };

const info: AiCallInfo = {
  id: "c1",
  source: "911",
  caller: "A",
  message: "m",
  location: "",
  priority: "",
  service: "",
};

function answerCall(): void {
  noteAnswered(
    {
      id: "c1",
      callerServerId: 9,
      callerName: "A",
      message: "m",
      frequency: 880.0001,
      coords: null,
    },
    info,
  );
}

beforeAll(() => {
  stub.install();
  tradio.resetHooks();
  tradio.resetWiring();
  tradio.wireEvents();
});

afterAll(() => {
  forgetStation();
  resetCalls();
  tradio.resetHooks();
  stub.uninstall();
});

beforeEach(() => {
  forgetStation();
  resetCalls();
  stub.reset();
});

describe("the station while a 911 call is live", () => {
  test("is not closed or re-opened for a changed or withdrawn wanted set", () => {
    syncStation(CONTROL);
    const opened = stationId();
    expect(opened).not.toBeNull();
    expect(stub.called("openStation")).toHaveLength(1);

    answerCall();
    syncStation({ name: "Control", frequencies: [], answers911: false });
    syncStation(null);
    expect(stationId()).toBe(opened);
    expect(stub.called("closeStation")).toHaveLength(0);
    expect(stub.called("openStation")).toHaveLength(1);

    forgetCall("c1");
    syncStation(null);
    expect(stationId()).toBeNull();
    expect(stub.stations.size).toBe(0);
  });

  test("an explicit closeStation still closes at once", () => {
    syncStation(CONTROL);
    answerCall();
    closeStation();
    expect(stationId()).toBeNull();
    expect(stub.called("closeStation")).toHaveLength(1);
    expect(stub.stations.size).toBe(0);
  });

  test("with no call live, a changed frequency set re-opens under a new id", () => {
    syncStation(CONTROL);
    const first = stationId();
    syncStation({ ...CONTROL, frequencies: [154.755, 155.475] });
    const second = stationId();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(stub.called("closeStation")).toHaveLength(1);
    expect(stub.stations.size).toBe(1);
  });
});

describe("a relay on a channel the station does not cover", () => {
  test("opens a transient station under the configured name, and closes it", async () => {
    syncStation({ name: "Control", frequencies: [154.755], answers911: false });
    const persistent = stationId();

    const result = await transmitOn(
      460.25,
      new Int16Array(800).fill(500),
      8000,
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);

    const opens = stub.called("openStation");
    expect(opens.length).toBeGreaterThanOrEqual(2);
    const last = JSON.parse(String(opens.at(-1)?.args[0])) as {
      name: string;
      frequencies: number[];
    };
    expect(last.name).toBe("Control");
    expect(last.frequencies).toEqual([460.25]);

    expect(stub.stations.size).toBe(1);
    expect([...stub.stations.keys()]).toEqual([persistent as string]);
  });
});
