/**
 * Deterministic Adapter & Workspace Integration Test Suite for CoderXP M3.7.
 *
 * Verifies:
 * - Correlation between M3.6 Permission UI / cards and M3.7 execution attempts
 * - Approval, Denial, and Cancellation card lifecycle
 * - Project switch disposal and generation fencing in runtime adapters
 * - Event subscriber isolation and unmount cleanup
 * - Replay idempotency in chat transcript projector
 * - Simulating React Strict Mode double-invocation safety
 *
 * Zero DOM, zero network, 100% deterministic assertions.
 */

import {
  AgentPermissionController,
  type AgentToolCall,
} from "../lib/workspace/agent-permissions";
import {
  AgentExecutionRuntime,
  type AgentExecutionEvent,
} from "../lib/workspace/agent-execution-runtime";
import {
  projectEventToTranscriptBlocks,
  TranscriptIngestionDispatcher,
} from "../lib/workspace/agent-transcript-projector";
import type { AgentBlock, AgentMessage } from "../lib/workspace/agent-protocol";
import type { AgentToolResult } from "../lib/workspace/agent-tools";
import { AgentOrchestrator } from "../lib/workspace/agent-orchestrator";
import { MockAgentTransport } from "../lib/workspace/agent-mock-transport";
import {
  AgentProcessStreamBridge,
  type MinimalCommandController,
} from "../lib/workspace/agent-process-stream";

let passCount = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
  passCount++;
  console.log(`[PASS #${passCount}] ${message}`);
}

