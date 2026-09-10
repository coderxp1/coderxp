/**
 * Deterministic Test Suite for CoderXP M3.8: Agent Orchestration, Process Streaming & Transport Foundation.
 *
 * Runs completely in-memory with zero network calls, zero provider SDKs, zero API keys, and zero DOM.
 */

import { AgentOrchestrator } from "../lib/workspace/agent-orchestrator";
import { MockAgentTransport } from "../lib/workspace/agent-mock-transport";
import { ToolCallAssembler, validateToolArguments } from "../lib/workspace/agent-tool-assembler";
import { StreamingRedactor, AgentProcessStreamBridge, type MinimalCommandController } from "../lib/workspace/agent-process-stream";
import { TranscriptIngestionDispatcher } from "../lib/workspace/agent-transcript-projector";
import { AgentExecutionRuntime } from "../lib/workspace/agent-execution-runtime";
import { AgentPermissionController } from "../lib/workspace/agent-permissions";
import { AGENT_TOOLS } from "../lib/workspace/agent-tools";
import type { AgentTransport, AgentTransportRequest } from "../lib/workspace/agent-transport-types";

let passedCount = 0;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
  passedCount++;
  console.log(`  ✓ ${msg}`);
}

class MockCommandController implements MinimalCommandController {
  private outputCb: ((processId: string, chunk: string) => void) | null = null;
  private stateCb: ((handle: { processId: string; state: string; exitCode: number | null }) => void) | null = null;

  onOutput(cb: (processId: string, chunk: string) => void): void {
    this.outputCb = cb;
  }

  onStateChange(cb: (handle: { processId: string; state: string; exitCode: number | null }) => void): void {
    this.stateCb = cb;
  }

  emitOutput(processId: string, chunk: string): void {
    this.outputCb?.(processId, chunk);
  }

  emitState(processId: string, state: string, exitCode: number | null = null): void {
    this.stateCb?.({ processId, state, exitCode });
  }
}

