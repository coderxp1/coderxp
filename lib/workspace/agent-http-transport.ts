/**
 * HTTP SSE streaming transport implementation for CoderXP M3.8.
 *
 * Connects the provider-independent agent orchestration layer to the
 * `/api/agent/stream` server endpoint via Server-Sent Events (SSE).
 *
 * Invariants:
 * - Emits canonical AgentTransportEvent objects only.
 * - Enforces monotonic event sequencing (sequence 0, 1, 2...).
 * - Yields exactly one terminal event on all termination paths.
 * - Binds to Request lifecycle and cancels upstream when aborted.
 * - Normalizes HTTP errors, network aborts, and upstream error payloads.
 * - Never logs or exposes raw BYOK keys in event payloads.
 * - Supports server-managed credentials (byokRequired: false) and client BYOK.
 */

import type {
  AgentTransport,
  AgentTransportRequest,
  AgentTransportEvent,
} from "./agent-transport-types";

export type HttpCredentialMode = "browser-byok" | "server-owned" | "auto";

export interface HttpAgentTransportOptions {
  endpoint?: string;
  /** Optional BYOK key getter. */
  getApiKey?: () => string | null;
  /** Optional model id appended to the JSON body (server validates allowlist). */
  getModel?: () => string | null;
  /** Whether client BYOK key is mandatory. Defaults to false (server manages Logicc credentials). */
  byokRequired?: boolean;
  /**
   * browser-byok: send x-coderxp-byok-key when available.
   * server-owned: never send BYOK header (Logicc mode).
   * auto: sends key if present, allows server credentials if null.
   */
  credentialMode?: HttpCredentialMode;
}

export class HttpAgentTransport implements AgentTransport {
  private readonly endpoint: string;
  private readonly getApiKey: (() => string | null) | undefined;
  private readonly getModel: (() => string | null) | undefined;
  private readonly byokRequired: boolean;
  private readonly credentialMode: HttpCredentialMode;

  constructor(options: HttpAgentTransportOptions = {}) {
    this.endpoint = options.endpoint ?? "/api/agent/stream";
    this.getApiKey = options.getApiKey;
    this.getModel = options.getModel;
    this.byokRequired = options.byokRequired ?? false;
    this.credentialMode = options.credentialMode ?? (this.byokRequired ? "browser-byok" : "auto");
  }

  async *send(
    request: AgentTransportRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentTransportEvent> {
    const turnId = request.turnId;
    const requestId = request.requestId;

    let key: string | null = null;
    if (this.credentialMode === "browser-byok" && this.byokRequired) {
      key = this.getApiKey?.() ?? null;
      if (!key || typeof key !== "string" || key.trim().length === 0) {
        yield {
          type: "turn-started",
          eventId: `evt-${turnId}-0`,
          sequence: 0,
          requestId,
          turnId,
          timestamp: Date.now(),
        };
        yield {
          type: "transport-error",
          eventId: `evt-${turnId}-1`,
          sequence: 1,
          requestId,
          turnId,
          code: "INVALID_CREDENTIALS",
          message: "An API key is required. Please set your BYOK credential.",
        };
        return;
      }
    } else if (this.credentialMode !== "server-owned") {
      key = this.getApiKey?.() ?? null;
    }

    if (signal.aborted) {
      yield {
        type: "turn-started",
        eventId: `evt-${turnId}-0`,
        sequence: 0,
        requestId,
        turnId,
        timestamp: Date.now(),
      };
      yield {
        type: "transport-cancelled",
        eventId: `evt-${turnId}-1`,
        sequence: 1,
        requestId,
        turnId,
        reason: "Request cancelled before execution.",
      };
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };

    if (this.credentialMode !== "server-owned" && key && key.trim().length > 0) {
      headers["x-coderxp-byok-key"] = key.trim();
    }

    const modelOverride = this.getModel?.();
    const payload = {
      ...request,
      ...(modelOverride && modelOverride.trim().length > 0
        ? { model: modelOverride.trim() }
        : {}),
    };

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err: unknown) {
      if (signal.aborted) {
        yield {
          type: "turn-started",
          eventId: `evt-${turnId}-0`,
          sequence: 0,
          requestId,
          turnId,
          timestamp: Date.now(),
        };
        yield {
          type: "transport-cancelled",
          eventId: `evt-${turnId}-1`,
          sequence: 1,
          requestId,
          turnId,
          reason: "Request cancelled by user.",
        };
        return;
      }

      yield {
        type: "turn-started",
        eventId: `evt-${turnId}-0`,
        sequence: 0,
        requestId,
        turnId,
        timestamp: Date.now(),
      };
      yield {
        type: "transport-error",
        eventId: `evt-${turnId}-1`,
        sequence: 1,
        requestId,
        turnId,
        code: "NETWORK_ERROR",
        message: "Failed to connect to agent streaming endpoint.",
      };
      return;
    }

    if (!response.ok) {
      let errorCode = "HTTP_ERROR";
      let errorMsg = `Server returned HTTP ${response.status}.`;
      try {
        const errJson = (await response.json()) as { errorCode?: string; message?: string };
        if (errJson.errorCode) errorCode = errJson.errorCode;
        if (errJson.message) errorMsg = errJson.message;
      } catch {
        // Fallback to generic status text
      }

      yield {
        type: "turn-started",
        eventId: `evt-${turnId}-0`,
        sequence: 0,
        requestId,
        turnId,
        timestamp: Date.now(),
      };
      yield {
        type: "transport-error",
        eventId: `evt-${turnId}-1`,
        sequence: 1,
        requestId,
        turnId,
        code: errorCode,
        message: errorMsg,
      };
      return;
    }

    if (!response.body) {
      yield {
        type: "turn-started",
        eventId: `evt-${turnId}-0`,
        sequence: 0,
        requestId,
        turnId,
        timestamp: Date.now(),
      };
      yield {
        type: "transport-error",
        eventId: `evt-${turnId}-1`,
        sequence: 1,
        requestId,
        turnId,
        code: "PROTOCOL_ERROR",
        message: "Empty response body received from stream.",
      };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminalReceived = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data:")) {
            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr) as AgentTransportEvent;
              if (
                event.type === "turn-completed" ||
                event.type === "transport-error" ||
                event.type === "transport-cancelled"
              ) {
                terminalReceived = true;
              }
              yield event;
              if (terminalReceived) {
                return;
              }
            } catch {
              yield {
                type: "transport-error",
                eventId: `evt-${turnId}-err`,
                sequence: 9999,
                requestId,
                turnId,
                code: "PROTOCOL_ERROR",
                message: "Failed to parse transport event JSON.",
              };
              return;
            }
          }
        }
      }

      if (!terminalReceived) {
        yield {
          type: "transport-error",
          eventId: `evt-${turnId}-premature`,
          sequence: 9999,
          requestId,
          turnId,
          code: "UPSTREAM_PREMATURE_CLOSE",
          message: "Stream finished without a canonical terminal event.",
        };
      }
    } catch (err: unknown) {
      if (signal.aborted) {
        if (!terminalReceived) {
          yield {
            type: "transport-cancelled",
            eventId: `evt-${turnId}-cancelled`,
            sequence: 9999,
            requestId,
            turnId,
            reason: "Stream cancelled by user.",
          };
        }
      } else {
        if (!terminalReceived) {
          yield {
            type: "transport-error",
            eventId: `evt-${turnId}-stream-err`,
            sequence: 9999,
            requestId,
            turnId,
            code: "STREAM_READ_ERROR",
            message: "Error encountered while reading stream.",
          };
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Safe disposal
      }
    }
  }
}
