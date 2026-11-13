import { describe, expect, test } from "bun:test";
import { hasLocationEvidence, knownLocation } from "./location";
import type { AiCallInfo, AiTurnContext } from "./types";

function call(location = ""): AiCallInfo {
  return {
    source: "911",
    caller: "Alex Vance",
    message: "someone is trying to get in my back door",
    location,
    priority: "",
    service: "",
  } as AiCallInfo;
}

function context(
  transcript: string,
  options: { location?: string; heard?: string[]; said?: string[] } = {}
): AiTurnContext {
  return {
    trigger: "call_intake",
    serverId: 41,
    callsign: "Alex Vance",
    unitId: "",
    frequency: -900001,
    channelName: "911 call",
    transcript,
    roster: [],
    history: [
      ...(options.heard ?? []).map((text) => ({ who: "Caller", text, at: 0, own: false })),
      ...(options.said ?? []).map((text) => ({ who: "Dispatch", text, at: 0, own: true })),
    ],
    waiting: [],
    channels: [],
    call: call(options.location ?? ""),
  } as AiTurnContext;
}

describe("whether a call has somewhere to send a unit", () => {
  test("a named street in what they just said counts", () => {
    // The real transcripts from the harness's call cases.
    expect(
      hasLocationEvidence(context("I'm at 12 Magellan Avenue, the house behind the laundromat."))
    ).toBe(true);
    expect(
      hasLocationEvidence(
        context("There's been a crash at Elgin Avenue and Vespucci Boulevard, two cars.")
      )
    ).toBe(true);
    expect(hasLocationEvidence(context("I need police at the 24-7 on Palomino Avenue."))).toBe(
      true
    );
  });

  test("an intersection counts, with no house number anywhere", () => {
    expect(hasLocationEvidence(context("I'm at the corner of Grove and Jefferson."))).toBe(true);
  });

  test("a mile marker and a postal count, since a unit can be sent to both", () => {
    expect(hasLocationEvidence(context("We're out by mile marker 14."))).toBe(true);
    expect(hasLocationEvidence(context("Postal 1234, hurry."))).toBe(true);
  });

  test("a street name said EARLIER in the call still counts", () => {
    // The whole reason the confirmations were expensive: the address was already
    // in hand two turns ago.
    const later = context("No, I'm upstairs with the door locked.", {
      heard: ["I'm at 12 Magellan Avenue."],
    });
    expect(hasLocationEvidence(later)).toBe(true);
  });

  test("the server's own derived location counts even if nobody said it", () => {
    expect(hasLocationEvidence(context("Please hurry.", { location: "Magellan Avenue" }))).toBe(
      true
    );
  });
});

describe("what is NOT an address, because asking twice is the cheaper mistake", () => {
  test("a generic street word is not an address", () => {
    // The dangerous direction. Accepting these would make the dispatcher stop
    // asking on exactly the calls with no address at all.
    expect(hasLocationEvidence(context("I'm driving down the street right now."))).toBe(false);
    expect(hasLocationEvidence(context("He ran across the road and into the alley."))).toBe(false);
    expect(hasLocationEvidence(context("There's a car in the driveway."))).toBe(false);
  });

  test("a vivid description with no address is not an address", () => {
    // The exact turn the harness case `call-no-location` asserts on.
    expect(
      hasLocationEvidence(
        context("He's been out there a couple of minutes, big guy, dark hoodie, something in hand.")
      )
    ).toBe(false);
  });

  test("a landmark with no street is not an address", () => {
    expect(hasLocationEvidence(context("I'm behind the laundromat."))).toBe(false);
  });

  test("the DISPATCHER saying a street does not count", () => {
    // Otherwise one hallucinated address convinces the server it has one, and
    // the dispatcher never asks again.
    const own = context("Please send someone.", { said: ["Units responding to Elgin Avenue."] });
    expect(hasLocationEvidence(own)).toBe(false);
  });

  test("an unspecific marker is not an address", () => {
    expect(hasLocationEvidence(context("Somewhere past the mile markers."))).toBe(false);
  });
});

describe("naming the location back to the model", () => {
  test("only the server-derived one is named", () => {
    expect(knownLocation(context("x", { location: "Magellan Avenue" }))).toBe("Magellan Avenue");
  });

  test("a street only heard in speech is not quoted back as established fact", () => {
    // A mis-heard street presented to the model as fact is how "Spoochie
    // Boulevard" would become an address units get sent to.
    expect(knownLocation(context("I'm at 12 Magellan Avenue."))).toBe("");
  });
});
