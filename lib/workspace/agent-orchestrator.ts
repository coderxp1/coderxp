/**
 * Agent Orchestration State Machine & Multi-Turn Controller for CoderXP M3.8.
 *
 * Coordinates multi-turn conversation loops between provider-neutral transports
 * and the M3.7 AgentExecutionRuntime.
 *
 * Invariants:
 * - Iterative finite state machine; constant call-stack depth (zero recursion).
 * - Client of M3.7: interacts exclusively via public M3.7 submission/resume/cancel APIs.
 * - Transport stream turns close immediately upon turn completion; never held open while waiting for tools or human approval.
 * - Tool calls submitted ONLY after valid turn-completed event AND normal iterator closure AND schema validation.
 * - Monotonic event sequence checking with idempotent eventId replay handling.
 * - Strict resource budgets with machine-readable failure codes.
 * - Context building preserves system context, user prompt, and indivisible atomic tool pairs.
 */

import { AGENT_TOOLS, type AgentToolDefinition } from "./agent-tools";
import { projectModelFacingResult } from "./agent-sanitizer";
import { ToolCallAssembler } from "./agent-tool-assembler";
import type { AgentExecutionRuntime, AgentExecutionAttempt } from "./agent-execution-runtime";
import type {
  AgentTransport,
  AgentTransportEvent,
  AgentTransportRequest,
  CanonicalAgentMessage,
  CanonicalPart,
  CanonicalRole,
  CanonicalToolDefinition,
  CanonicalToolResultEnvelope,
} from "./agent-transport-types";

// ---------------------------------------------------------------------------
// Orchestration State & Error Types
// ---------------------------------------------------------------------------

export type OrchestrationState =
  | "idle"
  | "starting"
  | "streaming"
  | "assembling-tool-calls"
  | "waiting-for-tools"
  | "waiting-for-approval"
  | "continuing"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale";

export type OrchestrationErrorCode =
  | "MAX_TURNS_EXCEEDED"
  | "MAX_TOOL_CALLS_EXCEEDED"
  | "MAX_TOTAL_TOOLS_EXCEEDED"
  | "ARGUMENT_LIMIT_EXCEEDED"
  | "STREAM_LIMIT_EXCEEDED"
  | "MAX_TOKENS_REACHED"
  | "TRANSPORT_FAILED"
  | "PROTOCOL_ERROR"
  | "UNKNOWN_TOOL"
  | "INVALID_PARAMS"
  | "CONTEXT_BUDGET_EXCEEDED"
  | "USER_INPUT_TOO_LARGE"
  | "TIMEOUT";

export interface OrchestrationError {
  code: OrchestrationErrorCode;
  message: string;
}

export interface OrchestrationBudgetOptions {
  maxTurns?: number;
  maxToolsPerTurn?: number;
  maxToolsPerRun?: number;
  maxAssembledArgumentBytes?: number;
  maxAssistantTextBytes?: number;
  maxContextBytes?: number;
  runTimeoutMs?: number;
}

export interface OrchestratorEnvironment {
  now?: () => number;
  scheduleTimeout?: (ms: number, cb: () => void) => () => void;
  nextId?: (prefix: string) => string;
  scheduleDrain?: (cb: () => void) => void;
}

export interface OrchestratorOptions {
  projectId: string;
  generation: number;
  runtime: AgentExecutionRuntime;
  transport?: AgentTransport;
  systemContext?: string;
  budgets?: OrchestrationBudgetOptions;
  env?: OrchestratorEnvironment;
  onEvent?: (event: OrchestratorLifecycleEvent) => void;
}

// ---------------------------------------------------------------------------
// Lifecycle Events
// ---------------------------------------------------------------------------

