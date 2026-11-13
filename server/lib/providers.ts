/**
 * Which engine serves each half of the dispatcher, and why.
 *
 * Three capabilities, resolved independently: hearing a unit (`transcription`),
 * deciding what to do (`text`), and answering (`speech`). Independently because
 * they are genuinely separate decisions — a server may be happy running speech
 * on its own box and still want a hosted model making the decisions, and the
 * reverse is just as reasonable.
 *
 * The default for all three is `local`, and that is the whole point. An operator
 * who configures nothing gets a dispatcher that runs entirely on their own
 * machine, sends nothing anywhere and costs nothing. Hosted is an opt-in, per
 * capability, and never a silent one.
 *
 * Resolution never throws. Every way a configuration can be wrong — an unknown
 * name, a provider that does not serve that capability, a missing key — falls
 * back to local with a named warning, because a dispatcher that answers on the
 * local engine is a working radio and a dispatcher that fails to start is not.
 *
 * Deliberately pure: no HTTP, no credentials, no FiveM globals. The key itself
 * never reaches this module — `hasKey` is all a resolution decision needs, so a
 * resolved plan can be logged without redacting anything.
 *
 * The vocabulary here is tAI's, on purpose. Both resources are configured the
 * same way by the same people.
 */

export type Capability = "text" | "speech" | "transcription";

export const CAPABILITIES: readonly Capability[] = ["text", "speech", "transcription"];

export type ProviderId = "local" | "openai" | "openrouter" | "groq" | "vercel" | "elevenlabs";

interface ProviderProfile {
  serves: readonly Capability[];
  /** Base URL for the OpenAI-shaped routes. Absent for the local engine. */
  baseUrl?: string;
  needsKey: boolean;
  /**
   * Whether a request without a model id is refused.
   *
   * Every hosted OpenAI-shaped endpoint refuses one: OpenAI with
   * `400 you must provide a model parameter`, which an operator who wrote
   * `providers = { text = { provider = 'openai' } }` hit on every turn. Resolved at
   * configuration time instead, so the mistake is named once at start with the fix,
   * and not discovered as a failed turn in the middle of a shift. ElevenLabs is the
   * exception: it picks a default when `model_id` is absent.
   */
  needsModel: boolean;
}

/**
 * Every provider tRadio can reach, and which capabilities each one serves.
 *
 * This used to be "only providers that speak the three OpenAI-shaped routes",
 * and `elevenlabs` is the first entry that does not. It serves speech on a
 * different route, with a different auth header and a different request body —
 * see `speech-dialect.ts`, which owns that difference so this table and the
 * resolver stay shape-agnostic. The rule is now the weaker and more honest one:
 * a provider is listed when tRadio has a dialect for it.
 */
const PROFILES: Record<ProviderId, ProviderProfile> = {
  local: { serves: CAPABILITIES, needsKey: false, needsModel: false },
  openai: {
    serves: CAPABILITIES,
    baseUrl: "https://api.openai.com/v1",
    needsKey: true,
    needsModel: true,
  },
  openrouter: {
    serves: ["text"],
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    needsModel: true,
  },
  groq: {
    serves: CAPABILITIES,
    baseUrl: "https://api.groq.com/openai/v1",
    needsKey: true,
    needsModel: true,
  },
  // TEXT ONLY, and this is a correction rather than a restriction: it never served
  // the other two. Vercel's AI Gateway is OpenAI-shaped at `/v1` for chat
  // completions and nothing else — its audio lives on a different API version with
  // a different protocol entirely:
  //
  //   speech         POST /v4/ai/speech-model          (not /v1/audio/speech)
  //   transcription  POST /v4/ai/transcription-model   (not /v1/audio/transcriptions)
  //
  // Both take the model in an `ai-model-id` header rather than the body, require two
  // `ai-*-version` headers, and answer with JSON carrying base64 audio or text —
  // never the raw bytes `pcmFromResponse` reads. Transcription additionally takes
  // base64 in a JSON body; Vercel's docs state multipart uploads are not supported,
  // which is what tRadio sends.
  //
  // Listing all three made the panel offer a pairing that cannot work, and asking
  // for speech produced `404 invalid_request_error: Invalid URL (POST
  // /v1/audio/speech)` — reported 2026-10-19 by an operator whose dispatcher heard
  // the call, drafted the reply and then logged "skipped: could not air the
  // go-ahead" on every single turn.
  //
  // Narrowed rather than implemented because a dialect is not the whole cost here:
  // the response is a different SHAPE, not just a different route, so it needs a
  // decode path of its own. Until that exists, `serves` must describe what tRadio
  // can actually reach — this file's own rule, stated above: a provider is listed
  // for a capability when tRadio has a dialect for it. Asking vercel for speech now
  // falls back to the local engine with a named reason, like any other mismatch,
  // instead of failing per turn against a route that is not there.
  vercel: {
    serves: ["text"],
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    needsKey: true,
    needsModel: true,
  },
  // Speech ONLY, and that is the product rather than a limitation: ElevenLabs has
  // no chat-completions or transcription route tRadio could use. Asking it for
  // `text` falls back to local with a named reason, like any other mismatch.
  elevenlabs: {
    serves: ["speech"],
    baseUrl: "https://api.elevenlabs.io/v1",
    needsKey: true,
    needsModel: false,
  },
};

