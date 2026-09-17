/**
 * Configuration fail-closed regression: missing secrets must not soft-fail to defaults.
 * Isolated child processes avoid module cache masking unset configuration.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const root = path.resolve(__dirname, "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const authUrl = pathToFileURL(path.join(root, "lib", "server", "auth.ts")).href;

function runCase(name: string, env: Record<string, string>, scriptBody: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coderxp-cfg-"));
  const scriptPath = path.join(dir, "case.ts");
  fs.writeFileSync(scriptPath, scriptBody, "utf8");
  const result = spawnSync(process.execPath, [tsxCli, scriptPath], {
    cwd: root,
    env: { ...process.env, ...env, NODE_OPTIONS: "" },
    encoding: "utf8",
    timeout: 30000,
  });
  const out = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0) {
    console.error(`Case ${name} failed status=${result.status}\n${out}`);
  }
  assert.equal(result.status, 0, `case ${name} exit`);
  assert.ok(out.includes("CASE_OK"), `case ${name} marker: ${out}`);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  console.log(`[PASS] ${name}`);
}

console.log("=== AUTH CONFIG FAIL-CLOSED ===");

runCase(
  "missing AUTH_SESSION_SECRET",
  {
    AUTH_SESSION_SECRET: "",
    DEVBOX_TOKEN_SECRET: "test-only-devbox-secret-min-32-chars!!!",
    AUTH_ADMIN_PASSWORD: "temp-pass-for-config-test-onlyxx",
    AUTH_PASSWORD_FILE: path.join(os.tmpdir(), "no-auth-file-a"),
  },
  `
import { createSessionToken, __resetAuthSecretCacheForTests } from ${JSON.stringify(path.join(root, "lib/server/auth.ts"))};
__resetAuthSecretCacheForTests();
try {
  createSessionToken("u", "e@x.com");
  console.error("UNEXPECTED_SUCCESS");
  process.exit(2);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("AUTH_SESSION_SECRET")) {
    console.error("Unexpected:", msg);
    process.exit(3);
  }
  console.log("CASE_OK");
}
`,
);

runCase(
  "missing admin credentials",
  {
    AUTH_SESSION_SECRET: "test-only-session-secret-min-32-chars!!",
    DEVBOX_TOKEN_SECRET: "test-only-devbox-secret-min-32-chars!!!",
    AUTH_ADMIN_PASSWORD: "",
    AUTH_PASSWORD_FILE: path.join(os.tmpdir(), "no-auth-file-b-xyz"),
  },
  `
import {
  verifyAdminCredentials,
  loadPersistedAdminPassword,
  __resetAuthSecretCacheForTests,
} from ${JSON.stringify(path.join(root, "lib/server/auth.ts"))};
__resetAuthSecretCacheForTests();
const ok = verifyAdminCredentials("coderxpadmin", "anything");
if (ok) {
  console.error("UNEXPECTED_AUTH");
  process.exit(2);
}
try {
  loadPersistedAdminPassword();
  console.error("UNEXPECTED_LOAD");
  process.exit(3);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!/not configured|credentials/i.test(msg)) {
    console.error("Unexpected:", msg);
    process.exit(4);
  }
  console.log("CASE_OK");
}
`,
);

runCase(
  "missing DEVBOX_TOKEN_SECRET",
  {
    AUTH_SESSION_SECRET: "test-only-session-secret-min-32-chars!!",
    DEVBOX_TOKEN_SECRET: "",
  },
  `
import {
  mintDevboxWssToken,
  __resetDevboxTokenSecretCacheForTests,
} from ${JSON.stringify(path.join(root, "lib/server/devbox-token.ts"))};
__resetDevboxTokenSecretCacheForTests();
try {
  mintDevboxWssToken("u", "p");
  console.error("UNEXPECTED_SUCCESS");
  process.exit(2);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("DEVBOX_TOKEN_SECRET")) {
    console.error("Unexpected:", msg);
    process.exit(3);
  }
  console.log("CASE_OK");
}
`,
);

runCase(
  "malformed password file: wrong hash format",
  {
    AUTH_SESSION_SECRET: "test-only-session-secret-min-32-chars!!",
    DEVBOX_TOKEN_SECRET: "test-only-devbox-secret-min-32-chars!!!",
    AUTH_ADMIN_PASSWORD: "env-password-must-not-be-used-here",
    AUTH_PASSWORD_FILE: "",
  },
  `
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bad-auth-file-"));
const badFile = path.join(dir, "bad-hash.txt");
fs.writeFileSync(badFile, "sha256$somehashvalue\\n", "utf8");
process.env.AUTH_PASSWORD_FILE = badFile;
process.env.AUTH_ADMIN_PASSWORD = "env-password-must-not-be-used-here";
import(${JSON.stringify(authUrl)}).then((auth) => {
  auth.__resetAuthSecretCacheForTests();
  try {
    auth.loadPersistedAdminPassword();
    console.error("UNEXPECTED_LOAD");
    process.exit(2);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/does not contain a valid|Refusing to fall back/i.test(msg)) {
      console.error("Unexpected:", msg);
      process.exit(3);
    }
    if (auth.verifyAdminCredentials("coderxpadmin", "env-password-must-not-be-used-here")) {
      console.error("ENV_FALLBACK_ACTIVATED");
      process.exit(4);
    }
    console.log("CASE_OK");
  }
}).catch((e) => { console.error(e); process.exit(1); });
`,
);

runCase(
  "malformed password file: truncated JSON",
  {
    AUTH_SESSION_SECRET: "test-only-session-secret-min-32-chars!!",
    DEVBOX_TOKEN_SECRET: "test-only-devbox-secret-min-32-chars!!!",
    AUTH_ADMIN_PASSWORD: "env-password-must-not-be-used-here",
    AUTH_PASSWORD_FILE: "",
  },
  `
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bad-json-"));
const badFile = path.join(dir, "truncated.json");
fs.writeFileSync(badFile, '{"version": 1, "hash": "pbkdf2$100000$', "utf8");
process.env.AUTH_PASSWORD_FILE = badFile;
process.env.AUTH_ADMIN_PASSWORD = "env-password-must-not-be-used-here";
import(${JSON.stringify(authUrl)}).then((auth) => {
  auth.__resetAuthSecretCacheForTests();
  try {
    auth.loadPersistedAdminPassword();
    console.error("UNEXPECTED_LOAD");
    process.exit(2);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/does not contain a valid|Refusing to fall back/i.test(msg)) {
      console.error("Unexpected:", msg);
      process.exit(3);
    }
    if (auth.verifyAdminCredentials("coderxpadmin", "env-password-must-not-be-used-here")) {
      console.error("ENV_FALLBACK_ACTIVATED");
      process.exit(4);
    }
    console.log("CASE_OK");
  }
}).catch((e) => { console.error(e); process.exit(1); });
`,
);

runCase(
  "malformed password file: wrong version / generation field",
  {
    AUTH_SESSION_SECRET: "test-only-session-secret-min-32-chars!!",
    DEVBOX_TOKEN_SECRET: "test-only-devbox-secret-min-32-chars!!!",
    AUTH_ADMIN_PASSWORD: "env-password-must-not-be-used-here",
    AUTH_PASSWORD_FILE: "",
  },
  `
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bad-ver-"));
const badFile = path.join(dir, "bad-version.txt");
fs.writeFileSync(badFile, "pbkdf2$100000$test\\ninvalid_gen_field\\n", "utf8");
process.env.AUTH_PASSWORD_FILE = badFile;
process.env.AUTH_ADMIN_PASSWORD = "env-password-must-not-be-used-here";
import(${JSON.stringify(authUrl)}).then((auth) => {
  auth.__resetAuthSecretCacheForTests();
  try {
    auth.loadPersistedAdminPassword();
    console.error("UNEXPECTED_LOAD");
    process.exit(2);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/does not contain a valid|Refusing to fall back/i.test(msg)) {
      console.error("Unexpected:", msg);
      process.exit(3);
    }
    if (auth.verifyAdminCredentials("coderxpadmin", "env-password-must-not-be-used-here")) {
      console.error("ENV_FALLBACK_ACTIVATED");
      process.exit(4);
    }
    console.log("CASE_OK");
  }
}).catch((e) => { console.error(e); process.exit(1); });
`,
);

runCase(
  "unreadable password file fails closed",
  {
    AUTH_SESSION_SECRET: "test-only-session-secret-min-32-chars!!",
    DEVBOX_TOKEN_SECRET: "test-only-devbox-secret-min-32-chars!!!",
    AUTH_ADMIN_PASSWORD: "env-password-must-not-be-used-here",
    AUTH_PASSWORD_FILE: "",
  },
  `
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
// Pointing to a directory causes existsSync to return true and readFileSync to throw EISDIR/EPERM
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unreadable-dir-"));
process.env.AUTH_PASSWORD_FILE = dir;
process.env.AUTH_ADMIN_PASSWORD = "env-password-must-not-be-used-here";
import(${JSON.stringify(authUrl)}).then((auth) => {
  auth.__resetAuthSecretCacheForTests();
  try {
    auth.loadPersistedAdminPassword();
    console.error("UNEXPECTED_LOAD");
    process.exit(2);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/unreadable|Refusing to fall back/i.test(msg)) {
      console.error("Unexpected:", msg);
      process.exit(3);
    }
    if (auth.verifyAdminCredentials("coderxpadmin", "env-password-must-not-be-used-here")) {
      console.error("ENV_FALLBACK_ACTIVATED");
      process.exit(4);
    }
    console.log("CASE_OK");
  }
}).catch((e) => { console.error(e); process.exit(1); });
`,
);

runCase(
  "non-durable credential state: persistence failure fails closed",
  {
    AUTH_SESSION_SECRET: "test-only-session-secret-min-32-chars!!",
    DEVBOX_TOKEN_SECRET: "test-only-devbox-secret-min-32-chars!!!",
    AUTH_ADMIN_PASSWORD: "initial-durable-password-2026",
    AUTH_PASSWORD_FILE: "",
  },
  `
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nondurable-test-"));
const passFile = path.join(dir, "pass.txt");
process.env.AUTH_PASSWORD_FILE = passFile;
process.env.AUTH_ADMIN_PASSWORD = "initial-durable-password-2026";
import(${JSON.stringify(authUrl)}).then(async (auth) => {
  auth.__resetAuthSecretCacheForTests();
  const initialGen = auth.getCredentialGeneration();
  const initialHash = auth.ADMIN_CONFIG.password;

  // Make passFile a directory so atomic rename / write fails
  if (fs.existsSync(passFile)) fs.unlinkSync(passFile);
  fs.mkdirSync(passFile, { recursive: true });

  let threw = false;
  try {
    await auth.updateAdminPassword("proposal-that-must-not-activate", {
      currentPassword: "initial-durable-password-2026",
      expectedGeneration: initialGen,
    });
  } catch {
    threw = true;
  }
  if (!threw) {
    console.error("EXPECTED_UPDATE_FAILURE");
    process.exit(2);
  }
  if (auth.ADMIN_CONFIG.password !== initialHash) {
    console.error("IN_MEMORY_STATE_MUTATED");
    process.exit(3);
  }
  if (auth.getCredentialGeneration() !== initialGen) {
    console.error("GENERATION_BUMPED");
    process.exit(4);
  }
  if (auth.verifyAdminCredentials("coderxpadmin", "proposal-that-must-not-activate")) {
    console.error("PROPOSAL_AUTHENTICATED");
    process.exit(5);
  }
  console.log("CASE_OK");
}).catch((e) => { console.error(e); process.exit(1); });
`,
);

runCase(
  "short AUTH_SESSION_SECRET rejected",
  {
    AUTH_SESSION_SECRET: "too-short",
    DEVBOX_TOKEN_SECRET: "test-only-devbox-secret-min-32-chars!!!",
    AUTH_ADMIN_PASSWORD: "temp-pass-for-config-test-onlyxx",
    AUTH_PASSWORD_FILE: path.join(os.tmpdir(), "no-auth-file-short"),
  },
  `
import { createSessionToken, __resetAuthSecretCacheForTests } from ${JSON.stringify(path.join(root, "lib/server/auth.ts"))};
__resetAuthSecretCacheForTests();
try {
  createSessionToken("u", "e@x.com");
  console.error("UNEXPECTED_SUCCESS");
  process.exit(2);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("AUTH_SESSION_SECRET")) {
    console.error("Unexpected:", msg);
    process.exit(3);
  }
  console.log("CASE_OK");
}
`,
);

console.log("=== ALL CONFIG FAIL-CLOSED TESTS PASSED ===");
