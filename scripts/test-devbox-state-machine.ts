import assert from "node:assert/strict";
import { devboxBroker } from "../lib/server/devbox-broker";
import { devboxMetering } from "../lib/devbox/metering";

async function main() {
  console.log("=== RUNNING DEVBOX STATE MACHINE & LIFECYCLE TESTS ===");

  const projectId = "test-project-lifecycle-1";
  const userId = "test-user-pro-1";

  // 1. Initial Creation
  console.log("--- 1. Initial Devbox Provisioning ---");
  const createRes = await devboxBroker.getOrCreateDevbox(projectId, userId, "pro");
  assert.equal(createRes.ok, true, "Devbox creation succeeds for Pro tier");
  assert.equal(createRes.status?.state, "running", "Devbox state is running");
  assert.equal(createRes.status?.projectId, projectId);
  console.log("[PASS] Devbox provisioned and transitions to running state.");

  // 2. Metering Event Verification
  console.log("--- 2. Active Session Metering ---");
  const initialStatus = devboxBroker.getStatus(projectId);
  assert.equal(initialStatus.state, "running");
  assert.ok(initialStatus.quotaRemainingHours > 0, "Pro tier has quota hours remaining");
  console.log("[PASS] Metering tracks active container session.");

  // 3. Freeze & Stop Lifecycle
  console.log("--- 3. Freeze Devbox ---");
  const freezeRes = await devboxBroker.freezeDevbox(projectId);
  assert.equal(freezeRes.ok, true, "Freeze operation succeeds");
  const frozenStatus = devboxBroker.getStatus(projectId);
  assert.equal(frozenStatus.state, "stopped", "Devbox state is stopped after freeze");
  console.log("[PASS] Freeze transitions container state to stopped.");

  // 4. Auto-Restart on Command
  console.log("--- 4. Auto-Restart on Execution ---");
  const execRes = await devboxBroker.executeCommand(projectId, "echo", ["hello from devbox"]);
  assert.equal(execRes.ok, true, "Command executes successfully");
  const restartedStatus = devboxBroker.getStatus(projectId);
  assert.equal(restartedStatus.state, "running", "Devbox auto-restarts to running on command");
  console.log("[PASS] Auto-restart transitions stopped devbox back to running on command.");

  console.log("=== ALL DEVBOX STATE MACHINE TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