/**
 * Every provider that can serve `capability`, `local` first.
 *
 * Exported so the admin panel can offer a picker that cannot express an impossible
 * pairing. The alternative — the frontend carrying its own copy of which provider
 * serves what — is a second table that goes stale the first time one is added, and the
 * symptom would be a dropdown offering ElevenLabs for transcription.
 *
 * `local` leads because it is the default and the honest answer for an operator who
 * has not decided.
 */
export function providersServing(capability: Capability): ProviderId[] {
  return (Object.keys(PROFILES) as ProviderId[]).filter((id) =>
    PROFILES[id].serves.includes(capability)
  );
}

/** Whether a provider needs an API key. `local` does not. */
export function providerNeedsKey(provider: ProviderId): boolean {
  return PROFILES[provider].needsKey;
}

export function isProviderId(value: string): value is ProviderId {
  return (PROFILES as Record<string, ProviderProfile | undefined>)[value] !== undefined;
}

/** Server convar a hosted provider's key is read from. Derived, never tabled. */
export function keyConvar(provider: ProviderId): string {
  return `tradioai_${provider}_key`;
}

/** One capability as the operator wrote it, with the key already reduced to a boolean. */
export interface CapabilityConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
  hasKey?: boolean;
}

export interface ResolvedCapability {
  provider: ProviderId;
  /** Empty for local, where the model is whatever artifact is installed. */
  model: string;
  /** Empty for local. */
  baseUrl: string;
  hosted: boolean;
  /** Why this ended up local when something else was asked for. Empty otherwise. */
  note: string;
}

export type ProviderPlan = Record<Capability, ResolvedCapability>;

/**
 * The capabilities this plan will serve from the local engine.
 *
 * Lives here, beside `CAPABILITIES`, rather than in `weights.ts` where it used
 * to: the model weights and the engine binaries are two separate downloads that
 * must agree exactly about which capabilities are local, and when `weights.ts`
 * owned this the engine installer had to import from it — a cycle, since the
 * weights flow is what triggers the engine install. One definition in the module
 * that defines what a capability IS, and no second copy of the rule to drift.
 */
export function localCapabilities(plan: ProviderPlan): Capability[] {
  return CAPABILITIES.filter((capability) => !plan[capability].hosted);
}

const LOCAL: ResolvedCapability = {
  provider: "local",
  model: "",
  baseUrl: "",
  hosted: false,
  note: "",
};

function local(note: string): ResolvedCapability {
  return { ...LOCAL, note };
}

function text(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

/**
 * Read one capability's configuration, dropping the key immediately.
 *
 * The operator writes `key = "sk-..."` in their own config; what leaves this
 * function is `hasKey: true`. Nothing downstream of here can leak a credential
 * into a log line, a diagnostic or an error message, because nothing downstream
 * of here has one.
 */
export function parseCapability(raw: unknown): CapabilityConfig {
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  const key = text(record.key, 512);
  return {
    provider: text(record.provider, 32).toLowerCase() || undefined,
    model: text(record.model, 128) || undefined,
    baseUrl: text(record.baseUrl, 256).replace(/\/+$/, "") || undefined,
    hasKey: key.length > 0 || record.hasKey === true,
  };
}

export function resolveCapability(
  capability: Capability,
  config: CapabilityConfig | undefined
): ResolvedCapability {
  const wanted = config?.provider;
  if (!wanted || wanted === "local") return LOCAL;

  if (!isProviderId(wanted)) {
    return local(`unknown provider "${wanted}" for ${capability}; using the local engine`);
  }

  const profile = PROFILES[wanted];
  if (!profile.serves.includes(capability)) {
    return local(
      `${wanted} does not serve ${capability} (it serves ${profile.serves.join(", ")}); using the local engine`
    );
  }
  if (profile.needsKey && config?.hasKey !== true) {
    return local(
      `${wanted} needs an API key and none is set in ${keyConvar(wanted)}; using the local engine`
    );
  }

  if (profile.needsModel && !config?.model) {
    return local(
      `${wanted} needs a model for ${capability}; set providers.${capability}.model in config.lua ` +
        `(\`tradioai_models ${wanted}\` lists them); using the local engine`
    );
  }

  return {
    provider: wanted,
    model: config?.model ?? "",
    // An explicit baseUrl wins, so a compatible proxy or a self-hosted gateway
    // can be reached under a provider's name without a code change.
    baseUrl: config?.baseUrl ?? profile.baseUrl ?? "",
    hosted: true,
    note: "",
  };
}

/** Resolve all three. An absent or empty configuration is an all-local one. */
export function resolveProviders(raw?: Record<string, unknown>): ProviderPlan {
  const source = raw ?? {};
  return {
    text: resolveCapability("text", parseCapability(source.text)),
    speech: resolveCapability("speech", parseCapability(source.speech)),
    transcription: resolveCapability("transcription", parseCapability(source.transcription)),
  };
}

/** True when nothing leaves the machine. */
export function isFullyLocal(plan: ProviderPlan): boolean {
  return CAPABILITIES.every((capability) => !plan[capability].hosted);
}

/** One line per capability, safe to log: no keys pass through here. */
export function describePlan(plan: ProviderPlan): string[] {
  return CAPABILITIES.map((capability) => {
    const resolved = plan[capability];
    const where = resolved.hosted
      ? `${resolved.provider}${resolved.model ? ` (${resolved.model})` : ""}`
      : "local";
    return resolved.note ? `${capability}: ${where} — ${resolved.note}` : `${capability}: ${where}`;
  });
}
