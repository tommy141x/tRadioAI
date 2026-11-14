/**
 * Fetch the local inference ENGINES this server actually needs, and only those.
 *
 * The sibling of `weights.ts`, deliberately shaped the same way and reusing the
 * same tLib machinery, because it is the same problem one step earlier: the
 * weights stopped being bundled when they reached 2.5 GB, and the engines that
 * load them are 117.5 MB of a 146 MB download for a feature whose default is
 * `enabled: false`. A server that sends `text` to Groq has no use for a
 * llama.cpp build, and every customer was paying for all six.
 *
 * ## Where the bytes come from
 *
 * Upstream, and only upstream. Nothing is mirrored by this project. The six
 * archives are pinned to upstream github.com URLs in
 * `local-engine.lock.json`; what changes here is WHEN they are fetched, not
 * from where. `scripts/vendor-local-engine.ts` still does it at release time
 * for a development tree, from the same pins.
 *
 * The accepted cost is that upstream may delete a release asset. `pins:check`
 * runs weekly so that is our Monday morning rather than a customer's failed
 * install, and `explainFetchFailure` makes the runtime symptom legible when it
 * happens anyway.
 *
 * ## What is downloaded
 *
 * Decided from the RESOLVED provider plan and the host platform, never from the
 * declared configuration — the same rule `weights.ts` documents at length.
 * `providers.ts` falls back to local for every way a configuration can be
 * wrong, including a hosted provider whose key is absent, so selecting on the
 * raw config would skip the download and then fall back onto an engine that is
 * not there.
 *
 * One platform's archives, not both: `local-engine.ts`'s `binDir` resolves
 * `server/bin/<win|linux>/<engine>` from `process.platform`, so the other
 * platform's copy could never be executed. That is the difference between a
 * ~48 MB install and a 98 MB one.
 *
 * Nothing here blocks the radio. Channels, trunking, 3D audio and the panel
 * come up regardless; only AI Dispatching waits on this.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AssetOutcome,
  type EnsureReport,
  ensureAssets,
  type PinnedAsset,
} from "./assets/index.ts";
import { aiLog } from "./logger";
import { discardUnpacked, unpackArchive } from "./archive";
import { type Capability, localCapabilities, type ProviderPlan } from "./providers";

/** The lockfile's `archives` entries, which are `PinnedAsset` plus unpack detail. */
export interface PinnedArchive extends PinnedAsset {
  engine: string;
  platform: "win" | "linux";
  /** `--strip-components`: the leading path segments to drop. */
  strip: number;
  /** A path that must exist after unpacking, relative to the engine directory. */
  expect: string;
}

export interface EngineInstallResult extends EnsureReport {
  requested: PinnedArchive[];
  /** Capabilities that cannot be served locally because an engine failed. */
  unavailable: Capability[];
}

/** `win` or `linux`, the two names the lockfile and `binDir` both use. */
export function hostPlatform(): "win" | "linux" {
  return process.platform === "win32" ? "win" : "linux";
}

/**
 * Parse one archive entry.
 *
 * Validated field by field rather than cast, because this file is the only
 * thing between a hand-edited lockfile and a download: a missing `bytes` would
 * disable tLib's mid-stream size cap, and a missing `strip` would unpack the
 * archive's wrapper directory so that `binDir` resolves to an empty folder and
 * the engine appears not to have installed.
 */
export function parseArchive(raw: unknown): PinnedArchive {
  const a = raw as Record<string, unknown>;
  const str = (key: string): string => {
    const value = a[key];
    if (typeof value !== "string" || value === "") {
      throw new Error(`archive entry is missing a '${key}'`);
    }
    return value;
  };
  const num = (key: string): number => {
    const value = a[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`archive '${String(a.id)}' is missing a numeric '${key}'`);
    }
    return value;
  };
  const platform = str("platform");
  if (platform !== "win" && platform !== "linux") {
    throw new Error(`archive '${String(a.id)}' has platform '${platform}', not win or linux`);
  }
  return {
    id: str("id"),
    dest: str("dest"),
    url: str("url"),
    sha256: str("sha256"),
    bytes: num("bytes"),
    capability: str("capability"),
    engine: str("engine"),
    platform,
    strip: num("strip"),
    expect: str("expect"),
  };
}

/** Every archive in the lockfile, parsed. Throws on a malformed one. */
export function readArchives(root: string): PinnedArchive[] {
  const path = join(root, "server", "local-engine.lock.json");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const archives = (raw as { archives?: unknown }).archives;
  if (!Array.isArray(archives)) {
    throw new Error("local-engine.lock.json has no 'archives' array");
  }
  return archives.map(parseArchive);
}

/**
 * The archives this server needs: the locally-served capabilities, on this
 * platform.
 *
 * Not `selectAssets`: that filters on capability alone, and an archive is also
 * specific to an OS. Selecting on capability only would download both
 * platforms' copies, which is the bulk this change exists to remove.
 */
export function archivesFor(
  all: readonly PinnedArchive[],
  plan: ProviderPlan,
  platform = hostPlatform(),
): PinnedArchive[] {
  const wanted = new Set<string>(localCapabilities(plan));
  return all.filter((a) => a.platform === platform && wanted.has(a.capability ?? ""));
}

