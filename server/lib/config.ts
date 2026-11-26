/**
 * Runtime configuration for the AI dispatcher.
 *
 * Everything the operator sets lives in `config/config.lua`, which
 * `server/sv_config.lua` pushes here as one payload on start and whenever the
 * resource's config is reloaded, so a partial push cannot leave the feature
 * half-configured. The one exception is provider API keys: those are
 * `server.cfg` convars (`tradioai_<provider>_key`), read at the point of use.
 *
 * Nothing here validates a key: a wrong key is a runtime failure with a clear
 * error from the provider, and a key-shaped check would only ever be wrong about
 * someone's self-hosted endpoint.
 */

import { aiLog } from "./logger";
import { normalizeFrequency } from "./frequency";
import { hostedAllowed, noteHostedCall } from "./budget";
import {
  configureLocal,
  localEndpoint,
  resourceRoot,
  localFailure,
  localSpeechFailure,
  stopLocalEngines,
} from "./local-engine";
import { DEFAULT_DEMEANOR, DEMEANORS, isDemeanor } from "./prompt";
import {
  type Capability,
  CAPABILITIES,
  describePlan,
  isProviderId,
  keyConvar,
  type ProviderId,
  type ProviderPlan,
  resolveProviders,
} from "./providers";
import { speechRoute } from "./speech-dialect";
import type { AiDispatchConfig, VoiceGender } from "./types";

/** One capability's resolved endpoint, ready to call. Local and hosted look identical here. */
export interface CapabilityEndpoint {
  /** The full URL to POST to, route included. */
  url: string;
  apiKey: string;
  model: string;
  hosted: boolean;
  /**
   * Which provider this is, so a caller can pick the request dialect.
   *
   * Added for ElevenLabs, whose speech route, auth header and body all differ from
   * the OpenAI shape every other provider uses (see `speech-dialect.ts`). The URL
   * alone cannot carry that, and sniffing the hostname would be a guess.
   */
  provider: ProviderId;
}

/**
 * The route a hosted, OpenAI-compatible provider serves each capability on.
 *
 * Only hosted providers are assumed to follow this shape. A local engine names
 * its own route, because whisper.cpp does not have these paths at all.
 */
const HOSTED_ROUTES: Record<Capability, string> = {
  text: "/chat/completions",
  speech: "/audio/speech",
  transcription: "/audio/transcriptions",
};

/**
 * The route for one capability on one provider.
 *
 * Only speech varies, and only for ElevenLabs — `speechRoute` owns that so the
 * knowledge sits beside the request builder that depends on it rather than being
 * split across two files that have to agree.
 */
function routeFor(provider: ProviderId, capability: Capability): string {
  return capability === "speech" ? speechRoute(provider) : HOSTED_ROUTES[capability];
}

export interface ProviderConfig {
  /** Provider voice ids to choose from, per gender. */
  voices: { male: string[]; female: string[] };
}

const DEFAULTS: AiDispatchConfig = {
  enabled: false,
  channels: [],
  yieldToDispatcher: true,
  auto911: true,
  answer911: false,
  callsign: "Dispatch",
  voiceGender: "female",
  demeanor: DEFAULT_DEMEANOR,
  wakePhrases: ["dispatch"],
  /**
   * No codes by default, deliberately.
   *
   * A shipped code sheet would be one agency's, and a dispatcher confidently acting on
   * "10-50" under the wrong meaning is worse than one that treats it as an opaque token
   * the unit said. Operators who use codes declare their own; those who do not lose
   * nothing.
   */
  tenCodes: {} as Record<string, string>,
  cad: "",
  // 15 s was chosen when a turn that had not answered in 15 s was a unit sitting
  // in silence, and cutting it off was kinder than leaving them there. The hold
  // changed that: the unit is told to stand by at 1.2 s, so the rest of the
  // budget is spent by somebody who knows they were heard. Measured on a loaded
  // box, decisions that ran 19–20 s were being killed at 15 s *and taking their
  // tool call with them* — the status never got set, which is worse than a slow
  // answer. The ceiling below still caps a genuinely stuck request at a minute.
  turnTimeoutMs: 30000,
  // 3 s: long enough that one unit cannot drive a turn per key-up, short enough that a
  // unit correcting themselves straight away ("disregard, make that 10-6") is still
  // answered. Not measured against the scanner feed — it carries no speaker labels, so
  // the gap between consecutive transmissions by the SAME unit cannot be counted from
  // it. Treat this as a starting value chosen to be unnoticeable, not a derived one.
  turnCooldownMs: 3000,
  // Off, deliberately. See the field's note in types.ts: an upgrade must not start
  // capping somebody's dispatcher mid-incident.
  hostedCallsPerMinute: 0,
};

