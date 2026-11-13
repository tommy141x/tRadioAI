import { describe, expect, test } from "bun:test";
import { buildMultipart, parseDecision } from "./provider";
import type { AiTool } from "./types";

const tools: AiTool[] = [
  { id: "unit_status", description: "status", input: "a status" },
  { id: "tow_request", description: "tow", input: "a location" },
];

describe("parseDecision", () => {
  test("reads a plain JSON object", () => {
    const raw =
      '{"actions":[{"tool":"unit_status","input":"10-8"}],"reply":"1-Adam-12, showing you 10-8"}';
    expect(parseDecision(raw, tools)).toEqual({
      actions: [{ tool: "unit_status", input: "10-8" }],
      reply: "1-Adam-12, showing you 10-8",
      // Parsed and carried out since BUG-72482; absent from this response, so empty.
      kind: "",
      about: "",
    });
  });

  test("accepts a bare tool/input object as one action", () => {
    const raw = '{"tool":"unit_status","input":"10-8","reply":"copy"}';
    expect(parseDecision(raw, tools).actions).toEqual([{ tool: "unit_status", input: "10-8" }]);
  });

  test("keeps every action when the traffic needed two", () => {
    const raw =
      '{"actions":[{"tool":"unit_status","input":"10-8"},{"tool":"tow_request","input":"5th and Rockford"}],"reply":"copy"}';
    expect(parseDecision(raw, tools).actions).toHaveLength(2);
  });

  test("caps a model that has decided to do six things", () => {
    const actions = Array.from({ length: 6 }, () => ({ tool: "tow_request", input: "x" }));
    expect(parseDecision(JSON.stringify({ actions, reply: "" }), tools).actions).toHaveLength(3);
  });

  test("digs the object out of prose or a code fence", () => {
    const raw = 'Sure!\n```json\n{"tool":"unit_status","input":"10-8","reply":"copy"}\n```';
    expect(parseDecision(raw, tools).actions[0]?.tool).toBe("unit_status");
  });

  test("keeps the reply but drops a tool that was never declared", () => {
    const raw = '{"tool":"delete_everything","input":"now","reply":"copy that"}';
    expect(parseDecision(raw, tools)).toEqual({
      actions: [],
      reply: "copy that",
      kind: "",
      about: "",
    });
  });

  /**
   * `kind` and `about` reach the caller.
   *
   * They were parsed and discarded one line later for as long as `kind` has existed, and
   * BUG-72482 is what that cost: the model's classification of a self-report is correct
   * on every run while the tool match it conditions flips with the length of the tool
   * list, so throwing the reliable half away left only the unreliable half to act on.
   * `self-report.ts` is the consumer. Lowercased because that is the form the hang-up
   * branch above already compares against, and a caller matching on "Report" would be a
   * second spelling of the same contract.
   */
  test("carries the classification out instead of discarding it", () => {
    const raw =
      '{"kind":"Report","about":"traffic stop at Grove and Jefferson","reply":"copy","actions":[]}';
    const decision = parseDecision(raw, tools);
    expect(decision.kind).toBe("report");
    expect(decision.about).toBe("traffic stop at Grove and Jefferson");
  });

  test("drops only the invented tool out of a list", () => {
    const raw =
      '{"actions":[{"tool":"delete_everything","input":"now"},{"tool":"unit_status","input":"10-8"}],"reply":""}';
    expect(parseDecision(raw, tools).actions).toEqual([{ tool: "unit_status", input: "10-8" }]);
  });

  test("matches a declared tool case-insensitively and returns its canonical id", () => {
    expect(parseDecision('{"tool":"Unit_Status","reply":"copy"}', tools).actions[0]?.tool).toBe(
      "unit_status",
    );
  });

  test('"done" on a call is the hang-up, whether or not the model also said so', () => {
    // Measured on the first 911 harness run: the model classified the turn
    // "done", wrote a closing line, and left `actions` empty — so the call ran
    // on until the caller gave up. The label is the decision; the tool call is
    // the same decision written twice.
    const onCall: AiTool[] = [{ id: "hang_up", description: "end the call", input: "a summary" }];
    const raw =
      '{"kind":"done","about":"prowler in a back yard","reply":"Help is coming.","actions":[]}';
    expect(parseDecision(raw, onCall).actions).toEqual([
      { tool: "hang_up", input: "prowler in a back yard" },
    ]);
  });

  test('"done" falls back to the reply when the model wrote no summary', () => {
    // `hang_up` refuses an empty summary, and a refusal here would leave the
    // line up on the one turn the model had decided to end it.
    const onCall: AiTool[] = [{ id: "hang_up", description: "end the call", input: "a summary" }];
    const raw = '{"kind":"done","about":"","reply":"Help is being sent.","actions":[]}';
    expect(parseDecision(raw, onCall).actions).toEqual([
      { tool: "hang_up", input: "Help is being sent." },
    ]);
  });

  test('"done" is not duplicated when the model did call the tool', () => {
    const onCall: AiTool[] = [{ id: "hang_up", description: "end the call", input: "a summary" }];
    const raw =
      '{"kind":"done","about":"burglary","reply":"Help is coming.","actions":[{"tool":"hang_up","input":"burglary in progress"}]}';
    expect(parseDecision(raw, onCall).actions).toEqual([
      { tool: "hang_up", input: "burglary in progress" },
    ]);
  });

  test('a radio turn is untouched by "done"', () => {
    // The radio framing's kinds are call-up, request and report, so this cannot
    // arise there — but a model writes what it likes, and the guard that keeps
    // it harmless is `hang_up` not being on the list rather than the word.
    const raw = '{"kind":"done","about":"traffic stop","reply":"copy","actions":[]}';
    expect(parseDecision(raw, tools).actions).toEqual([]);
  });

  test("accepts a numeric input", () => {
    expect(
      parseDecision('{"tool":"unit_status","input":10,"reply":""}', tools).actions[0]?.input,
    ).toBe("10");
  });

  test("an unparseable response says nothing rather than throwing", () => {
    expect(parseDecision("I'm not sure what you mean.", tools).actions).toEqual([]);
    expect(parseDecision("{not json}", tools).reply).toBe("");
    expect(parseDecision("", tools)).toEqual({ actions: [], reply: "" });
  });

  test("caps a reply long enough to key the channel for half a minute", () => {
    const raw = JSON.stringify({ actions: [], reply: "word ".repeat(200) });
    expect(parseDecision(raw, tools).reply.length).toBe(240);
  });
});

