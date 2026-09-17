import assert from "node:assert/strict";

process.env.DEVBOX_TOKEN_SECRET =
  process.env.DEVBOX_TOKEN_SECRET || "test-only-devbox-secret-min-32-chars!!!";

import {
  mintDevboxWssToken,
  verifyDevboxWssToken,
  __resetDevboxTokenSecretCacheForTests,
} from "../lib/server/devbox-token";

__resetDevboxTokenSecretCacheForTests();

async function main() {
  console.log("=== RUNNING DEVBOX BROKER WSS AUTHENTICATION TESTS ===");

  const userId = "user-alice-123";
  const projectId = "proj-acme-frontend";

  console.log("--- 1. Valid Token Minting & Verification ---");
  const token = mintDevboxWssToken(userId, projectId);
  assert.ok(token && typeof token === "string", "Token string generated");

  const verified = verifyDevboxWssToken(token, projectId);
  assert.equal(verified.valid, true, "Token verifies successfully");
  assert.equal(verified.userId, userId, "Token returns authenticated userId");
  console.log("[PASS] Valid HMAC-signed token verified successfully.");

  console.log("--- 2. Single-Use Replay Prevention ---");
  const replay = verifyDevboxWssToken(token, projectId);
  assert.equal(replay.valid, false, "Consumed token rejected on replay");
  assert.ok(replay.error?.includes("already been consumed"), "Error specifies single-use replay prevention");
  console.log("[PASS] Consumed single-use token rejected on secondary connection attempt.");

  console.log("--- 3. Cross-Project Access Rejection ---");
  const token2 = mintDevboxWssToken(userId, projectId);
  const crossProject = verifyDevboxWssToken(token2, "proj-other-user-bank");
  assert.equal(crossProject.valid, false, "Cross-project token handshake rejected");
  assert.ok(crossProject.error?.includes("project mismatch"), "Error indicates unauthorized cross-project access");
  console.log("[PASS] Cross-user token handshake rejected immediately.");

  console.log("--- 4. Tampered Signature Rejection ---");
  const token3 = mintDevboxWssToken(userId, projectId);
  const tamperedToken = token3.slice(0, -5) + "xxxxx";
  const tampered = verifyDevboxWssToken(tamperedToken, projectId);
  assert.equal(tampered.valid, false, "Tampered token rejected");
  assert.ok(tampered.error?.includes("signature"), "Error indicates invalid signature");
  console.log("[PASS] Tampered token signature fails validation.");

  console.log("=== ALL DEVBOX BROKER AUTH TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
