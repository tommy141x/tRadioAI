/**
 * What a CAD can do, and what tRadio is allowed to assume about it.
 *
 * Four CAD and MDT systems were surveyed before this file existed — ImperialCAD,
 * SonoranCAD, wasabi_mdt and ps-mdt — and the finding that shaped everything is
 * that **their capabilities differ wildly**. Sonoran does nine of the ten things
 * below; wasabi does four; ImperialCAD cannot set a unit's status at all and has
 * no detach; tk_mdt has no concept of a unit status anywhere in its API.
 *
 * So the integration is capability-driven, never CAD-driven. One set of
 * dispatcher tools exists, each gated on a declared capability, and a CAD that
 * cannot do a thing simply never causes that tool to be offered. Four copies of
 * a tool set, one per CAD, would be the obvious alternative and it is wrong for a
 * measured reason: **tool-list length changes this model's behaviour**
 * (`scripts/probe-self-report.ts`). A capability-gated list keeps the shape
 * identical whichever CAD is installed, so the one measurement covers all of
 * them instead of each needing its own.
 *
 * Deliberately pure — no FiveM globals, no HTTP, no provider imports. A provider
 * profile can be read, logged and tested without a CAD anywhere near it, which is
 * the same discipline `providers.ts` follows for the AI engines.
 */

/**
 * One thing a dispatcher might need a CAD to do.
 *
 * Named for the dispatcher's intent rather than for any CAD's endpoint, so a
 * capability survives a vendor renaming theirs. `writeStatus` is listed
 * separately from `readStatus` because that split is the single biggest
 * difference between the systems surveyed: every one of them can be asked what a
 * unit is doing, and only Sonoran can be told.
 */
export type CadCapability =
  | "plate"
  /**
   * A BOLO-only vehicle check, which is NOT a plate lookup and must never be
   * presented as one.
   *
   * tk_mdt exposes `doesVehicleHaveBOLO` and `getVehicleBOLOs` and nothing that
   * reads a registration. Mapping that onto `plate` would have the dispatcher say
   * "comes back clear" when all it established was "no BOLO on file" — a materially
   * different claim, and one a unit acts on. Separate capability, different wording.
   */
  | "bolo"
  | "person"
  /**
   * A warrant check on a person, without a profile behind it.
   *
   * Same distinction as `bolo` against `plate`: tk_mdt can answer "are there
   * warrants" and cannot answer "who is this".
   */
  | "warrants"
  | "createCall"
  | "attachUnit"
  | "detachUnit"
  | "closeCall"
  | "addNote"
  | "readStatus"
  | "writeStatus"
  | "roster";

export const CAD_CAPABILITIES: readonly CadCapability[] = [
  "plate",
  "bolo",
  "person",
  "warrants",
  "createCall",
  "attachUnit",
  "detachUnit",
  "closeCall",
  "addNote",
  "readStatus",
  "writeStatus",
  "roster",
];

/**
 * How a CAD answered, once its own status vocabulary has been read for meaning.
 *
 * The distinction that earns this type its place is `transient`. Both CADs
 * surveyed in depth collapse every failure into one boolean plus a string —
 * ImperialCAD in `performAPIRequest`, Sonoran in `CadApiSupportErrorText` — so a
 * rate limit, a spent plan quota and a genuine error are indistinguishable unless
 * the caller digs into the raw response. The dispatcher **reads tool results out
 * on the air**, so getting this wrong means a unit hears "negative" and believes
 * their plate came back clean when the lookup never ran.
 *
 *  - `ok`        — it happened.
 *  - `transient` — try later. The dispatcher says "stand by", not "negative".
 *  - `quota`     — the plan or per-user limit is spent. Retrying cannot help.
 *  - `absent`    — the CAD knows of no such unit, call or identity here.
 *  - `error`     — a real failure, with a log line for the operator.
 *  - `threw`     — the CAD's own code raised. Both systems can do this.
 *  - `off`       — no CAD is connected. The tool should not have been offered.
 *  - `unsupported` — this CAD cannot do this at all. A bug if it is ever seen,
 *                    because the capability gate should have hidden the tool.
 */
