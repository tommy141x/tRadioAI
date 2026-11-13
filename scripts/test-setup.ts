/**
 * Test preload: the FiveM natives the bundle reads at import time.
 *
 * Only defaults. A suite that needs different behaviour replaces the global inside its
 * own `beforeEach` and restores it afterwards — see `server/lib/stub-tradio.ts` for the
 * stand-in for tRadio itself.
 */

const g = globalThis as unknown as Record<string, unknown>;

g.GetConvar ??= (_name: string, fallback: string) => fallback;
g.GetCurrentResourceName ??= () => "tRadioAI";
g.GetResourcePath ??= () => process.cwd();
g.GetResourceState ??= () => "missing";
g.on ??= () => {};
g.emit ??= () => {};
g.RegisterCommand ??= () => {};
