/**
 * tLib's spawn broker, stood up in a bare bun process.
 *
 * Development only. Nothing here ships, and nothing here is a second
 * implementation of anything.
 *
 * ## Why this file exists
 *
 * `server/lib/ai/spawn.ts` starts llama-server, whisper-server and piper through
 * tLib's broker and has **no local fallback on purpose** — a resource missing the
 * broker is misinstalled, and spawning directly would quietly re-create the
 * per-resource `add_unsafe_child_process_permission` line the broker exists to
 * remove. That is the right call in the product and it is why every offline
 * script in `scripts/` stopped working: outside FXServer there is no
 * `exports.tLib`, so the harness and all five probes died on the first engine
 * with `tLib's spawn broker is unavailable`.
 *
 * ## It runs tLib's real broker, and that is the whole point
 *
 * The obvious shim — reimplement the six exports over `node:child_process` — is
 * wrong, because `spawn.ts` deliberately never names a path. The paths live in
 * tLib's `catalog.ts` and so do the argument shapes, so a hand-rolled stand-in
 * would be a second copy of them that drifts the moment either side moves a
 * binary. Then the harness is testing a spawn path the server does not have.
 *
 * So this installs the natives tLib's broker reads and calls tLib's own
 * `installSpawn()`. The catalog, the gate and the host are the shipped ones; what
 * is faked is only the runtime underneath them. `gate.ts` already takes its
 * filesystem `probes` as arguments precisely so it can run outside FiveM, so
 * nothing had to be bent to allow this.
 *
 * ## What is faked, and what it costs
 *
 *  - **`GetInvokingResource()` always answers `"tRadio"`.** In FXServer it names
 *    the resource whose runtime made the call; here there is one process and only
 *    tRadio calls the broker. The consequence worth knowing: this is the identity
 *    the gate confines a spawn to, so an offline run cannot catch a *mislabelled*
 *    caller. It can catch everything else the gate checks.
 *  - **`GetResourceMetadata` answers from the real `fxmanifest.lua`.** The gate
 *    only warns on an author mismatch and never branches on it, but reading the
 *    manifest costs one regex and keeps a spurious warning out of every run —
 *    which is the kind of noise that trains you to ignore the real one.
 *  - **Reaping is wired to `onResourceStop`, which never fires here.** Callers
 *    must stop their own engines; `stopLocalEngines()` already does, and a script
 *    that skips it leaves llama-server holding its port. Same obligation the
 *    harness docblock already states, for the same reason.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Where the sibling resources are.
 *
 * Derived from this file rather than from `process.cwd()`: a probe run from the
 * repo root and one run from `scripts/` would otherwise resolve tLib
 * differently, and the failure — the gate refusing a binary for being outside
 * the resource — names neither the cwd nor the reason.
 */
const RESOURCES = path.resolve(import.meta.dir, "..", "..", "..");
const ADDON = path.resolve(import.meta.dir, "..", "..");

type ExportsFn = (name: string, fn: (...args: unknown[]) => unknown) => void;

let installed = false;
let loud = false;

/**
 * Make a throw out of a top-level `await` fatal and visible.
 *
 * Bun can let an unhandled rejection from top-level await print nothing and still
 * **exit 0**. Every caller of this module is a top-level-await script, and a
 * broker that failed to install silently is the worst possible failure here: the
 * script reports no engine work and returns success, which reads as "the
 * dispatcher had nothing to say" rather than "nothing was ever started". This
 * repo has shipped three gates that passed while measuring zero; that is the
 * family of bug this prevents.
 *
 * Installed from here rather than in each script so one import carries it, and
 * additive — an existing handler in a caller still runs.
 */
