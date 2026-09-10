import assert from "node:assert/strict";
import { devboxBroker } from "../lib/server/devbox-broker";

async function main() {
  console.log("=== RUNNING DEVBOX PROCESS-AWARE IDLE DETECTION TESTS ===");

  const projectId = "test-project-idle-proc-1";
  const userId = "test-user-idle-1";

  await devboxBroker.getOrCreateDevbox(projectId, userId, "pro");

  // 1. Initial Fresh State (Active by timestamp)
  console.log("--- 1. Fresh Container State ---");
  assert.equal(devboxBroker.isContainerActivelyWorking(projectId), true, "Fresh session is active");
  console.log("[PASS] Fresh session marked active.");

  // 2. Active Child Process (Build / Dev Server)
  console.log("--- 2. Active Child Process Inspection ---");
  const session = (devboxBroker as any).sessions.get(projectId);
  assert.ok(session);

  // Simulate elapsed idle time past 10m
  session.lastActiveTimestamp = Date.now() - 15 * 60 * 1000;

  // With running child process (e.g. npm install), it must remain actively working
  session.activeChildProcesses = ["npm install --verbose"];
  assert.equal(
    devboxBroker.isContainerActivelyWorking(projectId),
    true,
    "Container with active running build is NOT marked idle",
  );
  console.log("[PASS] Long-running build prevents container from stopping prematurely.");

  // 3. True Idle State
  console.log("--- 3. True Idle State (Quiet Shell) ---");
  session.activeChildProcesses = [];
  assert.equal(
    devboxBroker.isContainerActivelyWorking(projectId),
    false,
    "Quiet shell past timeout is marked idle for graceful stop",
  );
  console.log("[PASS] Silent shell past timeout transitions to idle.");

  console.log("=== ALL PROCESS-AWARE IDLE TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
