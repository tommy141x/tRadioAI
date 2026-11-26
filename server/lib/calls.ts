/**
 * The 911 calls this dispatcher has picked up.
 *
 * A call is an ephemeral synthetic frequency (`allocateCall911Frequency`) that
 * reuses the whole channel/voice machinery — so once the dispatcher opens a
 * console on it, the caller is simply someone it can hear and talk to. What is
 * missing is the *knowledge* that the frequency exists at all: `monitorsFrequency`
 * answers from the configured channel list, which a call will never be in, and
 * everything downstream of it would treat the caller as traffic on a channel
 * nobody covers.
 *
 * So this is the second half of that question, kept here rather than in
 * `config.ts` because it is runtime state and not configuration, and because a
 * registry that imports the config module cannot also be imported by it.
 *
 * Deliberately small. It knows which frequencies are live calls, what each one
 * was originally about, and what the dispatcher has since learned about it. It
 * does not decide whether to answer, does not open consoles and does not end
 * calls — `index.ts` does all three, because all three need the config and the
 * turn loop.
 */

import type { Call911 } from "./tradio-hooks";
import type { AiCallInfo } from "./types";

/**
 * A call the dispatcher answered and is still on.
 *
 * `info` is the call as the model is shown it. `summary` is filled in by the
 * `hang_up` tool and is what the radio announcement is built from once the line
 * is down — the caller's original `/911` text is a sentence typed in a hurry,
 * and a call-taker who has just spoken to them knows better.
 */
export interface AnsweredCall {
  callId: string;
  frequency: number;
  callerServerId: number;
  info: AiCallInfo;
  /**
   * Where the caller was when they dialled.
   *
   * Kept because the call's radio announcement happens after the queue has
   * forgotten the call, and that announcement needs somewhere to send units —
   * which channel has people near it, and whose distances the roster is measured
   * from. Not the same thing as `info.location`: that is a street name if the
   * server could produce one, and null here is the ordinary case.
   */
  coords: Call911["coords"];
  answeredAt: number;
  summary: string;
  /**
   * The dispatcher has decided this call is over, and has not said so yet.
   *
   * A flag rather than `hang_up` simply ending the call, because the order
   * matters and only one of the two is survivable. Ending it inside the tool
   * drops the line — and the console with it — while the closing words are still
   * being written, so the caller is cut off mid-sentence by the thing that was
   * supposed to reassure them. The turn loop reads this after the reply has
   * actually aired, which is the only moment the call is genuinely finished.
   */
  closing: boolean;
}

const answered = new Map<number, AnsweredCall>();
const byId = new Map<string, number>();

/**
 * Take a call onto the books.
 *
 * Called after `acceptCall911` has succeeded, never before: a call that was
 * refused — the caller dropped in the meantime, somebody else got there first —
 * must not leave a frequency registered that nothing will ever clear.
 */
export function noteAnswered(call: Call911, info: AiCallInfo): AnsweredCall {
  const entry: AnsweredCall = {
    callId: call.id,
    frequency: call.frequency,
    callerServerId: call.callerServerId,
    info,
    coords: call.coords,
    answeredAt: Date.now(),
    summary: "",
    closing: false,
  };
  answered.set(call.frequency, entry);
  byId.set(call.id, call.frequency);
  return entry;
}

/** The call on a frequency, or null when it is a radio channel like any other. */
export function answeredOn(frequency: number): AnsweredCall | null {
  return answered.get(frequency) ?? null;
}

export function answeredById(callId: string): AnsweredCall | null {
  const frequency = byId.get(callId);
  return frequency === undefined ? null : (answered.get(frequency) ?? null);
}

/** The call a given caller is on, for tRadio's end event, which names the caller. */
export function answeredByCaller(callerServerId: number): AnsweredCall | null {
  for (const entry of answered.values()) {
    if (entry.callerServerId === callerServerId) return entry;
  }
  return null;
}

/** True when this frequency is a call the dispatcher is on right now. */
export function isAnsweredCall(frequency: number): boolean {
  return answered.has(frequency);
}

/** How many calls are live. The gate on picking up another one. */
export function answeredCount(): number {
  return answered.size;
}

/**
 * What the call turned out to be about, in the dispatcher's own words.
 *
 * Set by `hang_up` before the line goes down, so the announcement that follows
 * describes the call rather than repeating the text the caller typed.
 */
export function noteSummary(callId: string, summary: string): void {
  const entry = answeredById(callId);
  if (entry) entry.summary = summary.trim();
}

/**
 * Mark a call as finished once the dispatcher has said goodbye.
 *
 * Returns false when there is no such call — `hang_up` called on a line that
 * already dropped, which is a refusal the model should hear rather than a
 * silently ignored request to end something twice.
 */
export function markClosing(callId: string): boolean {
  const entry = answeredById(callId);
  if (!entry) return false;
  entry.closing = true;
  return true;
}

/**
 * Drop a call and hand back what was known about it.
 *
 * Returns the entry so the caller can still announce it: by the time this runs
 * the queue has already forgotten the call, and the announcement is the last
 * thing that needs it.
 */
export function forgetCall(callId: string): AnsweredCall | null {
  const frequency = byId.get(callId);
  if (frequency === undefined) return null;
  const entry = answered.get(frequency) ?? null;
  answered.delete(frequency);
  byId.delete(callId);
  return entry;
}

/** Resource stop. */
export function resetCalls(): void {
  answered.clear();
  byId.clear();
}
