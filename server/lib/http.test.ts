import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { post } from "./http";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base = "";
let handler: Handler = (_req, res) => res.end();

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A hang has to fail here, with a message, rather than at bun's test timeout. */
function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`post did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, hung]).finally(() => clearTimeout(timer));
}

function request(signal = new AbortController().signal) {
  return post({
    url: `${base}/v1/test`,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
    signal,
  });
}

describe("post", () => {
  test("a complete reply resolves with its status and body", async () => {
    const body = JSON.stringify({ ok: true, text: "copy" });
    handler = (req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
    };
    const reply = await settledWithin(request(), 2000);
    expect(reply.status).toBe(200);
    expect(reply.ok).toBe(true);
    expect(reply.text()).toBe(body);
  });

  test("a reply cut off mid-body rejects promptly instead of hanging", async () => {
    handler = (req, res) => {
      req.resume();
      res.writeHead(200, { "content-length": "1000" });
      res.write("partial");
      setTimeout(() => req.socket.destroy(), 20);
    };
    let outcome: string;
    try {
      await settledWithin(request(), 2000);
      outcome = "resolved";
    } catch (err) {
      outcome = (err as Error).message;
    }
    expect(outcome).not.toBe("resolved");
    expect(outcome).not.toContain("did not settle");
  });

  test("aborting while the server sits on the request rejects", async () => {
    handler = (req) => {
      req.resume();
    };
    const controller = new AbortController();
    const pending = settledWithin(request(controller.signal), 2000);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow("aborted");
  });
});
