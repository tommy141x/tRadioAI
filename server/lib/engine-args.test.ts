/**
 * The flags each local engine is started with.
 *
 * These are a compatibility contract with two upstream binaries, and one of
 * them shipped as an outage: whisper-server was started with `--convert`, which
 * makes it shell out to ffmpeg. ffmpeg is absent from the slim Debian images
 * most FiveM game panels run on, and whisper then exits 0 during startup having
 * printed only `sh: 1: ffmpeg: not found`. What the operator saw was
 * "transcription is unavailable: local transcription engine stopped while
 * loading" — a message naming neither ffmpeg nor the remedy. Two customers lost
 * their AI dispatcher to it, and one of them had 125 GB of RAM, so every
 * resource-shaped theory was wrong.
 *
 * The flag was never doing anything: tRadio's transmission tap hands over mono 16-bit
 * WAV at STT_SAMPLE_RATE, and `tradio-hooks.ts` refuses a WAV at any other rate, so
 * whisper receives the one format it reads natively on every request.
 *
 * So these cases pin the flags rather than the behaviour. A behavioural test
 * cannot reach them — it would need the real binaries, a real model and a free
 * port on a machine without ffmpeg, which is precisely the environment we do not
 * have and the customers do.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { STT_SAMPLE_RATE } from "./tradio-hooks";
import { configureLocal, launchFor } from "./local-engine";

const ROOT = path.join(import.meta.dir, "..", "..");

function argsFor(capability: "transcription" | "text"): string[] {
  configureLocal({ root: ROOT });
  const launch = launchFor(capability);
  return launch.args(launch.model ?? "model.bin", 18291);
}

describe("the transcription engine's flags", () => {
  test("does NOT pass --convert, which would require ffmpeg", () => {
    // THE REGRESSION. Re-adding this re-introduces a hard dependency on a
    // binary that is not present on a typical game panel, and the failure it
    // produces does not name ffmpeg anywhere.
    expect(argsFor("transcription")).not.toContain("--convert");
  });

  test("still passes everything the server needs to start", () => {
    // CONTROL for the case above: asserting only the ABSENCE of a flag would
    // pass just as happily against an empty argument list, which would be a
    // far worse bug and one that never starts the engine at all.
    const args = argsFor("transcription");
    for (const flag of ["--model", "--host", "--port", "--threads"]) {
      expect(args).toContain(flag);
    }
    expect(args[args.indexOf("--port") + 1]).toBe("18291");
  });

  test("the format we send is the one whisper reads without converting", () => {
    // The reason --convert is unnecessary, asserted rather than trusted. If
    // this rate ever moves off whisper's native 16 kHz, the flag's removal
    // stops being safe and this fails next to the case that depends on it.
    expect(STT_SAMPLE_RATE).toBe(16000);
  });
});

describe("the text engine's flags", () => {
  test("still passes everything the server needs to start", () => {
    const args = argsFor("text");
    for (const flag of ["--model", "--host", "--port"]) {
      expect(args).toContain(flag);
    }
  });
});
