/**
 * The answered-call registry, and the things that read it.
 *
 * Small enough to look trivial, and it is not: every one of these assertions is
 * a thing that goes wrong silently. A frequency that stays registered after the
 * call ends is a dispatcher that will never answer another one. A frequency that
 * is *not* registered while the call is live is a caller whose voice is dropped
 * before it reaches a turn, and a console the sweep signs off mid-sentence.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { Call911 } from "./tradio-hooks";
import {
  answeredById,
  answeredCalls,
  answeredCount,
  answeredOn,
  forgetCall,
  isAnsweredCall,
  markClosing,
  noteAnswered,
  noteSummary,
  resetCalls,
} from "./calls";
import type { AiCallInfo } from "./types";

function call(id: string, frequency: number): Call911 {
  return {
    id,
    callerServerId: 7,
    callerName: "Alex Vance",
    message: "someone is breaking into the store",
    coords: { x: 100, y: -200, z: 30 },
    frequency,
  };
}

const info: AiCallInfo = {
  id: "call911_a",
  source: "911",
  caller: "Alex Vance",
  message: "someone is breaking into the store",
  location: "Strawberry Avenue",
  priority: "",
  service: "",
};

describe("the answered-call registry", () => {
  beforeEach(() => {
    resetCalls();
  });

  test("a call is findable by its frequency and by its id", () => {
    noteAnswered(call("call911_a", -900001), info);

    expect(isAnsweredCall(-900001)).toBe(true);
    expect(answeredOn(-900001)?.callId).toBe("call911_a");
    expect(answeredById("call911_a")?.frequency).toBe(-900001);
    expect(answeredCount()).toBe(1);
  });

  test("a frequency with no call on it is not a call", () => {
    noteAnswered(call("call911_a", -900001), info);

    // The frequency either side, and a perfectly ordinary radio channel. This is
    // the check that keeps `monitored` from admitting traffic it should not.
    expect(isAnsweredCall(-900000)).toBe(false);
    expect(isAnsweredCall(-900002)).toBe(false);
    expect(isAnsweredCall(460.125)).toBe(false);
    expect(answeredOn(460.125)).toBeNull();
  });

  test("forgetting a call clears both indexes and hands the entry back", () => {
    noteAnswered(call("call911_a", -900001), info);
    const entry = forgetCall("call911_a");

    // Returned rather than dropped, because the radio announcement that follows
    // the call is built from it and the queue has already deleted the record.
    expect(entry?.callId).toBe("call911_a");
    expect(entry?.coords).toEqual({ x: 100, y: -200, z: 30 });
    expect(isAnsweredCall(-900001)).toBe(false);
    expect(answeredById("call911_a")).toBeNull();
    expect(answeredCount()).toBe(0);
  });

  test("forgetting a call that was never answered is not an error", () => {
    expect(forgetCall("call911_nope")).toBeNull();
  });

  test("the summary replaces what the caller typed, and only when it has one", () => {
    noteAnswered(call("call911_a", -900001), info);
    expect(answeredOn(-900001)?.summary).toBe("");

    noteSummary("call911_a", "  burglary in progress  ");
    expect(answeredOn(-900001)?.summary).toBe("burglary in progress");

    // The original is left alone, so a call that ends before `hang_up` still has
    // something to announce.
    expect(answeredOn(-900001)?.info.message).toBe("someone is breaking into the store");
  });

  test("closing is a flag, not an ending", () => {
    noteAnswered(call("call911_a", -900001), info);

    expect(answeredOn(-900001)?.closing).toBe(false);
    expect(markClosing("call911_a")).toBe(true);
    expect(answeredOn(-900001)?.closing).toBe(true);
    // Still registered: the line stays up until the closing words have aired,
    // which is the whole reason this is a flag and not a hangup.
    expect(isAnsweredCall(-900001)).toBe(true);
  });

  test("closing a call that already ended is refused rather than ignored", () => {
    // The model calling `hang_up` on a line the caller already dropped. A silent
    // no-op would have it told the call ended successfully.
    expect(markClosing("call911_gone")).toBe(false);
  });

  test("two calls do not see each other", () => {
    noteAnswered(call("call911_a", -900001), info);
    noteAnswered(call("call911_b", -900002), { ...info, id: "call911_b" });

    expect(answeredCount()).toBe(2);
    expect(
      answeredCalls()
        .map((entry) => entry.callId)
        .sort()
    ).toEqual(["call911_a", "call911_b"]);

    forgetCall("call911_a");
    expect(isAnsweredCall(-900002)).toBe(true);
    expect(answeredCount()).toBe(1);
  });

  test("resetting drops everything", () => {
    noteAnswered(call("call911_a", -900001), info);
    resetCalls();

    expect(answeredCount()).toBe(0);
    expect(isAnsweredCall(-900001)).toBe(false);
  });
});