export type OrchestratorLifecycleEvent =
  | {
      type: "orchestrator:run-started";
      runId: string;
      projectId: string;
      generation: number;
      timestamp: number;
    }
  | {
      type: "orchestrator:turn-started";
      runId: string;
      turnId: string;
      turnIndex: number;
      timestamp: number;
    }
  | {
      type: "orchestrator:text-delta";
      runId: string;
      turnId: string;
      text: string;
    }
  | {
      type: "orchestrator:tool-call-started";
      runId: string;
      turnId: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "orchestrator:tool-call-delta";
      runId: string;
      turnId: string;
      toolCallId: string;
      chunk: string;
    }
  | {
      type: "orchestrator:tool-call-assembled";
      runId: string;
      turnId: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "orchestrator:tools-submitted";
      runId: string;
      turnId: string;
      toolCallIds: string[];
    }
  | {
      type: "orchestrator:waiting-approval";
      runId: string;
      turnId: string;
      attemptId: string;
      toolCallId: string;
    }
  | {
      type: "orchestrator:resumed";
      runId: string;
      turnId: string;
      attemptId: string;
    }
  | {
      type: "orchestrator:tools-resolved";
      runId: string;
      turnId: string;
      envelopes: CanonicalToolResultEnvelope[];
    }
  | {
      type: "orchestrator:turn-next";
      runId: string;
      nextTurnIndex: number;
    }
  | {
      type: "orchestrator:run-completed";
      runId: string;
      messages: CanonicalAgentMessage[];
    }
  | {
      type: "orchestrator:run-failed";
      runId: string;
      error: OrchestrationError;
    }
  | {
      type: "orchestrator:run-cancelled";
      runId: string;
      reason: string;
    }
  | {
      type: "orchestrator:run-stale";
      runId: string;
      generation: number;
    };

// ---------------------------------------------------------------------------
// Constants & Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_TOOLS_PER_TURN = 8;
const DEFAULT_MAX_TOOLS_PER_RUN = 32;
const DEFAULT_MAX_ASSISTANT_TEXT_BYTES = 128 * 1024;
const DEFAULT_MAX_CONTEXT_BYTES = 256 * 1024;
const DEFAULT_RUN_TIMEOUT_MS = 300_000; // 5 minutes

const utf8Encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// AgentOrchestrator Class
// ---------------------------------------------------------------------------

export class AgentOrchestrator {
  private projectId: string;
  private generation: number;
  private runtime: AgentExecutionRuntime;
  private transport: AgentTransport | null;
  private systemContext: string;

  // Primitives
  private now: () => number;
  private scheduleTimeout: (ms: number, cb: () => void) => () => void;
  private nextId: (prefix: string) => string;
  private scheduleDrain: (cb: () => void) => void;
  private onEventCb?: (event: OrchestratorLifecycleEvent) => void;

  // Budgets
  private maxTurns: number;
  private maxToolsPerTurn: number;
  private maxToolsPerRun: number;
  private maxAssistantTextBytes: number;
  private maxContextBytes: number;
  private runTimeoutMs: number;

  // Active Run State
  private state: OrchestrationState = "idle";
  private currentRunId: string | null = null;
  private currentTurnId: string | null = null;
  private currentTurnIndex = 0;
  private totalToolCount = 0;

  private conversationMessages: CanonicalAgentMessage[] = [];
  private currentAssistantMessage: CanonicalAgentMessage | null = null;
  private currentAssistantText = "";

  private currentTurnToolAttempts = new Map<string, string>(); // toolCallId -> attemptId
  private currentTurnSettledAttempts = new Map<string, CanonicalToolResultEnvelope>();

  private abortController: AbortController | null = null;
  private cancelTimeout: (() => void) | null = null;
  private isProcessingLoop = false;
  private runtimeUnsubscribe: (() => void) | null = null;

  constructor(options: OrchestratorOptions) {
    this.projectId = options.projectId;
    this.generation = options.generation;
    this.runtime = options.runtime;
    this.transport = options.transport ?? null;
    this.systemContext = options.systemContext ?? "You are CoderXP Agent, a tier-gated software development assistant.";
    this.onEventCb = options.onEvent;

    // Primitives
    this.now = options.env?.now ?? (() => Date.now());
    this.scheduleDrain = options.env?.scheduleDrain ?? ((cb) => queueMicrotask(cb));

    let counter = 0;
    this.nextId = options.env?.nextId ?? ((prefix) => `${prefix}-${++counter}-${Math.random().toString(36).slice(2, 8)}`);

    this.scheduleTimeout =
      options.env?.scheduleTimeout ??
      ((ms, cb) => {
        const id = setTimeout(cb, ms);
        return () => clearTimeout(id);
      });

    // Budgets
    this.maxTurns = options.budgets?.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxToolsPerTurn = options.budgets?.maxToolsPerTurn ?? DEFAULT_MAX_TOOLS_PER_TURN;
    this.maxToolsPerRun = options.budgets?.maxToolsPerRun ?? DEFAULT_MAX_TOOLS_PER_RUN;
    this.maxAssistantTextBytes = options.budgets?.maxAssistantTextBytes ?? DEFAULT_MAX_ASSISTANT_TEXT_BYTES;
    this.maxContextBytes = options.budgets?.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES;
    this.runTimeoutMs = options.budgets?.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

    this.bindRuntime();
  }

