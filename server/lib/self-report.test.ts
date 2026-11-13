import { describe, expect, test } from "bun:test";
import { recordedSelfReport, withoutOwnCallsign } from "./self-report";
import type { AiTool, AiTurnContext } from "./types";

const UNIT_STATUS: AiTool = {
  id: "unit_status",
  description: "the unit is telling you their status, availability or location code",
  input: "the status the unit just gave, in the words they used for it",
};

/** The other two the harness registers, so "three tools" is the real three. */
const RUN_PLATE: AiTool = {
  id: "run_plate",
  description: "the unit is asking you to run a plate, or has read one to you",
  input: "the plate only, in the letters and numbers the unit gave",
};
const ASSIGN_UNIT: AiTool = {
  id: "assign_unit",
  description: "send another unit to assist a unit who asked for one",
  input: "the callsign of the unit who needs help",
};
/** Five more to reach the eight of `probe-tool-generalisation.ts`. */
const INVENTED: AiTool[] = [
  { id: "request_tow", description: "a vehicle needs towing", input: "where and what" },
  { id: "request_fire", description: "fire or EMS is needed", input: "which service, and where" },
  { id: "request_cover", description: "the unit wants cover", input: "what they need cover for" },
  { id: "put_out_bolo", description: "circulate a description", input: "the description" },
  { id: "page_supervisor", description: "a supervisor is wanted", input: "why" },
];

const EIGHT: AiTool[] = [UNIT_STATUS, RUN_PLATE, ASSIGN_UNIT, ...INVENTED];

const SETS: [number, AiTool[]][] = [
  [1, [UNIT_STATUS]],
  [3, [UNIT_STATUS, RUN_PLATE, ASSIGN_UNIT]],
  [8, EIGHT],
];

function turn(transcript: string, over: Partial<AiTurnContext> = {}): AiTurnContext {
  return {
    trigger: "transmission",
    serverId: 1,
    callsign: "King 41",
    unitId: "K41",
    frequency: 460.125,
    channelName: "DISP",
    transcript,
    roster: [],
    history: [],
    waiting: [],
    channels: [],
    ...over,
  } as unknown as AiTurnContext;
}

const SAID = "King 41, traffic stop at Grove and Jefferson.";

