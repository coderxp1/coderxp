import assert from "node:assert/strict";
import { devboxBroker } from "../lib/server/devbox-broker";

async function main() {
  console.log("=== RUNNING DEVBOX HOST CAPACITY GUARD TESTS ===");

  // Provision up to maximum 5 concurrent running devboxes
  const sessions: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const pId = `proj-cap-${i}`;
    const res = await devboxBroker.getOrCreateDevbox(pId, `user-${i}`, "pro");
    assert.equal(res.ok, true, `Devbox ${i} started`);
    sessions.push(pId);
  }

  assert.equal(devboxBroker.getRunningCount(), 5, "5 devboxes are actively running");
  console.log("[PASS] 5 concurrent devboxes running on host.");

  // 6th Devbox Request should be rejected with HOST_CAPACITY_REACHED (429)
  console.log("--- Enforcing 6th Devbox Concurrency Ceiling ---");
  const overflowRes = await devboxBroker.getOrCreateDevbox("proj-cap-overflow", "user-6", "pro");
  assert.equal(overflowRes.ok, false, "6th devbox blocked by host capacity guard");
  assert.equal(overflowRes.errorCode, "HOST_CAPACITY_REACHED");
  assert.ok(overflowRes.error?.includes("Host capacity limit reached"), "Returns host capacity limit message");
  console.log("[PASS] Host capacity guard protects Strato host and CineDrama from resource starvation.");

  // Clean up
  for (const pId of sessions) {
    await devboxBroker.freezeDevbox(pId);
  }

  console.log("=== ALL HOST CAPACITY GUARD TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
