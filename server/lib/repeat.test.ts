import { describe, expect, test } from "bun:test";
import { saysTheSameThing } from "./repeat";

/**
 * The four pairs in the first group are real: the acknowledgement is what the
 * streamed decision produced and the follow-up is what `compose` wrote against
 * the tool's outcome, captured by `scripts/probe-turn-latency.ts` on
 * 2026-09-19. They are the reason this module exists and the reason the
 * threshold is where it is.
 */
describe("measured acknowledgement / rewrite pairs", () => {
  test("a rewrite that only renames the unit is a repeat", () => {
    expect(
      saysTheSameThing(
        "King 41, copy, second unit requested.",
        "K41, second unit requested acknowledged.",
      ),
    ).toBe(true);
  });

  test("a rewrite that restates the status is a repeat", () => {
    expect(
      saysTheSameThing("King 41, copy, back in service.", "K41, status is now back in service."),
    ).toBe(true);
  });

  test("the unit's own callsign, spelled either way, is not new information", () => {
    expect(saysTheSameThing("King 41, copy, back in service.", "K41, back in service.")).toBe(true);
  });

  test("a rewrite that names a different place does air", () => {
    expect(
      saysTheSameThing(
        "King 41, copy, out at the corner of Grove and Jefferson.",
        "King 41, show me out at the station.",
      ),
    ).toBe(false);
  });
});

describe("information the unit actually asked for", () => {
  test("a plate coming back airs", () => {
    expect(
      saysTheSameThing("King 41, copy, stand by.", "King 41, plate returns a 2019 Ford, no wants."),
    ).toBe(false);
  });

  test("a failure airs even when it shares most of its words", () => {
    expect(
      saysTheSameThing(
        "King 41, copy, back in service.",
        "King 41, negative, unable to show you in service.",
      ),
    ).toBe(false);
  });

  test("another unit's callsign is new information", () => {
    expect(
      saysTheSameThing("King 41, copy, second unit requested.", "King 41, King 22 is en route."),
    ).toBe(false);
  });

  test("a time is new information even among familiar words", () => {
    expect(
      saysTheSameThing("King 41, copy, back in service.", "King 41, in service at 14:32."),
    ).toBe(false);
  });
});

describe("degenerate input", () => {
  test("an empty follow-up is a repeat, so nothing is aired", () => {
    expect(saysTheSameThing("King 41, copy.", "")).toBe(true);
  });

  test("a follow-up of nothing but procedure is a repeat", () => {
    expect(saysTheSameThing("King 41, copy, back in service.", "Copy that, roger.")).toBe(true);
  });

  test("an empty acknowledgement makes any real follow-up new", () => {
    expect(saysTheSameThing("", "King 41, back in service.")).toBe(false);
  });

  test("the identical sentence is a repeat", () => {
    const line = "King 41, copy, out with a vehicle. Two occupants.";
    expect(saysTheSameThing(line, line)).toBe(true);
  });

  test("punctuation and case do not make a line new", () => {
    expect(saysTheSameThing("King 41, copy, back in service.", "king 41 -- BACK IN SERVICE!")).toBe(
      true,
    );
  });

  test("a ten-code survives being de-hyphenated on the way to the voice", () => {
    expect(saysTheSameThing("King 41, show 10-8.", "King 41, showing 10 8.")).toBe(true);
  });
});

/**
 * The pair that sits closest to the threshold, kept as a test so that moving
 * `REPEAT_RATIO` has to be a decision rather than an accident. This one scores
 * 0.60 against a 0.667 line — it airs, and it airs on the strength of the single
 * word "updated".
 */
test("a confirmation one word away from the threshold airs", () => {
  expect(
    saysTheSameThing("King 41, copy, back in service.", "K41, status updated to back in service."),
  ).toBe(false);
});
