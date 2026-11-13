/**
 * What must never be in a release zip.
 *
 * Third-party engines and model weights are fetched from their upstreams on first start
 * and are never redistributed from this repository: they are gigabytes, and each carries
 * its own licence. A key-shaped string in a shipped file is the other thing that cannot
 * be taken back once it is in a public asset.
 *
 * `scripts/controls/release-gate-control.ts` plants each of these and requires this to
 * fail: a gate that has never been seen failing cannot be told apart from one that has
 * stopped looking.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Weights, engine binaries and archives. Nothing this resource downloads is shipped. */
const BANNED_EXTENSIONS = [
  ".gguf",
  ".bin",
  ".onnx",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".zip",
  ".gz",
  ".tgz",
  ".7z",
  ".wasm",
];

/** Directories that exist only on a developer's machine or are created at runtime. */
const BANNED_SEGMENTS = ["node_modules", ".git", ".cache", "bin", "logs", ".github"];

/**
 * Provider key shapes. Deliberately the prefixes the five hosted providers issue; a test
 * fixture that needs a key-shaped string writes one that does not match (see
 * provider.test.ts), which is also what keeps this from needing an allow-list.
 */
const KEY_PATTERNS: Array<[string, RegExp]> = [
  ["an OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["a Groq key", /\bgsk_[A-Za-z0-9]{20,}/],
  ["an ElevenLabs key", /\bxi-[A-Za-z0-9]{20,}/],
  ["a private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(join(dir, rel)).isDirectory()) out.push(...walk(dir, rel));
    else out.push(rel);
  }
  return out;
}

const TEXT_EXTENSIONS = [".lua", ".js", ".json", ".md", ".mdx", ".txt", ".cfg", ".yml", ".yaml"];

/** Every problem found in a staged release tree. Empty means clean. */
export function releaseProblems(dir: string): string[] {
  const problems: string[] = [];
  const files = walk(dir);

  for (const file of files) {
    const lower = file.toLowerCase();
    const bad = BANNED_EXTENSIONS.find((extension) => lower.endsWith(extension));
    if (bad) problems.push(`${file}: a ${bad} file cannot ship; it is fetched from upstream at first start`);
    const segment = file.split("/").slice(0, -1).find((part) => BANNED_SEGMENTS.includes(part));
    if (segment) problems.push(`${file}: inside "${segment}", which is never staged`);

    if (TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const [label, pattern] of KEY_PATTERNS) {
        if (pattern.test(text)) problems.push(`${file}: looks like it contains ${label}`);
      }
    }
  }

  const manifest = join(dir, "fxmanifest.lua");
  if (!existsSync(manifest)) {
    problems.push("fxmanifest.lua is missing");
  } else {
    const text = readFileSync(manifest, "utf8");
    // Open source and not escrowed: an escrow line would make the zip unreadable to the
    // people the licence is for.
    if (/escrow_ignore/.test(text)) problems.push("fxmanifest.lua declares escrow_ignore");
    for (const [, listed] of text.matchAll(/^\s*'((?:config|server)\/[^']+\.(?:lua|js))',?\s*$/gm)) {
      if (listed && !existsSync(join(dir, listed))) {
        problems.push(`fxmanifest.lua lists ${listed}, which is not in the release`);
      }
    }
  }

  const bundle = join(dir, "server", "dist", "bundle.js");
  if (!existsSync(bundle) || statSync(bundle).size === 0) {
    problems.push("server/dist/bundle.js is missing or empty");
  }

  return problems;
}

/** Throws with every problem named, so one failing run says everything to fix. */
export function assertReleaseClean(dir: string): void {
  const problems = releaseProblems(dir);
  if (problems.length > 0) {
    throw new Error(`the release tree is not clean:\n  - ${problems.join("\n  - ")}`);
  }
}
