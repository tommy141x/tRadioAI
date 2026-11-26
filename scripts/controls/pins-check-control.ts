#!/usr/bin/env bun
/**
 * Negative control for `bun run pins:check`.
 *
 *   bun run pins:check:control
 *
 * The gate it controls answers one question — are the 12 pinned upstream
 * artifacts still fetchable — and it is the kind of gate that rots into a
 * permanent PASS without anyone noticing, for three separate reasons:
 *
 *   1. It is the only gate here whose INPUT is somebody else's server. A
 *      checker that treated any answer as success would be green forever, and
 *      green is also what a healthy day looks like, so the real state and the
 *      broken state are indistinguishable from the output alone.
 *   2. It reads a list out of a file. `readPinnedUrls` returning `[]` for a
 *      lockfile it could not understand would report "all 0 artifacts resolve"
 *      — passing by measuring nothing, which is this repo's signature failure.
 *   3. It runs on a SCHEDULE, not on every verify, so a broken checker is not
 *      noticed by the next person's commit the way a broken test is.
 *
 * ⚠️ OFFLINE, deliberately, and that is the whole reason `head` is injected in
 * pins-check.ts rather than called directly. This control belongs in `bun run
 * controls`, which is offline and runs on every verify; the gate itself needs
 * the network and does not. A control that reached the network could fail
 * because GitHub was briefly unreachable, which would teach everyone to ignore
 * it.
 *
 * Exit 0 = the checker still reports a removed artifact as removed, and a live
 * one as live. Exit 1 = it has stopped discriminating. Exit 3 = the control
 * itself broke, which is not a verdict.
 */

import { join } from "node:path";
import { checkPins, deadPins, type Head, type PinnedUrl, readPinnedUrls } from "../pins-check.ts";

process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(3);
});
process.on("unhandledRejection", (err) => {
  console.error(err);
  process.exit(3);
});

const REPO = join(import.meta.dir, "..", "..");

const results: string[] = [];
const failures: string[] = [];

function ok(label: string): void {
  results.push(`  ok    ${label}`);
}
function bad(label: string, detail: string): void {
  failures.push(label);
  results.push(`  FAIL  ${label}\n        ${detail}`);
}

// Half 1: the real lockfile is readable and non-empty
//
// Against the REAL file, not a synthetic one: a fixture written by this control
// could only prove the control agrees with itself. This is the half that
// catches the lockfile being moved, renamed or restructured — at which point
// the gate would be probing an empty list and reporting success.

let real: PinnedUrl[] = [];
try {
  real = readPinnedUrls(REPO);
  if (real.length >= 12) {
    ok(`the real lockfile yields ${real.length} pinned artifacts`);
  } else {
    bad(
      `the real lockfile yields only ${real.length} pinned artifacts`,
      "there were 12 when this control was written (6 engine archives, 6 model weights). " +
        "Either entries were removed, or readPinnedUrls no longer understands the file — " +
        "in which case pins:check is probing fewer URLs than exist and still printing PASS.",
    );
  }
  const hosts = new Set(real.map((p) => new URL(p.url).host));
  // The rule: third-party bytes come from upstream, never a mirror hosted by this
  // project. A timmygstudios host appearing here is that decision being reversed by
  // accident, and this is the only place that would notice.
  const ours = [...hosts].filter((h) => h.includes("timmygstudios"));
  if (ours.length === 0) {
    ok(`every pin is upstream (${[...hosts].sort().join(", ")})`);
  } else {
    bad(
      `a pin points at our own infrastructure: ${ours.join(", ")}`,
      "TG infra serves the marketplace and update checks only. Third-party artifacts are " +
        "fetched from their real upstream and are never mirrored — see the note at the top " +
        "of scripts/pins-check.ts.",
    );
  }
} catch (err) {
  bad(
    "readPinnedUrls threw on the real lockfile",
    `${err instanceof Error ? err.message : String(err)}\n        ` +
      "pins:check cannot run at all, which is better than it running on nothing — but it " +
      "means the scheduled job is failing for a reason unrelated to upstream.",
  );
}

// Half 2: planted outcomes, one at a time

const PINS: PinnedUrl[] = [
  { id: "llama-win", kind: "archive", url: "https://github.com/x/y/releases/download/b1/a.zip" },
  {
    id: "piper-linux",
    kind: "archive",
    url: "https://github.com/x/y/releases/download/b1/b.tar.gz",
  },
  { id: "text", kind: "weight", url: "https://huggingface.co/x/y/resolve/main/m.gguf" },
];

/** Every pin answers the same way. */
const uniform =
  (result: Awaited<ReturnType<Head>>): Head =>
  async () =>
    result;

