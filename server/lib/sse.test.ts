import { describe, expect, test } from "bun:test";
import { createSseParser } from "./sse";

/**
 * Every case here is a real socket behaviour rather than a spec corner. A parser
 * that only handles whole events passes a hand-written test and then drops
 * tokens in game, which reads as the model losing words rather than as a parse
 * bug — so the cases are chosen to be the ones that hide.
 */
describe("parsing a streamed completion", () => {
  test("an event split across chunks is held until it is whole", () => {
    const parser = createSseParser();
    expect(parser.push('data: {"co')).toEqual([]);
    expect(parser.push('ntent":"K31"}')).toEqual([]);
    expect(parser.push("\n\n")).toEqual([{ event: "", data: '{"content":"K31"}' }]);
  });

  test("several events in one chunk all come back", () => {
    // Taking only the first is silent data loss: the reply is simply shorter.
    const parser = createSseParser();
    expect(parser.push("data: one\n\ndata: two\n\ndata: three\n\n")).toEqual([
      { event: "", data: "one" },
      { event: "", data: "two" },
      { event: "", data: "three" },
    ]);
  });

  test("a chunk boundary falling exactly on the blank line loses nothing", () => {
    const parser = createSseParser();
    expect(parser.push("data: copy\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ event: "", data: "copy" }]);
  });

  test("several data lines in one event join with a newline", () => {
    const parser = createSseParser();
    expect(parser.push("data: first\ndata: second\n\n")).toEqual([
      { event: "", data: "first\nsecond" },
    ]);
  });

  test("a comment line is not data", () => {
    // Proxies send these as keepalives. Fed to JSON.parse it is an exception per
    // ping, and llama-server itself never sends one, so it would only ever fail
    // in the deployment that has a proxy in front.
    const parser = createSseParser();
    expect(parser.push(": ping\n\ndata: real\n\n")).toEqual([{ event: "", data: "real" }]);
  });

  test("one optional space after the colon is framing, not content", () => {
    const parser = createSseParser();
    expect(parser.push("data:  leading\n\n")).toEqual([{ event: "", data: " leading" }]);
  });

  test("a named event keeps its name", () => {
    const parser = createSseParser();
    expect(parser.push("event: done\ndata: {}\n\n")).toEqual([{ event: "done", data: "{}" }]);
  });

  test("a stream that closes without a trailing blank line still yields its last event", () => {
    // The event most likely to arrive this way is the final one, which carries
    // the stop reason and the timings.
    const parser = createSseParser();
    expect(parser.push("data: last")).toEqual([]);
    expect(parser.end()).toEqual([{ event: "", data: "last" }]);
  });

  test("CRLF framing parses the same as LF", () => {
    const parser = createSseParser();
    expect(parser.push("data: windows\r\n\r\n")).toEqual([{ event: "", data: "windows" }]);
  });

  test("end() on an exhausted stream yields nothing", () => {
    const parser = createSseParser();
    parser.push("data: done\n\n");
    expect(parser.end()).toEqual([]);
  });

  test("a reply delivered one character at a time parses identically", () => {
    // The case the transport actually produces under load, and the one that
    // whole-chunk parsing passes tests on and fails in production.
    const wire = 'data: {"content":"K31"}\n\ndata: [DONE]\n\n';
    const parser = createSseParser();
    const events = [];
    for (const char of wire) events.push(...parser.push(char));
    events.push(...parser.end());
    expect(events).toEqual([
      { event: "", data: '{"content":"K31"}' },
      { event: "", data: "[DONE]" },
    ]);
  });
});
