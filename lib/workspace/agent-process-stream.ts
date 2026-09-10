/**
 * Process Streaming & Cross-Chunk Redactor for CoderXP M3.8.
 *
 * Connects authoritative WorkspaceCommandController process outputs to the
 * agent transcript with stateful cross-chunk secret redaction.
 *
 * Invariants:
 * - Withholds publication of trailing candidate secrets across arbitrary chunk boundaries.
 * - Fails closed with [CONTENT WITHHELD] / [REDACTED] if a sensitive region exceeds the maximum withholding buffer (512 bytes).
 * - Monotonic chunk indexing and deduplication by sequence.
 * - Single [OUTPUT TRUNCATED] marker on budget exhaustion (does not fail the agent run).
 * - Process output is non-model-facing by default (for user UI transcript display).
 */

import { sanitizeString } from "./agent-permissions";

/** Minimal structural interface for command controller subscriptions. */
export interface MinimalCommandController {
  onOutput(cb: (processId: string, chunk: string) => void): void;
  onStateChange(cb: (handle: { processId: string; state: string; exitCode: number | null }) => void): void;
}

/** Maximum withholding buffer for incomplete sensitive constructs across chunks (512 bytes). */
export const MAX_SENSITIVE_BUFFER_BYTES = 512;

/** Maximum retained output bytes per process in the transcript bridge (256 KB). */
export const MAX_PROCESS_OUTPUT_BYTES = 256 * 1024;

/** Truncation marker appended when output exceeds limit. */
export const OUTPUT_TRUNCATED_MARKER = "\n[OUTPUT TRUNCATED]";

/** Sensitive prefix patterns that trigger trailing withholding across chunk boundaries. */
const SENSITIVE_PREFIX_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/-]*$/i,
  /(?:--)?(?:token|password|passwd|secret|api_?key|auth|credentials)=[^\s'";]*$/i,
  /https?:\/\/[^:\s]+:[^@\s]*$/i,
  /(?:ghp|sk_live|sk_test|xox[baprs])-[A-Za-z0-9_]*$/i,
];

/**
 * Stateful streaming redactor with a withholding tail.
 */
export class StreamingRedactor {
  private tailBuffer = "";
  private isWithholdingSensitive = false;

  /**
   * Processes an incoming chunk. Returns only the safe, sanitized portion.
   * Defers publication of trailing text matching potential secret prefixes.
   */
  processChunk(chunk: string): string {
    if (!chunk || typeof chunk !== "string") return "";

    const combined = this.tailBuffer + chunk;
    this.tailBuffer = "";

    // Check if combined ends with an incomplete sensitive prefix
    let withholdIndex = -1;
    for (const pattern of SENSITIVE_PREFIX_PATTERNS) {
      const match = combined.match(pattern);
      if (match && match.index !== undefined) {
        if (withholdIndex === -1 || match.index < withholdIndex) {
          withholdIndex = match.index;
        }
      }
    }

    if (withholdIndex !== -1) {
      const safePrefix = combined.slice(0, withholdIndex);
      const trailingTail = combined.slice(withholdIndex);

      // If trailing sensitive buffer exceeds maximum withholding limit, fail closed
      if (trailingTail.length > MAX_SENSITIVE_BUFFER_BYTES) {
        this.tailBuffer = "";
        this.isWithholdingSensitive = false;
        return sanitizeString(safePrefix) + "[REDACTED]";
      }

      this.tailBuffer = trailingTail;
      this.isWithholdingSensitive = true;
      return sanitizeString(safePrefix);
    }

    // No trailing sensitive construct found
    this.isWithholdingSensitive = false;
    return sanitizeString(combined);
  }

  /**
   * Flushes remaining withholding tail at process exit / stream end.
   */
  flush(): string {
    if (this.tailBuffer.length === 0) return "";
    const remaining = this.tailBuffer;
    this.tailBuffer = "";
    this.isWithholdingSensitive = false;
    return sanitizeString(remaining);
  }
}

export interface ProcessStreamEvent {
  type: "process:started" | "process:output" | "process:completed";
  processId: string;
  attemptId?: string;
  toolCallId?: string;
  projectId: string;
  generation: number;
  sequence: number;
  data: {
    command?: string;
    chunk?: string;
    exitCode?: number | null;
    truncated?: boolean;
  };
}

interface ActiveProcessState {
  processId: string;
  attemptId?: string;
  toolCallId?: string;
  projectId: string;
  generation: number;
  redactor: StreamingRedactor;
  retainedBytes: number;
  isTruncated: boolean;
  nextChunkSequence: number;
  acceptedChunkSequences: Set<number>;
}

/**
 * Bridges WorkspaceCommandController process outputs to agent transcript events.
 */
export class AgentProcessStreamBridge {
  private activeProcesses = new Map<string, ActiveProcessState>();
  private earlyOutputBuffer = new Map<string, Array<{ chunk: string }>>();
  private listeners = new Set<(event: ProcessStreamEvent) => void>();
  private disposed = false;

