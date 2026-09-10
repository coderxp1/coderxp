import assert from "node:assert";
import { previewLinkStore } from "../lib/server/preview-link-store";
import { hostEventStore } from "../lib/server/devbox-event-store";

async function runTests() {
  console.log("=== Testing CoderXP Live Preview Link Store & Events ===");

  const projectId = `test-proj-${Date.now()}`;
  const userId = "coderxpadmin";

  // 1. Create Preview Link
  const link = previewLinkStore.create({
    projectId,
    userId,
    containerPort: 3000,
  });

  assert.ok(link, "Link must be returned");
  assert.strictEqual(typeof link.slug, "string", "Slug must be a string");
  assert.strictEqual(link.slug.length, 32, "Slug must be exactly 32 hex chars (128-bit)");
  assert.match(link.slug, /^[0-9a-f]{32}$/, "Slug must be valid 128-bit lowercase hex");
  assert.strictEqual(link.projectId, projectId, "Project ID must match");
  assert.strictEqual(link.containerPort, 3000, "Container port must match");
  assert.strictEqual(link.revokedAt, null, "Link must not be revoked on creation");
  console.log("[PASS] 128-bit slug generated correctly:", link.slug);

  // 2. Resolve Link
  const fetched = previewLinkStore.get(link.slug);
  assert.ok(fetched, "Link must be resolvable");
  assert.strictEqual(fetched.slug, link.slug);
  console.log("[PASS] Link resolves before revocation");

  // 3. Verify T2 Event on Creation
  const events = hostEventStore.getEvents(projectId);
  const createEvt = events.find((e) => e.type === "preview.created" && e.data?.action === "created");
  assert.ok(createEvt, "T2 preview.created event must be recorded in host event store");
  assert.strictEqual(createEvt.tier, "T2", "Creation event tier must be T2");
  assert.strictEqual(createEvt.data.slug, link.slug, "Event slug must match");
  console.log("[PASS] T2 event recorded on creation:", createEvt.id);

  // 4. Revoke Link (T1 event)
  const revoked = previewLinkStore.revoke(link.slug, projectId);
  assert.strictEqual(revoked, true, "Revocation must return true");

  // 5. Subsequent Resolve Returns Null
  const afterRevoke = previewLinkStore.get(link.slug);
  assert.strictEqual(afterRevoke, null, "Revoked link must resolve to null");
  console.log("[PASS] Revoked link successfully rejected");

  // 6. Verify T1 Event on Revocation
  const updatedEvents = hostEventStore.getEvents(projectId);
  const revokeEvt = updatedEvents.find((e) => e.type === "preview.created" && e.data?.action === "revoked");
  assert.ok(revokeEvt, "T1 preview.created event must be recorded on revocation");
  assert.strictEqual(revokeEvt.tier, "T1", "Revocation event tier must be T1");
  assert.strictEqual(revokeEvt.data.slug, link.slug, "Revocation event slug must match");
  console.log("[PASS] T1 event recorded on revocation:", revokeEvt.id);

  console.log("\n[SUCCESS] ALL LIVE PREVIEW UNIT TESTS PASSED!");
}

runTests().catch((err) => {
  console.error("Live Preview Unit Tests FAILED:", err);
  process.exit(1);
});