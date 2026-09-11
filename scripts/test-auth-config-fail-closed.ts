/**
 * Configuration fail-closed regression: missing secrets must not soft-fail to defaults.
 * Isolated child processes avoid module cache masking unset configuration.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const root = path.resolve(__dirname, "..");
const tsxBin = path.join(root, "node_modules", ".bin", "tsx");

function runCase(name: string, env: Record<string, string>, scriptBody: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coderxp-cfg-"));
  const scriptPath = path.join(dir, "case.ts");
  fs.writeFileSync(scriptPath, scriptBody, "utf8");
  const result = spawnSync(tsxBin, [scriptPath], {
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
  "malformed password file does not fall back to env",
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
fs.writeFileSync(badFile, "not-a-valid-pbkdf2-hash\\n", "utf8");
process.env.AUTH_PASSWORD_FILE = badFile;
process.env.AUTH_ADMIN_PASSWORD = "env-password-must-not-be-used-here";
import(${JSON.stringify(path.join(root, "lib/server/auth.ts"))}).then((auth) => {
  auth.__resetAuthSecretCacheForTests();
  try {
    auth.loadPersistedAdminPassword();
    console.error("UNEXPECTED_LOAD");
    process.exit(2);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/unreadable|does not contain a valid|Refusing to fall back/i.test(msg)) {
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
