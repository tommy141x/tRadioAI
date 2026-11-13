/**
 * A stand-in for tRadio that implements the integration contract in
 * `docs/content/tradio-contract.mdx`, for tests and the offline harness.
 *
 * It exists for two reasons. The tests need a tRadio to call, and writing a fresh
 * ad-hoc stub per suite is how contracts drift: every suite ends up agreeing with
 * itself. And tRadio's own maintainers have a runnable statement of what this addon
 * expects, which is the checklist `docs/design/AD-2-contract.md` is derived from.
 *
 * Not a test file: bun's runner only collects `*.test.ts`.
 *
 * The behaviours that matter are the ones this addon depends on and cannot see from
 * the outside:
 *  - every ADD export returns a JSON string, `""`, a boolean or `{ ok, reason }`, and
 *    never throws — except a MISSING export, which throws "No such export", exactly as
 *    FiveM does (`remove()` simulates an older tRadio);
 *  - tap, station-request and CAD-request ids are unguessable tokens, and events carry
 *    them so an event another resource fakes is distinguishable;
 *  - a call answered by a station is delivered to that station's tap, whatever the
 *    tap's frequency filter says (a 911 call's frequency exists in no config).
 */

type Handler = (...args: unknown[]) => void;
type ExportFn = (...args: unknown[]) => unknown;

export interface StubChannel {
  zoneName: string;
  name: string;
  frequency: number;
  type?: "conventional" | "trunked";
}

export interface StubStation {
  name: string;
  frequencies: number[];
  answers911: boolean;
  resource: string;
}

export interface StubCall {
  id: string;
  callerServerId: number;
  callerName: string;
  message: string;
  frequency: number;
  coords: { x: number; y: number; z: number } | null;
}

export interface TransmitRecord {
  stationId: string;
  requestId: string;
  frequency: number;
  sampleRate: number;
  container: string;
  samples: number;
  maxMs: number;
}

const INVOKER = "tRadioAI";

export class StubTradio {
  // ── world ──
  channels: StubChannel[] = [];
  /** `getChannelInfo` per frequency. */
  occupancy = new Map<number, { speakers: number[]; listeners: number[]; talking: number[] }>();
  names = new Map<number, string>();
  unitIds = new Map<number, string>();
  alerts: Array<{ name: string; toneOnly?: boolean }> = [];
  tones: string[] = [];
  activeAlerts = new Map<number, string>();
  patchList: Array<{ id: string; label: string; frequencies: number[] }> = [];
  /** Frequencies `createPatch` refuses, with the reason. */
  patchRefusals = new Map<number, "direct" | "trunked">();
  humans: Array<{ serverId: number; selected: number | null; listening: number[] }> = [];
  calls = new Map<string, StubCall>();

  // ── CAD ──
  detected: Record<string, { writeStatus?: boolean }> = {};
  cadSupports: string[] = [];
  cadConsent = true;
  vocabulary: string[] = [];
  /** What `cadOperation` answers with, by `provider.op`. */
  cadAnswers = new Map<string, { kind: string; ok: boolean; status?: string; body?: unknown }>();
  /** Set to hold every CAD answer back until `releaseCad()`. */
  cadHold = false;
  private heldCad: Array<() => void> = [];

  // ── behaviour switches ──
  /** `Config.integrations` lists the caller. False makes every powerful hook refuse. */
  permitted = true;
  /** Fire `tradio:station:done` straight after `stationTransmit`. */
  autoFinish = true;
  /** Reason `stationTransmit` reports when it finishes. */
  transmitReason: "aired" | "queue_full" | "too_long" | "no_station" | "not_covered" = "aired";
  /** Reason `answer911` refuses with, while set. */
  answerRefusal: string | null = null;
  /** Number of `answer911` calls that answer `caller_offline` before one succeeds. */
  callerOfflineFor = 0;

  // ── what the addon did ──
  invocations: Array<{ name: string; args: unknown[] }> = [];
  stations = new Map<string, StubStation>();
  taps = new Map<string, { frequencies: number[] | null }>();
  transmits: TransmitRecord[] = [];
  cadRequests: Array<{ provider: string; op: string; params: Record<string, unknown> }> = [];
  ended911: string[] = [];
  answered911: Array<{ stationId: string; callId: string }> = [];

  private missing = new Set<string>();
  private handlers = new Map<string, Handler[]>();
  private nextId = 0;
  private saved = new Map<string, unknown>();
  state: "started" | "stopped" | "missing" = "started";

  // ── install ──

