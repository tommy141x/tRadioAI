import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  archivesFor,
  engineDir,
  explainFetchFailure,
  isInstalled,
  parseArchive,
  type PinnedArchive,
  readArchives,
} from "./engine-install";
import type { ProviderPlan } from "./providers";

/**
 * Which engines get downloaded, and the parsing that decides it.
 *
 * `ensureEngines` itself is the one thing not driven here: it is an async
 * orchestration over tLib's `ensureAssets` and the real network. What IS tested
 * is every decision it makes before and after that call, because those are
 * where a mistake is silent — a selection bug downloads 98 MB instead of 48 MB
 * and nobody notices, and a parse that tolerates a missing `strip` installs an
 * engine into a directory the launcher does not look in.
 */

const REPO = resolve(import.meta.dir, "..", "..");

function plan(over: Partial<Record<"text" | "speech" | "transcription", boolean>>): ProviderPlan {
  // `hosted: true` means a remote provider serves it and nothing is downloaded.
  const one = (hosted: boolean) => ({ hosted }) as ProviderPlan["text"];
  return {
    text: one(over.text ?? false),
    speech: one(over.speech ?? false),
    transcription: one(over.transcription ?? false),
  } as ProviderPlan;
}

// ── The real lockfile ───────────────────────────────────────────────────────

describe("the shipped lockfile", () => {
  test("every archive entry parses, and carries what ensureAssets needs", () => {
    // Against the REAL file: a fixture would only prove this file agrees with
    // itself. `bytes` in particular is load-bearing and easy to omit — tLib
    // uses it as the mid-stream size cap, so without it a download has no
    // ceiling to enforce.
    const archives = readArchives(REPO);
    expect(archives).toHaveLength(6);
    for (const a of archives) {
      expect(a.bytes).toBeGreaterThan(1_000_000);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.dest.startsWith("server/.cache/")).toBe(true);
      expect(["text", "speech", "transcription"]).toContain(a.capability ?? "");
    }
  });

  test("every pin is upstream — nothing is served from our own infrastructure", () => {
    // Tommy's rule, asserted where it would be broken: TG infra is for the
    // marketplace and update checks, and third-party bytes come from upstream.
    for (const a of readArchives(REPO)) {
      expect(new URL(a.url).host).toBe("github.com");
    }
  });

  test("the two platforms are complete and symmetrical", () => {
    // Three engines on each. A missing entry would mean one platform's install
    // silently cannot serve a capability, which reads to the operator as the
    // dispatcher being broken on Linux only.
    const archives = readArchives(REPO);
    for (const platform of ["win", "linux"] as const) {
      const caps = archives.filter((a) => a.platform === platform).map((a) => a.capability).sort();
      expect(caps).toEqual(["speech", "text", "transcription"]);
    }
  });
});

// ── Selection: the whole point of the change ────────────────────────────────

describe("archivesFor", () => {
  const all = (): PinnedArchive[] => readArchives(REPO);

  test("only this platform's copies are selected", () => {
    // THE SAVING. `binDir` resolves server/bin/<platform>/<engine> from
    // process.platform, so the other platform's archives could never be
    // executed — downloading them is 50 MB of pure waste.
    const picked = archivesFor(all(), plan({}), "linux");
    expect(picked).toHaveLength(3);
    expect(picked.every((a) => a.platform === "linux")).toBe(true);
  });

  test("a hosted capability downloads no engine for it", () => {
    // The common configuration: Hearing and Decisions hosted, Speaking local,
    // which is what we tell operators to do because a 4B model on CPU eats the
    // whole budget. That server should fetch piper and nothing else.
    const picked = archivesFor(all(), plan({ text: true, transcription: true }), "linux");
    expect(picked.map((a) => a.engine)).toEqual(["piper"]);
  });

  test("every capability hosted selects nothing at all", () => {
    // Then there is no download, no unpack, and no engine on disk — the state
    // the overwhelming majority of installs are in, since enabled defaults to
    // false.
    const picked = archivesFor(all(), plan({ text: true, speech: true, transcription: true }));
    expect(picked).toEqual([]);
  });

  test("each capability maps to exactly one engine", () => {
    // CONTROL on the capability wiring. If two engines claimed the same
    // capability, the cases above would still pass while the install fetched
    // a second archive nothing asked for.
    for (const capability of ["text", "speech", "transcription"] as const) {
      const hosted = { text: true, speech: true, transcription: true };
      hosted[capability] = false;
      const picked = archivesFor(all(), plan(hosted), "linux");
      expect(picked).toHaveLength(1);
      expect(picked[0].capability).toBe(capability);
    }
  });
});

// ── Parsing refusals ───────────────────────────────────────────────────────

