/**
 * Agent Tool Execution Runtime for CoderXP M3.7.
 *
 * Provides a deterministic, provider-independent, React-independent lifecycle controller
 * for permission-gated agent tool execution.
 *
 * Core Guarantees:
 * 1. Serial FIFO execution queue with explicit head-of-line blocking.
 * 2. Every execution passes strictly through M3.6 gateAndInvoke().
 * 3. The "running" state is committed from inside the gate's execute callback immediately
 *    before invoking the real tool handler.
 * 4. Terminal state immutability (succeeded, failed, denied, cancelled, stale).
 * 5. Runtime-lifetime idempotency covering active and terminal attempts.
 * 6. Explicit invalidation of unconsumed approvals on cancellation or project switch.
 * 7. Monotonically increasing runtime-global event sequencing and isolated event listeners.
 * 8. Pure 4-tier disclosure sanitization and snapshot freezing.
 */

import {
  gateAndInvoke,
  type AgentPermissionController,
  type AgentToolCall,
} from "./agent-permissions-gate";
import {
  fingerprintArgs,
  summarizeToolCall,
} from "./agent-permissions";
import type { AgentToolResult, AgentToolError } from "./agent-tools";
import {
  deepFreezeSafeSnapshot,
  formatSafeDiagnostic,
  formatUserFacingResultSummary,
  projectModelFacingResult,
  type ModelFacingToolResult,
} from "./agent-sanitizer";

// ---------------------------------------------------------------------------
// Types & Contracts
// ---------------------------------------------------------------------------

export type AgentExecutionState =
  | "queued"
  | "awaiting-approval"
  | "approved"
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled"
  | "stale";

export type AgentRuntimeErrorCode =
  | "UNKNOWN_TOOL"
  | "PERMISSION_DENIED"
  | "USER_DENIED"
  | "STALE_GENERATION"
  | "CANCELLED"
  | "HANDLER_FAILED"
  | "HANDLER_THROWN"
  | "IDEMPOTENCY_CONFLICT";

export type AgentExecutionEventType =
  | "attempt:queued"
  | "attempt:awaiting-approval"
  | "attempt:approved"
  | "attempt:running"
  | "attempt:succeeded"
  | "attempt:failed"
  | "attempt:denied"
  | "attempt:cancelled"
  | "attempt:stale";

export interface AgentExecutionEvent {
  eventId: string;
  attemptId: string;
  toolCallId: string;
  sequence: number;
  type: AgentExecutionEventType;
  timestamp: number;
  projectId: string;
  generation: number;
  data?: Readonly<Record<string, unknown>>;
}

export interface ToolExecutionContext {
  attemptId: string;
  projectId: string;
  generation: number;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface AgentExecutionAttempt {
  attemptId: string;
  idempotencyKey?: string;
  call: AgentToolCall;
  state: AgentExecutionState;
  approvalId?: string;
  error?: { code: AgentRuntimeErrorCode; message: string };
  result?: AgentToolResult<unknown>;
  modelResult?: ModelFacingToolResult;
  userSummary?: string;
  createdAt: number;
  updatedAt: number;
  abortController: AbortController;
}

export interface AgentExecutionRuntimeOptions {
  projectId: string;
  generation: number;
  controller: AgentPermissionController;
  executeTool: (
    name: string,
    params: unknown,
    context: ToolExecutionContext,
  ) => Promise<AgentToolResult<unknown>>;
  now?: () => number;
  generateId?: (prefix: string) => string;
  scheduleDrain?: (fn: () => void) => void;
  logger?: (msg: string) => void;
}

export interface SubmitOptions {
  idempotencyKey?: string;
}

export class StaleOwnershipError extends Error {
  constructor(message = "Stale ownership") {
    super(message);
    this.name = "StaleOwnershipError";
  }
}

export class IdempotencyConflictError extends Error {
  code: AgentRuntimeErrorCode = "IDEMPOTENCY_CONFLICT";
  constructor(message = "Submission has an idempotency key with conflicting arguments.") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

const TERMINAL_STATES = new Set<AgentExecutionState>([
  "succeeded",
  "failed",
  "denied",
  "cancelled",
  "stale",
]);

// ---------------------------------------------------------------------------
// Core Runtime Controller
// ---------------------------------------------------------------------------

export class AgentExecutionRuntime {
  private projectId: string;
  private generation: number;
  private readonly controller: AgentPermissionController;
  private readonly executeTool: (
    name: string,
    params: unknown,
    context: ToolExecutionContext,
  ) => Promise<AgentToolResult<unknown>>;

