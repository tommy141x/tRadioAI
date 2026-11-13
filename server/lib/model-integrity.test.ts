/**
 * The integrity check that runs after an engine dies.
 *
 * "Ready — every model file this configuration needs is installed" is a SIZE
 * check. A file with the right length and the wrong bytes is reported installed
 * forever, and the only symptom is the engine dying as it loads — which is how a
 * customer with 128 GB of RAM ended up with a ticket nobody could diagnose.
 *
 * Both verdicts have to be trustworthy. "Corrupt" sends someone to delete a
 * 2.5 GB file, and "intact" sends them away from the model and towards the
 * binary; a wrong answer either way costs more than no answer, which is why
 * every case below that cannot be decided asserts `checked: false` rather than
 * a default.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPins, UNCHECKED, verifyPinnedModel } from "./model-integrity";

const DEST = "server/models/test-model.bin";

/** A resource root with a lockfile pinning one asset, and optionally that file. */
function rootWith(contents: string | null, pinnedTo?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "tradio-integrity-"));
  mkdirSync(path.join(root, "server"), { recursive: true });
  mkdirSync(path.join(root, "server", "models"), { recursive: true });

  if (contents !== null) {
    writeFileSync(path.join(root, DEST), contents);
  }
  const sha =
    pinnedTo ??
    createHash("sha256")
      .update(contents ?? "")
      .digest("hex");
  writeFileSync(
    path.join(root, "server", "local-engine.lock.json"),
    JSON.stringify({
      weights: [
        {
          id: "transcription",
          dest: DEST,
          url: "https://example.invalid/model.bin",
          sha256: sha,
          bytes: (contents ?? "").length,
          capability: "transcription",
        },
      ],
    }),
  );
  return root;
}

describe("verifying a model against its pin", () => {
  test("says the file is intact when the hash matches", async () => {
    const root = rootWith("the real model bytes");
    const verdict = await verifyPinnedModel(root, path.join(root, DEST));
    expect(verdict.checked).toBe(true);
    expect(verdict.intact).toBe(true);
    expect(verdict.note).toContain("not a bad download");
  });

  test("an intact verdict points away from the model, not just 'fine'", async () => {
    // The value of "intact" is that it ENDS a line of enquiry. Without this the
    // note could be trimmed to a bare pass and stop being actionable.
    const root = rootWith("the real model bytes");
    const { note } = await verifyPinnedModel(root, path.join(root, DEST));
    expect(note).toContain("engine binary");
  });

  test("catches a file of the right size with the wrong bytes", async () => {
    // THE CASE THIS EXISTS FOR. Same length, different content — exactly what
    // the size check cannot see and what an ASCII-mode transfer produces.
    const intact = "the real model bytes";
    const corrupt = "the fake model bytes";
    expect(corrupt.length).toBe(intact.length);

    const root = rootWith(corrupt, createHash("sha256").update(intact).digest("hex"));
    const verdict = await verifyPinnedModel(root, path.join(root, DEST));
    expect(verdict.checked).toBe(true);
    expect(verdict.intact).toBe(false);
    expect(verdict.note).toContain("CORRUPT");
  });

  test("a corrupt verdict says what to do about it", async () => {
    const root = rootWith("wrong", createHash("sha256").update("right").digest("hex"));
    const { note } = await verifyPinnedModel(root, path.join(root, DEST));
    expect(note).toContain("Delete that file and restart");
    expect(note).toContain(DEST);
  });

  test("hashes the contents rather than trusting the recorded size", async () => {
    // CONTROL. If this compared `bytes` it would pass the corrupt case above,
    // since the sizes are equal by construction. Pin a size that is wrong and a
    // hash that is right: the verdict must follow the hash.
    const root = mkdtempSync(path.join(tmpdir(), "tradio-integrity-size-"));
    mkdirSync(path.join(root, "server"), { recursive: true });
    mkdirSync(path.join(root, "server", "models"), { recursive: true });
    writeFileSync(path.join(root, DEST), "abc");
    writeFileSync(
      path.join(root, "server", "local-engine.lock.json"),
      JSON.stringify({
        weights: [
          {
            id: "transcription",
            dest: DEST,
            url: "https://example.invalid/m.bin",
            sha256: createHash("sha256").update("abc").digest("hex"),
            bytes: 999999,
            capability: "transcription",
          },
        ],
      }),
    );
    const verdict = await verifyPinnedModel(root, path.join(root, DEST));
    expect(verdict.intact).toBe(true);
  });
});

describe("refusing to guess", () => {
  test("no verdict for a path that is not pinned", async () => {
    const root = rootWith("x");
    expect(await verifyPinnedModel(root, path.join(root, "server/models/other.bin"))).toEqual(
      UNCHECKED,
    );
  });

  test("no verdict when the file is missing", async () => {
    const root = rootWith(null, "a".repeat(64));
    expect((await verifyPinnedModel(root, path.join(root, DEST))).checked).toBe(false);
  });

  test("no verdict when the lockfile will not parse", async () => {
    const root = rootWith("x");
    writeFileSync(path.join(root, "server", "local-engine.lock.json"), "{ not json");
    expect((await verifyPinnedModel(root, path.join(root, DEST))).checked).toBe(false);
  });

  test("an undecidable case contributes nothing to the message", async () => {
    // CONTROL. The note is concatenated straight into a failure line, so an
    // unreachable verdict must be empty rather than "could not be checked" —
    // the surrounding message already says what failed.
    const root = rootWith("x");
    const verdict = await verifyPinnedModel(root, path.join(root, "server/models/nope.bin"));
    expect(verdict.note).toBe("");
  });
});

describe("reading the pins", () => {
  test("rejects a lockfile with no weights array", () => {
    const root = mkdtempSync(path.join(tmpdir(), "tradio-pins-"));
    mkdirSync(path.join(root, "server"), { recursive: true });
    writeFileSync(path.join(root, "server", "local-engine.lock.json"), JSON.stringify({}));
    expect(() => readPins(root)).toThrow("weights");
  });

  test("reads this repo's real lockfile", () => {
    // Guards the move of `readPins` out of weights.ts: the shipped lockfile
    // must still parse through the new module.
    const pins = readPins(path.join(import.meta.dir, "..", ".."));
    expect(pins.length).toBeGreaterThan(0);
    expect(pins.every((p) => typeof p.sha256 === "string" && p.sha256.length === 64)).toBe(true);
  });
});
