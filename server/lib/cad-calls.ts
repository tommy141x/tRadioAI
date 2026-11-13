/**
 * Which call did this unit open?
 *
 * Shared by every provider, because every CAD surveyed has the same gap in the
 * same place: creating a call returns a reference, and nothing lets you look that
 * reference up again afterwards.
 *
 *  - **ImperialCAD** tracks it internally in `main/sv_calls.lua`'s `callsBySrc`,
 *    and the four exports that would read it are commented out upstream ("I may
 *    make this a thing later on.."). Lua globals do not cross resources, so there
 *    is no back door either.
 *  - **wasabi_mdt** returns the record from `CreateDispatch` and exposes
 *    `GetActiveDispatches()`, but nothing that says which unit a dispatch belongs
 *    to.
 *  - **SonoranCAD** is the exception: `GetCallCache()` is a live local read. Its
 *    provider still records here, so one code path serves all three — and because
 *    that cache refreshes on a 60-second poll, a call opened five seconds ago is
 *    not in it yet.
 *
 * The consequence is a boundary worth stating plainly rather than hiding: **the
 * dispatcher can attach to, note or close a call it opened itself.** A call a
 * human raised inside the CAD is invisible to it, except on Sonoran where the
 * cache eventually catches up.
 *
 * Keyed by the unit who reported it, because that is how the traffic arrives: "41,
 * send me another unit" names no call, and the only thing identifying which call
 * they mean is that 41 opened it. One dispatcher-opened call per unit matches both
 * ImperialCAD's own `callsBySrc` shape and how a single radio channel works.
 */

import type { CadCall } from "./cad-types";

export interface OpenCall extends CadCall {
  /** What it was opened for, so a later readback need not guess. */
  about: string;
  openedAt: number;
}

const openCalls = new Map<number, OpenCall>();

/**
 * Forget calls nobody closed.
 *
 * A dispatcher-opened call whose unit disconnected, or who never mentioned it
 * again, would otherwise sit here for the life of the server and hand a stale
 * reference to the next unit who asked for cover. Two hours is far longer than any
 * call and far shorter than an uptime.
 */
const CALL_TTL_MS = 2 * 60 * 60 * 1000;

function sweep(): void {
  const cutoff = Date.now() - CALL_TTL_MS;
  for (const [serverId, call] of openCalls) {
    if (call.openedAt < cutoff) openCalls.delete(serverId);
  }
}

export function rememberCall(serverId: number, call: OpenCall): void {
  sweep();
  openCalls.set(serverId, call);
}

export function callFor(serverId: number): OpenCall | null {
  sweep();
  return openCalls.get(serverId) ?? null;
}

export function forgetCall(serverId: number): void {
  openCalls.delete(serverId);
}

/** How many calls are open. Drives whether the attach tool is offered at all. */
export function openCallCount(): number {
  sweep();
  return openCalls.size;
}

export function resetCalls(): void {
  openCalls.clear();
}
