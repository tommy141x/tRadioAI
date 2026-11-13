import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { builtinTools, findBuiltin } from "./builtins";
import { probe } from "./tradio-hooks";
import { argumentRefusal, describeTools, isPlaceholderValue, runTool } from "./tools";
import type { AiTool, AiTurnContext } from "./types";

const globals = globalThis as unknown as Record<string, unknown>;
const saved = new Map<string, unknown>();
const RESOURCE = "tRadio";

let alerts: string[] = [];
let tones: string[] = [];

const base: AiTurnContext = {
  trigger: "transmission",
  serverId: 7,
  callsign: "1-ADAM-12",
  unitId: "",
  frequency: 155.475,
  channelName: "DISP",
  transcript: "",
  roster: [],
  history: [],
  waiting: [],
  channels: [],
};

const withNeighbour: AiTurnContext = {
  ...base,
  channels: [
    {
      frequency: 460.25,
      name: "DISP",
      zone: "Blaine County",
      monitored: false,
      units: [],
      alert: null,
      patchedWith: [],
    },
  ],
};

/** A channel that has both somewhere to relay to and a unit who could be mistaken for one. */
const withUnits: AiTurnContext = {
  ...withNeighbour,
  roster: [
    {
      callsign: "King 41",
      unitId: "K41",
      status: "10-8",
      note: "",
      point: null,
      serverId: 1,
      distance: null,
      talking: false,
    },
  ],
};

beforeEach(() => {
  alerts = [];
  tones = [];
  for (const [name, value] of Object.entries({
    GetCurrentResourceName: (): string => "tRadioAI",
    exports: {
      [RESOURCE]: {
        getAlerts: () => JSON.stringify(alerts.map((name) => ({ name }))),
        getToneKeys: () => JSON.stringify(tones),
        getPatches: () => "[]",
        removePatch: () => false,
      },
    },
    GetResourceState: (): string => "started",
  })) {
    if (!saved.has(name)) saved.set(name, globals[name]);
    globals[name] = value;
  }
  // The patch tools are offered only when tRadio answered the patch probes.
  probe();
});

afterAll(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete globals[name];
    else globals[name] = value;
  }
});

function ids(context: AiTurnContext): string[] {
  return builtinTools(context).map((tool) => tool.id);
}

describe("builtinTools", () => {
  test("offers nothing about other channels when there are none", () => {
    expect(ids(base)).not.toContain("patch_channels");
    expect(ids(base)).not.toContain("call_another_channel");
  });

  test("offers patching and relaying once another channel exists", () => {
    expect(ids(withNeighbour)).toContain("patch_channels");
    expect(ids(withNeighbour)).toContain("call_another_channel");
  });

  test("hides the alert tool on a server with no alerts configured", () => {
    expect(ids(withNeighbour)).not.toContain("channel_alert");
  });

  test("builds the alert tool's input line from the operator's own alert names", () => {
    alerts = ["SIGNAL 100", "SIGNAL 3"];
    const alert = builtinTools(withNeighbour).find((tool) => tool.id === "channel_alert");
    expect(alert).toBeDefined();
    expect(alert!.input).toContain("SIGNAL 100, SIGNAL 3");
  });

  test("builds the tone tool's input line from the configured tones", () => {
    tones = ["ALERT_A", "PRIORITY"];
    const tone = builtinTools(withNeighbour).find((tool) => tool.id === "channel_tone");
    expect(tone!.input).toContain("ALERT_A, PRIORITY");
  });
});

describe("channel_alert", () => {
  test("refuses an alert this server does not have, and says what it does have", async () => {
    alerts = ["SIGNAL 100"];
    const result = await findBuiltin("channel_alert")!.run(withNeighbour, "signal 12");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("SIGNAL 100");
  });

  test("refuses to act on nothing", async () => {
    alerts = ["SIGNAL 100"];
    expect((await findBuiltin("channel_alert")!.run(withNeighbour, "  ")).ok).toBe(false);
  });
});

/**
 * The guard and the tool must agree about what this tool's words are.
 *
 * Measured in game 2026-10-17: `channel_alert("lift")` never ran. `isPlaceholderValue`
 * builds its "nothing but the tool's own subject" set from the id, description and
 * input line, "lift" is in the description — and every alert NAME is in the generated
 * input line — so the whole of this tool's vocabulary read as a placeholder. The turn
 * then aired "go ahead", the unit said it again, and it failed identically forever.
 *
 * Driven through `runTool` and through the descriptor `builtinTools` really offers,
 * because three separate things had to be true and asserting the guard alone would
 * have missed two of them: the declaration has to exist, it has to survive
 * `describeTools` flattening the built-in into a plain `AiTool`, and the argument has
 * to reach `run`. `setAlertOnChannel` being called is the only proof of the last one.
 */
