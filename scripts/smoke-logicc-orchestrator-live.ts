/**
 * Live Logicc orchestrator smoke: stream → tool call → M3.6 approval →
 * execute once → continuation → final response. Localhost only.
 * Never prints credentials or raw upstream payloads.
 *
 * Manual/local-only — not part of npm test / CI.
 * executeTool is an in-memory stub (no filesystem writes).
 */

import { AgentOrchestrator } from "../lib/workspace/agent-orchestrator";
import { HttpAgentTransport } from "../lib/workspace/agent-http-transport";
import { AgentExecutionRuntime } from "../lib/workspace/agent-execution-runtime";
import { AgentPermissionController } from "../lib/workspace/agent-permissions";
import type { AgentToolResult } from "../lib/workspace/agent-tools";

function requireLoopbackBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SMOKE_BASE_URL must be a valid loopback URL");
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (!allowed || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error("Smoke helpers may only target loopback hosts (127.0.0.1/localhost/::1)");
  }
  return url.origin;
}

const BASE = requireLoopbackBase(process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000");
const MODEL = process.env.SMOKE_MODEL_ID ?? "azure/gpt-4o-mini";

function assertNoSecret(label: string, value: unknown): void {
  const key = process.env.LOGICC_API_KEY ?? "";
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (key && serialized.includes(key)) {
    throw new Error(`Credential leaked into ${label}`);
  }
}

async function waitForState(
  orchestrator: AgentOrchestrator,
  predicate: (state: string) => boolean,
  timeoutMs = 60000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = orchestrator.getState();
    if (predicate(current)) return current;
    await new Promise((r) => setTimeout(r, 25));
  }
  return orchestrator.getState();
}

async function main(): Promise<void> {
  console.log("===== LOGICC LIVE ORCHESTRATOR SMOKE =====");
  console.log(`base=${BASE} model=${MODEL}`);

  // Object counter avoids TS control-flow narrowing after pre-approval checks.
  const counters = { toolExecuted: 0 };
  const permissionCtrl = new AgentPermissionController();
  permissionCtrl.setMode("ask");

  const runtime = new AgentExecutionRuntime({
    projectId: "proj-logicc-live",
    generation: 1,
    controller: permissionCtrl,
    executeTool: async (name): Promise<AgentToolResult<unknown>> => {
      counters.toolExecuted += 1;
      console.log(`tool_execute name=${name} count=${counters.toolExecuted}`);
      // In-memory stub only — does not write project files.
      return { ok: true, data: { path: "smoke-live.txt", written: true, stub: true } };
    },
    scheduleDrain: (fn) => queueMicrotask(fn),
  });

  const transport = new HttpAgentTransport({
    endpoint: `${BASE}/api/agent/stream`,
    credentialMode: "server-owned",
    getModel: () => MODEL,
  });

  const orchestrator = new AgentOrchestrator({
    projectId: "proj-logicc-live",
    generation: 1,
    runtime,
    transport,
  });

  orchestrator.submitRun(
    'Call write_file exactly once with path "smoke-live.txt" and contents "hello-logicc". Do not ask questions.',
  );

  const afterTurn1 = await waitForState(
    orchestrator,
    (s) => s === "waiting-for-approval" || s === "failed" || s === "completed",
    90000,
  );
  console.log(`state_after_turn1=${afterTurn1}`);
  if (afterTurn1 === "failed") {
    assertNoSecret("messages-on-fail", orchestrator.getMessages());
    console.error("LIVE_ORCH:FAILED turn1");
    process.exit(1);
  }

  if (afterTurn1 !== "waiting-for-approval") {
    console.error("LIVE_ORCH:FAILED expected waiting-for-approval for write_file");
    process.exit(1);
  }

  const pending = permissionCtrl.getPending();
  console.log(`pending_approvals=${pending.length}`);
  if (pending.length !== 1) {
    console.error("LIVE_ORCH:FAILED expected one approval");
    process.exit(1);
  }
  if (counters.toolExecuted !== 0) {
    console.error("LIVE_ORCH:FAILED tool ran before approval");
    process.exit(1);
  }
  console.log("pre_approval_executions=0");
  permissionCtrl.approve(pending[0].approvalId, 1);
  const active = runtime.getActiveHead();
  if (!active) {
    console.error("LIVE_ORCH:FAILED missing active attempt");
    process.exit(1);
  }
  await runtime.resume(active.attemptId);

  const afterTurn2 = await waitForState(
    orchestrator,
    (s) => s === "completed" || s === "failed",
    90000,
  );
  console.log(`state_after_turn2=${afterTurn2}`);
  const toolCount: number = counters.toolExecuted;
  console.log(`tool_executed=${toolCount}`);

  const messages = orchestrator.getMessages();
  assertNoSecret("messages", messages);
  console.log(`message_count=${messages.length}`);
  console.log(`roles=${messages.map((m) => m.role).join(",")}`);

  const ok =
    afterTurn2 === "completed" &&
    toolCount === 1 &&
    messages.some((m) => m.role === "tool") &&
    messages.filter((m) => m.role === "assistant").length >= 2;

  if (!ok) {
    console.error("LIVE_ORCH:FAILED workflow incomplete");
    process.exit(1);
  }

  console.log("LIVE_ORCH:PASSED");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : "unknown";
  console.error(`LIVE_ORCH:FAILED — ${msg}`);
  process.exit(1);
});
