#!/usr/bin/env bun
/**
 * Generate and audit THIRD-PARTY-NOTICES.txt.
 *
 *   bun run notices:gen      # derive, render, write
 *   bun run notices:check    # derive again and audit what is written
 *
 * ## Why this exists
 *
 * `server/dist/bundle.js` is a `Bun.build` with `packages: "bundle"`, so every npm
 * dependency it imports is COPIED into the file that ships in the zip. MIT asks for
 * its copyright notice to be included in "all copies or substantial portions of the
 * Software", and a bundled copy is a copy. The zip carried none until this file
 * existed.
 *
 * The bundle is not minified, so some of those notices do survive inside it — but
 * only the ones the packages happen to write as comments, at a path nobody reads.
 * A file beside the bundle is the reproduction.
 *
 * ## It derives the set, it does not restate it
 *
 * A hand-kept list of bundled packages is wrong the first time somebody adds a
 * dependency, and wrong silently. The set comes from the BUNDLER: the sourcemap's
 * `sources` array IS the module graph. Nothing is written to disk for this — the
 * build stays in memory.
 *
 * The build options MUST track `scripts/build.ts`. They are not cosmetic: with
 * `target: "bun"` a package that Bun has a builtin for resolves external and drops
 * out of the graph with no error anywhere. The shipped bundle is a node build.
 *
 * Exit codes: 0 clean, 1 the document is missing or disagrees with the bundle.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dir, "..");
export const NOTICES_FILE = "THIRD-PARTY-NOTICES.txt";

/**
 * Both floors exist because a derivation that measures nothing renders a document
 * with no components in it, and an empty document looks like compliance.
 */
const MIN_PACKAGES = 2;
const MIN_MODULES = 40;

const LICENCE_NAMES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENCE",
  "LICENCE.md",
  "LICENCE.txt",
  "license",
  "license.md",
  "license.txt",
  "COPYING",
  "COPYING.txt",
  "LICENSE-MIT",
  "MIT-LICENSE",
];

export interface Component {
  name: string;
  version: string;
  spdx: string;
  textSource: string;
  text: string;
}

/** Every npm package named by a module id in the graph. */
export function packagesFromModuleIds(ids: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const raw of ids) {
    const id = raw.split("\\").join("/");
    // The LAST node_modules/ segment is the package, so a nested install
    // (a/node_modules/b/index.js) is b and not a.
    const at = id.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const dep = id.slice(at + "node_modules/".length).match(/^(@[^/]+\/[^/]+|[^@/][^/]*)\//);
    if (dep) found.add(dep[1]);
  }
  return [...found].sort();
}

/** The shipped bundle's module graph, read out of its own sourcemap. */
export async function bundledPackages(): Promise<{ packages: string[]; modules: number }> {
  const result = await Bun.build({
    entrypoints: [path.join(REPO, "server/main.ts")],
    target: "node",
    format: "cjs",
    packages: "bundle",
    minify: false,
    sourcemap: "external",
  });
  if (!result.success) {
    throw new Error(`the server bundle did not build: ${result.logs.map(String).join("; ")}`);
  }
  const map = result.outputs.find((output) => output.kind === "sourcemap");
  if (!map) throw new Error("the build produced no sourcemap — there is no graph to read");
  const sources: string[] = JSON.parse(await map.text()).sources;
  if (sources.length < MIN_MODULES) {
    throw new Error(
      `the sourcemap names ${sources.length} modules (floor ${MIN_MODULES}) — that is not the graph`,
    );
  }
  return { packages: packagesFromModuleIds(sources), modules: sources.length };
}

/** SPDX id, including the pre-SPDX `licenses: [{ type }]` array some packages still use. */
export function spdxOf(pkg: {
  license?: string | { type?: string };
  licenses?: { type?: string }[];
}): string | null {
  if (typeof pkg.license === "string" && pkg.license.trim() !== "") return pkg.license.trim();
  if (typeof pkg.license === "object" && pkg.license?.type) return pkg.license.type;
  const legacy = (pkg.licenses ?? []).map((entry) => entry.type).filter(Boolean);
  return legacy.length > 0 ? legacy.join(" OR ") : null;
}

/**
 * One component record, or a throw.
 *
 * It throws rather than returning a partial row because a row with no licence text
 * is indistinguishable from compliance at a glance and is not compliance at all. A
 * new dependency with an unusual licence filename should stop the build once.
 */
export function componentFor(name: string, root = REPO): Component {
  const dir = path.join(root, "node_modules", name);
  const manifest = path.join(dir, "package.json");
  if (!fs.existsSync(manifest)) {
    throw new Error(`${name} is in the bundle but not installed — its licence cannot be read`);
  }
  const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const version: string = pkg.version ?? "unknown";
  const spdx = spdxOf(pkg);
  if (!spdx) throw new Error(`${name}@${version} declares no licence id`);

  const onDisk = LICENCE_NAMES.map((file) => path.join(dir, file)).find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  );
  if (!onDisk) {
    throw new Error(
      `${name}@${version} ships no licence text under any name this script knows. ` +
        `Declared licence: ${spdx}. Add its filename to LICENCE_NAMES, or vendor the ` +
        "upstream text and name where it came from — do not ship the row empty.",
    );
  }
  const text = fs.readFileSync(onDisk, "utf8").replace(/\r\n/g, "\n").trimEnd();
  if (text.trim().length < 200) {
    throw new Error(`${name}@${version}: licence text is ${text.trim().length} chars`);
  }
  return {
    name,
    version,
    spdx,
    textSource: `${name}/${path.basename(onDisk)} as published on npm`,
    text,
  };
}