export type CadResultKind =
  | "ok"
  | "transient"
  | "quota"
  | "absent"
  | "error"
  | "threw"
  | "off"
  | "unsupported";

export interface CadResult<T = Record<string, unknown>> {
  kind: CadResultKind;
  ok: boolean;
  /** The CAD's own status string when it sent one — "RATE_LIMIT", "BUSY", … */
  status?: string;
  /** The useful part of the response, already unwrapped from any envelope. */
  body?: T;
}

/** What a plate lookup is reduced to before the dispatcher sees it. */
export interface CadPlate {
  plate: string;
  owner?: string;
  stolen?: boolean;
  insured?: boolean;
  /** Free text from the CAD — "Active", "Lapsed" — when it gives one. */
  insuranceStatus?: string;
  registration?: string;
  /** Warrants or BOLOs the CAD attached to this plate, if it reports any. */
  flags?: string[];
}

/**
 * What a person lookup is reduced to before the dispatcher sees it.
 *
 * Deliberately three fields, and deliberately not a profile. The CADs that can
 * answer this return a sanitised record whose field names are documented nowhere —
 * LACORE publishes that `records` and `faction` are stripped upstream and that BOLO
 * hits arrive under `bolos`, and that is the whole of what can be relied on. So this
 * carries the two things a dispatcher actually says on the air (how many records
 * matched, and whether any of them is flagged) and nothing it would have to guess a
 * field name for. A date of birth read out of a key that might not exist is worse
 * than no date of birth.
 */
export interface CadPerson {
  /** The name as the unit gave it, echoed back so the readback names who. */
  name: string;
  /** How many records matched. Always at least 1 — no match is `absent`. */
  matches: number;
  /** Warrants or BOLOs the CAD attached to the person, where it reports any. */
  flags?: string[];
}

/** A call this dispatcher can refer to again. */
export interface CadCall {
  /** What `attachUnit` wants. A number on every CAD surveyed, carried as text. */
  ref: string;
  /** What `closeCall` wants, when the CAD distinguishes the two. Imperial does. */
  closeRef?: string;
}

/**
 * One unit as the CAD sees it.
 *
 * Every field optional because the CADs disagree on all of them, and a roster row
 * that invents a callsign is worse than one that admits it has none.
 */
export interface CadUnit {
  serverId: number;
  callsign?: string;
  /** The CAD's own status text, already mapped out of any numeric enum. */
  status?: string;
  /** "LEO", "FIRE", a department name — whatever the CAD actually reports. */
  service?: string;
}

export type CadProviderId = "imperial" | "sonoran" | "wasabi" | "tkmdt" | "psmdt" | "lacore";

/**
 * Re-type a failure for a narrower body.
 *
 * A provider's `plate()` promises `CadResult<CadPlate>`, but a failure from the
 * bridge carries the generic body type — and a failure's body is never read anyway.
 * This drops it rather than casting around the mismatch, which keeps the one thing
 * that matters on a failure path (the `kind`) exact and asserts nothing false about
 * the shape of a body that is not there.
 */
export function cadFailure<T>(result: CadResult<unknown>): CadResult<T> {
  return { kind: result.kind, ok: false, status: result.status };
}

/**
 * What to say on the air about a result that is not `ok`.
 *
 * Centralised so every CAD tool refuses identically and the one distinction that
 * matters cannot be lost at a call site: `transient` is a hold, everything else is
 * a negative. No CAD vocabulary survives into the wording — a unit does not care
 * which HTTP status a web service returned, and "RATE_LIMIT" read aloud is a bug
 * report rather than radio traffic.
 */
export function cadRefusal(result: CadResult<unknown>): string {
  switch (result.kind) {
    case "transient":
      return "the system is busy, stand by";
    case "quota":
      return "the system is not accepting that right now";
    case "absent":
      return "they are not showing on the system";
    case "off":
      return "that system is not connected";
    case "unsupported":
      return "I cannot do that from here";
    default:
      return "the system did not answer";
  }
}
