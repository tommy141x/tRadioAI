/**
 * POSTing to an inference endpoint over `node:http` rather than `fetch`.
 *
 * `fetch` looks like the obvious choice and is the wrong one here. FXServer's
 * Node turns any request body into a byte-type `ReadableStream`, then tees that
 * stream so the request can be replayed. Nothing ever reads the second branch,
 * and when it is closed the reader behind it has already been released — which
 * surfaces as `TypeError: Invalid state: Reader released`, thrown from a timer,
 * as an unhandled rejection that no `await` in this resource is in a position
 * to catch. Measured in-game: every transcription produced one, and a streamed
 * reply died after its first chunk.
 *
 * `node:http` has no body stream to tee.
 *
 * ## The streamed reply, and why the note above no longer forbids it
 *
 * "A streamed reply died after its first chunk" was measured through `fetch`,
 * before this module existed, and it was the same tee fault as the transcription
 * one — not evidence that FXServer cannot stream. tAI hit the identical
 * `Invalid state: Reader released` and traced it the rest of the way: the tee is
 * of the *request body*, so it fires on any POST that carries one, and a streamed
 * response simply noticed it one chunk in instead of at the end. tAI streams
 * tokens in production over `node:http` today.
 *
 * So {@link postStream} exists, and the conclusion that it could not is retired.
 * The buffered {@link post} stays for transcription and for anything else whose
 * reply is worthless in pieces.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * What to pass as `agent` on a streamed request. `false` — no pooling.
 *
 * A fix, not a default. Node's global agent keeps sockets alive and reuses them.
 * A streamed response that is aborted mid-body — which here is the normal case,
 * not an error path, because a transmission that turns out not to need an answer
 * cancels one — leaves its socket in a state the agent cannot reason about. It
 * goes back in the pool and the *next* caller inherits it.
 *
 * So the symptom is that the request after a cancelled one fails, with nothing
 * wrong with the request that fails. tAI measured this directly: two independent
 * probes each succeeded on attempt 1 and failed on attempt 2, with "socket hang
 * up" and ECONNRESET, while the server's own log showed attempt 1 completing
 * cleanly.
 *
 * Not a throughput regression: this connects to loopback, where a fresh socket
 * costs microseconds against a generation that costs seconds. Pooling was buying
 * nothing and charging a class of intermittent failure for it.
 */
const NO_POOLING = false;

export interface HttpReply {
  status: number;
  ok: boolean;
  bytes: Buffer;
  /** The body as text, for JSON and for error reporting. */
  text(): string;
}

export interface PostOptions {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | string;
  signal: AbortSignal;
}

/**
 * One POST, one buffered reply.
 *
 * Rejects on transport failure and on abort, which is the same contract `fetch`
 * had, so callers upstream are unchanged.
 */
export function post(options: PostOptions): Promise<HttpReply> {
  const payload =
    typeof options.body === "string"
      ? Buffer.from(options.body, "utf8")
      : Buffer.from(options.body);

  return new Promise<HttpReply>((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new Error("aborted"));
      return;
    }

    let target: URL;
    try {
      target = new URL(options.url);
    } catch {
      reject(new Error(`not a usable URL: ${options.url}`));
      return;
    }

    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: { ...options.headers, "content-length": String(payload.length) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        // Once headers have arrived a dropped connection is reported on the RESPONSE,
        // not the request, and `end` never fires. Unhandled, the promise simply never
        // settled: an engine that died mid-reply held its turn, and the channel with it,
        // until the turn's own deadline, and was logged as a timeout rather than as the
        // connection reset it was.
        const dropped = (error: Error) => {
          options.signal.removeEventListener("abort", cancel);
          reject(error);
        };
        response.on("error", dropped);
        // `close` without a complete message is the same fault on a runtime that does
        // not raise `error` for it. After `end` this is a second settle and does nothing.
        response.on("close", () => {
          if (!response.complete) dropped(new Error("the connection closed mid-reply"));
        });
        response.on("end", () => {
          options.signal.removeEventListener("abort", cancel);
          const status = response.statusCode ?? 0;
          const bytes = Buffer.concat(chunks);
          resolve({
            status,
            ok: status >= 200 && status < 300,
            bytes,
            text: () => bytes.toString("utf8"),
          });
        });
      },
    );

    const cancel = () => {
      request.destroy();
      reject(new Error("aborted"));
    };
    options.signal.addEventListener("abort", cancel, { once: true });

    request.on("error", (error: Error) => {
      options.signal.removeEventListener("abort", cancel);
      reject(error);
    });
    request.end(payload);
  });
}

/**
 * The same POST, yielding the response body as text fragments as they arrive.
 *
 * An async generator rather than a callback, deliberately: the consumer's
 * `for await` loop owns the deadlines, and a callback-driven reader cannot be
 * stopped from outside without a second channel — which is where the races live.
 * Abandoning the loop, or aborting the signal, destroys the request, which stops
 * the far end generating into a slot nobody is reading.
 *
 * Pulls from an event-driven stream into a queue, so whatever arrives between
 * two `next()` calls is buffered rather than dropped.
 */
export async function* postStream(options: PostOptions): AsyncGenerator<string> {
  const payload =
    typeof options.body === "string"
      ? Buffer.from(options.body, "utf8")
      : Buffer.from(options.body);

  if (options.signal.aborted) throw new Error("aborted");

  const target = new URL(options.url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const queue: string[] = [];
  let notify: (() => void) | null = null;
  let finished = false;
  let failure: Error | null = null;

  const wake = () => {
    const resume = notify;
    notify = null;
    resume?.();
  };
  const fail = (error: Error) => {
    failure = error;
    finished = true;
    wake();
  };

  const request = send(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      // Explicit rather than inherited: an empty `port` on an https URL means
      // 443, and passing "" through would try to connect to port 0.
      port: target.port === "" ? (target.protocol === "https:" ? 443 : 80) : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: {
        accept: "text/event-stream",
        ...options.headers,
        "content-length": String(payload.length),
      },
      agent: NO_POOLING,
    },
    (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 400) {
        // The body as well as the status: a 401 from a hosted provider names the
        // wrong key in its body, and swallowing that turns a one-line fix into
        // an afternoon.
        const parts: Buffer[] = [];
        response.on("data", (chunk: Buffer) => parts.push(chunk));
        response.on("end", () =>
          fail(new Error(`POST ${options.url} returned ${status}: ${Buffer.concat(parts)}`)),
        );
        response.on("error", fail);
        return;
      }
      // `setEncoding` rather than decoding per chunk: it holds back a multi-byte
      // character split across a chunk boundary instead of emitting two
      // replacement characters.
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        queue.push(chunk);
        wake();
      });
      response.on("end", () => {
        finished = true;
        wake();
      });
      response.on("error", fail);
    },
  );
  request.on("error", fail);

  const onAbort = () => request.destroy(new Error("aborted"));
  options.signal.addEventListener("abort", onAbort, { once: true });
  request.end(payload);

  try {
    while (true) {
      while (queue.length > 0) {
        const chunk = queue.shift();
        if (chunk) yield chunk;
      }
      if (failure) throw failure;
      if (finished) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    request.destroy();
  }
}
