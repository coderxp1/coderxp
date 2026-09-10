/**
 * Server-only agent stream handler for CoderXP M3.9+.
 *
 * Production binds fetch/clock/timers and the active provider adapter.
 * Tests bind the same handler to a deterministic fake upstream.
 * Upstream origins are fixed inside provider adapters and are never taken
 * from the HTTP request or the browser.
 *
 * Timeout, cancellation, limits, concurrency, and terminal-once behavior
 * remain centralized here.
 */

import { prepareLogiccTranslation } from "./agent-logicc-adapter";
import { createAnthropicByokAdapter } from "./agent-anthropic-byok-adapter";
import { isSameOriginRequest } from "./agent-same-origin";
import { SERVER_RESOURCE_LIMITS } from "./agent-shared-limits";
import type { AgentProviderAdapter } from "./agent-provider-types";
import type { AgentTransportRequest, AgentTransportEvent } from "../workspace/agent-transport-types";

export {
  PRODUCTION_ANTHROPIC_MESSAGES_URL,
  PRODUCTION_ANTHROPIC_VERSION,
} from "./agent-anthropic-byok-adapter";

export const MAX_GLOBAL_CONCURRENT_STREAMS = 50;

export type AgentStreamLimits = {
  maxRequestBodyBytes: number;
  streamTimeoutMs: number;
  connectTimeoutMs: number;
};

export type FetchUpstream = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface ConcurrencyGate {
  tryAcquire(): boolean;
  release(): void;
  active(): number;
}

export function createConcurrencyGate(maxConcurrent: number): ConcurrencyGate {
  let active = 0;
  return {
    tryAcquire(): boolean {
      if (active >= maxConcurrent) return false;
      active += 1;
      return true;
    },
    release(): void {
      active = Math.max(0, active - 1);
    },
    active(): number {
      return active;
    },
  };
}

export interface AgentStreamHandlerDeps {
  fetchUpstream: FetchUpstream;
  clock: () => number;
  scheduleTimeout: (fn: () => void, ms: number) => unknown;
  cancelTimeout: (id: unknown) => void;
  limits: AgentStreamLimits;
  concurrency: ConcurrencyGate;
  /** Active provider adapter. Defaults to Anthropic BYOK for backward-compatible tests. */
  provider?: AgentProviderAdapter;
  /** When true, skip same-origin check (unit tests). Production leaves this false. */
  skipSameOriginCheck?: boolean;
}

type AbortCause = "none" | "client" | "connect-timeout" | "stream-timeout";

function jsonError(errorCode: string, message: string, status: number): Response {
  return Response.json({ errorCode, message }, { status });
}

