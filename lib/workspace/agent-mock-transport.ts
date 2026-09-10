/**
 * Deterministic Mock & Scripted Transports for CoderXP M3.8.
 *
 * Provides scripted and loopback transports for deterministic verification of
 * multi-turn agent orchestration, streaming grammar, fragmented tool calls,
 * and error conditions.
 *
 * Invariants:
 * - Emits strictly monotonic event sequences per turn.
 * - NEVER executes tools directly; never manufactures fake tool results.
 * - All tool execution passes authentically through AgentExecutionRuntime.
 */

import type {
  AgentTransport,
  AgentTransportEvent,
  AgentTransportRequest,
} from "./agent-transport-types";

export interface ScriptedTurn {
  events: Array<
    | { type: "text-delta"; text: string }
    | { type: "tool-call-started"; toolCallId: string; toolName: string }
    | { type: "tool-call-arguments-delta"; toolCallId: string; chunk: string }
    | { type: "tool-call-completed"; toolCallId: string }
    | { type: "usage"; inputTokens: number; outputTokens: number }
    | { type: "turn-completed"; stopReason: "stop" | "tool_calls" | "max_tokens" }
    | { type: "transport-error"; code: string; message: string }
    | { type: "transport-cancelled"; reason: string }
  >;
  /** Optional delay per event (ms) for timer tests */
  delayMs?: number;
  /** Optional callback to run during the stream */
  beforeYield?: (index: number) => Promise<void> | void;
}

export class MockAgentTransport implements AgentTransport {
  private turnScripts: ScriptedTurn[] = [];
  private turnIndex = 0;
  private eventIdCounter = 0;

  constructor(turns: ScriptedTurn[] = []) {
    this.turnScripts = [...turns];
  }

  addTurn(script: ScriptedTurn): this {
    this.turnScripts.push(script);
    return this;
  }

  async *send(
    request: AgentTransportRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentTransportEvent> {
    const script = this.turnScripts[this.turnIndex];
    this.turnIndex++;

    let sequence = 1;

    const turnStartedEvent: AgentTransportEvent = {
      type: "turn-started",
      eventId: `evt-${++this.eventIdCounter}`,
      sequence: sequence++,
      requestId: request.requestId,
      turnId: request.turnId,
      timestamp: Date.now(),
    };

    if (signal.aborted) {
      yield {
        type: "transport-cancelled",
        eventId: `evt-${++this.eventIdCounter}`,
        sequence: sequence++,
        requestId: request.requestId,
        turnId: request.turnId,
        reason: signal.reason ? String(signal.reason) : "Aborted before start",
      };
      return;
    }

    yield turnStartedEvent;

    if (!script) {
      // Default: clean text completion
      yield {
        type: "text-delta",
        eventId: `evt-${++this.eventIdCounter}`,
        sequence: sequence++,
        requestId: request.requestId,
        turnId: request.turnId,
        text: "I am finished.",
      };
      yield {
        type: "turn-completed",
        eventId: `evt-${++this.eventIdCounter}`,
        sequence: sequence++,
        requestId: request.requestId,
        turnId: request.turnId,
        stopReason: "stop",
      };
      return;
    }

    for (let i = 0; i < script.events.length; i++) {
      if (signal.aborted) {
        yield {
          type: "transport-cancelled",
          eventId: `evt-${++this.eventIdCounter}`,
          sequence: sequence++,
          requestId: request.requestId,
          turnId: request.turnId,
          reason: signal.reason ? String(signal.reason) : "Aborted mid-stream",
        };
        return;
      }

      if (script.beforeYield) {
        await script.beforeYield(i);
      }

      if (script.delayMs && script.delayMs > 0) {
        await new Promise((r) => setTimeout(r, script.delayMs));
      }

      const item = script.events[i];
      const eventId = `evt-${++this.eventIdCounter}`;
      const seq = sequence++;

      switch (item.type) {
        case "text-delta":
          yield {
            type: "text-delta",
            eventId,
            sequence: seq,
            requestId: request.requestId,
            turnId: request.turnId,
            text: item.text,
          };
          break;
        case "tool-call-started":
          yield {
            type: "tool-call-started",
            eventId,
            sequence: seq,
            requestId: request.requestId,
            turnId: request.turnId,
            toolCallId: item.toolCallId,
            toolName: item.toolName,
          };
          break;
        case "tool-call-arguments-delta":
          yield {
            type: "tool-call-arguments-delta",
            eventId,
            sequence: seq,
            requestId: request.requestId,
            turnId: request.turnId,
            toolCallId: item.toolCallId,
            chunk: item.chunk,
          };
          break;
        case "tool-call-completed":
          yield {
            type: "tool-call-completed",
            eventId,
            sequence: seq,
            requestId: request.requestId,
            turnId: request.turnId,
            toolCallId: item.toolCallId,
          };
          break;
        case "usage":
          yield {
            type: "usage",
            eventId,
            sequence: seq,
            requestId: request.requestId,
            turnId: request.turnId,
            inputTokens: item.inputTokens,
            outputTokens: item.outputTokens,
          };
          break;
        case "turn-completed":
          yield {
            type: "turn-completed",
            eventId,
            sequence: seq,
            requestId: request.requestId,
            turnId: request.turnId,
            stopReason: item.stopReason,
          };
          break;
        case "transport-error":
          yield {
            type: "transport-error",
            eventId,
            sequence: seq,
            requestId: request.requestId,
            turnId: request.turnId,
            code: item.code,
            message: item.message,
          };
          break;
        case "transport-cancelled":
          yield {
            type: "transport-cancelled",
            eventId,
            sequence: seq,
            requestId: request.requestId,
            turnId: request.turnId,
            reason: item.reason,
          };
          break;
      }
    }
  }
}
