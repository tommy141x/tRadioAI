/**
 * Which CAD the dispatcher talks to, and what it can do there.
 *
 * tRadio owns the six CAD integrations (LACORE, SonoranCAD, ImperialCAD, wasabi_mdt,
 * tk_mdt, ps-mdt). They know each system's exports, identities and status
 * vocabularies, and they reduce every answer to a few fields before it leaves
 * tRadio, so this resource never sees a CAD's raw record. What this file adds is the
 * choice between them, and a facade whose methods exist only for the capabilities
 * the chosen CAD declares — so `cad-tools.ts` never offers a tool the CAD cannot do.
 *
 * The operator's consent is tRadio's `Config.cad.tools`, reported in
 * `cadCapabilities().consent`. There is deliberately no second switch here: two
 * switches for one consent is two places to look when a tool is missing.
 */

import { aiConfig } from "./config";
import { aiLog } from "./logger";
import {
  CAD_TIMEOUT_SLOW_MS,
  cadCapabilities,
  cadDetect,
  cadLiveCall,
  cadOperation,
  cadStatusVocabulary,
} from "./tradio-hooks";
import { callFor, forgetCall, rememberCall } from "./cad-calls";
import { mapSpokenStatus } from "./cad-status";
import {
  type CadCall,
  type CadCapability,
  type CadPerson,
  type CadPlate,
  type CadProviderId,
  type CadResult,
  cadFailure,
} from "./cad-types";

/**
 * Detection order when more than one CAD is running: the richest first, which is rarely
 * wrong and is still a guess — `cad` in `config.lua` is the way to say which.
 */
const ORDER: readonly CadProviderId[] = ["lacore", "sonoran", "imperial", "wasabi", "tkmdt", "psmdt"];

export interface CadFacade {
  id: CadProviderId;
  supports: ReadonlySet<CadCapability>;
  plate?: (plate: string) => Promise<CadResult<CadPlate>>;
  bolo?: (plate: string) => Promise<CadResult<CadPlate>>;
  person?: (name: string) => Promise<CadResult<CadPerson>>;
  warrants?: (name: string) => Promise<CadResult<{ warrants: boolean }>>;
  createCall?: (serverId: number, about: string) => Promise<CadResult<CadCall>>;
  attachUnit?: (serverId: number, call: CadCall) => Promise<CadResult>;
  detachUnit?: (serverId: number) => Promise<CadResult>;
  closeCall?: (serverId: number, call: CadCall) => Promise<CadResult>;
  addNote?: (serverId: number, note: string) => Promise<CadResult>;
  writeStatus?: (serverId: number, spoken: string) => Promise<CadResult>;
  /** Synchronous: only LACORE can say which call a unit is on, and it answers from a cache. */
  liveCall?: (serverId: number) => CadCall | null;
}

function ask(provider: CadProviderId, op: string, params: Record<string, unknown>) {
  return cadOperation(provider, op, params, CAD_TIMEOUT_SLOW_MS);
}

