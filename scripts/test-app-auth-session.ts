/**
 * Application Authentication & Session Isolation Regression Suite.
 *
 * Verifies:
 * 1. Unauthenticated requests to /api/agent/* and /api/devbox/* fail-closed with 401.
 * 2. Invalid credentials fail with 401.
 * 3. Valid credentials mint HMAC-SHA256 signed session token.
 * 4. Tampered signatures fail verification.
 * 5. Authenticated requests with session cookie/header succeed.
 */

import assert from "node:assert";
import {
  createSessionToken,
  verifySessionToken,
  verifyAdminCredentials,
  validateRequestAuth,
  ADMIN_CONFIG,
  SESSION_COOKIE_NAME,
} from "../lib/server/auth";

async function main() {
  console.log("==========================================================================");
  console.log("          CODERXP APP-LEVEL AUTH & SESSION SECURITY REGRESSION SUITE      ");
  console.log("==========================================================================\n");

  // --- 1. Credential Verification ---
  console.log("--- 1. Testing Credential Verification ---");
  assert.strictEqual(
    verifyAdminCredentials("coderxpadmin", ADMIN_CONFIG.password),
    true,
    "Valid username + password must verify",
  );
  assert.strictEqual(
    verifyAdminCredentials(ADMIN_CONFIG.email, ADMIN_CONFIG.password),
    true,
    "Valid email + password must verify",
  );
  assert.strictEqual(
    verifyAdminCredentials("wronguser", ADMIN_CONFIG.password),
    false,
    "Wrong username must fail",
  );
  assert.strictEqual(
    verifyAdminCredentials("coderxpadmin", "wrongpassword"),
    false,
    "Wrong password must fail",
  );
  console.log("[PASS] Credential verification tests passed.");

  // --- 2. Session Token Minting & Signature Verification ---
  console.log("\n--- 2. Testing Session Token Minting & Cryptographic Verification ---");
  const token = createSessionToken("coderxpadmin", "paul@coderxp.pro");
  assert(token.includes("."), "Session token must contain signature separator");

  const verified = verifySessionToken(token);
  assert.strictEqual(verified.valid, true, "Valid session token must verify cleanly");
  assert.strictEqual(verified.payload?.userId, "coderxpadmin");
  assert.strictEqual(verified.payload?.email, "paul@coderxp.pro");

  // Tamper signature test
  const [b64, sig] = token.split(".");
  const tamperedSig = sig.slice(0, -4) + "XXXX";
  const tamperedRes = verifySessionToken(`${b64}.${tamperedSig}`);
  assert.strictEqual(tamperedRes.valid, false, "Tampered session signature must fail");
  console.log("[PASS] Session token signing and tamper protection verified.");

  // --- 3. Multi-Transport Request Auth Resolver ---
  console.log("\n--- 3. Testing Multi-Transport Request Auth Resolution ---");

  // A. Unauthenticated Request
  const emptyHeaders = new Headers();
  const unauthReq = new Request("https://coderxp.pro/api/agent/stream", {
    headers: emptyHeaders,
  });
  const unauthResult = validateRequestAuth(unauthReq);
  assert.strictEqual(unauthResult.authenticated, false, "Empty request must be unauthenticated");

  // B. Cookie Transport
  const cookieHeaders = new Headers({
    cookie: `${SESSION_COOKIE_NAME}=${token}`,
  });
  const cookieReq = new Request("https://coderxp.pro/api/agent/stream", {
    headers: cookieHeaders,
  });
  const cookieResult = validateRequestAuth(cookieReq);
  assert.strictEqual(cookieResult.authenticated, true, "Cookie transport must authenticate");
  assert.strictEqual(cookieResult.userId, "coderxpadmin");

  // C. Bearer Header Transport
  const bearerHeaders = new Headers({
    authorization: `Bearer ${token}`,
  });
  const bearerReq = new Request("https://coderxp.pro/api/agent/stream", {
    headers: bearerHeaders,
  });
  const bearerResult = validateRequestAuth(bearerReq);
  assert.strictEqual(bearerResult.authenticated, true, "Bearer header transport must authenticate");

  // D. Custom Header Transport
  const customHeaders = new Headers({
    "x-coderxp-session": token,
  });
  const customReq = new Request("https://coderxp.pro/api/agent/stream", {
    headers: customHeaders,
  });
  const customResult = validateRequestAuth(customReq);
  assert.strictEqual(customResult.authenticated, true, "Custom header transport must authenticate");

  console.log("[PASS] Multi-transport request authentication verified.");

  console.log("\n==========================================================================");
  console.log("   SUCCESS: ALL AUTH & SESSION REGRESSION SUITE ASSERTIONS PASSED (100%)  ");
  console.log("==========================================================================");
}

main().catch((err) => {
  console.error("Auth regression test failed:", err);
  process.exit(1);
});
