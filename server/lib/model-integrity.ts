/**
 * Reading the weight pins, and checking a model file actually matches its pin.
 *
 * ## Why this is a separate module
 *
 * `weights.ts` owns downloading and imports `resourceRoot` from `local-engine.ts`;
 * `local-engine.ts` needs the integrity check on its failure path. Putting the
 * check in `weights.ts` would make that a cycle. Both now depend on this, and
 * this depends on neither.
 *
 * ## Why the check is on the failure path and not at boot
 *
 * "Ready — every model file this configuration needs is installed" is weaker
 * than it reads, and a customer found the gap. `missingAssets` treats a file as
 * present when a `.pin.json` marker vouches for it (hash, size and mtime all
 * matching, which does prove a verified download that has not been touched
 * since) OR when it is merely the right SIZE with no marker at all. The second
 * case is deliberate and correct for what it was written for — a file that
 * shipped inside the release, or one whose marker was lost to a copy — because
 * re-fetching 2.5 GB on every restart to prove a byte nobody suspects is
 * indefensible.
 *
 * The cost is that a file which is the right size and the wrong bytes is
 * reported Ready, forever, and the only symptom is the engine dying as it
 * loads. That is not hypothetical: the install docs warn that an FTP client in
 * ASCII mode damages files anywhere in the resource, and that is exactly the
 * kind of damage that can preserve a length.
 *
 * So the hash runs when an engine has ALREADY failed to start. At that point we
 * are answering "why", a few seconds of I/O costs nothing, and the answer is
 * either "your model file is corrupt, delete it and restart" or a definitive
 * "the file is fine, stop looking here" — which is worth as much, because it is
 * what sends the next person to look at the binary instead.
 */

import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type PinnedAsset, parseAsset } from "./assets/index.ts";

export const LOCKFILE = join("server", "local-engine.lock.json");

/** The pinned weights for this resource. Throws if the lockfile is unreadable. */
export function readPins(root: string): PinnedAsset[] {
  const raw: unknown = JSON.parse(readFileSync(join(root, LOCKFILE), "utf8"));
  const weights = (raw as { weights?: unknown }).weights;
  if (!Array.isArray(weights)) throw new Error(`${LOCKFILE} has no 'weights' array`);
  return weights.map(parseAsset);
}

export interface IntegrityVerdict {
  /** False when no verdict could be reached — no pin, unreadable lockfile, I/O error. */
  checked: boolean;
  /** Only meaningful when `checked`. */
  intact: boolean;
  /** Operator-facing sentence, or "" when there is nothing worth saying. */
  note: string;
}

/** No verdict. Exported so a caller that skips the check has one shape to use. */
export const UNCHECKED: IntegrityVerdict = { checked: false, intact: false, note: "" };

async function sha256Of(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  // Streamed rather than read whole: the text model is 2.5 GB and this runs
  // inside the server process.
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Does the file at `modelPath` match the pin that put it there?
 *
 * Returns `checked: false` rather than guessing whenever the question cannot be
 * answered — an unpinned path, a lockfile that will not parse, a read error.
 * A wrong verdict in a failure message is worse than no verdict: it sends the
 * operator to delete a file that was never the problem.
 */
export async function verifyPinnedModel(
  root: string,
  modelPath: string,
): Promise<IntegrityVerdict> {
  let pins: PinnedAsset[];
  try {
    pins = readPins(root);
  } catch {
    return UNCHECKED;
  }

  // Matched on the resolved path, because the pin's `dest` is relative to the
  // resource root with forward slashes while the caller holds an absolute,
  // platform-separated path.
  const target = resolve(modelPath);
  const pin = pins.find((asset) => resolve(join(root, asset.dest)) === target);
  if (!pin) return UNCHECKED;

  try {
    const actual = await sha256Of(target);
    if (actual.toLowerCase() === pin.sha256.toLowerCase()) {
      return {
        checked: true,
        intact: true,
        note:
          `. The model file is intact (sha256 matches ${pin.id}), so this is not a bad ` +
          "download — look at the engine binary and its libraries rather than the model",
      };
    }
    return {
      checked: true,
      intact: false,
      note:
        `. THE MODEL FILE IS CORRUPT: ${pin.dest} is the expected size but its contents do ` +
        "not match the checksum it was pinned at. Delete that file and restart the resource " +
        "— it will be downloaded again and verified. Transferring the resource with an FTP " +
        "client in ASCII mode is the usual cause",
    };
  } catch {
    return UNCHECKED;
  }
}
