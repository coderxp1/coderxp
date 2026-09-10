/**
 * Server-only provider registry.
 *
 * Provider selection is controlled exclusively by server configuration
 * (AGENT_PROVIDER). The browser cannot select an upstream URL or provider.
 */

import { createAnthropicByokAdapter } from "./agent-anthropic-byok-adapter";
import { createLogiccAdapter, type LogiccAdapterOptions } from "./agent-logicc-adapter";
import { resolveProviderId, type EnvBag } from "./agent-provider-config";
import type { AgentProviderAdapter, AgentProviderId } from "./agent-provider-types";

export type ProviderRegistryOptions = {
  env?: EnvBag;
  logicc?: LogiccAdapterOptions;
};

export function createProviderAdapter(
  id: AgentProviderId,
  options: ProviderRegistryOptions = {},
): AgentProviderAdapter {
  if (id === "logicc") {
    return createLogiccAdapter({
      env: options.env,
      ...options.logicc,
    });
  }
  return createAnthropicByokAdapter();
}

/** Resolve the active provider from server env. Logicc is off unless selected. */
export function getActiveProvider(
  options: ProviderRegistryOptions = {},
): AgentProviderAdapter {
  const env = options.env ?? process.env;
  const id = resolveProviderId(env);
  return createProviderAdapter(id, options);
}
