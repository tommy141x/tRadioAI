/**
 * Using an engine another resource already has loaded.
 *
 * tRadio ships its own inference and works alone — that is the requirement, and
 * nothing here changes it. But tAI ships inference too, and on a box running
 * both, each loading its own copy of the same weights is gigabytes of memory
 * spent to arrive at the same answers. tLib keeps a small table of which
 * resource is serving which artifact, and this is the half of that conversation
 * tRadio holds: ask before starting, announce after starting.
 *
 * Matching is on the artifact the operator installed, not on a path — the same
 * GGUF in `tAI/models` and `tRadio/models` is one workload. Two genuinely
 * different models do not match and two engines run, which is the right answer
 * rather than a silent downgrade of whichever resource asked second.
 *
 * Every call here is optional. tLib absent, the export missing, the registry
 * empty: all of them mean "nobody else has this", and tRadio starts its own.
 */

import { aiLog } from "./logger";

interface TlibExports {
  InferenceAdvertise(payload: string): string;
  InferenceLookup(capability: string, workload: string): string;
}

interface Advertisement {
  resource: string;
  url: string;
  model: string;
}

/** Resolved through globalThis: the bundler shadows a bare `exports` with the CJS one. */
function tlib(): TlibExports | null {
  try {
    const registry = (globalThis as { exports?: Record<string, TlibExports> }).exports;
    return registry?.tLib ?? null;
  } catch {
    return null;
  }
}

/** The address last announced per capability, so the log line marks a change. */
const announced = new Map<string, string>();

/**
 * An engine someone else is already running for this workload.
 *
 * Not probed before it is returned, and deliberately not cached: the lookup is a
 * synchronous table read, and asking every time is what makes this self-healing.
 * A provider that stops is withdrawn by tLib as it stops, so the worst case is
 * one failed turn before tRadio starts its own engine on the next.
 */
export function sharedEngine(capability: string, workload: string): Advertisement | null {
  if (!workload) return null;
  const registry = tlib();
  if (!registry) return null;

  try {
    const encoded = registry.InferenceLookup(capability, workload);
    if (typeof encoded !== "string" || !encoded) {
      announced.delete(capability);
      return null;
    }
    const parsed = JSON.parse(encoded) as Advertisement;
    if (!parsed?.url) return null;
    // Said when the answer changes, not every time it is asked: an adopted engine is
    // looked up on every request, three times a turn, and at `info` that was three
    // identical lines per turn for the whole shift.
    if (announced.get(capability) !== parsed.url) {
      announced.set(capability, parsed.url);
      aiLog.info(`shared: using ${parsed.resource}'s ${capability} engine at ${parsed.url}`);
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Announce an engine tRadio started, so the next resource to want it adopts it. */
export function advertiseEngine(
  capability: string,
  workload: string,
  url: string,
  model: string,
): void {
  if (!workload) return;
  const registry = tlib();
  if (!registry) return;

  try {
    const handle = registry.InferenceAdvertise(
      JSON.stringify({ capability, workload, url, model }),
    );
    if (handle) aiLog.debug(`shared: advertised ${capability} (${workload}) at ${url}`);
  } catch {
    // tLib not installed, or an older build without the registry. Either way
    // tRadio keeps the engine it just started; sharing is the optional half.
  }
}
