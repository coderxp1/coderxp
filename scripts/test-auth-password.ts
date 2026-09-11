/**
 * Auth password hashing, config fail-closed, persistence, and session invalidation.
 * Uses disposable credentials only — no production secrets or legacy bootstrap defaults.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "coderxp-auth-test-"));
const PASSWORD_FILE = path.join(TEST_DIR, "auth-admin-hash.txt");

process.env.AUTH_SESSION_SECRET =
  process.env.AUTH_SESSION_SECRET || "test-only-session-secret-min-32-chars!!";
process.env.DEVBOX_TOKEN_SECRET =
  process.env.DEVBOX_TOKEN_SECRET || "test-only-devbox-secret-min-32-chars!!!";
process.env.AUTH_PASSWORD_FILE = PASSWORD_FILE;
process.env.AUTH_ADMIN_PASSWORD = "disposable-test-password-2026";
delete process.env.CODERXP_AUTH_PASS;

async function main() {
  const auth = await import("../lib/server/auth");
  auth.__resetAuthSecretCacheForTests();

  console.log("=== AUTH PASSWORD & CONFIG FAIL-CLOSED TESTS ===");

  console.log("--- 1. Explicit credential verification ---");
  assert.equal(
    auth.verifyAdminCredentials("coderxpadmin", "disposable-test-password-2026"),
    true,
  );
  assert.equal(auth.verifyAdminCredentials("coderxpadmin", "wrong-pass"), false);
  assert.equal(
    auth.verifyAdminCredentials("paul@coderxp.pro", "disposable-test-password-2026"),
    true,
  );
  console.log("[PASS] Explicit credentials verified.");

  console.log("--- 2. PBKDF2 hashing & verification ---");
  const hashed = auth.hashPassword("super-secret-test-pass-2026");
  assert.ok(hashed.startsWith("pbkdf2$100000$"));
  assert.equal(auth.verifyPassword("super-secret-test-pass-2026", hashed), true);
  assert.equal(auth.verifyPassword("wrong-attempt", hashed), false);
  console.log("[PASS] PBKDF2 hashing and constant-time verification.");

  console.log("--- 3. Plaintext stored hash rejection ---");
  assert.equal(auth.verifyPassword("plaintext-password", "plaintext-password"), false);
  assert.equal(auth.verifyPassword("coderxp-pilot-2026", "coderxp-pilot-2026"), false);
  console.log("[PASS] Plaintext stored values strictly rejected.");

  console.log("--- 4. Password update, persistence, session invalidation ---");
  const genBefore = auth.getCredentialGeneration();
  const oldToken = auth.createSessionToken(auth.ADMIN_CONFIG.userId, auth.ADMIN_CONFIG.email);
  assert.equal(auth.verifySessionToken(oldToken).valid, true);

  const newHash = await auth.updateAdminPassword("new-authenticated-password-2026", {
    currentPassword: "disposable-test-password-2026",
    expectedGeneration: genBefore,
  });
  assert.ok(newHash.startsWith("pbkdf2$100000$"));
  assert.equal(
    auth.verifyAdminCredentials("coderxpadmin", "new-authenticated-password-2026"),
    true,
  );
  assert.equal(
    auth.verifyAdminCredentials("coderxpadmin", "disposable-test-password-2026"),
    false,
  );
  assert.ok(fs.existsSync(PASSWORD_FILE));
  const fileContent = fs.readFileSync(PASSWORD_FILE, "utf8");
  assert.ok(fileContent.includes(newHash.split("\n")[0]));
  assert.equal(auth.getCredentialGeneration(), genBefore + 1);

  const oldVerify = auth.verifySessionToken(oldToken);
  assert.equal(oldVerify.valid, false, "Sessions must invalidate after password change");

  const newToken = auth.createSessionToken(auth.ADMIN_CONFIG.userId, auth.ADMIN_CONFIG.email);
  assert.equal(auth.verifySessionToken(newToken).valid, true);
  console.log("[PASS] Password update persists and invalidates prior sessions.");

  console.log("--- 5. Rejected legacy bootstrap defaults ---");
  assert.equal(
    auth.verifyAdminCredentials("coderxpadmin", "coderxp-pilot-2026"),
    false,
    "Legacy bootstrap password must not authenticate",
  );
  console.log("[PASS] Legacy bootstrap password rejected.");

  console.log("--- 6. Generation survives simulated process restart ---");
  const genAfterChange = auth.getCredentialGeneration();
  const tokenBeforeRestart = newToken;
  auth.__resetAuthSecretCacheForTests();
  assert.equal(auth.getCredentialGeneration(), genAfterChange, "generation must reload from file");
  assert.equal(
    auth.verifySessionToken(tokenBeforeRestart).valid,
    true,
    "session minted at current generation remains valid after restart",
  );
  assert.equal(auth.verifySessionToken(oldToken).valid, false, "pre-change session still invalid after restart");
  console.log("[PASS] Credential generation persists across restart (file-backed).");

  console.log("--- 7. Password persistence failure does not activate new credential ---");
  const hashBeforeFail = auth.ADMIN_CONFIG.password;
  const genBeforeFail = auth.getCredentialGeneration();
  const tokenBeforeFail = auth.createSessionToken(auth.ADMIN_CONFIG.userId, auth.ADMIN_CONFIG.email);
  fs.unlinkSync(PASSWORD_FILE);
  fs.mkdirSync(PASSWORD_FILE, { recursive: true });
  let threw = false;
  try {
    await auth.updateAdminPassword("should-not-activate-password-xx", {
      currentPassword: "new-authenticated-password-2026",
      expectedGeneration: genBeforeFail,
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "updateAdminPassword must throw when persistence fails");
  assert.equal(auth.ADMIN_CONFIG.password, hashBeforeFail, "in-memory hash must not change on failure");
  assert.equal(auth.getCredentialGeneration(), genBeforeFail, "generation must not bump on failure");
  assert.equal(auth.verifySessionToken(tokenBeforeFail).valid, true, "prior session remains valid");
  assert.equal(
    auth.verifyAdminCredentials("coderxpadmin", "should-not-activate-password-xx"),
    false,
  );
  fs.rmSync(PASSWORD_FILE, { recursive: true, force: true });
  console.log("[PASS] Persistence failure leaves prior credential active.");

  console.log("--- 8. Overlapping password changes: serialize, reject stale, persist-fail isolation ---");
  const overlapCurrent = "new-authenticated-password-2026";
  const overlapGen = auth.getCredentialGeneration();
  const overlapWinner = "overlap-winner-password-2026";
  const overlapStale = "overlap-stale-password-2026";
  const sessionBeforeOverlap = auth.createSessionToken(
    auth.ADMIN_CONFIG.userId,
    auth.ADMIN_CONFIG.email,
  );
  assert.equal(auth.verifySessionToken(sessionBeforeOverlap).valid, true);

  const winnerClaim = {
    currentPassword: overlapCurrent,
    expectedGeneration: overlapGen,
  };
  const first = auth.updateAdminPassword(overlapWinner, winnerClaim);
  const queued = auth.updateAdminPassword(overlapStale, { ...winnerClaim });
  const settled = await Promise.allSettled([first, queued]);

  assert.equal(settled[0].status, "fulfilled", "first overlapping change must commit");
  assert.equal(settled[1].status, "rejected", "queued overlapping change must not commit");
  if (settled[1].status === "rejected") {
    assert.equal(
      settled[1].reason instanceof auth.StaleCredentialChangeError,
      true,
      "queued change must be rejected as stale generation",
    );
  }

  const activeHash = auth.ADMIN_CONFIG.password;
  const activeGen = auth.getCredentialGeneration();
  assert.equal(activeGen, overlapGen + 1);
  assert.equal(auth.verifyAdminCredentials("coderxpadmin", overlapWinner), true);
  assert.equal(auth.verifyAdminCredentials("coderxpadmin", overlapStale), false);
  assert.equal(auth.verifyAdminCredentials("coderxpadmin", overlapCurrent), false);
  assert.ok(fs.existsSync(PASSWORD_FILE));
  const persisted = fs.readFileSync(PASSWORD_FILE, "utf8");
  const persistedLines = persisted.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  assert.equal(persistedLines[0], activeHash, "persisted hash must match active hash");
  assert.equal(Number(persistedLines[1]), activeGen, "persisted generation must match active generation");
  assert.equal(auth.verifySessionToken(sessionBeforeOverlap).valid, false);
  const sessionAfterOverlap = auth.createSessionToken(
    auth.ADMIN_CONFIG.userId,
    auth.ADMIN_CONFIG.email,
  );
  assert.equal(auth.verifySessionToken(sessionAfterOverlap).valid, true);
  console.log("[PASS] Overlap: active and persisted agree; stale queued change cannot overwrite.");

  const hashAfterOverlap = auth.ADMIN_CONFIG.password;
  const genAfterOverlap = auth.getCredentialGeneration();
  const fileAfterOverlap = fs.readFileSync(PASSWORD_FILE, "utf8");
  auth.__failNextPasswordPersistForTests();
  let persistThrew = false;
  try {
    await auth.updateAdminPassword("should-not-activate-after-success-xx", {
      currentPassword: overlapWinner,
      expectedGeneration: genAfterOverlap,
    });
  } catch (err) {
    persistThrew = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, /persist/i);
  }
  assert.equal(persistThrew, true, "injected persist failure must throw");
  assert.equal(auth.ADMIN_CONFIG.password, hashAfterOverlap, "successful change must not roll back");
  assert.equal(auth.getCredentialGeneration(), genAfterOverlap, "generation must stay at successful change");
  assert.equal(fs.readFileSync(PASSWORD_FILE, "utf8"), fileAfterOverlap, "password file must be unchanged");
  assert.equal(auth.verifyAdminCredentials("coderxpadmin", overlapWinner), true);
  assert.equal(
    auth.verifyAdminCredentials("coderxpadmin", "should-not-activate-after-success-xx"),
    false,
  );
  assert.equal(auth.verifySessionToken(sessionAfterOverlap).valid, true);
  console.log("[PASS] Persist failure after success neither activates proposal nor rolls back.");

  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }

  console.log("=== ALL AUTH PASSWORD TESTS PASSED ===");
}

main().catch((err) => {
  console.error("Auth password test failed:", err);
  process.exit(1);
});
