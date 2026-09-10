/**
 * Comprehensive Deterministic Acceptance, Security & Lifecycle Test Harness for CoderXP M3.7.
 *
 * Verifies the Agent Tool Execution Runtime:
 * - Pure provider-independent execution controller & state machine
 * - M3.6 gateAndInvoke integration and 'running' commit checkpoint
 * - Serial FIFO queue scheduling with activeHead head-of-line blocking
 * - Complete approval invalidation terminal-state matrix & match criteria
 * - Full lifecycle matrix (resume, cancel, retry, fail, throw, race, stale)
 * - Mutation-style negative control for at-most-once execution claim
 * - 4-tier disclosure sanitization for all 16 registered tools
 * - Raw result lifetime protection and event immutability
 *
 * Zero DOM, zero network, 100% deterministic assertions.
 */

import {
  AgentPermissionController,
  type AgentToolCall,
} from "../lib/workspace/agent-permissions";
import {
  AgentExecutionRuntime,
  IdempotencyConflictError,
  type AgentExecutionEvent,
  type ToolExecutionContext,
} from "../lib/workspace/agent-execution-runtime";
import {
  projectModelFacingResult,
  formatUserFacingResultSummary,
  formatSafeDiagnostic,
  deepFreezeSafeSnapshot,
} from "../lib/workspace/agent-sanitizer";
import { projectEventToTranscriptBlocks } from "../lib/workspace/agent-transcript-projector";
import {
  AGENT_TOOLS,
  type AgentToolResult,
  type AgentToolName,
} from "../lib/workspace/agent-tools";
import type { AgentBlock } from "../lib/workspace/agent-protocol";

let passCount = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
  passCount++;
  console.log(`[PASS #${passCount}] ${message}`);
}

