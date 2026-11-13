/**
 * A dead engine's failure message carries the engine's own words.
 *
 * `local transcription engine stopped while loading` named the symptom and
 * nothing else. The engine had printed exactly why on the way down — a missing
 * DLL, a bad model header, an instruction set the CPU lacks — and tRadio threw
 * it away twice over: the liveness poll read the broker's output every 250 ms
 * only to learn `alive`, and the failure path then called `kill()`, which routes
 * through `SpawnUnserve` and DELETES the broker's retained record, before
 * building the message that needed it.
 *
 * A customer with 128 GB of RAM hit this on 2026-10-20 and the ticket had
 * nothing in it to diagnose: the only theory anyone could offer was memory, and
 * his machine disproved it.
 *
 * The ordering is the whole fix, so `the record is read before it is deleted`
 * below is the case that matters. Its fake broker wipes its buffer on unserve
 * exactly like the real one, so a future edit that kills first cannot pass.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { engineSaid, exitNote } from "./local-engine";
import { launchServer, type Postmortem } from "./spawn";

interface Line {
  stream: string;
  text: string;
}

/**
 * Stands in for tLib's spawn broker, including the one behaviour that caused
 * the bug: `SpawnUnserve` drops the record, so output read after a kill is gone.
 */
function fakeBroker(lines: Line[], code: number | null) {
  let served = true;
  const calls: string[] = [];
  const tlib = {
    SpawnServe: () => {
      calls.push("serve");
      return JSON.stringify({ pid: 4242 });
    },
    SpawnOutput: (_key: string, since: number) => {
      calls.push(`output:${since}`);
      if (!served) return JSON.stringify({ lines: [], next: 0, alive: false, code: null });
      return JSON.stringify({ lines, next: lines.length, alive: false, code });
    },
    SpawnUnserve: () => {
      calls.push("unserve");
      served = false;
      return true;
    },
    SpawnRun: () => "{}",
    SpawnJob: () => "{}",
    SpawnCancel: () => true,
  };
  (globalThis as { exports?: Record<string, unknown> }).exports = { tLib: tlib };
  return { calls };
}

function start() {
  const started = launchServer({
    key: "transcription",
    program: "whisper-server",
    args: [],
    env: {},
  });
  if ("error" in started) throw new Error(`launch failed: ${started.error}`);
  return started;
}

