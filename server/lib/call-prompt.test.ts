/**
 * The call-taker prompt, and the turn prompt on a 911 call.
 *
 * Its own file rather than more cases in `prompt.test.ts`, because what is being
 * checked is different in kind: not that the text says the right thing, but that
 * none of the radio text reaches a member of the public. Every assertion below
 * is a phrase that is correct on a channel and wrong on a phone line.
 */

import { describe, expect, test } from "bun:test";
import { buildCallTakerPrompt, buildOutcomePrompt, buildTurnPrompt } from "./prompt";
import type { AiCallInfo, AiTool, AiTurnContext } from "./types";

const call: AiCallInfo = {
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
  frequency: -900001,
  channelName: "911 call from Alex Vance",
  transcript: "he's still out there, i can see him from the window",
  roster: [],
  history: [],
  waiting: [],
  channels: [],
  call,
};

const hangUp: AiTool = {
  id: "hang_up",
  description: "you have the location and you know what is happening",
  input: "what the call was, in a few words",
};

describe("buildCallTakerPrompt", () => {
  test("puts the location first and says why", () => {
    const prompt = buildCallTakerPrompt("Dispatch");
    expect(prompt).toContain("Get the location before anything else");
  });

  test("bans the radio's whole vocabulary", () => {
    const prompt = buildCallTakerPrompt("Dispatch");
    expect(prompt).toContain("No radio codes");
    expect(prompt).toContain("no callsigns");
    expect(prompt).toContain("This is not the radio");
  });

  test("forbids promising an outcome or a time", () => {
    const prompt = buildCallTakerPrompt("Dispatch");
    expect(prompt).toContain("How long anyone will be");
    expect(prompt).toContain("You do not know");
  });

  test("gives a word count rather than a sentence count", () => {
    // Measured on the radio prompt: "one sentence" is not a length and produced
    // seven seconds of airtime. The same mistake on a call is a paragraph said
    // to somebody who is frightened.
    const prompt = buildCallTakerPrompt("Dispatch");
    expect(prompt).toContain("Twenty words at the most");
  });

  test("quotes no line the model could say back verbatim", () => {
    // The failure the radio prompt cost two measurement rounds to find: a model
    // shown a concrete utterance says that utterance. On a call the invented
    // line would be a claim about somebody's emergency.
    const prompt = buildCallTakerPrompt("Dispatch");
    expect(prompt).not.toMatch(/["“”]/);
  });

  test("an operator's instructions are layered under the rules, never over them", () => {
    const prompt = buildCallTakerPrompt(
      "Dispatch",
      "Callers on the island get the harbour patrol."
    );
    expect(prompt).toContain("Callers on the island get the harbour patrol.");
    expect(prompt).toContain("Everything above them still holds");
    expect(prompt).toContain("promise a caller an outcome");
  });
});

describe("buildTurnPrompt on a call", () => {
  test("names the caller rather than a frequency nobody should read", () => {
    const prompt = buildTurnPrompt(onCall, [hangUp]);
    expect(prompt).toContain("On the phone with: Alex Vance");
    expect(prompt).not.toContain("Channel:");
    expect(prompt).not.toContain("-900001");
  });

  test("separates what they typed from what they just said", () => {
    const prompt = buildTurnPrompt(onCall, [hangUp]);
    // Both present, and distinguishable. Collapsed into one, the model answers
    // the /911 text again several turns into a call that has moved past it.
    expect(prompt).toContain('They called about: "there is someone in my back yard"');
    expect(prompt).toContain(
      'They just said: "he\'s still out there, i can see him from the window"'
    );
  });

  test("states that there is no address, rather than asking the model to work it out", () => {
    const prompt = buildTurnPrompt(onCall, [hangUp]);
    expect(prompt).toContain("You do not have an address");
    expect(prompt).toContain("one question asking where they are");
    // The decision moved to the server. Asking the model to reason it out cost a
    // turn on most calls and went wrong in both directions — see location.ts.
    expect(prompt).not.toContain("whether you already have a location");
  });

  test("states that a location IS held once the caller has given one", () => {
    const prompt = buildTurnPrompt(
      { ...onCall, transcript: "I'm at 12 Magellan Avenue, behind the laundromat." },
      [hangUp]
    );
    expect(prompt).toContain("You already have somewhere to send a unit");
    expect(prompt).toContain("Do not ask where they are again");
    expect(prompt).not.toContain("You do not have an address");
  });

  test("names a server-derived location, which a transcript is not trusted to supply", () => {
    const prompt = buildTurnPrompt({ ...onCall, call: { ...call, location: "Magellan Avenue" } }, [
      hangUp,
    ]);
    expect(prompt).toContain("somewhere to send a unit — Magellan Avenue");
  });

  test("names its own previous lines, so it cannot ask the same thing twice", () => {
    // Measured: "Is anyone hurt?" went out on three consecutive turns of one
    // call with both earlier copies already visible in the history.
    const prompt = buildTurnPrompt(
      {
        ...onCall,
        history: [
          { who: "Dispatch", text: "Is anyone hurt?", own: true, at: 1 },
          { who: "Alex Vance", text: "no, I'm upstairs", own: false, at: 2 },
          { who: "Dispatch", text: "Is anyone hurt?", own: true, at: 3 },
        ],
      },
      [hangUp]
    );
    expect(prompt).toContain('You have already said: "Is anyone hurt?"');
    expect(prompt).toContain("Say something else");
    // Deduplicated: the same line twice is one thing it has said, not two.
    expect(prompt.match(/You have already said: "Is anyone hurt\?" /g)).toHaveLength(1);
  });

  test("does not claim the caller's own words were its own", () => {
    // The discriminating case. A filter that took every history line would tell
    // the dispatcher not to repeat the CALLER, which is a different instruction
    // and a wrong one.
    const prompt = buildTurnPrompt(
      {
        ...onCall,
        history: [{ who: "Alex Vance", text: "someone is in my yard", own: false, at: 1 }],
      },
      [hangUp]
    );
    expect(prompt).not.toContain("You have already said");
  });

  test("calls the history a call rather than channel traffic", () => {
    const prompt = buildTurnPrompt(
      {
        ...onCall,
        history: [
          { who: "Dispatch", text: "Nine one one, what is your emergency?", own: true, at: 1 },
          { who: "Alex Vance", text: "someone is in my yard", own: false, at: 2 },
        ],
      },
      [hangUp]
    );
    expect(prompt).toContain("The call so far, oldest first:");
    expect(prompt).not.toContain("Recent traffic on this channel");
  });

  test("says nothing about the radio system", () => {
    const prompt = buildTurnPrompt(onCall, [hangUp]);
    expect(prompt).not.toContain("The rest of the system");
    expect(prompt).not.toContain("Units on this channel");
    // The instruction that ends a radio turn, which on a call would have the
    // dispatcher answering a transmission nobody made.
    expect(prompt).not.toContain("Answer that transmission");
  });
});

describe("buildOutcomePrompt on a call", () => {
  test("asks for plain words, not a radio sentence", () => {
    const prompt = buildOutcomePrompt(onCall, [
      { tool: "hang_up", input: "prowler in a back yard", ok: true, message: "the call ends" },
    ]);
    expect(prompt).toContain("Tell the caller");
    expect(prompt).toContain("in plain words");
    expect(prompt).not.toContain("on the air");
    expect(prompt).not.toContain("radio sentence");
  });

  test("an announcement is told who can actually hear it", () => {
    // Measured 2026-09-21: naming the caller so the model knows what the
    // traffic is about had it answer them — "Copy, Maria Ortiz, request
    // relayed" — on a channel the caller is not on.
    const prompt = buildOutcomePrompt({ ...onCall, trigger: "call", serverId: 0 }, [
      { tool: "channel_alert", input: "SIGNAL 100", ok: true, message: "the alert is up" },
    ]);
    expect(prompt).toContain("The caller is not on this channel and cannot hear you");
    expect(prompt).toContain("on the air");
  });

  test("a failure is reported without the technical reason", () => {
    const prompt = buildOutcomePrompt(onCall, [
      { tool: "hang_up", input: "", ok: false, message: "that call has already ended" },
    ]);
    expect(prompt).toContain("did not go through");
    expect(prompt).toContain("Do not tell them why in technical terms");
  });
});