/**
 * Voices the local engine ships with, named the way its own voice files are.
 *
 * These are Piper voice names, which are also the file stems under the voices
 * directory. An operator on a hosted provider overrides them with that
 * provider's own names — `alloy` and `nova` on OpenAI, for instance.
 */
const PROVIDER_DEFAULTS: ProviderConfig = {
  voices: { male: ["en_US-ryan-medium"], female: ["en_US-amy-medium"] },
};

let current: AiDispatchConfig = { ...DEFAULTS, channels: [] };
let provider: ProviderConfig = { voices: { male: [], female: [] } };
let plan: ProviderPlan = resolveProviders();

/**
 * Tell the resolver which providers have a key, without handing it the key.
 *
 * ⛔ This was MISSING, and its absence made every hosted provider unreachable.
 *
 * `providers.ts` is deliberately pure — no credentials, so a resolved plan can be
 * logged without redacting anything — and it decides whether a hosted provider is
 * usable from a boolean, `hasKey`. Nothing in the running server ever set that
 * boolean: `parseCapability` reads it from the payload, and the payload Lua sends is
 * `{ provider, model }` because keys live in the credential store, not in config.lua.
 *
 * So `resolveCapability` always took its `needsKey && hasKey !== true` branch and fell
 * back to the local engine with the note "needs an API key and none is set in
 * tradio_<provider>_key" — WHICH IS THE SAME NOTE AN ACTUALLY MISSING KEY PRODUCES.
 * An operator who had stored a key correctly saw a message telling them they had not,
 * and no amount of re-pasting it would have changed anything.
 *
 * The lookup belongs here rather than in `providers.ts`: this module already reads the
 * store for `keyFor`, and moving it there would put a credential inside the one module
 * whose contract is that it never sees one.
 */
function withKeyPresence(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const capability of CAPABILITIES) {
    const entry = raw[capability];
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const wanted = typeof record.provider === "string" ? record.provider.toLowerCase() : "";
    out[capability] = {
      ...record,
      // Only ever a boolean leaves here. `local` needs no key, and an unknown name is
      // the resolver's to reject with its own message.
      hasKey: isProviderId(wanted) && wanted !== "local" ? keyFor(wanted).length > 0 : false,
    };
  }
  return out;
}

export function aiConfig(): AiDispatchConfig {
  return current;
}

export function providerConfig(): ProviderConfig {
  return provider;
}

export function providerPlan(): ProviderPlan {
  return plan;
}

/**
 * Where a capability is actually served from right now.
 *
 * Resolved per call rather than cached because a local engine starts on first
 * use: asking for the endpoint is what brings it up. Async for the same reason —
 * the first ask waits out a model load, and every ask after it returns
 * immediately. Null means the capability cannot be served — a hosted provider
 * with no endpoint, or a local one whose runtime or weights are not installed —
 * and the dispatcher stays quiet.
 */
export async function endpointFor(
  capability: Capability,
  signal?: AbortSignal,
): Promise<CapabilityEndpoint | null> {
  const resolved = plan[capability];
  // The ceiling is consulted here rather than in the turn path because this is the one
  // place every capability's endpoint is resolved: a cap applied to the text call alone
  // would miss roughly two thirds of the hosted spend a single turn makes.
  if (resolved.hosted && hostedAllowed(current.hostedCallsPerMinute)) {
    if (!resolved.baseUrl) return null;
    noteHostedCall(capability);
    return {
      url: `${resolved.baseUrl}${routeFor(resolved.provider, capability)}`,
      apiKey: keyFor(resolved.provider),
      model: resolved.model,
      hosted: true,
      provider: resolved.provider,
    };
  }

  const local = await localEndpoint(capability, signal);
  if (!local) return null;
  return { url: local.url, apiKey: "", model: local.model, hosted: false, provider: "local" };
}

/** Why a capability is unavailable, in words an operator can act on. */
export function endpointFailure(capability: Capability): string {
  const resolved = plan[capability];
  if (resolved.hosted) {
    return resolved.baseUrl ? "" : `${resolved.provider} has no endpoint configured`;
  }
  if (capability === "speech") return localSpeechFailure(voiceFor(current.voiceGender));
  return localFailure(capability) || "the local engine is not available";
}

/**
 * The voice this dispatcher speaks with.
 *
 * Stable per gender rather than picked per turn: the dispatcher is one person,
 * and a voice that changes between transmissions reads as two.
 */
export function voiceFor(gender: VoiceGender): string {
  return provider.voices[gender][0] ?? "";
}

/**
 * The key for a hosted provider, read from its `server.cfg` convar.
 *
 * Read at the point of use rather than stored with the rest of the config, so a
 * key never sits in the same object that gets logged, passed over an event or
 * serialised into a diagnostic. It is also why the key is a convar and not a
 * `config.lua` field: `config.lua` is an operator-edited file that gets pasted
 * into support threads, and `server.cfg` convars are the FiveM place for secrets.
 */
