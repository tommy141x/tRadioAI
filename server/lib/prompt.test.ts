import { describe, expect, test } from "bun:test";
import {
  addressesAnotherUnit,
  addressesDispatcher,
  buildOutcomePrompt,
  buildSystemPrompt,
  buildTurnPrompt,
  CALL_BIAS_OPENING,
  callTranscriptionBias,
  collapseOwnRepeats,
  DEFAULT_DEMEANOR,
  demeanorLine,
  DEMEANORS,
  echoesInstructions,
  echoesTheQuestion,
  isBareCallUp,
  isTrafficSignal,
  opensWithOwnCallsign,
  transcriptionBias,
  unitAskedAQuestion,
  unitNamedIn,
} from "./prompt";
import type { AiTool, AiTurnContext } from "./types";

const context: AiTurnContext = {
  trigger: "transmission",
  serverId: 7,
  callsign: "1-ADAM-12",
  unitId: "A12",
  frequency: 155.475,
  channelName: "LAPD DISPATCH",
  transcript: "dispatch 1-adam-12 i'll be 10-8",
  roster: [],
  history: [],
  waiting: [],
  channels: [],
};

const tools: AiTool[] = [
  {
    id: "unit_status",
    description: "the unit is telling you their status",
    input: "the status they gave, such as 10-8",
  },
  { id: "roll_call", description: "the unit asked who is on the air", input: "" },
];

