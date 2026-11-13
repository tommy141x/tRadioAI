import { describe, expect, test } from "bun:test";
import { draftReply } from "./draft";

describe("reading a reply out of a decision that is still arriving", () => {
  test("nothing is returned until the closing quote lands", () => {
    // The case the whole module exists for. A synthesiser handed the middle
    // reading says exactly that and stops, on the air, to a unit who is waiting.
    expect(draftReply('{"reply": "King 41, copy')).toBe("");
    expect(draftReply('{"reply": "King 41, copy, out at Grove')).toBe("");
    expect(draftReply('{"reply": "King 41, copy, out at Grove."')).toBe(
      "King 41, copy, out at Grove.",
    );
  });

  test("the reply is available long before the actions are", () => {
    // The saving being bought: this document is less than a third written.
    const partial = '{"reply": "King 41, copy, back in service.", "actions": [{"tool": "set_un';
    expect(draftReply(partial)).toBe("King 41, copy, back in service.");
  });

  test("an empty document says nothing rather than failing", () => {
    expect(draftReply("")).toBe("");
    expect(draftReply("{")).toBe("");
    expect(draftReply('{"actions": []')).toBe("");
  });

  test("a reply containing a quote is not cut short at it", () => {
    // Escaped quotes are why this cannot be a lastIndexOf on '"'.
    expect(draftReply('{"reply": "King 41, say again \\"out\\" please."}')).toBe(
      'King 41, say again "out" please.',
    );
  });

  test("a trailing backslash is treated as incomplete, not as an ending", () => {
    // The escape's payload is in the next chunk. Guessing here would either end
    // the string early or swallow the character after it.
    expect(draftReply('{"reply": "King 41 \\')).toBe("");
  });

  test("escapes that appear in a spoken line decode", () => {
    expect(draftReply('{"reply": "King 41,\\ncopy."}')).toBe("King 41,\ncopy.");
    expect(draftReply('{"reply": "a \\u0042 c"}')).toBe("a B c");
  });

  test("an incomplete unicode escape leaves the reply incomplete", () => {
    // The quote visible here is not a closing quote — it is the third of the
    // four hex digits' worth of characters the escape is still waiting for. A
    // reader that took it as the end would emit a truncated line and speak it.
    expect(draftReply('{"reply": "a \\u00"')).toBe("");
    // And once the rest arrives, it resolves normally.
    expect(draftReply('{"reply": "a \\u0042 c"}')).toBe("a B c");
  });

  test("actions arriving first still yields the reply once it closes", () => {
    // Ordering is a prompt instruction, not a guarantee, so the reader must not
    // depend on it.
    const whole = '{"actions": [{"tool": "play_tone", "input": "pursuit"}], "reply": "King 41."}';
    expect(draftReply(whole)).toBe("King 41.");
  });

  test("a non-string reply is never a draft", () => {
    expect(draftReply('{"reply": null, "actions": []}')).toBe("");
    expect(draftReply('{"reply": 41}')).toBe("");
  });

  test("something that merely looks like the key does not lock the scan", () => {
    // Taking the first match and giving up would report nothing for this whole
    // document, losing a reply that is right there.
    const text = '{"note": "the \\"reply\\" field", "reply": "King 41, copy."}';
    expect(draftReply(text)).toBe("King 41, copy.");
  });

  test("a reply is capped the same way the parsed decision caps it", () => {
    const long = "x".repeat(400);
    expect(draftReply(`{"reply": "${long}"}`).length).toBe(240);
  });

  test("the draft matches what the complete document parses to", () => {
    // The property that matters: speaking the draft and then recording the
    // parsed reply must not be two different sentences.
    const whole = '{"reply": "King 41, copy, out at Grove and Jefferson.", "actions": []}';
    const parsed = JSON.parse(whole) as { reply: string };
    expect(draftReply(whole)).toBe(parsed.reply);

    // And at every prefix, the draft is either nothing or already that answer.
    for (let i = 0; i <= whole.length; i++) {
      const draft = draftReply(whole.slice(0, i));
      if (draft !== "") expect(draft).toBe(parsed.reply);
    }
  });
});
