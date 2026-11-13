import { describe, expect, test } from "bun:test";
import { buildRoster, describeDistance, type RosterView, type UnitInfo } from "./roster";

const FREQ = 155.475;

function view(serverId: number, options: Partial<RosterView> = {}): RosterView {
  return {
    serverId,
    speakerChannel: FREQ,
    listeningChannels: new Set(),
    isTalking: false,
    ...options,
  };
}

function describer(points: Record<number, { x: number; y: number } | null>) {
  return (serverId: number): UnitInfo => ({
    callsign: `U${serverId}`,
    unitId: "",
    status: "",
    note: "",
    point: points[serverId] ?? null,
  });
}

describe("buildRoster", () => {
  test("includes listeners as well as speakers", () => {
    const users = [
      view(1),
      view(2, { speakerChannel: 460.1, listeningChannels: new Set([FREQ]) }),
      view(3, { speakerChannel: 460.1 }),
    ];
    const roster = buildRoster(FREQ, users, describer({}), null);
    expect(roster.map((unit) => unit.serverId).sort()).toEqual([1, 2]);
  });

  test("leaves dispatch consoles off — they are not units", () => {
    const users = [view(1), view(-1001), view(-900000)];
    const roster = buildRoster(FREQ, users, describer({}), null);
    expect(roster.map((unit) => unit.serverId)).toEqual([1]);
  });

  test("sorts nearest first and puts unplaceable units last", () => {
    const users = [view(1), view(2), view(3)];
    const points = { 1: { x: 300, y: 0 }, 2: null, 3: { x: 40, y: 0 } };
    const roster = buildRoster(FREQ, users, describer(points), { x: 0, y: 0 });
    expect(roster.map((unit) => unit.serverId)).toEqual([3, 1, 2]);
    expect(roster[0]?.distance).toBe(40);
    expect(roster[2]?.distance).toBeNull();
  });

  test("carries the talking flag through", () => {
    const roster = buildRoster(FREQ, [view(1, { isTalking: true })], describer({}), null);
    expect(roster[0]?.talking).toBe(true);
  });
});

describe("describeDistance", () => {
  test("says what a dispatcher would say", () => {
    expect(describeDistance(null)).toBe("position unknown");
    expect(describeDistance(80)).toBe("right there");
    expect(describeDistance(420)).toBe("400 m away");
    expect(describeDistance(2400)).toBe("2.4 km away");
  });
});
