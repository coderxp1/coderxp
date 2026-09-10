/**
 * Server-only Logicc (OpenAI-compatible) provider adapter.
 *
 * Fixed upstream origin: https://api.logicc.cloud
 * Credential: LOGICC_API_KEY (server-only, never returned from resolve helpers).
 * Tools: generated exclusively from lib/workspace/agent-tool-manifest.ts.
 */

import { getManifestTool, isValidManifestTool } from "../workspace/agent-tool-manifest";
import type {
  AgentTransportEvent,
  AgentTransportRequest,
  CanonicalAgentMessage,
  CanonicalPart,
} from "../workspace/agent-transport-types";
import {
  LOGICC_CHAT_COMPLETIONS_URL,
  getLogiccAllowedModels,
  getLogiccDefaultModel,
  getProviderConfigSnapshot,
  isLogiccCredentialConfigured,
  isLogiccInternalModeEnabled,
  type EnvBag,
} from "./agent-provider-config";
import {
  discoverLogiccModels,
  type LogiccModelDiscoveryDeps,
} from "./agent-logicc-models";
import type {
  AgentProviderAdapter,
  ProviderCredentialResult,
  ProviderHttpError,
  ProviderRequestOptions,
  ProviderSafeHealth,
  ProviderStreamTranslator,
  ProviderTranslateResult,
  SanitizedProviderModel,
} from "./agent-provider-types";
import { SERVER_RESOURCE_LIMITS } from "./agent-shared-limits";

// ---------------------------------------------------------------------------
// OpenAI-compatible wire types (server-only)
// ---------------------------------------------------------------------------

export interface OpenAITextMessage {
  role: "system" | "user" | "assistant";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type OpenAIMessage = OpenAITextMessage | OpenAIToolMessage;

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature: number;
  max_tokens: number;
  stream: true;
  n: 1;
  tools?: OpenAIToolDefinition[];
  tool_choice?: "auto";
}

// ---------------------------------------------------------------------------
// Canonical → OpenAI translation
// ---------------------------------------------------------------------------

