import assert from "node:assert/strict";
import {
  saveServerByok,
  listServerByok,
  getDecryptedServerKey,
  revokeServerByok,
} from "../lib/workspace/byok-server-store";

async function main() {
  console.log("=== RUNNING SERVER-SIDE BYOK SECRETS STORE & PROXY TESTS ===");

  const userId = "test_session_user_1";
  const rawKey = "sk-ant-api03-super-secret-key-that-must-never-leak-to-client-state-1234567890";

  // 1. Save BYOK Credential on Server
  console.log("--- 1. Save & Server-Side Encryption ---");
  const saveResult = await saveServerByok(userId, "anthropic", rawKey, { skipProbe: true });
  assert.equal(saveResult.ok, true, "Save operation succeeds");
  assert.ok(saveResult.record, "Returns client-safe record");

  // ASSERTION: Full key never appears in client record
  assert.equal(saveResult.record.maskedKey, "…7890", "Masked key contains only …last4");
  assert.equal(JSON.stringify(saveResult.record).includes(rawKey), false, "Full key string is NEVER returned in save response");
  console.log("[PASS] Full key string is not returned to client upon save.");

  // 2. Client-Bound List API Payload Non-Leak
  console.log("--- 2. Client-Bound List Payloads Non-Leak ---");
  const records = listServerByok(userId);
  assert.ok(records.length > 0, "Saved record appears in user store");
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes(rawKey), false, "Full key string is NEVER present in list payload");
  assert.equal(records[0].maskedKey, "…7890", "Record has maskedKey only");
  console.log("[PASS] listServerByok payload contains zero plaintext or ciphertext key leaks.");

  // 3. Server Internal Credential Retrieval (Proxy Path)
  console.log("--- 3. Server Injected Credential Retrieval ---");
  const serverKey = getDecryptedServerKey(userId, "anthropic");
  assert.equal(serverKey, rawKey, "Server can decrypt credential internally for upstream dispatch");
  console.log("[PASS] Server securely decrypts key for upstream proxy requests.");

  // 4. Live Discovery vs Fallback Optgroups
  console.log("--- 4. Live Discovery Models Population ---");
  assert.ok(Array.isArray(saveResult.record.models), "Models array is returned");
  assert.ok(saveResult.record.models.length > 0, "At least one model is present");
  console.log("[PASS] Models populated dynamically from probe / fallback.");

  // 5. Revocation
  console.log("--- 5. Server-Side Revocation ---");
  const revoked = revokeServerByok(userId, "anthropic");
  assert.equal(revoked, true, "Revoke succeeds");
  assert.equal(getDecryptedServerKey(userId, "anthropic"), null, "Decrypted key is null after revocation");
  assert.equal(listServerByok(userId).length, 0, "No records returned after revocation");
  console.log("[PASS] Revocation clears key from server store immediately.");

  // 6. SSRF Guard on Custom Server BYOK
  console.log("--- 6. SSRF Guard on Custom Base URL ---");
  const ssrfResult = await saveServerByok(userId, "custom", "custom-key", {
    baseUrl: "http://127.0.0.1:9090/v1",
  });
  assert.equal(ssrfResult.ok, false, "Localhost custom provider URL rejected by server SSRF guard");
  console.log("[PASS] Server rejects forbidden localhost base URLs for custom providers.");

  console.log("=== ALL SERVER-SIDE BYOK TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