describe("parseArchive", () => {
  const good = {
    id: "llama-linux",
    engine: "llama",
    platform: "linux",
    capability: "text",
    url: "https://github.com/x/y/releases/download/b1/a.tar.gz",
    sha256: "a".repeat(64),
    bytes: 16_865_765,
    dest: "server/.cache/llama-linux.tar.gz",
    strip: 1,
    expect: "llama-server",
  };

  test("a complete entry parses", () => {
    // The clean case first: without it every refusal below could be passing
    // because the parser rejects everything.
    expect(parseArchive(good).id).toBe("llama-linux");
  });

  test("a missing bytes is refused, not defaulted to zero", () => {
    // tLib uses `bytes` as the mid-stream cap. Defaulted to 0 there is no
    // ceiling, and a hostile or broken upstream could stream without bound
    // into a game server's disk.
    const { bytes, ...without } = good;
    expect(() => parseArchive(without)).toThrow(/numeric 'bytes'/);
  });

  test("a missing strip is refused", () => {
    // strip:0 and "no strip field" are the same value and completely different
    // outcomes: the tarballs wrap their payload in one directory, so a dropped
    // strip puts the binaries one level below where binDir looks and the engine
    // reads as not installed.
    const { strip, ...without } = good;
    expect(() => parseArchive(without)).toThrow(/numeric 'strip'/);
  });

  test("a platform that is neither win nor linux is refused", () => {
    expect(() => parseArchive({ ...good, platform: "darwin" })).toThrow(/not win or linux/);
  });

  test("a missing expect is refused", () => {
    // `expect` is the only thing that distinguishes "unpacked successfully"
    // from "unpacked something". Without it a renamed upstream binary installs
    // cleanly and fails at the first transmission.
    const { expect: _, ...without } = good;
    expect(() => parseArchive(without)).toThrow(/missing a 'expect'/);
  });
});

// ── Install detection ──────────────────────────────────────────────────────

describe("isInstalled", () => {
  const archive = (): PinnedArchive =>
    parseArchive({
      id: "llama-linux",
      engine: "llama",
      platform: "linux",
      capability: "text",
      url: "https://github.com/x/y/a.tar.gz",
      sha256: "a".repeat(64),
      bytes: 1_000_001,
      dest: "server/.cache/llama-linux.tar.gz",
      strip: 1,
      expect: "llama-server",
    });

  test("a directory with contents but no binary is NOT installed", () => {
    // The case that makes this keyed on the binary rather than the directory.
    // A half-unpacked tree, or one an FTP client in ASCII mode damaged, is a
    // populated directory with nothing executable in it — and if that answered
    // "installed", nothing would ever retry and the engine would fail at the
    // first transmission forever.
    const root = mkdtempSync(join(tmpdir(), "tradio-engine-"));
    try {
      const a = archive();
      mkdirSync(engineDir(root, a), { recursive: true });
      writeFileSync(join(engineDir(root, a), "libggml.so"), "SO");
      expect(isInstalled(root, a)).toBe(false);

      writeFileSync(join(engineDir(root, a), "llama-server"), "ELF");
      expect(isInstalled(root, a)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the directory it checks is the one the launcher resolves", () => {
    // The contract between this installer and local-engine.ts's binDir. If
    // these two ever disagree the install succeeds and the launcher reports no
    // engine, with nothing anywhere saying why.
    const dir = engineDir("/srv/res", archive());
    expect(dir).toBe(join("/srv/res", "server", "bin", "linux", "llama"));
  });
});

// ── Operator-facing failure text ───────────────────────────────────────────

describe("explainFetchFailure", () => {
  const a = (): PinnedArchive =>
    parseArchive({
      id: "llama-linux",
      engine: "llama",
      platform: "linux",
      capability: "text",
      url: "https://github.com/x/y/a.tar.gz",
      sha256: "a".repeat(64),
      bytes: 1_000_001,
      dest: "server/.cache/llama-linux.tar.gz",
      strip: 1,
      expect: "llama-server",
    });

  test("a 404 says upstream removed it and that retrying will not help", () => {
    // The two failures that actually happen are indistinguishable from the
    // error text and have opposite fixes. Telling an operator to check their
    // firewall when upstream pruned the release sends them somewhere there is
    // nothing to find.
    const text = explainFetchFailure(a(), new Error("HTTP 404 Not Found"));
    expect(text).toMatch(/upstream having removed this build/);
    expect(text).toMatch(/re-running will not fix it/);
  });

  test("anything else points at the server's own connectivity", () => {
    const text = explainFetchFailure(a(), new Error("getaddrinfo ENOTFOUND github.com"));
    expect(text).toMatch(/could not reach the file/);
    expect(text).not.toMatch(/upstream having removed/);
  });

  test("both name the hosted provider as the way out", () => {
    // Whichever it is, there is a configuration that needs no download at all,
    // and an operator who does not know that is stuck.
    for (const err of [new Error("HTTP 404"), new Error("ETIMEDOUT")]) {
      expect(explainFetchFailure(a(), err)).toMatch(/hosted provider/);
    }
  });
});