  private bindRuntime(): void {
    this.runtimeUnsubscribe = this.runtime.onEvent((event) => {
      this.handleRuntimeEvent(event);
    });
  }

  // -------------------------------------------------------------------------
  // Public Getters
  // -------------------------------------------------------------------------

  getState(): OrchestrationState {
    return this.state;
  }

  getRunId(): string | null {
    return this.currentRunId;
  }

  getMessages(): CanonicalAgentMessage[] {
    return [...this.conversationMessages];
  }

  getProjectId(): string {
    return this.projectId;
  }

  getGeneration(): number {
    return this.generation;
  }

  setTransport(transport: AgentTransport | null): void {
    this.transport = transport;
  }

  getTransport(): AgentTransport | null {
    return this.transport;
  }

  // -------------------------------------------------------------------------
  // Run Submission & Lifecycle Control
  // -------------------------------------------------------------------------

  submitRun(userPrompt: string): { runId: string } {
    const trimmed = userPrompt.trim();
    if (trimmed.length === 0) {
      throw new Error("Cannot submit an empty user prompt.");
    }

    if (utf8Encoder.encode(trimmed).length > this.maxContextBytes) {
      throw new Error(`User input exceeds maximum allowed context budget of ${this.maxContextBytes} bytes.`);
    }

    // Allocate fresh run identity
    const runId = this.nextId("run");
    this.currentRunId = runId;
    this.currentTurnIndex = 0;
    this.totalToolCount = 0;
    this.currentTurnToolAttempts.clear();
    this.currentTurnSettledAttempts.clear();

    const userMessage: CanonicalAgentMessage = {
      id: this.nextId("msg"),
      role: "user",
      parts: [{ type: "text", text: trimmed }],
      createdAt: this.now(),
      status: "complete",
    };
    this.conversationMessages.push(userMessage);

    this.transition("starting", () => {
      this.emit({
        type: "orchestrator:run-started",
        runId,
        projectId: this.projectId,
        generation: this.generation,
        timestamp: this.now(),
      });
    });

    // Schedule timeout
    this.abortController = new AbortController();
    this.cancelTimeout = this.scheduleTimeout(this.runTimeoutMs, () => {
      if (this.currentRunId === runId && this.isActiveState()) {
        this.transition("failed", () => {
          this.emit({
            type: "orchestrator:run-failed",
            runId,
            error: {
              code: "TIMEOUT",
              message: `Orchestration run exceeded timeout limit of ${this.runTimeoutMs}ms.`,
            },
          });
        });
      }
    });

    this.scheduleNextLoopStep();
    return { runId };
  }

  cancel(reason: string = "User cancelled run"): boolean {
    if (!this.isActiveState() || !this.currentRunId) {
      return false;
    }

    const runId = this.currentRunId;
    this.transition("cancelled", () => {
      if (this.currentAssistantMessage) {
        this.currentAssistantMessage.status = "cancelled";
      }
      this.emit({
        type: "orchestrator:run-cancelled",
        runId,
        reason,
      });
    });
    return true;
  }

  invalidateGeneration(newGeneration: number): void {
    if (this.generation === newGeneration) return;
    this.generation = newGeneration;

    if (this.isActiveState() && this.currentRunId) {
      const runId = this.currentRunId;
      this.transition("stale", () => {
        if (this.currentAssistantMessage) {
          this.currentAssistantMessage.status = "error";
        }
        this.emit({
          type: "orchestrator:run-stale",
          runId,
          generation: newGeneration,
        });
      });
    }
  }

  // -------------------------------------------------------------------------
  // Iterative Loop Controller (Zero Recursion)
  // -------------------------------------------------------------------------

  private scheduleNextLoopStep(): void {
    if (this.isProcessingLoop) return;
    this.scheduleDrain(() => {
      void this.processLoopStep();
    });
  }

