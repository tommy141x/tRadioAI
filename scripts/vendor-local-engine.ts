/**
 * Fetches the local inference runtime into the resource. Release preparation
 * only — no application code calls this, and the dispatcher never downloads
 * anything at runtime.
 *
 *   bun run scripts/vendor-local-engine.ts            # everything
 *   bun run scripts/vendor-local-engine.ts --cache DIR # reuse a staging dir
 *
 * Every input is pinned by URL and SHA-256 in local-engine.lock.json and is
 * verified before it is unpacked. A hash that does not match aborts the run
 * rather than installing the file, because the alternative to a wrong binary is
 * no binary, and only one of those is discovered at the point of failure.
 *
 * Binaries land in bin/<platform>/<engine>/, one directory per engine, because
 * llama.cpp and whisper.cpp both ship `ggml.dll` built from different revisions
 * and the loser of a shared directory gets a library it was not linked against.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = process.cwd();
const lock = JSON.parse(
  await readFile(join(root, "server/local-engine.lock.json"), "utf8"),
) as Lockfile;

interface Archive {
  id: string;
  engine: string;
  platform: string;
  url: string;
  sha256: string;
  strip: number;
  expect: string;
}

interface Weight {
  id: string;
  dest: string;
  url: string;
  sha256: string;
}

interface Lockfile {
  archives: Archive[];
  weights: Weight[];
}

const ORIGINS = new Set(["https://github.com", "https://huggingface.co"]);

const cacheFlag = process.argv.indexOf("--cache");
const cache = cacheFlag > 0 ? process.argv[cacheFlag + 1] : join(root, "server", ".cache");
await mkdir(cache, { recursive: true });

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A verified copy of one pinned input, from the cache when it is already there.
 *
 * Redirects are followed but the *starting* origin is checked, so a lockfile
 * edited to point somewhere else fails here rather than three steps later.
 */
async function fetchPinned(url: string, sha256: string, into: string): Promise<Uint8Array> {
  if (!ORIGINS.has(new URL(url).origin)) throw new Error(`unexpected origin: ${url}`);

  if (existsSync(into)) {
    const cached = new Uint8Array(await Bun.file(into).arrayBuffer());
    if (digest(cached) === sha256) return cached;
    console.log(`  cached copy of ${into} does not match its hash; refetching`);
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());

  const actual = digest(bytes);
  if (actual !== sha256) {
    throw new Error(`hash mismatch for ${url}\n  expected ${sha256}\n  got      ${actual}`);
  }

  await Bun.write(into, bytes);
  return bytes;
}

/**
 * Windows' own bsdtar, by full path.
 *
 * Bare `tar` on a developer box usually resolves to Git's MSYS build first, and
 * that one rewrites Windows paths in its arguments — `-C C:\…\bin\win\llama`
 * arrives as `in//llama`. The System32 copy takes the paths as written.
 */
const TAR =
  process.platform === "win32" && existsSync("C:\\Windows\\System32\\tar.exe")
    ? "C:\\Windows\\System32\\tar.exe"
    : "tar";

/**
 * Unpack with bsdtar, which reads both zip and tar.gz and ships with Windows 10
 * and every Linux this runs on — one extractor rather than two code paths.
 */
async function unpack(archive: string, dest: string, strip: number): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  const args = ["-xf", archive, "-C", dest];
  if (strip > 0) args.push(`--strip-components=${strip}`);

  const proc = Bun.spawn([TAR, ...args], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`tar failed on ${archive}: ${await new Response(proc.stderr).text()}`);
  }
}

let installed = 0;

console.log("binaries:");
for (const archive of lock.archives) {
  const staged = join(cache, `${archive.id}${archive.url.endsWith(".zip") ? ".zip" : ".tar.gz"}`);
  const dest = join(root, "server", "bin", archive.platform, archive.engine);

  process.stdout.write(`  ${archive.id.padEnd(16)}`);
  await fetchPinned(archive.url, archive.sha256, staged);
  await unpack(staged, dest, archive.strip);

  // The archive being valid does not prove it contained what we came for: an
  // upstream that renames or relocates its server binary would otherwise leave a
  // full directory that fails at the first transmission instead of here.
  if (!existsSync(join(dest, archive.expect))) {
    throw new Error(`${archive.id}: ${archive.expect} is not in the unpacked archive`);
  }
  console.log(`ok  -> bin/${archive.platform}/${archive.engine}/`);
  installed++;
}

console.log("weights:");
for (const weight of lock.weights) {
  const dest = join(root, weight.dest);
  process.stdout.write(`  ${weight.id.padEnd(16)}`);

  if (existsSync(dest)) {
    const existing = new Uint8Array(await Bun.file(dest).arrayBuffer());
    if (digest(existing) === weight.sha256) {
      console.log("ok  (already installed)");
      installed++;
      continue;
    }
  }

  await mkdir(dirname(dest), { recursive: true });
  const bytes = await fetchPinned(weight.url, weight.sha256, join(cache, weight.id));
  await Bun.write(dest, bytes);
  console.log(`ok  -> ${weight.dest}`);
  installed++;
}

// What is actually on disk, for the release. The lockfile says what should be
// here; this says what is, and the two are compared by eye exactly once.
await writeFile(
  join(root, "server", "models", "validation.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      archives: lock.archives.map(({ id, url, sha256 }) => ({ id, url, sha256 })),
      weights: lock.weights.map(({ id, dest, url, sha256 }) => ({ id, dest, url, sha256 })),
    },
    null,
    2,
  )}\n`,
);

console.log(`\n${installed} artifact(s) installed and verified.`);
