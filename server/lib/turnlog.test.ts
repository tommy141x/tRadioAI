import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describeTurn, finishTurn, recordOutcomes, setTurnLogFile, startTurn } from "./turnlog";
import type { AiTurnContext } from "./types";

let scratch = "";
let file = "";

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "tradio-turnlog-"));
  file = path.join(scratch, "logs", "ai-dispatch.jsonl");
  setTurnLogFile(file);
});

afterEach(() => {
  setTurnLogFile(null);
  rmSync(scratch, { recursive: true, force: true });
});

function lines(): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const context = {
  channelName: "PD-1",
  callsign: "K31",
  unitId: "1234",
  serverId: 7,
} as AiTurnContext;

describe("the turn journal", () => {
  test("distinguishes response-start latency from completed airtime", () => {
    const journal = startTurn("transmission", 850, 7);
    expect(journal.responseStartMs).toBeNull();
    expect(journal.stages).toEqual({});
    journal.responseStartMs = 1250;
    journal.stages.transcription = 320;
    journal.stages.decision = 610;
    finishTurn(journal);
    expect(lines()[0]).toMatchObject({
      responseStartMs: 1250,
      stages: { transcription: 320, decision: 610 },
    });
  });
  test("records what was heard, what was done and what aired", () => {
    const journal = startTurn("transmission", 850, 7);
    describeTurn(journal, context);
    journal.heard = "dispatch k31 show me out at grove";
    journal.addressed = true;
    recordOutcomes(journal, [
      { tool: "setunitstatus", input: "10-6", ok: true, message: "status set" },
    ]);
    journal.reply = "K31 copy, out at Grove.";
    journal.aired = true;
    finishTurn(journal);

    const [entry] = lines();
    expect(entry).toMatchObject({
      trigger: "transmission",
      frequency: 850,
      channel: "PD-1",
      unit: "K31",
      heard: "dispatch k31 show me out at grove",
      addressed: true,
      reply: "K31 copy, out at Grove.",
      aired: true,
    });
    expect(entry.actions).toEqual([
      { tool: "setunitstatus", input: "10-6", ok: true, message: "status set" },
    ]);
    // Elapsed time is what turns "it answered" into "it answered in eleven seconds".
    expect(typeof entry.ms).toBe("number");
  });

  test("a turn that said nothing records why", () => {
    const journal = startTurn("transmission", 850, 7);
    describeTurn(journal, context);
    journal.heard = "k31 to k32 you on?";
    journal.skipped = "not addressed to dispatch";
    finishTurn(journal);

    expect(lines()[0]).toMatchObject({ addressed: false, skipped: "not addressed to dispatch" });
  });

  test("a failure is kept rather than lost with the turn", () => {
    const journal = startTurn("transmission", 850, 7);
    journal.heard = "dispatch";
    journal.addressed = true;
    journal.error = "timed out after 20000ms";
    finishTurn(journal);

    expect(lines()[0]?.error).toBe("timed out after 20000ms");
  });

  test("turns append rather than replacing each other", () => {
    for (const said of ["one", "two", "three"]) {
      const journal = startTurn("transmission", 850, 7);
      journal.heard = said;
      finishTurn(journal);
    }
    expect(lines().map((entry) => entry.heard)).toEqual(["one", "two", "three"]);
  });

  test("an unwritable journal does not take the turn down with it", () => {
    // A directory where the file should be: every write fails, forever.
    setTurnLogFile(scratch);
    const journal = startTurn("transmission", 850, 7);
    journal.heard = "dispatch k31";
    expect(() => finishTurn(journal)).not.toThrow();
  });
});