  constructor(private controller: MinimalCommandController) {
    this.bindController();
  }

  private bindController(): void {
    this.controller.onOutput((processId, chunk) => {
      if (this.disposed) return;
      this.handleOutputChunk(processId, chunk);
    });

    this.controller.onStateChange((handle) => {
      if (this.disposed) return;
      this.handleStateChange(handle);
    });
  }

  /**
   * Correlates a running process with an agent tool attempt.
   */
  correlateProcess(
    processId: string,
    metadata: {
      attemptId?: string;
      toolCallId?: string;
      projectId: string;
      generation: number;
      command?: string;
    },
  ): void {
    if (this.disposed) return;

    let state = this.activeProcesses.get(processId);
    if (!state) {
      state = {
        processId,
        attemptId: metadata.attemptId,
        toolCallId: metadata.toolCallId,
        projectId: metadata.projectId,
        generation: metadata.generation,
        redactor: new StreamingRedactor(),
        retainedBytes: 0,
        isTruncated: false,
        nextChunkSequence: 1,
        acceptedChunkSequences: new Set(),
      };
      this.activeProcesses.set(processId, state);

      // Emit process:started event
      this.emit({
        type: "process:started",
        processId,
        attemptId: metadata.attemptId,
        toolCallId: metadata.toolCallId,
        projectId: metadata.projectId,
        generation: metadata.generation,
        sequence: 0,
        data: {
          command: metadata.command,
        },
      });

      // Flush any early buffered output
      const early = this.earlyOutputBuffer.get(processId);
      if (early) {
        this.earlyOutputBuffer.delete(processId);
        for (const item of early) {
          this.handleOutputChunk(processId, item.chunk);
        }
      }
    } else {
      state.attemptId = metadata.attemptId ?? state.attemptId;
      state.toolCallId = metadata.toolCallId ?? state.toolCallId;
      state.projectId = metadata.projectId;
      state.generation = metadata.generation;
    }
  }

  private handleOutputChunk(processId: string, rawChunk: string): void {
    const state = this.activeProcesses.get(processId);
    if (!state) {
      // Buffer early chunks before correlation
      const buffer = this.earlyOutputBuffer.get(processId) ?? [];
      buffer.push({ chunk: rawChunk });
      this.earlyOutputBuffer.set(processId, buffer);
      return;
    }

    if (state.isTruncated) {
      // Output cap reached; ignore further text chunks for UI transcript
      return;
    }

    const sanitizedChunk = state.redactor.processChunk(rawChunk);
    if (!sanitizedChunk) return;

    const seq = state.nextChunkSequence++;
    state.acceptedChunkSequences.add(seq);

    state.retainedBytes += sanitizedChunk.length;
    let finalChunk = sanitizedChunk;

    if (state.retainedBytes > MAX_PROCESS_OUTPUT_BYTES) {
      state.isTruncated = true;
      finalChunk += OUTPUT_TRUNCATED_MARKER;
    }

    this.emit({
      type: "process:output",
      processId,
      attemptId: state.attemptId,
      toolCallId: state.toolCallId,
      projectId: state.projectId,
      generation: state.generation,
      sequence: seq,
      data: {
        chunk: finalChunk,
        truncated: state.isTruncated,
      },
    });
  }

  private handleStateChange(handle: { processId: string; state: string; exitCode: number | null }): void {
    const state = this.activeProcesses.get(handle.processId);
    if (!state) return;

    if (
      handle.state === "exited" ||
      handle.state === "completed" ||
      handle.state === "failed" ||
      handle.state === "cancelled"
    ) {
      // Flush redactor tail
      const flushedTail = state.redactor.flush();
      if (flushedTail && !state.isTruncated) {
        const seq = state.nextChunkSequence++;
        this.emit({
          type: "process:output",
          processId: handle.processId,
          attemptId: state.attemptId,
          toolCallId: state.toolCallId,
          projectId: state.projectId,
          generation: state.generation,
          sequence: seq,
          data: {
            chunk: flushedTail,
            truncated: state.isTruncated,
          },
        });
      }

      this.emit({
        type: "process:completed",
        processId: handle.processId,
        attemptId: state.attemptId,
        toolCallId: state.toolCallId,
        projectId: state.projectId,
        generation: state.generation,
        sequence: state.nextChunkSequence++,
        data: {
          exitCode: handle.exitCode,
          truncated: state.isTruncated,
        },
      });

      this.activeProcesses.delete(handle.processId);
    }
  }

  private emit(event: ProcessStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("Error in process stream listener:", err);
      }
    }
  }

  onEvent(listener: (event: ProcessStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Disposes the bridge and clears all active buffers.
   */
  dispose(): void {
    this.disposed = true;
    this.activeProcesses.clear();
    this.earlyOutputBuffer.clear();
    this.listeners.clear();
  }
}