  install(): void {
    const g = globalThis as unknown as Record<string, unknown>;
    for (const name of ["exports", "on", "emit", "GetResourceState", "GetCurrentResourceName"]) {
      if (!this.saved.has(name)) this.saved.set(name, g[name]);
    }
    const existing = (g.exports as Record<string, unknown> | undefined) ?? {};
    g.exports = { ...existing, tRadio: this.bag() };
    g.on = (event: string, handler: Handler) => {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    };
    g.emit = (event: string, ...args: unknown[]) => this.fire(event, ...args);
    g.GetResourceState = (resource: string) => (resource === "tRadio" ? this.state : "missing");
    g.GetCurrentResourceName = () => INVOKER;
  }

  uninstall(): void {
    const g = globalThis as unknown as Record<string, unknown>;
    for (const [name, value] of this.saved) {
      if (value === undefined) delete g[name];
      else g[name] = value;
    }
    this.saved.clear();
  }

  /** Simulate an older tRadio: these exports raise "No such export" when called. */
  remove(...names: string[]): void {
    for (const name of names) this.missing.add(name);
    const g = globalThis as unknown as { exports?: Record<string, unknown> };
    if (g.exports) g.exports.tRadio = this.bag();
  }

  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  handlerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0;
  }

  private token(prefix: string): string {
    this.nextId += 1;
    return `${prefix}-${crypto.randomUUID()}-${this.nextId}`;
  }

  /**
   * Forget the world and everything the addon did, but keep the event handlers.
   *
   * The dispatcher registers its event handlers once per module execution (FiveM keeps
   * them across a superseded execution), so a suite that builds a new stub per case would
   * leave every handler on the first stub's bus. One stub, reset between cases.
   */
  reset(): void {
    this.channels = [];
    this.occupancy.clear();
    this.names.clear();
    this.unitIds.clear();
    this.alerts = [];
    this.tones = [];
    this.activeAlerts.clear();
    this.patchList = [];
    this.patchRefusals.clear();
    this.humans = [];
    this.calls.clear();
    this.detected = {};
    this.cadSupports = [];
    this.cadConsent = true;
    this.vocabulary = [];
    this.cadAnswers.clear();
    this.cadHold = false;
    this.heldCad = [];
    this.permitted = true;
    this.autoFinish = true;
    this.transmitReason = "aired";
    this.answerRefusal = null;
    this.callerOfflineFor = 0;
    this.invocations = [];
    this.stations.clear();
    this.taps.clear();
    this.transmits = [];
    this.cadRequests = [];
    this.ended911 = [];
    this.answered911 = [];
    this.missing.clear();
    this.state = "started";
    const g = globalThis as unknown as { exports?: Record<string, unknown> };
    if (g.exports) g.exports.tRadio = this.bag();
  }

  // ── the exports ──

  private bag(): Record<string, ExportFn> {
    const raw = this.exportTable();
    const out: Record<string, ExportFn> = {};
    for (const [name, fn] of Object.entries(raw)) {
      if (this.missing.has(name)) continue;
      out[name] = (...args: unknown[]) => {
        this.invocations.push({ name, args });
        return fn(...args);
      };
    }
    // A Proxy so a missing export throws as FiveM's bridge does, rather than reading
    // as `undefined` and being silently skipped.
    return new Proxy(out, {
      get: (target, key: string) => {
        if (typeof key !== "string") return undefined;
        if (key in target) return target[key];
        return () => {
          throw new Error(`No such export ${key} in resource tRadio`);
        };
      },
    });
  }

  private exportTable(): Record<string, ExportFn> {
    return {
      // ── H1: exists today ──
      getAllChannels: () =>
        this.channels.map((channel, index) => ({
          zoneId: 1,
          zoneName: channel.zoneName,
          channelId: index + 1,
          name: channel.name,
          frequency: channel.frequency,
          type: channel.type ?? "conventional",
        })),
      getChannelInfo: (frequency) => {
        const entry = this.occupancy.get(Number(frequency));
        if (!entry) return null;
        return {
          speakers: entry.speakers,
          listeners: entry.listeners,
          activeTalkers: entry.talking,
        };
      },
      getPlayerName: (serverId) => this.names.get(Number(serverId)) ?? "",
      getSubscriberInfo: (serverId) => {
        const unitId = this.unitIds.get(Number(serverId));
        return unitId === undefined ? null : { unitId, codeplugId: "leo" };
      },
      getChannelAlert: (frequency) => {
        const name = this.activeAlerts.get(Number(frequency));
        return name ? { name } : null;
      },
      setAlertOnChannel: (frequency, enabled, name) => {
        if (enabled === false) {
          this.activeAlerts.delete(Number(frequency));
          return true;
        }
        const wanted = typeof name === "string" ? name : this.alerts[0]?.name;
        if (!wanted || !this.alerts.some((alert) => alert.name === wanted)) return false;
        this.activeAlerts.set(Number(frequency), wanted);
        return true;
      },
      playToneOnChannel: () => true,

      // ── H6 ──
      getAlerts: () => JSON.stringify(this.alerts),
      getToneKeys: () => JSON.stringify(this.tones),

      // ── H6b ──
      getPatches: () => JSON.stringify(this.patchList),
      createPatch: (label, frequenciesJson) => {
        if (!this.permitted) return JSON.stringify({ ok: false, reason: "not_permitted" });
        const frequencies = JSON.parse(String(frequenciesJson)) as number[];
        if (frequencies.length < 2) return JSON.stringify({ ok: false, reason: "too_few" });
        for (const frequency of frequencies) {
          const refusal = this.patchRefusals.get(frequency);
          if (refusal) return JSON.stringify({ ok: false, reason: refusal, frequency });
          const existing = this.patchList.find((patch) => patch.frequencies.includes(frequency));
          if (existing) {
            return JSON.stringify({
              ok: false,
              reason: "already_patched",
              frequency,
              label: existing.label,
            });
          }
        }
        const id = `patch_${this.token("p")}`;
        this.patchList.push({ id, label: String(label), frequencies });
        return JSON.stringify({ ok: true, id });
      },
      removePatch: (id) => {
        const before = this.patchList.length;
        this.patchList = this.patchList.filter((patch) => patch.id !== id);
        return this.patchList.length < before;
      },

      // ── H2 ──
      registerTransmissionTap: (optsJson) => {
        if (!this.permitted) return "";
        const options = JSON.parse(String(optsJson)) as { frequencies?: number[] };
        const id = this.token("tap");
        this.taps.set(id, { frequencies: options.frequencies ?? null });
        return id;
      },
      unregisterTransmissionTap: (id) => this.taps.delete(String(id)),

      // ── H3 ──
      openStation: (optsJson) => {
        if (!this.permitted) return "";
        const options = JSON.parse(String(optsJson)) as Partial<StubStation>;
        const id = this.token("station");
        this.stations.set(id, {
          name: options.name ?? "Dispatch",
          frequencies: options.frequencies ?? [],
          answers911: options.answers911 === true,
          resource: INVOKER,
        });
        return id;
      },
      closeStation: (id) => this.stations.delete(String(id)),
      stationTransmit: (stationId, optsJson) => {
        if (!this.permitted) return "";
        const options = JSON.parse(String(optsJson)) as {
          frequency: number;
          container: string;
          sampleRate: number;
          audio: string;
          maxMs: number;
        };
        const requestId = this.token("tx");
        const station = this.stations.get(String(stationId));
        const samples = Buffer.from(options.audio, "base64").length / 2;
        this.transmits.push({
          stationId: String(stationId),
          requestId,
          frequency: options.frequency,
          sampleRate: options.sampleRate,
          container: options.container,
          samples,
          maxMs: options.maxMs,
        });
        if (this.autoFinish) {
          queueMicrotask(() => {
            const covered =
              station &&
              (station.frequencies.includes(options.frequency) || this.answeredFreq(station));
            const reason = !station ? "no_station" : !covered ? "not_covered" : this.transmitReason;
            this.finishTransmit(String(stationId), requestId, reason, samples, options.sampleRate);
          });
        }
        return requestId;
      },
      getStations: () =>
        JSON.stringify({
          stations: [...this.stations.entries()].map(([stationId, station]) => ({
            stationId,
            ...station,
          })),
          humans: this.humans,
        }),

      // ── H4 ──
      answer911: (stationId, callId) => {
        if (!this.permitted) return JSON.stringify({ ok: false, reason: "not_permitted" });
        const station = this.stations.get(String(stationId));
        const call = this.calls.get(String(callId));
        if (!station) return JSON.stringify({ ok: false, reason: "no_station" });
        if (!call) return JSON.stringify({ ok: false, reason: "unknown_call" });
        if (this.answerRefusal) return JSON.stringify({ ok: false, reason: this.answerRefusal });
        if (this.callerOfflineFor > 0) {
          this.callerOfflineFor -= 1;
          return JSON.stringify({ ok: false, reason: "caller_offline" });
        }
        station.frequencies = [...new Set([...station.frequencies, call.frequency])];
        this.answered911.push({ stationId: String(stationId), callId: String(callId) });
        return JSON.stringify({ ok: true });
      },
      end911: (callId) => {
        if (!this.calls.has(String(callId))) return false;
        this.ended911.push(String(callId));
        const call = this.calls.get(String(callId)) as StubCall;
        this.calls.delete(String(callId));
        queueMicrotask(() =>
          this.fire("tradio:911:ended", call.callerServerId, "integration_ended"),
        );
        return true;
      },

      // ── H7 ──
      cadDetect: () => this.detected,
      cadCapabilities: (provider) => {
        const chosen = String(provider) || Object.keys(this.detected)[0] || "";
        if (!chosen || this.detected[chosen] === undefined) {
          return JSON.stringify({ provider: "", supports: [], consent: this.cadConsent });
        }
        return JSON.stringify({
          provider: chosen,
          supports: this.cadConsent ? this.cadSupports : [],
          consent: this.cadConsent,
        });
      },
      cadStatusVocabulary: () => this.vocabulary,
      cadLiveCall: () => null,
      cadOperation: (provider, op, paramsJson, requestId) => {
        if (!this.permitted) return false;
        this.cadRequests.push({
          provider: String(provider),
          op: String(op),
          params: JSON.parse(String(paramsJson)) as Record<string, unknown>,
        });
        const answer = this.cadAnswers.get(`${provider}.${op}`) ?? {
          kind: "ok",
          ok: true,
          body: {},
        };
        const send = () => this.fire("tradio:cad:operationResult", String(requestId), answer);
        if (this.cadHold) this.heldCad.push(send);
        else queueMicrotask(send);
        return true;
      },
    };
  }

  private answeredFreq(station: StubStation): boolean {
    return [...this.calls.values()].some((call) => station.frequencies.includes(call.frequency));
  }

  releaseCad(): void {
    const held = this.heldCad;
    this.heldCad = [];
    for (const send of held) send();
  }

  finishTransmit(
    stationId: string,
    requestId: string,
    reason: string,
    samples = 0,
    sampleRate = 8000,
  ): void {
    this.fire("tradio:station:done", stationId, requestId, {
      ok: reason === "aired",
      reason,
      airedMs: reason === "aired" ? Math.round((samples / sampleRate) * 1000) : 0,
    });
  }

  // ── driving the addon ──

  /** The id of the tap the addon registered, or null. */
  tapId(): string | null {
    return [...this.taps.keys()].at(-1) ?? null;
  }

  /** The id of the station the addon has open, or null. */
  stationId(): string | null {
    return [...this.stations.keys()].at(-1) ?? null;
  }

  /** Deliver one ended transmission to the tap, as tRadio would. */
  transmission(
    fields: {
      serverId: number;
      frequency: number;
      name?: string;
      container?: "wav" | "webm";
      sampleRate?: number;
      audio?: Uint8Array;
      codec?: string;
    },
    tapId = this.tapId(),
  ): void {
    const audio = fields.audio ?? new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]);
    this.fire("tradio:tap:transmission", tapId, {
      serverId: fields.serverId,
      name: fields.name ?? this.names.get(fields.serverId) ?? "",
      frequency: fields.frequency,
      startedAt: Date.now() - 2000,
      endedAt: Date.now(),
      codec: fields.codec ?? "imbe",
      container: fields.container ?? "wav",
      sampleRate: fields.sampleRate ?? 16000,
      audio: Buffer.from(audio).toString("base64"),
    });
  }

  /** A call enters the queue. */
  queueCall(call: Partial<StubCall> & { id: string }): StubCall {
    const full: StubCall = {
      callerServerId: 9,
      callerName: "Caller",
      message: "help",
      frequency: 880.0001,
      coords: null,
      ...call,
    };
    this.calls.set(full.id, full);
    this.fire("tradio:911:queued", full);
    return full;
  }

  /** Put a user on a channel. */
  put(
    frequency: number,
    serverId: number,
    options: { listening?: boolean; talking?: boolean; name?: string; unitId?: string } = {},
  ): void {
    const entry = this.occupancy.get(frequency) ?? { speakers: [], listeners: [], talking: [] };
    (options.listening ? entry.listeners : entry.speakers).push(serverId);
    if (options.talking) entry.talking.push(serverId);
    this.occupancy.set(frequency, entry);
    if (options.name !== undefined) this.names.set(serverId, options.name);
    if (options.unitId !== undefined) this.unitIds.set(serverId, options.unitId);
  }

  called(name: string): Array<{ name: string; args: unknown[] }> {
    return this.invocations.filter((entry) => entry.name === name);
  }
}
