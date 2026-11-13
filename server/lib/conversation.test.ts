import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  clearExpectation,
  clearWaiting,
  expectReplyFrom,
  forgetChannel,
  history,
  isExpected,
  noteWaiting,
  recordHeard,
  recordSaid,
  resetConversations,
  setConversationClock,
  WAITING_TTL_MS,
  waiting,
} from "./conversation";

const FREQ = 155.475;

let now = 1_000_000;

beforeEach(() => {
  resetConversations();
  now = 1_000_000;
  setConversationClock(() => now);
});

// The suite shares one process, and a stuck clock would follow this module into
// every other file that imports it.
afterAll(() => resetConversations());

describe("history", () => {
  test("keeps both sides of an exchange, oldest first", () => {
    recordHeard(FREQ, "K31", "K31 to dispatch");
    recordSaid(FREQ, "Dispatch", "Go K31");
    recordHeard(FREQ, "K31", "traffic stop, two occupants");

    expect(history(FREQ).map((entry) => entry.text)).toEqual([
      "K31 to dispatch",
      "Go K31",
      "traffic stop, two occupants",
    ]);
    expect(history(FREQ)[1]?.own).toBe(true);
  });

  test("caps what it remembers", () => {
    for (let i = 0; i < 40; i++) recordHeard(FREQ, "K31", `line ${i}`);
    const kept = history(FREQ);
    expect(kept.length).toBe(12);
    expect(kept[kept.length - 1]?.text).toBe("line 39");
  });

  test("forgets a conversation that ended minutes ago", () => {
    recordHeard(FREQ, "K31", "old traffic");
    now += 6 * 60_000;
    expect(history(FREQ)).toEqual([]);
  });

  test("hands back a copy, so recording during a turn cannot rewrite it", () => {
    recordHeard(FREQ, "K31", "first");
    const snapshot = history(FREQ);
    recordHeard(FREQ, "K31", "second");
    expect(snapshot.map((entry) => entry.text)).toEqual(["first"]);
  });

  test("keeps channels apart", () => {
    recordHeard(FREQ, "K31", "on one");
    recordHeard(460.125, "K32", "on the other");
    expect(history(FREQ).length).toBe(1);
    forgetChannel(FREQ);
    expect(history(FREQ)).toEqual([]);
    expect(history(460.125).length).toBe(1);
  });
});

describe("expectations", () => {
  test("a unit just spoken to is expected back", () => {
    expectReplyFrom(FREQ, 7);
    expect(isExpected(FREQ, 7)).toBe(true);
    expect(isExpected(FREQ, 8)).toBe(false);
    expect(isExpected(460.125, 7)).toBe(false);
  });

  test("stops expecting once they have gone back to their own business", () => {
    expectReplyFrom(FREQ, 7);
    now += 30_000;
    expect(isExpected(FREQ, 7)).toBe(false);
  });

  test("clears on demand", () => {
    expectReplyFrom(FREQ, 7);
    clearExpectation(FREQ);
    expect(isExpected(FREQ, 7)).toBe(false);
  });

  test("ignores synthetic talkers", () => {
    expectReplyFrom(FREQ, -900000);
    expect(isExpected(FREQ, -900000)).toBe(false);
  });
});

describe("waiting", () => {
  test("answers in the order they called, and calling twice does not cost a place", () => {
    noteWaiting(FREQ, 7, "K31");
    noteWaiting(FREQ, 8, "K32");
    noteWaiting(FREQ, 7, "K31");
    expect(waiting(FREQ)).toEqual(["K31", "K32"]);

    clearWaiting(FREQ, 7);
    expect(waiting(FREQ)).toEqual(["K32"]);
  });

  test("names a unit with no callsign by their id", () => {
    noteWaiting(FREQ, 42, "");
    expect(waiting(FREQ)).toEqual(["unit 42"]);
  });

  test("forgets a unit who has been waiting too long", () => {
    // A unit can be recorded as waiting without its transmission being queued
    // (the queue-full drop path), and a dropped one has no turn coming to clear
    // it. Without this the model would be told to answer them on every future
    // turn, forever.
    noteWaiting(FREQ, 7, "K31");
    now += WAITING_TTL_MS + 1;
    expect(waiting(FREQ)).toEqual([]);
  });

  test("keeps one who called a moment ago", () => {
    // The discriminating case: an expiry that fired immediately would satisfy the
    // test above while throwing away every unit that is genuinely waiting.
    noteWaiting(FREQ, 7, "K31");
    now += WAITING_TTL_MS - 1;
    expect(waiting(FREQ)).toEqual(["K31"]);
  });

  test("keying up again brings a forgotten unit back", () => {
    noteWaiting(FREQ, 7, "K31");
    now += WAITING_TTL_MS + 1;
    expect(waiting(FREQ)).toEqual([]);
    noteWaiting(FREQ, 7, "K31");
    expect(waiting(FREQ)).toEqual(["K31"]);
  });
});
