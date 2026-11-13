/**
 * What the dispatcher is allowed to spend, and on whose behalf.
 *
 * Two independent controls, because they answer two different questions and fail in
 * opposite directions:
 *
 *  - **`turnCooldownMs`** — how often ONE unit may drive a turn. On by default. It
 *    rate-limits a talker, never the channel, so the worst case is that one unit is
 *    answered a little later. This is the defence against a single player keying up
 *    repeatedly, which costs a full turn — transcription, text and speech — every time.
 *
 *  - **`hostedCallsPerMinute`** — how many HOSTED provider calls the whole server may
 *    make per rolling minute. Off by default, because a ceiling that trips mid-incident
 *    degrades every unit at once and that has to be an operator's choice. Above 0, the
 *    excess is served by the local engine rather than refused: the same fallback a
 *    missing API key already takes.
 *
 * Nothing here knows a price. A provider's rate card is not ours to track and would be
 * wrong within a month; what an operator can actually act on is the call RATE, so that
 * is what this counts and what the status surface reports.
 *
 * **Every limit is passed in rather than read from `aiConfig()`.** `config.ts` is what
 * consults this module, so reading the config back from here would be an import cycle.
 * It also makes the policy trivially testable without standing up a config.
 */

import type { Capability } from "./providers";

/** One rolling minute, the window both the counter and the report are stated in. */
const WINDOW_MS = 60_000;

/**
 * Timestamps of recent hosted calls, oldest first.
 *
 * An array rather than a counter reset on a fixed boundary: a fixed window lets twice
 * the ceiling through across a boundary — the last instant of one minute plus the first
 * of the next — which is exactly the burst a ceiling exists to stop.
 */
let hostedCalls: number[] = [];

/** Last turn start per unit, keyed by FiveM server id. */
const lastTurnAt = new Map<number, number>();

/** How many hosted calls the ceiling sent to the local engine, for the status surface. */
let shedByCeiling = 0;

function prune(now: number): void {
  if (hostedCalls.length === 0) return;
  const cutoff = now - WINDOW_MS;
  // Oldest first, so the first in-window entry ends the scan.
  let keepFrom = 0;
  while (keepFrom < hostedCalls.length && hostedCalls[keepFrom] <= cutoff) keepFrom += 1;
  if (keepFrom > 0) hostedCalls = hostedCalls.slice(keepFrom);
}

/**
 * May a hosted provider be used for this call?
 *
 * Asked where the endpoint is resolved, so it covers every capability rather than only
 * the text one. False means "serve this locally", never "do nothing".
 *
 * `ceiling <= 0` is the documented off switch and short-circuits before any bookkeeping.
 */
export function hostedAllowed(ceiling: number, now = Date.now()): boolean {
  if (ceiling <= 0) return true;
  prune(now);
  if (hostedCalls.length < ceiling) return true;
  shedByCeiling += 1;
  return false;
}

/**
 * Record that a hosted call is being made.
 *
 * Separate from {@link hostedAllowed} because the two happen at different moments and
 * conflating them would double-count: the status surface asks whether hosted use is
 * allowed without making a call, and a resolved endpoint can still fail before use.
 */
export function noteHostedCall(_capability: Capability, now = Date.now()): void {
  prune(now);
  hostedCalls.push(now);
}

/**
 * Is this unit allowed to drive a turn yet?
 *
 * `serverId <= 0` is a call-driven turn with no talker behind it — there is nobody to
 * rate-limit, so it is always allowed.
 */
export function turnAllowed(serverId: number, cooldownMs: number, now = Date.now()): boolean {
  if (cooldownMs <= 0 || serverId <= 0) return true;
  const previous = lastTurnAt.get(serverId);
  if (previous === undefined) return true;
  if (now - previous < cooldownMs) return false;

  /**
   * Expired, so the entry is dropped on the way out.
   *
   * This is what keeps the map bounded by the number of units CURRENTLY inside a
   * cooldown rather than by every unit seen since the resource started, and it means
   * there is no disconnect hook to remember to wire up — a player who leaves simply
   * never asks again, and their entry is collected the next time anyone does. A query
   * that evicts is worth the small impurity for that.
   */
  lastTurnAt.delete(serverId);
  return true;
}

/** Record that a turn started for this unit. Call only once the turn is going ahead. */
export function noteTurn(serverId: number, now = Date.now()): void {
  if (serverId > 0) lastTurnAt.set(serverId, now);
}

export interface BudgetState {
  /** Hosted calls in the last rolling minute. */
  hostedPerMinute: number;
  /** The configured ceiling, 0 when there is none. */
  ceiling: number;
  /** Hosted calls sent to the local engine instead, since the last reset. */
  shed: number;
  /** Units currently inside their cooldown. */
  cooling: number;
}

/** What the status surface reports. Read-only — asking must not consume budget. */
export function budgetState(ceiling: number, cooldownMs: number, now = Date.now()): BudgetState {
  prune(now);
  let cooling = 0;
  if (cooldownMs > 0) {
    for (const at of lastTurnAt.values()) if (now - at < cooldownMs) cooling += 1;
  }
  return { hostedPerMinute: hostedCalls.length, ceiling, shed: shedByCeiling, cooling };
}

/** Resource stop, and the test seam. */
export function resetBudget(): void {
  hostedCalls = [];
  lastTurnAt.clear();
  shedByCeiling = 0;
}
