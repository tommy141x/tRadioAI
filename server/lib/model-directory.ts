/**
 * Listing the models a provider will actually accept, using its stored key.
 *
 * ## Why this is fetched rather than tabled
 *
 * The obvious alternative is a hardcoded list of "common models" per provider. It is
 * wrong within weeks: providers rename, deprecate and add models constantly, and a
 * stale suggestion is worse than none — an operator picks `gpt-4o-mini` from a
 * dropdown, the provider 404s it, and the dispatcher falls back to local with a
 * message about the model rather than about the list that offered it.
 *
 * Every hosted provider publishes its own catalogue, so `tradioai_models` asks. The
 * list is therefore always current and nothing here has to be maintained.
 *
 * ## The two dialects
 *
 * `openai`, `groq`, `openrouter` and `vercel` all serve the OpenAI-shaped
 * `GET /models` returning `{ data: [{ id }] }`. ElevenLabs serves `GET /models` as a
 * bare array keyed on `model_id`, with the same auth difference as its speech route —
 * `xi-api-key` rather than `Authorization: Bearer`. That split already exists in
 * `speech-dialect.ts`; this file is the read-only counterpart and keeps the difference
 * in one place for the same reason.
 *
 * ## Not filtered by capability, deliberately
 *
 * `GET /models` returns a provider's whole catalogue, and nothing in those responses
 * reliably says which capability a model serves — OpenAI lists embeddings, moderation
 * and image models beside the chat ones with no machine-readable distinction. Guessing
 * from the name (`whisper`, `tts`, `gpt`) would be a heuristic that silently hides a
 * model the operator wanted. So the full list is returned and the console prints it
 * searchable, which is honest about what is known and faster to use than a wrong
 * filter.
 *
 * ## Failure is always an empty list with a reason
 *
 * No key, a revoked key, a network timeout: every one resolves rather than throwing,
 * and the console prints a hint per reason. The model field stays free text throughout,
 * so a provider that cannot be listed never blocks configuration.
 */

import { aiLog } from "./logger";
import { isProviderId, keyConvar, type ProviderId } from "./providers";

const log = aiLog;

/** Long enough for a cold connection, short enough not to hold `tradioai_models` open. */
const TIMEOUT_MS = 10_000;

/** A catalogue changes rarely; asking twice in a minute gets the same answer. */
const TTL_MS = 60_000;

export type ModelListResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: "no_key" | "unauthorized" | "unsupported" | "unreachable" };

interface Entry {
  at: number;
  value: ModelListResult;
}
const cache = new Map<ProviderId, Entry>();

/** Base URLs, duplicated from the provider registry's private table on purpose:
 *  that table is about resolution, this is about a read-only admin convenience, and
 *  exporting it would make the registry's shape part of two contracts. */
const MODEL_ROUTES: Partial<Record<ProviderId, { url: string; dialect: "openai" | "elevenlabs" }>> =
  {
    openai: { url: "https://api.openai.com/v1/models", dialect: "openai" },
    groq: { url: "https://api.groq.com/openai/v1/models", dialect: "openai" },
    openrouter: { url: "https://openrouter.ai/api/v1/models", dialect: "openai" },
    vercel: { url: "https://ai-gateway.vercel.sh/v1/models", dialect: "openai" },
    elevenlabs: { url: "https://api.elevenlabs.io/v1/models", dialect: "elevenlabs" },
  };

/** Model ids out of either response shape. Unknown shapes yield nothing, not a throw. */
export function parseModels(dialect: "openai" | "elevenlabs", body: unknown): string[] {
  if (dialect === "elevenlabs") {
    if (!Array.isArray(body)) return [];
    return body
      .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>).model_id : null))
      .filter((id): id is string => typeof id === "string");
  }
  const data = (body as Record<string, unknown> | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>).id : null))
    .filter((id): id is string => typeof id === "string");
}

/**
 * The models `provider` will accept, sorted.
 *
 * `local` is not listed: its model is whichever artifact is installed under the local
 * engine's root, which `config.lua`'s `localEngine` names and this has no view of.
 */
export async function listModels(provider: string): Promise<ModelListResult> {
  if (!isProviderId(provider) || provider === "local") return { ok: false, reason: "unsupported" };
  const route = MODEL_ROUTES[provider];
  if (!route) return { ok: false, reason: "unsupported" };

  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at <= TTL_MS) return hit.value;

  // Read at the point of use, never held: the shorter a key's lifetime in any object,
  // the fewer the ways it reaches a log or a diagnostic.
  const key = GetConvar(keyConvar(provider), "");
  if (!key) return { ok: false, reason: "no_key" };

  const headers: Record<string, string> =
    route.dialect === "elevenlabs" ? { "xi-api-key": key } : { Authorization: `Bearer ${key}` };

  let result: ModelListResult;
  try {
    const response = await fetch(route.url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers,
    });
    if (response.status === 401 || response.status === 403) {
      log.warn(
        `${provider} refused the model list with ${response.status} — the stored key is wrong, revoked, or lacks permission`,
      );
      result = { ok: false, reason: "unauthorized" };
    } else if (!response.ok) {
      log.warn(`${provider} model list failed: ${response.status} ${response.statusText}`);
      result = { ok: false, reason: "unreachable" };
    } else {
      const models = parseModels(route.dialect, await response.json()).sort();
      result = { ok: true, models };
    }
  } catch (error) {
    log.warn(
      `${provider} model list errored: ${error instanceof Error ? error.message : String(error)}`,
    );
    result = { ok: false, reason: "unreachable" };
  }

  // Failures are cached too, briefly. Without that, repeating the command against a provider with
  // a bad key re-requests on every render and earns a rate limit on top of the 401.
  cache.set(provider, { at: Date.now(), value: result });
  return result;
}
