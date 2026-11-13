import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PinnedAsset,
  selectAssets,
  totalBytes,
} from "./assets/index.ts";
import { localCapabilities, resolveProviders } from "./providers";
import { readPins } from "./model-integrity";
import {
  DOWNLOAD_COMMAND,
  missingAssets,
  registerWeightsCommand,
  weightsStatus,
} from "./weights";

const ROOT = join(import.meta.dir, "..", "..");

describe("localCapabilities", () => {
  test("the shipped default is every capability local", () => {
    expect(localCapabilities(resolveProviders()).sort()).toEqual([
      "speech",
      "text",
      "transcription",
    ]);
  });

  test("a hosted capability with a key drops out", () => {
    const plan = resolveProviders({ text: { provider: "groq", key: "sk-test" } });
    expect(localCapabilities(plan)).not.toContain("text");
    expect(localCapabilities(plan).sort()).toEqual(["speech", "transcription"]);
  });

  test("a hosted capability WITHOUT a key stays local", () => {
    // The whole reason selection reads the resolved plan and not the raw
    // config. providers.ts falls back to local for a missing key; keying off
    // the declared config would skip this download and then load an engine
    // whose weights are not on disk.
    const plan = resolveProviders({ text: { provider: "groq" } });
    expect(localCapabilities(plan)).toContain("text");
  });

  test("a provider that cannot serve a capability stays local", () => {
    // openrouter is text-only; asking it for speech resolves back to local.
    const plan = resolveProviders({ speech: { provider: "openrouter", key: "sk-test" } });
    expect(localCapabilities(plan)).toContain("speech");
  });

  test("everything hosted leaves nothing to fetch", () => {
    const plan = resolveProviders({
      text: { provider: "groq", key: "k" },
      speech: { provider: "openai", key: "k" },
      transcription: { provider: "openai", key: "k" },
    });
    expect(localCapabilities(plan)).toEqual([]);
  });
});

describe("the real lockfile", () => {
  const pins = readPins(ROOT);

  test("every pinned weight declares a capability and a size", () => {
    // Without `capability` the selection is all-or-nothing; without `bytes`
    // there is no progress denominator and no mid-stream cap.
    expect(pins.length).toBe(6);
    for (const pin of pins) {
      expect(pin.capability, pin.id).toBeDefined();
      expect(pin.bytes, pin.id).toBeGreaterThan(0);
    }
  });

  test("the capability labels match what providers.ts resolves", () => {
    // These two vocabularies are joined only by string equality, so a typo in
    // the lockfile would silently select nothing and fetch nothing.
    const labels = new Set(pins.map((p) => p.capability));
    expect([...labels].sort()).toEqual(["speech", "text", "transcription"]);
  });

  test("speech needs all four files; voice ids do not name their capability", () => {
    const speech = pins.filter((p) => p.capability === "speech").map((p) => p.id);
    expect(speech.sort()).toEqual([
      "voice-female",
      "voice-female-config",
      "voice-male",
      "voice-male-config",
    ]);
  });

  test("the fully-local download is the figure the docs quote", () => {
    expect(totalBytes(pins)).toBe(2_683_414_484);
  });

  test("sending text to a hosted provider avoids 2.3 GB of the 2.5", () => {
    const plan = resolveProviders({ text: { provider: "groq", key: "sk-test" } });
    const needed = selectAssets(pins, localCapabilities(plan));
    expect(needed.map((p) => p.id)).not.toContain("text");
    // 2.5 GB down to under 200 MB: the point of the whole feature.
    expect(totalBytes(needed)).toBeLessThan(200_000_000);
  });

  test("all-hosted selects nothing at all", () => {
    const plan = resolveProviders({
      text: { provider: "groq", key: "k" },
      speech: { provider: "openai", key: "k" },
      transcription: { provider: "openai", key: "k" },
    });
    expect(selectAssets(pins, localCapabilities(plan))).toEqual([]);
  });

  test("every destination stays inside server/models", () => {
    for (const pin of pins) expect(pin.dest.startsWith("server/models/")).toBe(true);
  });
});

/**
 * The presence check behind the "needs setup" state.
 *
 * This is the half that decides whether an operator is asked to download 2.5 GB,
 * so both directions of a wrong answer are expensive: a false "missing" asks for
 * gigabytes they already have, and a false "present" lets the engine start
 * against files that are not there. It deliberately does NOT hash — see the note
 * on `missingAssets` — so the contract tested here is exactly "cheap check, and
 * erring towards present when the size matches".
 */