  private async processLoopStep(): Promise<void> {
    if (this.isProcessingLoop) return;
    this.isProcessingLoop = true;

    try {
      while (this.isActiveState()) {
        if (this.state === "starting") {
          await this.executeStartingStep();
        } else if (this.state === "continuing") {
          await this.executeContinuingStep();
        } else {
          // In streaming, assembling-tool-calls, waiting-for-tools, waiting-for-approval:
          // Wait for incoming async transport or execution events
          break;
        }
      }
    } finally {
      this.isProcessingLoop = false;
    }
  }

  private async executeStartingStep(): Promise<void> {
    if (!this.currentRunId || !this.isActiveState()) return;

    if (this.currentTurnIndex >= this.maxTurns) {
      this.transition("failed", () => {
        this.emit({
          type: "orchestrator:run-failed",
          runId: this.currentRunId!,
          error: {
            code: "MAX_TURNS_EXCEEDED",
            message: `Run exceeded maximum turn limit of ${this.maxTurns} turns.`,
          },
        });
      });
      return;
    }

    if (!this.transport) {
      this.transition("failed", () => {
        this.emit({
          type: "orchestrator:run-failed",
          runId: this.currentRunId!,
          error: {
            code: "TRANSPORT_FAILED",
            message: "No AI transport configured for orchestrator.",
          },
        });
      });
      return;
    }

    const turnId = this.nextId("turn");
    this.currentTurnId = turnId;
    this.currentAssistantText = "";
    this.currentTurnToolAttempts.clear();
    this.currentTurnSettledAttempts.clear();

    const assistantMsg: CanonicalAgentMessage = {
      id: this.nextId("msg"),
      role: "assistant",
      parts: [],
      createdAt: this.now(),
      status: "streaming",
    };
    this.currentAssistantMessage = assistantMsg;
    this.conversationMessages.push(assistantMsg);

    this.transition("streaming", () => {
      this.emit({
        type: "orchestrator:turn-started",
        runId: this.currentRunId!,
        turnId,
        turnIndex: this.currentTurnIndex,
        timestamp: this.now(),
      });
    });

    const contextPayload = this.buildContextPayload(this.currentRunId, turnId);
    if (!contextPayload.ok) {
      this.transition("failed", () => {
        this.emit({
          type: "orchestrator:run-failed",
          runId: this.currentRunId!,
          error: contextPayload.error,
        });
      });
      return;
    }

    // Run the streaming consumption loop
    await this.consumeTransportStream(contextPayload.request);
  }

