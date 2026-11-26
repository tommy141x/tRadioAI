/**
 * A runtime or model that is missing is asked about again on every start, because
 * `tradioai_download` installs it while the resource is running. Remembered as a
 * verdict, one transmission heard before the download wrote the capability off until
 * the next restart.
 */

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  configureLocal,
  launchFor,
  localEndpoint,
  localFailure,
  stopLocalEngines,
} from "./local-engine";
import { aiLog } from "./logger";

const globals = globalThis as unknown as Record<string, unknown>;
const hadExports = "exports" in globals;
const savedExports = globals.exports;
let tmp = "";

beforeAll(() => {
  // No tLib: nothing to adopt and no spawn broker, whatever another suite left here.
  globals.exports = {};
  tmp = mkdtempSync(path.join(tmpdir(), "tradioai-absent-"));
  configureLocal({ root: tmp });
});

afterAll(() => {
  stopLocalEngines();
  configureLocal({});
  if (hadExports) globals.exports = savedExports;
  else delete globals.exports;
  rmSync(tmp, { recursive: true, force: true });
});

test("a missing runtime is re-checked on the next start, and warned about once", async () => {
  const warn = spyOn(aiLog, "warn").mockImplementation(() => {});
  try {
    expect(await localEndpoint("text")).toBeNull();
    expect(localFailure("text")).toContain("no local runtime");
    expect(await localEndpoint("text")).toBeNull();
    const runtimeWarnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes("no local runtime"),
    );
    expect(runtimeWarnings).toHaveLength(1);

    const binary = launchFor("text").binary;
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(binary, "");
    const model = path.join(tmp, "server", "models", "qwen3-4b-instruct-2507-q4_k_m.gguf");
    mkdirSync(path.dirname(model), { recursive: true });
    writeFileSync(model, "");

    expect(await localEndpoint("text")).toBeNull();
    const failure = localFailure("text");
    expect(failure).not.toBe("");
    expect(failure).not.toContain("no local runtime");
    expect(failure).not.toContain("model installed");
  } finally {
    warn.mockRestore();
  }
}, 15_000);
