/**
 * Builds the Node half of the resource: `server/main.ts` -> `server/dist/bundle.js`.
 *
 *   bun run build
 *
 * Same Bun.build settings tLib's `buildServerBundle` uses for every t* resource (node
 * target, one CJS file, dependencies bundled), kept inline so this repo builds with
 * nothing beside it: tLib is a runtime dependency of the resource, not a build one.
 *
 * Not minified. The source ships in the zip anyway, and a stack trace an operator pastes
 * into an issue should be readable.
 */

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outdir = join(root, "server", "dist");

export async function build(): Promise<void> {
  await rm(join(outdir, "bundle.js"), { force: true });
  await mkdir(outdir, { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(root, "server", "main.ts")],
    outdir,
    target: "node",
    format: "cjs",
    minify: false,
    sourcemap: "none",
    naming: "bundle.[ext]",
    packages: "bundle",
  });

  for (const log of result.logs) {
    const line = `  ${log.level}: ${log.message}`;
    if (log.level === "error") console.error(line);
    else console.warn(line);
  }
  if (!result.success) throw new Error("the server bundle did not build");

  for (const output of result.outputs) console.log(`  ${output.path}`);
}

if (import.meta.main) {
  await build();
}