  private readonly now: () => number;
  private readonly generateId: (prefix: string) => string;
  private readonly scheduleDrain: (fn: () => void) => void;
  private readonly logger: (msg: string) => void;

  private readonly attempts = new Map<string, AgentExecutionAttempt>();
  private readonly idempotencyMap = new Map<string, string>(); // idempotencyKey -> attemptId
  private readonly queue: string[] = []; // FIFO of attemptIds
  private activeHead: string | null = null; // Currently processing attemptId

  private sequence = 0;
  private isDraining = false;
  private isResuming = false;
  private readonly listeners = new Set<(event: AgentExecutionEvent) => void>();

  constructor(options: AgentExecutionRuntimeOptions) {
    this.projectId = options.projectId;
    this.generation = options.generation;
    this.controller = options.controller;
    this.executeTool = options.executeTool;

    this.now = options.now ?? (() => Date.now());
    let idCounter = 0;
    this.generateId =
      options.generateId ?? ((prefix: string) => `${prefix}-${++idCounter}`);
    this.scheduleDrain =
      options.scheduleDrain ?? ((fn: () => void) => queueMicrotask(fn));
    this.logger = options.logger ?? ((_msg: string) => {});
  }

  // -------------------------------------------------------------------------
  // Public Accessors & Listeners
  // -------------------------------------------------------------------------

  getProjectId(): string {
    return this.projectId;
  }

  getGeneration(): number {
    return this.generation;
  }

  getAttempt(attemptId: string): AgentExecutionAttempt | null {
    return this.attempts.get(attemptId) ?? null;
  }

