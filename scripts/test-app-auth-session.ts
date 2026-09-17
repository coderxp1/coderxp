/**
 * Application Authentication & Session Isolation Regression Suite (hardened).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "coderxp-session-test-"));
const PASSWORD_FILE = path.join(TEST_DIR, "auth-admin-hash.txt");

process.env.AUTH_SESSION_SECRET = "test-only-session-secret-min-32-chars!!";
process.env.DEVBOX_TOKEN_SECRET = "test-only-devbox-secret-min-32-chars!!!";
process.env.AUTH_PASSWORD_FILE = PASSWORD_FILE;
process.env.AUTH_ADMIN_PASSWORD = "disposable-session-test-pass-2026";

async function main() {
  const auth = await import("../lib/server/auth");
  auth.__resetAuthSecretCacheForTests();

  console.log("================================================");
  console.log("  AUTH & SESSION HARDENING REGRESSION SUITE");
  console.log("================================================");

  console.log("\n--- 1. Valid credentials mint signed session ---");
  assert.equal(
    auth.verifyAdminCredentials("coderxpadmin", "disposable-session-test-pass-2026"),
    true,
  );
  assert.equal(auth.verifyAdminCredentials("coderxpadmin", "bad"), false);

  const token = auth.createSessionToken(
    auth.ADMIN_CONFIG.userId,
    auth.ADMIN_CONFIG.email,
  );
  assert.ok(token.includes("."));
  const verified = auth.verifySessionToken(token);
  assert.equal(verified.valid, true);
  assert.equal(verified.payload?.userId, "coderxpadmin");
  assert.equal(typeof verified.payload?.credentialGeneration, "number");
  console.log("[PASS] Session token signing verified.");

  console.log("\n--- 2. Reject malformed, tampered, expired, invalid-claim sessions ---");
  const [b64, sig] = token.split(".");
  const tamperedSig = sig.slice(0, -4) + "XXXX";
  assert.equal(auth.verifySessionToken(`${b64}.${tamperedSig}`).valid, false);
  assert.equal(auth.verifySessionToken("not-a-token").valid, false);
  assert.equal(auth.verifySessionToken("").valid, false);
  assert.equal(auth.verifySessionToken("onlyonepart").valid, false);

  const expiredPayload = {
    userId: "coderxpadmin",
    email: auth.ADMIN_CONFIG.email,
    role: "admin",
    createdAt: Date.now() - 10_000,
    expiresAt: Date.now() - 1000,
    nonce: crypto.randomBytes(8).toString("hex"),
    credentialGeneration: auth.getCredentialGeneration(),
  };
  const expB64 = Buffer.from(JSON.stringify(expiredPayload)).toString("base64url");
  const expSig = crypto
    .createHmac("sha256", process.env.AUTH_SESSION_SECRET!)
    .update(expB64)
    .digest("base64url");
  assert.equal(auth.verifySessionToken(`${expB64}.${expSig}`).valid, false, "expired must fail");

  const badClaims = {
    userId: "",
    email: "",
    role: "admin",
    createdAt: Date.now(),
    expiresAt: Date.now() + 999999,
    nonce: "x",
    credentialGeneration: auth.getCredentialGeneration(),
  };
  const badB64 = Buffer.from(JSON.stringify(badClaims)).toString("base64url");
  const badSig = crypto
    .createHmac("sha256", process.env.AUTH_SESSION_SECRET!)
    .update(badB64)
    .digest("base64url");
  assert.equal(auth.verifySessionToken(`${badB64}.${badSig}`).valid, false, "empty claims must fail");
  console.log("[PASS] Malformed, tampered, expired, and invalid-claim sessions rejected.");

  console.log("\n--- 3. Multi-transport request auth ---");
  const emptyResult = auth.validateRequestAuth(
    new Request("https://example.test/api/agent/stream", { headers: new Headers() }),
  );
  assert.equal(emptyResult.authenticated, false);

  const cookieResult = auth.validateRequestAuth(
    new Request("https://example.test/api/agent/stream", {
      headers: new Headers({ cookie: `${auth.SESSION_COOKIE_NAME}=${token}` }),
    }),
  );
  assert.equal(cookieResult.authenticated, true);
  assert.equal(cookieResult.userId, "coderxpadmin");

  const bearerResult = auth.validateRequestAuth(
    new Request("https://example.test/api/agent/stream", {
      headers: new Headers({ authorization: `Bearer ${token}` }),
    }),
  );
  assert.equal(bearerResult.authenticated, true);

  const customResult = auth.validateRequestAuth(
    new Request("https://example.test/api/agent/stream", {
      headers: new Headers({ "x-coderxp-session": token }),
    }),
  );
  assert.equal(customResult.authenticated, true);
  console.log("[PASS] Multi-transport authentication verified.");

  console.log("\n--- 4. Session invalidation after password change ---");
  const before = token;
  await auth.updateAdminPassword("post-change-password-2026xx", {
    currentPassword: "disposable-session-test-pass-2026",
    expectedGeneration: auth.getCredentialGeneration(),
  });
  assert.equal(auth.verifySessionToken(before).valid, false);
  const after = auth.createSessionToken(auth.ADMIN_CONFIG.userId, auth.ADMIN_CONFIG.email);
  assert.equal(auth.verifySessionToken(after).valid, true);
  console.log("[PASS] Credential generation invalidates prior sessions.");

  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }

  console.log("\n================================================");
  console.log("  SUCCESS: AUTH & SESSION SUITE PASSED");
  console.log("================================================");
}

main().catch((err) => {
  console.error("Auth regression test failed:", err);
  process.exit(1);
});
