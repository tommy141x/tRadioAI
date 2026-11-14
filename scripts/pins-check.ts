#!/usr/bin/env bun
/**
 * Are the pinned upstream artifacts still fetchable?
 *
 *   bun run pins:check
 *
 * Every entry in `local-engine.lock.json` is a third-party URL — six engine
 * archives on github.com, six model weights on huggingface.co. Nothing is
 * mirrored, by decision: this project hosts no third-party bytes. Upstream is the
 * artifact's real home.
 *
 * The cost of that decision is the one thing this gate covers. **Upstream can
 * delete a release asset.** llama.cpp cuts several builds a day and does prune
 * old ones, so the pin that resolved when it was written can stop resolving
 * without anybody touching this repo. Whoever finds out first either way, the
 * difference is who: a scheduled run of this tells US, and the fix is bumping a
 * pin in a release; silence tells a CUSTOMER, whose install fails at the point
 * they enable the dispatcher.
 *
 * ⚠️ This gate needs the network, which is why it is NOT in `bun run controls`
 * — those are all offline by design and run on every verify. It belongs on a
 * schedule (`.gitea/workflows/pins.yml`). Its negative control IS offline,
 * because `head` is injected: see `scripts/controls/pins-check-control.ts`.
 *
 * It deliberately does NOT verify sha256. Doing so would mean downloading ~2.6 GB
 * to prove a byte, and `vendor-local-engine.ts` already refuses to install
 * anything whose hash does not match. The question here is narrower and is the
 * one that goes stale on its own: is it still there.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One pinned third-party artifact, flattened across the lockfile's two sections. */
export interface PinnedUrl {
  id: string;
  kind: "archive" | "weight";
  url: string;
}

export interface HeadResult {
  /** The artifact is still fetchable. */
  ok: boolean;
  /** 0 when the request never got a response. */
  status: number;
  /** `content-length`, when the host sent one. Reported, never asserted. */
  bytes?: number;
  /** Transport failure, as opposed to an HTTP status. */
  error?: string;
}

/** Injected so the control can drive every outcome without a network. */
export type Head = (url: string) => Promise<HeadResult>;

export interface PinVerdict extends PinnedUrl {
  result: HeadResult;
}

/**
 * Flatten the lockfile into the one list this gate cares about.
 *
 * Reads the same file `vendor-local-engine.ts` and `model-integrity.ts` read.
 * A second copy of a URL list is a second thing to forget to update, which is
 * the whole reason the lockfile is a single source of truth.
 */
export function readPinnedUrls(root: string): PinnedUrl[] {
  const raw: unknown = JSON.parse(
    readFileSync(join(root, "server", "local-engine.lock.json"), "utf8"),
  );
  const lock = raw as { archives?: unknown; weights?: unknown };
  const out: PinnedUrl[] = [];
  for (const [kind, section] of [
    ["archive", lock.archives],
    ["weight", lock.weights],
  ] as const) {
    if (!Array.isArray(section)) throw new Error(`local-engine.lock.json has no '${kind}s' array`);
    for (const entry of section as { id?: unknown; url?: unknown }[]) {
      if (typeof entry.id !== "string" || typeof entry.url !== "string") {
        throw new Error(`local-engine.lock.json has a ${kind} with no id or url`);
      }
      out.push({ id: entry.id, kind, url: entry.url });
    }
  }
  // A lockfile that parsed but holds nothing would otherwise be a PASS that
  // checked nothing — the exact shape this repo keeps shipping.
  if (out.length === 0) throw new Error("local-engine.lock.json declares no pinned artifacts");
  return out;
}

/** The real probe. Follows redirects: both hosts answer from a CDN. */
export const fetchHead: Head = async (url) => {
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow" });
    const length = response.headers.get("content-length");
    return {
      ok: response.ok,
      status: response.status,
      bytes: length === null ? undefined : Number(length),
    };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * Probe every pin. Resolves rather than throws — the caller wants the whole
 * list, because "llama's two archives are gone and nothing else is" is a
 * different problem from "the network is down", and stopping at the first
 * failure cannot tell them apart.
 */
export async function checkPins(pins: readonly PinnedUrl[], head: Head): Promise<PinVerdict[]> {
  return await Promise.all(pins.map(async (pin) => ({ ...pin, result: await head(pin.url) })));
}

/** Everything that is no longer fetchable. */
export function deadPins(verdicts: readonly PinVerdict[]): PinVerdict[] {
  return verdicts.filter((v) => !v.result.ok);
}

if (import.meta.main) {
  // A throw out of a top-level-await module is swallowed by Bun: no output,
  // exit 0. For a gate that means "reports success forever".
  process.on("uncaughtException", (err) => {
    console.error(err);
    process.exit(3);
  });
  process.on("unhandledRejection", (err) => {
    console.error(err);
    process.exit(3);
  });

  const root = join(import.meta.dir, "..");
  const pins = readPinnedUrls(root);
  const verdicts = await checkPins(pins, fetchHead);

  console.log(`pinned upstream artifacts: ${pins.length}\n`);
  for (const v of verdicts) {
    const size = v.result.bytes === undefined ? "" : ` ${(v.result.bytes / 1048576).toFixed(1)} MB`;
    const detail = v.result.error ?? `HTTP ${v.result.status}`;
    console.log(
      `  ${v.result.ok ? "ok  " : "GONE"}  ${v.kind.padEnd(7)} ${v.id.padEnd(16)} ${
        v.result.ok ? detail + size : detail
      }`,
    );
  }

  const dead = deadPins(verdicts);
  if (dead.length > 0) {
    console.error(
      `\nFAIL — ${dead.length} of ${pins.length} pinned artifact(s) no longer resolve:\n` +
        dead.map((v) => `  ${v.id}  ${v.url}`).join("\n") +
        "\n\nUpstream removed or retagged them. Bump the pin in " +
        "server/local-engine.lock.json (url AND sha256) and re-run " +
        "`bun run scripts/vendor-local-engine.ts`. Do NOT mirror the artifact: " +
        "see the note at the top of this file.",
    );
    process.exit(1);
  }
  console.log(`\nPASS — all ${pins.length} pinned upstream artifacts still resolve.`);
}
