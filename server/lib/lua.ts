/**
 * Calling into the resource's own Lua from the dispatcher.
 *
 * `tools.ts` and `index.ts` reach the operator's hooks through here — `index.ts`
 * by way of the `callLuaSafely` that `tools.ts` re-exports.
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
