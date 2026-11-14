/**
 * The only file in this resource that knows tRadio's integration contract.
 *
 * Everything else asks this module for channels, units, alerts, patches, stations,
 * transmissions, 911 calls and CAD operations, in this resource's own types. If
 * tRadio renames an export or changes a payload, this is the one place that moves;
 * `docs/content/tradio-contract.mdx` is the same contract written for the tRadio
 * side, and `scripts/tests/` drives this file against a stub that implements it.
 *
 * ## Conventions every call here follows
 *
 * - tRadio's integration exports never throw into the caller. A refusal is an
 *   empty string, `false`, or `{ ok: false, reason }`, and this module turns each
 *   into a typed failure so a caller never has to know which.
 * - A MISSING export is the one thing that does throw — FiveM raises
 *   `No such export <name> in resource <resource>` — so existence can only be
 *   learned by calling. {@link probe} therefore calls the read-only exports and
 *   the inverse of each write-ish export (`closeStation("probe")`,
 *   `unregisterTransmissionTap("probe")`, `end911("probe")`, `removePatch("probe")`)
 *   with an id that cannot exist, which every one of them answers with `false`
 *   and no side effect.
 * - Events from tRadio are local server events, and any resource on the server can
 *   fire one with any payload. Every event that carries audio or a result is
 *   therefore matched against an unguessable id this module issued or was issued
 *   (tap id, station request id, CAD request id) and dropped otherwise.
 *
 * ## Degrading
 *
 * {@link probe} reports a {@link Capabilities}. The addon runs only when tRadio is
 * started and offers the channel, tap and station hooks; each of the rest turns
 * off just the feature that needs it (911, alerts and tones, patches, CAD tools).
 * It never falls back to tRadio's Socket.IO API: that would need an IMBE decoder
 * and encoder, which tRadio deliberately does not hand out.
 */

import { aiLog } from "./logger";
import type { RosterView } from "./roster";
import type { CadCapability, CadProviderId, CadResult } from "./cad-types";

export const TRADIO_RESOURCE = "tRadio";

/**
 * The rate of every WAV the tap delivers. whisper-server is started without `--convert`
 * (ffmpeg is absent from most game panels), so it reads exactly this format; a WAV at
 * any other rate would be transcribed as garbage with no error, which is why the tap
 * handler refuses one rather than passing it on.
 */
export const STT_SAMPLE_RATE = 16000;

type ExportFn = (...args: unknown[]) => unknown;

interface Globals {
  exports?: Record<string, Record<string, ExportFn>>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  GetResourceState?: (resource: string) => string;
  GetCurrentResourceName?: () => string;
}

const g = globalThis as unknown as Globals;

// ─── raw calls ────────────────────────────────────────────────────────────────

type Called<T> = { ok: true; value: T } | { ok: false; missing: boolean; error: string };

/**
 * Call a tRadio export. Never throws.
 *
 * Resolved through `globalThis`: the bundler shadows a bare `exports` with the CJS
 * one, which has no resource entries.
 */
function call<T = unknown>(name: string, ...args: unknown[]): Called<T> {
  try {
    const bag = g.exports?.[TRADIO_RESOURCE];
    const fn = bag?.[name];
    if (typeof fn !== "function") return { ok: false, missing: true, error: `no export ${name}` };
    return { ok: true, value: fn(...args) as T };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, missing: /no such export/i.test(message), error: message };
  }
}

/** A JSON string, an already-decoded table, or nothing. */
function decode(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  if (value === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Lua sends a sequential table as an array and anything else as an object; take both. */
function list(value: unknown): unknown[] {
  const decoded = decode(value);
  if (Array.isArray(decoded)) return decoded;
  if (decoded && typeof decoded === "object") return Object.values(decoded as object);
  return [];
}

function numbers(value: unknown): number[] {
  return list(value)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry));
}

