/**
 * Builds the release zip: `bun run prod`.
 *
 *   dist-release/tRadioAI/            the staged resource
 *   dist-release/tRadioAI-<version>.zip
 *
 * Plaintext Lua and a readable bundle, no escrow. The zip is attached to a GitHub
 * release; nothing is uploaded from here.
 *
 * The staged manifest gets a `tlib_build` id hashed from the staged bytes, so two zips of
 * one version are distinguishable in a pasted startup banner, and a `tlib_commit` that
 * leads back to the exact source. Same keys and format as every other t* release.
 */

import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { build } from "./build.ts";
import { assertReleaseClean } from "./release-gate.ts";

const root = resolve(import.meta.dir, "..");
const out = join(root, "dist-release");
const stage = join(out, "tRadioAI");

/** What ships. Everything else in the repository is development tooling. */
const SHIPPED = [
  "fxmanifest.lua",
  "LICENSE",
  "README.md",
  "config",
  "server/sv_config.lua",
  "server/sv_tools.lua",
  "server/sv_version.lua",
  "server/dist/bundle.js",
  "server/local-engine.lock.json",
  "server/models/artifacts.json",
  "server/models/voices",
  "server/models/ggml-base.en-q5_1.bin.pin.json",
  "server/models/qwen3-4b-instruct-2507-q4_k_m.gguf.pin.json",
  "docs/content",
];

function stagedPaths(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(dir, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(join(dir, rel)).isDirectory()) found.push(...stagedPaths(dir, rel));
    else found.push(rel);
  }
  return found;
}

const STAMP = /\n*^(?:tlib_build|tlib_commit)\s+'[^']*'[ \t]*$\n?/gm;

function stamp(dir: string, commit: string): string {
  const manifest = join(dir, "fxmanifest.lua");
  const bare = `${readFileSync(manifest, "utf8").replace(STAMP, "").trimEnd()}\n`;
  const hash = createHash("sha256");
  for (const rel of stagedPaths(dir)) {
    hash.update(rel);
    hash.update("\0");
    hash.update(
      rel === "fxmanifest.lua" ? Buffer.from(bare, "utf8") : readFileSync(join(dir, rel)),
    );
  }
  const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${hash.digest("hex").slice(0, 8)}`;
  const commitLine = commit ? `tlib_commit '${commit}'\n` : "";
  writeFileSync(manifest, `${bare}\ntlib_build '${id}'\n${commitLine}`, "utf8");
  return id;
}

function gitCommit(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}

await build();

rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const entry of SHIPPED) {
  const from = join(root, entry);
  if (!existsSync(from)) throw new Error(`${entry} is listed as shipped and does not exist`);
  cpSync(from, join(stage, entry), { recursive: true });
}

const buildId = stamp(stage, gitCommit());
assertReleaseClean(stage);

const manifest = readFileSync(join(stage, "fxmanifest.lua"), "utf8");
const version = /^version\s+'([^']+)'/m.exec(manifest)?.[1] ?? "0.0.0";

const zip = new AdmZip();
zip.addLocalFolder(stage, "tRadioAI");
const target = join(out, `tRadioAI-${version}.zip`);
zip.writeZip(target);

console.log(`tRadioAI ${version} (build ${buildId}) -> ${target}`);