describe("recordedSelfReport", () => {
  /**
   * BUG-72482, at the three list lengths the defect was measured across.
   *
   * The whole point of deciding this server-side is that list length cannot reach it,
   * so the assertion is the same answer three times. Measured before this existed,
   * `scripts/probe-self-report.ts`: this transmission reached `unit_status` 3 of 3 runs
   * at one tool and 0 of 8 at three or eight, with kind and `about` correct every time.
   */
  test.each(SETS)("records the status the model classified and skipped (%p tools)", (_n, tools) => {
    expect(
      recordedSelfReport(
        { actions: [], kind: "report", about: "traffic stop at Grove and Jefferson" },
        turn(SAID),
        tools,
      ),
    ).toEqual({ tool: "unit_status", input: "traffic stop at Grove and Jefferson" });
  });

  /**
   * The model labels its own traffic with its own callsign, which defeats grounding.
   *
   * Measured: "King 41, I'll be out with two at the Pink Cage." comes back
   * about="King 41 out with two at Pink Cage" and about="King 41 is out with two at the
   * Pink Cage" across runs. Neither is a contiguous quote — "I'll be" sits between the
   * callsign and the status — so both were refused and the status went unrecorded at
   * eight tools while the classification and the label were perfectly correct.
   */
  test.each(SETS)("strips the speaker's own callsign off the label (%p tools)", (_n, tools) => {
    const said = "King 41, I'll be out with two at the Pink Cage.";
    for (const about of [
      "King 41 out with two at Pink Cage",
      "King 41 is out with two at the Pink Cage",
      "K41, out with two at the Pink Cage",
    ]) {
      expect(
        recordedSelfReport({ actions: [], kind: "report", about }, turn(said), tools),
      ).not.toBeNull();
    }
  });

  test("only the speaker's own name, and only at the front", () => {
    // A label about somebody else keeps its callsign. `kind` already excludes that turn;
    // this is the second lock on the same door, and the one that would still hold if the
    // framing's vocabulary changed under it.
    expect(withoutOwnCallsign("King 22 still on that call", "King 41", "K41")).toBe(
      "King 22 still on that call",
    );
    expect(withoutOwnCallsign("out with King 41", "King 41", "K41")).toBe("out with King 41");
    // The discriminating one: a name in the MIDDLE with traffic after it. An
    // implementation that scanned ahead for the callsign instead of requiring it to lead
    // would return "at the station" here and the two assertions above would not notice.
    expect(withoutOwnCallsign("out with King 41 at the station", "King 41", "K41")).toBe(
      "out with King 41 at the station",
    );
    // And a label that is nothing BUT the callsign is left alone, so the empty-`about`
    // gate sees it rather than being handed "".
    expect(withoutOwnCallsign("King 41", "King 41", "K41")).toBe("King 41");
    // The remainder keeps its real spelling, because it becomes the status on the panel.
    expect(withoutOwnCallsign("King 41 — out at the Pink Cage", "King 41", "K41")).toBe(
      "out at the Pink Cage",
    );
  });

  test("never second-guesses a turn the model acted on", () => {
    // Including when it acted on a DIFFERENT tool. A turn the model understood well
    // enough to act on is not one to add a status to from the side.
    expect(
      recordedSelfReport(
        {
          actions: [{ tool: "run_plate", input: "6 Alpha Lima 749" }],
          kind: "report",
          about: "traffic stop at Grove and Jefferson",
        },
        turn(SAID),
        EIGHT,
      ),
    ).toBeNull();
  });

  /**
   * The over-reach controls — BUG-26294's direction — and they are the reason this is
   * gated on `kind` at all.
   *
   * Both are measured classifications, not guesses. "Dispatch, is King 22 still on that
   * call?" comes back kind="request" (and at eight tools it wrongly calls
   * `page_supervisor`, which is the other bug). "King 41, be advised there's a lot of
   * traffic on the bridge." comes back kind="call-up", about="" on 3 of 3 runs — which
   * matters, because its `about` WOULD pass grounding if it were ever filled in: "traffic
   * on the bridge" really is in that transmission. The `kind` gate is what keeps a road
   * condition out of a unit's status field, so if the framing's `kind` vocabulary changes,
   * re-measure this case first.
   */
  test.each(SETS)("a question is not a status (%p tools)", (_n, tools) => {
    expect(
      recordedSelfReport(
        { actions: [], kind: "request", about: "King 22 still on that call" },
        turn("Dispatch, is King 22 still on that call?"),
        tools,
      ),
    ).toBeNull();
  });

  test.each(SETS)("a road condition is not a status (%p tools)", (_n, tools) => {
    const said = "King 41, be advised there's a lot of traffic on the bridge.";
    // As measured: call-up, about empty.
    expect(
      recordedSelfReport({ actions: [], kind: "call-up", about: "" }, turn(said), tools),
    ).toBeNull();
    // And the shape that would be dangerous if the model ever labelled it a report —
    // held as its own assertion so the `kind` gate is the only thing standing between
    // them, visibly.
    expect(
      recordedSelfReport(
        { actions: [], kind: "report", about: "traffic on the bridge" },
        turn(said),
        tools,
      ),
    ).not.toBeNull();
  });

  test("an invented label never becomes roster data", () => {
    // The protection this leans on rather than works around. `about` is the model's own
    // text and is not trusted: it goes through the same gate `runTool` applies.
    expect(
      recordedSelfReport(
        { actions: [], kind: "report", about: "out at 5th and Rockford" },
        turn(SAID),
        [UNIT_STATUS],
      ),
    ).toBeNull();
  });

  test("a placeholder is not a status", () => {
    expect(
      recordedSelfReport({ actions: [], kind: "report", about: "status" }, turn(SAID), [
        UNIT_STATUS,
      ]),
    ).toBeNull();
  });

  test("an empty label records nothing", () => {
    expect(
      recordedSelfReport({ actions: [], kind: "report", about: "" }, turn(SAID), [UNIT_STATUS]),
    ).toBeNull();
    expect(
      recordedSelfReport({ actions: [], kind: "report" }, turn(SAID), [UNIT_STATUS]),
    ).toBeNull();
  });

  test("a missing kind decides nothing", () => {
    // A provider that answers without one is still a provider; it just does not get this.
    expect(
      recordedSelfReport(
        { actions: [], about: "traffic stop at Grove and Jefferson" },
        turn(SAID),
        [UNIT_STATUS],
      ),
    ).toBeNull();
  });

  test("does nothing when the server registered no status tool", () => {
    // An operator can register anything or nothing, and `unit_status` is only present
    // because `sv_ai_dispatch.lua` ships it. Nothing here invents a tool.
    expect(
      recordedSelfReport(
        { actions: [], kind: "report", about: "traffic stop at Grove and Jefferson" },
        turn(SAID),
        [RUN_PLATE, ASSIGN_UNIT],
      ),
    ).toBeNull();
  });

  /**
   * ⚠ This pair passes with the `trigger` check in `recordedSelfReport` deleted, and
   * that is recorded rather than hidden.
   *
   * `argumentRefusal` already refuses a quote-declared input on any trigger but
   * `transmission`, and `unit_status` is quote-declared unconditionally — so the
   * explicit check is belt and braces, not the gate. It is kept because it states the
   * invariant where a reader is looking, and because the id gate above it is the kind of
   * thing that gets widened; but do not read these two assertions as covering that line.
   * Measured: mutating it away fails nothing. Every other gate's mutation does fail —
   * removing the whole function fails 6, the `kind` gate 4, the grounding gate 2 and the
   * already-acted gate 1.
   */
  test.each([["call_intake"], ["call"]])("does nothing on a %s turn", (trigger) => {
    // No unit on the other end to have a status, and nothing transmitted to ground it in.
    expect(
      recordedSelfReport(
        { actions: [], kind: "report", about: "traffic stop at Grove and Jefferson" },
        turn(SAID, { trigger } as Partial<AiTurnContext>),
        [UNIT_STATUS],
      ),
    ).toBeNull();
  });
});
