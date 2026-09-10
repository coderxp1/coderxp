/**
 * BYOK Provider Registry and Model Definitions for CoderXP Revision 2.3.
 *
 * Implements Directive §10.2, §10.3 & Review Note Updates:
 * - Multi-provider configuration for Anthropic, OpenAI, Gemini, Mistral,
 *   OpenRouter, Ollama (local + cloud), Grok (xAI), Hugging Face, and Custom.
 * - Server-side key storage and proxying (full key never kept on client).
 * - Live dynamic models discovery (static models used solely as marked offline fallbacks).
 * - Client-only execution for Ollama Local (localhost:11434).
 */

import { validateUrlForFetch } from "./ssrf-guard";

export type ByokProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "mistral"
  | "openrouter"
  | "ollama"
  | "xai"
  | "huggingface"
  | "custom";

export interface ByokModelDescriptor {
  id: string;
  name: string;
  contextWindow?: string;
  description?: string;
  isOfflineFallback?: boolean;
}

export interface ByokProviderDefinition {
  id: ByokProviderId;
  name: string;
  defaultBaseUrl: string;
  keyPlaceholder: string;
  keyPrefix?: string;
  helpUrl?: string;
  defaultModels: ByokModelDescriptor[];
  supportsCustomEndpoint?: boolean;
}

export const BYOK_PROVIDER_DEFS: Record<ByokProviderId, ByokProviderDefinition> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    keyPlaceholder: "sk-ant-...",
    keyPrefix: "sk-ant-",
    helpUrl: "https://console.anthropic.com/settings/keys",
    defaultModels: [
      { id: "claude-3-5-sonnet-latest", name: "Claude 3.5 Sonnet (fallback)", isOfflineFallback: true },
      { id: "claude-3-5-haiku-latest", name: "Claude 3.5 Haiku (fallback)", isOfflineFallback: true },
    ],
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyPlaceholder: "sk-proj-... / sk-...",
    keyPrefix: "sk-",
    helpUrl: "https://platform.openai.com/api-keys",
    defaultModels: [
      { id: "gpt-4o", name: "GPT-4o (fallback)", isOfflineFallback: true },
      { id: "gpt-4o-mini", name: "GPT-4o mini (fallback)", isOfflineFallback: true },
    ],
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyPlaceholder: "AIza...",
    keyPrefix: "AIza",
    helpUrl: "https://aistudio.google.com/app/apikey",
    defaultModels: [
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash (fallback)", isOfflineFallback: true },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro (fallback)", isOfflineFallback: true },
    ],
  },
  mistral: {
    id: "mistral",
    name: "Mistral AI",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    keyPlaceholder: "sk-...",
    helpUrl: "https://console.mistral.ai/api-keys/",
    defaultModels: [
      { id: "mistral-large-latest", name: "Mistral Large (fallback)", isOfflineFallback: true },
      { id: "codestral-latest", name: "Codestral (fallback)", isOfflineFallback: true },
    ],
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    keyPlaceholder: "sk-or-...",
    keyPrefix: "sk-or-",
    helpUrl: "https://openrouter.ai/keys",
    defaultModels: [
      { id: "openrouter/auto", name: "Auto (fallback)", isOfflineFallback: true },
    ],
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    defaultBaseUrl: "http://localhost:11434",
    keyPlaceholder: "Optional (for cloud/remote endpoints)",
    supportsCustomEndpoint: true,
    defaultModels: [
      { id: "llama3.3", name: "Llama 3.3 (fallback)", isOfflineFallback: true },
      { id: "qwen2.5-coder", name: "Qwen 2.5 Coder (fallback)", isOfflineFallback: true },
    ],
  },
  xai: {
    id: "xai",
    name: "Grok (xAI)",
    defaultBaseUrl: "https://api.x.ai/v1",
    keyPlaceholder: "xai-...",
    keyPrefix: "xai-",
    helpUrl: "https://console.x.ai/",
    defaultModels: [
      { id: "grok-2-latest", name: "Grok 2 (fallback)", isOfflineFallback: true },
    ],
  },
  huggingface: {
    id: "huggingface",
    name: "Hugging Face",
    defaultBaseUrl: "https://api-inference.huggingface.co/v1",
    keyPlaceholder: "hf_...",
    keyPrefix: "hf_",
    helpUrl: "https://huggingface.co/settings/tokens",
    defaultModels: [
      { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1 (fallback)", isOfflineFallback: true },
    ],
  },
  custom: {
    id: "custom",
    name: "Custom OpenAI-Compatible",
    defaultBaseUrl: "https://api.custom-ai.com/v1",
    keyPlaceholder: "API key...",
    supportsCustomEndpoint: true,
    defaultModels: [
      { id: "custom-model", name: "Custom Model (fallback)", isOfflineFallback: true },
    ],
  },
};