function build(id: CadProviderId, supports: ReadonlySet<CadCapability>): CadFacade {
  const facade: CadFacade = { id, supports };
  const has = (capability: CadCapability) => supports.has(capability);

  if (has("plate")) {
    facade.plate = async (plate) => {
      const result = await ask(id, "plate", { plate });
      return result.ok && result.body
        ? { kind: "ok", ok: true, body: result.body as unknown as CadPlate }
        : cadFailure<CadPlate>(result);
    };
  }
  if (has("bolo")) {
    facade.bolo = async (plate) => {
      const result = await ask(id, "bolo", { plate });
      return result.ok && result.body
        ? { kind: "ok", ok: true, body: result.body as unknown as CadPlate }
        : cadFailure<CadPlate>(result);
    };
  }
  if (has("person")) {
    facade.person = async (name) => {
      const result = await ask(id, "person", { name });
      return result.ok && result.body
        ? { kind: "ok", ok: true, body: result.body as unknown as CadPerson }
        : cadFailure<CadPerson>(result);
    };
  }
  if (has("warrants")) {
    facade.warrants = async (name) => {
      const result = await ask(id, "warrants", { name });
      return result.ok && result.body
        ? { kind: "ok", ok: true, body: { warrants: result.body.warrants === true } }
        : cadFailure<{ warrants: boolean }>(result);
    };
  }
  if (has("createCall")) {
    facade.createCall = async (serverId, about) => {
      const result = await ask(id, "createCall", { serverId, about });
      if (!result.ok) return cadFailure<CadCall>(result);
      const ref = typeof result.body?.ref === "string" ? result.body.ref : "";
      if (!ref) return { kind: "ok", ok: true, body: { ref: "" } };
      const closeRef = typeof result.body?.closeRef === "string" ? result.body.closeRef : undefined;
      const call = { ref, closeRef, about, openedAt: Date.now() };
      rememberCall(serverId, call);
      return { kind: "ok", ok: true, body: call };
    };
  }
  if (has("attachUnit")) {
    facade.attachUnit = (serverId, call) =>
      ask(id, "attachUnit", { serverId, ref: call.ref, closeRef: call.closeRef });
  }
  if (has("detachUnit")) {
    facade.detachUnit = (serverId) => ask(id, "detachUnit", { serverId });
  }
  if (has("closeCall")) {
    facade.closeCall = async (serverId, call) => {
      const result = await ask(id, "closeCall", {
        serverId,
        ref: call.ref,
        closeRef: call.closeRef,
      });
      if (result.ok) forgetCall(serverId);
      return result;
    };
  }
  if (has("addNote")) {
    facade.addNote = (serverId, note) =>
      ask(id, "addNote", { serverId, note, ref: callFor(serverId)?.ref });
  }
  if (has("writeStatus")) {
    facade.writeStatus = async (serverId, spoken) => {
      // The ten-code sheet is the operator's and lives in this resource's config; the
      // CAD only knows its own status names, so the spoken words are mapped to one of
      // those here and tRadio is handed a name it can match exactly.
      const status = mapSpokenStatus(spoken, cadStatusVocabulary(id), aiConfig().tenCodes ?? {});
      // Refused, not failed: nothing is broken, and retrying will not help. The
      // dispatcher has nothing it can confidently write.
      if (!status) return { kind: "absent", ok: false };
      return ask(id, "writeStatus", { serverId, status });
    };
  }
  if (id === "lacore") {
    facade.liveCall = (serverId) => {
      const live = cadLiveCall(id, serverId);
      return live ? { ref: live.ref } : null;
    };
  }
  return facade;
}

let lastChosen: string | null = null;

function announce(key: string | null, message: string): void {
  if (lastChosen === key) return;
  lastChosen = key;
  if (message) aiLog.info(message);
}

let cached: { at: number; value: CadFacade | null } | null = null;
const CACHE_MS = 1_000;

/**
 * The CAD in use right now, or null.
 *
 * Asked live (cached for a second) rather than captured at start: `server.cfg` start
 * order is arbitrary, so a CAD that came up after this resource would otherwise latch
 * "off" for the whole session — which looks exactly like the integration not working.
 */
export function activeCad(): CadFacade | null {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = choose();
  cached = { at: now, value };
  return value;
}

function choose(): CadFacade | null {
  const detected = cadDetect();
  const pinned = aiConfig().cad;

  let provider: CadProviderId | null = null;
  if (pinned !== "") {
    if (!ORDER.includes(pinned as CadProviderId)) {
      announce(`unknown:${pinned}`, `cad: no provider named "${pinned}" — CAD tools are off`);
      return null;
    }
    if (detected[pinned] === undefined) {
      announce(`down:${pinned}`, `cad: ${pinned} is pinned but not running — CAD tools are off`);
      return null;
    }
    provider = pinned as CadProviderId;
  } else {
    const found = ORDER.filter((id) => detected[id] !== undefined);
    if (found.length === 0) {
      announce(null, "");
      return null;
    }
    provider = found[0] as CadProviderId;
    if (found.length > 1) {
      announce(
        `auto:${provider}`,
        `cad: ${found.length} CADs running — using ${provider}, ignoring ${found.slice(1).join(", ")}. ` +
          "Set `cad` in config.lua if that is the wrong one."
      );
    }
  }

  const capabilities = cadCapabilities(provider);
  if (capabilities.provider === "") {
    announce(`none:${provider}`, `cad: tRadio does not offer ${provider} to this resource — CAD tools are off`);
    return null;
  }
  if (!capabilities.consent) {
    announce(
      `consent:${provider}`,
      "cad: tRadio's `Config.cad.tools` is off, so CAD tools are off here too"
    );
    return null;
  }
  announce(`use:${provider}`, `cad: using ${provider}`);
  return build(provider, new Set(capabilities.supports));
}

export function resetCad(): void {
  cached = null;
  lastChosen = null;
}
