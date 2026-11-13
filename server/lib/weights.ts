/**
 * Fetch the model weights this server actually needs, and only those.
 *
 * The weights are no longer bundled. Together they are 2.5 GB, which pushed the
 * release past adm-zip's 2 GB single-Buffer ceiling, and — more to the point —
 * every customer paid for every model whether or not they loaded it. A server
 * that sends `text` to Groq has no use for a 2.4 GB GGUF.
 *
 * What is fetched is decided from the RESOLVED provider plan, never from the
 * declared configuration. `providers.ts` falls back to local for every way a
 * configuration can be wrong, including a hosted provider whose API key is
 * absent. Selecting on the raw config would skip that download and then fall
 * back onto weights that are not there — trading a clear "AI dispatching is
 * unavailable" for an engine that fails to load at the first transmission.
 *
 * Nothing here blocks the radio. Channels, trunking, 3D audio and the panel come
 * up regardless; only AI Dispatching waits on this.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type AssetOutcome,
  assertSafeDest,
  type EnsureReport,
  ensureAssets,
  formatBytes,
  markerVouchesFor,
  type PinnedAsset,
  parseMarker,
  selectAssets,
  totalBytes,
} from "./assets/index.ts";
import { aiLog } from "./logger";
import { archivesFor, ensureEngines, isInstalled, readArchives } from "./engine-install";
import { LOCKFILE, readPins } from "./model-integrity";
import { resourceRoot } from "./local-engine";
import type { Capability, ProviderPlan } from "./providers";
import { localCapabilities } from "./providers";


/**
 * Where the pins live.
 *
 * Deliberately still `scripts/`, the build tool's directory, rather than copied
 * to a runtime path. It is the single source of truth that
 * `vendor-local-engine.ts` also reads, and two copies of a hash list drift. The
 * release stages this one file out of `scripts/` for that reason; see
 * `scripts/runtime-staging.ts`.
 */

/** Progress is logged at most this often, so a slow link does not flood the console. */
const LOG_INTERVAL_MS = 10_000;

/**
 * The console command that starts the download, named in one place.
 *
 * The failure message used to tell operators to run `radio ai weights`, which
 * was never implemented — so the single line an operator saw when this broke
 * sent them to a command that does not exist. It is registered now (see
 * `registerWeightsCommand`), and both the message and the registration read this
 * constant so they cannot drift apart again.
 */
export const DOWNLOAD_COMMAND = "tradioai_download";

// `localCapabilities` lives in providers.ts now — beside `CAPABILITIES`, and
// importable by the engine installer without the cycle that owning it here
// created. No alias left behind: the three call sites read it from providers.

/**
 * The pinned weights, as declared. Throws on a malformed lockfile: a hash list
 * that cannot be parsed is not something to proceed past quietly.
 */

export interface WeightsResult extends EnsureReport {
  /** What was asked for. Empty when every capability is hosted. */
  requested: PinnedAsset[];
  /** Capabilities that cannot be served locally because an asset failed. */
  unavailable: Capability[];
}

function summarise(outcome: AssetOutcome): void {
  if (outcome.status === "failed") {
    aiLog.error(`weights: ${outcome.id} FAILED — ${outcome.error?.message ?? "unknown error"}`);
    return;
  }
  const verb = { present: "present", verified: "verified", fetched: "downloaded" }[outcome.status];
  aiLog.info(`weights: ${outcome.id} ${verb}`);
}

/**
 * Ensure the locally-served capabilities have their weights.
 *
 * Resolves rather than throws. A failure means AI Dispatching is degraded, not
 * that the radio is broken, and the caller needs the detail to say which
 * capability went and why.
 */
