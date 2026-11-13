/**
 * The "stopped while loading" failure says why it probably happened.
 *
 * That message named the symptom and nothing else, and the cause is nearly
 * always the same: the box has no room for the model. Three operators reported
 * it on 2026-10-19 alone. The one who sent a screenshot had 0.8 GB free against
 * a 1.3 GB text model, while the panel correctly told him every model file was
 * installed — nothing he could read mentioned memory.
 *
 * It REPORTS and does not refuse, which is the property the last case pins. A
 * pre-flight check that blocked the launch would be wrong on Linux, where
 * `freemem()` excludes reclaimable page cache and reads far below what is really
 * available; it would turn working servers away.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { memoryNote } from "./local-engine";

const dir = mkdtempSync(path.join(tmpdir(), "tradio-memnote-"));

function modelOf(bytes: number): string {
  const p = path.join(dir, `model-${bytes}.gguf`);
  writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

describe("the memory note on a load failure", () => {
  test("reports the model size and the machine's free and total RAM", () => {
    const note = memoryNote(modelOf(3 * 1024 * 1024));
    expect(note).toContain("GB RAM free of");
    expect(note).toContain("this model is 0.0 GB");
    expect(note).toMatch(/\d+\.\d GB RAM free of \d+\.\d GB/);
  });

  test("says what to do about it, not just what happened", () => {
    // The line exists to end a support round trip, so it has to carry the
    // remedy. Without this a future edit could trim it back to two numbers.
    const note = memoryNote(modelOf(1024));
    expect(note).toContain("hosted provider");
  });

  test("degrades to nothing when the model cannot be measured", () => {
    // CONTROL. A missing file must fall back to the old message rather than
    // invent a number — a wrong memory figure in a failure line is worse than
    // no figure, because it sends the operator after the wrong thing.
    expect(memoryNote(path.join(dir, "does-not-exist.gguf"))).toBe("");
  });
});