export interface ClientByokProviderState {
  providerId: ByokProviderId;
  displayName: string;
  maskedKey: string;
  baseUrl?: string;
  mode?: "local" | "cloud";
  models: ByokModelDescriptor[];
  updatedAt: number;
}

// In-memory browser session storage for Ollama-local exception
let sessionOllamaModels: ByokModelDescriptor[] = [];

/**
 * Saves a BYOK provider key to the secure server secrets store.
 */
export async function saveByokKeyToServer(
  providerId: ByokProviderId,
  apiKey: string,
  options: { baseUrl?: string; mode?: "local" | "cloud" } = {},
): Promise<{ ok: boolean; record?: ClientByokProviderState; error?: string }> {
  // Documented Ollama-local exception: Browser-direct probe & memory state
  if (providerId === "ollama" && options.mode !== "cloud") {
    const localUrl = options.baseUrl || "http://localhost:11434";
    try {
      const res = await fetch(`${localUrl}/api/tags`, { method: "GET" });
      if (!res.ok) {
        return {
          ok: false,
          error: `Local Ollama returned HTTP ${res.status}. Ensure Ollama is running with OLLAMA_ORIGINS="*" for CORS.`,
        };
      }
      const data = await res.json();
      const models = Array.isArray(data.models)
        ? data.models.map((m: any) => ({ id: m.name || m.model, name: m.name || m.model }))
        : BYOK_PROVIDER_DEFS.ollama.defaultModels;

      sessionOllamaModels = models;
      return {
        ok: true,
        record: {
          providerId: "ollama",
          displayName: "Ollama (Local)",
          maskedKey: "Local Daemon",
          baseUrl: localUrl,
          mode: "local",
          models,
          updatedAt: Date.now(),
        },
      };
    } catch {
      return {
        ok: false,
        error: "Cannot connect to local Ollama on http://localhost:11434. Set OLLAMA_ORIGINS=\"*\" and start ollama serve.",
      };
    }
  }

  try {
    const res = await fetch("/api/agent/byok", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId,
        apiKey,
        baseUrl: options.baseUrl,
        mode: options.mode,
      }),
    });

    const json = await res.json();
    if (!res.ok || !json.ok) {
      return { ok: false, error: json.error || `HTTP ${res.status}` };
    }

    return { ok: true, record: json.record };
  } catch (err: any) {
    return { ok: false, error: err.message || "Failed to reach BYOK server." };
  }
}

/**
 * Fetches configured BYOK providers from the server.
 */
export async function fetchServerByokRecords(): Promise<ClientByokProviderState[]> {
  const records: ClientByokProviderState[] = [];

  // Include session Ollama if active
  if (sessionOllamaModels.length > 0) {
    records.push({
      providerId: "ollama",
      displayName: "Ollama (Local)",
      maskedKey: "Local Daemon",
      baseUrl: "http://localhost:11434",
      mode: "local",
      models: sessionOllamaModels,
      updatedAt: Date.now(),
    });
  }

  try {
    const res = await fetch("/api/agent/byok");
    if (res.ok) {
      const json = await res.json();
      if (Array.isArray(json.records)) {
        records.push(...json.records);
      }
    }
  } catch {
    // offline
  }

  return records;
}

/**
 * Revokes a BYOK provider key on the server.
 */
export async function revokeByokKeyOnServer(providerId: ByokProviderId): Promise<boolean> {
  if (providerId === "ollama") {
    sessionOllamaModels = [];
    return true;
  }

  try {
    const res = await fetch(`/api/agent/byok?providerId=${encodeURIComponent(providerId)}`, {
      method: "DELETE",
    });
    const json = await res.json();
    return json.ok === true;
  } catch {
    return false;
  }
}