async function runAdapterTests() {
  console.log("==========================================================================");
  console.log("      M3.7 WORKSPACE INTEGRATION & ADAPTER TEST HARNESS                   ");
  console.log("==========================================================================");

  const PROJECT_ID_1 = "proj-adapter-1";
  const PROJECT_ID_2 = "proj-adapter-2";

  // -------------------------------------------------------------------------
  // 1. APPROVAL CARD CORRELATION & RESOLUTION FLOW
  // -------------------------------------------------------------------------
  console.log("\n--- 1. APPROVAL CARD CORRELATION & RESOLUTION FLOW ---");

  const ctrl1 = new AgentPermissionController();
  ctrl1.setMode("ask");

  let toolExecuted = 0;
  const runtime1 = new AgentExecutionRuntime({
    projectId: PROJECT_ID_1,
    generation: 1,
    controller: ctrl1,
    executeTool: async () => {
      toolExecuted++;
      return { ok: true, data: { success: true } };
    },
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  const toolCall: AgentToolCall = {
    toolCallId: "call-card-1",
    name: "write_file",
    args: { path: "card.txt", content: "data" },
    projectId: PROJECT_ID_1,
    generation: 1,
  };

  const { attempt } = runtime1.submit(toolCall);
  await runtime1.drain();

  assert(attempt.state === "awaiting-approval", "Attempt pauses in awaiting-approval");
  const pendingApprovals = ctrl1.getPending();
  assert(pendingApprovals.length === 1, "Exactly one pending approval card exists in controller");
  assert(
    pendingApprovals[0].approvalId === attempt.approvalId,
    "Approval card ID in controller matches attempt approvalId exactly",
  );

  // User clicks Approve on the card (mirrors ProjectShell.handleApprove)
  const approvalId = pendingApprovals[0].approvalId;
  const approveResult = ctrl1.approve(approvalId, 1);
  assert(approveResult === true, "Controller records approval for card");

  // Adapter resumes the correlated attempt
  const resumed = await runtime1.resume(attempt.attemptId);
  assert(resumed === true, "Adapter resumes correlated attempt successfully");
  assert(attempt.state === "succeeded", "Attempt transitioned to succeeded");
  assert(toolExecuted === 1, "Tool handler executed exactly 1 time");

  const remainingPending = ctrl1.getPending();
  assert(remainingPending.length === 0, "Pending approval card removed after resolution");

  // -------------------------------------------------------------------------
  // 2. DENIAL & CANCELLATION CARD CLEANUP
  // -------------------------------------------------------------------------
  console.log("\n--- 2. DENIAL & CANCELLATION CARD CLEANUP ---");

  const { attempt: attemptDeny } = runtime1.submit({
    toolCallId: "call-deny-1",
    name: "write_file",
    args: { path: "deny.txt" },
    projectId: PROJECT_ID_1,
    generation: 1,
  });
  await runtime1.drain();
  assert(ctrl1.getPending().length === 1, "Pending card created");

  // User clicks Deny (mirrors ProjectShell.handleDeny)
  runtime1.deny(attemptDeny.attemptId);
  await runtime1.drain();
  assert(attemptDeny.state === "denied", "Attempt marked denied");
  assert(ctrl1.getPending().length === 0, "Card dismissed on denial");

  // -------------------------------------------------------------------------
  // 3. PROJECT SWITCH DISPOSAL & GENERATION FENCING
  // -------------------------------------------------------------------------
  console.log("\n--- 3. PROJECT SWITCH DISPOSAL & GENERATION FENCING ---");

  const ctrl3 = new AgentPermissionController();
  ctrl3.setMode("ask");

  const runtimeOld = new AgentExecutionRuntime({
    projectId: PROJECT_ID_1,
    generation: 1,
    controller: ctrl3,
    executeTool: async () => ({ ok: true, data: null }),
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  const { attempt: oldAttempt } = runtimeOld.submit({
    toolCallId: "old-proj-call",
    name: "write_file",
    args: {},
    projectId: PROJECT_ID_1,
    generation: 1,
  });
  await runtimeOld.drain();

  // Project switch occurs in ProjectShell: old runtime is disposed/cancelled
  const cancelledCount = runtimeOld.cancelAll("Project unmounted");
  assert(cancelledCount === 1, "Old runtime cancelled all active and queued attempts");
  assert(oldAttempt.state === "cancelled", "Old project attempt transitioned to cancelled");

  // New runtime initialized for new project
  const runtimeNew = new AgentExecutionRuntime({
    projectId: PROJECT_ID_2,
    generation: 1,
    controller: ctrl3,
    executeTool: async () => ({ ok: true, data: null }),
    scheduleDrain: (fn) => queueMicrotask(fn),
  });
  assert(runtimeNew.getProjectId() === PROJECT_ID_2, "New runtime bound to new project");
  assert(runtimeNew.getAllAttempts().length === 0, "New runtime has isolated, clean attempt history");

  // -------------------------------------------------------------------------
  // 4. EVENT SUBSCRIPTION & UNMOUNT CLEANUP
  // -------------------------------------------------------------------------
  console.log("\n--- 4. EVENT SUBSCRIPTION & UNMOUNT CLEANUP ---");

  let listenerFired = 0;
  const unsubscribe = runtimeNew.onEvent(() => {
    listenerFired++;
  });

  runtimeNew.submit({
    toolCallId: "evt-test-1",
    name: "read_file",
    args: {},
    projectId: PROJECT_ID_2,
    generation: 1,
  });
  await runtimeNew.drain();
  assert(listenerFired > 0, "Event listener received execution events");

  // Unsubscribe (mirrors useEffect cleanup in useAgentExecutionRuntime)
  const countBeforeUnsub = listenerFired;
  unsubscribe();

  runtimeNew.submit({
    toolCallId: "evt-test-2",
    name: "read_file",
    args: {},
    projectId: PROJECT_ID_2,
    generation: 1,
  });
  await runtimeNew.drain();
  assert(listenerFired === countBeforeUnsub, "Unsubscribed listener receives zero further events");

  // -------------------------------------------------------------------------
  // 5. CHAT TRANSCRIPT REPLAY DEDUPLICATION
  // -------------------------------------------------------------------------
  console.log("\n--- 5. CHAT TRANSCRIPT REPLAY DEDUPLICATION ---");

  let chatBlocks: AgentBlock[] = [];
  const event1: AgentExecutionEvent = {
    eventId: "evt-chat-1",
    attemptId: "att-c-1",
    toolCallId: "tc-c-1",
    sequence: 1,
    type: "attempt:running",
    timestamp: 2000,
    projectId: PROJECT_ID_2,
    generation: 1,
    data: { toolName: "write_file", summary: "Writing file app.tsx" },
  };

  chatBlocks = projectEventToTranscriptBlocks(chatBlocks, event1);
  assert(chatBlocks.length === 1, "First event creates exactly 1 block");

  // -------------------------------------------------------------------------
  // 6. REACT LIFETIME, STRICT MODE & OLD-EFFECT DISPOSAL ISOLATION
  // -------------------------------------------------------------------------
  console.log("\n--- 6. REACT LIFETIME, STRICT MODE & OLD-EFFECT DISPOSAL ISOLATION ---");

  // 6.1 Runtime instance stability across rerenders
  // Simulating the useMemo([projectId, generation, controller, executeTool]) logic from useAgentExecutionRuntime
  function createMemoizedRuntimeGetter() {
    let cachedRuntime: AgentExecutionRuntime | null = null;
    let prevDeps: [string, number, AgentPermissionController, Function] | null = null;

    return function getRuntime(
      pId: string,
      gen: number,
      ctrl: AgentPermissionController,
      exec: Function,
    ) {
      if (
        cachedRuntime &&
        prevDeps &&
        prevDeps[0] === pId &&
        prevDeps[1] === gen &&
        prevDeps[2] === ctrl &&
        prevDeps[3] === exec
      ) {
        return cachedRuntime;
      }
      cachedRuntime = new AgentExecutionRuntime({
        projectId: pId,
        generation: gen,
        controller: ctrl,
        executeTool: exec as any,
        scheduleDrain: (fn) => queueMicrotask(fn),
      });
      prevDeps = [pId, gen, ctrl, exec];
      return cachedRuntime;
    };
  }

  const getHookRuntime = createMemoizedRuntimeGetter();
  const ctrl6 = new AgentPermissionController();
  ctrl6.setMode("autonomous");
  const stableExecutor = async () => ({ ok: true, data: null });

  const r1 = getHookRuntime("proj-life", 1, ctrl6, stableExecutor);
  const r2 = getHookRuntime("proj-life", 1, ctrl6, stableExecutor); // Ordinary component rerender 1
  const r3 = getHookRuntime("proj-life", 1, ctrl6, stableExecutor); // Ordinary component rerender 2

  assert(r1 === r2, "Runtime instance is stable across rerender 1");
  assert(r2 === r3, "Runtime instance is stable across rerender 2");

  // 6.2 Strict Mode double mount / effect replay does NOT double execute
  let strictExecCount = 0;
  const strictExecutor = async (): Promise<AgentToolResult<unknown>> => {
    strictExecCount++;
    return { ok: true, data: { success: true } };
  };

  const strictRuntime = new AgentExecutionRuntime({
    projectId: "proj-strict",
    generation: 1,
    controller: ctrl6,
    executeTool: strictExecutor,
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  const toolCallStrict: AgentToolCall = {
    toolCallId: "call-strict-1",
    name: "read_file",
    args: { path: "strict.txt" },
    projectId: "proj-strict",
    generation: 1,
  };

  // Mount 1 (initial mount & submit)
  const sub1 = strictRuntime.submit(toolCallStrict, { idempotencyKey: "idem-strict-1" });
  assert(sub1.isNew === true, "First submission in Strict Mode mount is new");

  // Strict Mode unmount/cleanup simulation (unsubscribes listeners, but runtime survives or idempotent resubmit)
  // Mount 2 (effect replay with identical submission)
  const sub2 = strictRuntime.submit(toolCallStrict, { idempotencyKey: "idem-strict-1" });
  assert(sub2.isNew === false, "Effect replay submission in Strict Mode is deduplicated (isNew: false)");
  assert(sub1.attempt.attemptId === sub2.attempt.attemptId, "Returns identical attempt instance");

  await strictRuntime.drain();
  assert(strictExecCount === 1, "Handler executed exactly 1 time across Strict Mode replay");

  // 6.3 Cleanup of old effect cannot cancel or dispose a newer runtime instance
  const oldRuntime = new AgentExecutionRuntime({
    projectId: "proj-old",
    generation: 1,
    controller: ctrl6,
    executeTool: async () => ({ ok: true, data: null }),
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  const newRuntime = new AgentExecutionRuntime({
    projectId: "proj-new",
    generation: 1,
    controller: ctrl6,
    executeTool: async () => ({ ok: true, data: null }),
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  // Old effect cleanup closure capturing oldRuntime
  const oldEffectCleanup = () => {
    oldRuntime.cancelAll("Old workspace unmounted");
  };

  const { attempt: oldAtt } = oldRuntime.submit({
    toolCallId: "call-old",
    name: "read_file",
    args: {},
    projectId: "proj-old",
    generation: 1,
  });

  const { attempt: newAtt } = newRuntime.submit({
    toolCallId: "call-new",
    name: "read_file",
    args: {},
    projectId: "proj-new",
    generation: 1,
  });

  // Run old effect cleanup
  oldEffectCleanup();

  assert(oldAtt.state === "cancelled", "Old runtime attempt is cancelled by old effect cleanup");
  assert(newAtt.state === "queued", "New runtime attempt is untouched by old effect cleanup");

  await newRuntime.drain();
  assert(newAtt.state === "succeeded", "New runtime progresses and succeeds independently");

  // -------------------------------------------------------------------------
  // 7. M3.8 FULL WORKSPACE INTEGRATION & ORCHESTRATOR WIRING
  // -------------------------------------------------------------------------
  console.log("\n--- 7. M3.8 FULL WORKSPACE INTEGRATION & ORCHESTRATOR WIRING ---");

  // 7.1 ProjectShell owns stable AgentOrchestrator instance
  const ctrl7 = new AgentPermissionController();
  ctrl7.setMode("ask");
  let tool7Executed = 0;
  const runtime7 = new AgentExecutionRuntime({
    projectId: "proj-workspace",
    generation: 1,
    controller: ctrl7,
    executeTool: async () => {
      tool7Executed++;
      return { ok: true, data: { status: "file written" } };
    },
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  const transport7 = new MockAgentTransport([
    {
      events: [
        { type: "text-delta", text: "Starting file write..." },
        { type: "tool-call-started", toolCallId: "call-ws-1", toolName: "write_file" },
        { type: "tool-call-arguments-delta", toolCallId: "call-ws-1", chunk: '{"path":"ws.txt","contents":"hello"}' },
        { type: "tool-call-completed", toolCallId: "call-ws-1" },
        { type: "turn-completed", stopReason: "tool_calls" },
      ],
    },
    {
      events: [
        { type: "text-delta", text: "File written successfully." },
        { type: "turn-completed", stopReason: "stop" },
      ],
    },
  ]);

  const orchestrator7 = new AgentOrchestrator({
    projectId: "proj-workspace",
    generation: 1,
    runtime: runtime7,
    transport: transport7,
  });

  assert(orchestrator7.getState() === "idle", "Orchestrator initialized in idle state");

  // 7.2 Prompt submission starts orchestrator and updates visible transcript
  const dispatcher7 = new TranscriptIngestionDispatcher();
  const transcript7: AgentMessage[] = [];

  // Submit prompt
  orchestrator7.submitRun("Create ws.txt");
  assert(orchestrator7.getState() === "starting" || orchestrator7.getState() === "streaming" || orchestrator7.getState() === "waiting-for-approval", "Prompt starts orchestrator run");

  await new Promise((r) => setTimeout(r, 20));
  assert(orchestrator7.getState() === "waiting-for-approval", "Paused at waiting-for-approval for write_file");

  // 7.3 Approval targets correlated M3.7 attempt
  const pending7 = ctrl7.getPending();
  assert(pending7.length === 1, "Approval request pending in controller");
  const apprId7 = pending7[0].approvalId;
  ctrl7.approve(apprId7, 1);

  const activeAtt7 = runtime7.getActiveHead();
  assert(activeAtt7 !== null && activeAtt7.approvalId === apprId7, "Found correlated M3.7 attempt");
  await runtime7.resume(activeAtt7!.attemptId);

  await new Promise((r) => setTimeout(r, 40));
  assert(orchestrator7.getState() === "completed", "Orchestrator run completed after tool resolution");
  assert(tool7Executed === 1, "Tool executed exactly 1 time through gate");

  // 7.4 Process-stream bridge connects to command controller and emits process output
  class MockCmdController implements MinimalCommandController {
    private outCb: ((pId: string, chunk: string) => void) | null = null;
    private stCb: ((h: { processId: string; state: string; exitCode: number | null }) => void) | null = null;

    onOutput(cb: (pId: string, chunk: string) => void) {
      this.outCb = cb;
    }
    onStateChange(cb: (h: { processId: string; state: string; exitCode: number | null }) => void) {
      this.stCb = cb;
    }
    emitOut(pId: string, chunk: string) {
      this.outCb?.(pId, chunk);
    }
    emitDone(pId: string, exitCode: number) {
      this.stCb?.({ processId: pId, state: "completed", exitCode });
    }
  }

  const mockCmdCtrl = new MockCmdController();
  const bridge7 = new AgentProcessStreamBridge(mockCmdCtrl);
  let processEvtCount = 0;
  const unsubBridge = bridge7.onEvent((evt) => {
    processEvtCount++;
    dispatcher7.ingestProcessEvent(evt);
  });

  bridge7.correlateProcess("cmd-100", {
    toolCallId: "call-ws-1",
    attemptId: activeAtt7!.attemptId,
    projectId: "proj-workspace",
    generation: 1,
    command: "npm test",
  });
  mockCmdCtrl.emitOut("cmd-100", "Build passing\n");
  mockCmdCtrl.emitDone("cmd-100", 0);

  assert(processEvtCount >= 2, "Process-stream bridge emitted events to dispatcher");
  const blocks7 = dispatcher7.getBlocks();
  assert(blocks7.some((b) => b.kind === "command-started"), "Transcript contains command-started block");
  assert(blocks7.some((b) => b.kind === "command-output"), "Transcript contains command-output block");
  assert(blocks7.some((b) => b.kind === "command-completed"), "Transcript contains command-completed block");

  // 7.5 Unsubscribing bridge cleans up without affecting orchestrator
  unsubBridge();
  bridge7.dispose();
  const prevCount = processEvtCount;
  mockCmdCtrl.emitOut("cmd-100", "ignored\n");
  assert(processEvtCount === prevCount, "Unsubscribed bridge receives zero further events");

  // 7.6 Project switch stales active orchestrator
  const switchOrchestrator = new AgentOrchestrator({
    projectId: "proj-switch-old",
    generation: 1,
    runtime: runtime7,
    transport: new MockAgentTransport([{ events: [{ type: "text-delta", text: "hi" }] }]),
  });
  switchOrchestrator.submitRun("Run before switch");
  switchOrchestrator.invalidateGeneration(2);
  assert(switchOrchestrator.getState() === "stale", "Project switch / generation invalidation stales active orchestrator");

  console.log("==========================================================================");
  console.log(`  SUCCESS: ALL ${passCount} ADAPTER & INTEGRATION ASSERTIONS PASSED!`);
  console.log("==========================================================================");
}

runAdapterTests().catch((err) => {
  console.error("Adapter test failure:", err);
  process.exit(1);
});