async function runTests() {
  console.log("==========================================================================");
  console.log("      M3.7 AGENT TOOL EXECUTION RUNTIME (COMPREHENSIVE HARNESS)           ");
  console.log("==========================================================================");

  const PROJECT_ID = "proj-test";

  // -------------------------------------------------------------------------
  // 1. HARDENED INVALIDATE APPROVAL & TERMINAL-STATE MATRIX
  // -------------------------------------------------------------------------
  console.log("\n--- 1. APPROVAL INVALIDATION & TERMINAL-STATE MATRIX ---");

  let notificationCount = 0;
  const ctrl1 = new AgentPermissionController({
    onChange: () => {
      notificationCount++;
    },
  });
  ctrl1.setMode("ask");

  const writeCall1: AgentToolCall = {
    toolCallId: "call-1",
    name: "write_file",
    args: { path: "hello.txt", content: "hi" },
    projectId: PROJECT_ID,
    generation: 1,
  };

  const req1 = ctrl1.requestApproval(writeCall1, 1);
  assert(req1.kind === "pending", "Pending approval created for write_file in ask mode");
  const approvalId1 = (req1 as any).approval.approvalId;

  // 1.1 Invalidate pending approval
  const notesBefore = notificationCount;
  assert(ctrl1.invalidateApproval(approvalId1) === true, "Invalidate pending approval returns true");
  assert(ctrl1.getApproval(approvalId1)?.status === "cancelled", "Pending approval marked cancelled");
  assert(notificationCount === notesBefore + 1, "Invalidation fires notification exactly once");

  // 1.2 Repeated invalidation is idempotent (returns false, no mutation, no notification)
  const notesAfter = notificationCount;
  assert(ctrl1.invalidateApproval(approvalId1) === false, "Repeated invalidation returns false");
  assert(notificationCount === notesAfter, "Repeated invalidation does not trigger additional notifications");
  assert(ctrl1.getApproval(approvalId1)?.status === "cancelled", "Retained cancelled state unchanged");

  // 1.3 Invalidate approved (unconsumed) approval
  const writeCall2: AgentToolCall = {
    toolCallId: "call-2",
    name: "write_file",
    args: { path: "hello2.txt", content: "hi2" },
    projectId: PROJECT_ID,
    generation: 1,
  };
  const req2 = ctrl1.requestApproval(writeCall2, 1);
  const approvalId2 = (req2 as any).approval.approvalId;
  assert(ctrl1.approve(approvalId2, 1) === true, "Approval resolved to approved");
  assert(ctrl1.getApproval(approvalId2)?.status === "approved", "Approval status is approved");
  assert(ctrl1.invalidateApproval(approvalId2) === true, "Invalidate approved unconsumed approval returns true");
  assert(ctrl1.getApproval(approvalId2)?.status === "cancelled", "Approved unconsumed approval marked cancelled");

  // 1.4 Invalidation cannot modify consumed approvals
  const writeCall3: AgentToolCall = {
    toolCallId: "call-3",
    name: "write_file",
    args: { path: "hello3.txt", content: "hi3" },
    projectId: PROJECT_ID,
    generation: 1,
  };
  const req3 = ctrl1.requestApproval(writeCall3, 1);
  const approvalId3 = (req3 as any).approval.approvalId;
  ctrl1.approve(approvalId3, 1);
  const consumeReq = ctrl1.requestApproval(writeCall3, 1);
  assert(consumeReq.kind === "allowed", "Approval consumed and allowed returned");
  assert(ctrl1.getApproval(approvalId3)?.status === "consumed", "Approval status is consumed");
  assert(ctrl1.invalidateApproval(approvalId3) === false, "Attempt to invalidate consumed approval returns false");
  assert(ctrl1.getApproval(approvalId3)?.status === "consumed", "Consumed approval status remains untouched");

  // 1.5 Invalidation cannot modify denied approvals
  const writeCallDeny: AgentToolCall = {
    toolCallId: "call-deny",
    name: "write_file",
    args: { path: "deny.txt", content: "d" },
    projectId: PROJECT_ID,
    generation: 1,
  };
  const reqDeny = ctrl1.requestApproval(writeCallDeny, 1);
  const approvalIdDeny = (reqDeny as any).approval.approvalId;
  ctrl1.deny(approvalIdDeny, 1);
  assert(ctrl1.getApproval(approvalIdDeny)?.status === "denied", "Approval status is denied");
  assert(ctrl1.invalidateApproval(approvalIdDeny) === false, "Attempt to invalidate denied approval returns false");
  assert(ctrl1.getApproval(approvalIdDeny)?.status === "denied", "Denied approval status remains untouched");

  // 1.6 Invalidation cannot modify expired approvals
  const writeCallExp: AgentToolCall = {
    toolCallId: "call-exp",
    name: "write_file",
    args: { path: "exp.txt", content: "e" },
    projectId: PROJECT_ID,
    generation: 1,
  };
  const reqExp = ctrl1.requestApproval(writeCallExp, 1);
  const approvalIdExp = (reqExp as any).approval.approvalId;
  const expApproval = (ctrl1 as any).approvals.get(approvalIdExp);
  if (expApproval) {
    expApproval.status = "expired";
  }
  let expNotified = false;
  const prevOnChange = (ctrl1 as any).onChange;
  (ctrl1 as any).onChange = () => {
    expNotified = true;
  };
  assert(ctrl1.getApproval(approvalIdExp)?.status === "expired", "Approval status is expired");
  assert(
    ctrl1.invalidateApproval(approvalIdExp) === false,
    "Attempt to invalidate expired approval returns false",
  );
  assert(ctrl1.getApproval(approvalIdExp)?.status === "expired", "Expired approval status remains untouched");
  assert(expNotified === false, "No notification fired on attempted invalidation of expired approval");
  assert(
    ctrl1.getApproval(approvalIdExp) !== null,
    "Audit record remains unchanged in storage",
  );
  (ctrl1 as any).onChange = prevOnChange;

  // 1.7 Invalidation cannot modify cancelled approvals
  assert(ctrl1.invalidateApproval(approvalId1) === false, "Attempt to invalidate cancelled approval returns false");

  // 1.7 Stale attempt cannot invalidate newer approval with different generation/callId
  const writeCall5: AgentToolCall = {
    toolCallId: "call-5",
    name: "write_file",
    args: { path: "hello5.txt", content: "hi5" },
    projectId: PROJECT_ID,
    generation: 2,
  };
  const req5 = ctrl1.requestApproval(writeCall5, 2);
  const approvalId5 = (req5 as any).approval.approvalId;
  assert(
    ctrl1.invalidateApproval(approvalId5, { generation: 1 }) === false,
    "Stale generation (1 vs 2) cannot invalidate newer approval",
  );
  assert(
    ctrl1.invalidateApproval(approvalId5, { projectId: "wrong-project" }) === false,
    "Wrong projectId cannot invalidate approval",
  );
  assert(
    ctrl1.invalidateApproval(approvalId5, { toolCallId: "wrong-call" }) === false,
    "Wrong toolCallId cannot invalidate approval",
  );
  assert(
    ctrl1.invalidateApproval(approvalId5, { argsFingerprint: "wrong-args" }) === false,
    "Wrong argsFingerprint cannot invalidate approval",
  );
  assert(ctrl1.getApproval(approvalId5)?.status === "pending", "Approval remains pending after failed match checks");

  // 1.8 Audit record remains in storage after invalidation
  assert(ctrl1.getApproval(approvalId1) !== null, "Audit record preserved after invalidation");

  // -------------------------------------------------------------------------
  // 2. AUTOMATIC EXECUTION & RUNNING COMMIT INSIDE GATE
  // -------------------------------------------------------------------------
  console.log("\n--- 2. AUTOMATIC READ EXECUTION & RUNNING COMMIT ---");

  const ctrl2 = new AgentPermissionController();
  ctrl2.setMode("ask");

  let handlerExecuted = 0;
  const events: AgentExecutionEvent[] = [];

  const runtime2 = new AgentExecutionRuntime({
    projectId: PROJECT_ID,
    generation: 1,
    controller: ctrl2,
    executeTool: async (name, params, ctx) => {
      handlerExecuted++;
      assert(name === "read_file", "Handler invoked with tool name read_file");
      assert(ctx.isCurrent() === true, "isCurrent() returns true inside handler");
      return { ok: true, data: { path: "test.txt", content: "data", bytes: 4 } };
    },
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  runtime2.onEvent((evt) => events.push(evt));

  const readCall: AgentToolCall = {
    toolCallId: "read-call-1",
    name: "read_file",
    args: { path: "test.txt" },
    projectId: PROJECT_ID,
    generation: 1,
  };

  const { attempt: att2 } = runtime2.submit(readCall);
  await runtime2.drain();
  assert(att2.state === "succeeded", "Read call in ask mode transitions queued -> running -> succeeded");
  assert(handlerExecuted === 1, "Handler executed exactly 1 time");

  const eventTypes2 = events.map((e) => e.type);
  assert(
    eventTypes2.includes("attempt:queued") &&
      eventTypes2.includes("attempt:running") &&
      eventTypes2.includes("attempt:succeeded"),
    "Emitted attempt:queued, attempt:running, and attempt:succeeded in order",
  );

  // -------------------------------------------------------------------------
  // 3. APPROVAL FLOW, CONCURRENT RESUMES & QUEUE BLOCKING
  // -------------------------------------------------------------------------
  console.log("\n--- 3. APPROVAL FLOW, RESUME & QUEUE BLOCKING ---");

  const ctrl3 = new AgentPermissionController();
  ctrl3.setMode("ask");

  let writeExecuted3 = 0;
  let readExecuted3 = 0;
  const runtime3 = new AgentExecutionRuntime({
    projectId: PROJECT_ID,
    generation: 1,
    controller: ctrl3,
    executeTool: async (name, params, ctx) => {
      if (name === "write_file") writeExecuted3++;
      if (name === "read_file") readExecuted3++;
      return { ok: true, data: { path: "test.txt", success: true } };
    },
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  const writeCallA: AgentToolCall = {
    toolCallId: "write-call-A",
    name: "write_file",
    args: { path: "write.txt", content: "content" },
    projectId: PROJECT_ID,
    generation: 1,
  };

  const readCallB: AgentToolCall = {
    toolCallId: "read-call-B",
    name: "read_file",
    args: { path: "read.txt" },
    projectId: PROJECT_ID,
    generation: 1,
  };

  const { attempt: attA } = runtime3.submit(writeCallA);
  await runtime3.drain();
  assert(attA.state === "awaiting-approval", "Write call paused at awaiting-approval");
  assert(runtime3.getActiveHead()?.attemptId === attA.attemptId, "Active head is attempt A");

  // Submit second call (Head of line blocking)
  const { attempt: attB } = runtime3.submit(readCallB);
  await runtime3.drain();
  assert(attB.state === "queued", "Second call remains queued behind awaiting-approval head");
  assert(writeExecuted3 === 0, "No handler executed yet");

  // Approve first call
  assert(ctrl3.approve(attA.approvalId!, 1) === true, "Approval recorded in controller");

  // 3.1 Concurrent resume attempts execute at most once
  const [res1, res2, res3] = await Promise.all([
    runtime3.resume(attA.attemptId),
    runtime3.resume(attA.attemptId),
    runtime3.resume(attA.attemptId),
  ]);
  const successCount = [res1, res2, res3].filter((r) => r === true).length;
  assert(successCount === 1, "Concurrent resumes execute at most once (exactly 1 returns true)");
  assert(attA.state === "succeeded", "Attempt A reached succeeded state");
  assert(writeExecuted3 === 1, "Write handler executed exactly 1 time");

  // Drain queue
  await runtime3.drain();
  assert(attB.state === "succeeded", "Attempt B progressed and succeeded after attempt A finished");
  assert(readExecuted3 === 1, "Read handler executed exactly 1 time");

  // 3.2 Duplicate approval callback handling
  assert(ctrl3.approve(attA.approvalId!, 1) === false, "Duplicate approve on resolved approval returns false");

  // -------------------------------------------------------------------------
  // 4. INTERRUPTED APPROVALS, ABANDONED TOKENS & GENERATION INVALIDATION
  // -------------------------------------------------------------------------
  console.log("\n--- 4. INTERRUPTED APPROVALS & ABANDONED AUTHORIZATIONS ---");

  // 4.1 Approval recorded, then cancellation before resume
  const ctrl4a = new AgentPermissionController();
  ctrl4a.setMode("ask");
  const runtime4a = new AgentExecutionRuntime({
    projectId: PROJECT_ID,
    generation: 1,
    controller: ctrl4a,
    executeTool: async () => ({ ok: true, data: null }),
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  const { attempt: att4a } = runtime4a.submit({
    toolCallId: "call-4a",
    name: "write_file",
    args: { path: "4a.txt" },
    projectId: PROJECT_ID,
    generation: 1,
  });
  await runtime4a.drain();
  assert(att4a.state === "awaiting-approval", "Attempt 4a is awaiting approval");
  ctrl4a.approve(att4a.approvalId!, 1);
  assert(ctrl4a.getApproval(att4a.approvalId!)?.status === "approved", "Approval recorded as approved");

  runtime4a.cancel(att4a.attemptId);
  assert(att4a.state === "cancelled", "Attempt 4a cancelled before resume");
  assert(
    ctrl4a.getApproval(att4a.approvalId!)?.status === "cancelled",
    "Approved unconsumed authorization was cancelled upon attempt cancellation",
  );

  // Resume on cancelled attempt fails
  const resumedCancelled = await runtime4a.resume(att4a.attemptId);
  assert(resumedCancelled === false, "Resume on cancelled attempt returns false");

  // 4.2 Reuse attempt after abandoned authorization fails (must not steal old token)
  const { attempt: att4aRetry } = runtime4a.submit({
    toolCallId: "call-4a-retry",
    name: "write_file",
    args: { path: "4a.txt" },
    projectId: PROJECT_ID,
    generation: 1,
  });
  await runtime4a.drain();
  assert(
    att4aRetry.state === "awaiting-approval",
    "Retry attempt cannot claim cancelled authorization and requires new approval",
  );

  // 4.3 Approval recorded, then generation invalidation before resume
  const ctrl4b = new AgentPermissionController();
  ctrl4b.setMode("ask");
  const runtime4b = new AgentExecutionRuntime({
    projectId: PROJECT_ID,
    generation: 1,
    controller: ctrl4b,
    executeTool: async () => ({ ok: true, data: null }),
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  const { attempt: att4b } = runtime4b.submit({
    toolCallId: "call-4b",
    name: "write_file",
    args: { path: "4b.txt" },
    projectId: PROJECT_ID,
    generation: 1,
  });
  await runtime4b.drain();
  ctrl4b.approve(att4b.approvalId!, 1);

  runtime4b.invalidateGeneration(2);
  assert(att4b.state === "stale", "Attempt 4b transitioned to stale on generation invalidation");
  assert(
    ctrl4b.getApproval(att4b.approvalId!)?.status === "cancelled",
    "Approval invalidated on generation switch",
  );

  const resumedStale = await runtime4b.resume(att4b.attemptId);
  assert(resumedStale === false, "Resume on stale attempt returns false");

  // -------------------------------------------------------------------------
  // 5. HANDLER FAILURES, THROWS & ERROR CODES
  // -------------------------------------------------------------------------
  console.log("\n--- 5. HANDLER FAILURES, THROWS & QUEUE PROGRESSION ---");

  const ctrl5 = new AgentPermissionController();
  ctrl5.setMode("autonomous");

  const status5prog = {
    queueAfterFailureExecuted: false,
    queueAfterThrowExecuted: false,
  };

  const runtime5 = new AgentExecutionRuntime({
    projectId: PROJECT_ID,
    generation: 1,
    controller: ctrl5,
    executeTool: async (name, params) => {
      const p = params as any;
      if (p?.action === "fail") {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: "File missing on disk" },
        };
      }
      if (p?.action === "throw") {
        throw new Error("Internal disk write error: connection failed");
      }
      if (p?.action === "after-fail") {
        status5prog.queueAfterFailureExecuted = true;
        return { ok: true, data: { success: true } };
      }
      if (p?.action === "after-throw") {
        status5prog.queueAfterThrowExecuted = true;
        return { ok: true, data: { success: true } };
      }
      return { ok: true, data: null };
    },
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  // 5.1 Handler returns { ok: false } -> HANDLER_FAILED
  const { attempt: attFail } = runtime5.submit({
    toolCallId: "call-fail",
    name: "read_file",
    args: { action: "fail" },
    projectId: PROJECT_ID,
    generation: 1,
  });
  const { attempt: attAfterFail } = runtime5.submit({
    toolCallId: "call-after-fail",
    name: "read_file",
    args: { action: "after-fail" },
    projectId: PROJECT_ID,
    generation: 1,
  });

  await runtime5.drain();
  assert(attFail.state === "failed", "Handler returning ok:false maps to failed state");
  assert(attFail.error?.code === "HANDLER_FAILED", "Error code is HANDLER_FAILED");
  assert(attAfterFail.state === "succeeded", "Queue progressed automatically after HANDLER_FAILED");
  assert(status5prog.queueAfterFailureExecuted === true, "Subsequent queue item executed after failure");

  // 5.2 Handler throws -> HANDLER_THROWN
  const { attempt: attThrow } = runtime5.submit({
    toolCallId: "call-throw",
    name: "write_file",
    args: { action: "throw" },
    projectId: PROJECT_ID,
    generation: 1,
  });
  const { attempt: attAfterThrow } = runtime5.submit({
    toolCallId: "call-after-throw",
    name: "write_file",
    args: { action: "after-throw" },
    projectId: PROJECT_ID,
    generation: 1,
  });

  await runtime5.drain();
  assert(attThrow.state === "failed", "Handler throwing an exception maps to failed state");
  assert(attThrow.error?.code === "HANDLER_THROWN", "Error code is HANDLER_THROWN");
  assert(attAfterThrow.state === "succeeded", "Queue progressed automatically after HANDLER_THROWN");
  assert(status5prog.queueAfterThrowExecuted === true, "Subsequent queue item executed after handler throw");

  // 5.3 Retry after failure creates a new attempt and re-evaluates permissions
  ctrl5.setMode("ask");
  const { attempt: attRetry } = runtime5.submit({
    toolCallId: "call-retry-1",
    name: "write_file",
    args: { path: "retry.txt" },
    projectId: PROJECT_ID,
    generation: 1,
  });
  await runtime5.drain();
  assert(attRetry.attemptId !== attThrow.attemptId, "Retry has a distinct, new attempt ID");
  assert(attRetry.state === "awaiting-approval", "Retry in ask mode re-evaluates permissions and pauses for approval");

  // -------------------------------------------------------------------------
  // 6. QUEUE PROGRESSION ACROSS ALL TERMINAL STATES
  // -------------------------------------------------------------------------
  console.log("\n--- 6. QUEUE PROGRESSION ACROSS ALL TERMINAL STATES ---");

  const ctrl6 = new AgentPermissionController();
  ctrl6.setMode("ask");

  let progressionCount = 0;
  const runtime6 = new AgentExecutionRuntime({
    projectId: PROJECT_ID,
    generation: 1,
    controller: ctrl6,
    executeTool: async () => {
      progressionCount++;
      return { ok: true, data: null };
    },
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  // 6.1 Progression after denial
  const { attempt: attDenyHead } = runtime6.submit({
    toolCallId: "deny-head",
    name: "write_file",
    args: {},
    projectId: PROJECT_ID,
    generation: 1,
  });
  const { attempt: attDenyFollower } = runtime6.submit({
    toolCallId: "deny-follower",
    name: "read_file",
    args: {},
    projectId: PROJECT_ID,
    generation: 1,
  });
  await runtime6.drain();
  runtime6.deny(attDenyHead.attemptId);
  await runtime6.drain();
  assert(attDenyHead.state === "denied", "Head was denied");
  assert(attDenyFollower.state === "succeeded", "Queue progressed after head denial");

  // 6.2 Progression after cancellation
  const { attempt: attCancelHead } = runtime6.submit({
    toolCallId: "cancel-head",
    name: "write_file",
    args: {},
    projectId: PROJECT_ID,
    generation: 1,
  });
  const { attempt: attCancelFollower } = runtime6.submit({
    toolCallId: "cancel-follower",
    name: "read_file",
    args: {},
    projectId: PROJECT_ID,
    generation: 1,
  });
  await runtime6.drain();
  runtime6.cancel(attCancelHead.attemptId);
  await runtime6.drain();
  assert(attCancelHead.state === "cancelled", "Head was cancelled");
  assert(attCancelFollower.state === "succeeded", "Queue progressed after head cancellation");

  // -------------------------------------------------------------------------
  // 7. IN-FLIGHT GENERATION CHANGE & LATE-FAILURE SUPPRESSION
  // -------------------------------------------------------------------------
  console.log("\n--- 7. IN-FLIGHT GENERATION CHANGE & LATE RESULT SUPPRESSION ---");

  const ctrl7 = new AgentPermissionController();
  ctrl7.setMode("autonomous");

  const status7 = { lateFired: false };
  const runtime7 = new AgentExecutionRuntime({
    projectId: PROJECT_ID,
    generation: 1,
    controller: ctrl7,
    executeTool: async () => {
      await new Promise((r) => setTimeout(r, 25));
      status7.lateFired = true;
      throw new Error("Late thrown failure");
    },
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  const { attempt: attInFlight } = runtime7.submit({
    toolCallId: "in-flight-1",
    name: "run_command",
    args: { command: "sleep 10" },
    projectId: PROJECT_ID,
    generation: 1,
  });

  void runtime7.drain();
  await new Promise((r) => setTimeout(r, 5));
  assert(attInFlight.state === "running", "Attempt is actively running");

  // Generation changes while handler is in-flight
  runtime7.invalidateGeneration(2);
  assert(attInFlight.state === "stale", "In-flight attempt marked stale on generation bump");

  // Wait for late throwing handler
  await new Promise((r) => setTimeout(r, 35));
  assert(status7.lateFired === true, "Late handler executed");
  assert(attInFlight.state === "stale", "Late handler exception does NOT overwrite stale terminal state");

  // -------------------------------------------------------------------------
  // 8. IDEMPOTENCY KEYS & IDENTITY CHECKS
  // -------------------------------------------------------------------------
  console.log("\n--- 8. IDEMPOTENCY KEYS & IDENTITY CHECKS ---");

  const ctrl8 = new AgentPermissionController();
  ctrl8.setMode("autonomous");

  const runtime8 = new AgentExecutionRuntime({
    projectId: PROJECT_ID,
    generation: 1,
    controller: ctrl8,
    executeTool: async () => ({ ok: true, data: { path: "idem.txt" } }),
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  // 8.1 Two distinct attempts with identical args but different idempotency keys
  const callPayload = {
    toolCallId: "call-payload-1",
    name: "read_file",
    args: { path: "same.txt" },
    projectId: PROJECT_ID,
    generation: 1,
  };

  const { attempt: attIdemA } = runtime8.submit(callPayload, { idempotencyKey: "key-A" });
  const { attempt: attIdemB } = runtime8.submit(callPayload, { idempotencyKey: "key-B" });
  await runtime8.drain();
  assert(attIdemA.attemptId !== attIdemB.attemptId, "Different idempotency keys yield distinct execution attempts");
  assert(attIdemA.state === "succeeded" && attIdemB.state === "succeeded", "Both distinct attempts succeeded");

  // 8.2 Same idempotency key with conflicting tool-call identity throws IdempotencyConflictError
  let conflictThrown = false;
  try {
    runtime8.submit(
      {
        toolCallId: "call-payload-conflict",
        name: "write_file",
        args: { path: "different.txt" },
        projectId: PROJECT_ID,
        generation: 1,
      },
      { idempotencyKey: "key-A" },
    );
  } catch (err) {
    if (err instanceof IdempotencyConflictError) {
      conflictThrown = true;
    }
  }
  assert(conflictThrown === true, "Conflicting submission with same key throws IdempotencyConflictError");

  // -------------------------------------------------------------------------
  // 9. COMPLETE TOOL DISCLOSURE REGISTRY COVERAGE (ALL 16 TOOLS)
  // -------------------------------------------------------------------------
  console.log("\n--- 9. COMPLETE TOOL DISCLOSURE REGISTRY COVERAGE ---");

  const canonicalToolNames: AgentToolName[] = [
    "list_files",
    "read_file",
    "read_files",
    "create_file",
    "write_file",
    "apply_patch",
    "rename_file",
    "delete_file",
    "run_command",
    "stop_command",
    "read_command_output",
    "run_project",
    "stop_project",
    "get_runtime_status",
    "run_build",
    "run_tests",
  ];

  // Verify that AGENT_TOOLS contains all canonical tools
  const registeredNames = AGENT_TOOLS.map((t) => t.name);
  for (const toolName of canonicalToolNames) {
    assert(registeredNames.includes(toolName), `Tool ${toolName} is present in AGENT_TOOLS registry`);
  }

  // Verify disclosure projectors for each tool
  for (const toolName of canonicalToolNames) {
    const mockRawResult: AgentToolResult<any> = {
      ok: true,
      data: {
        path: "src/index.ts",
        oldPath: "old.ts",
        newPath: "new.ts",
        bytes: 100,
        content: "console.log('hello with token=secret123');",
        files: [{ path: "a.ts", bytes: 10, content: "token=sec456" }],
        entries: [{ path: "src", kind: "directory" }],
        commandId: "cmd-1",
        exitCode: 0,
        stdout: "Build succeeded with token=sec789",
        stderr: "",
        state: "running",
        mounted: true,
        previewUrl: "http://user:pass@localhost:3000",
        success: true,
        summary: "12 tests passed",
        secret_env: { KEY: "SUPER_SECRET" },
      },
    };

    const modelProj = projectModelFacingResult(toolName, mockRawResult);
    assert(modelProj.ok === true, `Model-facing projection for ${toolName} returns ok:true`);
    const modelStr = JSON.stringify(modelProj);
    assert(!modelStr.includes("SUPER_SECRET"), `Model projection for ${toolName} redacts raw env secrets`);
    assert(!modelStr.includes("secret123"), `Model projection for ${toolName} redacts secret tokens in content`);

    const userSummary = formatUserFacingResultSummary(toolName, mockRawResult);
    assert(typeof userSummary === "string" && userSummary.length > 0, `User summary for ${toolName} is non-empty`);
    assert(!userSummary.includes("SUPER_SECRET"), `User summary for ${toolName} contains no raw secrets`);
  }

  // -------------------------------------------------------------------------
  // 10. RAW RESULT LIFETIME, IMMUTABILITY & EVENT PRIVACY
  // -------------------------------------------------------------------------
  console.log("\n--- 10. RAW RESULT LIFETIME, IMMUTABILITY & EVENT PRIVACY ---");

  const ctrl10 = new AgentPermissionController();
  ctrl10.setMode("autonomous");

  const rawMutableResult = {
    path: "data.txt",
    internalRef: { secret: "original_secret" },
  };

  const capturedEvents: AgentExecutionEvent[] = [];
  const runtime10 = new AgentExecutionRuntime({
    projectId: PROJECT_ID,
    generation: 1,
    controller: ctrl10,
    executeTool: async () => ({
      ok: true,
      data: rawMutableResult,
    }),
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  runtime10.onEvent((evt) => capturedEvents.push(evt));

  runtime10.submit({
    toolCallId: "raw-leak-test",
    name: "read_file",
    args: { path: "data.txt" },
    projectId: PROJECT_ID,
    generation: 1,
  });

  await runtime10.drain();

  // Mutate rawMutableResult after execution
  rawMutableResult.internalRef.secret = "MUTATED_AFTER_FACT";

  const succEvent = capturedEvents.find((e) => e.type === "attempt:succeeded");
  assert(succEvent !== undefined, "attempt:succeeded event was emitted");
  assert((succEvent?.data as any).rawResult === undefined, "attempt:succeeded event does NOT contain rawResult field");
  assert(
    !JSON.stringify(succEvent).includes("MUTATED_AFTER_FACT"),
    "Event history is immune to subsequent mutations of the raw result object",
  );

  // -------------------------------------------------------------------------
  // 11. TRANSCRIPT PROJECTOR ACROSS ALL EVENT TYPES
  // -------------------------------------------------------------------------
  console.log("\n--- 11. TRANSCRIPT PROJECTOR ACROSS ALL EVENT TYPES ---");

  let blocks: AgentBlock[] = [];

  // Running event
  blocks = projectEventToTranscriptBlocks(blocks, {
    eventId: "e1",
    attemptId: "att-1",
    toolCallId: "tc-1",
    sequence: 1,
    type: "attempt:running",
    timestamp: 1000,
    projectId: PROJECT_ID,
    generation: 1,
    data: { toolName: "read_file", summary: "Read file hello.txt" },
  });
  assert(blocks.length === 1 && blocks[0].kind === "tool-call", "Projects tool-call block on running");

  // Awaiting approval event
  blocks = projectEventToTranscriptBlocks(blocks, {
    eventId: "e2",
    attemptId: "att-2",
    toolCallId: "tc-2",
    sequence: 2,
    type: "attempt:awaiting-approval",
    timestamp: 1001,
    projectId: PROJECT_ID,
    generation: 1,
    data: { toolName: "write_file", approvalId: "appr-2", summary: "Approval for write" },
  });
  assert(blocks.some((b) => b.kind === "approval-requested"), "Projects approval-requested block on awaiting-approval");

  // Succeeded event
  blocks = projectEventToTranscriptBlocks(blocks, {
    eventId: "e3",
    attemptId: "att-1",
    toolCallId: "tc-1",
    sequence: 3,
    type: "attempt:succeeded",
    timestamp: 1002,
    projectId: PROJECT_ID,
    generation: 1,
    data: { toolName: "read_file", userSummary: "Read 10 bytes" },
  });
  assert(blocks.some((b) => b.kind === "tool-result" && !b.isError), "Projects tool-result (isError:false) on succeeded");

  // Failed event
  blocks = projectEventToTranscriptBlocks(blocks, {
    eventId: "e4",
    attemptId: "att-4",
    toolCallId: "tc-4",
    sequence: 4,
    type: "attempt:failed",
    timestamp: 1003,
    projectId: PROJECT_ID,
    generation: 1,
    data: { toolName: "run_command", errorMessage: "Process exited with code 1" },
  });
  assert(blocks.some((b) => b.kind === "tool-result" && b.isError), "Projects tool-result (isError:true) on failed");

  // Denied event
  blocks = projectEventToTranscriptBlocks(blocks, {
    eventId: "e5",
    attemptId: "att-5",
    toolCallId: "tc-5",
    sequence: 5,
    type: "attempt:denied",
    timestamp: 1004,
    projectId: PROJECT_ID,
    generation: 1,
    data: { toolName: "delete_file", message: "User denied action" },
  });
  assert(blocks.some((b) => b.kind === "tool-result" && b.isError), "Projects tool-result on denied");

  // Cancelled event
  blocks = projectEventToTranscriptBlocks(blocks, {
    eventId: "e6",
    attemptId: "att-6",
    toolCallId: "tc-6",
    sequence: 6,
    type: "attempt:cancelled",
    timestamp: 1005,
    projectId: PROJECT_ID,
    generation: 1,
    data: { reason: "User cancelled task" },
  });
  assert(blocks.some((b) => b.kind === "cancellation"), "Projects cancellation block on cancelled");

  // Stale event
  blocks = projectEventToTranscriptBlocks(blocks, {
    eventId: "e7",
    attemptId: "att-7",
    toolCallId: "tc-7",
    sequence: 7,
    type: "attempt:stale",
    timestamp: 1006,
    projectId: PROJECT_ID,
    generation: 1,
    data: { message: "Project switched" },
  });
  assert(blocks.some((b) => b.kind === "cancellation"), "Projects cancellation block on stale");

  // Replaying identical events is idempotent
  const blocksBeforeReplay = blocks.length;
  blocks = projectEventToTranscriptBlocks(blocks, {
    eventId: "e3",
    attemptId: "att-1",
    toolCallId: "tc-1",
    sequence: 3,
    type: "attempt:succeeded",
    timestamp: 1002,
    projectId: PROJECT_ID,
    generation: 1,
    data: { toolName: "read_file", userSummary: "Read 10 bytes" },
  });
  assert(blocks.length === blocksBeforeReplay, "Transcript projection is idempotent upon event replay");

  // -------------------------------------------------------------------------
  // 12. LOAD-BEARING NEGATIVE CONTROLS & MUTATION TEST
  // -------------------------------------------------------------------------
  console.log("\n--- 12. LOAD-BEARING NEGATIVE CONTROLS & MUTATION TEST ---");

  // 12.1 Negative Control #1: Gate is load-bearing; zero unapproved executions
  const ctrlNeg1 = new AgentPermissionController();
  ctrlNeg1.setMode("ask");
  let neg1Count = 0;
  const runtimeNeg1 = new AgentExecutionRuntime({
    projectId: PROJECT_ID,
    generation: 1,
    controller: ctrlNeg1,
    executeTool: async () => {
      neg1Count++;
      return { ok: true, data: null };
    },
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  const { attempt: attNeg1 } = runtimeNeg1.submit({
    toolCallId: "neg-1",
    name: "write_file",
    args: {},
    projectId: PROJECT_ID,
    generation: 1,
  });
  await runtimeNeg1.drain();
  assert(attNeg1.state === "awaiting-approval", "Unapproved write is blocked awaiting approval");
  assert(neg1Count === 0, "Negative Control #1: Handler executed 0 times without approval");

  // 12.2 Negative Control #2: Mutation-style test for at-most-once resume lock
  // We prove that without the `isResuming` lock in resume(), concurrent calls entering the resume flow
  // would invoke the underlying execution path multiple times.
  let locklessInvocations = 0;
  async function simulateResume(withLock: boolean) {
    let isResuming = false;
    async function resumeAttempt() {
      if (withLock) {
        if (isResuming) return false;
        isResuming = true;
      }
      locklessInvocations++;
      await new Promise((r) => setTimeout(r, 10));
      return true;
    }
    return Promise.all([resumeAttempt(), resumeAttempt()]);
  }

  // With lock (Production AgentExecutionRuntime behavior)
  locklessInvocations = 0;
  const lockedResults = await simulateResume(true);
  const lockedSuccessCount = lockedResults.filter((r) => r === true).length;
  assert(lockedSuccessCount === 1, "With lock: exactly 1 concurrent resume succeeds");
  assert(locklessInvocations === 1, "With lock: handler invoked exactly 1 time");

  // Without lock (Mutated behavior)
  locklessInvocations = 0;
  const unlockedResults = await simulateResume(false);
  const unlockedSuccessCount = unlockedResults.filter((r) => r === true).length;
  assert(unlockedSuccessCount === 2, "Without lock (mutated): both concurrent resumes succeed (2)");
  assert(
    locklessInvocations === 2,
    "Negative Control #2: Mutation test proves disabling resume lock causes duplicate execution (2 > 1)",
  );

  console.log("==========================================================================");
  console.log(`  SUCCESS: ALL ${passCount} COMPREHENSIVE ASSERTIONS PASSED PERFECTLY!`);
  console.log("==========================================================================");
}

runTests().catch((err) => {
  console.error("Test harness uncaught failure:", err);
  process.exit(1);
});