export function validateAndTranslateLogiccRequest(
  request: AgentTransportRequest,
  options: ProviderRequestOptions & {
    approvedModels: readonly SanitizedProviderModel[];
    defaultModelId: string;
  },
): ProviderTranslateResult {
  const requestedModel = options.model ?? options.defaultModelId;
  const approved = options.approvedModels.find((m) => m.id === requestedModel);
  if (!approved) {
    return {
      ok: false,
      errorCode: "MODEL_NOT_ALLOWED",
      message: `Model '${requestedModel}' is not permitted.`,
      status: 400,
    };
  }

  const temperature = options.temperature ?? SERVER_RESOURCE_LIMITS.defaultTemperature;
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

  const maxTokens = options.maxTokens ?? SERVER_RESOURCE_LIMITS.defaultMaxTokens;
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

  const messagesResult = translateMessages(request.messages);
  if (!messagesResult.ok) return messagesResult;

  const toolsResult = translateTools(request.tools);
  if (!toolsResult.ok) return toolsResult;

  const body: OpenAIChatCompletionRequest = {
    model: approved.id,
    messages: messagesResult.messages,
    temperature,
    max_tokens: maxTokens,
    stream: true,
    n: 1,
  };

  if (toolsResult.tools.length > 0) {
    body.tools = toolsResult.tools;
    body.tool_choice = "auto";
  }

  return { ok: true, body, model: approved.id };
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

function translateMessages(
  messages: any[],
):
  | { ok: true; messages: OpenAIMessage[] }
  | ProviderTranslateResult & { ok: false } {
  const out: OpenAIMessage[] = [];
  const knownToolRequests = new Map<string, string>();
  const seenToolResults = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
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
      let text = "";
      for (const part of parts) {
        if (part.type === "system-context" || part.type === "text") {
          text += (text ? "\n\n" : "") + part.text;
        }
      }
      if (text.length > 0) {
        out.push({ role: "system", content: text });
      }
      continue;
    }

    if (msg.role === "user") {
      const texts: string[] = [];
      for (const part of parts) {
        if (part.type === "text") {
          texts.push(part.text);
        } else if (part.type === "system-context") {
          out.push({ role: "system", content: part.text });
        } else {
          return {
            ok: false,
            errorCode: "INVALID_REQUEST",
            message: `User message contains unsupported part type '${part.type}'.`,
            status: 400,
          };
        }
      }
      if (texts.length > 0) {
        out.push({ role: "user", content: texts.join("\n\n") });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];
      for (const part of parts) {
        if (part.type === "text") {
          textParts.push(part.text);
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
          knownToolRequests.set(part.toolCallId, part.name);
          toolCalls.push({
            id: part.toolCallId,
            type: "function",
            function: {
              name: part.name,
              arguments: JSON.stringify(part.args ?? {}),
            },
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

      const assistantMsg: OpenAITextMessage = {
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("\n\n") : null,
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      if (assistantMsg.content !== null || toolCalls.length > 0) {
        out.push(assistantMsg);
      }
      continue;
    }

    if (msg.role === "tool") {
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

        const expectedName = knownToolRequests.get(envelope.toolCallId);
        if (!expectedName) {
          return {
            ok: false,
            errorCode: "INVALID_REQUEST",
            message: `Orphaned tool result '${envelope.toolCallId}' has no matching tool request.`,
            status: 400,
          };
        }
        if (expectedName !== envelope.toolName) {
          return {
            ok: false,
            errorCode: "INVALID_REQUEST",
            message: `Tool name mismatch for '${envelope.toolCallId}': expected '${expectedName}', got '${envelope.toolName}'.`,
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

        const safeContent =
          typeof envelope.modelSafeResult === "string"
            ? envelope.modelSafeResult
            : JSON.stringify(envelope.modelSafeResult ?? null);

        out.push({
          role: "tool",
          tool_call_id: envelope.toolCallId,
          content: safeContent,
        });
      }
      continue;
    }

    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: `Unsupported message role at index ${i}.`,
      status: 400,
    };
  }

  return { ok: true, messages: out };
}

function translateTools(
  tools: AgentTransportRequest["tools"],
):
  | { ok: true; tools: OpenAIToolDefinition[] }
  | ProviderTranslateResult & { ok: false } {
  const out: OpenAIToolDefinition[] = [];
  if (!Array.isArray(tools)) {
    return { ok: true, tools: out };
  }

  if (tools.length > SERVER_RESOURCE_LIMITS.maxTools) {
    return {
      ok: false,
      errorCode: "REQUEST_TOO_LARGE",
      message: `Tool count (${tools.length}) exceeds maximum limit (${SERVER_RESOURCE_LIMITS.maxTools}).`,
      status: 400,
    };
  }

  const seen = new Set<string>();
  for (const clientTool of tools) {
    if (!clientTool || !isValidManifestTool(clientTool.name)) {
      return {
        ok: false,
        errorCode: "TOOL_NOT_ALLOWED",
        message: `Tool '${clientTool?.name}' is unknown or not permitted.`,
        status: 400,
      };
    }

    if (seen.has(clientTool.name)) {
      return {
        ok: false,
        errorCode: "TOOL_NOT_ALLOWED",
        message: `Duplicate tool '${clientTool.name}' in request.`,
        status: 400,
      };
    }
    seen.add(clientTool.name);

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

    out.push({
      type: "function",
      function: {
        name: manifestTool.name,
        description: manifestTool.summary,
        parameters: manifestTool.jsonSchema as unknown as Record<string, unknown>,
      },
    });
  }

  return { ok: true, tools: out };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible SSE → canonical stream translator
// ---------------------------------------------------------------------------

type ToolCallTrack = {
  choiceIndex: number;
  toolIndex: number;
  id: string | null;
  name: string | null;
  args: string;
  startedEmitted: boolean;
  completed: boolean;
  /** Buffered argument fragments received before id+name were known. */
  pendingArgChunks: string[];
};

export class LogiccStreamTranslator implements ProviderStreamTranslator {
  private sequence = 1;
  private terminalCommitted = false;
  private turnStartedEmitted = false;
  private finishReason: "stop" | "tool_calls" | "max_tokens" | null = null;
  private pendingUsage: { inputTokens: number; outputTokens: number } | null = null;
  private doneReceived = false;
  private readonly toolTracks = new Map<string, ToolCallTrack>();
  private readonly toolIds = new Set<string>();

  constructor(
    private readonly requestId: string,
    private readonly turnId: string,
    private readonly emit: (event: AgentTransportEvent) => void,
  ) {}

  private trackKey(choiceIndex: number, toolIndex: number): string {
    return `${choiceIndex}:${toolIndex}`;
  }

  private nextEventId(): string {
    return `evt-${this.turnId}-${this.sequence}`;
  }

  private ensureTurnStarted(): void {
    if (this.turnStartedEmitted) return;
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

  handleDataPayload(data: string): void {
    if (this.terminalCommitted) return;

    if (data === "[DONE]") {
      this.doneReceived = true;
      this.tryFinalizeFromDone();
      return;
    }

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(data) as Record<string, unknown>;
    } catch {
      this.emitTerminalError(
        "UPSTREAM_PROTOCOL_ERROR",
        "Failed to parse upstream event data.",
      );
      return;
    }

    this.handleChunkObject(obj);
  }

  notifyStreamEnded(): void {
    if (this.terminalCommitted) return;

    if (this.finishReason !== null) {
      // Confirmed normal upstream completion without an explicit [DONE] marker.
      this.emitUsageIfPending();
      this.emitTerminalCompleted(this.finishReason);
      return;
    }

    if (this.doneReceived) {
      // [DONE] without finish_reason is a protocol error (handled in tryFinalize).
      return;
    }

    this.emitTerminalError(
      "UPSTREAM_PREMATURE_CLOSE",
      "Upstream stream closed without a terminal completion event.",
    );
  }

  private tryFinalizeFromDone(): void {
    if (this.terminalCommitted) return;

    if (this.finishReason === null) {
      this.emitTerminalError(
        "UPSTREAM_PROTOCOL_ERROR",
        "Upstream [DONE] received without a valid finish reason.",
      );
      return;
    }

    this.emitUsageIfPending();
    this.emitTerminalCompleted(this.finishReason);
  }

  private emitUsageIfPending(): void {
    if (!this.pendingUsage) return;
    const usage = this.pendingUsage;
    this.pendingUsage = null;
    this.emit({
      type: "usage",
      eventId: this.nextEventId(),
      sequence: this.sequence++,
      requestId: this.requestId,
      turnId: this.turnId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
  }

  private handleChunkObject(obj: Record<string, unknown>): void {
    this.ensureTurnStarted();

    // OpenAI error object shape
    if (obj.error && typeof obj.error === "object") {
      const err = obj.error as Record<string, unknown>;
      const msg =
        typeof err.message === "string" ? err.message : "Upstream provider error.";
      this.emitTerminalError("UPSTREAM_ERROR", msg);
      return;
    }

    const choices = obj.choices;
    if (!Array.isArray(choices)) {
      // Usage-only final chunk (some providers emit usage after choices clear)
      this.captureUsage(obj);
      return;
    }

    if (choices.length > 1) {
      this.emitTerminalError(
        "UPSTREAM_PROTOCOL_ERROR",
        "Multiple completion choices are not supported (n must be 1).",
      );
      return;
    }

    if (choices.length === 0) {
      this.captureUsage(obj);
      return;
    }

    const choice = choices[0] as Record<string, unknown>;
    const choiceIndex = typeof choice.index === "number" ? choice.index : 0;
    if (choiceIndex !== 0) {
      this.emitTerminalError(
        "UPSTREAM_PROTOCOL_ERROR",
        "Only choice index 0 is supported.",
      );
      return;
    }

    const delta = (choice.delta as Record<string, unknown>) ?? {};
    const finishReasonRaw = choice.finish_reason;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      this.emit({
        type: "text-delta",
        eventId: this.nextEventId(),
        sequence: this.sequence++,
        requestId: this.requestId,
        turnId: this.turnId,
        text: delta.content,
      });
    }

    const toolCalls = delta.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const rawTc of toolCalls) {
        if (!rawTc || typeof rawTc !== "object") {
          this.emitTerminalError(
            "UPSTREAM_PROTOCOL_ERROR",
            "Malformed tool_calls delta entry.",
          );
          return;
        }
        if (!this.handleToolCallDelta(choiceIndex, rawTc as Record<string, unknown>)) {
          return;
        }
      }
    }

    this.captureUsage(obj);

    if (finishReasonRaw !== null && finishReasonRaw !== undefined) {
      if (typeof finishReasonRaw !== "string") {
        this.emitTerminalError(
          "UPSTREAM_PROTOCOL_ERROR",
          "Invalid finish_reason type.",
        );
        return;
      }

      // Complete any open tool calls before recording finish.
      for (const track of this.toolTracks.values()) {
        if (track.startedEmitted && !track.completed) {
          track.completed = true;
          this.emit({
            type: "tool-call-completed",
            eventId: this.nextEventId(),
            sequence: this.sequence++,
            requestId: this.requestId,
            turnId: this.turnId,
            toolCallId: track.id!,
          });
        }
      }

      let mapped: "stop" | "tool_calls" | "max_tokens" = "stop";
      if (finishReasonRaw === "tool_calls") mapped = "tool_calls";
      else if (finishReasonRaw === "length") mapped = "max_tokens";
      else if (
        finishReasonRaw === "stop" ||
        finishReasonRaw === "end_turn" ||
        finishReasonRaw === "function_call"
      ) {
        mapped = finishReasonRaw === "function_call" ? "tool_calls" : "stop";
      } else {
        this.emitTerminalError(
          "UPSTREAM_PROTOCOL_ERROR",
          `Unsupported finish_reason '${finishReasonRaw}'.`,
        );
        return;
      }

      this.finishReason = mapped;
      // Do NOT emit terminal yet — wait for usage/[DONE]/EOF per protocol.
    }
  }

  private captureUsage(obj: Record<string, unknown>): void {
    const usage = obj.usage;
    if (!usage || typeof usage !== "object") return;
    const u = usage as Record<string, unknown>;
    const input =
      typeof u.prompt_tokens === "number"
        ? u.prompt_tokens
        : typeof u.input_tokens === "number"
          ? u.input_tokens
          : 0;
    const output =
      typeof u.completion_tokens === "number"
        ? u.completion_tokens
        : typeof u.output_tokens === "number"
          ? u.output_tokens
          : 0;
    this.pendingUsage = { inputTokens: input, outputTokens: output };
  }

  private handleToolCallDelta(
    choiceIndex: number,
    raw: Record<string, unknown>,
  ): boolean {
    const toolIndex = typeof raw.index === "number" ? raw.index : -1;
    if (toolIndex < 0) {
      this.emitTerminalError(
        "UPSTREAM_PROTOCOL_ERROR",
        "Tool call delta missing valid index.",
      );
      return false;
    }

    const key = this.trackKey(choiceIndex, toolIndex);
    let track = this.toolTracks.get(key);

    const id = typeof raw.id === "string" ? raw.id : null;
    const fn = (raw.function as Record<string, unknown>) ?? {};
    const name = typeof fn.name === "string" ? fn.name : null;
    const argsChunk = typeof fn.arguments === "string" ? fn.arguments : "";

    if (!track) {
      track = {
        choiceIndex,
        toolIndex,
        id: null,
        name: null,
        args: "",
        startedEmitted: false,
        completed: false,
        pendingArgChunks: [],
      };
      this.toolTracks.set(key, track);
    }

    if (track.completed) {
      if (argsChunk.length > 0 || id || name) {
        this.emitTerminalError(
          "UPSTREAM_PROTOCOL_ERROR",
          "Tool call arguments received after completion.",
        );
        return false;
      }
      return true;
    }

    // Identity conflict checks
    if (id) {
      if (track.id && track.id !== id) {
        this.emitTerminalError(
          "UPSTREAM_PROTOCOL_ERROR",
          "Tool call index reused with conflicting id.",
        );
        return false;
      }
      if (!track.id) {
        if (this.toolIds.has(id)) {
          this.emitTerminalError(
            "UPSTREAM_PROTOCOL_ERROR",
            `Duplicate tool call id '${id}'.`,
          );
          return false;
        }
        track.id = id;
        this.toolIds.add(id);
      }
    }

    if (name !== null) {
      if (name.length === 0) {
        this.emitTerminalError(
          "UPSTREAM_PROTOCOL_ERROR",
          "Tool call name must not be empty.",
        );
        return false;
      }
      if (track.name && track.name !== name) {
        this.emitTerminalError(
          "UPSTREAM_PROTOCOL_ERROR",
          "Tool call index reused with conflicting name.",
        );
        return false;
      }
      track.name = name;
    }

    if (argsChunk.length > 0) {
      if (!track.id || !track.name) {
        // Buffer until identity is known; do not emit started yet.
        track.pendingArgChunks.push(argsChunk);
      } else {
        this.ensureToolStarted(track);
        track.args += argsChunk;
        this.emit({
          type: "tool-call-arguments-delta",
          eventId: this.nextEventId(),
          sequence: this.sequence++,
          requestId: this.requestId,
          turnId: this.turnId,
          toolCallId: track.id,
          chunk: argsChunk,
        });
      }
    } else if (track.id && track.name) {
      this.ensureToolStarted(track);
    }

    return !this.terminalCommitted;
  }

  private ensureToolStarted(track: ToolCallTrack): void {
    if (track.startedEmitted || !track.id || !track.name) return;
    track.startedEmitted = true;
    this.emit({
      type: "tool-call-started",
      eventId: this.nextEventId(),
      sequence: this.sequence++,
      requestId: this.requestId,
      turnId: this.turnId,
      toolCallId: track.id,
      toolName: track.name,
    });

    // Flush buffered argument fragments in order.
    for (const chunk of track.pendingArgChunks) {
      track.args += chunk;
      this.emit({
        type: "tool-call-arguments-delta",
        eventId: this.nextEventId(),
        sequence: this.sequence++,
        requestId: this.requestId,
        turnId: this.turnId,
        toolCallId: track.id,
        chunk,
      });
    }
    track.pendingArgChunks = [];
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
    this.ensureTurnStarted();
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

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export type LogiccAdapterOptions = {
  env?: EnvBag;
  modelDiscoveryDeps?: LogiccModelDiscoveryDeps;
  /**
   * When set, skip live discovery and use these approved models
   * (deterministic tests).
   */
  fixedApprovedModels?: SanitizedProviderModel[];
  fixedDefaultModelId?: string;
};

function resolveLogiccOperationalStatus(env: EnvBag): ProviderSafeHealth {
  const snapshot = getProviderConfigSnapshot(env);
  const base = {
    ok: true as const,
    provider: "logicc" as const,
    byokRequired: false,
    displayName: "Logicc",
    defaultModelDisplayName: snapshot.logiccDefaultModel,
  };

  if (!snapshot.logiccInternalMode) {
    return {
      ...base,
      ready: false,
      access: "restricted",
      status: "access_restricted",
    };
  }

  if (!snapshot.logiccCredentialConfigured) {
    return {
      ...base,
      ready: false,
      access: "internal",
      status: "unavailable",
    };
  }

  if (snapshot.logiccAllowedModels.length === 0 || !snapshot.logiccDefaultModel) {
    return {
      ...base,
      ready: false,
      access: "internal",
      status: "unavailable",
    };
  }

  if (
    snapshot.logiccDefaultModel &&
    !snapshot.logiccAllowedModels.includes(snapshot.logiccDefaultModel)
  ) {
    return {
      ...base,
      ready: false,
      access: "internal",
      status: "unavailable",
    };
  }

  return {
    ...base,
    ready: true,
    access: "internal",
    status: "ready",
    defaultModelDisplayName: snapshot.logiccDefaultModel,
  };
}

export function createLogiccAdapter(
  options: LogiccAdapterOptions = {},
): AgentProviderAdapter {
  const env = options.env ?? process.env;
  const discoveryDeps: LogiccModelDiscoveryDeps = {
    ...options.modelDiscoveryDeps,
    env,
  };

  return {
    id: "logicc",
    displayName: "Logicc",

    getUpstreamUrl(): string {
      return LOGICC_CHAT_COMPLETIONS_URL;
    },

    requiresBrowserByok(): boolean {
      return false;
    },

    getSafeHealth(): ProviderSafeHealth {
      return resolveLogiccOperationalStatus(env);
    },

    beginCredentialSession(_browserByokHeader: string | null): ProviderCredentialResult {
      // Ignore browser BYOK entirely — server-owned key only.
      if (!isLogiccInternalModeEnabled(env)) {
        return {
          ok: false,
          errorCode: "ACCESS_RESTRICTED",
          message: "Logicc mode is restricted to internal deployments.",
          status: 403,
        };
      }

      let key = "";
      if (isLogiccCredentialConfigured(env)) {
        key = (env.LOGICC_API_KEY ?? "").trim();
      }

      if (!key) {
        return {
          ok: false,
          errorCode: "PROVIDER_NOT_CONFIGURED",
          message: "Logicc provider is not configured.",
          status: 503,
        };
      }

      return {
        ok: true,
        session: {
          applyAuth(headers: Record<string, string>): void {
            if (key) {
              headers.Authorization = `Bearer ${key}`;
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
      reqOptions?: ProviderRequestOptions,
    ): ProviderTranslateResult {
      // Synchronous path for tests with fixed models; production uses
      // validateAndTranslateRequestAsync via the handler when needed.
      if (options.fixedApprovedModels && options.fixedDefaultModelId) {
        return validateAndTranslateLogiccRequest(request, {
          ...reqOptions,
          approvedModels: options.fixedApprovedModels,
          defaultModelId: options.fixedDefaultModelId,
        });
      }

      // Fail closed if discovery is required but not pre-seeded: the async
      // handler path must call prepareLogiccTranslation first.
      const allowlist = getLogiccAllowedModels(env);
      const defaultModel = getLogiccDefaultModel(env);
      if (!defaultModel || allowlist.length === 0) {
        return {
          ok: false,
          errorCode: "PROVIDER_NOT_CONFIGURED",
          message: "Logicc models are not configured.",
          status: 503,
        };
      }

      // Without fixed models, only allowlist membership is checked here;
      // live availability is enforced by prepareLogiccTranslation in the handler.
      const requested = reqOptions?.model ?? defaultModel;
      if (!allowlist.includes(requested)) {
        return {
          ok: false,
          errorCode: "MODEL_NOT_ALLOWED",
          message: `Model '${requested}' is not permitted.`,
          status: 400,
        };
      }

      const approvedModels = allowlist.map((id) => ({ id, displayName: id }));
      return validateAndTranslateLogiccRequest(request, {
        ...reqOptions,
        approvedModels,
        defaultModelId: defaultModel,
      });
    },

    createStreamTranslator(requestId, turnId, emit): ProviderStreamTranslator {
      return new LogiccStreamTranslator(requestId, turnId, emit);
    },

    normalizeHttpError(status: number): ProviderHttpError {
      if (status === 401 || status === 403) {
        return {
          errorCode: "INVALID_CREDENTIALS",
          message: "Logicc provider rejected the request.",
        };
      }
      if (status === 429) {
        // Distinguish QUOTA_EXCEEDED only with a reliable machine-readable
        // signal; HTTP 429 alone maps to RATE_LIMITED.
        return {
          errorCode: "RATE_LIMITED",
          message: "Logicc rate limit exceeded. Please wait before retrying.",
        };
      }
      if (status >= 500) {
        return {
          errorCode: "PROVIDER_UNAVAILABLE",
          message: "Logicc service is temporarily unavailable.",
        };
      }
      return {
        errorCode: "UPSTREAM_ERROR",
        message: `Upstream provider returned HTTP ${status}.`,
      };
    },

    async listSanitizedModels() {
      if (options.fixedApprovedModels && options.fixedDefaultModelId) {
        return {
          ok: true as const,
          models: options.fixedApprovedModels.map((m) => ({ ...m })),
          defaultModelId: options.fixedDefaultModelId,
        };
      }
      const result = await discoverLogiccModels(discoveryDeps);
      if (!result.ok) {
        return {
          ok: false as const,
          errorCode: result.errorCode,
          message: result.message,
          status: result.status,
        };
      }
      return {
        ok: true as const,
        models: result.models,
        defaultModelId: result.defaultModelId,
      };
    },
  };
}

/**
 * Async preparation that intersects discovery/allowlist before translating.
 * Uses the adapter's listSanitizedModels (fixed fixtures or live discovery).
 */
export async function prepareLogiccTranslation(
  adapter: AgentProviderAdapter,
  request: AgentTransportRequest,
  reqOptions: ProviderRequestOptions | undefined,
): Promise<ProviderTranslateResult> {
  if (!adapter.listSanitizedModels) {
    return {
      ok: false,
      errorCode: "PROVIDER_NOT_CONFIGURED",
      message: "Logicc model listing is not available.",
      status: 503,
    };
  }

  const listed = await adapter.listSanitizedModels();
  if (!listed.ok) {
    return {
      ok: false,
      errorCode: listed.errorCode,
      message: listed.message,
      status: listed.status,
    };
  }

  if (!listed.defaultModelId || listed.models.length === 0) {
    return {
      ok: false,
      errorCode: "MODEL_UNAVAILABLE",
      message: "No Logicc models are both enabled and administrator-approved.",
      status: 503,
    };
  }

  return validateAndTranslateLogiccRequest(request, {
    ...reqOptions,
    approvedModels: listed.models,
    defaultModelId: listed.defaultModelId,
  });
}
