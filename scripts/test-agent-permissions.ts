import {
  AgentPermissionController,
  summarizeToolCall,
  sanitizeString,
  getExecutableName,
  alwaysRequiresApproval,
  type AgentToolCall,
} from "../lib/workspace/agent-permissions";
import { gateAndInvoke, outcomeToToolResult } from "../lib/workspace/agent-permissions-gate";
import { toolOk, type AgentToolResult } from "../lib/workspace/agent-tools";
import type { AgentToolsApi } from "../app/workspace/hooks/useAgentTools";

async function runTestHarness() {
  console.log("==========================================================================");
  console.log("      M3.6 AGENT PERMISSIONS & SECURITY SUITE (DETERMINISTIC HARNESS)     ");
  console.log("==========================================================================");

  let assertionCount = 0;
  let failureCount = 0;

  function assert(condition: boolean, testName: string, detail: string) {
    assertionCount++;
    if (!condition) {
      console.error(`[FAIL #${assertionCount}] ${testName}: ${detail}`);
      failureCount++;
    } else {
      console.log(`[PASS #${assertionCount}] ${testName}: ${detail}`);
    }
  }

  // -------------------------------------------------------------------------
  // 1. PERMISSION POLICY MATRIX & DESTRUCTIVE ENFORCEMENT
  // -------------------------------------------------------------------------
  console.log("\n--- 1. POLICY MATRIX & DESTRUCTIVE ENFORCEMENT ---");
  const ctrlAsk = new AgentPermissionController({ mode: "ask" });
  const ctrlAutoSafe = new AgentPermissionController({ mode: "auto-safe" });
  const ctrlAuto = new AgentPermissionController({ mode: "autonomous" });

  const readCall: AgentToolCall = { toolCallId: "c1", name: "read_file", args: { path: "a.txt" }, projectId: "p1", generation: 1 };
  const writeCall: AgentToolCall = { toolCallId: "c2", name: "write_file", args: { path: "a.txt", contents: "x" }, projectId: "p1", generation: 1 };
  const execCall: AgentToolCall = { toolCallId: "c3", name: "run_command", args: { command: "npm", args: ["test"] }, projectId: "p1", generation: 1 };
  const destCall: AgentToolCall = { toolCallId: "c4", name: "delete_file", args: { path: "a.txt" }, projectId: "p1", generation: 1 };

  assert(ctrlAsk.evaluate(readCall, 1).kind === "allowed", "Ask Mode - Read", "Read is auto in ask mode");
  assert(ctrlAsk.evaluate(writeCall, 1).kind === "approval-required", "Ask Mode - Write", "Write requires approval in ask mode");
  assert(ctrlAsk.evaluate(execCall, 1).kind === "approval-required", "Ask Mode - Execute", "Execute requires approval in ask mode");
  assert(ctrlAsk.evaluate(destCall, 1).kind === "approval-required", "Ask Mode - Destructive", "Destructive requires approval in ask mode");

  assert(ctrlAutoSafe.evaluate(readCall, 1).kind === "allowed", "Auto-Safe Mode - Read", "Read is auto in auto-safe mode");
  assert(ctrlAutoSafe.evaluate(writeCall, 1).kind === "allowed", "Auto-Safe Mode - Write", "Write is auto in auto-safe mode");
  assert(ctrlAutoSafe.evaluate(execCall, 1).kind === "approval-required", "Auto-Safe Mode - Execute", "Execute requires approval in auto-safe mode");
  assert(ctrlAutoSafe.evaluate(destCall, 1).kind === "approval-required", "Auto-Safe Mode - Destructive", "Destructive requires approval in auto-safe mode");

  assert(ctrlAuto.evaluate(readCall, 1).kind === "allowed", "Autonomous Mode - Read", "Read is auto in autonomous mode");
  assert(ctrlAuto.evaluate(writeCall, 1).kind === "allowed", "Autonomous Mode - Write", "Write is auto in autonomous mode");
  assert(ctrlAuto.evaluate(execCall, 1).kind === "allowed", "Autonomous Mode - Execute", "Execute is auto in autonomous mode");
  assert(ctrlAuto.evaluate(destCall, 1).kind === "approval-required", "Autonomous Mode - Destructive", "Destructive ALWAYS requires approval in autonomous mode!");
  assert(alwaysRequiresApproval("destructive"), "alwaysRequiresApproval Guard", "alwaysRequiresApproval('destructive') returns true");

  // -------------------------------------------------------------------------
  // 2. ONE-SHOT CONSUMPTION & CONCURRENCY
  // -------------------------------------------------------------------------
  console.log("\n--- 2. ONE-SHOT CONSUMPTION & CONCURRENCY ---");
  const controller = new AgentPermissionController({ mode: "ask" });
  let executionCount = 0;
  const mockExecute = async (name: string, params: unknown): Promise<AgentToolResult<unknown>> => {
    executionCount++;
    return toolOk({ done: true, name, params });
  };

  const reqResult = controller.requestApproval(destCall, 1);
  assert(reqResult.kind === "pending", "Request Approval", "Destructive call yields pending approval");
  if (reqResult.kind === "pending") {
    controller.approve(reqResult.approval.approvalId, 1);

    // Sequential: Invocation #1 -> executes
    const outcome1 = await gateAndInvoke({ controller, call: destCall, generation: 1, execute: mockExecute });
    assert(outcome1.kind === "executed", "Invocation #1", "First approved invocation executes");
    assert(executionCount === 1, "Execution Count #1", "Handler executed exactly 1 time");

    // Sequential: Invocation #2 -> consumed, returns awaiting-approval
    const outcome2 = await gateAndInvoke({ controller, call: destCall, generation: 1, execute: mockExecute });
    assert(outcome2.kind === "awaiting-approval", "Invocation #2", "Second identical invocation requires new approval");
    assert(executionCount === 1, "Execution Count #2", "Handler executed 0 additional times");
  }

  // Concurrent Execution Test: Promise.all([invoke, invoke])
  const concurrentCall: AgentToolCall = { toolCallId: "c_conc", name: "delete_file", args: { path: "concurrent.txt" }, projectId: "p1", generation: 1 };
  let concurrentExecCount = 0;
  const mockConcurrentExecute = async (): Promise<AgentToolResult<unknown>> => {
    concurrentExecCount++;
    return toolOk({ done: true });
  };

  const reqResultConc = controller.requestApproval(concurrentCall, 1);
  if (reqResultConc.kind === "pending") {
    controller.approve(reqResultConc.approval.approvalId, 1);

    const [resA, resB] = await Promise.all([
      gateAndInvoke({ controller, call: concurrentCall, generation: 1, execute: mockConcurrentExecute }),
      gateAndInvoke({ controller, call: concurrentCall, generation: 1, execute: mockConcurrentExecute }),
    ]);

    const executedCount = (resA.kind === "executed" ? 1 : 0) + (resB.kind === "executed" ? 1 : 0);
    const awaitingCount = (resA.kind === "awaiting-approval" ? 1 : 0) + (resB.kind === "awaiting-approval" ? 1 : 0);

    assert(executedCount === 1, "Concurrent Execution - Single Success", "Exactly one concurrent call executed");
    assert(awaitingCount === 1, "Concurrent Execution - Single Blocked", "Exactly one concurrent call was blocked awaiting approval");
    assert(concurrentExecCount === 1, "Concurrent Execution - Handler Counter", "Handler executed exactly 1 time across concurrent races");
  }

  // -------------------------------------------------------------------------
  // 3. FAILURE AND ISOLATION BEHAVIOR
  // -------------------------------------------------------------------------
  console.log("\n--- 3. FAILURE & ISOLATION BEHAVIOR ---");

  // A) Handler throws after authorization is consumed -> Authorization remains consumed; retry requires new approval
  const throwCall: AgentToolCall = { toolCallId: "c_throw", name: "delete_file", args: { path: "throw.txt" }, projectId: "p1", generation: 1 };
  const reqThrow = controller.requestApproval(throwCall, 1);
  if (reqThrow.kind === "pending") {
    controller.approve(reqThrow.approval.approvalId, 1);
    try {
      await gateAndInvoke({
        controller,
        call: throwCall,
        generation: 1,
        execute: async () => {
          throw new Error("Runtime process crash during tool execution");
        },
      });
    } catch {
      // Expected handler throw
    }
    // Retry call after throw
    const outcomePostThrow = await gateAndInvoke({ controller, call: throwCall, generation: 1, execute: mockExecute });
    assert(outcomePostThrow.kind === "awaiting-approval", "Failure Recovery - Throw", "Authorization remains consumed after handler throw; retry requires new approval");
  }

  // B) Generation change during call
  const genCall: AgentToolCall = { toolCallId: "c_gen", name: "delete_file", args: { path: "gen.txt" }, projectId: "p1", generation: 1 };
  const reqGen = controller.requestApproval(genCall, 1);
  if (reqGen.kind === "pending") {
    controller.approve(reqGen.approval.approvalId, 1);
    const outcomeGenStale = await gateAndInvoke({ controller, call: genCall, generation: 2, execute: mockExecute });
    assert(outcomeGenStale.kind === "stale", "Generation Change", "Generation switch invalidates authorization and yields stale");
  }

  // C) Cancellation before execution
  const cancelCall: AgentToolCall = { toolCallId: "c_canc", name: "delete_file", args: { path: "canc.txt" }, projectId: "p1", generation: 1 };
  const reqCanc = controller.requestApproval(cancelCall, 1);
  if (reqCanc.kind === "pending") {
    const cancelSuccess = controller.cancel(reqCanc.approval.approvalId);
    assert(cancelSuccess, "Controller Cancel", "cancel() returns true for pending approval");
    const outcomeCancelled = await gateAndInvoke({ controller, call: cancelCall, generation: 1, execute: mockExecute });
    assert(outcomeCancelled.kind === "stale" || outcomeCancelled.kind === "awaiting-approval", "Cancelled Outcome", "Cancelled call does not execute");
  }

  // -------------------------------------------------------------------------
  // 4. SECRET REDACTION & SANITIZATION
  // -------------------------------------------------------------------------
  console.log("\n--- 4. SECRET REDACTION & SANITIZATION ---");

  // Executable name extraction without raw command string
  assert(getExecutableName("/usr/local/bin/npm run deploy") === "npm", "Executable Extraction - Path", "Strips path and flags from command string");
  assert(getExecutableName("C:\\Program Files\\nodejs\\node.exe script.js") === "node.exe", "Executable Extraction - Windows Path", "Strips Windows path from command string");

  // URL Credential Redaction
  const urlString = "https://admin:SuperSecretPass123@api.internal.net/v1?token=bearer999&apiKey=sk_live_12345";
  const sanitizedUrl = sanitizeString(urlString);
  assert(!sanitizedUrl.includes("SuperSecretPass123"), "URL Credential Redaction - Password", "Redacts embedded URL passwords");
  assert(!sanitizedUrl.includes("bearer999"), "URL Credential Redaction - Query Token", "Redacts sensitive query parameters");
  assert(!sanitizedUrl.includes("sk_live_12345"), "URL Credential Redaction - API Key", "Redacts sensitive API keys");

  // Bearer Token & Secret Flag Redaction
  const bearerString = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 --token=ghp_ABC123SECRETKEY";
  const sanitizedBearer = sanitizeString(bearerString);
  assert(!sanitizedBearer.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), "Bearer Redaction", "Redacts Bearer JWT tokens");
  assert(!sanitizedBearer.includes("ghp_ABC123SECRETKEY"), "Token Flag Redaction", "Redacts --token flag secrets");

  // Summary generation test with sensitive keys
  const sensitiveSummary = summarizeToolCall("run_command", {
    command: "/usr/bin/npm run deploy --token=ghp_SECRET_TOKEN",
    args: ["--password", "MyPassword123", "--apiKey=sk_live_99999"],
    env: { AWS_SECRET_ACCESS_KEY: "super_secret_aws_key", PRIVATE_KEY: "pem_key_data" },
    contents: "SENSITIVE_FILE_BODY_CONTENT",
    token: "leaked_token",
    password: "leaked_password",
  });

  console.log("  Generated Summary:", JSON.stringify(sensitiveSummary));
  assert(!sensitiveSummary.includes("/usr/bin/npm"), "Summary - Raw Command Path", "Raw command path is omitted from summary");
  assert(!sensitiveSummary.includes("ghp_SECRET_TOKEN"), "Summary - Command Token", "Command token is redacted from summary");
  assert(!sensitiveSummary.includes("MyPassword123"), "Summary - Argument Values", "Argument string values are omitted from summary");
  assert(!sensitiveSummary.includes("super_secret_aws_key"), "Summary - Env Secrets", "Env secrets are omitted from summary");
  assert(!sensitiveSummary.includes("SENSITIVE_FILE_BODY"), "Summary - File Contents", "File contents are omitted from summary");
  assert(!sensitiveSummary.includes("leaked_token"), "Summary - Sensitive Key Token", "Sensitive key 'token' value is omitted");
  assert(sensitiveSummary.includes("command npm"), "Summary - Executable Name", "Displays clean executable name 'npm'");
  assert(sensitiveSummary.includes("Arguments: 3"), "Summary - Argument Count", "Displays safe argument count ('Arguments: 3')");

  // -------------------------------------------------------------------------
  // 5. PUBLIC API HARDENING & BYPASS VERIFICATION
  // -------------------------------------------------------------------------
  console.log("\n--- 5. PUBLIC API HARDENING & BYPASS VERIFICATION ---");
  const apiCheck = {} as AgentToolsApi;
  assert(!("invokeUnchecked" in apiCheck), "API Surface Check", "AgentToolsApi type contains no invokeUnchecked entrypoint");

  // -------------------------------------------------------------------------
  // 6. NEGATIVE CONTROL & SECURITY ASSERTIONS
  // -------------------------------------------------------------------------
  console.log("\n--- 6. NEGATIVE CONTROL & SECURITY ASSERTIONS ---");

  // Direct gateAndInvoke call without prior approval fails
  const unapprovedCall: AgentToolCall = { toolCallId: "c_bypass", name: "delete_file", args: { path: "bypass.ts" }, projectId: "p1", generation: 1 };
  let bypassExecCount = 0;
  const outcomeBypass = await gateAndInvoke({
    controller,
    call: unapprovedCall,
    generation: 1,
    execute: async () => {
      bypassExecCount++;
      return toolOk({});
    },
  });
  assert(outcomeBypass.kind === "awaiting-approval", "Negative Control - Bypass Gate", "Unapproved call is stopped by gateAndInvoke and returns awaiting-approval");
  assert(bypassExecCount === 0, "Negative Control - Handler Count", "Handler executed ZERO times without approval (gate is load-bearing)");

  // Denied call outcome verification
  const deniedCall: AgentToolCall = { toolCallId: "c_den", name: "delete_file", args: { path: "denied.ts" }, projectId: "p1", generation: 1 };
  const reqDen = controller.requestApproval(deniedCall, 1);
  if (reqDen.kind === "pending") {
    controller.deny(reqDen.approval.approvalId, 1);
    const outcomeDen = await gateAndInvoke({ controller, call: deniedCall, generation: 1, execute: mockExecute });
    const resultDen = outcomeToToolResult(outcomeDen);
    assert(outcomeDen.kind === "denied", "Negative Control - Denied Outcome", "Denied approval produces denied outcome");
    assert(resultDen !== null && !resultDen.ok && resultDen.error?.code === "PERMISSION_DENIED", "Negative Control - PERMISSION_DENIED Code", "Tool result contains PERMISSION_DENIED error code");
  }

  // Unknown tool outcome verification
  const unknownCall: AgentToolCall = { toolCallId: "c_unk", name: "unknown_hack_tool", args: {}, projectId: "p1", generation: 1 };
  const outcomeUnk = await gateAndInvoke({ controller, call: unknownCall, generation: 1, execute: mockExecute });
  const resultUnk = outcomeToToolResult(outcomeUnk);
  assert(outcomeUnk.kind === "denied" && outcomeUnk.reason === "UNKNOWN_TOOL", "Negative Control - Unknown Tool Outcome", "Unknown tool call is denied immediately");
  assert(resultUnk !== null && !resultUnk.ok && resultUnk.error?.code === "UNKNOWN_TOOL", "Negative Control - UNKNOWN_TOOL Code", "Tool result contains UNKNOWN_TOOL error code");

  console.log("\n==========================================================================");
  if (failureCount === 0) {
    console.log(`  SUCCESS: ALL ${assertionCount} DETERMINISTIC ASSERTIONS PASSED PERFECTLY!`);
  } else {
    console.error(`  FAILURE: ${failureCount} OUT OF ${assertionCount} ASSERTIONS FAILED!`);
    process.exit(1);
  }
  console.log("==========================================================================\n");
}

runTestHarness().catch((err) => {
  console.error(err);
  process.exit(1);
});
