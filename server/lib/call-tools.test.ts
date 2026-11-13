/**
 * Which tools a 911 call is offered, and which it is not.
 *
 * The asymmetry is the whole point and is worth restating where it is tested: a
 * radio tool hidden from a call costs nothing, because there is nothing on a
 * call for it to do. A radio tool *offered* on a call is an action the model
 * will eventually take against a member of the public — a status written to the
 * CAD for somebody who is not a unit, a channel patched because a caller said
 * the word "fire". Every assertion here is that shape of mistake.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { findBuiltin } from "./builtins";
import { noteAnswered, resetCalls } from "./calls";
import { describeTools, runTool } from "./tools";
import { probe } from "./tradio-hooks";
import type { AiCallInfo, AiTurnContext } from "./types";

const globals = globalThis as unknown as Record<string, unknown>;
const saved = new Map<string, unknown>();
const RESOURCE = "tRadioAI";

const CALL_FREQUENCY = -900001;

const info: AiCallInfo = {
  id: "call911_a",
  source: "911",
  caller: "Alex Vance",
  message: "there is someone in my back yard",
  location: "",
  priority: "",
  service: "",
};

const onCall: AiTurnContext = {
  trigger: "call_intake",
  serverId: 7,
  callsign: "Alex Vance",
  unitId: "",
  frequency: CALL_FREQUENCY,
  channelName: "911 call from Alex Vance",
  transcript: "he's still out there",
  roster: [],
  history: [],
  waiting: [],
  channels: [],
  call: info,
};

const onRadio: AiTurnContext = {
  ...onCall,
  trigger: "transmission",
  frequency: 155.475,
  channelName: "DISPATCH",
  callsign: "1-ADAM-12",
  call: undefined,
};

let luaToolCalls = 0;

function answer(): void {
  noteAnswered(
    {
      id: "call911_a",
      callerServerId: 7,
      callerName: "Alex Vance",
      message: info.message,
      coords: null,
      frequency: CALL_FREQUENCY,
    },
    info
  );
}

beforeEach(() => {
  resetCalls();
  luaToolCalls = 0;
  for (const [name, value] of Object.entries({
    GetCurrentResourceName: (): string => RESOURCE,
    exports: {
      [RESOURCE]: {
        getTools: () => {
          luaToolCalls++;
          return [{ id: "unit_status", description: "a unit's status", input: "the status" }];
        },
        runTool: () => true,
      },
      tRadio: {
        getAlerts: () => JSON.stringify([{ name: "SIGNAL 100" }]),
        getToneKeys: () => JSON.stringify(["ATTENTION"]),
        getPatches: () => "[]",
        removePatch: () => false,
      },
    },
    GetResourceState: (): string => "started",
  })) {
    if (!saved.has(name)) saved.set(name, globals[name]);
    globals[name] = value;
  }
  probe();
});

afterAll(() => {
  resetCalls();
  for (const [name, value] of saved) {
    if (value === undefined) delete globals[name];
    else globals[name] = value;
  }
});

describe("tools on a 911 call", () => {
  test("hang_up is offered, and it is the only thing offered", () => {
    answer();
    expect(describeTools(onCall).map((tool) => tool.id)).toEqual(["hang_up"]);
  });

  test("the operator's Lua tools are never even asked about", () => {
    answer();
    describeTools(onCall);
    // Not merely absent from the list: the hook is not called at all, so a
    // customer's tool cannot observe a call it was never meant to see.
    expect(luaToolCalls).toBe(0);
  });

  test("a radio turn is unchanged — every built-in, plus Lua's", () => {
    const ids = describeTools(onRadio).map((tool) => tool.id);
    expect(ids).toContain("channel_alert");
    expect(ids).toContain("channel_tone");
    expect(ids).toContain("unit_status");
    expect(ids).not.toContain("hang_up");
    expect(luaToolCalls).toBe(1);
  });

  test("an announcement gets the channel tools and none of the unit ones", () => {
    // A call put out on the air has no unit on the other end — `serverId` is 0.
    // Measured 2026-09-21: offered `set_unit_status` anyway, the dispatcher
    // called it against unit 0, the operator's Lua refused it, and the refusal
    // became a second transmission explaining the refusal to nobody.
    const announcement: AiTurnContext = {
      ...onRadio,
      trigger: "call",
      serverId: 0,
      callsign: "",
      call: info,
    };
    const ids = describeTools(announcement).map((tool) => tool.id);
    expect(ids).toContain("channel_alert");
    expect(ids).not.toContain("unit_status");
    expect(ids).not.toContain("hang_up");
    expect(luaToolCalls).toBe(0);
  });

  test("hang_up is hidden once the call is gone", () => {
    // No `answer()`: the registry is empty, so the frequency is not a live call.
    expect(describeTools(onCall).map((tool) => tool.id)).toEqual([]);
  });
});

describe("hang_up", () => {
  test("records the summary and marks the call closing without ending it", async () => {
    answer();
    // Looked up through the registry the turn loop uses, so a rename that broke
    // the wiring would fail here rather than at runtime on a live call.
    expect(findBuiltin("hang_up")?.id).toBe("hang_up");

    const result = await runTool(
      { id: "hang_up", description: "", input: "" },
      "prowler in a back yard",
      onCall
    );
    expect(result.ok).toBe(true);
    // The message is the prompt the closing line gets written from, so it has to
    // name what is still left to say rather than announce that it is over.
    expect(result.message).toContain("tell them help is being sent");
  });

  test("refuses an empty summary", async () => {
    answer();
    const result = await runTool({ id: "hang_up", description: "", input: "" }, "   ", onCall);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("what the call was about");
  });

  test("refuses on a line that has already dropped", async () => {
    const result = await runTool(
      { id: "hang_up", description: "", input: "" },
      "prowler in a back yard",
      onCall
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("already ended");
  });
});