  private async consumeTransportStream(request: AgentTransportRequest): Promise<void> {
    const runId = this.currentRunId!;
    const turnId = this.currentTurnId!;
    const assembler = new ToolCallAssembler();

    let expectedSequence = 1;
    let turnStartedSeen = false;
    let terminalEventSeen: AgentTransportEvent | null = null;
    let textAfterToolCall = false;
    let previousUsageTotal = 0;
    const acceptedEventIds = new Map<string, string>(); // eventId -> deterministic hash

    let streamIterator: AsyncIterator<AgentTransportEvent> | null = null;

    try {
      const stream = this.transport!.send(request, this.abortController!.signal);
      streamIterator = stream[Symbol.asyncIterator]();

      while (true) {
        if (!this.isActiveState() || this.currentRunId !== runId) {
          return;
        }

        const nextResult = await streamIterator.next();
        if (nextResult.done) {
          // Stream completed iteration
          break;
        }

        const event = nextResult.value;

        // If an event arrives after a terminal event, fail with protocol error
        if (terminalEventSeen !== null) {
          throw {
            code: "PROTOCOL_ERROR",
            message: "Received transport event after terminal event was emitted.",
          };
        }

        // Validate turn & request correlation
        if (event.turnId !== turnId || event.requestId !== request.requestId) {
          throw {
            code: "PROTOCOL_ERROR",
            message: `Event IDs mismatch (expected turn "${turnId}", got "${event.turnId}").`,
          };
        }

        // Event replay and sequence validation
        const eventHash = JSON.stringify(event);
        const existingHash = acceptedEventIds.get(event.eventId);
        if (existingHash) {
          if (existingHash === eventHash) {
            // Valid idempotent replay: ignore
            continue;
          } else {
            throw {
              code: "PROTOCOL_ERROR",
              message: `Duplicate eventId "${event.eventId}" with conflicting payload.`,
            };
          }
        }

        // Require strictly monotonic sequence for new events
        if (event.sequence !== expectedSequence) {
          throw {
            code: "PROTOCOL_ERROR",
            message: `Non-monotonic event sequence (expected ${expectedSequence}, got ${event.sequence}).`,
          };
        }
        expectedSequence++;
        acceptedEventIds.set(event.eventId, eventHash);

        // Turn-started must be sequence 1
        if (event.type === "turn-started") {
          if (event.sequence !== 1 || turnStartedSeen) {
            throw {
              code: "PROTOCOL_ERROR",
              message: "turn-started must be the first event at sequence 1.",
            };
          }
          turnStartedSeen = true;
          continue;
        }

        if (!turnStartedSeen) {
          throw {
            code: "PROTOCOL_ERROR",
            message: `Expected turn-started event before receiving ${event.type}.`,
          };
        }

        // Process stream events
        switch (event.type) {
          case "text-delta": {
            if (textAfterToolCall) {
              throw {
                code: "PROTOCOL_ERROR",
                message: "text-delta cannot appear after tool-call-started in the same turn.",
              };
            }
            this.currentAssistantText += event.text;
            if (utf8Encoder.encode(this.currentAssistantText).length > this.maxAssistantTextBytes) {
              throw {
                code: "STREAM_LIMIT_EXCEEDED",
                message: `Assistant text output exceeded budget of ${this.maxAssistantTextBytes} bytes.`,
              };
            }
            this.emit({
              type: "orchestrator:text-delta",
              runId,
              turnId,
              text: event.text,
            });
            break;
          }

          case "tool-call-started": {
            textAfterToolCall = true;
            this.totalToolCount++;
            if (this.totalToolCount > this.maxToolsPerRun) {
              throw {
                code: "MAX_TOTAL_TOOLS_EXCEEDED",
                message: `Run exceeded total tool limit of ${this.maxToolsPerRun} tools.`,
              };
            }

            const startedCalls = assembler.getStartedToolCallIds();
            if (startedCalls.length >= this.maxToolsPerTurn) {
              throw {
                code: "MAX_TOOL_CALLS_EXCEEDED",
                message: `Turn exceeded limit of ${this.maxToolsPerTurn} tool calls.`,
              };
            }

            const startResult = assembler.startToolCall(event.toolCallId, event.toolName);
            if (!startResult.ok) {
              throw startResult.error;
            }

            if (this.state === "streaming") {
              this.transition("assembling-tool-calls", () => {});
            }

            this.emit({
              type: "orchestrator:tool-call-started",
              runId,
              turnId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            });
            break;
          }

          case "tool-call-arguments-delta": {
            const deltaResult = assembler.appendArgumentChunk(event.toolCallId, event.chunk);
            if (!deltaResult.ok) {
              throw deltaResult.error;
            }
            this.emit({
              type: "orchestrator:tool-call-delta",
              runId,
              turnId,
              toolCallId: event.toolCallId,
              chunk: event.chunk,
            });
            break;
          }

          case "tool-call-completed": {
            const compResult = assembler.completeToolCall(event.toolCallId);
            if (!compResult.ok) {
              throw compResult.error;
            }
            this.emit({
              type: "orchestrator:tool-call-assembled",
              runId,
              turnId,
              toolCallId: event.toolCallId,
              toolName: event.toolCallId,
            });
            break;
          }

          case "usage": {
            const total = event.inputTokens + event.outputTokens;
            if (total < previousUsageTotal) {
              throw {
                code: "PROTOCOL_ERROR",
                message: "Usage event reported decreasing cumulative token count.",
              };
            }
            previousUsageTotal = total;
            break;
          }

          case "turn-completed":
          case "transport-error":
          case "transport-cancelled": {
            terminalEventSeen = event;
            break;
          }
        }
      }

      // Stream closed normally. Check that a terminal event was received.
      if (!terminalEventSeen) {
        throw {
          code: "PROTOCOL_ERROR",
          message: "Transport stream closed normally without emitting a terminal event.",
        };
      }

      // Handle terminal event outcome
      if (terminalEventSeen.type === "transport-error") {
        throw {
          code: "TRANSPORT_FAILED",
          message: terminalEventSeen.message,
        };
      }

      if (terminalEventSeen.type === "transport-cancelled") {
        this.transition("cancelled", () => {
          this.emit({
            type: "orchestrator:run-cancelled",
            runId,
            reason: (terminalEventSeen as any).reason,
          });
        });
        return;
      }

      if (terminalEventSeen.type === "turn-completed") {
        if (terminalEventSeen.stopReason === "max_tokens") {
          throw {
            code: "MAX_TOKENS_REACHED",
            message: "Model generation truncated because max_tokens limit was reached.",
          };
        }

        const startedCalls = assembler.getStartedToolCallIds();

        if (terminalEventSeen.stopReason === "stop") {
          if (startedCalls.length > 0) {
            throw {
              code: "PROTOCOL_ERROR",
              message: 'stopReason "stop" cannot be emitted when tool calls were started.',
            };
          }

          // Complete text turn
          if (this.currentAssistantMessage) {
            if (this.currentAssistantText.length > 0) {
              this.currentAssistantMessage.parts.push({
                type: "text",
                text: this.currentAssistantText,
              });
            }
            this.currentAssistantMessage.status = "complete";
          }

          this.transition("completed", () => {
            this.emit({
              type: "orchestrator:run-completed",
              runId,
              messages: this.getMessages(),
            });
          });
          return;
        }

        if (terminalEventSeen.stopReason === "tool_calls") {
          if (startedCalls.length === 0) {
            throw {
              code: "PROTOCOL_ERROR",
              message: 'stopReason "tool_calls" emitted but zero tool calls were started.',
            };
          }

          // Finalize and validate all assembled calls
          const finalizeResult = assembler.finalizeAll();
          if (!finalizeResult.ok) {
            throw finalizeResult.error;
          }

          if (this.currentAssistantText.length > 0 && this.currentAssistantMessage) {
            this.currentAssistantMessage.parts.push({
              type: "text",
              text: this.currentAssistantText,
            });
          }

          // Submit all tool calls to M3.7 runtime
          this.transition("waiting-for-tools", () => {
            let hasAwaitingApproval = false;
            let awaitingApprovalAttemptId = "";
            let awaitingApprovalToolCallId = "";

            for (const call of finalizeResult.calls) {
              if (this.currentAssistantMessage) {
                this.currentAssistantMessage.parts.push({
                  type: "tool-request",
                  toolCallId: call.toolCallId,
                  name: call.name,
                  args: call.args,
                });
              }

              const { attempt } = this.runtime.submit(
                {
                  toolCallId: call.toolCallId,
                  name: call.name as any,
                  args: call.args,
                  projectId: this.projectId,
                  generation: this.generation,
                },
                { idempotencyKey: `${runId}:${turnId}:${call.toolCallId}` },
              );

              this.currentTurnToolAttempts.set(call.toolCallId, attempt.attemptId);
              if (attempt.state === "awaiting-approval") {
                hasAwaitingApproval = true;
                awaitingApprovalAttemptId = attempt.attemptId;
                awaitingApprovalToolCallId = call.toolCallId;
              }
            }

            this.emit({
              type: "orchestrator:tools-submitted",
              runId,
              turnId,
              toolCallIds: finalizeResult.calls.map((c) => c.toolCallId),
            });

            if (hasAwaitingApproval) {
              this.transition("waiting-for-approval", () => {
                this.emit({
                  type: "orchestrator:waiting-approval",
                  runId,
                  turnId,
                  attemptId: awaitingApprovalAttemptId,
                  toolCallId: awaitingApprovalToolCallId,
                });
              });
            }
          });

          // Check if any tool immediately settled or is awaiting approval
          this.checkToolTurnSettlement();
          return;
        }
      }
    } catch (err: any) {
      if (!this.isActiveState() || this.currentRunId !== runId) {
        return;
      }

      assembler.clear();

      const code: OrchestrationErrorCode = err?.code ?? "TRANSPORT_FAILED";
      const message: string = err?.message ?? "Transport execution threw an unexpected error.";

      if (this.currentAssistantMessage) {
        if (this.currentAssistantText.length > 0) {
          this.currentAssistantMessage.parts.push({
            type: "text",
            text: this.currentAssistantText,
          });
        }
        this.currentAssistantMessage.status = "interrupted";
      }

      this.transition("failed", () => {
        this.emit({
          type: "orchestrator:run-failed",
          runId,
          error: { code, message },
        });
      });
    }
  }

