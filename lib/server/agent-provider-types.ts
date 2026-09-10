/**
 * Server-only provider adapter contract for the M3.8/M3.9 agent stream path.
 *
 * Adapters are never imported by browser bundles. Canonical M3.8 types remain
 * the browser contract. This interface stays small: only what the shared
 * stream handler needs for the Logicc vertical slice.
 */

import type {
  AgentTransportEvent,
  AgentTransportRequest,
} from "../workspace/agent-transport-types";

export type AgentProviderId = "logicc" | "anthropic-byok";

export type ProviderAccessMode = "internal" | "byok" | "restricted";

export type ProviderOperationalStatus = "ready" | "unavailable" | "access_restricted";

/** Safe health payload — never includes secrets, env names, or upstream URLs. */
export interface ProviderSafeHealth {
  ok: true;
  provider: AgentProviderId;
  ready: boolean;
  access: ProviderAccessMode;
  status: ProviderOperationalStatus;
  byokRequired: boolean;
  displayName: string;
  defaultModelDisplayName: string | null;
}

/** Sanitized model entry for /api/agent/models — no pricing or routing metadata. */
export interface SanitizedProviderModel {
  id: string;
  displayName: string;
}

export interface ProviderRequestOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ProviderTranslateSuccess {
  ok: true;
  /** Upstream JSON body object (stringified by the handler). */
  body: unknown;
  model: string;
}

export interface ProviderTranslateError {
  ok: false;
  errorCode: string;
  message: string;
  status: number;
}

export type ProviderTranslateResult = ProviderTranslateSuccess | ProviderTranslateError;

/**
 * Narrow credential session: the secret is never exposed as a readable field.
 * applyAuth mutates headers in place; release() drops the request-scoped reference.
 */
export interface ProviderCredentialSession {
  applyAuth: (headers: Record<string, string>) => void;
  release: () => void;
}

export interface ProviderCredentialOk {
  ok: true;
  session: ProviderCredentialSession;
}

export interface ProviderCredentialErr {
  ok: false;
  errorCode: string;
  message: string;
  status: number;
}

export type ProviderCredentialResult = ProviderCredentialOk | ProviderCredentialErr;

export interface ProviderHttpError {
  errorCode: string;
  message: string;
}

export interface ProviderStreamTranslator {
  /** Handle one SSE `data:` payload (JSON object text or the literal `[DONE]`). */
  handleDataPayload: (data: string) => void;
  /** Called when the upstream readable ends (EOF). */
  notifyStreamEnded: () => void;
  emitTerminalError: (code: string, message: string) => void;
  emitTerminalCancelled: (reason: string) => void;
  isTerminalCommitted: () => boolean;
}

export interface AgentProviderAdapter {
  readonly id: AgentProviderId;
  readonly displayName: string;

  /** Fixed upstream chat-completions / messages URL. Never from the browser. */
  getUpstreamUrl: () => string;

  requiresBrowserByok: () => boolean;

  /** Safe operational readiness — no secrets. */
  getSafeHealth: () => ProviderSafeHealth;

  /**
   * Begin a request-scoped credential session.
   * browserByokHeader is used only by anthropic-byok; Logicc ignores it.
   */
  beginCredentialSession: (browserByokHeader: string | null) => ProviderCredentialResult;

  validateAndTranslateRequest: (
    request: AgentTransportRequest,
    options?: ProviderRequestOptions,
  ) => ProviderTranslateResult;

  createStreamTranslator: (
    requestId: string,
    turnId: string,
    emit: (event: AgentTransportEvent) => void,
  ) => ProviderStreamTranslator;

  normalizeHttpError: (status: number) => ProviderHttpError;

  /** Optional model listing for providers that support discovery + allowlist. */
  listSanitizedModels?: () => Promise<{
    ok: true;
    models: SanitizedProviderModel[];
    defaultModelId: string | null;
  } | {
    ok: false;
    errorCode: string;
    message: string;
    status: number;
  }>;
}