const RULE = "=".repeat(78);
const THIN = "-".repeat(78);

/** The marker the audit looks for, one per component. Changing it changes the audit. */
export const componentMarker = (component: Pick<Component, "name" | "version">) =>
  `--- ${component.name}@${component.version} ---`;

export function render(components: Component[], modules: number, today: string): string {
  const lines: string[] = [];
  const p = (...text: string[]) => lines.push(...text);

  p(
    RULE,
    " THIRD-PARTY SOFTWARE NOTICES",
    " tRadioAI -- Tommy Johnston",
    ` Generated ${today} by scripts/third-party-notices.ts`,
    RULE,
    "",
    "tRadioAI bundles the open-source components listed below into",
    "server/dist/bundle.js. Their licences require the copyright notice to",
    "accompany a copy of the software, and a bundled copy is a copy, so the full",
    "text of each is reproduced here.",
    "",
    "tRadioAI's own code is MIT as well; its licence is in LICENSE beside this",
    "file. Nothing here changes it.",
    "",
    "The local engine (llama.cpp, whisper.cpp, Piper) and its model weights are",
    "NOT distributed with this resource. They are downloaded from upstream on",
    "first start, under their own licences, and no copy of them is in this zip.",
    "",
  );

  p(THIN, " 1. HOW THIS LIST WAS DERIVED", THIN, "");
  p(
    "From the bundler, not from a list anyone maintains by hand, so a dependency",
    "added tomorrow appears here without somebody remembering to add it.",
    "",
    `  Bun.build module graph of server/main.ts, read from its external sourcemap`,
    `  (target node, format cjs, packages bundle -- the options the shipped bundle`,
    `  is built with): ${modules} modules, ${components.length} third-party packages.`,
    "",
  );

  p(THIN, ` 2. COMPONENTS (${components.length})`, THIN, "");
  const width = Math.max(...components.map((c) => `${c.name}@${c.version}`.length));
  for (const component of components) {
    p(`  ${`${component.name}@${component.version}`.padEnd(width)}  ${component.spdx}`);
  }
  p("");

  p(THIN, " 3. LICENCE TEXTS", THIN);
  for (const component of components) {
    p("", componentMarker(component), `    ${component.spdx} -- ${component.textSource}`, "");
    for (const line of component.text.split("\n")) p(line === "" ? "" : `  ${line}`);
    p("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The document minus its generation date, which is the only part that changes
 * without anything about the components changing. Compared on this so a run
 * tomorrow does not rewrite a file nobody touched.
 */
export function withoutGenerationDate(text: string): string {
  return text.replace(/^ Generated \d{4}-\d{2}-\d{2} by /m, " Generated by ");
}

/**
 * Audit a written document against a freshly derived set. Pure: both sides are
 * arguments, so the negative control can plant a defect without a build.
 *
 * Collects every problem rather than stopping at the first.
 */
export function noticesProblems(staged: string | null, components: Component[]): string[] {
  const problems: string[] = [];

  if (components.length === 0) {
    problems.push(
      "the derivation produced NO components — a document rendered from this would be " +
        "empty and would pass every presence check",
    );
  }
  if (staged === null) {
    problems.push(`${NOTICES_FILE} is missing — the bundle ships with no attribution`);
    return problems;
  }

  for (const component of components) {
    if (!staged.includes(componentMarker(component))) {
      problems.push(`${component.name}@${component.version} is bundled but not attributed`);
      continue;
    }
    // The heading can be right while the text under it is somebody else's, so the
    // licence body is checked too, on a line long enough to be unique to it.
    const grant = component.text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 40);
    if (grant && !staged.includes(grant)) {
      problems.push(
        `${component.name}@${component.version} is listed, but its licence text is not`,
      );
    }
  }
  return problems;
}

async function derive(): Promise<{ components: Component[]; modules: number }> {
  const { packages, modules } = await bundledPackages();
  if (packages.length < MIN_PACKAGES) {
    throw new Error(
      `the graph yielded ${packages.length} third-party package(s) (floor ${MIN_PACKAGES}). ` +
        "Refusing to write a document that would look like compliance.",
    );
  }
  return { components: packages.map((name) => componentFor(name)), modules };
}

if (import.meta.main) {
  const target = path.join(REPO, NOTICES_FILE);
  const check = process.argv.slice(2).includes("--check");
  const { components, modules } = await derive();

  if (check) {
    const staged = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    const problems = noticesProblems(staged, components);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`FAIL  ${problem}`);
      console.error(`\nRun \`bun run notices:gen\` and commit ${NOTICES_FILE}.`);
      process.exit(1);
    }
    console.log(`✅ ${NOTICES_FILE}: ${components.length} bundled component(s) attributed`);
  } else {
    const text = render(components, modules, new Date().toISOString().slice(0, 10));
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    if (current === null || withoutGenerationDate(current) !== withoutGenerationDate(text)) {
      fs.writeFileSync(target, text, "utf8");
    }
    console.log(
      `✅ ${NOTICES_FILE}: ${components.length} component(s) from ${modules} modules, ` +
        `${Buffer.byteLength(text)} bytes`,
    );
  }
}