export function createAgentStreamHandler(
  deps: AgentStreamHandlerDeps,
): (req: Request) => Promise<Response> {
  const provider = deps.provider ?? createAnthropicByokAdapter();

  return async function handleAgentStream(req: Request): Promise<Response> {
    if (!deps.skipSameOriginCheck && !isSameOriginRequest(req)) {
      return jsonError("ACCESS_RESTRICTED", "Cross-origin agent requests are not allowed.", 403);
    }

    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return jsonError("INVALID_REQUEST", "Content-Type must be application/json.", 400);
    }

    const browserByokHeader = req.headers.get("x-coderxp-byok-key");

    // Logicc mode: do not require, read for auth, or preserve BYOK.
    // Anthropic BYOK: credential session validates the header.
    const credentialResult = provider.beginCredentialSession(
      provider.requiresBrowserByok() ? browserByokHeader : null,
    );
    if (!credentialResult.ok) {
      return jsonError(
        credentialResult.errorCode,
        credentialResult.message,
        credentialResult.status,
      );
    }
    const credentialSession = credentialResult.session;

    if (!deps.concurrency.tryAcquire()) {
      credentialSession.release();
      return jsonError("RATE_LIMITED", "Server capacity reached. Please try again shortly.", 429);
    }

    let acquired = true;
    const releaseConcurrency = () => {
      if (acquired) {
        acquired = false;
        deps.concurrency.release();
      }
    };

    let rawBodyText: string;
    try {
      rawBodyText = await req.text();
    } catch {
      releaseConcurrency();
      credentialSession.release();
      return jsonError("INVALID_REQUEST", "Failed to read request body.", 400);
    }

    if (Buffer.byteLength(rawBodyText, "utf8") > deps.limits.maxRequestBodyBytes) {
      releaseConcurrency();
      credentialSession.release();
      return jsonError("REQUEST_TOO_LARGE", "Request body exceeds maximum limit (1 MB).", 413);
    }

    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = JSON.parse(rawBodyText);
    } catch {
      releaseConcurrency();
      credentialSession.release();
      return jsonError("INVALID_REQUEST", "Malformed JSON payload.", 400);
    }

    const transportReq = parsedBody as unknown as AgentTransportRequest;
    const requestOptions = {
      model: typeof parsedBody.model === "string" ? parsedBody.model : undefined,
      temperature:
        typeof parsedBody.temperature === "number" ? parsedBody.temperature : undefined,
      maxTokens: typeof parsedBody.maxTokens === "number" ? parsedBody.maxTokens : undefined,
    };

    const translationResult =
      provider.id === "logicc"
        ? await prepareLogiccTranslation(provider, transportReq, requestOptions)
        : provider.validateAndTranslateRequest(transportReq, requestOptions);

    if (!translationResult.ok) {
      releaseConcurrency();
      credentialSession.release();
      return jsonError(
        translationResult.errorCode,
        translationResult.message,
        translationResult.status,
      );
    }

    const requestId = transportReq.requestId || `req-${deps.clock()}`;
    const turnId = transportReq.turnId || `turn-${deps.clock()}`;
    const abortController = new AbortController();
    let abortCause: AbortCause = "none";

    const markClientAbort = () => {
      if (abortCause === "none") abortCause = "client";
      abortController.abort();
    };

    if (req.signal.aborted) {
      markClientAbort();
    } else {
      req.signal.addEventListener("abort", markClientAbort);
    }

    const encoder = new TextEncoder();
    const upstreamBody = JSON.stringify(translationResult.body);
    const upstreamUrl = provider.getUpstreamUrl();

    const responseStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let isClosed = false;
        let connectInFlight = true;
        let connectTimer: unknown;
        let streamTimer: unknown;

        const clearConnectTimer = () => {
          if (connectTimer !== undefined) {
            deps.cancelTimeout(connectTimer);
            connectTimer = undefined;
          }
        };

        const clearStreamTimer = () => {
          if (streamTimer !== undefined) {
            deps.cancelTimeout(streamTimer);
            streamTimer = undefined;
          }
        };

        const safeEnqueue = (event: AgentTransportEvent) => {
          if (isClosed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            // Client cancelled the readable stream.
          }
        };

        const closeStream = () => {
          if (isClosed) return;
          isClosed = true;
          clearConnectTimer();
          clearStreamTimer();
          credentialSession.release();
          releaseConcurrency();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        };

        let terminalSeen = false;
        const translator = provider.createStreamTranslator(requestId, turnId, (event) => {
          if (terminalSeen) return;
          if (
            event.type === "turn-completed" ||
            event.type === "transport-error" ||
            event.type === "transport-cancelled"
          ) {
            terminalSeen = true;
          }
          safeEnqueue(event);
        });

        const armStreamTimer = () => {
          clearStreamTimer();
          streamTimer = deps.scheduleTimeout(() => {
            if (translator.isTerminalCommitted()) return;
            abortCause = "stream-timeout";
            translator.emitTerminalError("PROVIDER_TIMEOUT", "Streaming request timed out.");
            abortController.abort();
            closeStream();
          }, deps.limits.streamTimeoutMs);
        };

        connectTimer = deps.scheduleTimeout(() => {
          if (!connectInFlight) return;
          if (abortCause !== "none") return;
          if (translator.isTerminalCommitted()) return;
          abortCause = "connect-timeout";
          abortController.abort();
        }, deps.limits.connectTimeoutMs);

        try {
          const headers: Record<string, string> = {
            "content-type": "application/json",
          };
          credentialSession.applyAuth(headers);

          const upstreamResponse = await deps.fetchUpstream(upstreamUrl, {
            method: "POST",
            headers,
            body: upstreamBody,
            signal: abortController.signal,
          });

          connectInFlight = false;
          clearConnectTimer();

          if (abortCause === "connect-timeout") {
            translator.emitTerminalError("PROVIDER_TIMEOUT", "Connection to provider timed out.");
            closeStream();
            return;
          }

          armStreamTimer();

          if (!upstreamResponse.ok) {
            const normalized = provider.normalizeHttpError(upstreamResponse.status);
            translator.emitTerminalError(normalized.errorCode, normalized.message);
            closeStream();
            return;
          }

          if (!upstreamResponse.body) {
            translator.emitTerminalError(
              "UPSTREAM_PROTOCOL_ERROR",
              "Upstream response body was empty.",
            );
            closeStream();
            return;
          }

          const reader = upstreamResponse.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith("data:")) {
                const dataStr = trimmed.slice(5).trim();
                translator.handleDataPayload(dataStr);
              }
            }

            if (translator.isTerminalCommitted()) {
              break;
            }
          }

          if (!translator.isTerminalCommitted()) {
            translator.notifyStreamEnded();
          }
        } catch {
          if (!translator.isTerminalCommitted()) {
            if (abortCause === "connect-timeout") {
              translator.emitTerminalError("PROVIDER_TIMEOUT", "Connection to provider timed out.");
            } else if (abortCause === "stream-timeout") {
              translator.emitTerminalError("PROVIDER_TIMEOUT", "Streaming request timed out.");
            } else if (abortCause === "client" || abortController.signal.aborted) {
              translator.emitTerminalCancelled("Request cancelled by client.");
            } else {
              translator.emitTerminalError(
                "PROVIDER_UNAVAILABLE",
                "Failed to establish connection with upstream provider.",
              );
            }
          }
        } finally {
          connectInFlight = false;
          closeStream();
        }
      },
      cancel() {
        if (abortCause === "none") abortCause = "client";
        abortController.abort();
        credentialSession.release();
        releaseConcurrency();
      },
    });

    return new Response(responseStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  };
}

export const defaultStreamLimits: AgentStreamLimits = {
  maxRequestBodyBytes: SERVER_RESOURCE_LIMITS.maxRequestBodyBytes,
  streamTimeoutMs: SERVER_RESOURCE_LIMITS.streamTimeoutMs,
  connectTimeoutMs: SERVER_RESOURCE_LIMITS.connectTimeoutMs,
};