  getActiveHead(): AgentExecutionAttempt | null {
    return this.activeHead ? this.attempts.get(this.activeHead) ?? null : null;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getAllAttempts(): AgentExecutionAttempt[] {
    return Array.from(this.attempts.values()).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }

  onEvent(listener: (event: AgentExecutionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Submission & Queue Management
  // -------------------------------------------------------------------------

  submit(
    call: AgentToolCall,
    options?: SubmitOptions,
  ): { attempt: AgentExecutionAttempt; isNew: boolean } {
    if (call.projectId !== this.projectId) {
      throw new Error(
        `Cannot submit tool call for project ${call.projectId} to runtime owning ${this.projectId}`,
      );
    }

    const idempotencyKey = options?.idempotencyKey;

    // Idempotency check across ALL attempts (active and terminal)
    if (idempotencyKey) {
      const existingAttemptId = this.idempotencyMap.get(idempotencyKey);
      if (existingAttemptId) {
        const existing = this.attempts.get(existingAttemptId);
        if (existing) {
          // Verify canonical match
          const matching =
            existing.call.toolCallId === call.toolCallId &&
            existing.call.name === call.name &&
            existing.call.projectId === call.projectId &&
            fingerprintArgs(existing.call.args) === fingerprintArgs(call.args);

          if (matching) {
            return { attempt: existing, isNew: false };
          } else {
            throw new IdempotencyConflictError(
              `Idempotency key ${idempotencyKey} already associated with a different tool call.`,
            );
          }
        }
      }
    }

    const attemptId = this.generateId("att");
    const attempt: AgentExecutionAttempt = {
      attemptId,
      idempotencyKey,
      call,
      state: "queued",
      createdAt: this.now(),
      updatedAt: this.now(),
      abortController: new AbortController(),
    };

    this.attempts.set(attemptId, attempt);
    if (idempotencyKey) {
      this.idempotencyMap.set(idempotencyKey, attemptId);
    }

    this.queue.push(attemptId);
    this.transition(attempt, "queued", {
      toolName: call.name,
      summary: summarizeToolCall(call.name, call.args),
    });

    this.scheduleNextDrain();
    return { attempt, isNew: true };
  }

  // -------------------------------------------------------------------------
  // Queue Drain & Execution Engine
  // -------------------------------------------------------------------------

  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.isDraining) {
      await this.drainQueue();
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
      if (this.activeHead !== null) {
        const head = this.attempts.get(this.activeHead);
        if (head && head.state === "awaiting-approval") {
          break;
        }
      }
      if (this.queue.length === 0 && !this.isDraining) {
        break;
      }
    }
  }

  private scheduleNextDrain(): void {
    this.scheduleDrain(() => {
      void this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.isDraining) return;
    this.isDraining = true;

    try {
      while (this.queue.length > 0) {
        // Head-of-line blocking: if activeHead is currently awaiting-approval, approved, or running,
        // subsequent queue items MUST wait.
        if (this.activeHead !== null) {
          const currentHead = this.attempts.get(this.activeHead);
          if (
            currentHead &&
            (currentHead.state === "awaiting-approval" ||
              currentHead.state === "approved" ||
              currentHead.state === "running")
          ) {
            return;
          }
          // Active head reached terminal state; clear it
          this.activeHead = null;
        }

        const nextAttemptId = this.queue.shift()!;
        const attempt = this.attempts.get(nextAttemptId);
        if (!attempt) continue;

        // If attempt reached terminal state while queued (e.g. cancelled/stale), skip to next
        if (TERMINAL_STATES.has(attempt.state)) {
          continue;
        }

        this.activeHead = attempt.attemptId;

        // Multi-checkpoint generation fencing before gate call
        if (
          attempt.call.generation !== this.generation ||
          attempt.call.projectId !== this.projectId
        ) {
          this.transition(attempt, "stale", {
            toolName: attempt.call.name,
            message: "Project or generation changed before execution.",
          });
          this.activeHead = null;
          continue;
        }

        await this.runGateAndInvoke(attempt);

        if (this.activeHead !== null) {
          const currentHead = this.attempts.get(this.activeHead);
          if (currentHead && (currentHead.state === "awaiting-approval" || currentHead.state === "running")) {
            break;
          }
        }
      }
    } finally {
      this.isDraining = false;
    }
  }

  private async runGateAndInvoke(attempt: AgentExecutionAttempt): Promise<void> {
    try {
      const outcome = await gateAndInvoke({
        controller: this.controller,
        call: attempt.call,
        generation: this.generation,
        execute: async (name, args) => {
          // Checkpoint inside execute callback:
          if (
            this.activeHead !== attempt.attemptId ||
            this.generation !== attempt.call.generation ||
            attempt.abortController.signal.aborted
          ) {
            throw new StaleOwnershipError("Execution cancelled or generation changed before execute.");
          }

          // 3. Commit running state inside execute callback
          this.transition(attempt, "running", {
            toolName: name,
            summary: summarizeToolCall(name, args),
          });

          const context: ToolExecutionContext = {
            attemptId: attempt.attemptId,
            projectId: attempt.call.projectId,
            generation: attempt.call.generation,
            signal: attempt.abortController.signal,
            isCurrent: () => this.isCurrent(attempt),
          };

          return await this.executeTool(name, args, context);
        },
      });

      // If attempt was cancelled/stale while in-flight, ignore late return
      if (TERMINAL_STATES.has(attempt.state)) {
        this.activeHead = null;
        this.scheduleNextDrain();
        return;
      }

      switch (outcome.kind) {
        case "executed": {
          if (outcome.result.ok) {
            const modelResult = projectModelFacingResult(attempt.call.name, outcome.result);
            const userSummary = formatUserFacingResultSummary(attempt.call.name, outcome.result);
            attempt.result = outcome.result;
            attempt.modelResult = modelResult;
            attempt.userSummary = userSummary;

            this.transition(attempt, "succeeded", {
              toolName: attempt.call.name,
              userSummary,
              modelResult: modelResult.data,
            });
          } else {
            attempt.result = outcome.result;
            attempt.error = {
              code: outcome.result.error.code === "UNKNOWN_TOOL" ? "UNKNOWN_TOOL" : "HANDLER_FAILED",
              message: outcome.result.error.message,
            };
            this.transition(attempt, "failed", {
              toolName: attempt.call.name,
              error: attempt.error,
              errorMessage: outcome.result.error.message,
            });
          }
          this.activeHead = null;
          this.scheduleNextDrain();
          break;
        }

        case "awaiting-approval": {
          attempt.approvalId = outcome.approval.approvalId;
          this.transition(attempt, "awaiting-approval", {
            toolName: attempt.call.name,
            approvalId: outcome.approval.approvalId,
            summary: outcome.approval.summary,
          });
          // Active head remains set to block queue until resolution
          break;
        }

        case "denied": {
          const code: AgentRuntimeErrorCode =
            outcome.reason === "UNKNOWN_TOOL"
              ? "UNKNOWN_TOOL"
              : outcome.reason === "USER_DENIED"
                ? "USER_DENIED"
                : "PERMISSION_DENIED";

          attempt.error = {
            code,
            message: outcome.message || "Permission denied",
          };
          this.transition(attempt, "denied", {
            toolName: attempt.call.name,
            reason: code,
            message: outcome.message,
          });
          this.activeHead = null;
          this.scheduleNextDrain();
          break;
        }

        case "stale": {
          attempt.error = {
            code: "STALE_GENERATION",
            message: outcome.message || "Stale generation",
          };
          this.transition(attempt, "stale", {
            toolName: attempt.call.name,
            message: outcome.message,
          });
          this.activeHead = null;
          this.scheduleNextDrain();
          break;
        }
      }
    } catch (err) {
      if (TERMINAL_STATES.has(attempt.state)) {
        this.activeHead = null;
        this.scheduleNextDrain();
        return;
      }

      if (err instanceof StaleOwnershipError) {
        attempt.error = { code: "STALE_GENERATION", message: err.message };
        this.transition(attempt, "stale", {
          toolName: attempt.call.name,
          message: err.message,
        });
      } else {
        attempt.error = {
          code: "HANDLER_THROWN",
          message: formatSafeDiagnostic(err),
        };
        this.transition(attempt, "failed", {
          toolName: attempt.call.name,
          error: attempt.error,
          errorMessage: attempt.error.message,
        });
      }
      this.activeHead = null;
      this.scheduleNextDrain();
    }
  }

  // -------------------------------------------------------------------------
  // User Resolution (Approve / Deny / Resume)
  // -------------------------------------------------------------------------

  /**
   * Resumes an attempt that is currently awaiting approval.
   *
   * The user action in the UI records authorization in the controller first.
   * Then resume() transitions the attempt to "approved" and calls gateAndInvoke()
   * which consumes the authorization atomically.
   */
  async resume(attemptId: string): Promise<boolean> {
    if (this.isResuming) return false;
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state !== "awaiting-approval") {
      return false;
    }

    if (this.activeHead !== attempt.attemptId) {
      return false;
    }

    if (attempt.call.generation !== this.generation) {
      this.transition(attempt, "stale", {
        toolName: attempt.call.name,
        message: "Generation changed before resume.",
      });
      this.activeHead = null;
      this.scheduleNextDrain();
      return false;
    }

    this.isResuming = true;
    try {
      this.transition(attempt, "approved", {
        toolName: attempt.call.name,
        approvalId: attempt.approvalId,
      });

      await this.runGateAndInvoke(attempt);
      return true;
    } finally {
      this.isResuming = false;
    }
  }

  deny(attemptId: string): boolean {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state !== "awaiting-approval") {
      return false;
    }

    if (attempt.approvalId) {
      this.controller.deny(attempt.approvalId, this.generation);
    }

    attempt.error = { code: "USER_DENIED", message: "User denied action." };
    this.transition(attempt, "denied", {
      toolName: attempt.call.name,
      reason: "USER_DENIED",
      message: "User denied action.",
    });

    if (this.activeHead === attempt.attemptId) {
      this.activeHead = null;
    }
    this.scheduleNextDrain();
    return true;
  }

