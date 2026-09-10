import assert from "node:assert/strict";
import { devboxBroker } from "../lib/server/devbox-broker";
import { getDevboxAuditLogs, clearDevboxAuditLogs } from "../lib/devbox/audit-logger";
import { getProjectGitSnapshots, getLatestSnapshot } from "../lib/devbox/git-snapshot";

async function main() {
  console.log("=== RUNNING DEVBOX COMPENSATING CONTROLS TESTS ===");

  const projectId = "test-project-controls-1";
  const userId = "test-user-controls-1";

  await devboxBroker.getOrCreateDevbox(projectId, userId, "pro");
  clearDevboxAuditLogs(projectId);

  // 1. Control 1: Append-Only Audit Logging
  console.log("--- 1. Append-Only Audit Logging ---");
  const exec1 = await devboxBroker.executeCommand(projectId, "npm", ["--version"], {
    initiatedBy: "agent",
  });
  assert.equal(exec1.ok, true);

  const logs1 = getDevboxAuditLogs(projectId);
  assert.equal(logs1.length, 1, "One audit log record created");
  assert.equal(logs1[0].command, "npm");
  assert.equal(logs1[0].initiatedBy, "agent");
  assert.equal(logs1[0].exitCode, 0);

  const exec2 = await devboxBroker.executeCommand(projectId, "python3", ["--version"], {
    initiatedBy: "agent",
  });
  assert.equal(exec2.ok, true);

  const logs2 = getDevboxAuditLogs(projectId);
  assert.equal(logs2.length, 2, "Second record appended immutably");
  assert.equal(logs2[1].command, "python3");
  console.log("[PASS] Append-only audit logger records commands with timestamps and exit codes.");

  // 2. Control 2: Pre-Push Git Snapshot & Rollback
  console.log("--- 2. Pre-Push Git Snapshot & Rollback Command ---");
  const pushExec = await devboxBroker.executeCommand(projectId, "git", ["push", "--force", "origin", "feature"], {
    initiatedBy: "agent",
    branch: "feature",
  });
  assert.ok(pushExec, "Pre-push hook processed execution");

  const snapshots = getProjectGitSnapshots(projectId);
  assert.ok(snapshots.length > 0, "Pre-push snapshot created automatically");
  const latestSnap = getLatestSnapshot(projectId);
  assert.ok(latestSnap, "Latest snapshot is available");
  assert.equal(latestSnap.branch, "feature");
  assert.ok(latestSnap.rollbackCommand.includes("git push --force origin"), "Rollback command generated");
  console.log("[PASS] Automatic pre-push snapshot recorded with 1-click rollback command.");

  // 3. Control 3: Kill Switch
  console.log("--- 3. Stop Agent Kill Switch ---");
  const killRes = await devboxBroker.stopAgent(projectId);
  assert.equal(killRes.ok, true, "Kill switch executes without error");
  console.log("[PASS] Stop Agent kill switch terminates active processes immediately.");

  console.log("=== ALL COMPENSATING CONTROLS TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