function keyFor(provider: ProviderId): string {
  return GetConvar(keyConvar(provider), "");
}

/** True when this frequency is one the dispatcher is configured to monitor. */
export function monitorsFrequency(frequency: number): boolean {
  if (!current.enabled) return false;
  return current.channels.includes(frequency);
}

function str(value: unknown, fallback: string, maxLength = 64): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.slice(0, maxLength);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * The server's ten-code table, as `code` -> meaning.
 *
 * Accepts a Lua table, so both shapes a server can send are handled: a map
 * `{ ["10-50"] = "traffic accident" }` and an array of pairs. Lua drops nil, so a key
 * with no meaning simply is not there.
 *
 * Also accepts a single line, `10-4=acknowledged, 10-50=traffic accident`, so a code
 * sheet can be pasted as typed rather than rewritten as a table. Entries may be separated by commas, semicolons or
 * newlines, and `=` or `:` may join a code to its meaning — a meaning containing a comma
 * is the one thing this cannot express, which is why the cap is 48 characters of plain
 * description and not a sentence.
 *
 * Capped and length-limited like every other operator list — the codes ride in whisper's
 * initial prompt, which is a bounded window shared with the callsigns and channels, and
 * a hundred codes would crowd out the names that matter more.
 */
function codeTable(value: unknown, maxItems = 24): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (code: unknown, meaning: unknown): void => {
    if (typeof code !== "string" || typeof meaning !== "string") return;
    const key = code.trim();
    const text = meaning.trim();
    if (!key || !text || key.length > 16 || text.length > 48) return;
    if (Object.keys(out).length >= maxItems) return;
    out[key] = text;
  };

  if (typeof value === "string") {
    for (const entry of value.split(/[,;\n\r]+/)) {
      // `split` on the FIRST separator only: a meaning may legitimately contain
      // one, as in "10-39 = run code 3, no siren" — which the entry split above
      // would already have broken, but "signal 4: traffic = accident" survives.
      const at = entry.search(/[=:]/);
      if (at < 0) continue;
      add(entry.slice(0, at), entry.slice(at + 1));
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (Array.isArray(entry)) add(entry[0], entry[1]);
      else if (entry && typeof entry === "object") {
        const pair = entry as { code?: unknown; meaning?: unknown };
        add(pair.code, pair.meaning);
      }
    }
    return out;
  }
  if (value && typeof value === "object") {
    for (const [code, meaning] of Object.entries(value as Record<string, unknown>)) {
      add(code, meaning);
    }
  }
  return out;
}

function stringList(value: unknown, maxItems = 16, maxLength = 48): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > maxLength) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Normalize the channel list.
 *
 * Frequencies arrive as whatever the config holds — a string like
 * "460.1250", a number, a Lua-round-tripped float — and every comparison later
 * is an exact `includes()`. Anything `normalizeFrequency` rejects is dropped with
 * a named warning rather than kept as NaN, which would silently match nothing.
 */
function channelList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    try {
      const frequency = normalizeFrequency(entry as never);
      if (!out.includes(frequency)) out.push(frequency);
    } catch {
      aiLog.warn(`config: dropping unusable channel ${JSON.stringify(entry)}`);
    }
  }
  return out;
}

/**
 * The demeanour key, resolved against the table in `prompt.ts`.
 *
 * This is the half of the feature the card calls "picked outside the model": the key
 * becomes one prompt line and the catalogue stays here, so there is nothing for the
 * model to choose between.
 *
 * Blank resolves silently, because blank is the documented default and is what every
 * server that has never set the key sends. A key that is present and WRONG is the
 * opposite case — somebody typed a manner and got none of it — so that one is named,
 * with what was used instead and what it could have been. The list is safe in a log
 * line for exactly the reason it is not safe in a prompt: nothing reads a log back to
 * the model.
 */
function demeanorKey(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_DEMEANOR;
  const wanted = value.trim().toLowerCase();
  if (!wanted) return DEFAULT_DEMEANOR;
  if (isDemeanor(wanted)) return wanted;
  aiLog.warn(
    `config: unknown dispatcher demeanor ${JSON.stringify(value)} — using ` +
      `${DEFAULT_DEMEANOR}. One of: ${Object.keys(DEMEANORS).join(", ")}`,
  );
  return DEFAULT_DEMEANOR;
}

function gender(value: unknown): VoiceGender {
  return value === "male" || value === "female" ? value : DEFAULTS.voiceGender;
}

const trimSlash = (value: string) => value.replace(/[\\/]+$/, "");

