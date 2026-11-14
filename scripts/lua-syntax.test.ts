/**
 * Every shipped Lua file parses.
 *
 * The Lua suites load only the files they are oracles for, and `sv_version.lua` and the
 * manifest touch tLib at load time, so a missing `end` there would otherwise first show up
 * on a server. Parsing is all this proves — it is what a Lua interpreter that is not
 * running FiveM can honestly say — and it is why the file list is read off disk rather
 * than written out: a new file is covered the moment it exists.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

// fengari ships its own CJS entry; the Lua suites run on the same VM.
const fengari = require("fengari") as {
  lua: { lua_tojsstring: (L: unknown, index: number) => string | null };
  lauxlib: {
    luaL_newstate: () => unknown;
    luaL_loadstring: (L: unknown, source: Uint8Array) => number;
  };
  to_luastring: (value: string) => Uint8Array;
};

function luaFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "dist" && entry.name !== "node_modules") out.push(...luaFiles(rel));
    } else if (entry.name.endsWith(".lua")) {
      out.push(rel);
    }
  }
  return out;
}

function parseError(source: string): string | null {
  const state = fengari.lauxlib.luaL_newstate();
  const status = fengari.lauxlib.luaL_loadstring(state, fengari.to_luastring(source));
  return status === 0 ? null : fengari.lua.lua_tojsstring(state, -1);
}

describe("shipped Lua", () => {
  const files = ["fxmanifest.lua", ...luaFiles("config"), ...luaFiles("server")];

  test("there are files to check", () => {
    // A directory that was renamed would otherwise make this pass over nothing.
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  test.each(files)("%s parses", (file) => {
    expect(parseError(readFileSync(join(root, file), "utf8"))).toBeNull();
  });

  test("a file with a missing end is refused, so the check can fail", () => {
    expect(parseError("local function broken()\n  return 1\n")).not.toBeNull();
  });
});