describe("missingAssets", () => {
  const pin = (over: Partial<PinnedAsset> = {}): PinnedAsset =>
    ({
      id: "text",
      capability: "text",
      dest: "server/models/probe.gguf",
      bytes: 11,
      sha256: "0".repeat(64),
      url: "https://example.invalid/probe.gguf",
      ...over,
    }) as PinnedAsset;

  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tradio-weights-"));
    await mkdir(join(dir, "server", "models"), { recursive: true });
  });
  afterEach(async () => {
    // Only ever the directory this test created, under the OS temp dir.
    await rm(dir, { recursive: true, force: true });
  });

  test("a file that is not there is missing", async () => {
    expect(await missingAssets(dir, [pin()])).toHaveLength(1);
  });

  // The actual shape of a fresh install: nobody has downloaded anything, so the
  // directory the probe is about to look in does not exist either. This is the
  // path that printed six "Unhandled promise rejection" ENOENTs on first launch
  // on FiveM Enhanced, whose runtime reports handled rejections as unhandled —
  // which is why the probe lists the directory instead of stat-ing each file.
  test("a models directory that does not exist reports everything missing", async () => {
    const bare = await mkdtemp(join(tmpdir(), "tradio-weights-bare-"));
    try {
      const assets = [pin(), pin({ id: "speech", dest: "server/models/voices/a.onnx" })];
      expect(await missingAssets(bare, assets)).toHaveLength(2);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test("a file of the declared size counts as present, with no marker", async () => {
    // What a release that shipped the weights looks like, and what a marker lost
    // to a file copy looks like. Asking for a 2.4 GB re-download here would be
    // the single most expensive wrong answer this function can give.
    await writeFile(join(dir, "server", "models", "probe.gguf"), "hello world");
    expect(await missingAssets(dir, [pin()])).toEqual([]);
  });

  test("a file of the WRONG size is missing", async () => {
    await writeFile(join(dir, "server", "models", "probe.gguf"), "short");
    expect(await missingAssets(dir, [pin()])).toHaveLength(1);
  });

  test("a directory where the file should be is missing, not present", async () => {
    await mkdir(join(dir, "server", "models", "probe.gguf"), { recursive: true });
    expect(await missingAssets(dir, [pin()])).toHaveLength(1);
  });

  test("it reports every missing asset, not just the first", async () => {
    const assets = [pin(), pin({ id: "transcription", dest: "server/models/b.bin" })];
    expect(await missingAssets(dir, assets)).toHaveLength(2);
  });

  test("a dest that escapes the resource root is refused rather than probed", async () => {
    // `assertSafeDest` is what stops a hostile lockfile pointing at ../../ — this
    // asserts the presence check runs it too, not just the downloader.
    await expect(missingAssets(dir, [pin({ dest: "../../escape.bin" })])).rejects.toThrow();
  });
});

describe("weightsStatus", () => {
  test("reports a state, a needed list and a byte total", () => {
    const status = weightsStatus();
    expect(["idle", "needed", "working", "ready", "degraded"]).toContain(status.state);
    expect(Array.isArray(status.needed)).toBe(true);
    expect(typeof status.neededBytes).toBe("number");
  });
});

/**
 * The console half of the download decision.
 *
 * Worth a test because the message it replaces was *wrong*: the failure path
 * used to tell operators to run `radio ai weights`, a command that was never
 * implemented. The single line an operator saw when this broke sent them
 * nowhere. So what is asserted is the pair — the command registers under the
 * same name the failure message prints — and that it never starts a download
 * when there is nothing to fetch.
 */
describe("registerWeightsCommand", () => {
  const original = (globalThis as Record<string, unknown>).RegisterCommand;
  let registered: { name: string; restricted: boolean; run: () => void } | undefined;

  beforeEach(() => {
    registered = undefined;
    (globalThis as Record<string, unknown>).RegisterCommand = (
      name: string,
      handler: () => void,
      restricted: boolean
    ) => {
      registered = { name, restricted, run: handler };
    };
  });
  afterEach(() => {
    (globalThis as Record<string, unknown>).RegisterCommand = original;
  });

  test("registers under the name the failure message tells operators to run", () => {
    registerWeightsCommand(() => resolveProviders());
    expect(registered?.name).toBe(DOWNLOAD_COMMAND);
  });

  test("is restricted — it spends the host's bandwidth and disk", () => {
    // Unrestricted, any player could type it in chat and start a 2.5 GB fetch
    // on someone else's server.
    registerWeightsCommand(() => resolveProviders());
    expect(registered?.restricted).toBe(true);
  });

  /**
   * An all-hosted plan, deliberately. The default plan is all-LOCAL, and running
   * the handler against it starts a real 2.5 GB fetch from the test process — it
   * happened to be a no-op on the machine this was written on only because the
   * weights were already installed there. A test must not depend on that.
   */
  const allHosted = () =>
    resolveProviders({
      text: { provider: "openai", model: "gpt-4o-mini", key: "x" },
      speech: { provider: "openai", model: "tts-1", key: "x" },
      transcription: { provider: "openai", model: "whisper-1", key: "x" },
    });

  test("with every capability hosted it starts nothing and says so", () => {
    expect(localCapabilities(allHosted())).toEqual([]);
    registerWeightsCommand(allHosted);
    expect(() => registered?.run()).not.toThrow();
    // Still `ready`: there was nothing to fetch, so nothing moved.
    expect(weightsStatus().state).not.toBe("working");
  });
});