export function applyAiConfig(raw: unknown): void {
  const payload = (raw ?? {}) as Record<string, unknown>;

  current = {
    enabled: bool(payload.enabled, false),
    channels: channelList(payload.channels),
    yieldToDispatcher: bool(payload.yieldToDispatcher, DEFAULTS.yieldToDispatcher),
    auto911: bool(payload.auto911, DEFAULTS.auto911),
    answer911: bool(payload.answer911, DEFAULTS.answer911),
    callsign: str(payload.callsign, DEFAULTS.callsign, 32),
    voiceGender: gender(payload.voiceGender),
    demeanor: demeanorKey(payload.demeanor),
    wakePhrases: (() => {
      const phrases = stringList(payload.wakePhrases);
      return phrases.length > 0 ? phrases : DEFAULTS.wakePhrases;
    })(),
    tenCodes: codeTable(payload.tenCodes),
    // Lowercased and trimmed so "SonoranCAD " in a config file still matches a
    // provider id. An unknown name is NOT corrected here — the registry refuses it
    // loudly, which is the behaviour an operator needs to see.
    cad: typeof payload.cad === "string" ? payload.cad.trim().toLowerCase() : "",
    turnTimeoutMs: (() => {
      const value = Number(payload.turnTimeoutMs);
      // Below a couple of seconds nothing can complete and the feature looks
      // broken; above a minute a stuck request holds a talker slot all shift.
      return Number.isFinite(value)
        ? Math.min(60000, Math.max(2000, value))
        : DEFAULTS.turnTimeoutMs;
    })(),
    // Both spend controls clamp to 0 rather than rejecting a negative: 0 is the
    // documented "off" for each of them, so a typo disables the control instead of
    // silently inverting it.
    turnCooldownMs: (() => {
      const value = Number(payload.turnCooldownMs);
      // Capped at a minute. A cooldown longer than that is indistinguishable from the
      // dispatcher having stopped answering that unit, which is a support ticket.
      return Number.isFinite(value) ? Math.min(60000, Math.max(0, value)) : DEFAULTS.turnCooldownMs;
    })(),
    hostedCallsPerMinute: (() => {
      const value = Number(payload.hostedCallsPerMinute);
      return Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : DEFAULTS.hostedCallsPerMinute;
    })(),
  };

  const providerRaw = (payload.provider ?? {}) as Record<string, unknown>;
  const voicesRaw = (providerRaw.voices ?? {}) as Record<string, unknown>;
  provider = {
    voices: {
      male: stringList(voicesRaw.male),
      female: stringList(voicesRaw.female),
    },
  };
  if (provider.voices.male.length === 0) provider.voices.male = PROVIDER_DEFAULTS.voices.male;
  if (provider.voices.female.length === 0) provider.voices.female = PROVIDER_DEFAULTS.voices.female;

  plan = resolveProviders(withKeyPresence((payload.providers ?? {}) as Record<string, unknown>));

  const localRaw = (payload.localEngine ?? {}) as Record<string, unknown>;
  const requestedRoot = str(localRaw.root, "", 256);
  configureLocal({
    root: requestedRoot,
    textModel: str(localRaw.textModel, "", 256),
    transcribeModel: str(localRaw.transcribeModel, "", 256),
    voicesDir: str(localRaw.voicesDir, "", 256),
  });
  // tLib starts an engine only from this resource's own folder, whatever root the
  // download went to. Said once at config time, because the symptom otherwise is a
  // launcher refusal that names the program and not the folder.
  if (requestedRoot && trimSlash(requestedRoot) !== trimSlash(resourceRoot())) {
    aiLog.warn(
      `config: localEngine.root is ${requestedRoot}, outside this resource. tLib starts engines ` +
        "only from this resource's own folder, so engines downloaded there will not be found " +
        "unless server/bin inside the resource links to them. Models and voices are read from " +
        "that root as configured.",
    );
  }

  aiLog.debug(
    `config: enabled=${current.enabled} channels=${current.channels.length} ` +
      `yield=${current.yieldToDispatcher} voice=${current.voiceGender}`,
  );
  // Same level as the summary above it: which engine each capability resolved to is
  // a steady-state fact the operator set in config.lua and can read back there.
  //
  // Except when it is not what they asked for. `resolved.note` is non-empty only on
  // the fallback paths -- unknown provider, provider that does not serve this
  // capability, missing API key -- where the operator configured a hosted provider
  // and silently got the local engine. That one stays loud.
  // describePlan is `CAPABILITIES.map(...)`, so index i is CAPABILITIES[i].
  const planLines = describePlan(plan);
  for (const [index, capability] of CAPABILITIES.entries()) {
    const line = `config: ${planLines[index]}`;
    if (plan[capability].note) aiLog.warn(line);
    else aiLog.debug(line);
  }
}

/** Reset to shipped defaults. Called from `resetState()` on resource stop. */
export function resetAiConfig(): void {
  current = { ...DEFAULTS, channels: [] };
  provider = { voices: { male: [], female: [] } };
  plan = resolveProviders();
  stopLocalEngines();
}
