import { expect, test } from "bun:test";
import { outcomeReadback } from "./outcome-reply";

test("reads the confirmed status result without a second model pass", () => {
  expect(
    outcomeReadback([
      { tool: "unit_status", input: "10-8", ok: true, message: "Tommy is now showing 10-8" },
    ]),
  ).toBe("Tommy is now showing 10-8");
});

test("covers every tool, not only unit_status — that is the point of it", () => {
  // The old version matched `unit_status` alone, so a patch, an alert and a tone
  // each paid a model call to rephrase a sentence that was already correct.
  expect(
    outcomeReadback(
      [
        {
          tool: "patch_channels",
          input: "DISP OPS2",
          ok: true,
          message: "DISP and OPS2 are patched together",
        },
      ],
      "King 41",
    ),
  ).toBe("King 41, DISP and OPS2 are patched together");
});

test("puts the callsign first, which is the transmission rule", () => {
  expect(
    outcomeReadback(
      [{ tool: "channel_tone", input: "alert", ok: true, message: "the tone went out" }],
      "King 22",
    ),
  ).toBe("King 22, the tone went out");
});

test("does not say the callsign twice when the tool already named them", () => {
  // The shipped unit_status readback is "<callsign> is now showing <status>".
  expect(
    outcomeReadback(
      [{ tool: "unit_status", input: "10-8", ok: true, message: "King 22 is now showing 10-8" }],
      "King 22",
    ),
  ).toBe("King 22 is now showing 10-8");
  // And recognises the short spelling, since a tool may use either.
  expect(
    outcomeReadback(
      [{ tool: "unit_status", input: "10-8", ok: true, message: "K22 is now showing 10-8" }],
      "King 22",
    ),
  ).toBe("K22 is now showing 10-8");
});

test("never airs hang_up's success message, which is an instruction not a line", () => {
  // "the call ends as soon as you finish speaking — tell them help is being sent"
  // is addressed to the model. index.ts filters it; this is the second lock.
  expect(
    outcomeReadback(
      [
        {
          tool: "hang_up",
          input: "",
          ok: true,
          message: "the call ends as soon as you finish speaking",
        },
      ],
      "Alex",
    ),
  ).toBeNull();
});

test("hands a two-tool turn back to the model rather than guessing an order", () => {
  expect(
    outcomeReadback(
      [
        { tool: "patch_channels", input: "a b", ok: true, message: "patched" },
        { tool: "channel_alert", input: "pursuit", ok: true, message: "pursuit is in effect" },
      ],
      "King 41",
    ),
  ).toBeNull();
});

test("a failure is never a readback", () => {
  // Failures go to index.ts's fixed negative, so this must not answer for them.
  expect(
    outcomeReadback(
      [{ tool: "unit_status", input: "x", ok: false, message: "no such status" }],
      "King 41",
    ),
  ).toBeNull();
});
