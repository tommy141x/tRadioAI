/**
 * The spend controls.
 *
 * Every limit is injected, so these run without a config and without a provider. Time is
 * passed in too rather than slept through — a rolling-window test built on real sleeps is
 * the kind that passes on a fast box and fails in CI.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  budgetState,
  hostedAllowed,
  noteHostedCall,
  noteTurn,
  resetBudget,
  turnAllowed,
} from "./budget";

beforeEach(() => {
  resetBudget();
});

describe("hosted ceiling", () => {
  test("0 means no ceiling, and does not count", () => {
    const now = 1_000_000;
    for (let i = 0; i < 500; i++) expect(hostedAllowed(0, now)).toBe(true);
    // The control for the test below: if the off switch still recorded, the state would
    // show 500 here and the "rolls" test could pass for the wrong reason.
    expect(budgetState(0, 0, now).hostedPerMinute).toBe(0);
  });

  test("allows up to the ceiling and then sheds to local", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(hostedAllowed(3, now)).toBe(true);
      noteHostedCall("text", now);
    }
    expect(hostedAllowed(3, now)).toBe(false);
    const state = budgetState(3, 0, now);
    expect(state.hostedPerMinute).toBe(3);
    expect(state.shed).toBe(1);
  });

  test("counts every capability, not just text", () => {
    const now = 1_000_000;
    noteHostedCall("transcription", now);
    noteHostedCall("text", now);
    noteHostedCall("speech", now);
    // One turn spends all three. A per-turn cap would read this as 1.
    expect(budgetState(0, 0, now).hostedPerMinute).toBe(3);
    expect(hostedAllowed(3, now)).toBe(false);
  });

  /**
   * The reason the window is a timestamp list and not a counter reset on the minute.
   *
   * A fixed window lets through twice the ceiling across a boundary — the last instant
   * of one minute plus the first of the next — which is the burst a ceiling exists to
   * stop. Asserted directly: 59.9 s after filling the window we are still refused.
   */
  test("rolls continuously rather than resetting on a boundary", () => {
    const start = 1_000_000;
    for (let i = 0; i < 2; i++) noteHostedCall("text", start);
    expect(hostedAllowed(2, start + 59_900)).toBe(false);
    // One tick past the window the oldest two have aged out.
    expect(hostedAllowed(2, start + 60_001)).toBe(true);
  });
});

describe("per-unit turn cooldown", () => {
  test("0 disables it", () => {
    noteTurn(7, 1000);
    expect(turnAllowed(7, 0, 1000)).toBe(true);
  });

  test("refuses a second turn inside the gap and allows it after", () => {
    noteTurn(7, 1000);
    expect(turnAllowed(7, 3000, 1500)).toBe(false);
    expect(turnAllowed(7, 3000, 4000)).toBe(true);
  });

  test("rate-limits one unit without touching anybody else", () => {
    noteTurn(7, 1000);
    // The control: a cooldown that applied to the channel rather than the talker would
    // refuse unit 8 here, which is the failure this design exists to avoid.
    expect(turnAllowed(8, 3000, 1500)).toBe(true);
  });

  test("a call-driven turn has no talker to limit", () => {
    noteTurn(0, 1000);
    expect(turnAllowed(0, 3000, 1000)).toBe(true);
    expect(turnAllowed(-1, 3000, 1000)).toBe(true);
  });

  test("an expired entry is dropped, so the map tracks only units still cooling", () => {
    noteTurn(7, 1000);
    expect(budgetState(0, 3000, 1500).cooling).toBe(1);
    // Asking after the gap evicts it; nothing else prunes, so this is the only thing
    // keeping the map from growing by every unit ever seen.
    expect(turnAllowed(7, 3000, 5000)).toBe(true);
    expect(budgetState(0, 3000, 5000).cooling).toBe(0);
  });
});

describe("resetBudget", () => {
  test("clears both controls and the shed count", () => {
    noteHostedCall("text", 1000);
    noteTurn(7, 1000);
    hostedAllowed(1, 1000);
    resetBudget();
    const state = budgetState(1, 3000, 1000);
    expect(state.hostedPerMinute).toBe(0);
    expect(state.shed).toBe(0);
    expect(state.cooling).toBe(0);
    expect(turnAllowed(7, 3000, 1000)).toBe(true);
  });
});