describe("channel_alert's own vocabulary reaches run", () => {
  let alertCalls: unknown[][] = [];

  function offered(context: AiTurnContext = withNeighbour): AiTool {
    const tool = describeTools(context).find((entry) => entry.id === "channel_alert");
    expect(tool).toBeDefined();
    return tool as AiTool;
  }

  beforeEach(() => {
    alerts = ["SIGNAL 100", "Ping"];
    alertCalls = [];
    const resource = (globals.exports as Record<string, Record<string, unknown>>)[RESOURCE];
    resource.setAlertOnChannel = (...args: unknown[]) => {
      alertCalls.push(args);
      return true;
    };
  });

  test("the offered descriptor still declares its vocabulary", () => {
    // `describeTools` rebuilds the built-in as a plain `AiTool`, and that object is
    // what `runTool` is handed. A field dropped there is a field the guards never see.
    expect(typeof offered().recognizes).toBe("function");
  });

  test("lift is not a placeholder, and is not refused", () => {
    const tool = offered();
    expect(isPlaceholderValue(tool, "lift")).toBe(false);
    expect(argumentRefusal(tool, "lift", withNeighbour)).toBeNull();
  });

  test("lift takes the alert down instead of airing go-ahead", async () => {
    const result = await runTool(offered(), "lift", withNeighbour);
    expect(result.ok).toBe(true);
    expect(result.fault).toBeUndefined();
    expect(alertCalls).toHaveLength(1);
    expect(alertCalls[0]![1]).toBe(false);
  });

  test("an alert name with no digit in it is a value too", async () => {
    // "Ping" is a shipped default alert. Only SIGNAL 100 and SIGNAL 3 ever worked,
    // and only because a number in the argument short-circuits the guard.
    expect(isPlaceholderValue(offered(), "Ping")).toBe(false);
    const result = await runTool(offered(), "Ping", withNeighbour);
    expect(result.ok).toBe(true);
    expect(alertCalls[0]![1]).toBe(true);
    expect(alertCalls[0]![2]).toBe("Ping");
  });

  test("a word that is neither a lift nor an alert is still a placeholder", () => {
    // The discriminating case. A declaration that answered true for anything would
    // turn the guard off for this tool, and `channel_alert("alert")` would run on
    // the tool's own subject — which is what the guard is for.
    const tool = offered();
    expect(isPlaceholderValue(tool, "alert")).toBe(true);
    expect(argumentRefusal(tool, "alert", withNeighbour)).toBe("you have not given me that yet");
  });
});

describe("channel_tone's own vocabulary reaches run", () => {
  test("a tone name is not a placeholder", () => {
    // Same mechanism, and worse: this tool declares no vocabulary in its description
    // at all, so EVERY tone name was refused except one carrying a digit.
    tones = ["PRIORITY", "ALERT_B"];
    const tool = describeTools(withNeighbour).find((entry) => entry.id === "channel_tone");
    expect(isPlaceholderValue(tool as AiTool, "PRIORITY")).toBe(false);
    expect(isPlaceholderValue(tool as AiTool, "tone")).toBe(true);
  });
});