function record(value: unknown): Record<string, unknown> {
  const decoded = decode(value);
  return decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? (decoded as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Unguessable, because anything with the id can speak to a listener of the event it names. */
function token(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// ─── capability probe ─────────────────────────────────────────────────────────

export interface Capabilities {
  /** tRadio's resource state: "absent" when it is not installed at all. */
  state: "absent" | "stopped" | "started";
  /** Channels, users, names, subscriber info. Required. */
  read: boolean;
  /** Hear finished transmissions. Required. */
  tap: boolean;
  /** Open a station and transmit as it. Required. */
  station: boolean;
  /** Queue event, answer and end a 911 call. Optional: without it, no 911. */
  calls911: boolean;
  /** Alert and tone names plus the actions. Optional. */
  alerts: boolean;
  /** Read, create and remove patches. Optional. */
  patches: boolean;
  /** CAD detection, capabilities and operations. Optional. */
  cad: boolean;
  /** Every hook name that was probed and absent, for the one-line message. */
  missing: string[];
}

const NO_CAPABILITIES: Capabilities = {
  state: "absent",
  read: false,
  tap: false,
  station: false,
  calls911: false,
  alerts: false,
  patches: false,
  cad: false,
  missing: [],
};

function tradioState(): Capabilities["state"] {
  const state = g.GetResourceState?.(TRADIO_RESOURCE);
  if (state === undefined || state === "missing" || state === "unknown") return "absent";
  return state === "started" ? "started" : "stopped";
}

/** Which probes make up each capability. Every name is a real tRadio export. */
const PROBES: Record<
  Exclude<keyof Capabilities, "state" | "missing">,
  Array<[string, unknown[]]>
> = {
  read: [
    ["getAllChannels", []],
    ["getChannelInfo", ["0"]],
    ["getPlayerName", [0]],
    ["getSubscriberInfo", [0]],
  ],
  tap: [["unregisterTransmissionTap", ["probe"]]],
  station: [
    ["getStations", []],
    ["closeStation", ["probe"]],
  ],
  calls911: [["end911", ["probe"]]],
  alerts: [
    ["getAlerts", []],
    ["getToneKeys", []],
    ["getChannelAlert", ["0"]],
  ],
  patches: [
    ["getPatches", []],
    ["removePatch", ["probe"]],
  ],
  cad: [
    ["cadDetect", []],
    ["cadCapabilities", [""]],
  ],
};

let latest: Capabilities = NO_CAPABILITIES;

/** The result of the last {@link probe}. Cheap, which the per-turn tool gates need. */
export function capabilities(): Capabilities {
  return latest;
}

/**
 * Ask tRadio what it offers. Each call makes about a dozen export calls, so it runs at
 * start, when tRadio starts or stops, and on the retry beat — never per turn.
 */
export function probe(): Capabilities {
  latest = measure();
  return latest;
}

function measure(): Capabilities {
  const state = tradioState();
  if (state !== "started") return { ...NO_CAPABILITIES, state };

  const result: Capabilities = { ...NO_CAPABILITIES, state, missing: [] };
  for (const key of Object.keys(PROBES) as Array<keyof typeof PROBES>) {
    let all = true;
    for (const [name, args] of PROBES[key]) {
      const outcome = call(name, ...args);
      if (!outcome.ok && outcome.missing) {
        all = false;
        result.missing.push(name);
      }
    }
    result[key] = all;
  }
  return result;
}

/**
 * The one console line that says why the addon is idle, or "" when it can run.
 *
 * Lines name the exact thing the operator has to do, which is the whole point of a
 * degrade rule: "tRadioAI is off" with no reason is a support ticket.
 */
export function idleReason(capabilities: Capabilities): string {
  if (capabilities.state === "absent") {
    return `tRadio is not installed on this server. Install tRadio, then start tRadioAI after it.`;
  }
  if (capabilities.state === "stopped") {
    return "tRadio is not running. tRadioAI will start working as soon as tRadio starts.";
  }
  const required = ["read", "tap", "station"] as const;
  if (required.every((key) => capabilities[key])) return "";
  const lacking = required.filter((key) => !capabilities[key]);
  return (
    `this tRadio is too old for tRadioAI: it lacks the ${lacking.join(" and ")} integration hooks ` +
    `(${capabilities.missing.join(", ")}). Update tRadio to a version that lists "integration hooks" ` +
    "in its changelog."
  );
}

/**
 * What to tell the operator when tRadio refuses a call.
 *
 * tRadio only answers the powerful hooks for resources named in its own
 * `Config.integrations`, which is empty by default and which the addon cannot edit.
 */
export function refusalLine(hook: string): string {
  const me = g.GetCurrentResourceName?.() ?? "tRadioAI";
  return (
    `tRadio refused ${hook}. Add this line to tRadio's config/config.lua, then restart tRadio: ` +
    `Config.integrations = { '${me}' }`
  );
}

/**
 * Stations (this resource's and any other integration's) take server ids from a
 * reserved negative block, which is how a roster or an audience count tells them from
 * people. The block is tRadio's — `STATION_ID_BASE` there — and this is its mirror.
 */
export const STATION_ID_MIN = -890999;
export const STATION_ID_MAX = -890000;

export function isStationId(serverId: number): boolean {
  return serverId >= STATION_ID_MIN && serverId <= STATION_ID_MAX;
}

// ─── channels, units, alerts, patches ────────────────────────────────────────

export interface TradioChannel {
  zoneName: string;
  name: string;
  frequency: number;
  type: "conventional" | "trunked";
}

export function channels(): TradioChannel[] {
  const outcome = call("getAllChannels");
  if (!outcome.ok) return [];
  const out: TradioChannel[] = [];
  for (const entry of list(outcome.value)) {
    const row = record(entry);
    const frequency = Number(row.frequency);
    if (!Number.isFinite(frequency)) continue;
    out.push({
      zoneName: text(row.zoneName),
      name: text(row.name),
      frequency,
      type: row.type === "trunked" ? "trunked" : "conventional",
    });
  }
  return out;
}

/**
 * Everybody on one channel, in the shape the roster and presence rules take.
 *
 * `getChannelInfo` answers per channel, so a user's view here only ever names the
 * channel it was asked about — which is all both consumers read.
 */
export function usersOn(frequency: number): Array<RosterView & { talking: boolean }> {
  const outcome = call("getChannelInfo", String(frequency));
  if (!outcome.ok) return [];
  const info = record(outcome.value);
  const talking = new Set(numbers(info.activeTalkers));
  const out: Array<RosterView & { talking: boolean }> = [];
  for (const serverId of numbers(info.speakers)) {
    out.push({
      serverId,
      speakerChannel: frequency,
      listeningChannels: new Set(),
      isTalking: talking.has(serverId),
      talking: talking.has(serverId),
    });
  }
  for (const serverId of numbers(info.listeners)) {
    if (out.some((user) => user.serverId === serverId)) continue;
    out.push({
      serverId,
      speakerChannel: null,
      listeningChannels: new Set([frequency]),
      isTalking: talking.has(serverId),
      talking: talking.has(serverId),
    });
  }
  return out;
}

/** The callsign when callsigns are on, the player's name otherwise. */
export function playerName(serverId: number): string {
  const outcome = call("getPlayerName", serverId);
  return outcome.ok ? text(outcome.value) : "";
}

/** The codeplug unit id ("1041"), or "" when unassigned. */
export function unitId(serverId: number): string {
  const outcome = call("getSubscriberInfo", serverId);
  if (!outcome.ok) return "";
  const id = record(outcome.value).unitId;
  return typeof id === "string" || typeof id === "number" ? String(id) : "";
}

/** The active alert's name on a frequency, or null. */
export function alertOn(frequency: number): string | null {
  const outcome = call("getChannelAlert", String(frequency));
  if (!outcome.ok) return null;
  const name = record(outcome.value).name;
  return typeof name === "string" && name !== "" ? name : null;
}

/** Alert names this server offers, excluding tone-only alerts. */
export function alertNames(): string[] {
  const outcome = call("getAlerts");
  if (!outcome.ok) return [];
  const out: string[] = [];
  for (const entry of list(outcome.value)) {
    const row = record(entry);
    if (typeof row.name === "string" && row.name !== "" && row.toneOnly !== true)
      out.push(row.name);
  }
  return out;
}

export function toneNames(): string[] {
  const outcome = call("getToneKeys");
  if (!outcome.ok) return [];
  return list(outcome.value).filter(
    (entry): entry is string => typeof entry === "string" && entry !== "",
  );
}

/** Raise (`name` set) or lift (`name` null) an alert. False when nothing matched. */
export function setAlert(frequency: number, enabled: boolean, name: string | null): boolean {
  const outcome = call("setAlertOnChannel", String(frequency), enabled, name ?? undefined);
  return outcome.ok && outcome.value === true;
}

export function playTone(frequency: number, tone: string): boolean {
  const outcome = call("playToneOnChannel", String(frequency), tone);
  return outcome.ok && outcome.value === true;
}

export interface TradioPatch {
  id: string;
  label: string;
  frequencies: number[];
}

export function patches(): TradioPatch[] {
  const outcome = call("getPatches");
  if (!outcome.ok) return [];
  const out: TradioPatch[] = [];
  for (const entry of list(outcome.value)) {
    const row = record(entry);
    if (typeof row.id !== "string") continue;
    out.push({ id: row.id, label: text(row.label), frequencies: numbers(row.frequencies) });
  }
  return out;
}

export type PatchRefusal =
  | {
      ok: false;
      reason: "direct" | "trunked" | "already_patched";
      frequency: number;
      label?: string;
    }
  | { ok: false; reason: "not_permitted" | "disabled" | "unknown_channel" | "failed" };

export function createPatch(
  label: string,
  frequencies: number[],
): { ok: true; id: string } | PatchRefusal {
  const outcome = call("createPatch", label, JSON.stringify(frequencies));
  if (!outcome.ok) return { ok: false, reason: "failed" };
  const row = record(outcome.value);
  if (row.ok === true && typeof row.id === "string") return { ok: true, id: row.id };
  const reason = row.reason;
  if (reason === "direct" || reason === "trunked" || reason === "already_patched") {
    return {
      ok: false,
      reason,
      frequency: Number(row.frequency),
      label: typeof row.label === "string" ? row.label : undefined,
    };
  }
  if (reason === "not_permitted") {
    aiLog.warn(refusalLine("createPatch"));
    return { ok: false, reason };
  }
  if (reason === "disabled" || reason === "unknown_channel") return { ok: false, reason };
  return { ok: false, reason: "failed" };
}

export function removePatch(id: string): boolean {
  const outcome = call("removePatch", id);
  return outcome.ok && outcome.value === true;
}

// ─── stations (the dispatcher's voice) ───────────────────────────────────────

export interface StationsView {
  /** Human dispatchers signed on to the dispatch panel. */
  humans: Array<{ serverId: number; selected: number | null; listening: number[] }>;
}

let stationsCache: { at: number; value: StationsView } | null = null;
const STATIONS_TTL_MS = 400;

/**
 * Who is on the dispatch panel. Cached for well under a second: the sweep asks once per
 * tick and a turn asks a few more times, and none of them needs an answer fresher than
 * the beat a human dispatcher takes to sign on.
 */
export function stations(now = Date.now()): StationsView {
  if (stationsCache && now - stationsCache.at < STATIONS_TTL_MS) return stationsCache.value;
  const outcome = call("getStations");
  const humans: StationsView["humans"] = [];
  if (outcome.ok) {
    for (const entry of list(record(outcome.value).humans)) {
      const row = record(entry);
      const serverId = Number(row.serverId);
      if (!Number.isFinite(serverId)) continue;
      const selected = Number(row.selected);
      humans.push({
        serverId,
        selected: Number.isFinite(selected) && row.selected !== null ? selected : null,
        listening: numbers(row.listening),
      });
    }
  }
  stationsCache = { at: now, value: { humans } };
  return stationsCache.value;
}

export function resetStationsCache(): void {
  stationsCache = null;
}

export interface StationOptions {
  name: string;
  frequencies: number[];
  answers911: boolean;
}

/** The station's id, or null when tRadio refused (see {@link refusalLine}) or has no such hook. */
export function openStation(options: StationOptions): string | null {
  const outcome = call("openStation", JSON.stringify(options));
  if (!outcome.ok) return null;
  const id = text(outcome.value);
  if (id === "") {
    aiLog.warn(refusalLine("openStation"));
    return null;
  }
  return id;
}

export function closeStation(stationId: string): boolean {
  const outcome = call("closeStation", stationId);
  return outcome.ok && outcome.value === true;
}

export type StationReason =
  | "aired"
  | "queue_full"
  | "too_long"
  | "no_station"
  | "not_covered"
  | "encode_failed";

/**
 * tRadio's limits on one `stationTransmit` payload. It answers `""` for anything outside
 * them, the same `""` it answers an unlisted resource with, so they are checked here and
 * the operator is not told to edit `Config.integrations` over an oversize clip.
 */
const TRANSMIT_RATE_MIN = 4000;
const TRANSMIT_RATE_MAX = 48000;
const TRANSMIT_BASE64_MAX = 2_700_000;

export interface TransmitResult {
  ok: boolean;
  reason: StationReason | "timeout" | "refused";
  airedMs: number;
}

interface PendingTransmit {
  stationId: string;
  resolve: (result: TransmitResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingTransmits = new Map<string, PendingTransmit>();

/**
 * Put PCM on the air as a station.
 *
 * `accepted` is false when tRadio refused the audio outright. `done` resolves when
 * tRadio says it has finished airing (or refused), never rejects, and gives up after
 * `timeoutMs` — a `done` that never comes must not hold a turn open.
 */
export function transmit(
  stationId: string,
  options: { frequency: number; pcm: Int16Array; sampleRate: number; maxMs: number },
  timeoutMs: number,
): { accepted: boolean; done: Promise<TransmitResult> } {
  const audio = Buffer.from(options.pcm.buffer, options.pcm.byteOffset, options.pcm.byteLength);
  const encoded = audio.toString("base64");
  if (
    encoded === "" ||
    encoded.length > TRANSMIT_BASE64_MAX ||
    options.sampleRate < TRANSMIT_RATE_MIN ||
    options.sampleRate > TRANSMIT_RATE_MAX
  ) {
    aiLog.warn(
      `stationTransmit: ${audio.byteLength} bytes at ${options.sampleRate} Hz is outside what tRadio accepts, not sent`,
    );
    return { accepted: false, done: Promise.resolve({ ok: false, reason: "refused", airedMs: 0 }) };
  }
  const outcome = call(
    "stationTransmit",
    stationId,
    JSON.stringify({
      frequency: options.frequency,
      container: "pcm16",
      sampleRate: options.sampleRate,
      audio: encoded,
      maxMs: options.maxMs,
    }),
  );
  const requestId = outcome.ok ? text(outcome.value) : "";
  if (requestId === "") {
    if (outcome.ok) aiLog.warn(refusalLine("stationTransmit"));
    return { accepted: false, done: Promise.resolve({ ok: false, reason: "refused", airedMs: 0 }) };
  }
  const done = new Promise<TransmitResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingTransmits.delete(requestId);
      aiLog.warn(`tRadio did not report ${requestId} finished within ${timeoutMs}ms`);
      resolve({ ok: false, reason: "timeout", airedMs: 0 });
    }, timeoutMs);
    pendingTransmits.set(requestId, { stationId, resolve, timer });
  });
  return { accepted: true, done };
}

function onStationDone(stationId: unknown, requestId: unknown, payload: unknown): void {
  const id = text(requestId);
  const waiting = pendingTransmits.get(id);
  // Not an error: a result after its timeout, or one nobody here asked for.
  if (!waiting || waiting.stationId !== text(stationId)) return;
  pendingTransmits.delete(id);
  clearTimeout(waiting.timer);
  const row = record(payload);
  const reason = text(row.reason) as StationReason;
  waiting.resolve({
    ok: row.ok === true,
    reason: reason || (row.ok === true ? "aired" : "refused"),
    airedMs: Number(row.airedMs) || 0,
  });
}

// ─── hearing transmissions ───────────────────────────────────────────────────

export interface Transmission {
  serverId: number;
  name: string;
  frequency: number;
  startedAt: number;
  endedAt: number;
  codec: string;
  container: "wav" | "webm";
  sampleRate: number;
  audio: Uint8Array;
}

let tapId: string | null = null;
let tapHandler: ((transmission: Transmission) => void) | null = null;

/**
 * Hear every ended transmission on `frequencies`. Returns false when tRadio refused
 * or has no such hook; the caller retries on its own schedule.
 */
export function registerTap(
  frequencies: number[],
  handler: (transmission: Transmission) => void,
): boolean {
  if (tapId) {
    call("unregisterTransmissionTap", tapId);
    tapId = null;
  }
  const outcome = call("registerTransmissionTap", JSON.stringify({ frequencies }));
  const id = outcome.ok ? text(outcome.value) : "";
  if (id === "") {
    if (outcome.ok) aiLog.warn(refusalLine("registerTransmissionTap"));
    return false;
  }
  tapId = id;
  tapHandler = handler;
  return true;
}

export function unregisterTap(): void {
  if (tapId) call("unregisterTransmissionTap", tapId);
  tapId = null;
  tapHandler = null;
}

function onTapTransmission(id: unknown, payload: unknown): void {
  // Matched on the token tRadio issued, so another resource firing this event with a
  // made-up clip is ignored rather than transcribed and answered.
  if (!tapId || text(id) !== tapId || !tapHandler) return;
  const row = record(payload);
  const serverId = Number(row.serverId);
  const frequency = Number(row.frequency);
  const container = row.container === "webm" ? "webm" : row.container === "wav" ? "wav" : null;
  const encoded = text(row.audio);
  if (!Number.isFinite(serverId) || !Number.isFinite(frequency) || !container || encoded === "") {
    return;
  }
  const sampleRate = Number(row.sampleRate) || STT_SAMPLE_RATE;
  if (container === "wav" && sampleRate !== STT_SAMPLE_RATE) {
    aiLog.warn(
      `tRadio delivered a ${sampleRate} Hz WAV; ${STT_SAMPLE_RATE} Hz is the contract, so it was dropped`,
    );
    return;
  }
  const audio = new Uint8Array(Buffer.from(encoded, "base64"));
  if (audio.length === 0) return;
  try {
    tapHandler({
      serverId,
      name: text(row.name),
      frequency,
      startedAt: Number(row.startedAt) || Date.now(),
      endedAt: Number(row.endedAt) || Date.now(),
      codec: text(row.codec),
      container,
      sampleRate,
      audio,
    });
  } catch (err) {
    aiLog.warn(`transmission handler threw — ${(err as Error).message}`);
  }
}

// ─── 911 ─────────────────────────────────────────────────────────────────────

export interface Call911 {
  id: string;
  callerServerId: number;
  callerName: string;
  message: string;
  frequency: number;
  coords: { x: number; y: number; z: number } | null;
}

/** tRadio's own reason string, passed through. This resource reads three of them by name. */
export type Call911EndReason = string;

let queuedHandler: ((call: Call911) => void) | null = null;
let endedHandler: ((callerServerId: number, reason: Call911EndReason) => void) | null = null;

export function onCallQueued(handler: ((call: Call911) => void) | null): void {
  queuedHandler = handler;
}

/**
 * A call ended, however it ended. tRadio's `tradio:911:ended` carries the caller's
 * server id and the reason rather than a call record, which is enough: this resource
 * only needs the event for the one call it answered, and it knows that caller.
 */
export function onCallEnded(
  handler: ((callerServerId: number, reason: Call911EndReason) => void) | null,
): void {
  endedHandler = handler;
}

function parseCall(payload: unknown): Call911 | null {
  const row = record(payload);
  const id = text(row.id) || (typeof row.id === "number" ? String(row.id) : "");
  if (id === "") return null;
  const raw = record(row.coords);
  const coords =
    Number.isFinite(Number(raw.x)) && Number.isFinite(Number(raw.y)) && raw.x !== undefined
      ? { x: Number(raw.x), y: Number(raw.y), z: Number(raw.z) || 0 }
      : null;
  return {
    id,
    callerServerId: Number(row.callerServerId) || 0,
    callerName: text(row.callerName),
    message: text(row.message),
    frequency: Number(row.frequency) || 0,
    coords,
  };
}

/**
 * Pick the call up as `stationId`. tRadio opens the station on the call's frequency
 * and only then accepts it, because a call whose channel has nobody on it is swept.
 * Returns a reason on refusal, "" on success.
 */
export function answer911(stationId: string, callId: string): { ok: boolean; reason: string } {
  const outcome = call("answer911", stationId, callId);
  if (!outcome.ok) return { ok: false, reason: outcome.missing ? "unsupported" : "failed" };
  const row = record(outcome.value);
  if (row.ok === true) return { ok: true, reason: "" };
  const reason = text(row.reason) || "failed";
  if (reason === "not_permitted") aiLog.warn(refusalLine("answer911"));
  return { ok: false, reason };
}

export function end911(callId: string): boolean {
  const outcome = call("end911", callId);
  return outcome.ok && outcome.value === true;
}

// ─── CAD ─────────────────────────────────────────────────────────────────────

export interface CadCapabilities {
  /** The provider tRadio would use, or "" when none. */
  provider: CadProviderId | "";
  supports: CadCapability[];
  /** The operator's `Config.cad.tools` consent in tRadio. False hides every CAD tool. */
  consent: boolean;
}

/** Providers tRadio can currently reach, as `{ [provider]: { writeStatus } }`. */
export function cadDetect(): Record<string, { writeStatus?: boolean }> {
  const outcome = call("cadDetect");
  return outcome.ok ? (record(outcome.value) as Record<string, { writeStatus?: boolean }>) : {};
}

export function cadCapabilities(provider: string): CadCapabilities {
  const outcome = call("cadCapabilities", provider);
  if (!outcome.ok) return { provider: "", supports: [], consent: false };
  const row = record(outcome.value);
  return {
    provider: text(row.provider) as CadProviderId | "",
    supports: list(row.supports).filter(
      (entry): entry is CadCapability => typeof entry === "string",
    ),
    consent: row.consent === true,
  };
}

export function cadStatusVocabulary(provider: string): string[] {
  const outcome = call("cadStatusVocabulary", provider);
  if (!outcome.ok) return [];
  return list(outcome.value).filter((entry): entry is string => typeof entry === "string");
}

/** Which call a CAD says a unit is on. Only LACORE answers; everyone else gets null. */
export function cadLiveCall(provider: string, serverId: number): { ref: string } | null {
  const outcome = call("cadLiveCall", provider, serverId);
  if (!outcome.ok) return null;
  const ref = record(outcome.value).ref;
  return typeof ref === "string" && ref !== "" ? { ref } : null;
}

interface PendingCad {
  resolve: (result: CadResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingCad = new Map<string, PendingCad>();

export const CAD_TIMEOUT_MS = 6_000;
export const CAD_TIMEOUT_SLOW_MS = 15_000;

/**
 * One CAD operation, answered with tRadio's own reduced result (`CadPlate`,
 * `CadPerson`, `CadCall`: a few fields, never the CAD's raw record). Never rejects:
 * every failure arrives as a result with a `kind`, because a tool has to say
 * something either way and the hold-versus-negative distinction lives in `kind`.
 */
export function cadOperation(
  provider: string,
  op: string,
  params: Record<string, unknown>,
  timeoutMs = CAD_TIMEOUT_MS,
): Promise<CadResult> {
  const requestId = token("cad");
  const outcome = call("cadOperation", provider, op, JSON.stringify(params), requestId);
  if (!outcome.ok) {
    return Promise.resolve({ kind: outcome.missing ? "off" : "threw", ok: false });
  }
  if (outcome.value !== true) {
    aiLog.warn(refusalLine("cadOperation"));
    return Promise.resolve({ kind: "off", ok: false });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCad.delete(requestId);
      aiLog.warn(`cad: ${provider}.${op} did not answer in ${timeoutMs}ms`);
      resolve({ kind: "transient", ok: false });
    }, timeoutMs);
    pendingCad.set(requestId, { resolve, timer });
  });
}