function beLoudOnFailure(): void {
  if (loud) return;
  loud = true;
  process.on("uncaughtException", (err) => {
    console.error(`\nFATAL (uncaught): ${err instanceof Error ? (err.stack ?? err.message) : err}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    console.error(`\nFATAL (rejected): ${err instanceof Error ? (err.stack ?? err.message) : err}`);
    process.exit(1);
  });
}

/** Every `author` line in a resource's manifest, in declared order. */
function authorsOf(resourceName: string): string[] {
  try {
    const manifest = readFileSync(path.join(RESOURCES, resourceName, "fxmanifest.lua"), "utf8");
    return [...manifest.matchAll(/^\s*author\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] as string);
  } catch {
    return [];
  }
}

/**
 * Make `globalThis.exports` both callable and a bag, the way FXServer does.
 *
 * FiveM overloads one global two ways: `exports("name", fn)` registers one of
 * yours, and `exports.other.Thing()` calls someone else's. tLib's `fExports` is
 * the first; tRadio's `broker()` is the second. A plain object satisfies only the
 * second, which is what `scripts/sim/fivem.ts` installs — correct for everything
 * it was written for, and not enough here.
 *
 * Existing bags are carried over rather than replaced: `installFivemStubs()` puts
 * `tRadio.getChannelPanic` there, and dropping it breaks the panic path in a run
 * that has nothing to do with spawning.
 */
function callableExports(): ExportsFn & Record<string, Record<string, unknown>> {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g.exports;
  if (typeof existing === "function") {
    return existing as ExportsFn & Record<string, Record<string, unknown>>;
  }

  const bags = (existing ?? {}) as Record<string, Record<string, unknown>>;
  // Registration is attributed to tLib because tLib's broker is the only caller
  // of this form here. tRadio's own exports are set as bags, never registered.
  const fn = ((name: string, impl: (...args: unknown[]) => unknown) => {
    if (!fn.tLib) fn.tLib = {};
    fn.tLib[name] = impl;
  }) as ExportsFn & Record<string, Record<string, unknown>>;

  for (const [resource, bag] of Object.entries(bags)) fn[resource] = bag;
  g.exports = fn;
  // `server/lib/*` is bundled CJS at runtime and reaches `exports` off either
  // global depending on the file, so both have to be the same object.
  (global as unknown as Record<string, unknown>).exports = fn;
  return fn;
}

/**
 * Install the broker. Safe to call more than once; the second call is a no-op.
 *
 * `await` matters, and so does the dynamic import inside. tLib's
 * `spawn/fivem.ts` captures `globalThis.exports` **at module evaluation** (`export
 * const fExports = g.exports`), and a static import at the top of this file would
 * be evaluated before the line below that makes it callable — so `fExports` would
 * close over the plain object, every `fExports(...)` would throw "not a
 * function", and the broker would register nothing while reporting nothing.
 */
export async function installSpawnBroker(): Promise<void> {
  // Re-asserted rather than skipped, and that is the whole reason this is not a
  // plain `if (installed) return`. `installFivemStubs` assigns `globalThis.exports`
  // wholesale, so anything installed before it is silently thrown away — and the
  // skip then made the correct, later call a no-op, leaving a plain object where the
  // broker should be. The symptom is "tLib's spawn broker is unavailable" from a
  // script that installed it, which reads as the shim not working at all.
  const live = (globalThis as unknown as Record<string, unknown>).exports as
    | (((name: string, fn: unknown) => void) & { tLib?: { SpawnServe?: unknown } })
    | undefined;
  if (installed && typeof live === "function" && typeof live.tLib?.SpawnServe === "function") {
    return;
  }

  beLoudOnFailure();
  const bag = callableExports();
  const g = globalThis as unknown as Record<string, unknown>;

  g.GetInvokingResource = () => "tRadioAI";
  g.GetCurrentResourceName ??= () => "tRadioAI";
  g.GetResourcePath = (resourceName: string) =>
    resourceName === "tRadioAI" ? ADDON : path.join(RESOURCES, resourceName);
  g.GetResourceMetadata = (resourceName: string, key: string, index: number) =>
    key === "author" ? (authorsOf(resourceName)[index] ?? null) : null;
  // The broker registers an `onResourceStop` handler. A script that installed no
  // bus at all would die on it before registering a single export.
  g.on ??= () => {};

  // A relative specifier, not an alias: `@tlib/shared` maps only `tLib/shared/ts`,
  // and the broker lives in `tLib/server/lib/spawn`. Adding a second alias to a
  // tsconfig the release tooling reads would widen a shipped config for a
  // dev-only import.
  //
  // Built from a variable so TYPESCRIPT CANNOT FOLLOW IT, which is deliberate and
  // is not about hiding a problem with this file. Resolving it statically pulls
  // tLib's whole server tree into `bun run typecheck`, and tLib never typechecks
  // that tree — its own `typecheck` script covers `client/web` alone. The first
  // thing that surfaced was a real error in tLib: `spawn/index.ts` imports
  // `Platform` from `./gate`, which only imports the type from `./catalog` and
  // never re-exports it (TS2459). Letting it resolve would therefore make
  // tRadio's CI typecheck fail on the state of another repo's untypechecked code
  // — and CI clones tLib from GitHub, so tRadio would go red for a tLib commit
  // nobody here had seen. The runtime import is unaffected: bun erases types.
  const brokerModule = "../../../tLib/server/lib/spawn/index";
  const { installSpawn } = (await import(brokerModule)) as { installSpawn: () => void };
  installSpawn();

  if (typeof bag.tLib?.SpawnServe !== "function") {
    throw new Error("the spawn broker registered no SpawnServe — tLib's export wiring changed");
  }
  installed = true;
}
