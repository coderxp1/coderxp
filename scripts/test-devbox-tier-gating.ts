import assert from "node:assert/strict";
import { devboxBroker } from "../lib/server/devbox-broker";
import { devboxMetering } from "../lib/devbox/metering";

async function main() {
  console.log("=== RUNNING DEVBOX TIER GATING & QUOTA TESTS ===");

  // 1. Free Tier Rejection
  console.log("--- 1. Free Tier Entitlement Gate ---");
  const freeUser = "test-user-free-tier";
  const freeRes = await devboxBroker.getOrCreateDevbox("proj-free", freeUser, "free");
  assert.equal(freeRes.ok, false, "Free tier cannot create devbox");
  assert.ok(freeRes.error?.includes("Pro or BYOK Compute plan"), "Error specifies plan requirement");
  console.log("[PASS] Free tier correctly rejected and redirected to WebContainer runtime.");

  // 2. Pro Tier Allowance & Quota
  console.log("--- 2. Pro Tier Allowance ---");
  const proUser = "test-user-pro-quota";
  const proRes = await devboxBroker.getOrCreateDevbox("proj-pro", proUser, "pro");
  assert.equal(proRes.ok, true, "Pro tier devbox created successfully");

  const quota = devboxMetering.getOrCreateQuota(proUser, "pro");
  assert.equal(quota.monthlyQuotaHours, 50, "Pro tier has 50 included hours");
  assert.equal(quota.isPaused, false);
  console.log("[PASS] Pro tier provisioned with monthly compute quota.");

  // 3. Quota Exhaustion Pause
  console.log("--- 3. Quota Exhaustion Pause State ---");
  quota.usedHours = 50; // Simulate exhaustion
  const check = devboxMetering.canStartDevbox(proUser, "pro");
  assert.equal(check.allowed, false, "Exhausted quota blocks container start");
  assert.ok(check.reason?.includes("quota reached"), "Returns quota reached message");
  console.log("[PASS] Quota exhaustion pauses container and returns upgrade message.");

  console.log("=== ALL DEVBOX TIER GATING TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
