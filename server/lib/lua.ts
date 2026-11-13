/**
 * Calling into the resource's own Lua from the dispatcher.
 *
 * Its own module so the tool layers can share it without importing each other:
 * `tools.ts` reaches the operator's registry through here, `builtins.ts` reaches
 * alerts and tones through here, and neither depends on the other.
 */

import { aiLog } from "./logger";

type LuaExports = Record<string, (...args: unknown[]) => unknown>;

function luaExports(): LuaExports | null {
  try {
    const bag = (globalThis as any).exports?.[GetCurrentResourceName()];
    return bag ? (bag as LuaExports) : null;
  } catch {
    return null;
  }
}

/** Call a Lua export, or return the fallback. Never throws — a broken hook is a bad turn, not a dead radio. */
export function callLuaSafely<T>(name: string, args: unknown[], fallback: T): T {
  const bag = luaExports();
  if (!bag || typeof bag[name] !== "function") return fallback;
  try {
    const result = bag[name]!(...args);
    return (result ?? fallback) as T;
  } catch (err) {
    aiLog.warn(`tools: ${name} threw — ${(err as Error).message}`);
    return fallback;
  }
}

/** Lua sends a list of strings as a sequential table; anything else arrives as an object. */
export function luaStrings(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value as object)
      : [];
  return list.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}
