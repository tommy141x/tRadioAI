import { describe, expect, test } from "bun:test";
import { buildDirectory, type ChannelEntry, describeChannel, resolveChannel } from "./directory";
import type { RosterUnit } from "./roster";

const zones = {
  ls: {
    name: "Los Santos",
    Channels: [
      { name: "DISP", frequency: 155.475 },
      { name: "OPS-1", frequency: 155.55 },
    ],
  },
  bc: {
    name: "Blaine County",
    Channels: [{ name: "DISP", frequency: 460.25 }],
  },
};

function unit(callsign: string): RosterUnit {
  return {
    serverId: 7,
    callsign,
    unitId: "",
    status: "",
    note: "",
    point: null,
    distance: null,
    talking: false,
  };
}

function build(overrides: Partial<Parameters<typeof buildDirectory>[0]> = {}): ChannelEntry[] {
  return buildDirectory({
    zones,
    monitors: () => false,
    roster: () => [],
    alertOn: () => null,
    patchOf: () => [],
    ...overrides,
  });
}

describe("buildDirectory", () => {
  test("describes every configured channel, zone first", () => {
    const names = build().map((entry) => describeChannel(entry.zone, entry.name, entry.frequency));
    expect(names).toContain("Los Santos DISP");
    expect(names).toContain("Blaine County DISP");
  });

  test("puts channels with somebody on them ahead of empty ones", () => {
    const busy = build({ roster: (f) => (f === 460.25 ? [unit("K31")] : []) });
    expect(busy[0]!.zone).toBe("Blaine County");
    expect(busy[0]!.units).toHaveLength(1);
  });

  test("names the channels a patch reaches rather than their frequencies", () => {
    const patched = build({ patchOf: (f) => (f === 155.475 ? [155.475, 460.25] : []) });
    const ls = patched.find((entry) => entry.frequency === 155.475);
    expect(ls!.patchedWith).toEqual(["Blaine County DISP"]);
  });

  test("carries the active alert", () => {
    const running = build({ alertOn: (f) => (f === 155.475 ? "SIGNAL 100" : null) });
    expect(running.find((entry) => entry.frequency === 155.475)!.alert).toBe("SIGNAL 100");
  });
});

describe("resolveChannel", () => {
  const entries = build();

  test("matches the full name a dispatcher would say", () => {
    expect(resolveChannel("Blaine County DISP", entries)!.frequency).toBe(460.25);
  });

  test("matches a frequency", () => {
    expect(resolveChannel("155.475", entries)!.frequency).toBe(155.475);
  });

  test("uses the zone to break a shared channel name", () => {
    expect(resolveChannel("county disp", entries)!.frequency).toBe(460.25);
  });

  test("refuses rather than guessing when two channels fit equally", () => {
    // "DISP" is both zones' channel name, so this is genuinely ambiguous —
    // and a patch onto the wrong agency is worse than an answer of "which one".
    expect(resolveChannel("DISP", entries)).toBeNull();
  });

  test("refuses a channel that does not exist", () => {
    expect(resolveChannel("the fire channel", entries)).toBeNull();
    expect(resolveChannel("", entries)).toBeNull();
  });
});
