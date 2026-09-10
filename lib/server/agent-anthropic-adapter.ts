import type {
  AgentTransportRequest,
  AgentTransportEvent,
  CanonicalPart,
} from "../workspace/agent-transport-types";
import { getManifestTool, isValidManifestTool } from "../workspace/agent-tool-manifest";
import { SERVER_RESOURCE_LIMITS as SHARED_LIMITS } from "./agent-shared-limits";

// ---------------------------------------------------------------------------
// Server Model Governance & Resource Limits
// ---------------------------------------------------------------------------

export const ALLOWED_MODELS = [
  "claude-3-5-sonnet-20241022",
  "claude-3-7-sonnet-20250219",
] as const;

export type AllowedModelId = (typeof ALLOWED_MODELS)[number];

export const DEFAULT_MODEL: AllowedModelId = "claude-3-5-sonnet-20241022";

export const MODEL_DISPLAY_NAMES: Record<AllowedModelId, string> = {
  "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
  "claude-3-7-sonnet-20250219": "Claude 3.7 Sonnet",
};

/** Re-export shared limits under the historical Anthropic adapter name. */
export const SERVER_RESOURCE_LIMITS = SHARED_LIMITS;

// ---------------------------------------------------------------------------
// Anthropic Wire Format Types (Server-Only)
// ---------------------------------------------------------------------------

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicToolParam {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  temperature: number;
  system?: string;
  messages: AnthropicMessageParam[];
  tools?: AnthropicToolParam[];
  stream: boolean;
}