/** Where an engine's binaries live. The same join `local-engine.ts`'s `binDir` makes. */
export function engineDir(root: string, archive: PinnedArchive): string {
  return join(root, "server", "bin", archive.platform, archive.engine);
}

/**
 * Is this engine already installed?
 *
 * Keyed on the file the launcher will actually execute, not on the directory
 * existing: a half-unpacked tree, or one an FTP client damaged, is a directory
 * with contents and no usable binary. Cheap enough to run on every boot.
 */
export function isInstalled(root: string, archive: PinnedArchive): boolean {
  return existsSync(join(engineDir(root, archive), archive.expect));
}

/**
 * Turn a failed fetch into something an operator can act on.
 *
 * The two failures that actually happen are indistinguishable from the error
 * text alone, and they have opposite fixes: upstream pruned the release (we
 * bump a pin and ship), or the host cannot reach github.com (they open it, or
 * they move the capability to a hosted provider and need none of this).
 */
export function explainFetchFailure(archive: PinnedArchive, error: Error): string {
  const base =
    `engine ${archive.id} could not be installed: ${error.message}\n` + `  from ${archive.url}`;
  if (/\b404\b|not found/i.test(error.message)) {
    return (
      `${base}\n  That is upstream having removed this build. It is not a problem with your ` +
      "server, and re-running will not fix it — the pin has to be updated in a tRadioAI " +
      "release. Until then, set a hosted provider for this capability in config.lua."
    );
  }
  return (
    `${base}\n  Your server could not reach the file. Check outbound HTTPS to github.com, ` +
    "or set a hosted provider for this capability in config.lua and nothing needs to " +
    "be downloaded at all."
  );
}

/**
 * Ensure the locally-served capabilities have their engines installed.
 *
 * Resolves rather than throws, matching `ensureWeights`: a failure means AI
 * Dispatching is degraded, not that the radio is broken, and the caller needs
 * the detail to say which capability went and why.
 */
export async function ensureEngines(
  root: string,
  plan: ProviderPlan,
  signal?: AbortSignal,
): Promise<EngineInstallResult> {
  const requested = archivesFor(readArchives(root), plan);
  const empty: EngineInstallResult = {
    outcomes: [],
    ok: true,
    bytesFetched: 0,
    requested: [],
    unavailable: [],
  };
  if (requested.length === 0) {
    aiLog.info("engines: nothing to install — every capability is served by a hosted provider");
    return empty;
  }

  // Already-installed engines are not re-fetched and not re-unpacked. The
  // archive itself may well have been deleted from server/.cache after a
  // previous install, which is fine and is why this is keyed on the unpacked
  // binary rather than on the archive being present.
  const missing = requested.filter((a) => !isInstalled(root, a));
  for (const a of requested) {
    if (!missing.includes(a)) aiLog.info(`engines: ${a.id} already installed`);
  }
  if (missing.length === 0) return { ...empty, requested };

  const report = await ensureAssets(root, missing, {
    signal,
    onAsset: (outcome) => {
      if (outcome.status === "failed") return; // reported with its explanation below
      aiLog.info(`engines: ${outcome.id} archive ${outcome.status}`);
    },
  });

  const outcomes: AssetOutcome[] = [];
  const unavailable = new Set<Capability>();

  for (const archive of missing) {
    const fetched = report.outcomes.find((o) => o.id === archive.id);
    if (!fetched || fetched.status === "failed") {
      const error = fetched?.error ?? new Error("archive was not fetched");
      aiLog.error(explainFetchFailure(archive, error));
      outcomes.push({ id: archive.id, dest: archive.dest, status: "failed", error });
      unavailable.add(archive.capability as Capability);
      continue;
    }

    // ⚠️ ORDER. `ensureAssets` has verified the archive's sha256 by this point,
    // and the unpack must not start before it: a reader walking entries out of
    // unverified bytes is doing exactly what the pin exists to prevent.
    const dir = engineDir(root, archive);
    try {
      const unpacked = unpackArchive(join(root, archive.dest), dir, archive.strip);
      if (!isInstalled(root, archive)) {
        throw new Error(
          `${archive.expect} is not in the unpacked archive — upstream moved or renamed it`,
        );
      }
      aiLog.info(
        `engines: ${archive.id} installed — ${unpacked.files} file(s), ` +
          `${unpacked.linkCopies} link(s) copied -> server/bin/${archive.platform}/${archive.engine}/`,
      );
      outcomes.push({ id: archive.id, dest: archive.dest, status: fetched.status });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // A partially unpacked directory is worse than an absent one: `isInstalled`
      // could start answering true for a tree with no usable binary in it, and
      // then nothing would ever retry the install.
      discardUnpacked(dir);
      aiLog.error(`engines: ${archive.id} FAILED to unpack — ${error.message}`);
      outcomes.push({ id: archive.id, dest: archive.dest, status: "failed", error });
      unavailable.add(archive.capability as Capability);
    }
  }

  return {
    outcomes,
    ok: unavailable.size === 0,
    bytesFetched: report.bytesFetched,
    requested,
    unavailable: [...unavailable],
  };
}
