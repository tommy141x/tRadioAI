/**
 * The release gate's negative control: `bun run release:gate:control`.
 *
 * Builds a minimal clean tree, requires the gate to accept it, then plants each thing the
 * gate exists to refuse and requires it to fail by name. A gate that passes on a tree with
 * a model weight in it is measuring nothing.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { releaseProblems } from "../release-gate.ts";

function write(root: string, rel: string, body: string | Uint8Array): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function cleanTree(): string {
  const root = mkdtempSync(join(tmpdir(), "tradioai-gate-"));
  write(
    root,
    "fxmanifest.lua",
    "fx_version 'cerulean'\nserver_scripts {\n    'config/config.lua',\n    'server/dist/bundle.js',\n}\n"
  );
  write(root, "config/config.lua", "Config = {}\n");
  write(root, "server/dist/bundle.js", "// bundle\n");
  return root;
}

const cases: Array<[string, (root: string) => void, RegExp]> = [
  ["a model weight", (r) => write(r, "server/models/model.gguf", "x"), /\.gguf/],
  ["an engine binary", (r) => write(r, "server/bin/win/llama/llama-server.exe", "x"), /\.exe|"bin"/],
  ["a downloaded archive", (r) => write(r, "server/.cache/llama.zip", "x"), /\.zip|\.cache/],
  ["an OpenAI-style key", (r) => write(r, "config/notes.md", "key sk-abcdefghijklmnopqrstuvwxyz0123"), /OpenAI/],
  ["a Groq key", (r) => write(r, "config/notes.md", "gsk_abcdefghijklmnopqrstuvwxyz0123"), /Groq/],
  ["an escrow line", (r) => write(r, "fxmanifest.lua", "escrow_ignore {}\n'config/config.lua'\n"), /escrow/],
  [
    "a manifest entry that is not staged",
    (r) => write(r, "fxmanifest.lua", "server_scripts {\n    'server/sv_missing.lua',\n    'server/dist/bundle.js',\n}\n"),
    /sv_missing/,
  ],
  ["an empty bundle", (r) => write(r, "server/dist/bundle.js", ""), /bundle\.js/],
];

const failures: string[] = [];

const clean = cleanTree();
const baseline = releaseProblems(clean);
if (baseline.length > 0) failures.push(`the clean tree was refused: ${baseline.join("; ")}`);
rmSync(clean, { recursive: true, force: true });

for (const [label, plant, expected] of cases) {
  const root = cleanTree();
  try {
    plant(root);
    const problems = releaseProblems(root);
    if (problems.length === 0) failures.push(`${label}: the gate accepted it`);
    else if (!problems.some((problem) => expected.test(problem))) {
      failures.push(`${label}: refused, but not for the right reason (${problems.join("; ")})`);
    } else {
      console.log(`  refused as required  ${label}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  process.exit(1);
}
console.log("PASS  the release gate is demonstrably capable of failing.");