describe("reading why an engine died", () => {
  test("returns the stderr lines and the exit code", () => {
    fakeBroker(
      [
        { stream: "stdout", text: "loading model" },
        { stream: "stderr", text: "error: failed to open ggml-base.en.bin" },
      ],
      1
    );
    const why = start().postmortem();
    expect(why.stderr).toEqual(["error: failed to open ggml-base.en.bin"]);
    expect(why.code).toBe(1);
  });

  test("keeps stderr and drops stdout", () => {
    // stdout is a progress log; stderr is the diagnosis. Mixing them in buries
    // the one line that matters under a tensor table.
    fakeBroker(
      [
        { stream: "stdout", text: "noise one" },
        { stream: "stderr", text: "the real reason" },
        { stream: "stdout", text: "noise two" },
      ],
      3221225781
    );
    expect(start().postmortem().stderr).toEqual(["the real reason"]);
  });

  test("a read after the kill gets nothing, which is what the bug was", () => {
    fakeBroker([{ stream: "stderr", text: "last words" }], 139);
    const engine = start();
    expect(engine.postmortem().stderr).toEqual(["last words"]);
    engine.kill();
    // The broker's unserve drops the buffer. This is the whole reason the
    // order at the call site matters, and it is asserted here so the
    // source-order case below is testing against a real consequence rather
    // than a style preference.
    expect(engine.postmortem().stderr).toEqual([]);
  });

  test("startEngine reads the postmortem before it kills the child", () => {
    // THE REGRESSION, and it has to be checked against the source.
    //
    // A behavioural test cannot reach it: `startEngine` needs a real binary, a
    // real model file and a free port before it can fail the way this guards,
    // and faking all three would be testing the fake. What went wrong was one
    // statement being in the wrong place, so that is what is pinned.
    //
    // Scoped to the `!ready` block rather than the file, because `kill()` is
    // called on three other paths where no postmortem is wanted — matching the
    // whole file would pass on the wrong `kill`.
    const source = readFileSync(new URL("./local-engine.ts", import.meta.url), "utf8");
    const block = source.slice(
      source.indexOf("  if (!ready) {"),
      source.indexOf("  engines.set(capability,")
    );
    expect(block).toContain("started.postmortem()");
    expect(block).toContain("started.kill()");
    expect(block.indexOf("started.postmortem()")).toBeLessThan(block.indexOf("started.kill()"));
  });

  test("asks from the start, not from the liveness cursor", () => {
    // The poll has already consumed the lines explaining the failure, so
    // reusing its cursor returns nothing. `0` is load-bearing.
    const { calls } = fakeBroker([{ stream: "stderr", text: "x" }], 1);
    const engine = start();
    engine.alive();
    engine.postmortem();
    expect(calls).toContain("output:0");
  });

  test("survives a broker that answers with nothing usable", () => {
    // CONTROL. A failure message is being built; this must not throw and lose
    // the failure itself.
    (globalThis as { exports?: Record<string, unknown> }).exports = {
      tLib: {
        SpawnServe: () => JSON.stringify({ pid: 1 }),
        SpawnOutput: () => "not json",
        SpawnUnserve: () => true,
        SpawnRun: () => "{}",
        SpawnJob: () => "{}",
        SpawnCancel: () => true,
      },
    };
    expect(start().postmortem()).toEqual({ stderr: [], code: null });
  });
});

const died = (stderr: string[], code: number | null): Postmortem => ({ stderr, code });

describe("the exit code note", () => {
  test("names a missing DLL rather than printing a hex-looking number", () => {
    expect(exitNote(died([], 3221225781))).toContain("DLL it needs is missing");
    expect(exitNote(died([], 3221225781))).toContain("3221225781");
  });

  test("names the CPU for an illegal instruction, on both platforms", () => {
    expect(exitNote(died([], 3221225501))).toContain("instruction set");
    expect(exitNote(died([], 132))).toContain("instruction set");
  });

  test("distinguishes the OOM killer from being short of RAM at launch", () => {
    // 137 is the kernel taking it mid-load, which the free-memory figures
    // cannot show, so it has to be said separately.
    expect(exitNote(died([], 137))).toContain("running out of memory");
  });

  test("prints an unrecognised code bare instead of guessing at it", () => {
    // CONTROL. Every engine exits 1 for its own reasons; glossing that would
    // be inventing a diagnosis, which is the failure this whole change is
    // against. The number must still appear.
    expect(exitNote(died([], 1))).toBe(" (exit 1)");
  });

  test("says nothing at all when there is no code", () => {
    expect(exitNote(died([], null))).toBe("");
  });
});

describe("quoting what the engine said", () => {
  test("quotes the last lines verbatim", () => {
    const note = engineSaid(died(["first", "second", "third", "fourth"], 1));
    expect(note).toContain("fourth");
    expect(note).toContain("It said:");
  });

  test("keeps the end of a chatty loader, not the beginning", () => {
    // llama-server prints a tensor table before it fails. The useful line is
    // always last.
    const note = engineSaid(died(["t1", "t2", "t3", "t4", "t5", "the actual error"], 1));
    expect(note).toContain("the actual error");
    expect(note).not.toContain("t1");
  });

  test("adds nothing when the engine said nothing", () => {
    // CONTROL. A silent death must leave the message as it was rather than
    // appending an empty "It said:".
    expect(engineSaid(died([], 1))).toBe("");
    expect(engineSaid(died(["", "   "], 1))).toBe("");
  });
});