export async function ensureWeights(
  root: string,
  plan: ProviderPlan,
  signal?: AbortSignal
): Promise<WeightsResult> {
  const local = localCapabilities(plan);
  const empty: WeightsResult = {
    outcomes: [],
    ok: true,
    bytesFetched: 0,
    requested: [],
    unavailable: [],
  };

  // Every capability hosted: nothing to fetch, and nothing to say about it.
  // Saying something here would be noise on a correctly-configured server.
  if (local.length === 0) return empty;

  let pins: PinnedAsset[];
  try {
    pins = readPins(root);
  } catch (error) {
    aiLog.error(`weights: cannot read ${LOCKFILE} — ${(error as Error).message}`);
    return { ...empty, ok: false, unavailable: local };
  }

  const requested = selectAssets(pins, local);
  if (requested.length === 0) return empty;

  let lastLog = 0;
  // Bytes finished BEFORE the file currently in flight, so the panel can show one
  // bar for the whole run rather than a bar that restarts on every artifact.
  let completedBytes = 0;
  const overallTotalBytes = totalBytes(requested);
  const report = await ensureAssets(root, requested, {
    signal,
    onAsset: (outcome) => {
      lastLog = 0; // let the next chunk of the following asset log immediately
      const finished = requested.find((asset) => asset.id === outcome.id);
      if (finished) completedBytes += finished.bytes;
      summarise(outcome);
    },
    onProgress: (progress) => {
      if (progress.phase !== "downloading") return;
      // Published every chunk, not every ten seconds: this feeds a progress bar
      // that is polled, and a bar that only moves every ten seconds reads as a
      // stalled download. The ten-second throttle below still governs the
      // CONSOLE, which is a log and not a UI.
      sync.progress = {
        id: progress.id,
        receivedBytes: progress.received,
        totalBytes: progress.size,
        overallReceivedBytes: completedBytes + progress.received,
        overallTotalBytes,
      };
      const now = Date.now();
      if (now - lastLog < LOG_INTERVAL_MS && progress.received < progress.size) return;
      lastLog = now;
      const percent = Math.floor((progress.received / progress.size) * 100);
      aiLog.info(
        `weights: ${progress.id} ${formatBytes(progress.received)} / ` +
          `${formatBytes(progress.size)} (${percent}%)`
      );
    },
  });
  sync.progress = undefined;

  // A capability is unavailable if ANY of its files failed — `speech` needs both
  // voices and both configs, so a partial success is still a broken capability.
  const failedIds = new Set(
    report.outcomes.filter((o) => o.status === "failed").map((outcome) => outcome.id)
  );
  const unavailable = local.filter((capability) =>
    requested.some((asset) => asset.capability === capability && failedIds.has(asset.id))
  );

  return { ...report, requested, unavailable };
}

/** One line naming what is about to happen, before a multi-gigabyte wait begins. */
export function describeIntent(requested: readonly PinnedAsset[]): string | undefined {
  if (requested.length === 0) return undefined;
  return (
    `weights: ${requested.length} artifact(s) needed, ` +
    `${formatBytes(totalBytes(requested))} total — ` +
    "this is a one-time download; the radio is usable meanwhile"
  );
}

/**
 * `needed` is the state this subsystem used to skip straight past.
 *
 * Weights used to download the moment the feature was switched on. Nothing was
 * wrong with the download — it is pinned, hashed and resumable — but it is up to
 * 2.5 GB arriving on someone's game server with no announcement, while the only
 * evidence was a console line every ten seconds. An operator who turned the
 * feature on saw a panel that looked identical and a dispatcher that did not
 * answer, and had no way to tell "downloading" from "broken".
 *
 * So the decision is now the operator's: `needed` means we know exactly what is
 * missing and how big it is, and we are waiting to be told to go.
 */
export type WeightsState = "idle" | "needed" | "working" | "ready" | "degraded";

/** Byte progress for the asset currently in flight, and across the whole run. */
export interface WeightsProgress {
  /** Pin id of the file being fetched, e.g. `text`. */
  id: string;
  receivedBytes: number;
  totalBytes: number;
  /** Bytes finished in this run, including the in-flight file. */
  overallReceivedBytes: number;
  /** Bytes this run will transfer in total. */
  overallTotalBytes: number;
}

interface Sync {
  state: WeightsState;
  /** Which local capabilities the run covered; the key for "has this already run". */
  key: string;
  unavailable: Capability[];
  /** What is missing. Empty unless `needed` or `working`. */
  needed: PinnedAsset[];
  progress?: WeightsProgress;
  controller?: AbortController;
}

let sync: Sync = { state: "idle", key: "", unavailable: [], needed: [] };

/** Current state, for the readiness banner and for gating a dispatch attempt. */
export function weightsState(): { state: WeightsState; unavailable: Capability[] } {
  return { state: sync.state, unavailable: sync.unavailable };
}

