import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  argumentRefusal,
  describeTools,
  groundedIn,
  isLiftedExample,
  isPlaceholderValue,
  resolveSelfReference,
  resolveTool,
  runTool,
} from "./tools";
import { resetCad } from "./cad";
import { aiLog } from "./logger";
import { resetHooks } from "./tradio-hooks";
import type { AiTool, AiTurnContext } from "./types";

const globals = globalThis as unknown as Record<string, unknown>;
const saved = new Map<string, unknown>();

const RESOURCE = "tRadioAI";

const context: AiTurnContext = {
  trigger: "transmission",
  serverId: 7,
  callsign: "1-ADAM-12",
  unitId: "A12",
  frequency: 155.475,
  channelName: "DISPATCH",
  transcript: "dispatch i'll be 10-8",
  roster: [],
  history: [],
  waiting: [],
  channels: [],
};

let luaTools: unknown = [];
let luaRun: (...args: unknown[]) => unknown = () => true;
let runCalls: unknown[][] = [];

beforeEach(() => {
  /*
   * Start every case with NO CAD, because `describeTools` offers CAD built-ins the
   * moment one looks present and most assertions here are exact tool-id lists.
   *
   * Both calls are needed and neither is tidiness. `activeCad()` memoises its
   * answer for a second, so a CAD another FILE brought up is still "present"
   * here — the suite shares one process, and bun gives no ordering guarantee. That
   * is exactly what happened on 2026-10-14: five cases failed with run_plate,
   * create_call, clear_unit and cad_status prepended to the expected list, while the
   * file passed on its own. A test that only passes when it runs first is not
   * measuring what it says.
   */
  resetCad();
  resetHooks();
  luaTools = [];
  luaRun = () => true;
  runCalls = [];
  for (const [name, value] of Object.entries({
    GetCurrentResourceName: (): string => RESOURCE,
    exports: {
      [RESOURCE]: {
        getTools: () => luaTools,
        runTool: (...args: unknown[]) => {
          runCalls.push(args);
          return luaRun(...args);
        },
      },
    },
  })) {
    if (!saved.has(name)) saved.set(name, globals[name]);
    globals[name] = value;
  }
});

// The suite shares one process and one globalThis.
afterAll(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete globals[name];
    else globals[name] = value;
  }
});

function tool(id: string, input = "a value"): AiTool {
  return { id, description: `the ${id} case`, input };
}

describe("status grounding", () => {
  test.each([
    ["Dispatch, what's your 20?", "right there"],
    ["Control.", "showing right there"],
    ["Priority priority. I got a vehicle taken off. Eastbound Route 68.", "showing right there"],
  ])("rejects invented status for %s before calling Lua", async (transcript, input) => {
    const result = await runTool(tool("unit_status"), input, { ...context, transcript });
    expect(result.ok).toBe(false);
    expect(runCalls).toHaveLength(0);
  });

  test("allows the actual status without imposing a ten-code dictionary", async () => {
    expect(
      (
        await runTool(tool("unit_status"), "at lunch", {
          ...context,
          transcript: "Dispatch, show me at lunch.",
        })
      ).ok,
    ).toBe(true);
    expect(runCalls).toHaveLength(1);
  });
});

describe("describeTools", () => {
  test("passes the turn context to Lua and keeps declaration order", () => {
    luaTools = [tool("unit_status"), tool("tow_request")];
    expect(describeTools(context).map((t) => t.id)).toEqual(["unit_status", "tow_request"]);
  });

  test("accepts a non-sequential Lua table", () => {
    luaTools = { a: tool("unit_status") };
    expect(describeTools(context).map((t) => t.id)).toEqual(["unit_status"]);
  });

  test("skips entries with no id or description, and duplicates", () => {
    luaTools = [
      { description: "no id" },
      { id: "no_description" },
      tool("unit_status"),
      tool("unit_status"),
      "not a tool",
    ];
    expect(describeTools(context).map((t) => t.id)).toEqual(["unit_status"]);
  });

  test("a missing input description means the tool takes no argument", () => {
    luaTools = [{ id: "roll_call", description: "the unit asked who is on the air" }];
    expect(describeTools(context)[0]!.input).toBe("");
  });

  test("is empty when the export is missing entirely", () => {
    (globals.exports as Record<string, unknown>)[RESOURCE] = {};
    expect(describeTools(context)).toEqual([]);
  });
});