describe("what the announcement turn may reach for", () => {
  // The `call` trigger is the turn that puts a fresh 911 call out on the air.
  const announcing: AiTurnContext = { ...withUnits, trigger: "call" };

  test("offers no channel-target tool, because there is nothing to relay or patch", () => {
    // Measured: on this turn the model names the unit it is assigning the call to
    // where a channel belongs, with whichever of these two tools is offered.
    expect(ids(announcing)).not.toContain("call_another_channel");
    expect(ids(announcing)).not.toContain("patch_channels");
  });

  test("still offers the tools that take no channel target", () => {
    // The discriminating half: a gate that withdrew everything would pass the
    // assertion above while removing capability nothing measured as broken.
    alerts = ["Attempt to Locate"];
    tones = ["alert"];
    expect(ids(announcing)).toContain("channel_alert");
    expect(ids(announcing)).toContain("channel_tone");
  });

  test("offers them while this channel has somebody else on it", () => {
    // INVERTED 2026-10-24. This used to require the opposite, and that assertion was
    // the bug: 287262e offered these tools only to a unit alone on its channel, so a
    // customer found cross-channel requests worked with one unit on the channel and
    // failed with two, symmetrically, in both directions. Two LEOs on a police
    // channel cannot provide an ambulance, and `buildRoster` counts listeners too,
    // so one silent monitor disabled the feature for everyone.
    //
    // `withUnits` has King 41 on the roster and the turn is unit 7, so there IS
    // somebody else here — which is the case that was broken.
    expect(ids(withUnits)).toContain("call_another_channel");
    expect(ids(withUnits)).toContain("patch_channels");
  });

  test("offers them when this channel has nobody else either", () => {
    // Unchanged by the inversion above, and kept as the discriminating pair: roster
    // size must not decide this at all, so BOTH roster shapes have to be offered the
    // tools. Asserting only the populated case would pass a gate keyed the other way.
    const aloneHere: AiTurnContext = { ...withNeighbour, serverId: 7, roster: [] };
    expect(ids(aloneHere)).toContain("call_another_channel");
    expect(ids(aloneHere)).toContain("patch_channels");
  });

  test("withholds them when there is no other CHANNEL to reach", () => {
    // The condition that legitimately remains, and the one the roster filter used to
    // hide: with nothing but the current channel on the system there is nowhere for a
    // relay or a patch to go. Without this case the gate could be stripped entirely
    // and the suite would still pass.
    const onlyChannel: AiTurnContext = {
      ...withUnits,
      channels: withUnits.channels.filter((entry) => entry.frequency === withUnits.frequency),
    };
    expect(ids(onlyChannel)).not.toContain("call_another_channel");
    expect(ids(onlyChannel)).not.toContain("patch_channels");
  });

  test("the asking unit does not count as somebody else to send", () => {
    // The roster always contains the unit doing the asking, so counting it would
    // withhold the tool on a channel where that unit is the only one on it.
    const onlyMe: AiTurnContext = {
      ...withNeighbour,
      serverId: 1,
      roster: [
        {
          callsign: "King 41",
          unitId: "K41",
          status: "10-8",
          note: "",
          point: null,
          serverId: 1,
          distance: null,
          talking: false,
        },
      ],
    };
    expect(ids(onlyMe)).toContain("call_another_channel");
  });
});

describe("call_another_channel", () => {
  test("refuses when nothing was written to put out", async () => {
    const result = await findBuiltin("call_another_channel")!.run(
      withNeighbour,
      "Blaine County DISP",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("did not say what");
  });

  test("refuses a channel that is not on the system", async () => {
    const result = await findBuiltin("call_another_channel")!.run(
      withNeighbour,
      "Fire Control: we need an engine",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no channel called");
  });

  test("says so when the target is a unit on this channel, not a channel", async () => {
    // The failure every call case in dispatch-harness.ts reproduces: the model
    // names the unit it just gave the call to as though it were a channel.
    const result = await findBuiltin("call_another_channel")!.run(
      withUnits,
      "King 41: incident at 12 Magellan Avenue",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("is a unit on this channel");
    expect(result.message).toContain("nothing to relay");
    // Must not be the generic message, which composes a follow-up that reads as
    // a system fault rather than as nothing needing to be relayed.
    expect(result.message).not.toContain("no channel called");
  });

  test('keeps a hyphenated name whole, so 1-ADAM-12 is not the target "1"', async () => {
    // A bare `-` in splitTarget's character class used to split here, which made
    // this tool and patch_channels unusable for LAPD-style callsigns and any
    // channel named like "LSPD-1". A spaced " - " is still a separator.
    const hyphenated = await findBuiltin("call_another_channel")!.run(
      withUnits,
      "1-ADAM-12: we need an engine",
    );
    expect(hyphenated.message).toContain('no channel called "1-ADAM-12"');
    const spaced = await findBuiltin("call_another_channel")!.run(
      withUnits,
      "Blaine County DISP - we need an engine",
    );
    expect(spaced.message).not.toContain("did not say what");
  });

  test("matches the callsign however the model punctuated it", async () => {
    for (const written of ["king41", "KING-41", "  King  41 "]) {
      const result = await findBuiltin("call_another_channel")!.run(
        withUnits,
        `${written}: incident at 12 Magellan Avenue`,
      );
      expect(result.message).toContain("is a unit on this channel");
    }
  });

  test("a real channel still relays, so the unit check cannot swallow one", async () => {
    // The discriminating case. A check that answered "that is a unit" for
    // everything would pass every assertion above it.
    const result = await findBuiltin("call_another_channel")!.run(
      withUnits,
      "Blaine County DISP: we need an engine",
    );
    expect(result.message).not.toContain("is a unit on this channel");
  });
});

describe("patch_channels", () => {
  test("refuses a patch of one channel", async () => {
    const result = await findBuiltin("patch_channels")!.run(withNeighbour, "Blaine County DISP");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("at least two");
  });

  test("refuses rather than guessing at a channel it cannot resolve", async () => {
    const result = await findBuiltin("patch_channels")!.run(
      withNeighbour,
      "Blaine County DISP and the fire channel",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("fire channel");
  });
});