/**
 * Everything the admin panel needs to explain this subsystem in one screen.
 *
 * Shaped for display rather than for logic: sizes are pre-totalled and the asset
 * list carries its capability, because the panel shows "Decision model — 2.4 GB"
 * and should not have to join two tables to do it.
 */
export function weightsStatus(): {
  state: WeightsState;
  unavailable: Capability[];
  needed: { id: string; capability: Capability; bytes: number }[];
  neededBytes: number;
  progress?: WeightsProgress;
} {
  return {
    state: sync.state,
    unavailable: sync.unavailable,
    needed: sync.needed.map((asset) => ({
      id: asset.id,
      capability: asset.capability as Capability,
      bytes: asset.bytes,
    })),
    neededBytes: totalBytes(sync.needed),
    progress: sync.progress,
  };
}

/**
 * Which of `assets` are not already usable on disk — without fetching anything.
 *
 * Deliberately the cheap half of `ensureAssets`'s own check: the marker beside
 * the file, or failing that a size match. It does NOT hash. Hashing 2.5 GB to
 * paint a status card would stall the panel for a minute and would be answering
 * a question nobody asked — the hash still runs inside `ensureAssets` before
 * anything is used, so a file that is the right size and the wrong bytes is
 * caught there, where it matters, rather than here.
 *
 * Consequence worth knowing: a corrupt same-size file reports as present here
 * and is re-fetched at download time. That is the right way round. The reverse —
 * reporting a good file as missing — would ask an operator to re-download
 * gigabytes they already have.
 */
export async function missingAssets(
  root: string,
  assets: readonly PinnedAsset[]
): Promise<PinnedAsset[]> {
  const missing: PinnedAsset[] = [];
  // Directory listings, not a probe per file, and the reason is the console
  // rather than the disk: FiveM Enhanced's JS runtime reports HANDLED promise
  // rejections as "Unhandled promise rejection". A `stat(dest).catch(...)` per
  // asset is correct JavaScript and still printed six uncaught-looking ENOENTs
  // on every fresh install — one per artifact nobody has downloaded yet, which
  // is the DEFAULT state of this feature. The same measurement, and the same
  // conclusion, is written up at the model-discovery readdir in http.ts.
  //
  // `existsSync` for the directory: it is the one check with no promise to
  // reject at all, there are two directories here, and this runs once at
  // startup rather than per tick.
  const listings = new Map<string, Set<string> | null>();
  for (const asset of assets) {
    const dest = join(root, assertSafeDest(asset.dest));
    const dir = dirname(dest);
    if (!listings.has(dir)) {
      listings.set(dir, existsSync(dir) ? new Set(await readdir(dir)) : null);
    }
    const entries = listings.get(dir);
    const name = basename(dest);
    if (!entries?.has(name)) {
      missing.push(asset);
      continue;
    }
    // `readdir` just said both of these are there, so neither call rejects in
    // the normal path. The `.catch` covers only the race where the file is
    // removed in between, which is not a path anyone meets on a fresh install.
    const existing = await stat(dest).catch(() => undefined);
    if (!existing?.isFile()) {
      missing.push(asset);
      continue;
    }
    const raw = entries.has(`${name}.pin.json`)
      ? await readFile(`${dest}.pin.json`, "utf8").catch(() => undefined)
      : undefined;
    const marker = raw === undefined ? undefined : parseMarker(raw);
    if (markerVouchesFor(marker, asset, existing)) continue;
    // Unvouched but the right size is what a release that shipped the file looks
    // like, and what a marker lost to a copy looks like. `ensureAssets` hashes
    // and keeps it; treat it as present so we do not ask for a pointless 2.4 GB.
    if (existing.size !== asset.bytes) missing.push(asset);
  }
  return missing;
}

/**
 * Work out what this plan needs — and do NOT fetch it.
 *
 * Keyed on the resolved local capability set, so re-applying the same
 * configuration -- which the admin panel does on every save -- does not restart
 * a 2.4 GB download. A plan that newly needs something aborts the previous run
 * rather than racing it: two writers on one `.part` produce a file that passes
 * neither length nor hash.
 *
 * This used to start the download itself. It no longer does: it resolves to
 * `ready` when everything is already on disk (the common case on every restart
 * and every upgrade that did not move a pin) and to `needed` when something is
 * missing, which is the state the admin panel turns into "2.5 GB — Download".
 * `startWeightsDownload()` is the only thing that transfers bytes.
 *
 * Fire-and-forget by design. Returning the promise would invite a caller to
 * await it on the server thread, which is the one thing this must never do.
 */
