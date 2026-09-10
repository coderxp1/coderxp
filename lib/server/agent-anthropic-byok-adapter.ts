/**
 * Anthropic BYOK provider adapter — wraps the existing Anthropic translator
 * behind the neutral AgentProviderAdapter contract.
 *
 * Browser supplies x-coderxp-byok-key; server never stores Anthropic credentials.
 */

import {
  AnthropicStreamTranslator,
  DEFAULT_MODEL,
  MODEL_DISPLAY_NAMES,
  validateAndTranslateRequest,
  type AllowedModelId,
} from "./agent-anthropic-adapter";
import type {
  AgentProviderAdapter,
  ProviderCredentialResult,
  ProviderHttpError,
  ProviderRequestOptions,
  ProviderSafeHealth,
  ProviderStreamTranslator,
  ProviderTranslateResult,
} from "./agent-provider-types";
import type { AgentTransportEvent, AgentTransportRequest } from "../workspace/agent-transport-types";

export const PRODUCTION_ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const PRODUCTION_ANTHROPIC_VERSION = "2023-06-01";

function isHeaderSafeApiKey(key: string): boolean {
  if (typeof key !== "string" || key.trim().length === 0) return false;
  if (key.length > 256) return false;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 33 || code > 126) return false;
  }
  return true;
}

function wrapAnthropicTranslator(
  inner: AnthropicStreamTranslator,
): ProviderStreamTranslator {
  return {
    handleDataPayload(data: string): void {
      if (data === "[DONE]") {
        if (!inner.isTerminalCommitted()) {
          inner.emitTerminalCompleted("stop");
        }
        return;
      }
      try {
        const eventObj = JSON.parse(data) as Record<string, unknown>;
        inner.handleAnthropicEvent(eventObj);
      } catch {
        inner.emitTerminalError(
          "UPSTREAM_PROTOCOL_ERROR",
          "Failed to parse upstream event data.",
        );
      }
    },
    notifyStreamEnded(): void {
      if (!inner.isTerminalCommitted()) {
        inner.emitTerminalError(
          "UPSTREAM_PREMATURE_CLOSE",
          "Upstream stream closed without a terminal completion event.",
        );
      }
    },
    emitTerminalError: (code, message) => inner.emitTerminalError(code, message),
    emitTerminalCancelled: (reason) => inner.emitTerminalCancelled(reason),
    isTerminalCommitted: () => inner.isTerminalCommitted(),
  };
}

export function createAnthropicByokAdapter(): AgentProviderAdapter {
  return {
    id: "anthropic-byok",
    displayName: "Anthropic",

    getUpstreamUrl(): string {
      return PRODUCTION_ANTHROPIC_MESSAGES_URL;
    },

    requiresBrowserByok(): boolean {
      return true;
    },

    getSafeHealth(): ProviderSafeHealth {
      return {
        ok: true,
        provider: "anthropic-byok",
        ready: true,
        access: "byok",
        status: "ready",
        byokRequired: true,
        displayName: "Anthropic",
        defaultModelDisplayName: MODEL_DISPLAY_NAMES[DEFAULT_MODEL],
      };
    },

    beginCredentialSession(browserByokHeader: string | null): ProviderCredentialResult {
      let key = (browserByokHeader ?? "").trim();
      if (!isHeaderSafeApiKey(key)) {
        key = "";
        return {
          ok: false,
          errorCode: "INVALID_CREDENTIALS",
          message:
            "A valid Anthropic API key is required. Please provide your BYOK credential.",
          status: 401,
        };
      }

      return {
        ok: true,
        session: {
          applyAuth(headers: Record<string, string>): void {
            if (key) {
              headers["x-api-key"] = key;
              headers["anthropic-version"] = PRODUCTION_ANTHROPIC_VERSION;
            }
          },
          release(): void {
            key = "";
          },
        },
      };
    },

    validateAndTranslateRequest(
      request: AgentTransportRequest,
      options?: ProviderRequestOptions,
    ): ProviderTranslateResult {
      return validateAndTranslateRequest(request, options);
    },

    createStreamTranslator(
      requestId: string,
      turnId: string,
      emit: (event: AgentTransportEvent) => void,
    ): ProviderStreamTranslator {
      const inner = new AnthropicStreamTranslator(requestId, turnId, emit);
      return wrapAnthropicTranslator(inner);
    },

    normalizeHttpError(status: number): ProviderHttpError {
      if (status === 401 || status === 403) {
        return {
          errorCode: "INVALID_CREDENTIALS",
          message: "Provided Anthropic API key was rejected by the provider.",
        };
      }
      if (status === 429) {
        return {
          errorCode: "RATE_LIMITED",
          message: "Anthropic rate limit exceeded. Please wait before retrying.",
        };
      }
      if (status >= 500) {
        return {
          errorCode: "PROVIDER_UNAVAILABLE",
          message: "Anthropic service is temporarily unavailable.",
        };
      }
      return {
        errorCode: "UPSTREAM_ERROR",
        message: `Upstream provider returned HTTP ${status}.`,
      };
    },

    async listSanitizedModels() {
      const models = (Object.keys(MODEL_DISPLAY_NAMES) as AllowedModelId[]).map((id) => ({
        id,
        displayName: MODEL_DISPLAY_NAMES[id],
      }));
      return {
        ok: true as const,
        models,
        defaultModelId: DEFAULT_MODEL,
      };
    },
  };
}