  // -------------------------------------------------------------------------
  // Cancellation & Generation Invalidation
  // -------------------------------------------------------------------------

  cancel(attemptId: string, reason = "Action cancelled"): boolean {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || TERMINAL_STATES.has(attempt.state)) {
      return false;
    }

    // Invalidate unconsumed approval if present
    if (attempt.approvalId) {
      this.controller.invalidateApproval(attempt.approvalId, {
        projectId: attempt.call.projectId,
        generation: attempt.call.generation,
        toolCallId: attempt.call.toolCallId,
        argsFingerprint: fingerprintArgs(attempt.call.args),
      });
    }

    // Signal abort to cooperative handlers
    attempt.abortController.abort();

    this.transition(attempt, "cancelled", {
      toolName: attempt.call.name,
      reason,
    });

    // Remove from queue if still queued
    const qIdx = this.queue.indexOf(attemptId);
    if (qIdx >= 0) {
      this.queue.splice(qIdx, 1);
    }

    if (this.activeHead === attempt.attemptId) {
      this.activeHead = null;
    }

    this.scheduleNextDrain();
    return true;
  }

  cancelAll(reason = "Workspace cancelled"): number {
    let count = 0;
    for (const attempt of this.attempts.values()) {
      if (!TERMINAL_STATES.has(attempt.state)) {
        this.cancel(attempt.attemptId, reason);
        count++;
      }
    }
    return count;
  }

