/**
 * Real-browser Playwright verification suite for CoderXP auth hardening.
 * Tests:
 * 1. Login with valid credentials (session cookie minted, redirect to workspace)
 * 2. Wrong password attempt (error alert shown, no session cookie)
 * 3. Expired / tampered session (rejected with 401)
 * 4. Password change invalidates existing sessions (prior session fails closed, new password works)
 * 5. Restart recovery (killing & restarting server preserves file-backed credentials and generation)
 */
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";

const root = path.resolve(__dirname, "..");
const PORT = 3192;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderxp-browser-auth-"));
const passwordFile = path.join(tmpDir, "auth-password.txt");

const testEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PORT: String(PORT),
  AUTH_SESSION_SECRET: "browser-test-session-secret-min-32-chars-long!",
  DEVBOX_TOKEN_SECRET: "browser-test-devbox-secret-min-32-chars-long!",
  AUTH_ADMIN_PASSWORD: "initial-browser-test-pass-2026",
  AUTH_PASSWORD_FILE: passwordFile,
  NODE_ENV: "production",
};

function killProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!proc.pid || proc.killed) {
      resolve();
      return;
    }
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
      killer.on("close", () => resolve());
      killer.on("error", () => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      });
    } else {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }
  });
}

async function waitForServer(timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/login`);
      if (res.status === 200) return;
    } catch {
      // wait
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server failed to start on ${BASE_URL} within ${timeoutMs}ms`);
}

function startServer(): ChildProcess {
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  const proc = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    cwd: root,
    env: testEnv,
    stdio: "pipe",
  });
  proc.stdout?.on("data", (d) => {
    const s = d.toString();
    if (process.env.DEBUG_AUTH_TEST) console.log(`[Next] ${s.trim()}`);
  });
  proc.stderr?.on("data", (d) => {
    const s = d.toString();
    if (process.env.DEBUG_AUTH_TEST) console.error(`[Next ERR] ${s.trim()}`);
  });
  return proc;
}