const CASES: { label: string; head: Head; expectDead: number; detail: string }[] = [
  {
    label: "a pruned release asset (404) is reported GONE",
    head: uniform({ ok: false, status: 404 }),
    expectDead: 3,
    detail:
      "THE CASE THIS GATE EXISTS FOR. llama.cpp removes old release builds; a 404 read as a " +
      "pass means the next customer to enable the dispatcher is the detector.",
  },
  {
    label: "a live asset (200) is reported ok",
    head: uniform({ ok: true, status: 200, bytes: 18_453_864 }),
    expectDead: 0,
    detail:
      "CONTROL, and the one that matters most: a checker that called everything dead would " +
      "satisfy the case above while being useless, and would fail the scheduled job forever.",
  },
  {
    label: "a transport failure with no HTTP status is reported GONE",
    head: uniform({ ok: false, status: 0, error: "getaddrinfo ENOTFOUND" }),
    expectDead: 3,
    detail:
      "`fetch` rejects rather than resolving for DNS and TLS failures. Treated as a pass, a " +
      "repo-wide outage would read as a clean bill of health.",
  },
  {
    label: "a 403 is reported GONE, not silently tolerated",
    head: uniform({ ok: false, status: 403 }),
    expectDead: 3,
    detail:
      "A private or rate-limited asset is not a fetchable one. GitHub answers 403 for a " +
      "release asset that needs a token, which is exactly the state a repo going private " +
      "would produce.",
  },
  {
    label: "a 301 that `fetch` already followed to a 200 is ok",
    head: uniform({ ok: true, status: 200 }),
    expectDead: 0,
    detail:
      "CONTROL on redirect handling: both hosts answer release assets from a CDN, so every " +
      "real success arrives after a redirect. A checker that only accepted a bare 200 on the " +
      "first hop would call all 12 dead.",
  },
  {
    label: "one dead pin among live ones is still reported",
    head: async (url) =>
      url.endsWith("b.tar.gz") ? { ok: false, status: 404 } : { ok: true, status: 200 },
    expectDead: 1,
    detail:
      "The realistic shape: upstream prunes ONE tag. A checker that only looked at the first " +
      "result, or that required all of them to fail, would miss it — and 'piper's linux " +
      "archive is gone' is a shipping blocker even with the other 11 healthy.",
  },
];

for (const c of CASES) {
  const verdicts = await checkPins(PINS, c.head);
  if (verdicts.length !== PINS.length) {
    bad(
      `${c.label}: checkPins returned ${verdicts.length} verdicts for ${PINS.length} pins`,
      "it must probe every pin and report on every pin; a short list is a silent skip.",
    );
    continue;
  }
  const dead = deadPins(verdicts).length;
  if (dead === c.expectDead) ok(c.label);
  else bad(`${c.label} — got ${dead} dead, expected ${c.expectDead}`, c.detail);
}

// Vacuity floor: an empty lockfile is refused, not passed
//
// `checkPins([])` resolving to `[]` and `deadPins([])` returning `[]` is a clean
// PASS over nothing. `readPinnedUrls` is what has to refuse it, so that is what
// is tested — through the real parser, on synthetic JSON.

const EMPTY_CASES: { label: string; json: string; expect: RegExp }[] = [
  {
    label: "a lockfile with both sections empty",
    json: '{"archives":[],"weights":[]}',
    expect: /declares no pinned artifacts/,
  },
  {
    label: "a lockfile missing the archives section entirely",
    json: '{"weights":[{"id":"a","url":"https://huggingface.co/x"}]}',
    expect: /no 'archives' array/,
  },
  {
    label: "an entry with a url but no id",
    json: '{"archives":[{"url":"https://github.com/x"}],"weights":[]}',
    expect: /no id or url/,
  },
];

const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
const os = await import("node:os");
const tmp = mkdtempSync(join(os.tmpdir(), "tradioai-pins-control-"));
try {
  mkdirSync(join(tmp, "server"), { recursive: true });
  for (const c of EMPTY_CASES) {
    writeFileSync(join(tmp, "server", "local-engine.lock.json"), c.json);
    let message: string | null = null;
    try {
      readPinnedUrls(tmp);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    if (message === null) {
      bad(
        `MISSED ${c.label}`,
        "readPinnedUrls returned normally, so pins:check would have printed PASS having " +
          "probed nothing at all.",
      );
    } else if (!c.expect.test(message)) {
      bad(`${c.label} threw the wrong error`, `expected ${c.expect}; got: ${message}`);
    } else {
      ok(`refused ${c.label}`);
    }
  }
} finally {
  // Created by this script, inside the OS temp dir, nowhere near the repo.
  rmSync(tmp, { recursive: true, force: true });
}

// Verdict

console.log("pinned-upstream-artifact negative control\n");
for (const line of results) console.log(line);

if (failures.length > 0) {
  console.error(
    `\nFAIL — ${failures.length} of ${results.length} control assertion(s) failed.\n` +
      "pins:check is no longer able to tell a removed upstream artifact from a present one, " +
      "so its scheduled PASS means nothing. Fix the gate (or this control, if the gate " +
      "deliberately changed).",
  );
  process.exit(1);
}
console.log(
  `\nPASS — ${results.length} assertion(s): pins:check still reports a removed artifact as ` +
    "removed and a live one as live.",
);
