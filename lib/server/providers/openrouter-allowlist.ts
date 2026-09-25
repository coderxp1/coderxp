/**
 * OpenRouter Reviewed Free-Model Allowlist
 *
 * Strict Policy:
 * - A ':free' ID suffix alone is NOT proof of free pricing.
 * - Every model must have its live /api/v1/models pricing snapshot verified at review time:
 *   prompt === 0 and completion === 0.
 * - Unreviewed or unlisted models fail closed.
 */
import { ModelDescriptor } from "./types";

export interface AllowlistEntry {
  readonly id: string;
  readonly name: string;
  readonly contextTokens: number;
  readonly pricingSnapshot: {
    readonly prompt: number;
    readonly completion: number;
  };
  readonly verifiedAt: string;
}

export const OPENROUTER_ALLOWLIST_METADATA = {
  version: "2026-09-23",
  reviewedBy: "Jan-Paul Hartmann",
  lastVerified: "2026-09-23T03:52:29Z",
} as const;

export const OPENROUTER_REVIEWED_MODELS: readonly AllowlistEntry[] = [
  {
    id: "qwen/qwen3.8-27b:free",
    name: "Qwen: Qwen3.8 27B (free)",
    contextTokens: 262144,
    pricingSnapshot: { prompt: 0, completion: 0 },
    verifiedAt: "2026-09-23T03:52:29Z",
  },
  {
    id: "google/gemma-4-31b-it:free",
    name: "Google: Gemma 4 31B (free)",
    contextTokens: 262144,
    pricingSnapshot: { prompt: 0, completion: 0 },
    verifiedAt: "2026-09-23T03:52:29Z",
  },
  {
    id: "google/gemma-4-26b-a4b-it:free",
    name: "Google: Gemma 4 26B A4B (free)",
    contextTokens: 262144,
    pricingSnapshot: { prompt: 0, completion: 0 },
    verifiedAt: "2026-09-23T03:52:29Z",
  },
  {
    id: "nvidia/nemotron-3.5-lightning:free",
    name: "NVIDIA: Nemotron 3.5 Lightning (free)",
    contextTokens: 1000000,
    pricingSnapshot: { prompt: 0, completion: 0 },
    verifiedAt: "2026-09-23T03:52:29Z",
  },
] as const;

const allowlistMap = new Map<string, AllowlistEntry>(
  OPENROUTER_REVIEWED_MODELS.map((m) => [m.id, m]),
);

export function isModelInAllowlist(modelId: string): boolean {
  return allowlistMap.has(modelId);
}

export function getAllowlistEntry(modelId: string): AllowlistEntry | undefined {
  return allowlistMap.get(modelId);
}

export function getAllowlistDescriptors(): ModelDescriptor[] {
  return OPENROUTER_REVIEWED_MODELS.map((m) => ({
    id: m.id,
    domain: "text",
    name: m.name,
    contextWindowTokens: m.contextTokens,
    isLocal: false,
    isFree: true,
    verifiedAt: m.verifiedAt,
  }));
}
