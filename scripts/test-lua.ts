/**
 * Runs the Lua suites: `bun run test:lua`, and `bun run test:lua:control`.
 *
 * There is no native Lua interpreter here. Fengari is a Lua VM that runs under bun, and
 * `fengari-node-cli` is installed as a dev dependency so this needs no network.
 *
 * ## Discovery is off disk, not a list
 *
 * A hardcoded list is the one way a runner fails silently: it keeps passing while the
 * suite nobody added to it is the suite that would have caught the regression.
 * `scripts/controls/lua/` is NOT in the discovery path, deliberately: it holds suites
 * that are supposed to fail.
 *
 * ## Exit codes, read directly
 *
 * Every suite runs through `scripts/run-lua-suite.lua` because fengari's CLI can print an
 * unhandled Lua error and still exit ZERO. Codes are read from `Bun.spawnSync().exitCode`,
 * never from `$?` after a pipe.
 *
 * `LUA_CONTROL=1` is this gate's negative control. It runs the cases below, each of which
 * must fail, and exits 1 if any of them passes. A suite that implements the flip protocol
 * (scripts/lua/harness.lua) exits 1 for BOTH outcomes of its control, so the runner also
 * requires its `CONTROL OK` marker.
 */

import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const CONTROL = process.env.LUA_CONTROL === "1";

function runSuite(
  relativePath: string,
  quiet = false,
  extraEnv: Record<string, string> = {},
): { code: number; output: string } {
  const result = Bun.spawnSync(
    ["bunx", "--bun", "fengari", "scripts/run-lua-suite.lua", relativePath],
    {
      cwd: root,
      stdout: quiet ? "pipe" : "inherit",
      stderr: quiet ? "pipe" : "inherit",
      env: { ...process.env, ...extraEnv },
    },
  );
  // `exitCode` is null when the process was killed by a signal, which is a failure.
  const output = quiet
    ? `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`
    : "";
  return { code: result.exitCode ?? 1, output };
}

async function discover(dir: string): Promise<string[]> {
  return (await Array.fromAsync(new Bun.Glob("**/*.lua").scan({ cwd: resolve(root, dir) }))).sort();
}

if (CONTROL) {
  const failures: string[] = [];

  for (const [label, suite, env, flipProtocol] of [
    ["a false assertion", "scripts/controls/lua/lua-fails.lua", {}, false],
    ["an error raised at the top level", "scripts/controls/lua/lua-throws.lua", {}, false],
    [
      "malformed and throwing tools made acceptable, so every refusal must stop holding",
      "scripts/tests/tools.lua",
      { TOOLS_CONTROL: "1" },
      true,
    ],
    [
      "a key forwarded and nothing said, so every secrecy assertion must stop holding",
      "scripts/tests/config.lua",
      { CONFIG_CONTROL: "1" },
      true,
    ],
  ] as const satisfies ReadonlyArray<readonly [string, string, Record<string, string>, boolean]>) {
    const { code, output } = runSuite(suite, true, env as Record<string, string>);
    if (code !== 0 && flipProtocol && !output.includes("CONTROL OK")) {
      failures.push(
        `${suite} (${label}) failed under its control, but did not report CONTROL OK. ` +
          "A negative assertion still held against accepted input, so it is not reading the " +
          "code path it names.",
      );
      console.log(`  CONTROL NOT SATISFIED  ${suite} — exit ${code}, no CONTROL OK`);
    } else if (code === 0) {
      failures.push(
        `${suite} (${label}) exited 0. The Lua gate cannot fail there, so every passing run of ` +
          "`bun run test:lua` has been measuring nothing.",
      );
      console.log(`  NOT FAILING  ${suite} — exit 0`);
    } else {
      console.log(`  failed as required  ${suite} — exit ${code} (${label})`);
    }
  }

  // The vacuous-pass guard: a directory that exists and holds no `.lua`, which is what a
  // renamed or moved suite directory looks like.
  const empty = await discover("scripts/controls/lua/empty");
  if (empty.length !== 0) {
    failures.push(
      "scripts/controls/lua/empty is not empty, so the vacuous-pass guard was not exercised.",
    );
  } else {
    console.log("  discovery over an empty directory found 0 suites, as required");
  }

  console.log("");
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL  ${failure}`);
    process.exit(1);
  }
  console.log("PASS  the Lua gate is demonstrably capable of failing.");
  process.exit(0);
}

const suites = await discover("scripts/tests");
if (suites.length === 0) {
  // Thrown, not warned: an empty suite directory is a green run that proves nothing.
  throw new Error("scripts/tests contains no Lua suites; this run would pass vacuously");
}

let failed = 0;
for (const suite of suites) {
  const { code } = runSuite(`scripts/tests/${suite}`);
  if (code !== 0) {
    console.error(`FAIL scripts/tests/${suite} (exit ${code})`);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${suites.length} Lua suites failed`);
  process.exit(1);
}

console.log(`PASS: ${suites.length} Lua suites`);
