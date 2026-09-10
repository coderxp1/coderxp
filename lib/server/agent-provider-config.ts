/**
 * Server-only agent provider configuration.
 *
 * Reads process.env in a fail-closed manner. Never returns secret values.
 * Suggested non-secret names (documented): AGENT_PROVIDER, LOGICC_ALLOWED_MODELS,
 * LOGICC_DEFAULT_MODEL, LOGICC_INTERNAL_MODE. LOGICC_API_KEY is server-only.
 */

import type { AgentProviderId } from "./agent-provider-types";

export const LOGICC_CHAT_COMPLETIONS_URL = "https://api.logicc.cloud/v1/chat/completions";
export const LOGICC_MODELS_URL = "https://api.logicc.cloud/v1/models";
export const LOGICC_ORIGIN = "https://api.logicc.cloud";

/** Loose env bag for tests and production process.env. */
export type EnvBag = Record<string, string | undefined>;

const PROVIDER_IDS = new Set<AgentProviderId>(["logicc", "anthropic-byok"]);

export type ProviderConfigSnapshot = {
  providerId: AgentProviderId;
  /** True when AGENT_PROVIDER=logicc was selected. */
  logiccSelected: boolean;
  /** True when LOGICC_INTERNAL_MODE=true. */
  logiccInternalMode: boolean;
  /** Boolean-only: key present and non-empty. Never the value. */
  logiccCredentialConfigured: boolean;
  logiccAllowedModels: readonly string[];
  logiccDefaultModel: string | null;
};

function parseCsvList(raw: string | undefined): string[] {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve active provider id. Logicc is disabled unless explicitly selected.
 * Default remains anthropic-byok so existing BYOK deployments keep working.
 */
export function resolveProviderId(env: EnvBag = process.env): AgentProviderId {
  const raw = (env.AGENT_PROVIDER ?? "anthropic-byok").trim().toLowerCase();
  if (raw === "logicc") return "logicc";
  if (raw === "anthropic-byok" || raw === "anthropic") return "anthropic-byok";
  if (PROVIDER_IDS.has(raw as AgentProviderId)) return raw as AgentProviderId;
  return "anthropic-byok";
}

/** Boolean-only credential presence check. Never returns the key or its length. */
export function isLogiccCredentialConfigured(env: EnvBag = process.env): boolean {
  const value = env.LOGICC_API_KEY;
  return typeof value === "string" && value.trim().length > 0;
}

export function isLogiccInternalModeEnabled(env: EnvBag = process.env): boolean {
  return (env.LOGICC_INTERNAL_MODE ?? "").trim().toLowerCase() === "true";
}

export function getLogiccAllowedModels(env: EnvBag = process.env): readonly string[] {
  return parseCsvList(env.LOGICC_ALLOWED_MODELS);
}

export function getLogiccDefaultModel(env: EnvBag = process.env): string | null {
  const raw = (env.LOGICC_DEFAULT_MODEL ?? "").trim();
  if (raw.length > 0) return raw;
  const allowed = getLogiccAllowedModels(env);
  if (allowed.length > 0) return allowed[0];
  return "azure/gpt-4o-mini";
}

/**
 * Snapshot of non-secret configuration for health, UI, and tests.
 * Does not include LOGICC_API_KEY or any secret material.
 */
export function getProviderConfigSnapshot(env: EnvBag = process.env): ProviderConfigSnapshot {
  const providerId = resolveProviderId(env);
  return {
    providerId,
    logiccSelected: providerId === "logicc",
    logiccInternalMode: isLogiccInternalModeEnabled(env),
    logiccCredentialConfigured: isLogiccCredentialConfigured(env),
    logiccAllowedModels: getLogiccAllowedModels(env),
    logiccDefaultModel: getLogiccDefaultModel(env),
  };
}