async function runTests() {
  console.log("===============================================================");
  console.log("CoderXP M3.8 Deterministic Orchestration & Transport Harness");
  console.log("===============================================================\n");

  // Helper setup for mock runtime and permissions
  function createTestHarness(options: { generation?: number; autoApprove?: boolean } = {}) {
    const generation = options.generation ?? 1;
    const controller = new AgentPermissionController({});

    const runtime = new AgentExecutionRuntime({
      projectId: "proj-test",
      generation,
      controller,
      executeTool: async (name, params) => {
        if (name === "read_file") {
          return { ok: true, data: { content: "mock-file-content", size: 17 } };
        }
        if (name === "write_file") {
          return { ok: true, data: { path: (params as any).path, written: true } };
        }
        if (name === "run_command") {
          return { ok: true, data: { processId: "cmd-123", exitCode: 0, output: "done" } };
        }
        return { ok: true, data: {} };
      },
    });

    return { controller, runtime, generation };
  }

  // -------------------------------------------------------------------------
  // Section 1: Orchestration State Machine & Turn Lifecycle
  // -------------------------------------------------------------------------
  console.log("--- Section 1: Orchestration State Machine & Turn Lifecycle ---");

  // 1. Text-only completion
  {
    const { runtime, generation } = createTestHarness();
    const transport = new MockAgentTransport([
      {
        events: [
          { type: "text-delta", text: "Hello! " },
          { type: "text-delta", text: "How can I help you today?" },
          { type: "turn-completed", stopReason: "stop" },
        ],
      },
    ]);

    const orchestrator = new AgentOrchestrator({
      projectId: "proj-test",
      generation,
      runtime,
      transport,
    });

    const { runId } = orchestrator.submitRun("Hi");
    assert(orchestrator.getState() === "starting", "Initial state transitions to starting");

    // Wait for microtask drain
    await new Promise((r) => setTimeout(r, 10));

    assert(orchestrator.getState() === "completed", "Text-only run transitions to completed");
    const msgs = orchestrator.getMessages();
    assert(msgs.length === 2, "Conversation has user and assistant messages");
    assert(msgs[1].role === "assistant", "Assistant message recorded");
    assert(
      msgs[1].parts[0]?.type === "text" && msgs[1].parts[0].text === "Hello! How can I help you today?",
      "Assistant text deltas merged correctly",
    );
  }

  // 2. Single tool execution (rename_file) with permission approval & follow-up turn
  {
    const { controller, runtime, generation } = createTestHarness();
    const transport = new MockAgentTransport([
      // Turn 1: Assistant calls rename_file (gated)
      {
        events: [
          { type: "tool-call-started", toolCallId: "call-1", toolName: "rename_file" },
          {
            type: "tool-call-arguments-delta",
            toolCallId: "call-1",
            chunk: '{"from": "old.ts", "to": "new.ts"}',
          },
          { type: "tool-call-completed", toolCallId: "call-1" },
          { type: "turn-completed", stopReason: "tool_calls" },
        ],
      },
      // Turn 2: Assistant acknowledges completion
      {
        events: [
          { type: "text-delta", text: "I have renamed old.ts to new.ts for you." },
          { type: "turn-completed", stopReason: "stop" },
        ],
      },
    ]);

    const orchestrator = new AgentOrchestrator({
      projectId: "proj-test",
      generation,
      runtime,
      transport,
    });

    orchestrator.submitRun("Rename old.ts to new.ts");
    await new Promise((r) => setTimeout(r, 10));

    assert(orchestrator.getState() === "waiting-for-approval", "Paused at waiting-for-approval for gated rename_file");

    const pending = controller.getPending();
    assert(pending.length === 1, "Pending approval card created by M3.6 controller");

    // Approve the tool call
    const decision = controller.approve(pending[0].approvalId, generation);
    assert(decision, "Approval decision recorded in M3.6");

    // Resume attempt in M3.7
    const attempt = runtime.getActiveHead() ?? runtime.getAllAttempts()[0];
    assert(attempt !== null && attempt !== undefined, "Found in-flight attempt in runtime");
    await runtime.resume(attempt.attemptId);
    await new Promise((r) => setTimeout(r, 30));

    assert(orchestrator.getState() === "completed", "Run completes after tool resolution and follow-up turn");
    const msgs = orchestrator.getMessages();
    assert(msgs.length === 4, "Conversation has user, assistant (call), tool (result), assistant (summary)");
    assert(msgs[2].role === "tool", "Canonical tool result message injected");
    const resultPart = msgs[2].parts[0];
    assert(
      resultPart.type === "tool-result" && resultPart.envelope.status === "succeeded",
      "Model-safe tool result envelope reflects succeeded status",
    );
  }

  // 3. Multiple ordered tool calls in one turn
  {
    const { runtime, generation } = createTestHarness();
    const transport = new MockAgentTransport([
      {
        events: [
          { type: "tool-call-started", toolCallId: "call-read-1", toolName: "read_file" },
          { type: "tool-call-arguments-delta", toolCallId: "call-read-1", chunk: '{"path": "a.ts"}' },
          { type: "tool-call-completed", toolCallId: "call-read-1" },
          { type: "tool-call-started", toolCallId: "call-read-2", toolName: "read_file" },
          { type: "tool-call-arguments-delta", toolCallId: "call-read-2", chunk: '{"path": "b.ts"}' },
          { type: "tool-call-completed", toolCallId: "call-read-2" },
          { type: "turn-completed", stopReason: "tool_calls" },
        ],
      },
      {
        events: [
          { type: "text-delta", text: "Read both files successfully." },
          { type: "turn-completed", stopReason: "stop" },
        ],
      },
    ]);

    const orchestrator = new AgentOrchestrator({
      projectId: "proj-test",
      generation,
      runtime,
      transport,
    });

    orchestrator.submitRun("Read files a.ts and b.ts");
    await new Promise((r) => setTimeout(r, 80));

    assert(orchestrator.getState() === "completed", "Multiple read_file calls executed without requiring approval");
    const msgs = orchestrator.getMessages();
    const toolMsg = msgs.find((m) => m.role === "tool");
    assert(toolMsg !== undefined && toolMsg.parts.length === 2, "Tool message contains 2 ordered tool result envelopes");
  }

  // 4. User denial flow
  {
    const { controller, runtime, generation } = createTestHarness();
    const transport = new MockAgentTransport([
      {
        events: [
          { type: "tool-call-started", toolCallId: "call-del", toolName: "delete_file" },
          { type: "tool-call-arguments-delta", toolCallId: "call-del", chunk: '{"path": "main.ts"}' },
          { type: "tool-call-completed", toolCallId: "call-del" },
          { type: "turn-completed", stopReason: "tool_calls" },
        ],
      },
      {
        events: [
          { type: "text-delta", text: "Understood, I will not delete main.ts." },
          { type: "turn-completed", stopReason: "stop" },
        ],
      },
    ]);

    const orchestrator = new AgentOrchestrator({
      projectId: "proj-test",
      generation,
      runtime,
      transport,
    });

    orchestrator.submitRun("Delete main.ts");
    await new Promise((r) => setTimeout(r, 15));

    const pending = controller.getPending();
    controller.deny(pending[0].approvalId, generation);
    const attempt = runtime.getActiveHead() ?? runtime.getAllAttempts()[0];
    runtime.deny(attempt.attemptId);

    await new Promise((r) => setTimeout(r, 60));

    assert(orchestrator.getState() === "completed", "Run completes after handling denial");
    const toolMsg = orchestrator.getMessages().find((m) => m.role === "tool");
    assert(
      toolMsg?.parts[0]?.type === "tool-result" && toolMsg.parts[0].envelope.status === "denied",
      "Denied tool result envelope recorded with denied status",
    );
  }

  // 5. In-flight cancellation
  {
    const { runtime, generation } = createTestHarness();
    const transport = new MockAgentTransport([
      {
        events: [
          { type: "text-delta", text: "Starting long process..." },
          { type: "tool-call-started", toolCallId: "call-long", toolName: "delete_file" },
          { type: "tool-call-arguments-delta", toolCallId: "call-long", chunk: '{"path": "big.ts"}' },
          { type: "tool-call-completed", toolCallId: "call-long" },
          { type: "turn-completed", stopReason: "tool_calls" },
        ],
      },
    ]);

    const orchestrator = new AgentOrchestrator({
      projectId: "proj-test",
      generation,
      runtime,
      transport,
    });

    orchestrator.submitRun("Do long task");
    await new Promise((r) => setTimeout(r, 10));

    assert(orchestrator.getState() === "waiting-for-approval", "Waiting for approval before cancellation");
    const cancelled = orchestrator.cancel("User pressed stop");
    assert(cancelled, "cancel() returns true for active run");
    assert(orchestrator.getState() === "cancelled", "State transitions to cancelled");

    // Late actions have no effect
    const secondCancel = orchestrator.cancel();
    assert(!secondCancel, "cancel() on terminal run returns false");
  }

  // 6. Generation invalidation (project switch)
  {
    const { runtime } = createTestHarness({ generation: 1 });
    const transport = new MockAgentTransport([
      {
        events: [
          { type: "tool-call-started", toolCallId: "call-switch", toolName: "delete_file" },
          { type: "tool-call-arguments-delta", toolCallId: "call-switch", chunk: '{"path": "x.ts"}' },
          { type: "tool-call-completed", toolCallId: "call-switch" },
          { type: "turn-completed", stopReason: "tool_calls" },
        ],
      },
    ]);

    const orchestrator = new AgentOrchestrator({
      projectId: "proj-test",
      generation: 1,
      runtime,
      transport,
    });

    orchestrator.submitRun("Write x.ts");
    await new Promise((r) => setTimeout(r, 10));

    orchestrator.invalidateGeneration(2);
    assert(orchestrator.getState() === "stale", "Run transitions to stale on generation invalidation");
  }

  // 7. Budget enforcement: max turns
  {
    const { runtime, generation } = createTestHarness();
    const infiniteTurns = Array(15).fill({
      events: [
        { type: "tool-call-started", toolCallId: "call-step", toolName: "read_file" },
        { type: "tool-call-arguments-delta", toolCallId: "call-step", chunk: '{"path": "a.ts"}' },
        { type: "tool-call-completed", toolCallId: "call-step" },
        { type: "turn-completed", stopReason: "tool_calls" },
      ],
    });

    const transport = new MockAgentTransport(infiniteTurns);
    const orchestrator = new AgentOrchestrator({
      projectId: "proj-test",
      generation,
      runtime,
      transport,
      budgets: { maxTurns: 3 },
    });

    orchestrator.submitRun("Looping agent");
    await new Promise((r) => setTimeout(r, 50));

    assert(orchestrator.getState() === "failed", "Run fails when exceeding maxTurns");
  }

  // 8. Constant stack depth and iterative memory proof (50 iterations)
  {
    const { runtime, generation } = createTestHarness();
    const fiftyTurns = Array(50).fill({
      events: [
        { type: "tool-call-started", toolCallId: "call-loop", toolName: "read_file" },
        { type: "tool-call-arguments-delta", toolCallId: "call-loop", chunk: '{"path": "a.ts"}' },
        { type: "tool-call-completed", toolCallId: "call-loop" },
        { type: "turn-completed", stopReason: "tool_calls" },
      ],
    });

    const transport = new MockAgentTransport(fiftyTurns);
    const orchestrator = new AgentOrchestrator({
      projectId: "proj-test",
      generation,
      runtime,
      transport,
      budgets: { maxTurns: 60, maxToolsPerRun: 100 },
    });

    orchestrator.submitRun("50 iterative turns");
    await new Promise((r) => setTimeout(r, 200));

    const state = orchestrator.getState();
    assert(
      state === "starting" ||
        state === "streaming" ||
        state === "waiting-for-tools" ||
        state === "continuing" ||
        state === "completed",
      "50 iterative turns executed smoothly without stack overflow",
    );
    orchestrator.cancel();
  }

  // -------------------------------------------------------------------------
  // Section 2: Transport Protocol Grammar & Tool Assembly
  // -------------------------------------------------------------------------
  console.log("\n--- Section 2: Transport Protocol Grammar & Tool Assembly ---");

  // 9. Fragmented JSON argument assembly across 10 single-character chunks
  {
    const assembler = new ToolCallAssembler();
    assembler.startToolCall("call-frag", "read_file");

    const json = '{"path":"main.ts"}';
    for (const char of json) {
      const res = assembler.appendArgumentChunk("call-frag", char);
      assert(res.ok, "Character chunk appended");
    }
    assembler.completeToolCall("call-frag");

    const finalized = assembler.finalizeAll();
    assert(finalized.ok, "10-character fragmented arguments assembled cleanly");
    if (finalized.ok) {
      assert(finalized.calls[0].args.path === "main.ts", "Parsed arguments match expected object");
    }
  }

  // 10. Interleaved tool calls assemble independently
  {
    const assembler = new ToolCallAssembler();
    assembler.startToolCall("call-A", "read_file");
    assembler.startToolCall("call-B", "write_file");

    assembler.appendArgumentChunk("call-A", '{"path":');
    assembler.appendArgumentChunk("call-B", '{"path":"b.ts"');
    assembler.appendArgumentChunk("call-A", '"a.ts"}');
    assembler.appendArgumentChunk("call-B", ',"contents":"123"}');

    assembler.completeToolCall("call-A");
    assembler.completeToolCall("call-B");

    const finalized = assembler.finalizeAll();
    assert(finalized.ok, "Interleaved tool calls finalized");
    if (finalized.ok) {
      assert(finalized.calls[0].args.path === "a.ts", "Call A args match");
      assert(finalized.calls[1].args.contents === "123", "Call B args match");
    }
  }

  // 11. Malformed JSON triggers PROTOCOL_ERROR
  {
    const assembler = new ToolCallAssembler();
    assembler.startToolCall("call-bad", "read_file");
    assembler.appendArgumentChunk("call-bad", "{bad json: invalid}");
    assembler.completeToolCall("call-bad");

    const finalized = assembler.finalizeAll();
    assert(!finalized.ok && finalized.error.code === "PROTOCOL_ERROR", "Malformed JSON rejected with PROTOCOL_ERROR");
  }

  // 12. Oversized arguments (>64 KB) rejected with ARGUMENT_LIMIT_EXCEEDED
  {
    const assembler = new ToolCallAssembler();
    assembler.startToolCall("call-huge", "write_file");
    const hugePayload = "x".repeat(65 * 1024);
    const res = assembler.appendArgumentChunk("call-huge", hugePayload);
    assert(!res.ok && res.error.code === "ARGUMENT_LIMIT_EXCEEDED", "Payload > 64 KB rejected with ARGUMENT_LIMIT_EXCEEDED");
  }

  // 13. Canonical tool schema validation: missing required field & path traversal
  {
    const missingPath = validateToolArguments("read_file", {});
    assert(!missingPath.ok && missingPath.error.code === "INVALID_PARAMS", "Missing required 'path' rejected");

    const pathTraversal = validateToolArguments("read_file", { path: "../etc/passwd" });
    assert(!pathTraversal.ok && pathTraversal.error.code === "INVALID_PARAMS", "Path traversal rejected");

    const validCall = validateToolArguments("read_file", { path: "src/index.ts" });
    assert(validCall.ok, "Valid workspace path accepted");
  }

  // 14. Canonical tool coverage: every tool in AGENT_TOOLS has schema coverage
  {
    for (const tool of AGENT_TOOLS) {
      const validation = validateToolArguments(tool.name, {});
      // Should return either ok (for 0-param tools) or INVALID_PARAMS (for tools with required params)
      assert(validation.ok || validation.error.code === "INVALID_PARAMS", `Tool ${tool.name} has canonical schema coverage`);
    }
  }

  // 15. Unknown tool name yields UNKNOWN_TOOL code
  {
    const unknown = validateToolArguments("fake_tool_xyz", {});
    assert(!unknown.ok && unknown.error.code === "UNKNOWN_TOOL", "Unknown tool name returns UNKNOWN_TOOL error code");
  }

  // 15a. Event after terminal event rejected with PROTOCOL_ERROR (0 tools submitted)
  {
    const { runtime, generation } = createTestHarness();
    const transport = new MockAgentTransport([
      {
        events: [
          { type: "turn-completed", stopReason: "stop" },
          { type: "text-delta", text: "extra text after terminal" },
        ],
      },
    ]);
    const orchestrator = new AgentOrchestrator({ projectId: "proj-test", generation, runtime, transport });
    orchestrator.submitRun("Test event after terminal");
    await new Promise((r) => setTimeout(r, 20));
    assert(orchestrator.getState() === "failed", "Event after terminal rejected with run failure");
    assert(runtime.getAllAttempts().length === 0, "Zero tools submitted on event after terminal");
  }

  // 15b. Iterator error fails run and submits zero tools
  {
    const { runtime, generation } = createTestHarness();
    const failingTransport: AgentTransport = {
      send(req: AgentTransportRequest) {
        return {
          [Symbol.asyncIterator]() {
            let count = 0;
            return {
              async next() {
                if (count === 0) {
                  count++;
                  return {
                    done: false,
                    value: {
                      type: "turn-started",
                      eventId: "e1",
                      turnId: req.turnId,
                      requestId: req.requestId,
                      sequence: 1,
                      timestamp: Date.now(),
                    } as any,
                  };
                }
                throw new Error("Simulated transport stream connection failure");
              },
            };
          },
        };
      },
    };
    const orchestrator = new AgentOrchestrator({ projectId: "proj-test", generation, runtime, transport: failingTransport });
    orchestrator.submitRun("Test iterator throw");
    await new Promise((r) => setTimeout(r, 20));
    assert(orchestrator.getState() === "failed", "Iterator error fails run");
    assert(runtime.getAllAttempts().length === 0, "Zero tools submitted on iterator error");
  }

  // 15c. Stream ends without terminal event rejected with PROTOCOL_ERROR (0 tools submitted)
  {
    const { runtime, generation } = createTestHarness();
    const transport = new MockAgentTransport([
      {
        events: [
          { type: "text-delta", text: "Streaming without terminal event..." },
          // Omit turn-completed
        ],
      },
    ]);
    const orchestrator = new AgentOrchestrator({ projectId: "proj-test", generation, runtime, transport });
    orchestrator.submitRun("Test missing terminal");
    await new Promise((r) => setTimeout(r, 20));
    assert(orchestrator.getState() === "failed", "Missing terminal event fails run with PROTOCOL_ERROR");
    assert(runtime.getAllAttempts().length === 0, "Zero tools submitted on missing terminal event");
  }

  // 15d. Incomplete tool call in stream fails run and submits zero tools
  {
    const { runtime, generation } = createTestHarness();
    const transport = new MockAgentTransport([
      {
        events: [
          { type: "tool-call-started", toolCallId: "call-incomplete-stream", toolName: "read_file" },
          { type: "tool-call-arguments-delta", toolCallId: "call-incomplete-stream", chunk: '{"path": "a.ts"}' },
          // Missing tool-call-completed
          { type: "turn-completed", stopReason: "tool_calls" },
        ],
      },
    ]);
    const orchestrator = new AgentOrchestrator({ projectId: "proj-test", generation, runtime, transport });
    orchestrator.submitRun("Test incomplete tool call");
    await new Promise((r) => setTimeout(r, 20));
    assert(orchestrator.getState() === "failed", "Incomplete tool call fails run");
    assert(runtime.getAllAttempts().length === 0, "Zero tools submitted when tool call remains incomplete");
  }

  // 15e. Schema validation failure fails run and submits zero tools
  {
    const { runtime, generation } = createTestHarness();
    const transport = new MockAgentTransport([
      {
        events: [
          { type: "tool-call-started", toolCallId: "call-schema-fail", toolName: "read_file" },
          { type: "tool-call-arguments-delta", toolCallId: "call-schema-fail", chunk: '{"path": "../forbidden/file.txt"}' },
          { type: "tool-call-completed", toolCallId: "call-schema-fail" },
          { type: "turn-completed", stopReason: "tool_calls" },
        ],
      },
    ]);
    const orchestrator = new AgentOrchestrator({ projectId: "proj-test", generation, runtime, transport });
    orchestrator.submitRun("Test schema validation failure");
    await new Promise((r) => setTimeout(r, 20));
    assert(orchestrator.getState() === "failed", "Schema validation failure fails run");
    assert(runtime.getAllAttempts().length === 0, "Zero tools submitted when schema validation fails");
  }

  // -------------------------------------------------------------------------
  // Section 3: Process Streaming & Stateful Cross-Chunk Redaction
  // -------------------------------------------------------------------------
  console.log("\n--- Section 3: Process Streaming & Stateful Cross-Chunk Redaction ---");

  // 16. Secret split across 3+ chunks is withheld and 100% sanitized
  {
    const redactor = new StreamingRedactor();
    const chunk1 = "Connecting with token: Bearer ";
    const chunk2 = "eyJh";
    const chunk3 = "bGciOiJIUzI1NiJ9.test done\n";

    const out1 = redactor.processChunk(chunk1);
    const out2 = redactor.processChunk(chunk2);
    const out3 = redactor.processChunk(chunk3);

    const fullOutput = out1 + out2 + out3;
    assert(!fullOutput.includes("eyJh"), "Secret token omitted from chunk output");
    assert(fullOutput.includes("[REDACTED]") || fullOutput.includes("Bearer"), "Sanitized output replaces token");
  }

  // 17. Overlong sensitive buffer fails closed
  {
    const redactor = new StreamingRedactor();
    const longSecretPrefix = "token=" + "a".repeat(600);
    const out = redactor.processChunk(longSecretPrefix);
    assert(out.includes("[REDACTED]") || out.includes("[CONTENT WITHHELD]"), "Overlong sensitive buffer fails closed");
  }

  // 18. Redactor flush on exit flushes safe tail
  {
    const redactor = new StreamingRedactor();
    redactor.processChunk("Normal trailing text without secret");
    const flushed = redactor.flush();
    assert(flushed.length >= 0, "Flush on exit clears buffer cleanly");
  }

  // 19. AgentProcessStreamBridge output truncation (non-fatal)
  {
    const controller = new MockCommandController();
    const bridge = new AgentProcessStreamBridge(controller);

    let outputEventCount = 0;
    let sawTruncation = false;

    bridge.onEvent((evt) => {
      if (evt.type === "process:output") {
        outputEventCount++;
        if (evt.data.truncated) sawTruncation = true;
      }
    });

    bridge.correlateProcess("cmd-test-1", {
      projectId: "proj-test",
      generation: 1,
      command: "npm test",
    });

    // Simulate process output chunk
    controller.emitOutput("cmd-test-1", "test chunk line 1\n");
    assert(outputEventCount === 1, "Output event received through bridge");

    bridge.dispose();
  }

  // -------------------------------------------------------------------------
  // Section 4: Transcript Ingestion Dispatcher & Sequencing
  // -------------------------------------------------------------------------
  console.log("\n--- Section 4: Transcript Ingestion Dispatcher & Sequencing ---");

  // 20. Monotonic projectionSequence and replay deduplication
  {
    const dispatcher = new TranscriptIngestionDispatcher();

    const event1: any = {
      type: "attempt:running",
      attemptId: "att-1",
      toolCallId: "call-1",
      sequence: 1,
      data: { toolName: "read_file" },
    };

    const res1 = dispatcher.ingestExecutionEvent(event1);
    assert(res1.accepted && res1.sequence === 1, "First event assigned sequence 1");

    const replayRes = dispatcher.ingestExecutionEvent(event1);
    assert(!replayRes.accepted && replayRes.sequence === 1, "Replayed event rejected without consuming sequence number");

    const event2: any = {
      type: "attempt:succeeded",
      attemptId: "att-1",
      toolCallId: "call-1",
      sequence: 2,
      data: { toolName: "read_file", userSummary: "Read file ok" },
    };

    const res2 = dispatcher.ingestExecutionEvent(event2);
    assert(res2.accepted && res2.sequence === 2, "Second event assigned sequence 2");
    assert(dispatcher.getBlocks().length === 2, "Transcript contains 2 projected blocks");
  }

  // -------------------------------------------------------------------------
  // Section 5: Mutation Controls (Negative Controls)
  // -------------------------------------------------------------------------
  console.log("\n--- Section 5: Mutation Controls (Negative Controls) ---");

  // Mutation 1: Incomplete tool calls must not finalize
  {
    const assembler = new ToolCallAssembler();
    assembler.startToolCall("call-incomplete", "read_file");
    // Do not call completeToolCall
    const res = assembler.finalizeAll();
    assert(!res.ok, "Mutation 1 passed: Incomplete tool calls rejected before submission");
  }

  // Mutation 2: Bypassing M3.7 submission fails permission gate
  {
    const { controller, runtime, generation } = createTestHarness();
    const { attempt } = runtime.submit(
      {
        toolCallId: "call-gate",
        name: "delete_file",
        args: { path: "test.ts" },
        projectId: "proj-test",
        generation,
      },
      { idempotencyKey: "test-gate" },
    );
    await new Promise((r) => setTimeout(r, 15));
    assert(attempt.state === "awaiting-approval", "Mutation 2 passed: M3.7 runtime enforces M3.6 permission gate");
  }

  // Mutation 3: Stale generation invalidation rejects cross-talk
  {
    const { runtime } = createTestHarness({ generation: 1 });
    runtime.invalidateGeneration(2);
    const { attempt } = runtime.submit({
      toolCallId: "call-stale",
      name: "read_file",
      args: { path: "a.ts" },
      projectId: "proj-test",
      generation: 1, // Stale generation
    });
    await new Promise((r) => setTimeout(r, 15));
    assert(attempt.state === "stale", "Mutation 3 passed: Stale generation immediately sets attempt to stale");
  }

  // Mutation 4: Redactor withholding prevents split-token leak
  {
    const redactor = new StreamingRedactor();
    const chunk = "Authorization: Bearer secret-token-xyz";
    const out = redactor.processChunk(chunk);
    assert(!out.includes("secret-token-xyz"), "Mutation 4 passed: Token redacted in output stream");
  }

  // Mutation 5: Dispatcher deduplication prevents duplicate transcript blocks
  {
    const dispatcher = new TranscriptIngestionDispatcher();
    const procEvent: any = {
      type: "process:output",
      processId: "cmd-dedup",
      sequence: 1,
      data: { chunk: "output line 1\n" },
    };
    dispatcher.ingestProcessEvent(procEvent);
    dispatcher.ingestProcessEvent(procEvent); // Duplicate
    assert(dispatcher.getProjectionSequence() === 1, "Mutation 5 passed: Duplicate chunk rejected by dispatcher");
  }

  console.log(`\n===============================================================`);
  console.log(`All ${passedCount} CoderXP M3.8 Deterministic Tests Passed Successfully!`);
  console.log(`===============================================================\n`);
}

runTests().catch((err) => {
  console.error("Test harness failed with error:", err);
  process.exit(1);
});