function extractMessageParts(msg: any): CanonicalPart[] {
  if (Array.isArray(msg.parts)) {
    return msg.parts;
  }
  if (Array.isArray(msg.content)) {
    return msg.content.map((b: any) => {
      if (!b || typeof b !== "object") {
        return { type: "text" as const, text: String(b || "") };
      }
      if (b.kind === "text" || b.type === "text") {
        return { type: "text" as const, text: String(b.text || "") };
      }
      if (b.kind === "tool-call" || b.type === "tool-request") {
        return {
          type: "tool-request" as const,
          toolCallId: String(b.id || b.toolCallId || ""),
          name: String(b.name || b.toolName || ""),
          args: b.args || b.arguments || {},
        };
      }
      if (b.kind === "tool-result" || b.type === "tool-result") {
        return {
          type: "tool-result" as const,
          envelope: b.envelope || {
            toolCallId: String(b.toolCallId || ""),
            toolName: String(b.toolName || ""),
            attemptId: String(b.attemptId || ""),
            status: b.status || "succeeded",
            isError: Boolean(b.isError),
            modelSafeResult: b.modelSafeResult || b.result || {},
          },
        };
      }
      return { type: "text" as const, text: String(b.text || JSON.stringify(b)) };
    });
  }
  if (typeof msg.content === "string") {
    return [{ type: "text" as const, text: msg.content }];
  }
  if (typeof msg.text === "string") {
    return [{ type: "text" as const, text: msg.text }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Translation & Request Validation
// ---------------------------------------------------------------------------

export interface NormalizedRequestResult {
  ok: true;
  body: AnthropicRequestBody;
  model: AllowedModelId;
}

export interface NormalizedRequestError {
  ok: false;
  errorCode: string;
  message: string;
  status: number;
}

export function validateAndTranslateRequest(
  request: AgentTransportRequest,
  options?: { model?: string; temperature?: number; maxTokens?: number },
): NormalizedRequestResult | NormalizedRequestError {
  // 1. Model Validation
  const requestedModel = options?.model ?? DEFAULT_MODEL;
  if (!ALLOWED_MODELS.includes(requestedModel as AllowedModelId)) {
    return {
      ok: false,
      errorCode: "MODEL_NOT_ALLOWED",
      message: `Model '${requestedModel}' is not permitted.`,
      status: 400,
    };
  }
  const model = requestedModel as AllowedModelId;

  // 2. Options Validation (Reject invalid parameters without silent clamping)
  const temperature = options?.temperature ?? SERVER_RESOURCE_LIMITS.defaultTemperature;
  if (
    typeof temperature !== "number" ||
    Number.isNaN(temperature) ||
    temperature < SERVER_RESOURCE_LIMITS.minTemperature ||
    temperature > SERVER_RESOURCE_LIMITS.maxTemperature
  ) {
    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: `Temperature must be between ${SERVER_RESOURCE_LIMITS.minTemperature} and ${SERVER_RESOURCE_LIMITS.maxTemperature}.`,
      status: 400,
    };
  }

  const maxTokens = options?.maxTokens ?? SERVER_RESOURCE_LIMITS.defaultMaxTokens;
  if (
    typeof maxTokens !== "number" ||
    !Number.isInteger(maxTokens) ||
    maxTokens < SERVER_RESOURCE_LIMITS.minTokensLimit ||
    maxTokens > SERVER_RESOURCE_LIMITS.maxTokensLimit
  ) {
    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: `maxTokens must be an integer between ${SERVER_RESOURCE_LIMITS.minTokensLimit} and ${SERVER_RESOURCE_LIMITS.maxTokensLimit}.`,
      status: 400,
    };
  }

  // 3. Message Sequence & Limit Validation
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: "Messages array must be non-empty.",
      status: 400,
    };
  }

  if (request.messages.length > SERVER_RESOURCE_LIMITS.maxMessages) {
    return {
      ok: false,
      errorCode: "REQUEST_TOO_LARGE",
      message: `Message count (${request.messages.length}) exceeds maximum limit (${SERVER_RESOURCE_LIMITS.maxMessages}).`,
      status: 400,
    };
  }

  let systemPrompt = "";
  const anthropicMessages: AnthropicMessageParam[] = [];
  const knownToolRequests = new Map<string, { name: string; turnIndex: number }>();
  const seenToolResults = new Set<string>();

  for (let i = 0; i < request.messages.length; i++) {
    const msg = request.messages[i];
    if (!msg || typeof msg !== "object") {
      return {
        ok: false,
        errorCode: "INVALID_REQUEST",
        message: `Message at index ${i} is malformed.`,
        status: 400,
      };
    }

    const parts = extractMessageParts(msg);

    if (msg.role === "system") {
      // System message: concatenate into top-level system context
      for (const part of parts) {
        if (part.type === "system-context" || part.type === "text") {
          systemPrompt += (systemPrompt ? "\n\n" : "") + part.text;
        }
      }
      continue;
    }

    if (msg.role === "user") {
      const userBlocks: AnthropicContentBlock[] = [];
      for (const part of parts) {
        if (part.type === "text") {
          userBlocks.push({ type: "text", text: part.text });
        } else if (part.type === "system-context") {
          systemPrompt += (systemPrompt ? "\n\n" : "") + part.text;
        } else {
          return {
            ok: false,
            errorCode: "INVALID_REQUEST",
            message: `User message contains unsupported part type '${part.type}'.`,
            status: 400,
          };
        }
      }

      if (userBlocks.length > 0) {
        anthropicMessages.push({
          role: "user",
          content: userBlocks.length === 1 && userBlocks[0].type === "text" ? userBlocks[0].text : userBlocks,
        });
      }
    } else if (msg.role === "assistant") {
      const assistantBlocks: AnthropicContentBlock[] = [];
      for (const part of msg.parts) {
        if (part.type === "text") {
          assistantBlocks.push({ type: "text", text: part.text });
        } else if (part.type === "tool-request") {
          if (!part.toolCallId || typeof part.toolCallId !== "string") {
            return {
              ok: false,
              errorCode: "INVALID_REQUEST",
              message: "Tool request missing valid toolCallId.",
              status: 400,
            };
          }
          if (knownToolRequests.has(part.toolCallId)) {
            return {
              ok: false,
              errorCode: "INVALID_REQUEST",
              message: `Duplicate tool request ID '${part.toolCallId}'.`,
              status: 400,
            };
          }
          knownToolRequests.set(part.toolCallId, { name: part.name, turnIndex: anthropicMessages.length });
          assistantBlocks.push({
            type: "tool_use",
            id: part.toolCallId,
            name: part.name,
            input: part.args ?? {},
          });
        } else {
          return {
            ok: false,
            errorCode: "INVALID_REQUEST",
            message: `Assistant message contains unsupported part type '${part.type}'.`,
            status: 400,
          };
        }
      }

      if (assistantBlocks.length > 0) {
        anthropicMessages.push({
          role: "assistant",
          content: assistantBlocks,
        });
      }
    } else if (msg.role === "tool") {
      // Tool results are conveyed as user role in Anthropic Messages API
      const toolResultBlocks: AnthropicToolResultBlock[] = [];
      for (const part of msg.parts) {
        if (part.type !== "tool-result") {
          return {
            ok: false,
            errorCode: "INVALID_REQUEST",
            message: `Tool message contains non-tool-result part '${part.type}'.`,
            status: 400,
          };
        }
        const envelope = part.envelope;
        if (!envelope || !envelope.toolCallId) {
          return {
            ok: false,
            errorCode: "INVALID_REQUEST",
            message: "Tool result missing valid envelope or toolCallId.",
            status: 400,
          };
        }

        const req = knownToolRequests.get(envelope.toolCallId);
        if (!req) {
          return {
            ok: false,
            errorCode: "INVALID_REQUEST",
            message: `Orphaned tool result '${envelope.toolCallId}' has no matching tool request.`,
            status: 400,
          };
        }

        if (req.name !== envelope.toolName) {
          return {
            ok: false,
            errorCode: "INVALID_REQUEST",
            message: `Tool name mismatch for '${envelope.toolCallId}': expected '${req.name}', got '${envelope.toolName}'.`,
            status: 400,
          };
        }

        if (seenToolResults.has(envelope.toolCallId)) {
          return {
            ok: false,
            errorCode: "INVALID_REQUEST",
            message: `Duplicate tool result for '${envelope.toolCallId}'.`,
            status: 400,
          };
        }
        seenToolResults.add(envelope.toolCallId);

        // Sanitize to modelSafeResult string JSON
        const safeContent =
          typeof envelope.modelSafeResult === "string"
            ? envelope.modelSafeResult
            : JSON.stringify(envelope.modelSafeResult ?? null);

        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: envelope.toolCallId,
          content: safeContent,
          is_error: envelope.isError,
        });
      }

      if (toolResultBlocks.length > 0) {
        anthropicMessages.push({
          role: "user",
          content: toolResultBlocks,
        });
      }
    }
  }

  // 4. Server-Authoritative Tool Manifest Validation
  const anthropicTools: AnthropicToolParam[] = [];
  if (Array.isArray(request.tools)) {
    if (request.tools.length > SERVER_RESOURCE_LIMITS.maxTools) {
      return {
        ok: false,
        errorCode: "REQUEST_TOO_LARGE",
        message: `Tool count (${request.tools.length}) exceeds maximum limit (${SERVER_RESOURCE_LIMITS.maxTools}).`,
        status: 400,
      };
    }

    for (const clientTool of request.tools) {
      if (!clientTool || !isValidManifestTool(clientTool.name)) {
        return {
          ok: false,
          errorCode: "TOOL_NOT_ALLOWED",
          message: `Tool '${clientTool?.name}' is unknown or not permitted.`,
          status: 400,
        };
      }

      const manifestTool = getManifestTool(clientTool.name)!;
      if (
        clientTool.category !== manifestTool.category ||
        clientTool.risk !== manifestTool.risk ||
        clientTool.requiresApproval !== manifestTool.requiresApproval
      ) {
        return {
          ok: false,
          errorCode: "TOOL_NOT_ALLOWED",
          message: `Tool '${clientTool.name}' definition does not match the server manifest.`,
          status: 400,
        };
      }

      anthropicTools.push({
        name: manifestTool.name,
        description: manifestTool.summary,
        input_schema: manifestTool.jsonSchema as unknown as Record<string, unknown>,
      });
    }
  }

  const body: AnthropicRequestBody = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: anthropicMessages,
    stream: true,
  };

  if (systemPrompt.length > 0) {
    body.system = systemPrompt;
  }

  if (anthropicTools.length > 0) {
    body.tools = anthropicTools;
  }

  return {
    ok: true,
    body,
    model,
  };
}

