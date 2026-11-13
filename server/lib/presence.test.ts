import { describe, expect, test } from "bun:test";
import { type HumanDispatcher, humanDispatcherOn, humanDispatcherPresent } from "./presence";

const human = (serverId: number, selected: number | null, listening: number[] = []): HumanDispatcher => ({
  serverId,
  selected,
  listening,
});

describe("humanDispatcherOn", () => {
  test("counts a dispatcher with the channel selected", () => {
    expect(humanDispatcherOn(155.475, [human(-1001, 155.475)])).toBe(true);
  });

  test("counts a dispatcher merely listening to the channel", () => {
    expect(humanDispatcherOn(155.475, [human(-1001, 460.125, [155.475])])).toBe(true);
  });

  test("is false on a channel nobody covers", () => {
    expect(humanDispatcherOn(155.475, [human(-1001, 460.125, [460.125])])).toBe(false);
  });

  test("is false with nobody signed on", () => {
    expect(humanDispatcherOn(155.475, [])).toBe(false);
  });
});

/**
 * The gate on `shouldAnswerCalls`, which decides whether the AI may take a 911 call.
 * Presence is anywhere, not per channel.
 */
describe("humanDispatcherPresent", () => {
  test("nobody signed on means the dispatcher may answer", () => {
    expect(humanDispatcherPresent([])).toBe(false);
  });

  test("one human signed on anywhere stands the dispatcher down", () => {
    expect(humanDispatcherPresent([human(-1001, null)])).toBe(true);
  });
});
