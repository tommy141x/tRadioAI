/**
 * The dispatcher's seat in tRadio.
 *
 * A station is tRadio's name for a virtual dispatch console: it shows in the unit list
 * under the dispatcher's callsign, covers a set of channels, and can transmit on them.
 * This module keeps exactly one persistent station open for the channels the
 * dispatcher is working, and opens a short-lived one to speak on a channel it does not
 * cover (the relay tool), which is what the old in-process console did too.
 *
 * Coverage follows two rules that used to live in `console.ts`:
 *
 *  - A channel a human dispatcher has signed on to is left to them. The caller works
 *    out the wanted set (see `index.ts`); this module only makes tRadio match it, and
 *    changes the station only when the set changes, because re-opening a station makes
 *    the dispatcher flicker out of every unit's list.
 *  - A 911 call's frequency is minted at runtime and is covered by tRadio itself when
 *    `answer911` runs, so it is never in the wanted set.
 */

import { isAnsweredCall } from "./calls";
import { aiLog } from "./logger";
import * as tradio from "./tradio-hooks";

/** Ceiling on one transmission. A dispatcher does not monologue, and a runaway TTS response must not hold the channel. */
export const MAX_REPLY_MS = 20_000;

interface OpenStation {
  id: string;
  name: string;
  frequencies: number[];
  answers911: boolean;
}

export interface StationWants {
  name: string;
  frequencies: number[];
  answers911: boolean;
}

let current: OpenStation | null = null;
let failedAt = 0;

/** After a refusal, wait this long before asking again: the sweep runs twice a second. */
const RETRY_AFTER_MS = 30_000;

const sameSet = (a: number[], b: number[]) =>
  a.length === b.length && a.every((frequency) => b.includes(frequency));

/**
 * Make tRadio's station match `wants`. `null` closes it.
 *
 * Cheap to call on every sweep: it does nothing when the station already matches.
 */
export function syncStation(wants: StationWants | null, now = Date.now()): void {
  if (!wants || (wants.frequencies.length === 0 && !wants.answers911)) {
    closeStation();
    return;
  }
  if (
    current &&
    current.name === wants.name &&
    current.answers911 === wants.answers911 &&
    sameSet(current.frequencies, wants.frequencies)
  ) {
    return;
  }
  if (failedAt > 0 && now - failedAt < RETRY_AFTER_MS) return;

  closeStation();
  const id = tradio.openStation(wants);
  if (!id) {
    failedAt = now;
    return;
  }
  failedAt = 0;
  current = { id, name: wants.name, frequencies: [...wants.frequencies], answers911: wants.answers911 };
  aiLog.debug(
    `station: open as "${wants.name}" on ${wants.frequencies.length} channel(s)` +
      `${wants.answers911 ? ", taking 911 calls" : ""}`
  );
}

export function closeStation(): void {
  if (!current) return;
  tradio.closeStation(current.id);
  current = null;
}

/** The persistent station's id, for `answer911`. Null while none is open. */
export function stationId(): string | null {
  return current?.id ?? null;
}

/** Forget the station without telling tRadio, for when tRadio itself has gone away. */
export function forgetStation(): void {
  current = null;
  failedAt = 0;
}

function covers(frequency: number): boolean {
  if (!current) return false;
  return current.frequencies.includes(frequency) || isAnsweredCall(frequency);
}

/**
 * Transmit PCM on `frequency` and wait for tRadio to say it has aired.
 *
 * `onAccepted` runs once tRadio has taken the audio. Aborting stops the wait; tRadio
 * has no cancel hook, so on the persistent station the audio already handed over still
 * airs to its end. A transient station is closed on abort, which cuts it.
 */
export async function transmitOn(
  frequency: number,
  pcm: Int16Array,
  sampleRate: number,
  signal: AbortSignal,
  onAccepted?: () => void
): Promise<{ ok: boolean; reason: string }> {
  if (signal.aborted) return { ok: false, reason: "aborted" };

  let id = covers(frequency) ? (current?.id ?? null) : null;
  let transient: string | null = null;
  if (!id) {
    transient = tradio.openStation({ name: "Dispatch", frequencies: [frequency], answers911: false });
    id = transient;
  }
  if (!id) return { ok: false, reason: "refused" };

  const durationMs = (pcm.length / sampleRate) * 1000;
  let abortListener: (() => void) | null = null;
  const aborted = new Promise<{ ok: boolean; reason: string }>((resolve) => {
    abortListener = () => resolve({ ok: false, reason: "aborted" });
    signal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    const sent = tradio.transmit(
      id,
      { frequency, pcm, sampleRate, maxMs: MAX_REPLY_MS },
      durationMs + 60_000
    );
    if (sent.accepted) onAccepted?.();
    const result = await Promise.race([sent.done, aborted]);
    return { ok: result.ok, reason: result.reason };
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
    if (transient) tradio.closeStation(transient);
  }
}