// ---------------------------------------------------------------------------
// Anthropic SSE Parser & Canonical Event Translator
// ---------------------------------------------------------------------------

export interface ActiveContentBlockState {
  index: number;
  type: "text" | "tool_use";
  toolCallId?: string;
  toolName?: string;
  accumulatedArgs?: string;
  isComplete: boolean;
}

export class AnthropicStreamTranslator {
  private sequence = 1;
  private terminalCommitted = false;
  private readonly activeBlocks = new Map<number, ActiveContentBlockState>();
  private readonly toolUseIds = new Set<string>();
  private turnStartedEmitted = false;

  constructor(
    private readonly requestId: string,
    private readonly turnId: string,
    private readonly emit: (event: AgentTransportEvent) => void,
  ) {}

  private nextEventId(): string {
    return `evt-${this.turnId}-${this.sequence}`;
  }

  /**
   * Translates a raw parsed SSE event object from Anthropic into canonical events.
   */
  handleAnthropicEvent(eventObj: Record<string, unknown>): void {
    if (this.terminalCommitted) return;

    const eventType = eventObj.type as string;

    if (eventType === "message_start") {
      if (!this.turnStartedEmitted) {
        this.turnStartedEmitted = true;
        this.emit({
          type: "turn-started",
          eventId: this.nextEventId(),
          sequence: this.sequence++,
          requestId: this.requestId,
          turnId: this.turnId,
          timestamp: Date.now(),
        });
      }
      return;
    }

    // Ensure turn-started has been emitted before any content delta
    if (!this.turnStartedEmitted) {
      this.turnStartedEmitted = true;
      this.emit({
        type: "turn-started",
        eventId: this.nextEventId(),
        sequence: this.sequence++,
        requestId: this.requestId,
        turnId: this.turnId,
        timestamp: Date.now(),
      });
    }

    if (eventType === "content_block_start") {
      const index = typeof eventObj.index === "number" ? eventObj.index : -1;
      const contentBlock = (eventObj.content_block as Record<string, unknown>) ?? {};
      const blockType = contentBlock.type as string;

      if (index < 0) {
        this.emitTerminalError("UPSTREAM_PROTOCOL_ERROR", "Missing or invalid block index in content_block_start.");
        return;
      }

      if (this.activeBlocks.has(index)) {
        this.emitTerminalError("UPSTREAM_PROTOCOL_ERROR", `Duplicate block start for index ${index}.`);
        return;
      }

      if (blockType === "text") {
        this.activeBlocks.set(index, { index, type: "text", isComplete: false });
        const text = (contentBlock.text as string) ?? "";
        if (text.length > 0) {
          this.emit({
            type: "text-delta",
            eventId: this.nextEventId(),
            sequence: this.sequence++,
            requestId: this.requestId,
            turnId: this.turnId,
            text,
          });
        }
      } else if (blockType === "tool_use") {
        const toolCallId = contentBlock.id as string;
        const toolName = contentBlock.name as string;

        if (!toolCallId || typeof toolCallId !== "string" || !toolName || typeof toolName !== "string") {
          this.emitTerminalError("UPSTREAM_PROTOCOL_ERROR", "Invalid tool_use block start: missing id or name.");
          return;
        }

        if (this.toolUseIds.has(toolCallId)) {
          this.emitTerminalError("UPSTREAM_PROTOCOL_ERROR", `Duplicate tool_use id '${toolCallId}'.`);
          return;
        }
        this.toolUseIds.add(toolCallId);

        this.activeBlocks.set(index, {
          index,
          type: "tool_use",
          toolCallId,
          toolName,
          accumulatedArgs: "",
          isComplete: false,
        });

        this.emit({
          type: "tool-call-started",
          eventId: this.nextEventId(),
          sequence: this.sequence++,
          requestId: this.requestId,
          turnId: this.turnId,
          toolCallId,
          toolName,
        });
      }
      return;
    }

    if (eventType === "content_block_delta") {
      const index = typeof eventObj.index === "number" ? eventObj.index : -1;
      const delta = (eventObj.delta as Record<string, unknown>) ?? {};
      const deltaType = delta.type as string;

      const state = this.activeBlocks.get(index);
      if (!state) {
        this.emitTerminalError("UPSTREAM_PROTOCOL_ERROR", `Delta received for unknown block index ${index}.`);
        return;
      }

      if (deltaType === "text_delta" && state.type === "text") {
        const text = (delta.text as string) ?? "";
        if (text.length > 0) {
          this.emit({
            type: "text-delta",
            eventId: this.nextEventId(),
            sequence: this.sequence++,
            requestId: this.requestId,
            turnId: this.turnId,
            text,
          });
        }
      } else if (deltaType === "input_json_delta" && state.type === "tool_use") {
        const partialJson = (delta.partial_json as string) ?? "";
        if (partialJson.length > 0) {
          state.accumulatedArgs = (state.accumulatedArgs ?? "") + partialJson;
          this.emit({
            type: "tool-call-arguments-delta",
            eventId: this.nextEventId(),
            sequence: this.sequence++,
            requestId: this.requestId,
            turnId: this.turnId,
            toolCallId: state.toolCallId!,
            chunk: partialJson,
          });
        }
      }
      return;
    }

    if (eventType === "content_block_stop") {
      const index = typeof eventObj.index === "number" ? eventObj.index : -1;
      const state = this.activeBlocks.get(index);
      if (!state) {
        this.emitTerminalError("UPSTREAM_PROTOCOL_ERROR", `Block stop for unknown block index ${index}.`);
        return;
      }

      state.isComplete = true;

      if (state.type === "tool_use") {
        this.emit({
          type: "tool-call-completed",
          eventId: this.nextEventId(),
          sequence: this.sequence++,
          requestId: this.requestId,
          turnId: this.turnId,
          toolCallId: state.toolCallId!,
        });
      }
      return;
    }

    if (eventType === "message_delta") {
      const delta = (eventObj.delta as Record<string, unknown>) ?? {};
      const stopReason = delta.stop_reason as string | null;
      const usage = (eventObj.usage as Record<string, unknown>) ?? {};

      if (typeof usage.output_tokens === "number") {
        this.emit({
          type: "usage",
          eventId: this.nextEventId(),
          sequence: this.sequence++,
          requestId: this.requestId,
          turnId: this.turnId,
          inputTokens: (usage.input_tokens as number) ?? 0,
          outputTokens: usage.output_tokens,
        });
      }

      if (stopReason) {
        let canonicalStopReason: "stop" | "tool_calls" | "max_tokens" = "stop";
        if (stopReason === "tool_use") {
          canonicalStopReason = "tool_calls";
        } else if (stopReason === "max_tokens") {
          canonicalStopReason = "max_tokens";
        }

        this.emitTerminalCompleted(canonicalStopReason);
      }
      return;
    }

    if (eventType === "message_stop") {
      // If stop reason was not explicitly received, commit stop
      if (!this.terminalCommitted) {
        this.emitTerminalCompleted("stop");
      }
      return;
    }

    if (eventType === "error") {
      const err = (eventObj.error as Record<string, unknown>) ?? {};
      const errMsg = (err.message as string) || "Upstream provider error.";
      const errType = (err.type as string) || "UPSTREAM_ERROR";
      this.emitTerminalError(errType, errMsg);
    }
  }