async function run(): Promise<void> {
  console.log("=== STARTING REAL-BROWSER AUTH VERIFICATION SUITE ===");
  console.log(`Disposable test directory: ${tmpDir}`);
  console.log(`Target port: ${PORT}`);

  let server = startServer();
  await waitForServer();
  console.log("[PASS] Next.js production server running on port " + PORT);

  const browser = await chromium.launch({ headless: true });

  try {
    // -------------------------------------------------------------
    // 1. Real-browser Login with Valid Credentials
    // -------------------------------------------------------------
    console.log("--- 1. Testing valid login flow ---");
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    await page1.goto(`${BASE_URL}/login`);

    await page1.fill('input[placeholder*="paul@coderxp.pro"]', "coderxpadmin");
    await page1.fill('input[type="password"]', "initial-browser-test-pass-2026");
    await page1.click('button[type="submit"]');

    await page1.waitForURL("**/workspace", { timeout: 10000 });
    assert.ok(page1.url().includes("/workspace"), "Must redirect to /workspace upon login");

    const cookies = await context1.cookies();
    const sessionCookie = cookies.find(
      (c) => c.name === "__Host-coderxp_session" || c.name === "coderxp_session",
    );
    if (!sessionCookie) {
      console.log("Cookies found in context:", JSON.stringify(cookies));
    }
    assert.ok(sessionCookie && sessionCookie.value.length > 20, "Session cookie must be set");
    const sessionCookieName = sessionCookie.name;
    const session1 = sessionCookie.value;

    // Verify session route via browser context
    const sessionCheck = await page1.evaluate(async (url) => {
      const res = await fetch(`${url}/api/auth/session`);
      return { status: res.status, data: await res.json() };
    }, BASE_URL);

    assert.equal(sessionCheck.status, 200);
    assert.equal(sessionCheck.data.authenticated, true);
    assert.equal(sessionCheck.data.user.role, "admin");
    console.log("[PASS] Valid login minted session cookie and authenticated workspace session.");

    // -------------------------------------------------------------
    // 2. Real-browser Wrong Password Rejection
    // -------------------------------------------------------------
    console.log("--- 2. Testing wrong password rejection ---");
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.goto(`${BASE_URL}/login`);

    await page2.fill('input[placeholder*="paul@coderxp.pro"]', "coderxpadmin");
    await page2.fill('input[type="password"]', "incorrect-password-attempt");
    await page2.click('button[type="submit"]');

    // Wait for error alert to display
    const alertSelector = "div.bg-red-950\\/40";
    await page2.waitForSelector(alertSelector, { timeout: 5000 });
    const errorText = await page2.textContent(alertSelector);
    assert.ok(
      /invalid/i.test(errorText || ""),
      `Error text must indicate invalid credentials, got: ${errorText}`,
    );

    const cookies2 = await context2.cookies();
    const sessionCookie2 = cookies2.find(
      (c) => c.name === sessionCookieName || c.name === "__Host-coderxp_session" || c.name === "coderxp_session",
    );
    assert.equal(sessionCookie2, undefined, "No session cookie should be set on wrong password");
    assert.ok(page2.url().includes("/login"), "User must remain on login page");
    await context2.close();
    console.log("[PASS] Wrong password rejected, error displayed in UI, no cookie issued.");

    // -------------------------------------------------------------
    // 3. Expired / Tampered Session Rejection
    // -------------------------------------------------------------
    console.log("--- 3. Testing tampered/expired session rejection ---");
    // Test tampered signature
    const tamperedRes = await fetch(`${BASE_URL}/api/auth/session`, {
      headers: { Cookie: `${sessionCookieName}=${session1}tampered_signature_bits` },
    });
    assert.equal(tamperedRes.status, 401, "Tampered session must return HTTP 401");
    const tamperedData = await tamperedRes.json();
    assert.equal(tamperedData.authenticated, false);
    assert.ok(
      /invalid session signature|signature/i.test(tamperedData.error || ""),
      `Error must indicate invalid signature, got: ${tamperedData.error}`,
    );

    // Test expired session token
    const parts = session1.split(".");
    const rawPayload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const expiredPayload = { ...rawPayload, expiresAt: Date.now() - 3600000 };
    const expiredB64 = Buffer.from(JSON.stringify(expiredPayload)).toString("base64url");
    const crypto = await import("node:crypto");
    const expiredSig = crypto
      .createHmac("sha256", testEnv.AUTH_SESSION_SECRET!)
      .update(expiredB64)
      .digest("base64url");
    const expiredToken = `${expiredB64}.${expiredSig}`;

    const expiredRes = await fetch(`${BASE_URL}/api/auth/session`, {
      headers: { Cookie: `${sessionCookieName}=${expiredToken}` },
    });
    assert.equal(expiredRes.status, 401, "Expired session must return HTTP 401");
    const expiredData = await expiredRes.json();
    assert.equal(expiredData.authenticated, false);
    assert.ok(
      /expired/i.test(expiredData.error || ""),
      `Error must indicate expired token, got: ${expiredData.error}`,
    );

    console.log("[PASS] Tampered and expired session tokens rejected with HTTP 401.");

    // -------------------------------------------------------------
    // 4. Password Change Session Invalidation
    // -------------------------------------------------------------
    console.log("--- 4. Testing password change session invalidation ---");
    // Change password using the active authenticated session in context1
    const changeRes = await page1.evaluate(async (url) => {
      const res = await fetch(`${url}/api/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: "initial-browser-test-pass-2026",
          newPassword: "new-hardened-password-2026",
        }),
      });
      return { status: res.status, data: await res.json() };
    }, BASE_URL);

    assert.equal(changeRes.status, 200, "Password change must succeed");
    assert.equal(changeRes.data.ok, true);
    assert.equal(changeRes.data.sessionsInvalidated, true);

    // Confirm that the previous session1 token is NOW INVALIDATED on the server
    const postChangeCheck = await fetch(`${BASE_URL}/api/auth/session`, {
      headers: { Cookie: `${sessionCookieName}=${session1}` },
    });
    assert.equal(postChangeCheck.status, 401, "Prior session token must be rejected with 401");
    const postChangeBody = await postChangeCheck.json();
    assert.equal(postChangeBody.authenticated, false);
    assert.ok(
      /invalidated by credential change/i.test(postChangeBody.error || ""),
      `Error must specify session invalidated, got: ${postChangeBody.error}`,
    );

    // Verify old password cannot log in anymore
    const oldLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "coderxpadmin",
        password: "initial-browser-test-pass-2026",
      }),
    });
    assert.equal(oldLoginRes.status, 401, "Old password must be rejected");

    // Verify new password can log in and mint new session
    const context4 = await browser.newContext();
    const page4 = await context4.newPage();
    await page4.goto(`${BASE_URL}/login`);
    await page4.fill('input[placeholder*="paul@coderxp.pro"]', "coderxpadmin");
    await page4.fill('input[type="password"]', "new-hardened-password-2026");
    await page4.click('button[type="submit"]');
    await page4.waitForURL("**/workspace", { timeout: 10000 });

    const cookies4 = await context4.cookies();
    const sessionCookie4 = cookies4.find(
      (c) => c.name === sessionCookieName || c.name === "__Host-coderxp_session" || c.name === "coderxp_session",
    );
    assert.ok(sessionCookie4, "New session cookie must be present");
    const session2 = sessionCookie4.value;
    assert.notEqual(session1, session2, "New session token must differ from old token");

    console.log("[PASS] Password change invalidated prior sessions and activated new credentials.");

    // -------------------------------------------------------------
    // 5. Server Kill & Restart Recovery
    // -------------------------------------------------------------
    console.log("--- 5. Testing server kill and restart recovery ---");
    console.log("Terminating running Next.js server process (PID: " + server.pid + ")...");
    await killProcess(server);
    console.log("Server process terminated. Verifying server is down...");

    let serverDown = false;
    try {
      await fetch(`${BASE_URL}/login`);
    } catch {
      serverDown = true;
    }
    assert.equal(serverDown, true, "Server must be down after termination");

    console.log("Starting new Next.js server process from persisted file state...");
    server = startServer();
    await waitForServer();
    console.log("New server process running (PID: " + server.pid + ").");

    // Verify old session1 remains invalid across restart
    const restartOldSessionCheck = await fetch(`${BASE_URL}/api/auth/session`, {
      headers: { Cookie: `${sessionCookieName}=${session1}` },
    });
    assert.equal(
      restartOldSessionCheck.status,
      401,
      "Prior generation session must remain invalid after restart",
    );

    // Verify session2 (minted under updated generation) survives restart
    const restartNewSessionCheck = await fetch(`${BASE_URL}/api/auth/session`, {
      headers: { Cookie: `${sessionCookieName}=${session2}` },
    });
    assert.equal(
      restartNewSessionCheck.status,
      200,
      "Session minted at current generation must survive restart",
    );
    const restartData = await restartNewSessionCheck.json();
    assert.equal(restartData.authenticated, true);

    // Verify new password continues to work in fresh browser
    const context5 = await browser.newContext();
    const page5 = await context5.newPage();
    await page5.goto(`${BASE_URL}/login`);
    await page5.fill('input[placeholder*="paul@coderxp.pro"]', "coderxpadmin");
    await page5.fill('input[type="password"]', "new-hardened-password-2026");
    await page5.click('button[type="submit"]');
    await page5.waitForURL("**/workspace", { timeout: 10000 });
    assert.ok(page5.url().includes("/workspace"));
    await context5.close();

    console.log("[PASS] Server restart recovered persisted credentials and valid generation state.");

    await context1.close();
    await context4.close();
  } finally {
    await browser.close();
    await killProcess(server);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  console.log("=== ALL REAL-BROWSER AUTH TESTS PASSED ===");
}

run().catch((err) => {
  console.error("FATAL BROWSER TEST FAILURE:", err);
  process.exit(1);
});
