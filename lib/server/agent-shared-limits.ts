/**
 * Shared server resource limits for agent providers.
 * Kept independent of any single vendor adapter.
 */

export const SERVER_RESOURCE_LIMITS = {
  maxRequestBodyBytes: 1024 * 1024, // 1 MB
  maxMessages: 100,
  maxTools: 20,
  maxTokensLimit: 8192,
  minTokensLimit: 1,
  defaultMaxTokens: 4096,
  minTemperature: 0.0,
  maxTemperature: 1.0,
  defaultTemperature: 0.0,
  streamTimeoutMs: 180_000, // 3 minutes
  connectTimeoutMs: 15_000,
  /** Bounded model-discovery cache TTL. */
  modelCacheTtlMs: 60_000,
  modelDiscoveryTimeoutMs: 10_000,
} as const;