  // -------------------------------------------------------------------------
  // Tool Attempt Settlement & Multi-Turn Continuation
  // -------------------------------------------------------------------------

  private handleRuntimeEvent(event: any): void {
    if (!this.currentRunId || !this.isActiveState()) return;

    if (this.state === "waiting-for-tools" || this.state === "waiting-for-approval") {
      if (event.type === "attempt:awaiting-approval") {
        if (this.currentTurnToolAttempts.get(event.toolCallId) === event.attemptId) {
          this.transition("waiting-for-approval", () => {
            this.emit({
              type: "orchestrator:waiting-approval",
              runId: this.currentRunId!,
              turnId: this.currentTurnId!,
              attemptId: event.attemptId,
              toolCallId: event.toolCallId,
            });
          });
        }
      }

      if (
        event.type === "attempt:succeeded" ||
        event.type === "attempt:failed" ||
        event.type === "attempt:denied" ||
        event.type === "attempt:cancelled" ||
        event.type === "attempt:stale"
      ) {
        const attempt = this.runtime.getAttempt(event.attemptId);
        if (attempt && this.currentTurnToolAttempts.get(attempt.call.toolCallId) === attempt.attemptId) {
          const rawResult = attempt.result ?? {
            ok: false,
            error: {
              code: (attempt.error?.code as any) || "TOOL_ERROR",
              message: attempt.error?.message || "Tool execution was not completed",
            },
          };

          const envelope: CanonicalToolResultEnvelope = {
            toolCallId: attempt.call.toolCallId,
            toolName: attempt.call.name,
            attemptId: attempt.attemptId,
            status: attempt.state as any,
            isError: attempt.state !== "succeeded",
            errorCode: attempt.error?.code,
            modelSafeResult: projectModelFacingResult(attempt.call.name, rawResult),
          };

          this.currentTurnSettledAttempts.set(attempt.call.toolCallId, envelope);
          this.checkToolTurnSettlement();
        }
      }
    }
  }

