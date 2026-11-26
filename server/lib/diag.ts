/**
 * The console commands that replace an admin panel.
 *
 *   tradioai_status   what tRadio offers, what the dispatcher is doing, which engine
 *                     serves each capability and whether its key is set
 *   tradioai_models   the model ids a hosted provider will accept
 *   tradioai_download fetch the local engine's weights (registered in weights.ts)
 *
 * All `restricted`: server console only. A player typing in chat must not be able to
 * read configuration or spend the host's bandwidth.
 *
 * Keys are reported as present or absent and never as a value or a fragment of one: a
 * pasted status block is how a key would otherwise reach a support thread.
 */

import { budgetState } from "./budget";
import { aiConfig, providerPlan } from "./config";
import { activeCad } from "./cad";
import { aiLog } from "./logger";
import { listModels } from "./model-directory";
import { CAPABILITIES, describePlan, isProviderId, keyConvar, type ProviderId } from "./providers";
import { stationId } from "./station";
import * as tradio from "./tradio-hooks";
import { weightsStatus } from "./weights";

const HOSTED: readonly ProviderId[] = ["openai", "openrouter", "groq", "vercel", "elevenlabs"];

export function statusLines(): string[] {
  const config = aiConfig();
  const known = tradio.capabilities();
  const lines: string[] = [];

  lines.push(`tRadio: ${known.state}`);
  const idle = tradio.idleReason(known);
  lines.push(idle ? `  idle — ${idle}` : "  integration hooks found");
  if (known.state === "started") {
    const yes = (flag: boolean) => (flag ? "yes" : "no");
    lines.push(
      `  hear ${yes(known.tap)}, speak ${yes(known.station)}, 911 ${yes(known.calls911)}, ` +
        `alerts ${yes(known.alerts)}, patches ${yes(known.patches)}, CAD ${yes(known.cad)}`,
    );
  }

  lines.push(
    `dispatcher: ${config.enabled ? "enabled" : "disabled"}, ` +
      `${config.channels.length} channel(s), station ${stationId() ? "open" : "closed"}`,
  );
  lines.push(
    `911: auto ${config.auto911 ? "on" : "off"}, answering ${config.answer911 ? "on" : "off"}`,
  );
  lines.push(`cad: ${activeCad()?.id ?? "none"}`);

  // The two spend controls, which `budget.ts` has always described as reported here and
  // which were not: an operator who set a ceiling had no way to see whether it was the
  // reason turns were being served locally.
  const budget = budgetState(config.hostedCallsPerMinute, config.turnCooldownMs);
  lines.push(
    `hosted calls: ${budget.hostedPerMinute} in the last minute, ` +
      (budget.ceiling > 0
        ? `ceiling ${budget.ceiling}, ${budget.shed} sent to the local engine instead`
        : "no ceiling") +
      `; ${budget.cooling} unit(s) inside the turn cooldown`,
  );

  for (const line of describePlan(providerPlan())) lines.push(`  ${line}`);
  for (const provider of HOSTED) {
    const used = CAPABILITIES.some(
      (capability) => providerPlan()[capability].provider === provider,
    );
    lines.push(
      `  ${keyConvar(provider)}: ${GetConvar(keyConvar(provider), "") ? "set" : "not set"}` +
        `${used ? "" : " (not used)"}`,
    );
  }

  const weights = weightsStatus();
  lines.push(`local engine: ${weights.state}`);
  return lines;
}

export function registerDiagCommands(): void {
  RegisterCommand(
    "tradioai_status",
    () => {
      for (const line of statusLines()) aiLog.info(line);
    },
    true,
  );

  RegisterCommand(
    "tradioai_models",
    (_source, args) => {
      const provider = (args[0] ?? "").toLowerCase();
      if (!isProviderId(provider) || provider === "local") {
        aiLog.info(`tradioai_models <provider> — one of: ${HOSTED.join(", ")}`);
        return;
      }
      void listModels(provider).then((result) => {
        if (result.ok) {
          aiLog.info(`${provider} offers ${result.models.length} model(s):`);
          for (const model of result.models) aiLog.info(`  ${model}`);
          return;
        }
        const why = {
          no_key: `set ${keyConvar(provider)} in server.cfg first`,
          unauthorized: "the key was refused — it is wrong, revoked or lacks permission",
          unsupported: "this provider has no model list to ask for",
          unreachable: "the provider could not be reached",
        }[result.reason];
        aiLog.warn(`${provider}: ${why}`);
      });
    },
    true,
  );
}

/** The two rows of tLib's startup box this resource fills. */
export function emitBannerRows(): void {
  const known = tradio.capabilities();
  const idle = tradio.idleReason(known);
  emit("tradioai:vcInfo:tradio", { value: idle ? `idle — ${idle}` : "hooks found" });
  const lines = describePlan(providerPlan());
  emit("tradioai:vcInfo:engines", { value: lines.join("; ") });
}
