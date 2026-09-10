/**
 * Logicc model discovery with administrator allowlist intersection.
 *
 * Fetches GET https://api.logicc.cloud/v1/models with the server credential,
 * caches only sanitized metadata for a bounded TTL, and never retains raw
 * upstream responses or secrets.
 */

import {
  LOGICC_MODELS_URL,
  getLogiccAllowedModels,
  getLogiccDefaultModel,
  isLogiccCredentialConfigured,
  type EnvBag,
} from "./agent-provider-config";
import { SERVER_RESOURCE_LIMITS } from "./agent-shared-limits";
import type { SanitizedProviderModel } from "./agent-provider-types";

export type LogiccModelDiscoveryResult =
  | {
      ok: true;
      models: SanitizedProviderModel[];
      defaultModelId: string | null;
      fromCache: boolean;
    }
  | {
      ok: false;
      errorCode: string;
      message: string;
      status: number;
    };

type CacheEntry = {
  expiresAt: number;
  models: SanitizedProviderModel[];
  defaultModelId: string | null;
};

let cache: CacheEntry | null = null;

/** Test/harness seam: clear bounded cache. */
export function clearLogiccModelCache(): void {
  cache = null;
}

function displayNameFor(id: string): string {
  // Keep display names separate from IDs; no upstream branding/pricing metadata.
  return id;
}

function sanitizeUpstreamModels(raw: unknown): SanitizedProviderModel[] {
  if (!raw || typeof raw !== "object") return [];
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const out: SanitizedProviderModel[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || id.trim().length === 0) continue;
    const trimmed = id.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push({ id: trimmed, displayName: displayNameFor(trimmed) });
  }
  return out;
}

function intersectAllowlist(
  discovered: SanitizedProviderModel[],
  allowlist: readonly string[],
): SanitizedProviderModel[] {
  if (allowlist.length === 0) return [];
  const allowed = new Set(allowlist);
  return discovered.filter((m) => allowed.has(m.id));
}

function resolveDefaultModelId(
  approved: SanitizedProviderModel[],
  configuredDefault: string | null,
): string | null {
  if (approved.length === 0) return null;
  if (configuredDefault && approved.some((m) => m.id === configuredDefault)) {
    return configuredDefault;
  }
  // Do not silently pick an arbitrary replacement when the configured default
  // is missing from the allowlist intersection — report null.
  if (configuredDefault) return null;
  return null;
}

export type LogiccModelDiscoveryDeps = {
  fetchFn?: typeof fetch;
  env?: EnvBag;
  clock?: () => number;
  /** Injected credential reader — returns key or null; caller must release. */
  readCredential?: () => string | null;
};

/**
 * Discover models enabled for the Logicc key, intersect with admin allowlist,
 * and cache sanitized results. On failure, clears unsafe state and returns a
 * safe unavailable error.
 */
export async function discoverLogiccModels(
  deps: LogiccModelDiscoveryDeps = {},
): Promise<LogiccModelDiscoveryResult> {
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? Date.now;
  const fetchFn = deps.fetchFn ?? fetch;
  const now = clock();

  if (!isLogiccCredentialConfigured(env) && !deps.readCredential) {
    return {
      ok: false,
      errorCode: "PROVIDER_NOT_CONFIGURED",
      message: "Logicc provider is not configured.",
      status: 503,
    };
  }

  const allowlist = getLogiccAllowedModels(env);
  const configuredDefault = getLogiccDefaultModel(env);

  if (allowlist.length === 0) {
    cache = null;
    return {
      ok: false,
      errorCode: "MODEL_NOT_ALLOWED",
      message: "No administrator-approved Logicc models are configured.",
      status: 503,
    };
  }

  if (cache && cache.expiresAt > now) {
    return {
      ok: true,
      models: cache.models.map((m) => ({ ...m })),
      defaultModelId: cache.defaultModelId,
      fromCache: true,
    };
  }

  let key: string | null = null;
  try {
    if (deps.readCredential) {
      key = deps.readCredential();
    } else {
      key = (env.LOGICC_API_KEY ?? "").trim() || null;
    }

    if (!key) {
      cache = null;
      return {
        ok: false,
        errorCode: "PROVIDER_NOT_CONFIGURED",
        message: "Logicc provider is not configured.",
        status: 503,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      SERVER_RESOURCE_LIMITS.modelDiscoveryTimeoutMs,
    );

    let response: Response;
    try {
      response = await fetchFn(LOGICC_MODELS_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Drop credential reference as soon as the request is dispatched/finished.
    key = null;

    if (!response.ok) {
      cache = null;
      // Discard body; do not retain raw upstream error payloads.
      try {
        await response.arrayBuffer();
      } catch {
        // ignore
      }
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          errorCode: "INVALID_CREDENTIALS",
          message: "Logicc provider is unavailable.",
          status: 503,
        };
      }
      return {
        ok: false,
        errorCode: "PROVIDER_UNAVAILABLE",
        message: "Logicc model discovery is temporarily unavailable.",
        status: 503,
      };
    }

    let rawJson: unknown;
    try {
      rawJson = await response.json();
    } catch {
      cache = null;
      return {
        ok: false,
        errorCode: "PROVIDER_UNAVAILABLE",
        message: "Logicc model discovery is temporarily unavailable.",
        status: 503,
      };
    }

    const discovered = sanitizeUpstreamModels(rawJson);
    // Release raw response reference.
    rawJson = null;

    const approved = intersectAllowlist(discovered, allowlist);
    const defaultModelId = resolveDefaultModelId(approved, configuredDefault);

    if (approved.length === 0 || !defaultModelId) {
      cache = null;
      return {
        ok: false,
        errorCode: defaultModelId === null && approved.length > 0
          ? "MODEL_NOT_ALLOWED"
          : "MODEL_UNAVAILABLE",
        message:
          approved.length === 0
            ? "No Logicc models are both enabled and administrator-approved."
            : "Logicc default model is not enabled and allowlisted.",
        status: 503,
      };
    }

    cache = {
      expiresAt: now + SERVER_RESOURCE_LIMITS.modelCacheTtlMs,
      models: approved,
      defaultModelId,
    };

    return {
      ok: true,
      models: approved.map((m) => ({ ...m })),
      defaultModelId,
      fromCache: false,
    };
  } catch {
    cache = null;
    key = null;
    return {
      ok: false,
      errorCode: "PROVIDER_UNAVAILABLE",
      message: "Logicc model discovery is temporarily unavailable.",
      status: 503,
    };
  } finally {
    key = null;
  }
}

/**
 * Validate a requested model against the current approved set.
 * Rejects stale/unavailable selections without silent replacement.
 */
export async function assertLogiccModelAllowed(
  modelId: string,
  deps: LogiccModelDiscoveryDeps = {},
): Promise<
  | { ok: true; model: SanitizedProviderModel }
  | { ok: false; errorCode: string; message: string; status: number }
> {
  const discovery = await discoverLogiccModels(deps);
  if (!discovery.ok) {
    return {
      ok: false,
      errorCode: discovery.errorCode,
      message: discovery.message,
      status: discovery.status,
    };
  }

  const match = discovery.models.find((m) => m.id === modelId);
  if (!match) {
    return {
      ok: false,
      errorCode: "MODEL_NOT_ALLOWED",
      message: `Model '${modelId}' is not permitted.`,
      status: 400,
    };
  }

  return { ok: true, model: match };
}

/** Synchronous allowlist check used when discovery results are already known. */
export function isModelInAllowlist(
  modelId: string,
  allowlist: readonly string[],
): boolean {
  return allowlist.includes(modelId);
}
