/**
 * Per-channel conversation state: what was said, who is owed an answer, and who
 * is waiting to be heard.
 *
 * Real radio traffic is not a sequence of independent requests. "K31 to Dispatch"
 * carries no request at all; the request arrives two transmissions later, and it
 * only makes sense because the dispatcher answered "Go K31" in between. A
 * dispatcher with no memory answers the first and is baffled by the third.
 *
 * Three things are tracked, all per frequency:
 *
 *   - **History** — a short rolling log of everything heard on the channel and
 *     everything the dispatcher said. Unit-to-unit traffic is logged too: it is
 *     not addressed to the dispatcher, but a dispatcher who heard it knows
 *     things, and it is the difference between answering a question and
 *     answering the same question twice.
 *   - **Expecting** — who the dispatcher just spoke to. A transmission from that
 *     unit within the window is a reply and counts as addressed even without a
 *     wake phrase, which is exactly the "Traffic when ready" case.
 *   - **Waiting** — units who keyed up while the dispatcher was mid-turn. We
 *     cannot talk over ourselves to say "standby", so they are named to the model
 *     on the next turn instead and answered in the order they called.
 *
 * Pure apart from an injected clock.
 */

export interface HistoryEntry {
  /** Callsign, or "Dispatch" for the dispatcher's own transmissions. */
  who: string;
  text: string;
  at: number;
  /** True for the dispatcher's own transmissions. */
  own: boolean;
}

/**
 * How much of the channel is remembered.
 *
 * Long enough to hold a full exchange — call-up, go-ahead, traffic,
 * acknowledgement, and the one before it — and short enough that a busy channel
 * does not push the tools out of the prompt.
 */
const MAX_HISTORY = 12;

/** History older than this is a different conversation, not context. */
const HISTORY_TTL_MS = 5 * 60_000;

/**
 * How long a unit stays "expected" after the dispatcher speaks to them.
 *
 * Long enough to cover a unit reading a plate off a screen, short enough that a
 * unit who went back to their own business is not answered as if they were still
 * talking to the dispatcher.
 */
const EXPECT_MS = 25_000;

interface ChannelState {
  history: HistoryEntry[];
  expecting: { serverId: number; until: number } | null;
  waiting: { serverId: number; callsign: string; at: number }[];
}

const channels = new Map<number, ChannelState>();

let clock: () => number = Date.now;

/** Test seam. Production never calls this. */
export function setConversationClock(now: () => number): void {
  clock = now;
}

function stateFor(frequency: number): ChannelState {
  let existing = channels.get(frequency);
  if (!existing) {
    existing = { history: [], expecting: null, waiting: [] };
    channels.set(frequency, existing);
  }
  return existing;
}

export function recordHeard(frequency: number, who: string, text: string): void {
  push(frequency, { who: who || "unknown unit", text, at: clock(), own: false });
}

export function recordSaid(frequency: number, callsign: string, text: string): void {
  push(frequency, { who: callsign, text, at: clock(), own: true });
}

function push(frequency: number, entry: HistoryEntry): void {
  const state = stateFor(frequency);
  state.history.push(entry);
  if (state.history.length > MAX_HISTORY)
    state.history.splice(0, state.history.length - MAX_HISTORY);
}

/**
 * Oldest first, stale entries dropped.
 *
 * A copy, because a turn's context outlives this call: the transmission being
 * handled is recorded while the turn is in flight, and a caller holding the live
 * array would find the traffic it is about to answer already in its own history.
 */
export function history(frequency: number): HistoryEntry[] {
  const state = channels.get(frequency);
  if (!state) return [];
  const cutoff = clock() - HISTORY_TTL_MS;
  state.history = state.history.filter((entry) => entry.at >= cutoff);
  return state.history.slice();
}

/** The dispatcher just spoke to this unit and a reply would not surprise anyone. */
export function expectReplyFrom(frequency: number, serverId: number): void {
  if (serverId <= 0) return;
  stateFor(frequency).expecting = { serverId, until: clock() + EXPECT_MS };
}

export function isExpected(frequency: number, serverId: number): boolean {
  const expecting = channels.get(frequency)?.expecting;
  if (!expecting) return false;
  if (clock() > expecting.until) return false;
  return expecting.serverId === serverId;
}

export function clearExpectation(frequency: number): void {
  const state = channels.get(frequency);
  if (state) state.expecting = null;
}

/**
 * Note a unit who called while the dispatcher was busy.
 *
 * Re-calling does not move a unit down the queue — a unit who calls twice is
 * more impatient, not later.
 */
export function noteWaiting(frequency: number, serverId: number, callsign: string): void {
  const state = stateFor(frequency);
  // An entry past its TTL counts as gone, not as already-noted. `waiting()` is
  // what prunes, and it is only read on a turn — so a unit who called, timed out
  // of the list and called again would otherwise be refused a fresh entry here
  // and then have the stale one pruned out from under them on the next read. They
  // keyed up twice and ended up on no list at all.
  const now = clock();
  const cutoff = now - WAITING_TTL_MS;
  if (state.waiting.some((entry) => entry.serverId === serverId && entry.at > cutoff)) return;
  state.waiting = state.waiting.filter((entry) => entry.serverId !== serverId);
  state.waiting.push({ serverId, callsign: callsign || `unit ${serverId}`, at: now });
}

/**
 * How long a unit who called while the dispatcher was busy is still "waiting".
 *
 * Needed because a unit can now be recorded as waiting WITHOUT its transmission
 * being queued — see the queue-full path in `index.ts`. A queued unit is cleared
 * when its own turn runs, but a dropped one has no turn coming, so without an
 * expiry its name would be shown to the model on every future turn forever and
 * the dispatcher would keep calling for somebody who left.
 *
 * Thirty seconds, the same bound `MAX_QUEUE_AGE_MS` uses on a queued
 * transmission, and for the same reason: past that the exchange has moved on. A
 * unit who still wants something keys up again, and `noteWaiting` is idempotent
 * per unit, so they reappear.
 */
export const WAITING_TTL_MS = 30_000;

export function waiting(frequency: number): string[] {
  const state = channels.get(frequency);
  if (!state) return [];
  const cutoff = clock() - WAITING_TTL_MS;
  // Pruned here rather than on a timer: this is read once per turn, which is the
  // only moment the answer is used, and it keeps the module free of a clock it
  // would otherwise have to own and shut down.
  if (state.waiting.some((entry) => entry.at <= cutoff)) {
    state.waiting = state.waiting.filter((entry) => entry.at > cutoff);
  }
  return state.waiting.map((entry) => entry.callsign);
}

export function clearWaiting(frequency: number, serverId: number): void {
  const state = channels.get(frequency);
  if (!state) return;
  state.waiting = state.waiting.filter((entry) => entry.serverId !== serverId);
}

/** Drop everything for a channel — used when the dispatcher stops covering it. */
export function forgetChannel(frequency: number): void {
  channels.delete(frequency);
}

export function resetConversations(): void {
  channels.clear();
  clock = Date.now;
}
