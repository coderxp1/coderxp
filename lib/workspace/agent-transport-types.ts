/**
 * Canonical provider-independent agent transport protocol for CoderXP M3.8.
 *
 * Defines the strict boundary between AI model transports and workspace
 * orchestration. Contains declarations only: no provider SDKs, no API keys,
 * no network access, and no UI-coupled blocks.
 */

// ---------------------------------------------------------------------------
// Canonical Conversation Model (Provider-Neutral & UI-Independent)
// ---------------------------------------------------------------------------

export type CanonicalRole = "user" | "assistant" | "system" | "tool";

export type CanonicalMessageStatus =
  | "pending"
  | "streaming"
  | "complete"
  | "error"
  | "cancelled"
  | "interrupted";

export type CanonicalPart =
  | { type: "text"; text: string }
  | {
      type: "tool-request";
      toolCallId: string;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool-result";
      envelope: CanonicalToolResultEnvelope;
    }
  | {
      type: "system-context";
      text: string;
      metadata?: Record<string, unknown>;
    };

export interface CanonicalToolResultEnvelope {
  toolCallId: string;
  toolName: string;
  attemptId: string;
  status: "succeeded" | "failed" | "denied" | "cancelled" | "stale";
  isError: boolean;
  errorCode?: string;
  /** Sanitized model-safe projection (produced by M3.7 projectModelFacingResult). Never raw data. */
  modelSafeResult: unknown;
}

export interface CanonicalAgentMessage {
  id: string;
  role: CanonicalRole;
  parts: CanonicalPart[];
  createdAt: number;
  status: CanonicalMessageStatus;
}

// ---------------------------------------------------------------------------
// Canonical Tool Definition
// ---------------------------------------------------------------------------

export interface CanonicalToolParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface CanonicalToolDefinition {
  name: string;
  category: "filesystem" | "command" | "runtime";
  risk: "read" | "write" | "destructive" | "execute";
  summary: string;
  parameters: readonly CanonicalToolParameter[];
  requiresApproval: boolean;
}

// ---------------------------------------------------------------------------
// Transport Contract
// ---------------------------------------------------------------------------

export interface AgentTransportOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface AgentTransportRequest {
  runId: string;
  turnId: string;
  requestId: string;
  projectId: string;
  generation: number;
  messages: CanonicalAgentMessage[];
  tools: readonly CanonicalToolDefinition[];
  options?: AgentTransportOptions;
}

// ---------------------------------------------------------------------------
// Transport Event Union
// ---------------------------------------------------------------------------

export type AgentTransportEvent =
  | {
      type: "turn-started";
      eventId: string;
      sequence: number;
      requestId: string;
      turnId: string;
      timestamp: number;
    }
  | {
      type: "text-delta";
      eventId: string;
      sequence: number;
      requestId: string;
      turnId: string;
      text: string;
    }
  | {
      type: "tool-call-started";
      eventId: string;
      sequence: number;
      requestId: string;
      turnId: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "tool-call-arguments-delta";
      eventId: string;
      sequence: number;
      requestId: string;
      turnId: string;
      toolCallId: string;
      chunk: string;
    }
  | {
      type: "tool-call-completed";
      eventId: string;
      sequence: number;
      requestId: string;
      turnId: string;
      toolCallId: string;
    }
  | {
      type: "usage";
      eventId: string;
      sequence: number;
      requestId: string;
      turnId: string;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      type: "turn-completed";
      eventId: string;
      sequence: number;
      requestId: string;
      turnId: string;
      stopReason: "stop" | "tool_calls" | "max_tokens";
    }
  | {
      type: "transport-error";
      eventId: string;
      sequence: number;
      requestId: string;
      turnId: string;
      code: string;
      message: string;
    }
  | {
      type: "transport-cancelled";
      eventId: string;
      sequence: number;
      requestId: string;
      turnId: string;
      reason: string;
    };

/**
 * Provider-independent streaming transport interface.
 * Implemented by concrete provider adapters in M3.9.
 */
export interface AgentTransport {
  send(
    request: AgentTransportRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentTransportEvent>;
}