  emitTerminalCompleted(stopReason: "stop" | "tool_calls" | "max_tokens"): void {
    if (this.terminalCommitted) return;
    this.terminalCommitted = true;

    this.emit({
      type: "turn-completed",
      eventId: this.nextEventId(),
      sequence: this.sequence++,
      requestId: this.requestId,
      turnId: this.turnId,
      stopReason,
    });
  }

  emitTerminalError(code: string, message: string): void {
    if (this.terminalCommitted) return;
    this.terminalCommitted = true;

    // Ensure turn-started emitted if error happens immediately
    if (!this.turnStartedEmitted) {
      this.turnStartedEmitted = true;
      this.emit({
        type: "turn-started",
        eventId: `evt-${this.turnId}-0`,
        sequence: this.sequence++,
        requestId: this.requestId,
        turnId: this.turnId,
        timestamp: Date.now(),
      });
    }

    this.emit({
      type: "transport-error",
      eventId: this.nextEventId(),
      sequence: this.sequence++,
      requestId: this.requestId,
      turnId: this.turnId,
      code,
      message,
    });
  }

  emitTerminalCancelled(reason: string): void {
    if (this.terminalCommitted) return;
    this.terminalCommitted = true;

    this.emit({
      type: "transport-cancelled",
      eventId: this.nextEventId(),
      sequence: this.sequence++,
      requestId: this.requestId,
      turnId: this.turnId,
      reason,
    });
  }

  isTerminalCommitted(): boolean {
    return this.terminalCommitted;
  }
}