  private checkToolTurnSettlement(): void {
    if (this.state !== "waiting-for-tools" && this.state !== "waiting-for-approval") return;

    const totalExpected = this.currentTurnToolAttempts.size;
    const settledCount = this.currentTurnSettledAttempts.size;

    if (settledCount === totalExpected && totalExpected > 0) {
      const envelopes = Array.from(this.currentTurnSettledAttempts.values());

      // Append canonical tool-result parts to assistant or as tool message
      const toolMsg: CanonicalAgentMessage = {
        id: this.nextId("msg"),
        role: "tool",
        parts: envelopes.map((env) => ({
          type: "tool-result",
          envelope: env,
        })),
        createdAt: this.now(),
        status: "complete",
      };
      this.conversationMessages.push(toolMsg);

      if (this.currentAssistantMessage) {
        this.currentAssistantMessage.status = "complete";
      }

      this.transition("continuing", () => {
        this.emit({
          type: "orchestrator:tools-resolved",
          runId: this.currentRunId!,
          turnId: this.currentTurnId!,
          envelopes,
        });
      });

      this.scheduleNextLoopStep();
    }
  }

  private async executeContinuingStep(): Promise<void> {
    if (!this.currentRunId || !this.isActiveState()) return;

    this.currentTurnIndex++;
    if (this.currentTurnIndex >= this.maxTurns) {
      this.transition("failed", () => {
        this.emit({
          type: "orchestrator:run-failed",
          runId: this.currentRunId!,
          error: {
            code: "MAX_TURNS_EXCEEDED",
            message: `Orchestrator reached maximum turn limit of ${this.maxTurns} turns.`,
          },
        });
      });
      return;
    }

    this.transition("starting", () => {
      this.emit({
        type: "orchestrator:turn-next",
        runId: this.currentRunId!,
        nextTurnIndex: this.currentTurnIndex,
      });
    });

    this.scheduleNextLoopStep();
  }

  // -------------------------------------------------------------------------
  // Context Building & Deterministic Truncation
  // -------------------------------------------------------------------------