describe("buildTurnPrompt", () => {
  test("names each tool and says what its argument is", () => {
    const prompt = buildTurnPrompt(context, tools);
    expect(prompt).toContain("- unit_status: the unit is telling you their status");
    expect(prompt).toContain("Input: the status they gave, such as 10-8");
    expect(prompt).toContain("- roll_call: the unit asked who is on the air Takes no input.");
    expect(prompt).toContain("LAPD DISPATCH");
  });

  test("says so plainly when there is nothing to do", () => {
    const prompt = buildTurnPrompt(context, []);
    expect(prompt).toContain("You have no tools right now");
    expect(prompt).not.toContain("Tools:");
  });

  /**
   * The tool ids restated AFTER the transmission, which is the fix for the worst
   * measured defect in the dispatcher and is purely a matter of position.
   *
   * With the list declared only above the transcript, `scripts/probe-self-report.ts`
   * measured `unit_status` chosen 0 of 10 times against the one tool tRadio ships —
   * ordinary traffic came back as a call-up and was answered "Go ahead, King 41".
   * Restating the ids last took that to 10 of 10 on identical traffic. Nothing about
   * the words changed; a one-line tool list in a thirteen-line prompt was simply not
   * being weighed.
   *
   * So the assertion is positional, not textual. A test that only checked the sentence
   * was present would keep passing if the block moved back above the transcript, which
   * is exactly the regression that matters and the one a reader tidying this function
   * would cause.
   */
  test("restates the tool ids after the transmission, not before it", () => {
    const prompt = buildTurnPrompt(context, tools);
    const saidAt = prompt.indexOf("They said:");
    const checkAt = prompt.indexOf("Check what they said against your tools");
    expect(saidAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(saidAt);
    // Every registered id, so a server's own tools get the same salience as tRadio's.
    expect(prompt.slice(checkAt)).toContain("unit_status, roll_call");
    // The escape hatch. Without it a model with one tool has one way to comply, and
    // the over-recording this whole area is prone to comes straight back.
    expect(prompt.slice(checkAt)).toContain("use none and answer in words");
  });

  /**
   * Restating the whole tool line here was tried and measured worse; see the comment in
   * `buildTurnPrompt`. This holds the shape that is actually shipped, so a reader acting
   * on that comment's reasoning without re-running the probe trips over a failing test
   * rather than a quiet regression.
   */
  test("restates ids and not the descriptions again", () => {
    const prompt = buildTurnPrompt(context, tools);
    const restated = prompt.slice(prompt.indexOf("Check what they said against your tools"));
    expect(restated).not.toContain("the unit is telling you their status");
    expect(restated).not.toContain("the status they gave, such as 10-8");
  });

  test("restates nothing when there are no tools to restate", () => {
    // The negative control for the test above: with the list empty the sentence would
    // name nothing and read as an instruction to use a tool that does not exist.
    expect(buildTurnPrompt(context, [])).not.toContain("Check what they said against your tools");
  });

  test("does not restate tools on a 911 call", () => {
    // Scoped to radio traffic deliberately. A call has its own closing instruction —
    // the location decision, placed last for the same reason — and two instructions
    // competing for the last position is how that one stopped working before.
    const prompt = buildTurnPrompt(
      {
        ...context,
        trigger: "call_intake",
        call: { message: "someone is at my door" },
      } as unknown as AiTurnContext,
      tools
    );
    expect(prompt).not.toContain("Check what they said against your tools");
  });

  test("describes the roster with ids, statuses and distances", () => {
    const prompt = buildTurnPrompt(
      {
        ...context,
        roster: [
          {
            serverId: 7,
            callsign: "1-ADAM-12",
            unitId: "A12",
            status: "10-8",
            note: "",
            point: null,
            distance: 0,
            talking: true,
          },
          {
            serverId: 9,
            callsign: "1-L-20",
            unitId: "",
            status: "",
            note: "on a traffic stop",
            point: null,
            distance: 2400,
            talking: false,
          },
        ],
      },
      tools
    );
    expect(prompt).toContain("Units on this channel:");
    expect(prompt).toContain("- 1-ADAM-12: ID A12, showing 10-8, right there, keyed up right now");
    expect(prompt).toContain("- 1-L-20: no status given, 2.4 km away, on a traffic stop");
  });

  test("replays recent traffic and names who is still waiting", () => {
    const prompt = buildTurnPrompt(
      {
        ...context,
        history: [
          { who: "K31", text: "K31 to dispatch", at: 1, own: false },
          { who: "Dispatch", text: "Go K31", at: 2, own: true },
        ],
        waiting: ["K32"],
      },
      tools
    );
    expect(prompt).toContain("Recent traffic on this channel, oldest first:");
    expect(prompt).toContain('K31: "K31 to dispatch"');
    expect(prompt).toContain('Dispatch: "Go K31"');
    expect(prompt).toContain("Waiting to be answered: K32");
  });

  test("puts a call out instead of a transmission, and says where it came from", () => {
    const prompt = buildTurnPrompt(
      {
        ...context,
        trigger: "call",
        serverId: 0,
        callsign: "",
        unitId: "",
        transcript: "",
        call: {
          id: "call911_abc",
          source: "911",
          caller: "Jane Doe",
          message: "someone broke into the store",
          location: "Vespucci Boulevard",
          priority: "priority 2",
          service: "",
        },
      },
      tools
    );
    expect(prompt).toContain("A call just came in from 911");
    expect(prompt).toContain("Caller: Jane Doe");
    expect(prompt).toContain("Priority: priority 2");
    expect(prompt).toContain("Location: Vespucci Boulevard");
    expect(prompt).toContain("Pick the nearest unit who is available");
    expect(prompt).not.toContain("just keyed up");
  });

  test("describes the other channels, but not the one it is already on", () => {
    const prompt = buildTurnPrompt(
      {
        ...context,
        channels: [
          {
            frequency: 155.475,
            name: "DISP",
            zone: "Los Santos",
            monitored: true,
            units: [],
            alert: "SIGNAL 100",
            patchedWith: ["Blaine County DISP"],
          },
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
      },
      tools
    );
    expect(prompt).toContain("The rest of the system:");
    expect(prompt).toContain("- Blaine County DISP: nobody on it, you do not cover this one");
    expect(prompt).toContain("This channel is currently running SIGNAL 100.");
    expect(prompt).toContain("This channel is patched to Blaine County DISP.");
    expect(prompt).not.toContain("- Los Santos DISP:");
  });

  test("truncates a stuck-PTT transcript", () => {
    const prompt = buildTurnPrompt({ ...context, transcript: "word ".repeat(400) }, tools);
    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(1200);
  });
});

describe("buildSystemPrompt", () => {
  test("leaves the operator's section out when they wrote nothing", () => {
    const prompt = buildSystemPrompt("Dispatch");
    expect(prompt).not.toContain("This server's own instructions");
  });

  test("adds the operator's orders under the rules, not over them", () => {
    const prompt = buildSystemPrompt("Dispatch", "A pursuit means SIGNAL 100 goes up.");
    expect(prompt).toContain("This server's own instructions:");
    expect(prompt).toContain("A pursuit means SIGNAL 100 goes up.");
    expect(prompt).toContain("Everything above them still holds.");
    expect(prompt.indexOf("Never name a tool that is not on the list")).toBeLessThan(
      prompt.indexOf("This server's own instructions:")
    );
  });

  test("caps a policy document", () => {
    const prompt = buildSystemPrompt("Dispatch", "x".repeat(9000));
    expect(prompt).toContain("x".repeat(4000));
    expect(prompt).not.toContain("x".repeat(4001));
  });

  /**
   * The code sheet is the operator's, so the whole block is conditional — and until the
   * sheet became configurable it could never emit, since `tenCodes` was always empty.
   * Both halves are asserted: the meanings, and the rate.
   *
   * The rate matters on its own. Counted on the scanner feed, a code appears in 4.9% of
   * utterances and two in 0.2%; a model given 24 codes and no sense of how often real
   * operators use them starts speaking in them, which is the opposite of what the sheet
   * is for.
   */
  test("gives the codes their meanings and tells the model they are rare", () => {
    const prompt = buildSystemPrompt("Dispatch", "", {
      "10-50": "traffic accident",
    });
    expect(prompt).toContain("This channel's codes:");
    expect(prompt).toContain("10-50 is traffic accident");
    expect(prompt).toContain("read it back, never guess what it stands for");
    expect(prompt).toContain("Codes are rare on a real channel");
  });

  test("says nothing at all about codes when the operator set no sheet", () => {
    const prompt = buildSystemPrompt("Dispatch");
    expect(prompt).not.toContain("This channel's codes:");
    // The control for the test above: without this, a rate line moved out of the
    // conditional block would still satisfy every assertion there.
    expect(prompt).not.toContain("Codes are rare on a real channel");
  });
});

/**
 * The demeanor is picked host-side, and the CATALOGUE must never reach the prompt.
 *
 * That is the failure this block exists for, and it is not the obvious one. A manner
 * the operator did not ask for is a cosmetic complaint; the whole table in the prompt
 * is four manners in the model's context on every turn with an instruction to ignore
 * three, and `prompt.ts` records twice over what a model does with text it was shown
 * and told not to use.
 *
 * Every assertion here is paired with something that can see it go vacuous: a floor on
 * the table's size, and a control that pastes the catalogue in and watches the same
 * check fail.
 */
describe("the dispatcher's demeanor", () => {
  const keys = Object.keys(DEMEANORS) as (keyof typeof DEMEANORS)[];

  /** Which of the table's lines are present in a prompt, by exact text. */
  const linesIn = (prompt: string): string[] =>
    Object.values(DEMEANORS).filter((line) => prompt.includes(line));

  test("the table is big enough for the assertions below to mean anything", () => {
    // With one entry, "exactly one present and the others absent" is satisfied by
    // any prompt that injects anything at all, and duplicated text would make the
    // count unreadable.
    expect(keys.length).toBeGreaterThan(1);
    expect(new Set(Object.values(DEMEANORS)).size).toBe(keys.length);
  });

  test.each(keys)("picks %s and puts exactly that one line in the prompt", (key) => {
    const prompt = buildSystemPrompt("Dispatch", "", {}, key);

    expect(linesIn(prompt)).toEqual([DEMEANORS[key]]);
    // One LINE, not one occurrence — a second copy of the same text passes the
    // check above unchanged.
    expect(prompt.split("\n").filter((line) => line.endsWith(DEMEANORS[key]))).toHaveLength(1);
    // The KEYS are a catalogue too: "pick one of measured, brisk, …" leaks the
    // choice exactly as much as the prose does.
    for (const other of keys.filter((name) => name !== key)) {
      expect(prompt).not.toContain(other);
    }
    // Under the speaking rules it qualifies, not loose at the end of the prompt.
    expect(prompt.indexOf(DEMEANORS[key])).toBeGreaterThan(prompt.indexOf("Speaking:"));
    expect(prompt.indexOf(DEMEANORS[key])).toBeLessThan(
      prompt.indexOf("How a transmission is built:")
    );
  });

  test("⛔ the catalogue check can fail, and here is it failing", () => {
    // The negative control for the test above. Without it, `linesIn` returning the
    // one line it was handed proves nothing about whether it could ever see four.
    const leaked = `${buildSystemPrompt("Dispatch")}\n${Object.values(DEMEANORS).join("\n")}`;
    expect(linesIn(leaked)).toHaveLength(keys.length);
    expect(linesIn(leaked)).not.toEqual([DEMEANORS[DEFAULT_DEMEANOR]]);
  });

  test("a blank key is the documented default, not an error and not an empty bullet", () => {
    const blank = buildSystemPrompt("Dispatch", "", {}, "");
    expect(blank).toContain(DEMEANORS[DEFAULT_DEMEANOR]);
    expect(blank).toBe(buildSystemPrompt("Dispatch", "", {}, DEFAULT_DEMEANOR));
    // The outcome the default is there to prevent: a bullet with nothing after it.
    expect(blank.split("\n")).not.toContain("- ");
    expect(blank.split("\n")).not.toContain("-");
  });

  test("an unrecognised key falls back instead of naming itself to the model", () => {
    const prompt = buildSystemPrompt("Dispatch", "", {}, "SASSY");
    expect(prompt).not.toContain("SASSY");
    expect(prompt).toBe(buildSystemPrompt("Dispatch", "", {}, DEFAULT_DEMEANOR));
  });

  test("tolerates the spacing and case an operator actually types", () => {
    expect(demeanorLine("  BRISK ")).toBe(DEMEANORS.brisk);
    expect(demeanorLine("")).toBe(DEMEANORS[DEFAULT_DEMEANOR]);
    // `in` would find this on Object.prototype and hand back `undefined`.
    expect(demeanorLine("toString")).toBe(DEMEANORS[DEFAULT_DEMEANOR]);
  });

  test("names manner and never an utterance, so a copied line cannot be a lie", () => {
    // Why the table holds manner only: prompt.ts records two example sentences being
    // aired verbatim, one of them an address nobody had given.
    for (const line of Object.values(DEMEANORS)) {
      expect(line).not.toContain('"');
      expect(echoesInstructions(line, buildSystemPrompt("Dispatch", "", {}, "brisk"))).toBe(
        line === DEMEANORS.brisk
      );
    }
  });
});

describe("buildOutcomePrompt", () => {
  test("tells the model a failure failed, and what it had passed", () => {
    const prompt = buildOutcomePrompt(context, [
      { tool: "unit_status", input: "10-8", ok: false, message: "CAD refused the write" },
    ]);
    expect(prompt).toContain('- unit_status with "10-8": failed — CAD refused the write');
    expect(prompt).toContain("did not go through");
  });

  test("leaves the argument out for a tool that takes none", () => {
    const prompt = buildOutcomePrompt(context, [
      { tool: "roll_call", input: "", ok: true, message: "done" },
    ]);
    expect(prompt).toContain("- roll_call: succeeded — done");
  });

  test("reports every action when the turn took more than one", () => {
    const prompt = buildOutcomePrompt(context, [
      { tool: "channel_alert", input: "SIGNAL 100", ok: true, message: "SIGNAL 100 is in effect" },
      { tool: "patch_channels", input: "a and b", ok: false, message: "b is trunked" },
    ]);
    expect(prompt).toContain("SIGNAL 100 is in effect");
    expect(prompt).toContain("b is trunked");
    // One succeeded, so the reply covers what happened rather than reporting a failure.
    expect(prompt).toContain("Cover what actually happened");
  });
});

describe("addressesDispatcher", () => {
  test("matches a wake phrase in the opening words", () => {
    expect(addressesDispatcher("Dispatch, 1-Adam-12, I'll be 10-8.", ["dispatch"])).toBe(true);
    expect(addressesDispatcher("1-Adam-12 to dispatch, show me 10-8", ["dispatch"])).toBe(true);
  });

  test("ignores unit-to-unit traffic", () => {
    expect(addressesDispatcher("Adam-12, meet me at the station", ["dispatch"])).toBe(false);
  });

  test("ignores a wake phrase that only turns up late", () => {
    const late = "hey adam twelve can you swing by the yard and let me know when dispatch calls";
    expect(addressesDispatcher(late, ["dispatch"])).toBe(false);
  });

  test("answers everything when no wake phrases are configured", () => {
    expect(addressesDispatcher("anything at all", [])).toBe(true);
  });
});

describe("addressesAnotherUnit", () => {
  const others = ["King 22", "K22", "Adam 14", "A14"];

  test("catches the line that made the dispatcher talk over unit-to-unit traffic", () => {
    // Measured on the offline harness: answered with "Go K41" because the
    // dispatcher had spoken to King 41 moments earlier and was expecting a reply.
    expect(addressesAnotherUnit("King 41 to King 22, you on this channel?", others)).toBe(true);
  });

  test("catches an opening callsign and a unit ID", () => {
    expect(addressesAnotherUnit("King 22, King 41, meet me at the yard", others)).toBe(true);
    expect(addressesAnotherUnit("K41 to K22", others)).toBe(true);
  });

  test("a unit merely mentioned is not a unit addressed", () => {
    // The dispatcher must still answer these — they are traffic *about* another
    // unit, directed at us.
    expect(addressesAnotherUnit("Show me out with King 22 on the traffic stop", others)).toBe(
      false
    );
    expect(addressesAnotherUnit("Can I get King 22 to my location?", others)).toBe(false);
  });

  test("says nothing about traffic naming nobody", () => {
    expect(addressesAnotherUnit("I've got a traffic stop here", others)).toBe(false);
    expect(addressesAnotherUnit("King 41 to dispatch", others)).toBe(false);
    expect(addressesAnotherUnit("anything at all", [])).toBe(false);
  });

  test("only the opening counts", () => {
    const late = "we ran the plate and it came back clear then I called King 22 to come over";
    expect(addressesAnotherUnit(late, others)).toBe(false);
  });
});

describe("isBareCallUp", () => {
  const wake = ["dispatch"];
  const names = ["King 41", "K41"];
  const callUp = (heard: string) => isBareCallUp(heard, wake, names);

  test("answers the shapes a call-up actually arrives in", () => {
    expect(callUp("King 41 to dispatch.")).toBe(true);
    expect(callUp("Dispatch, King 41.")).toBe(true);
    expect(callUp("K41 to dispatch")).toBe(true);
    expect(callUp("Hey dispatch, this is King 41")).toBe(true);
  });

  test("one word of traffic and it is traffic", () => {
    // Every one of these would be answered "go ahead" if the model saw it, which
    // is the failure this path exists to stop being fast at.
    expect(callUp("Dispatch, King 41, show me 10-8")).toBe(false);
    expect(callUp("King 41 to dispatch, traffic when ready")).toBe(false);
    expect(callUp("Dispatch, King 41, I've got a traffic stop here")).toBe(false);
  });

  test("stays out of traffic that names nobody it knows", () => {
    expect(callUp("Hey, you there?")).toBe(false);
    expect(callUp("King 22 to King 41")).toBe(false);
    expect(callUp("")).toBe(false);
  });

  test("a stuck PTT is not a call-up however it started", () => {
    expect(callUp(`King 41 to dispatch ${"uh ".repeat(20)}`)).toBe(false);
  });

  test("nothing to match against is not a match", () => {
    expect(isBareCallUp("King 41 to dispatch", [], [])).toBe(false);
  });
});

describe("collapseOwnRepeats", () => {
  const said = (text: string, at: number) => ({ who: "Dispatch", text, at, own: true });
  const heard = (text: string, at: number) => ({ who: "K41", text, at, own: false });

  test("shows a repeated dispatcher line once, keeping the latest", () => {
    // The measured loop: the repeats are never adjacent, because the unit's
    // transmission sits between every pair of them.
    const kept = collapseOwnRepeats([
      heard("Dispatch, King 41", 1),
      said("King 41, go ahead.", 2),
      heard("I've got a traffic stop here.", 3),
      said("King 41, go ahead.", 4),
      heard("Running the plate now.", 5),
      said("King 41, go ahead.", 6),
    ]);
    expect(kept.map((entry) => entry.at)).toEqual([1, 3, 5, 6]);
  });

  test("ignores punctuation and case, the same as the rest of the prompt", () => {
    const kept = collapseOwnRepeats([said("Go K41.", 1), heard("...", 2), said("go k41", 3)]);
    expect(kept.map((entry) => entry.at)).toEqual([2, 3]);
  });

  test("leaves a dispatcher who is actually working the channel alone", () => {
    const traffic = [
      said("King 41, go ahead.", 1),
      said("King 22, copy, showing you out.", 2),
      said("King 41, go ahead.", 3),
    ];
    expect(collapseOwnRepeats(traffic)).toEqual(traffic);
  });

  test("never collapses a unit repeating themselves", () => {
    // A unit saying the same thing twice was not answered the first time, and
    // that is the single most important thing in the history.
    const traffic = [heard("Dispatch, King 41", 1), heard("Dispatch, King 41", 2)];
    expect(collapseOwnRepeats(traffic)).toEqual(traffic);
  });

  test("passes an empty history through", () => {
    expect(collapseOwnRepeats([])).toEqual([]);
  });
});

describe("the wake phrase against what the transcriber actually returned", () => {
  const wake = ["dispatch"];

  // Every one of these is a real line from a session log, transcribed from radio
  // audio in which the unit said "dispatch". An exact match caught none of them.
  test.each([
    "This batch.",
    "This patch, I have a vehicle pursuit high rate of speed.",
    "This batch show me 10/7.",
    "King 41 through this patch.",
    "Hey, dispatch.",
    "Dispatch, King 41.",
  ])("hears the dispatcher in %p", (heard) => {
    expect(addressesDispatcher(heard, wake)).toBe(true);
  });

  // The other half of the same logs: transcriptions too far gone to act on, and
  // ordinary unit-to-unit traffic. Answering these is worse than missing a call.
  test.each([
    "Did that hello?",
    "Bitbats, you can show me code for it.",
    "King 41 to this dash?",
    "K31 to K32, you on?",
    "Start me another unit on this.",
    "That was a good stop.",
  ])("stays off %p", (heard) => {
    expect(addressesDispatcher(heard, wake)).toBe(false);
  });

  test("a short wake phrase is still matched exactly, not approximately", () => {
    // "base" would otherwise admit "chase", "place", "case" — every one of which
    // is ordinary traffic on a police channel.
    expect(addressesDispatcher("We are in a chase", ["base"])).toBe(false);
    expect(addressesDispatcher("Base, K31", ["base"])).toBe(true);
  });
});

describe("a reply the model copied out of its own instructions", () => {
  test("is recognised so it can be dropped rather than aired", () => {
    const system = buildSystemPrompt("Dispatch");
    expect(echoesInstructions("Their callsign first, every time.", system)).toBe(true);
  });

  test("leaves a real answer alone", () => {
    const system = buildSystemPrompt("Dispatch");
    expect(echoesInstructions("K31, copy, showing you out at the courthouse.", system)).toBe(false);
  });
});

describe("the radio prompt's answering rules", () => {
  test("offers a refusal shape, so a question is not acknowledged", () => {
    // Without this the only shape specified was acknowledge-plus-detail, and the
    // model applied it to questions: "what's the weather looking like tonight?"
    // came back as "Copy, 15, weather looking like tonight".
    const prompt = buildSystemPrompt("Dispatch");
    expect(prompt).toContain("A question is answered or refused, never acknowledged");
    expect(prompt).toContain("say negative");
    expect(prompt).toContain("not an answer");
  });

  test("says a tool only takes its own kind of value", () => {
    // Measured: with one status tool registered the model set a unit's status to
    // "plate is 4-5 Charlie Mike Tango 9".
    const prompt = buildSystemPrompt("Dispatch");
    expect(prompt).toContain("A tool takes the kind of value it names");
    expect(prompt).toContain("what that unit is doing");
  });

  test("names the acknowledgement words real dispatchers actually use", () => {
    // The discriminating case: a prompt that only forbade things would take the
    // model's acknowledgement vocabulary away, and this file records that a model
    // with none mints its own and repeats it.
    //
    // The list is counted from assets/reference/real-radio-traffix.txt: copy 167,
    // 10-4 108, received 8, acknowledged 0.
    const prompt = buildSystemPrompt("Dispatch");
    expect(prompt).toContain("copy, 10-4, received");
    // Never occurs in ~4,200 real transmissions, so offering it is offering a tell.
    expect(prompt).not.toContain("acknowledged —");
  });

  test("makes the read-back detail optional, because real traffic mostly omits it", () => {
    // Bare "Copy."/"Copy that." 56 and bare "10-4." 39, against 27 for "Copy" plus
    // anything. Mandating a detail is what made the model invent one for questions.
    const prompt = buildSystemPrompt("Dispatch");
    expect(prompt).toContain("a complete transmission and usually the right one");
    expect(prompt).toContain("Add a detail only when");
    expect(prompt).not.toContain("the one detail that proves you heard them");
  });
});

describe("the transcriber's bias", () => {
  test("names the wake phrases and who is on the channel", () => {
    const bias = transcriptionBias(["dispatch"], ["K31", "King 41"]);
    expect(bias).toContain("dispatch");
    expect(bias).toContain("K31");
    expect(bias).toContain("King 41");
  });

  test("is empty when there is nothing to expect, rather than an empty sentence", () => {
    expect(transcriptionBias([], [])).toBe("");
  });

  test("names the ten-codes, which have no ordinary English reading", () => {
    // Measured: "code 4" came back as "Recode 4" and "Workcode 4". The codes are
    // the ones the real-traffic corpus actually uses, by frequency.
    const bias = transcriptionBias(["dispatch"], ["K31"]);
    expect(bias).toContain("10-4");
    expect(bias).toContain("code 4");
  });

  test("the codes alone do not manufacture a bias out of nothing", () => {
    // The discriminating case: a constant appended unconditionally would make
    // `transcriptionBias([], [])` non-empty and send an initial prompt on a channel
    // with no units, no names and nothing to expect.
    expect(transcriptionBias([], [], [], [])).toBe("");
  });

  test("names places, which nothing else on this path supplies", () => {
    const bias = transcriptionBias(["dispatch"], ["K31"], ["DISP"], ["Vespucci Boulevard"]);
    expect(bias).toContain("Vespucci Boulevard");
    // Its own sentence, not folded into the channel list: a street listed as a
    // channel is a false claim, and the same string is read by the model.
    expect(bias).toContain("Places: Vespucci Boulevard.");
    expect(bias).not.toContain("Channels: DISP, Vespucci Boulevard");
  });

  test("places alone are enough to produce a bias", () => {
    // The radio path can have no roster and no second channel and still know
    // where a call was. Returning "" there would discard the one piece of
    // vocabulary in hand.
    expect(transcriptionBias([], [], [], ["Elgin Avenue"])).toContain("Elgin Avenue");
  });

  test("caps places so they cannot crowd out the callsigns", () => {
    const many = Array.from({ length: 20 }, (_, at) => `Street${at}`);
    const bias = transcriptionBias(["dispatch"], ["K31"], [], many);
    expect(bias).toContain("Street7");
    // whisper's initial prompt is a bounded window shared with the callsigns.
    expect(bias).not.toContain("Street8");
  });
});

describe("a 911 call's bias", () => {
  test("carries no callsigns, and says what the line is", () => {
    const bias = callTranscriptionBias();
    expect(bias).toBe(CALL_BIAS_OPENING);
    // The whole point of it being a separate builder. Naming units to the
    // recogniser is how a caller saying "I can't find him" becomes a unit id.
    expect(bias).not.toContain("K31");
    expect(bias).not.toContain("Units on the air");
  });

  test("adds places, because an address heard wrong is a unit sent nowhere", () => {
    const bias = callTranscriptionBias(["Elgin Avenue", "Vespucci Boulevard"]);
    expect(bias).toContain(CALL_BIAS_OPENING);
    expect(bias).toContain("Places: Elgin Avenue, Vespucci Boulevard.");
  });

  test("ignores blank entries rather than emitting a dangling sentence", () => {
    expect(callTranscriptionBias(["", "   "])).toBe(CALL_BIAS_OPENING);
  });
});

describe("a unit opening with its own callsign", () => {
  // Verbatim from assets/reference/real-radio-traffix.txt, where "dispatch"
  // appears in 0.45% of transmissions and a leading callsign in 12.6%.
  test("answers the way real units actually talk", () => {
    expect(opensWithOwnCallsign("42, I'm en route to the family problem.", "King 42", "K42")).toBe(
      true
    );
    expect(opensWithOwnCallsign("448, can you send in the description?", "King 448", "K448")).toBe(
      true
    );
    expect(
      opensWithOwnCallsign("2534, can you show me en route to the Saratoga's ER?", "King 2534", "")
    ).toBe(true);
  });

  test("takes the callsign spelled either way", () => {
    expect(opensWithOwnCallsign("King 41, I'm 10-8.", "King 41", "K41")).toBe(true);
    expect(opensWithOwnCallsign("K41, en route.", "King 41", "K41")).toBe(true);
  });

  test("a bare call-up still counts, since it wants a go-ahead", () => {
    expect(opensWithOwnCallsign("41.", "King 41", "K41")).toBe(true);
  });

  test("a ten-code is never a callsign, even for a unit numbered 10", () => {
    // radioWords drops the hyphen, so "10-4" arrives as ["10","4"]. Without the
    // guard, unit 10 would be addressed by every ten-code on the channel.
    expect(opensWithOwnCallsign("10-4.", "King 10", "K10")).toBe(false);
    expect(opensWithOwnCallsign("10-42 at the station.", "King 10", "K10")).toBe(false);
    // And the unit itself can still be addressed by its own number.
    expect(opensWithOwnCallsign("10, I'm clear.", "King 10", "K10")).toBe(true);
  });

  test("another unit's number at the front is not this unit's callsign", () => {
    expect(opensWithOwnCallsign("22, you on this channel?", "King 41", "K41")).toBe(false);
    expect(opensWithOwnCallsign("I'll be en route.", "King 41", "K41")).toBe(false);
  });

  test("a single-digit callsign is not matched on the number alone", () => {
    // Too collision-prone, and no callsign in the corpus is one digit.
    expect(opensWithOwnCallsign("4 vehicles involved.", "King 4", "K4")).toBe(false);
  });

  test("unit-to-unit traffic DOES open with the sender's callsign — the caller gates it", () => {
    // Documented contract: this returns true here and `addressesAnotherUnit` is what
    // overrules it, so the two must be combined. Both halves asserted together so
    // the pairing cannot drift.
    const line = "King 41 to King 22, you on this channel?";
    expect(opensWithOwnCallsign(line, "King 41", "K41")).toBe(true);
    expect(addressesAnotherUnit(line, ["King 22", "K22"])).toBe(true);
  });
});

describe("handing a question back instead of answering it", () => {
  test("catches the measured failures verbatim", () => {
    // Every one of these was aired on a real harness run.
    expect(
      echoesTheQuestion(
        "Dispatch, what's the weather looking like tonight?",
        "Copy, 15, weather looking like tonight"
      )
    ).toBe(true);
    expect(echoesTheQuestion("Dispatch, you still there?", "copy, K15, you still there")).toBe(
      true
    );
  });

  test("leaves an acknowledgement that actually conveys something", () => {
    // Calibration, written down because I asserted the opposite first and the
    // measurement corrected me. "plate status unknown" scores 0.40, below the
    // threshold on purpose: "unknown" is not a word the unit said, so the line tells
    // them something — that nothing is known — rather than handing their question
    // back. A thin answer, not a non-answer, and replacing it with a bare "copy"
    // would lose information.
    expect(
      echoesTheQuestion(
        "Dispatch, what's the status on that plate?",
        "copy, K22, plate status unknown"
      )
    ).toBe(false);
  });

  test("leaves a correct read-back of a STATEMENT alone", () => {
    // The discriminating case, and the reason this keys off the question rather
    // than off the echo: a right read-back is also almost entirely the unit's own
    // words, and suppressing those would break every status confirmation.
    expect(
      echoesTheQuestion("show me out at the Vespucci station", "copy, 41, out at Vespucci station")
    ).toBe(false);
    expect(
      echoesTheQuestion(
        "Suspect's in a red hoodie, heading north on Grove Street.",
        "copy, 30, red hoodie north on Grove"
      )
    ).toBe(false);
  });

  test("leaves a real ANSWER to a question alone", () => {
    // Answering with information the unit did not supply is the good case and must
    // survive: little of it comes out of the question.
    expect(
      echoesTheQuestion("Dispatch, can I get a second unit?", "King 22 is en route to you")
    ).toBe(false);
    expect(echoesTheQuestion("Dispatch, you still there?", "negative, K15")).toBe(false);
  });

  test("knows a question without a question mark", () => {
    // Transcripts arrive unpunctuated often enough that the mark cannot be relied on.
    expect(unitAskedAQuestion("can you patch us to OPS2")).toBe(true);
    expect(unitAskedAQuestion("what did that plate come back to")).toBe(true);
    expect(unitAskedAQuestion("show me 10-8")).toBe(false);
    expect(unitAskedAQuestion("")).toBe(false);
  });

  /**
   * An auxiliary PRESENT in the opening is not a question; an auxiliary before the
   * SUBJECT is. Measured over the 4,409-utterance reference feed, precision went
   * 0.444 -> 0.936 at unchanged recall by asking the second question instead of the
   * first — every statement below was called a question before it.
   *
   * It matters because `echoesTheQuestion` throws away the read-back detail on
   * anything it believes was asked, and a read-back is mostly the unit's own words
   * by design.
   */
  test("an auxiliary after its subject is a statement, not a question", () => {
    // The two commonest shapes on a real channel, both previously misread.
    expect(unitAskedAQuestion("8J35 is on scene at that one")).toBe(false);
    expect(unitAskedAQuestion("insurance is affirmative")).toBe(false);
    expect(unitAskedAQuestion("you can take 16 off the CAD")).toBe(false);
    expect(unitAskedAQuestion("10-4, I can read you it")).toBe(false);
    expect(unitAskedAQuestion("we'll tell you what the status is")).toBe(false);

    // And the inverted forms still read as questions, including behind a callsign
    // and a vocative, which is how a unit actually opens one.
    expect(unitAskedAQuestion("1-6-5, can you copy a 10-47")).toBe(true);
    expect(unitAskedAQuestion("dispatch, is there another unit available")).toBe(true);
    expect(unitAskedAQuestion("is there another unit to respond")).toBe(true);
    expect(unitAskedAQuestion("King 41, any units free for a second car")).toBe(true);
    expect(unitAskedAQuestion("who's going over to pick up the pink sheet")).toBe(true);
  });

  /**
   * The negative control. A rule that answered `false` for everything would pass
   * every statement assertion above, and one that answered `true` for everything
   * would pass every question assertion — this fails for both.
   */
  test("the question test discriminates rather than answering one way", () => {
    const asked = "dispatch, can you run a plate";
    const told = "dispatch, the plate is affirmative";
    expect(unitAskedAQuestion(asked)).toBe(true);
    expect(unitAskedAQuestion(told)).toBe(false);
  });
});

describe("who the dispatcher expects to hear from after it speaks", () => {
  const roster = [
    { serverId: 1, callsign: "King 41", unitId: "K41" },
    { serverId: 5, callsign: "King 42", unitId: "K42" },
  ];

  test("a unit called out by name is the one expected", () => {
    // Measured: "King 41 copy, King 15 route, assisting King 41" left the expectation on
    // King 41, so King 15's "10-4, I'm en route" was dropped as not addressed — the
    // dispatcher could not hear the answer to its own callout.
    expect(unitNamedIn("King 41 copy, King 42 route to Grove and Jefferson", roster, 1)).toBe(5);
  });

  test("the speaker being named does not count as calling them out", () => {
    // The discriminating case: acknowledging a unit by name is not asking them anything,
    // and they already hold the expectation by having spoken.
    expect(unitNamedIn("King 41, copy, 10-8", roster, 1)).toBe(null);
  });

  test("takes the short spelling too, since the model uses either", () => {
    expect(unitNamedIn("King 41 copy, K42 is responding", roster, 1)).toBe(5);
  });

  test("nobody named means nobody new to expect", () => {
    expect(unitNamedIn("copy", roster, 1)).toBe(null);
    expect(unitNamedIn("", roster, 1)).toBe(null);
  });

  test("a name anywhere in the transmission counts, not only at the front", () => {
    // The opposite of addressesAnotherUnit, which only reads the opening: here the name
    // can sit at the end of an assignment.
    expect(unitNamedIn("copy, start me a second car, King 42", roster, 1)).toBe(5);
  });
});

describe("a unit signalling it has traffic, without saying what", () => {
  const WAKE = ["dispatch"];
  const NAMES = ["King 41", "K41", "Dispatch"];
  const signal = (text: string) => isTrafficSignal(text, WAKE, NAMES);

  test("the forms a unit actually uses", () => {
    // The middle of the protocol: hail, go-ahead, THIS, go-ahead, then the substance.
    expect(signal("traffic")).toBe(true);
    expect(signal("Traffic when ready.")).toBe(true);
    expect(signal("King 41, traffic.")).toBe(true);
    expect(signal("Dispatch, King 41 has traffic for you.")).toBe(true);
    expect(signal("King 41, question when you're ready.")).toBe(true);
  });

  test("needs no callsign, because by now the unit has already been answered", () => {
    // The one real difference from isBareCallUp. A bare "traffic" is addressed by the
    // live expectation, not by naming anybody.
    expect(signal("traffic")).toBe(true);
  });

  test("anything substantive is NOT a signal and must reach the model", () => {
    // The discriminating half, and the dangerous direction: waving real traffic through
    // with a go-ahead would lose it entirely.
    expect(signal("traffic stop at Grove and Jefferson")).toBe(false);
    expect(signal("traffic stop")).toBe(false);
    expect(signal("I have traffic on a stolen vehicle")).toBe(false);
    expect(signal("show me 10-8")).toBe(false);
  });

  test("a qualifier on its own is not a signal", () => {
    // "when ready" without "traffic" is somebody mid-sentence, not the handshake.
    expect(signal("when ready")).toBe(false);
    expect(signal("stand by")).toBe(false);
    expect(signal("")).toBe(false);
  });
});

describe("a server's own ten-codes", () => {
  const SHEET = { "10-50": "traffic accident", "10-99": "officer needs help" };

  test("the recogniser is told the server's codes, not another agency's", () => {
    // A code sheet is local: 10-50 is an accident on one agency and a pursuit on the
    // next. Biasing toward the default when the server has its own would push the
    // recogniser at strings its units never say.
    const bias = transcriptionBias(["dispatch"], ["K41"], [], [], SHEET);
    expect(bias).toContain("10-50");
    expect(bias).toContain("10-99");
    expect(bias).not.toContain("10-42");
  });

  test("only the codes reach the recogniser, never the meanings", () => {
    // This string is an initial prompt about SOUNDS. "traffic accident" is not a sound a
    // unit makes, and putting it there biases the transcript toward words nobody said.
    const bias = transcriptionBias(["dispatch"], ["K41"], [], [], SHEET);
    expect(bias).not.toContain("traffic accident");
  });

  test("a server with no sheet keeps the shared defaults", () => {
    expect(transcriptionBias(["dispatch"], ["K41"], [], [], {})).toContain("10-4");
  });

  test("the dispatcher is told what the codes MEAN", () => {
    // The point of the whole thing: given the meaning, it can act on a 10-50 without
    // anybody writing a 10-50 scenario.
    const prompt = buildSystemPrompt("Dispatch", "", SHEET);
    expect(prompt).toContain("10-50 is traffic accident");
    expect(prompt).toContain("This channel's codes:");
  });

  test("with no sheet it is told nothing and guesses nothing", () => {
    // The honest fallback. A dispatcher acting on a meaning nobody gave it is worse than
    // one treating the code as the token it heard.
    const prompt = buildSystemPrompt("Dispatch");
    expect(prompt).not.toContain("This channel's codes:");
  });

  test("an unknown code is read back, not guessed at", () => {
    const prompt = buildSystemPrompt("Dispatch", "", SHEET);
    expect(prompt).toContain("never guess what it stands for");
  });
});