describe("an operator's tool with a built-in's id", () => {
  const ids = () => describeTools(context).map((t) => t.id);

  test("cannot take hang_up while the built-in is hidden off a call", () => {
    luaTools = [
      { id: "hang_up", description: "x" },
      { id: "tow_request", description: "a unit needs a tow" },
    ];
    expect(ids()).toContain("tow_request");
    expect(ids()).not.toContain("hang_up");
  });

  test("cannot take channel_tone while tRadio reports no tones", () => {
    luaTools = [{ id: "channel_tone", description: "x" }];
    expect(ids()).not.toContain("channel_tone");
  });

  test("is still offered, in the operator's words, for a built-in that yields to Lua", () => {
    luaTools = [{ id: "run_plate", description: "the operator's own plate lookup" }];
    const offered = describeTools(context).find((t) => t.id === "run_plate");
    expect(offered?.description).toBe("the operator's own plate lookup");
  });

  test("is warned about once, however many turns rebuild the list", () => {
    const warn = spyOn(aiLog, "warn").mockImplementation(() => {});
    try {
      luaTools = [{ id: "unpatch_channels", description: "x" }];
      describeTools(context);
      describeTools(context);
      const reserved = warn.mock.calls.filter((call) =>
        String(call[0]).includes("built-in tool's id"),
      );
      expect(reserved).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("resolveTool", () => {
  const tools = [tool("unit_status"), tool("tow_request")];

  test("matches a declared name, case-insensitively", () => {
    expect(resolveTool("Unit_Status", tools)?.id).toBe("unit_status");
  });

  test("refuses a name the model invented rather than guessing at the nearest", () => {
    expect(resolveTool("unit_statuses", tools)).toBeNull();
    expect(resolveTool("", tools)).toBeNull();
  });
});

describe("runTool", () => {
  test("hands the tool its trimmed input", async () => {
    await runTool(tool("unit_status"), "  10-8  ", context);
    expect(runCalls[0]).toEqual(["unit_status", "10-8", context]);
  });

  test("reads a table result, including a rejection with a reason", async () => {
    luaRun = () => ({ ok: false, message: "that plate is not in the system" });
    expect(await runTool(tool("plate_check"), "3ABC123", context)).toEqual({
      ok: false,
      message: "that plate is not in the system",
    });
  });

  /**
   * The two kinds of `ok: false` have to be distinguishable, because the unit hears a
   * different thing for each: the world refusing is "negative", our own failure to
   * extract a value is "go ahead". See `ToolResult.fault` and BUG-69515.
   */
  test("an argument fault is marked as ours", async () => {
    // The placeholder BUG-69515 actually produced: the request's own subject.
    const result = await runTool(tool("plate_check"), "a plate", context);
    expect(result.ok).toBe(false);
    expect(result.fault).toBe("argument");
  });

  test("a failure from the tool itself is NOT marked as ours", async () => {
    // The control for the test above. Both are `ok: false`; only one is our fault, and
    // a `fault` set unconditionally would make the turn say "go ahead" to a real
    // refusal — telling a unit to repeat itself when the answer was genuinely no.
    luaRun = () => ({ ok: false, message: "that plate is not in the system" });
    const result = await runTool(tool("plate_check"), "3ABC123", context);
    expect(result.ok).toBe(false);
    expect(result.fault).toBeUndefined();
  });

  test("treats a bare true as success", async () => {
    luaRun = () => true;
    expect(await runTool(tool("unit_status"), "10-8", context)).toEqual({
      ok: true,
      message: "done",
    });
  });

  test("a tool that threw or does not exist is a failure, not a crash", async () => {
    luaRun = () => {
      throw new Error("boom");
    };
    expect((await runTool(tool("unit_status"), "10-8", context)).ok).toBe(false);
  });

  test("caps a runaway input", async () => {
    await runTool(tool("note"), "x".repeat(500), context);
    expect((runCalls[0]![1] as string).length).toBe(160);
  });
});

describe("an argument copied out of a tool's own description", () => {
  const tool = {
    id: "unit_status",
    description: "the unit is telling you their status",
    input: "the status the unit gave, such as 10-8, 10-97 or out at lunch",
  };

  test("is refused when nobody said it", () => {
    expect(isLiftedExample(tool, "out at lunch", "Hello dispatch!")).toBe(true);
  });

  test("is allowed when the unit actually said it", () => {
    expect(isLiftedExample(tool, "out at lunch", "Dispatch, K31, show me out at lunch")).toBe(
      false,
    );
  });

  test("never blocks a bare code, whatever the description mentions", () => {
    // "10-8" is in that description too, and a unit going 10-8 having only said
    // "show me in service" is the model doing its job, not copying.
    expect(isLiftedExample(tool, "10-8", "K31 show me in service")).toBe(false);
  });

  test("leaves a value that came from the traffic alone", () => {
    expect(isLiftedExample(tool, "out at the courthouse", "K31 out at the courthouse")).toBe(false);
    expect(isLiftedExample(tool, "en route", "K31 show me en route")).toBe(false);
  });
});

describe("grounding a status in what the unit actually said", () => {
  // The four near-misses measured on one harness run, each a real status the unit
  // had given, refused over a filler word and aired back to them as a negative.
  test("forgives leading filler the model adds", () => {
    expect(groundedIn("Dispatch, King 41. Show Me 10-8.", "showing 10-8")).toBe(true);
    expect(groundedIn("priority traffic, shots fired on Route 68", "showing shots fired")).toBe(
      true,
    );
    // "unit" strips to "running on foot", which the unit did say, so this is a
    // genuine status and passing is correct. I asserted false here first and the
    // test caught me: the filler list makes this one legal.
    expect(groundedIn("I've got one running on foot", "unit running on foot")).toBe(true);
  });

  test("forgives an article on either side", () => {
    expect(groundedIn("can I get a 10-28 on a plate", "10-28 on plate")).toBe(true);
    expect(groundedIn("show me out at Vespucci station", "out at the Vespucci station")).toBe(true);
  });

  test("still refuses a status the unit never gave", () => {
    // The whole reason the guard exists: an invented status feeds back through the
    // roster on every later turn. Filler is forgiven; content never is.
    expect(groundedIn("Dispatch, King 41, I'm at the station", "showing 10-8")).toBe(false);
    expect(groundedIn("suspect in a red hoodie", "in custody")).toBe(false);
    expect(groundedIn("show me out at Grove and Jefferson", "out at Elgin and Vespucci")).toBe(
      false,
    );
  });

  test("refuses words that are in the transmission but not together", () => {
    // Order and adjacency still hold, so a status cannot be assembled out of
    // scattered words the unit happened to use.
    expect(groundedIn("I'm out at the station and the suspect is in custody", "station in")).toBe(
      false,
    );
  });

  test("refuses filler on its own", () => {
    expect(groundedIn("Dispatch, King 41", "showing")).toBe(false);
    expect(groundedIn("Dispatch, King 41", "")).toBe(false);
  });
});

describe("which tools have their input held to what the unit said", () => {
  const spoken = "41, plate is 4 5 Charlie Mike Tango 9";
  const turn = (transcript: string): AiTurnContext =>
    ({ ...context, trigger: "transmission", transcript }) as AiTurnContext;

  /** A tool that declares its value is a quote, the way the shipped one does. */
  const plateTool: AiTool = {
    id: "run_plate",
    description: "the unit is asking you to run a plate",
    input: "the plate, in the letters and numbers the unit gave",
    run: async () => ({ ok: true, message: "returns to a 2017 Nissan Frontier, no wants" }),
  } as unknown as AiTool;

  /**
   * The fixture has to ADVERTISE the tool, not just be able to run it.
   *
   * `run_plate` is also the id of the ImperialCAD built-in, and built-ins are
   * resolved before Lua. That one yields to an operator who registered the same id
   * — but it can only know to yield by asking `getTools`, so a fixture
   * that stubs `runTool` alone claims a tool it never offered and gets
   * the built-in instead. Setting both is simply what a real registry looks like,
   * and it means these cases now exercise the yield as well as the grounding.
   */
  beforeEach(() => {
    luaTools = [{ id: plateTool.id, description: plateTool.description, input: plateTool.input }];
  });

  /**
   * A tool whose value is tRadio's to choose, so there is nothing to match against.
   *
   * Deliberately NOT a builtin id: `call_another_channel` would reach the real builtin,
   * which resolves the channel against `context.channels` and fails on an empty fixture
   * for reasons that have nothing to do with grounding. A Lua-style id isolates the
   * decision under test.
   */
  const assignTool: AiTool = {
    id: "assign_unit",
    description: "the unit is asking for another unit",
    input: "which unit to send, and what to",
  } as unknown as AiTool;

  test("a declared quote is refused when the unit never said it", async () => {
    // Measured: with run_plate registered, the dispatcher ran it on "Grove and
    // Jefferson" — a street from two transmissions earlier — and aired a vehicle
    // return for it. An invented status is untidy; an invented plate return sends a
    // unit after a car that does not exist.
    const result = await runTool(plateTool, "Grove and Jefferson", turn(spoken));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("did not say that");
  });

  test("a declared quote is allowed when the unit did say it", async () => {
    // Asserting on `ok` alone: `runTool` dispatches to the Lua side, so a stub's own
    // `run` is never called and the message here is the default. What this code decides
    // is whether the input was grounded, which is exactly what `ok` reports.
    const result = await runTool(plateTool, "4 5 Charlie Mike Tango 9", turn(spoken));
    expect(result.ok).toBe(true);
  });

  test("a tool whose value is not a quote is NOT grounded", async () => {
    // The discriminating case. Grounding everything would refuse a channel name or a
    // unit off the roster, neither of which appears in the transmission — and the
    // dispatcher would lose the ability to relay or to send anybody.
    const result = await runTool(assignTool, "King 22 to the traffic stop", turn(spoken));
    expect(result.ok).toBe(true);
    expect(result.message).not.toContain("did not say that");
  });
});

describe("a tool argument that is a placeholder rather than a value", () => {
  const plate = {
    id: "run_plate",
    description: "the unit is asking you to run a plate, or has read one to you",
    input: "the plate only, in the letters and numbers the unit gave",
  } as unknown as AiTool;
  const fire = {
    id: "request_fire",
    description: "fire or EMS is needed at a location",
    input: "which service, and where it is needed",
  } as unknown as AiTool;

  test("the tool's own subject repeated back is not a value", () => {
    // Measured twice: "can you run a plate for me?" produced run_plate("plate") in both
    // runs of probe-tool-generalisation, and run_plate("me") in the harness. Each ran a
    // lookup on nothing and aired a fabricated vehicle return.
    expect(isPlaceholderValue(plate, "plate")).toBe(true);
    expect(isPlaceholderValue(plate, "a plate")).toBe(true);
  });

  test("pronouns name nothing", () => {
    expect(isPlaceholderValue(plate, "me")).toBe(true);
    expect(isPlaceholderValue(plate, "this one")).toBe(true);
  });

  test("anything with a number in it is specific", () => {
    // A plate, a code, a house number. This is what keeps the rule from eating values.
    expect(isPlaceholderValue(plate, "6 Alpha Lima 749")).toBe(false);
    expect(isPlaceholderValue(plate, "4-5 Charlie Mike Tango 9")).toBe(false);
  });

  test("a value that merely overlaps the description still passes", () => {
    // The discriminating case, and the one that nearly broke: "fire and EMS" are both
    // words in request_fire's own declaration, so a rule checking only overlap would
    // refuse a perfectly good argument. The extra content is what saves it.
    expect(isPlaceholderValue(fire, "fire and EMS, one person trapped")).toBe(false);
    expect(isPlaceholderValue(plate, "blocking the lane")).toBe(false);
  });

  test("a command tool's own vocabulary is a value, and only when the tool declares it", () => {
    // The distinction this encodes: a LOOKUP's argument must name something other than
    // the tool itself, so `run_plate("plate")` is nothing. A COMMAND's legal values are
    // a closed vocabulary that its own description and input line necessarily list, so
    // for `channel_alert` the same test refused the one word it exists to act on.
    const command = {
      id: "channel_alert",
      description: "put an alert up, or lift it once whatever caused it is over",
      input: 'which alert — SIGNAL 100, Ping — or "lift" to take one down',
    } as const;
    const declaring: AiTool = { ...command, recognizes: (value) => /\blift\b/i.test(value) };
    const silent: AiTool = { ...command };

    // A tool that declares nothing keeps exactly today's answer, which matters because
    // a server registers its own tools from Lua and cannot declare this at all.
    expect(isPlaceholderValue(silent, "lift")).toBe(true);
    expect(isPlaceholderValue(declaring, "lift")).toBe(false);
    // And the declaration only covers what the tool said it covers.
    expect(isPlaceholderValue(declaring, "alert")).toBe(true);
    expect(isPlaceholderValue(declaring, "me")).toBe(true);
  });

  test("a declared command is not rewritten into the asker's callsign either", () => {
    // Why the test above lives in `isPlaceholderValue` and not in `argumentRefusal`:
    // `resolveSelfReference` gates on the same function, and "for me" is one of the
    // SELF_REQUEST shapes. Left to `argumentRefusal`, "41, can you lift it for me?"
    // would have reached `run` as the unit's own callsign instead of as "lift".
    const declaring: AiTool = {
      id: "channel_alert",
      description: "put an alert up, or lift it once whatever caused it is over",
      input: "which alert",
      recognizes: (value) => /\blift\b/i.test(value),
    };
    expect(
      resolveSelfReference(declaring, "lift", {
        ...context,
        transcript: "41, can you lift it for me?",
      }),
    ).toBeNull();
  });

  test("an EMPTY argument is left to the tool, which says it better", () => {
    // hang_up says "you did not say what the call was about"; preempting that with a
    // generic refusal replaced a good message with a worse one.
    expect(isPlaceholderValue(plate, "")).toBe(false);
    expect(isPlaceholderValue(plate, "   ")).toBe(false);
  });
});

/**
 * `argumentRefusal` is the gate `runTool` applies and the gate `probe-self-report.ts`
 * scores. These hold the two to the SAME answer.
 *
 * ## Why that matters more than it looks
 *
 * `probe-self-report.ts` scored only which tool the model named, for its whole history,
 * and that is what hid BUG-69515. Measured 2026-10-08 with the eight-tool set, three
 * runs of six: "King 41 to control, send me another unit." came back
 * `request_cover("cover")` on 3 of 6, the probe printed `ok` for all six — `request_cover`
 * is a defensible choice for that sentence — and what the unit got was
 * `isPlaceholderValue` refusing "cover", the refusal composed into a negative, and nobody
 * sent. The probe now reports an `argument kept` column instead, and it read 3/6 there.
 *
 * Both halves of that are now fixed and the rows below reflect it: the refusal airs as
 * "go ahead" rather than "negative" (`index.ts`), and an argument that is only the
 * request's own subject resolves to the asker when the transmission says it is for them
 * (`resolveSelfReference`). The rows that still expect a refusal are the ones where it
 * does not — a third party, or nothing saying who it is for.
 *
 * The danger in fixing it that way is the one this repo keeps hitting: a probe that
 * reimplements the guard measures its own copy. So the probe imports this function, and
 * these tests pin it to `runTool` rather than restating what it ought to say. Drift makes
 * both the product and the measurement wrong in the same direction, which is undetectable
 * from either side alone.
 */
describe("argumentRefusal is exactly the gate runTool applies", () => {
  const cover: AiTool = {
    id: "request_cover",
    description: "the unit wants another unit with them, cover, or a second car",
    input: "what they need cover for",
  };
  const assign: AiTool = {
    id: "assign_unit",
    description: "send another unit to assist a unit who asked for one",
    input: "the callsign of the unit who needs help",
  };

  const cases: [string, AiTool, string, string, boolean][] = [
    // The measured BUG-69515 argument and the filed form of it, both nothing but the
    // tool's own subject — on a transmission that says who it is for. Resolved to the
    // asker rather than refused; the block below this one holds that behaviour in full.
    ["request_cover(cover)", cover, "cover", "King 41 to control, send me another unit.", false],
    [
      "assign_unit(another unit)",
      assign,
      "another unit",
      "King 41 to control, send me another unit.",
      false,
    ],
    // The same two arguments with nothing saying the asker is the subject: still refused.
    ["request_cover(cover), no asker named", cover, "cover", "King 41 to control.", true],
    [
      "assign_unit(another unit) for a third party",
      assign,
      "another unit",
      "King 41, send King 22 another unit.",
      true,
    ],
    // A status the unit never gave — the quote gate rather than the placeholder one.
    ["unit_status(invented)", tool("unit_status"), "right there", "Dispatch, control.", true],
    // And the three that must survive, or the gate is just a brake.
    ["assign_unit(King 41)", assign, "King 41", "King 41 to control, send me another unit.", false],
    ["unit_status(said it)", tool("unit_status"), "at lunch", "Dispatch, show me at lunch.", false],
    ["request_cover(real)", cover, "traffic stop going bad", "it's going bad out here", false],
  ];

  test.each(cases)("%s agrees with runTool", async (_name, subject, input, transcript, refused) => {
    const turn = { ...context, transcript };
    expect(argumentRefusal(subject, input, turn) !== null).toBe(refused);
    // The product's own answer for the same turn. `ok === false` can also come from Lua,
    // so the refusal is additionally pinned to Lua never having been reached.
    const before = runCalls.length;
    const result = await runTool(subject, input, turn);
    if (refused) {
      expect(result.ok).toBe(false);
      expect(runCalls.length).toBe(before);
      expect(result.message).toBe(argumentRefusal(subject, input, turn) ?? "");
    } else {
      expect(runCalls.length).toBe(before + 1);
    }
  });

  /**
   * The negative control for the whole block.
   *
   * Six of the assertions above expect a refusal, so a vacuous gate — one that returned
   * a string for everything, or `null` for everything — would still pass half of them.
   * This asserts the gate DISCRIMINATES on the same input, which neither degenerate
   * implementation can do. Measured: stubbing `isPlaceholderValue` to `false` takes the
   * two placeholder rows down, and returning a constant string takes the three keeping
   * rows down.
   */
  test("the gate discriminates rather than answering the same way twice", () => {
    const turn = { ...context, transcript: "King 41 to control, send King 22 another unit." };
    expect(argumentRefusal(assign, "another unit", turn)).not.toBeNull();
    expect(argumentRefusal(assign, "King 41", turn)).toBeNull();
  });
});

/**
 * The second half of BUG-69515: a placeholder that restates the request, on a radio where
 * the asker is unambiguously the subject of it.
 *
 * The first half shipped in `index.ts` — an argument fault airs "go ahead" rather than
 * "negative", so a true request is no longer answered with a false no. It still sent
 * nobody, which is what this resolves.
 *
 * ⚠ These cases are also the guard against the other failure in this file's history:
 * `run_plate("Grove and Jefferson")`, an argument resolved out of a transmission two
 * turns earlier, which read as a pass. Resolution reads the transcript only as evidence
 * of WHO; the value is always `callsign`/`unitId` off this turn.
 */
describe("a placeholder that is the asker referring to themselves", () => {
  const asked = "King 41 to control, send me another unit.";
  const assign: AiTool = {
    id: "assign_unit",
    description: "send another unit to assist a unit who asked for one",
    input: "the callsign of the unit who needs help",
  };
  const cover: AiTool = {
    id: "request_cover",
    description: "the unit wants another unit with them, cover, or a second car",
    input: "what they need cover for",
  };
  /** Quote-declared, so its argument can never be answered with a callsign. */
  const plate: AiTool = {
    id: "lookup_plate",
    description: "the unit is asking you to run a plate",
    input: "the plate, in the letters and numbers the unit gave",
  };
  /**
   * The real `add_note` declaration, verbatim, because the point of this fixture is the
   * exact wording. It says "in their words" while QUOTE_DECLARATIONS carried only "in
   * their *own* words" — one word apart, matched nothing, so the tool was not treated as
   * quote-declared. That was invisible while a placeholder was simply refused, and became
   * a wrong write the moment self-references began resolving: `add_note("me")` put the
   * asker's callsign into a call note. If this fixture's text ever drifts from
   * `cad-tools.ts`, this stops guarding anything.
   */
  const note: AiTool = {
    id: "add_note",
    description: "add what the unit just told you to their call",
    input: "what to add to the call, in their words",
  };

  test.each([
    ["assign_unit(another unit)", assign, "another unit", asked],
    ["request_cover(cover)", cover, "cover", asked],
    // First person in the argument itself, which needs no help from the transcript.
    ["assign_unit(me)", assign, "me", "King 41, I need another unit out here."],
    ["request_cover(for me)", cover, "for me", "King 41, I need another unit out here."],
  ])("%s resolves to the asker and the tool runs", async (_name, subject, input, transcript) => {
    const turn = { ...context, transcript };
    expect(argumentRefusal(subject, input, turn)).toBeNull();
    const result = await runTool(subject, input, turn);
    expect(result.ok).toBe(true);
    // The whole point: the tool is handed a unit, not the word the model wrote.
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.[1]).toBe(context.callsign);
  });

  test.each([
    // The subject is somebody else, named in the transmission. Resolving to the asker
    // would send King 41 the help King 22 asked for.
    ["assign_unit(another unit)", assign, "another unit", "King 41, send King 22 another unit."],
    // The measured one that must never resolve: the asker's callsign is not a plate.
    ["lookup_plate(me)", plate, "me", "Control, can you run a plate for me?"],
    // A placeholder with no evidence of who it is about, on a turn that asked for nothing.
    ["request_cover(this one)", cover, "this one", "King 41 to control."],
    // No asker to name at all.
    [
      "assign_unit(me) on an announcement",
      assign,
      "me",
      "King 41 to control, send me another unit.",
    ],
    // Quote-declared by its real wording, so a callsign is not an answer for it either:
    // a note records what the unit SAID, and "me" is not something they said.
    ["add_note(me)", note, "me", "King 41 to control, send me another unit."],
  ])("%s still refuses, and as OUR fault", async (name, subject, input, transcript) => {
    const turn =
      name === "assign_unit(me) on an announcement"
        ? { ...context, trigger: "call" as const, serverId: 0, callsign: "", transcript }
        : { ...context, transcript };
    expect(argumentRefusal(subject, input, turn)).not.toBeNull();
    const result = await runTool(subject, input, turn);
    expect(result.ok).toBe(false);
    // `fault: "argument"` is what `index.ts` branches on to air "go ahead" instead of
    // "negative". An unresolvable placeholder must keep it.
    expect(result.fault).toBe("argument");
    expect(runCalls).toHaveLength(0);
  });

  test("a named third party is passed through exactly as the model wrote it", async () => {
    const result = await runTool(assign, "King 22", { ...context, transcript: asked });
    expect(result.ok).toBe(true);
    expect(runCalls[0]?.[1]).toBe("King 22");
  });

  /**
   * Resolution is tool-agnostic on purpose, so it reaches tools whose argument was
   * never a unit — `patch_channels("me")` becomes `patch_channels("1-ADAM-12")` and
   * the directory quite correctly says there is no such channel.
   *
   * No wrong ACTION can get through that way; every built-in resolves its argument
   * against the directory, the alert list or the tone list first. What was left was
   * the honesty of the line: an untagged failure makes `index.ts` say "negative",
   * and a negative is a false no when the value we refused is one WE wrote. The
   * unit's own request may have been perfectly actionable, which is what "go ahead"
   * invites them to repeat.
   */
  test("a refused substitution is tagged as our fault, not the world's", async () => {
    const patch: AiTool = {
      id: "patch_channels",
      description: "two or more channels need to hear each other",
      input: "the channels to patch together, named as they are listed above",
    };
    const result = await runTool(patch, "me", {
      ...context,
      transcript: "Control, patch me to the county.",
    });
    expect(result.ok).toBe(false);
    expect(result.fault).toBe("argument");
  });

  /** And a tool that genuinely acted still reports no fault, or the tag means nothing. */
  test("a resolved argument that works carries no fault", async () => {
    const result = await runTool(assign, "another unit", { ...context, transcript: asked });
    expect(result.ok).toBe(true);
    expect(result.fault).toBeUndefined();
  });
});