  private buildContextPayload(
    runId: string,
    turnId: string,
  ): { ok: true; request: AgentTransportRequest } | { ok: false; error: OrchestrationError } {
    const systemText = this.systemContext.trim();
    const systemBytes = utf8Encoder.encode(systemText).length;

    if (systemBytes > this.maxContextBytes) {
      return {
        ok: false,
        error: {
          code: "CONTEXT_BUDGET_EXCEEDED",
          message: `Required system context (${systemBytes} bytes) exceeds maximum context budget of ${this.maxContextBytes} bytes.`,
        },
      };
    }

    // Collect all canonical tool definitions
    const toolManifests: CanonicalToolDefinition[] = AGENT_TOOLS.map((t) => ({
      name: t.name,
      category: t.category,
      risk: t.risk,
      summary: t.summary,
      parameters: t.parameters.map((p) => ({
        name: p.name,
        type: p.type,
        required: p.required,
        description: p.description,
      })),
      requiresApproval: t.requiresApproval,
    }));

    // Deterministic message windowing preserving atomic tool groups
    const messages = this.truncateHistoryDeterministically(
      this.conversationMessages,
      this.maxContextBytes - systemBytes,
    );

    const fullMessages: CanonicalAgentMessage[] = [
      {
        id: "sys-0",
        role: "system",
        parts: [{ type: "system-context", text: systemText }],
        createdAt: this.now(),
        status: "complete",
      },
      ...messages,
    ];

    return {
      ok: true,
      request: {
        runId,
        turnId,
        requestId: this.nextId("req"),
        projectId: this.projectId,
        generation: this.generation,
        messages: fullMessages,
        tools: toolManifests,
      },
    };
  }

  private truncateHistoryDeterministically(
    messages: CanonicalAgentMessage[],
    availableBudgetBytes: number,
  ): CanonicalAgentMessage[] {
    if (messages.length === 0) return [];

    // Separate groups into atomic units
    const groups: CanonicalAgentMessage[][] = [];
    let currentGroup: CanonicalAgentMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "user") {
        if (currentGroup.length > 0) groups.push(currentGroup);
        currentGroup = [msg];
      } else if (msg.role === "assistant") {
        currentGroup.push(msg);
      } else if (msg.role === "tool") {
        currentGroup.push(msg);
      }
    }
    if (currentGroup.length > 0) groups.push(currentGroup);

    // Keep newest groups that fit within availableBudgetBytes
    const selectedMessages: CanonicalAgentMessage[] = [];
    let accumulatedBytes = 0;

    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      const groupBytes = group.reduce((sum, m) => sum + utf8Encoder.encode(JSON.stringify(m)).length, 0);

      if (accumulatedBytes + groupBytes <= availableBudgetBytes) {
        selectedMessages.unshift(...group);
        accumulatedBytes += groupBytes;
      } else {
        break;
      }
    }

    // Always ensure at least the very latest user prompt is included
    if (selectedMessages.length === 0 && messages.length > 0) {
      const latest = messages[messages.length - 1];
      selectedMessages.push(latest);
    }

    return selectedMessages;
  }

  // -------------------------------------------------------------------------
  // State Machine Helpers & Terminal Precedence
  // -------------------------------------------------------------------------

  private isActiveState(): boolean {
    return (
      this.state === "starting" ||
      this.state === "streaming" ||
      this.state === "assembling-tool-calls" ||
      this.state === "waiting-for-tools" ||
      this.state === "waiting-for-approval" ||
      this.state === "continuing"
    );
  }

  private transition(nextState: OrchestrationState, sideEffects?: () => void): void {
    if (!this.isActiveState() && nextState !== "starting" && this.state !== "idle") {
      // Terminal states are immutable
      return;
    }

    this.state = nextState;
    if (sideEffects) {
      sideEffects();
    }

    if (!this.isActiveState()) {
      this.cleanupRunResources();
    }
  }

  private cleanupRunResources(): void {
    if (this.cancelTimeout) {
      this.cancelTimeout();
      this.cancelTimeout = null;
    }
    if (this.abortController) {
      this.abortController.abort("Run concluded");
      this.abortController = null;
    }
  }

  private emit(event: OrchestratorLifecycleEvent): void {
    if (this.onEventCb) {
      try {
        this.onEventCb(event);
      } catch (err) {
        console.error("Error in orchestrator event listener:", err);
      }
    }
  }

  dispose(): void {
    this.cleanupRunResources();
    if (this.runtimeUnsubscribe) {
      this.runtimeUnsubscribe();
      this.runtimeUnsubscribe = null;
    }
    this.state = "idle";
    this.currentRunId = null;
  }
}