export function syncWeights(plan: ProviderPlan, root: string = resourceRoot()): void {
  const local = localCapabilities(plan);
  const key = local.join(",");
  if (key === sync.key && sync.state !== "degraded") return;

  sync.controller?.abort();

  if (local.length === 0) {
    // Every capability hosted. Nothing to fetch and nothing to ask about.
    sync = { state: "ready", key, unavailable: [], needed: [] };
    return;
  }

  sync = { state: "idle", key, unavailable: [], needed: [] };

  void (async () => {
    let missing: PinnedAsset[];
    try {
      // Engine archives first in the list as well as first in the transfer, so
      // the panel's total is what the operator is actually about to download.
      // A `PinnedArchive` IS a `PinnedAsset`, so `totalBytes` and
      // `formatBytes` below need no special case — the prompt said "2.5 GB"
      // while also being about to fetch ~48 MB of engine, and now says so.
      missing = [
        ...archivesFor(readArchives(root), plan).filter((a) => !isInstalled(root, a)),
        ...(await missingAssets(root, selectAssets(readPins(root), local))),
      ];
    } catch (error) {
      // A lockfile that will not parse is not something to show as "ready".
      sync = { state: "degraded", key, unavailable: local, needed: [] };
      aiLog.error(
        `AI Dispatching is UNAVAILABLE — cannot read ${LOCKFILE}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    if (sync.key !== key) return; // reconfigured while we were looking at the disk
    if (missing.length === 0) {
      sync = { state: "ready", key, unavailable: [], needed: [] };
      return;
    }
    sync = { state: "needed", key, unavailable: [], needed: missing };
    aiLog.info(
      `AI Dispatching is waiting on model files: ${missing.length} artifact(s), ` +
        `${formatBytes(totalBytes(missing))}. Nothing has been downloaded. ` +
        `Start it from the admin panel under Settings -> AI Dispatcher, or run ` +
        `'${DOWNLOAD_COMMAND}' here. The radio itself is unaffected.`
    );
  })();
}

/**
 * The operator said yes. Transfer the bytes.
 *
 * Returns whether a run was started: `false` when one is already in flight or
 * there is nothing to fetch, so the caller can answer the panel honestly instead
 * of implying it just kicked something off.
 */
export function startWeightsDownload(plan: ProviderPlan, root: string = resourceRoot()): boolean {
  if (sync.state === "working") return false;
  const local = localCapabilities(plan);
  if (local.length === 0) return false;

  const key = local.join(",");
  sync.controller?.abort();
  const controller = new AbortController();
  sync = { state: "working", key, unavailable: [], needed: sync.needed, controller };

  void run(plan, root, local, key, controller).catch((error: unknown) => {
    if (controller.signal.aborted) return;
    // `ensureWeights` resolves rather than throws, so reaching here means a bug
    // rather than a download that failed. It still must not surface as FiveM's
    // context-free "Unhandled promise rejection in resource tRadio": say which
    // subsystem, and leave the feature in the state that matches reality.
    sync = { state: "degraded", key, unavailable: local, needed: sync.needed };
    aiLog.error(
      `AI Dispatching is UNAVAILABLE — the weights sync itself failed for: ` +
        `${local.join(", ")}. The radio itself is unaffected. ` +
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
  });
  return true;
}

/** The body of a `syncWeights` run. Separate so its rejection has somewhere to go. */
async function run(
  plan: ProviderPlan,
  root: string,
  local: Capability[],
  key: string,
  controller: AbortController
): Promise<void> {
  try {
    const pins = readPins(root);
    const intent = describeIntent(selectAssets(pins, local));
    if (intent) aiLog.info(intent);
  } catch {
    // ensureWeights reports the same failure with its reason; do not double-log.
  }

  // ── Engines before weights ──
  //
  // The engine binaries are no longer bundled either (117.5 MB of a 146 MB zip,
  // for a feature whose default is off), so they are fetched from the same
  // upstream pins by the same operator consent that fetches the weights. One
  // "Download" means one transfer of everything AI Dispatching needs, rather
  // than a second prompt appearing after the first finishes.
  //
  // First because they are two orders of magnitude smaller: ~48 MB against
  // 2.5 GB. A pin upstream has pruned, or a host with no outbound HTTPS, fails
  // here in seconds instead of after a 40-minute model download that was never
  // going to be usable.
  const engines = await ensureEngines(root, plan, controller.signal);
  if (controller.signal.aborted) return;
  if (!engines.ok) {
    sync = { state: "degraded", key, unavailable: engines.unavailable, needed: sync.needed };
    // `ensureEngines` has already logged the per-archive reason, including which
    // of the two failures it was and what to do about each.
    aiLog.error(
      `AI Dispatching is UNAVAILABLE — could not install the local inference engine for: ` +
        `${engines.unavailable.join(", ")}. The radio itself is unaffected. ` +
        `Retry from the admin panel under Settings -> AI Dispatcher, or run ` +
        `'${DOWNLOAD_COMMAND}' here, or set a hosted provider for those ` +
        `capabilities in the AI config.`
    );
    return;
  }

  const result = await ensureWeights(root, plan, controller.signal);
  if (controller.signal.aborted) return;

  if (result.ok) {
    sync = { state: "ready", key, unavailable: [], needed: [] };
    if (result.bytesFetched > 0)
      aiLog.info(`weights: ready (${formatBytes(result.bytesFetched)} downloaded)`);
    return;
  }

  sync = { state: "degraded", key, unavailable: result.unavailable, needed: sync.needed };
  // Name the FEATURE, not the resource. tRadio is running: channels, trunking,
  // 3D audio and the panel are unaffected, and an operator reading "tRadio
  // failed" would go looking for a problem that is not there.
  aiLog.error(
    `AI Dispatching is UNAVAILABLE — could not obtain model weights for: ` +
      `${result.unavailable.join(", ")}. The radio itself is unaffected. ` +
      `Retry from the admin panel under Settings -> AI Dispatcher, or run ` +
      `'${DOWNLOAD_COMMAND}' here, or set a hosted provider for those ` +
      `capabilities in the AI config.`
  );
}

/**
 * The console half of the same decision, for operators who are not in the panel.
 *
 * `restricted: true`, so it is a server-console command and not something a
 * player can type in chat — it spends the host's bandwidth and disk.
 *
 * Registered once, from the same `installed` guard the AI net handlers use:
 * FiveM keeps handlers from superseded module executions alive, and a second
 * registration would stack two handlers on one command name.
 */
export function registerWeightsCommand(plan: () => ProviderPlan): void {
  RegisterCommand(
    DOWNLOAD_COMMAND,
    () => {
      const status = weightsStatus();
      if (status.state === "working") {
        const p = status.progress;
        aiLog.info(
          `weights: already downloading` +
            (p
              ? ` — ${formatBytes(p.overallReceivedBytes)} / ${formatBytes(p.overallTotalBytes)}`
              : "")
        );
        return;
      }
      if (status.state === "ready") {
        aiLog.info("weights: every model file this configuration needs is already installed");
        return;
      }
      if (startWeightsDownload(plan())) {
        // Re-read: `startWeightsDownload` is what works out the full set, and the
        // pre-call figure is 0 when nothing has evaluated the disk yet — printing
        // "starting download — 0 B" is worse than printing no figure at all.
        const total = weightsStatus().neededBytes;
        aiLog.info(
          `weights: starting download${total > 0 ? ` — ${formatBytes(total)}` : ""}. ` +
            "The radio is usable throughout; progress follows here and in the admin panel."
        );
      } else {
        // Every capability hosted: there is nothing local to fetch. Say so rather
        // than printing "starting" and then never mentioning it again.
        aiLog.info(
          "weights: nothing to download — every capability is served by a hosted provider"
        );
      }
    },
    true
  );
}

/** Drop in-flight work on resource stop. */
export function resetWeights(): void {
  sync.controller?.abort();
  sync = { state: "idle", key: "", unavailable: [], needed: [] };
}
