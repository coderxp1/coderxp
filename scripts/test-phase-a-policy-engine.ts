import assert from "node:assert/strict";
import { actionPolicyEngine } from "../lib/devbox/action-policy";
import { devboxCredentialGate } from "../lib/server/devbox-credential-gate";

async function main() {
  console.log("=== RUNNING PHASE A: 5-TIER ACTION POLICY & CREDENTIAL GATE TESTS ===");

  const projectId = "test-phase-a-policy-proj";
  const dummyPat = "ghp_11AABCDEF0123456789abcdef0123456789abcdef";

  // 1. T0 Free Tier Actions
  console.log("--- 1. T0 Free Tier Classification ---");
  const readDecision = actionPolicyEngine.evaluateAction({ type: "fs_read" });
  assert.equal(readDecision.tier, "T0");
  assert.equal(readDecision.allowed, true);
  assert.equal(readDecision.requiresApproval, false);

  const testDecision = actionPolicyEngine.evaluateAction({ type: "exec_cmd", command: "npm", args: ["test"] });
  assert.equal(testDecision.tier, "T0");
  assert.equal(testDecision.allowed, true);
  console.log("[PASS] T0 actions auto-execute without approval.");

  // 2. T1 Logged Actions
  console.log("--- 2. T1 Logged Tier Classification ---");
  const writeDecision = actionPolicyEngine.evaluateAction({ type: "fs_write" });
  assert.equal(writeDecision.tier, "T1");
  assert.equal(writeDecision.allowed, true);

  const installDecision = actionPolicyEngine.evaluateAction({ type: "exec_cmd", command: "npm", args: ["install", "lodash"] });
  assert.equal(installDecision.tier, "T1");
  assert.equal(installDecision.allowed, true);
  console.log("[PASS] T1 actions auto-execute and log to timeline.");

  // 3. T2 Notify Actions (Feature branch push)
  console.log("--- 3. T2 Notify Tier Classification ---");
  const featPushDecision = actionPolicyEngine.evaluateAction({
    type: "git_push",
    branch: "feature/user-auth",
    isDefaultBranch: false,
  });
  assert.equal(featPushDecision.tier, "T2");
  assert.equal(featPushDecision.allowed, true);
  assert.equal(featPushDecision.undoable, true);
  console.log("[PASS] Feature branch push executes at T2 with 1-click rollback.");

  // 4. T3 Approval Gate (Push to default branch or force-push)
  console.log("--- 4. T3 Approval Gate (Main Branch & Force Push) ---");
  const mainPushReq = {
    type: "git_push" as const,
    branch: "main",
    isDefaultBranch: true,
  };
  const mainPushDecision = actionPolicyEngine.evaluateAction(mainPushReq);
  assert.equal(mainPushDecision.tier, "T3");
  assert.equal(mainPushDecision.allowed, false);
  assert.equal(mainPushDecision.requiresApproval, true);

  // Credential gate MUST refuse credentials when not approved
  const credsBlocked = devboxCredentialGate.requestGitCredentials(projectId, mainPushReq, dummyPat);
  assert.equal(credsBlocked.allowed, false, "Credentials NOT released without approval");
  assert.equal(credsBlocked.pat, undefined);
  assert.ok(credsBlocked.error?.includes("APPROVAL_REQUIRED"));

  // Grant approval
  devboxCredentialGate.grantApproval(projectId, "main", "single");
  const credsAllowed = devboxCredentialGate.requestGitCredentials(projectId, mainPushReq, dummyPat);
  assert.equal(credsAllowed.allowed, true, "Credentials released after approval");
  assert.equal(credsAllowed.pat, dummyPat);
  console.log("[PASS] T3 push blocked until approval; credential released securely once approved.");

  // 5. T4 Hard Gate (Billing & Account Actions)
  console.log("--- 5. T4 Hard Gate (Billing) ---");
  const billingDecision = actionPolicyEngine.evaluateAction({ type: "billing" });
  assert.equal(billingDecision.tier, "T4");
  assert.equal(billingDecision.requiresApproval, true);
  assert.equal(billingDecision.requiresTypedConfirmation, true);
  console.log("[PASS] T4 billing actions require typed confirmation.");

  // 6. untrustedContext Elevation (+1 Tier)
  console.log("--- 6. Untrusted Context Tier Elevation ---");
  const elevatedFeatPush = actionPolicyEngine.evaluateAction({
    type: "git_push",
    branch: "feature/untrusted-patch",
    isDefaultBranch: false,
    untrustedContext: true, // Elevates T2 -> T3
  });
  assert.equal(elevatedFeatPush.tier, "T3", "T2 elevated to T3 when processing untrusted input");
  assert.equal(elevatedFeatPush.requiresApproval, true);
  console.log("[PASS] Processing untrusted input elevates T2 to T3 requiring explicit user approval.");

  console.log("=== ALL 5-TIER ACTION POLICY TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
