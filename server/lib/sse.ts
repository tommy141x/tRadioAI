/**
 * Incremental server-sent-events parsing.
 *
 * `llama-server`'s streaming `/completion` replies in SSE, and the whole point of
 * streaming is that the dispatcher starts speaking before the last token exists —
 * so this has to work on whatever fragment of a chunk the socket happened to
 * deliver. Three failure modes it exists to prevent, all of which read as
 * "streaming just does not work" rather than as a parse bug:
 *
 *  1. **A chunk can split mid-line.** Anything that calls `JSON.parse` per chunk
 *     works in testing, where replies arrive whole, and breaks under load.
 *  2. **A chunk can contain several events.** Taking only the first loses tokens
 *     silently, which reads as the model dropping words.
 *  3. **An event may carry several `data:` lines**, which the spec says to join
 *     with newlines. Rare from llama.cpp but legal.
 *
 * Pure and synchronous: no timers, no sockets. The transport hands it text.
 *
 * This is a deliberate copy of tAI's `shared/pipeline/sse.ts` rather than an
 * import. tRadio shares no code with tAI — only a runtime tLib handshake — and
 * reaching across resource boundaries for 90 lines of pure text handling would
 * buy nothing and cost a load-order dependency. If the shared-inference
 * extraction ever happens, this is one of the files that goes into it.
 */

/** One decoded event. `data` is the joined payload; `event` is `""` if unnamed. */
export interface SseEvent {
  event: string;
  data: string;
}

export interface SseParser {
  /** Feeds a fragment and returns whatever events completed because of it. */
  push(chunk: string): SseEvent[];
  /**
   * Flushes a trailing event the stream ended without a blank line after.
   *
   * Not pedantry: a connection closed immediately after the final event is
   * normal, and dropping that event would lose the final message carrying the
   * stop reason and the timings.
   */
  end(): SseEvent[];
}

export function createSseParser(): SseParser {
  let pending = "";
  let event = "";
  const dataLines: string[] = [];
  const ready: SseEvent[] = [];

  const dispatch = () => {
    if (dataLines.length === 0 && !event) return;
    ready.push({ event, data: dataLines.join("\n") });
    event = "";
    dataLines.length = 0;
  };

  const consumeLine = (line: string) => {
    // A blank line terminates the event. This is the only dispatch point.
    if (line === "") {
      dispatch();
      return;
    }
    // Comment/keepalive. llama-server does not send these, but proxies do, and
    // treating one as data would feed ": ping" to JSON.parse.
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    // One optional space after the colon is part of the framing, not the value.
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") dataLines.push(value);
    else if (field === "event") event = value;
    // `id` and `retry` are irrelevant here: the dispatcher never resumes a
    // stream, it reissues the request.
  };

  return {
    push(chunk: string): SseEvent[] {
      ready.length = 0;
      pending += chunk;
      // Split on either newline style and keep the last piece: it is either an
      // empty string (the chunk ended on a boundary) or a partial line.
      const lines = pending.split(/\r\n|\n|\r/);
      pending = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
      return [...ready];
    },
    end(): SseEvent[] {
      ready.length = 0;
      if (pending) {
        consumeLine(pending);
        pending = "";
      }
      dispatch();
      return [...ready];
    },
  };
}