const CAD_KINDS = new Set([
  "ok",
  "transient",
  "quota",
  "absent",
  "error",
  "threw",
  "off",
  "unsupported",
]);

function onCadResult(requestId: unknown, payload: unknown): void {
  const waiting = pendingCad.get(text(requestId));
  if (!waiting) return;
  pendingCad.delete(text(requestId));
  clearTimeout(waiting.timer);
  const row = record(payload);
  const kind = CAD_KINDS.has(text(row.kind)) ? (text(row.kind) as CadResult["kind"]) : "error";
  waiting.resolve({
    kind,
    ok: row.ok === true && kind === "ok",
    status: typeof row.status === "string" ? row.status : undefined,
    body:
      row.body && typeof row.body === "object" ? (row.body as Record<string, unknown>) : undefined,
  });
}

// ─── event wiring ────────────────────────────────────────────────────────────

let wired = false;

/**
 * Register the event handlers once per module execution. FiveM keeps handlers from a
 * superseded execution alive, and a second registration would deliver every
 * transmission twice.
 */
export function wireEvents(): void {
  if (wired) return;
  const on = g.on;
  if (typeof on !== "function") return;
  wired = true;
  on("tradio:tap:transmission", (id, payload) => onTapTransmission(id, payload));
  on("tradio:station:done", (stationId, requestId, payload) =>
    onStationDone(stationId, requestId, payload),
  );
  on("tradio:cad:operationResult", (requestId, payload) => onCadResult(requestId, payload));
  on("tradio:911:queued", (payload) => {
    const parsed = parseCall(payload);
    if (parsed && queuedHandler) queuedHandler(parsed);
  });
  on("tradio:911:ended", (callerServerId, reason) => {
    const caller = Number(callerServerId);
    if (Number.isFinite(caller) && endedHandler) endedHandler(caller, text(reason) || "ended");
  });
}

