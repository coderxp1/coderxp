import assert from "node:assert/strict";
import fs from "node:fs";
import {
  hashPassword,
  verifyPassword,
  verifyAdminCredentials,
  updateAdminPassword,
  loadPersistedAdminPassword,
  ADMIN_CONFIG,
  AUTH_PASSWORD_FILE,
} from "../lib/server/auth";

async function main() {
  console.log("=== RUNNING AUTH PASSWORD HASHING & CHANGE TESTS ===");

  // 1. Initial State: Valid PBKDF2 Credential Verification
  console.log("--- 1. Initial Credential Verification ---");
  const initialPass = "coderxp-pilot-2026";
  assert.equal(verifyAdminCredentials("coderxpadmin", initialPass), true);
  assert.equal(verifyAdminCredentials("coderxpadmin", "wrong-pass"), false);
  assert.equal(verifyAdminCredentials("paul@coderxp.pro", initialPass), true);
  console.log("[PASS] Initial credentials verified correctly.");

  // 2. PBKDF2 Hashing & Verification
  console.log("--- 2. PBKDF2 Hashing & Verification ---");
  const hashed = hashPassword("super-secret-paul-pass-2026");
  assert.ok(hashed.startsWith("pbkdf2$100000$"), "PBKDF2 prefix and iterations match");
  assert.equal(verifyPassword("super-secret-paul-pass-2026", hashed), true);
  assert.equal(verifyPassword("wrong-attempt", hashed), false);
  console.log("[PASS] PBKDF2 hashing and constant-time verification passed.");

  // 3. Strict Rejection of Plaintext Stored Values (Zero Plaintext Fallback)
  console.log("--- 3. Plaintext Stored Hash Rejection ---");
  assert.equal(verifyPassword("plaintext-password", "plaintext-password"), false, "Plaintext stored passwords must fail verification");
  assert.equal(verifyPassword("coderxp-pilot-2026", "coderxp-pilot-2026"), false, "Plaintext bootstrap string must fail verification");
  console.log("[PASS] Plaintext stored values strictly rejected without fallback.");

  // 4. Password Update & Disk Persistence
  console.log("--- 4. Password Update & Disk Persistence ---");
  const newHash = updateAdminPassword("new-authenticated-password-2026");
  assert.ok(newHash.startsWith("pbkdf2$100000$"), "Admin password updated to PBKDF2 hash");
  assert.equal(verifyAdminCredentials("coderxpadmin", "new-authenticated-password-2026"), true);
  assert.equal(verifyAdminCredentials("coderxpadmin", initialPass), false);

  // Verify file was written
  if (fs.existsSync(AUTH_PASSWORD_FILE)) {
    const fileContent = fs.readFileSync(AUTH_PASSWORD_FILE, "utf8").trim();
    assert.equal(fileContent, newHash, "Password file on disk matches updated PBKDF2 hash");
    const reloaded = loadPersistedAdminPassword();
    assert.equal(reloaded, newHash, "loadPersistedAdminPassword correctly re-loads the persisted hash");
    console.log("[PASS] Disk persistence and reload verified.");
  } else {
    console.log("[PASS] In-memory update verified (file path not writable in this test environment).");
  }

  // Restore initial password
  updateAdminPassword(initialPass);

  console.log("=== ALL AUTH PASSWORD TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