  invalidateGeneration(newGeneration?: number): void {
    const oldGeneration = this.generation;
    this.generation = newGeneration !== undefined ? newGeneration : this.generation + 1;

    // Drop all queued and active items from old generation
    for (const attempt of this.attempts.values()) {
      if (!TERMINAL_STATES.has(attempt.state)) {
        if (attempt.approvalId) {
          this.controller.invalidateApproval(attempt.approvalId, {
            projectId: attempt.call.projectId,
            generation: oldGeneration,
          });
        }
        attempt.abortController.abort();
        this.transition(attempt, "stale", {
          toolName: attempt.call.name,
          message: "Project generation changed.",
        });
      }
    }

    this.queue.length = 0;
    this.activeHead = null;
  }

  // -------------------------------------------------------------------------
  // State Transition & Event Emission
  // -------------------------------------------------------------------------

  private transition(
    attempt: AgentExecutionAttempt,
    nextState: AgentExecutionState,
    data?: Record<string, unknown>,
  ): void {
    if (TERMINAL_STATES.has(attempt.state)) {
      // Terminal state immutability invariant
      return;
    }

    attempt.state = nextState;
    attempt.updatedAt = this.now();

    this.sequence += 1;
    const event: AgentExecutionEvent = {
      eventId: this.generateId(`evt-${this.sequence}`),
      attemptId: attempt.attemptId,
      toolCallId: attempt.call.toolCallId,
      sequence: this.sequence,
      type: `attempt:${nextState}` as AgentExecutionEventType,
      timestamp: this.now(),
      projectId: this.projectId,
      generation: this.generation,
      data: data ? deepFreezeSafeSnapshot(data) : undefined,
    };

    // Emit event with listener isolation
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger(`Listener error on ${event.type}: ${formatSafeDiagnostic(err)}`);
      }
    }
  }

  private isCurrent(attempt: AgentExecutionAttempt): boolean {
    return (
      !attempt.abortController.signal.aborted &&
      this.activeHead === attempt.attemptId &&
      attempt.call.generation === this.generation &&
      attempt.call.projectId === this.projectId
    );
  }
}