describe("buildMultipart", () => {
  // The upload is assembled by hand because FormData makes the body a stream and
  // FXServer cannot read one — so the wire format is this code's problem now, and
  // an endpoint rejecting a malformed body would read as "the model heard nothing".
  test("writes the fields, then the file, with a boundary that closes", () => {
    const clip = {
      bytes: new Uint8Array([0, 1, 2, 250]),
      mime: "audio/wav",
      filename: "transmission.wav",
    };
    const { body, contentType } = buildMultipart(clip, {
      model: "whisper",
      response_format: "json",
    });
    const boundary = contentType.replace("multipart/form-data; boundary=", "");
    expect(boundary.length).toBeGreaterThan(8);

    // CRLF, not LF: every separator in a multipart body is a network line
    // ending, and an endpoint reading the parts strictly rejects a body that
    // uses bare newlines.
    const CRLF = "\r\n";
    // One byte per character, so the audio's high bytes cannot be replaced by
    // U+FFFD and shift every offset asserted below.
    const text = Array.from(body, (byte) => String.fromCharCode(byte)).join("");
    expect(text).toContain(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="model"${CRLF}${CRLF}whisper${CRLF}`,
    );
    expect(text).toContain('name="response_format"');
    expect(text).toContain('name="file"; filename="transmission.wav"');
    expect(text).toContain("Content-Type: audio/wav");
    expect(text.endsWith(`${CRLF}--${boundary}--${CRLF}`)).toBe(true);

    // The audio survives verbatim: a byte above 0x7f must not have been mangled
    // by a text encoder on its way into the body.
    const start = text.indexOf(CRLF + CRLF, text.indexOf('name="file"')) + 4;
    expect([...body.slice(start, start + 4)]).toEqual([0, 1, 2, 250]);
  });
});