/**
 * tRadio stopped: every id it issued is void. Pending waits are released rather than
 * left to time out, so a turn in flight finishes as silence instead of holding a channel.
 */
export function lostTradio(): void {
  tapId = null;
  for (const [id, waiting] of pendingTransmits) {
    clearTimeout(waiting.timer);
    waiting.resolve({ ok: false, reason: "refused", airedMs: 0 });
    pendingTransmits.delete(id);
  }
  for (const [id, waiting] of pendingCad) {
    clearTimeout(waiting.timer);
    waiting.resolve({ kind: "off", ok: false });
    pendingCad.delete(id);
  }
  stationsCache = null;
  latest = NO_CAPABILITIES;
}

/** Drop every outstanding wait, for resource stop and for tests. */
export function resetHooks(): void {
  unregisterTap();
  for (const waiting of pendingTransmits.values()) clearTimeout(waiting.timer);
  pendingTransmits.clear();
  for (const waiting of pendingCad.values()) clearTimeout(waiting.timer);
  pendingCad.clear();
  stationsCache = null;
  queuedHandler = null;
  endedHandler = null;
  latest = NO_CAPABILITIES;
}

/** Test seam: forget that handlers were registered, so a fresh bus gets them. */
export function resetWiring(): void {
  wired = false;
}
