/**
 * Authoritative Transcript Ingestion Dispatcher & Projector for CoderXP M3.8.
 *
 * Translates multi-domain lifecycle events (orchestrator, transport, M3.7 runtime, process stream)
 * into immutable AgentBlock[] arrays with deterministic sequence numbers and replay deduplication.
 *
 * Zero DOM, zero React, pure projection logic.
 */

import type { AgentBlock } from "./agent-protocol";
import type { AgentExecutionEvent } from "./agent-execution-runtime";
import type { ProcessStreamEvent } from "./agent-process-stream";
import { formatUserFacingResultSummary } from "./agent-sanitizer";

/**
 * Upserts a block into the block list by its stable ID.
 */
function upsertBlock(blocks: readonly AgentBlock[], block: AgentBlock): AgentBlock[] {
  const next = [...blocks];
  const idx = next.findIndex((b) => b.id === block.id);
  if (idx >= 0) {
    next[idx] = block;
  } else {
    next.push(block);
  }
  return next;
}

/**
 * Pure projection function that translates M3.7 execution events into AgentBlocks.
 */
export function projectEventToTranscriptBlocks(
  blocks: readonly AgentBlock[],
  event: AgentExecutionEvent,
): AgentBlock[] {
  const { type, toolCallId, attemptId, data } = event;
  const toolName = (data?.toolName as string) || "tool";

  switch (type) {
    case "attempt:running": {
      const toolCallBlock: AgentBlock = {
        id: `tc-${toolCallId}`,
        kind: "tool-call",
        toolCallId,
        name: toolName,
        input: typeof data?.summary === "string" ? data.summary : `Run ${toolName}`,
      };
      return upsertBlock(blocks, toolCallBlock);
    }

    case "attempt:awaiting-approval": {
      const approvalId = (data?.approvalId as string) || attemptId;
      const summary = (data?.summary as string) || `Approval required for ${toolName}`;
      const approvalBlock: AgentBlock = {
        id: `appr-${approvalId}`,
        kind: "approval-requested",
        approvalId,
        summary,
      };
      return upsertBlock(blocks, approvalBlock);
    }

    case "attempt:succeeded": {
      const summary =
        typeof data?.userSummary === "string"
          ? data.userSummary
          : data?.result
            ? formatUserFacingResultSummary(toolName, data.result as any)
            : `Completed ${toolName}`;
      const resultBlock: AgentBlock = {
        id: `res-${toolCallId}`,
        kind: "tool-result",
        toolCallId,
        output: summary,
        isError: false,
      };
      return upsertBlock(blocks, resultBlock);
    }

    case "attempt:failed": {
      const errorMsg =
        typeof data?.errorMessage === "string"
          ? data.errorMessage
          : typeof data?.error === "object" && data?.error !== null
            ? (data.error as any).message || "Tool execution failed"
            : "Tool execution failed";
      const resultBlock: AgentBlock = {
        id: `res-${toolCallId}`,
        kind: "tool-result",
        toolCallId,
        output: `Failed: ${errorMsg}`,
        isError: true,
      };
      return upsertBlock(blocks, resultBlock);
    }

    case "attempt:denied": {
      const reasonMsg =
        typeof data?.message === "string"
          ? data.message
          : "Action denied. It was not performed.";
      const resultBlock: AgentBlock = {
        id: `res-${toolCallId}`,
        kind: "tool-result",
        toolCallId,
        output: reasonMsg,
        isError: true,
      };
      return upsertBlock(blocks, resultBlock);
    }

    case "attempt:cancelled": {
      const cancelBlock: AgentBlock = {
        id: `canc-${attemptId}`,
        kind: "cancellation",
        reason: typeof data?.reason === "string" ? data.reason : "Action cancelled.",
      };
      return upsertBlock(blocks, cancelBlock);
    }

    case "attempt:stale": {
      const staleBlock: AgentBlock = {
        id: `stale-${attemptId}`,
        kind: "cancellation",
        reason:
          typeof data?.message === "string"
            ? data.message
            : "Action cancelled because project changed.",
      };
      return upsertBlock(blocks, staleBlock);
    }

    case "attempt:queued":
    case "attempt:approved":
    default:
      return [...blocks];
  }
}

/**
 * Projects a process stream event into transcript blocks.
 */
export function projectProcessEventToTranscriptBlocks(
  blocks: readonly AgentBlock[],
  event: ProcessStreamEvent,
): AgentBlock[] {
  switch (event.type) {
    case "process:started": {
      const block: AgentBlock = {
        id: `start-${event.processId}`,
        kind: "command-started",
        commandId: event.processId,
        command: event.data.command ?? "command",
      };
      return upsertBlock(blocks, block);
    }

    case "process:output": {
      const block: AgentBlock = {
        id: `out-${event.processId}-${blocks.length}`,
        kind: "command-output",
        commandId: event.processId,
        chunk: event.data.chunk ?? "",
        stream: "stdout",
      };
      return upsertBlock(blocks, block);
    }

    case "process:completed": {
      const block: AgentBlock = {
        id: `done-${event.processId}`,
        kind: "command-completed",
        commandId: event.processId,
        exitCode: event.data.exitCode ?? 0,
      };
      return upsertBlock(blocks, block);
    }

    default:
      return [...blocks];
  }
}

/**
 * Authoritative multi-domain transcript ingestion dispatcher.
 * Manages deterministic monotonic sequencing and replay deduplication.
 */
export class TranscriptIngestionDispatcher {
  private blocks: AgentBlock[] = [];
  private acceptedEventIds = new Set<string>();
  private projectionSequence = 0;

  getBlocks(): AgentBlock[] {
    return [...this.blocks];
  }

  getProjectionSequence(): number {
    return this.projectionSequence;
  }

  ingestExecutionEvent(event: AgentExecutionEvent): { accepted: boolean; sequence: number } {
    const eventKey = `exec:${event.attemptId}:${event.type}:${event.sequence}`;
    if (this.acceptedEventIds.has(eventKey)) {
      return { accepted: false, sequence: this.projectionSequence };
    }

    this.acceptedEventIds.add(eventKey);
    this.projectionSequence++;
    this.blocks = projectEventToTranscriptBlocks(this.blocks, event);
    return { accepted: true, sequence: this.projectionSequence };
  }

  ingestProcessEvent(event: ProcessStreamEvent): { accepted: boolean; sequence: number } {
    const eventKey = `proc:${event.processId}:${event.type}:${event.sequence}`;
    if (this.acceptedEventIds.has(eventKey)) {
      return { accepted: false, sequence: this.projectionSequence };
    }

    this.acceptedEventIds.add(eventKey);
    this.projectionSequence++;
    this.blocks = projectProcessEventToTranscriptBlocks(this.blocks, event);
    return { accepted: true, sequence: this.projectionSequence };
  }

  clear(): void {
    this.blocks = [];
    this.acceptedEventIds.clear();
    this.projectionSequence = 0;
  }
}
