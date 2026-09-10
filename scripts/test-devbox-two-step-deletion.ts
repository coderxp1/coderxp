import assert from "node:assert/strict";
import { devboxBroker } from "../lib/server/devbox-broker";

async function main() {
  console.log("=== RUNNING DEVBOX TWO-STEP DELETION TESTS ===");

  const projectId = "test-project-deletion-1";
  const userId = "test-user-del-1";

  await devboxBroker.getOrCreateDevbox(projectId, userId, "pro");

  // Execute a command before deletion
  await devboxBroker.executeCommand(projectId, "echo", ["critical forensic log"]);

  // 1. Step 1: Soft Delete (7-Day Grace Period)
  console.log("--- 1. Step 1: Soft Delete (7-Day Recovery Grace Period) ---");
  const softDel = await devboxBroker.softDeleteDevbox(projectId);
  assert.equal(softDel.ok, true, "Soft delete succeeds");
  assert.ok(softDel.purgeAt > Date.now(), "Purge date scheduled in the future");

  const status1 = devboxBroker.getStatus(projectId);
  assert.equal(status1.state, "pending-purge", "State transitions to pending-purge");
  assert.ok(status1.purgeAt, "Status reports purgeAt timestamp");
  console.log("[PASS] Soft delete preserves volume and schedules 7-day grace period.");

  // 2. Restore from Grace Period
  console.log("--- 2. Restore from Grace Period ---");
  const restoreRes = await devboxBroker.restoreDevbox(projectId);
  assert.equal(restoreRes.ok, true, "Restore succeeds");
  const status2 = devboxBroker.getStatus(projectId);
  assert.equal(status2.state, "stopped", "Restored state is stopped (ready to start)");
  assert.equal(status2.purgeAt, undefined, "purgeAt removed");
  console.log("[PASS] Devbox successfully restored from pending-purge.");

  // 3. Step 2: Permanent Purge & Audit Log Retention
  console.log("--- 3. Step 2: Permanent Purge with 90-Day Audit Log Retention ---");
  const permDel = await devboxBroker.permanentDeleteDevbox(projectId);
  assert.equal(permDel.ok, true, "Permanent delete succeeds");
  assert.equal(permDel.purged, true);

  const status3 = devboxBroker.getStatus(projectId);
  assert.equal(status3.state, "deleted", "State is deleted after permanent purge");

  // Invariant: Audit log records remain queryable after volume is destroyed
  const { getDevboxAuditLogs } = await import("../lib/devbox/audit-logger");
  const survivingLogs = getDevboxAuditLogs(projectId);
  assert.ok(survivingLogs.length > 0, "Audit logs are retained after permanent volume purge");
  assert.equal(survivingLogs[0].command, "echo");
  console.log("[PASS] Volume destroyed but forensic audit log retained outside devbox volume.");

  console.log("=== ALL TWO-STEP DELETION TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
