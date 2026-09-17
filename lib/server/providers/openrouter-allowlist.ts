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
  version: "2026-09-17",
  reviewedBy: "Coderxp Review",
  lastVerified: "2026-09-17T00:00:00Z",
} as const;

export const OPENROUTER_REVIEWED_MODELS: readonly AllowlistEntry[] = [
  {
    id: "meta-llama/llama-3.3-70b-instruct:free",
    name: "Llama 3.3 70B Instruct (Free)",
    contextTokens: 131072,
    pricingSnapshot: { prompt: 0, completion: 0 },
    verifiedAt: "2026-09-17T00:00:00Z",
  },
  {
    id: "qwen/qwen-2.5-coder-32b-instruct:free",
    name: "Qwen 2.5 Coder 32B Instruct (Free)",
    contextTokens: 32768,
    pricingSnapshot: { prompt: 0, completion: 0 },
    verifiedAt: "2026-09-17T00:00:00Z",
  },
  {
    id: "google/gemini-2.0-flash-exp:free",
    name: "Gemini 2.0 Flash Experimental (Free)",
    contextTokens: 1048576,
    pricingSnapshot: { prompt: 0, completion: 0 },
    verifiedAt: "2026-09-17T00:00:00Z",
  },
  {
    id: "deepseek/deepseek-r1:free",
    name: "DeepSeek R1 (Free)",
    contextTokens: 65536,
    pricingSnapshot: { prompt: 0, completion: 0 },
    verifiedAt: "2026-09-17T00:00:00Z",
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
