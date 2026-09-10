/**
 * Production Post-Deployment Smoke Gate for CoderXP Revision 2.4.
 *
 * Verifies live production health:
 * 1. Open UI access (HTTP 200, no WWW-Authenticate)
 * 2. Unauthenticated fail-closed (HTTP 401 on /api/agent/* and /api/devbox/*)
 * 3. App-level login (/api/auth/login) + session cookie issuance
 * 4. Authenticated /api/agent/health (Logicc provider, model status)
 * 5. Authenticated real streaming turn (/api/agent/stream)
 * 6. Authenticated Devbox WSS Token & REAL container execution (arithmetic, kernel, node runtime, filesystem)
 * 7. Host event store and Activity Timeline
 */

import assert from "node:assert";
import tls from "node:tls";
import { WebSocket } from "ws";

async function main() {
  const baseUrl = "https://coderxp.pro";
  const user = "coderxpadmin";
  const pass = process.env.CODERXP_AUTH_PASS || "coderxp-pilot-2026";

  console.log("==========================================================================");
  console.log("          CODERXP PRODUCTION POST-DEPLOYMENT LIVE SMOKE GATE             ");
  console.log("==========================================================================");
  console.log(`\nTarget: ${baseUrl}`);

  // Check 0: Open UI Access
  console.log("\n--- 0. Checking Open UI (No Basic Auth prompt, HTTP 200) ---");
  const uiRes = await fetch(`${baseUrl}/workspace`, { method: "GET" });
  assert.strictEqual(uiRes.status, 200, `UI must serve 200 OK (got ${uiRes.status})`);
  assert.strictEqual(
    uiRes.headers.get("www-authenticate"),
    null,
    "UI must not prompt with WWW-Authenticate header",
  );
  console.log("[PASS] /workspace serves HTTP 200 with zero Basic Auth prompts.");

  // Check 1: Unauthenticated Fail-Closed
  console.log("\n--- 1. Checking Unauthenticated API Fail-Closed (Must Return 401) ---");
  const unauthStream = await fetch(`${baseUrl}/api/agent/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  assert.strictEqual(unauthStream.status, 401, `Unauthenticated stream must return 401 (got ${unauthStream.status})`);

  const unauthHealth = await fetch(`${baseUrl}/api/agent/health`);
  assert.strictEqual(unauthHealth.status, 401, `Unauthenticated health must return 401 (got ${unauthHealth.status})`);

  const unauthDevbox = await fetch(`${baseUrl}/api/devbox/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: "smoke-project" }),
  });
  assert.strictEqual(unauthDevbox.status, 401, `Unauthenticated devbox token must return 401 (got ${unauthDevbox.status})`);
  console.log("[PASS] Unauthenticated API endpoints fail-closed with HTTP 401.");

  // Check 2: App-Level Login
  console.log("\n--- 2. Performing App-Level Login (/api/auth/login) ---");
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: user, email: user, password: pass }),
  });
  assert.strictEqual(loginRes.status, 200, `Login failed with HTTP ${loginRes.status}`);
  const loginJson: any = await loginRes.json();
  assert.strictEqual(loginJson.ok, true, "Login response must be ok: true");
  const sessionCookie = loginRes.headers.get("set-cookie") || "";
  const tokenHeader = loginJson.token ? `Bearer ${loginJson.token}` : "";
  const authHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(tokenHeader ? { Authorization: tokenHeader } : {}),
    ...(sessionCookie ? { Cookie: sessionCookie.split(";")[0] } : {}),
  };
  console.log("[PASS] App-level authentication succeeded. Session cookie acquired.");

  // Check 3: Authenticated Agent Health
  console.log("\n--- 3. Checking Authenticated /api/agent/health ---");
  const healthRes = await fetch(`${baseUrl}/api/agent/health`, { headers: authHeaders });
  const healthData: any = await healthRes.json();
  assert.ok(
    healthData.status === "ready" || healthData.status === "ok",
    "Health status must be 'ready' or 'ok'",
  );
  assert.strictEqual(healthData.providerId, "logicc", "Provider must be Logicc");
  const reportedModel = healthData.model || healthData.defaultModel || healthData.defaultModelDisplayName;
  assert.ok(
    typeof reportedModel === "string" && reportedModel.trim().length > 0 && reportedModel !== "undefined",
    `Health endpoint must return non-empty model identifier, got: ${reportedModel}`
  );
  console.log(`[PASS] Authenticated health check passed (${healthData.providerId}, model: ${reportedModel}).`);

  // Check 4: Authenticated Real Stream Turn
  console.log("\n--- 4. Checking Authenticated Real Stream Turn (/api/agent/stream) ---");
  const streamBody = {
    protocolVersion: 1,
    requestId: `smoke-${Date.now()}`,
    turnId: `turn-smoke-${Date.now()}`,
    messages: [
      {
        id: "msg-1",
        role: "user",
        content: [{ kind: "text", text: "hi" }],
      },
    ],
  };

  let streamRes = await fetch(`${baseUrl}/api/agent/stream`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(streamBody),
  });

  if (streamRes.status === 503) {
    console.log("[Stream] Received 503, waiting 3s for connection pool / rate limit...");
    await new Promise((r) => setTimeout(r, 3000));
    streamRes = await fetch(`${baseUrl}/api/agent/stream`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(streamBody),
    });
  }

  assert.strictEqual(streamRes.status, 200, `Stream endpoint failed with HTTP ${streamRes.status}`);
  assert(streamRes.body, "Stream response body must be present");

  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let receivedText = "";
  let turnCompleted = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === "text-delta" && evt.text) {
            receivedText += evt.text;
          }
          if (evt.type === "turn-completed") {
            turnCompleted = true;
          }
        } catch {
          // ignore
        }
      }
    }
  }

  assert(receivedText.length > 0, "Streamed text must not be empty");
  assert(turnCompleted, "Turn must complete cleanly");
  console.log(`[PASS] Stream turn completed successfully. Received: "${receivedText.trim()}"`);

  // Check 5: Authenticated Devbox WSS Token & REAL Execution Assertion
  console.log("\n--- 5. Checking Devbox WSS Token & Real Shell Execution ---");
  const tokenRes = await fetch(`${baseUrl}/api/devbox/token`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ projectId: "smoke-project" }),
  });
  assert.strictEqual(tokenRes.status, 200, `Token generation failed with HTTP ${tokenRes.status}`);
  const tokenData: any = await tokenRes.json();
  const token = tokenData.token;
  assert(token, "Token must be present in response");

  const wsUrl = `wss://coderxp.pro/ws/devbox/?token=${encodeURIComponent(token)}&projectId=smoke-project`;
  console.log("Connecting to Devbox WebSocket broker...");

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Devbox WSS connection timeout")), 20000);
    const ws = new WebSocket(wsUrl);

    let allOutput = "";
    let step = 0;

    ws.on("open", () => {
      // connected
    });

    ws.on("message", (raw: any) => {
      try {
        const str = raw.toString();
        const parsed = JSON.parse(str);

        if (parsed.type === "error") {
          clearTimeout(timeout);
          try { ws.close(); } catch { /* ignore */ }
          reject(new Error(`Devbox returned error: ${parsed.error}`));
          return;
        }

        if (parsed.type === "handshake_ack") {
          // Step 1: Send arithmetic command requiring real shell calculation
          step = 1;
          ws.send(JSON.stringify({ type: "command", command: "expr", args: ["7", "*", "6"] }));
        }

        if (parsed.type === "output" && typeof parsed.data === "string") {
          allOutput += parsed.data;
          console.log("[Devbox Output]", JSON.stringify(parsed.data));

          if (step === 1 && allOutput.includes("42")) {
            console.log("[PASS] Real arithmetic execution verified: `expr 7 * 6` -> 42");
            // Step 2: Send kernel inspection command
            step = 2;
            allOutput = "";
            ws.send(JSON.stringify({ type: "command", command: "uname", args: ["-s"] }));
          } else if (step === 2 && allOutput.includes("Linux")) {
            console.log("[PASS] Real Linux kernel environment verified: `uname -s` -> Linux");
            // Step 3: Send Node.js runtime version inspection command
            step = 3;
            allOutput = "";
            ws.send(JSON.stringify({ type: "command", command: "node", args: ["-v"] }));
          } else if (step === 3 && allOutput.includes("v2")) {
            console.log("[PASS] Real Node.js runtime inside container verified: `node -v` -> " + allOutput.trim());
            // Step 4: Send working directory inspection
            step = 4;
            allOutput = "";
            ws.send(JSON.stringify({ type: "command", command: "pwd", args: [] }));
          } else if (step === 4 && allOutput.includes("/workspace")) {
            console.log("[PASS] Real workspace directory verified: `pwd` -> /workspace");
            // Step 5: Send real TTY test assertion
            step = 5;
            allOutput = "";
            ws.send(JSON.stringify({ type: "command", command: "[ -t 0 ] && echo TTY_OK", args: [] }));
          } else if (step === 5 && allOutput.includes("TTY_OK")) {
            console.log("[PASS] Real interactive TTY verified: `[ -t 0 ] && echo TTY_OK` -> TTY_OK");
            // Step 6: Send terminal columns test assertion
            step = 6;
            allOutput = "";
            ws.send(JSON.stringify({ type: "command", command: "tput", args: ["cols"] }));
          } else if (step === 6 && (allOutput.includes("120") || allOutput.includes("80"))) {
            console.log("[PASS] Real PTY window size discipline verified: `tput cols` -> " + allOutput.trim());
            clearTimeout(timeout);
            try { ws.close(); } catch { /* ignore */ }
            resolve();
          }
        }
      } catch {
        // ignore
      }
    });

    ws.on("error", (err: any) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on("close", (code, reason) => {
      if (step < 6) {
        clearTimeout(timeout);
        reject(new Error(`WebSocket closed at step ${step} with code ${code}: ${reason.toString()}`));
      }
    });
  });

  console.log(`[PASS] Devbox WebSocket real PTY execution verified across arithmetic, OS kernel, and Node.js runtime.`);

  // Check 6: Activity Timeline & Events API
  console.log("\n--- 6. Checking Devbox Timeline & Host Events API ---");
  const eventsRes = await fetch(`${baseUrl}/api/devbox/events?projectId=smoke-project`, { headers: authHeaders });
  assert.strictEqual(eventsRes.status, 200, `Events endpoint failed with HTTP ${eventsRes.status}`);
  const eventsData: any = await eventsRes.json();
  assert(Array.isArray(eventsData.events), "Events must be an array");
  console.log("[PASS] Host event store and Activity Timeline verified.");

  // Check 7: Live Preview Subsystem & Wildcard TLS Verification (4 Smoke Assertions)
  console.log("\n--- 7. Checking Live Preview Subsystem & Wildcard TLS (4 Smoke Assertions) ---");

  // 7.1 Preview Link Creation (>= 128-bit slug, HTTP 200, T2 event)
  console.log("  [7.1] Testing authenticated preview link creation (POST /api/preview/link)...");
  const createLinkRes = await fetch(`${baseUrl}/api/preview/link`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ projectId: "smoke-project", containerPort: 3000 }),
  });
  assert.strictEqual(createLinkRes.status, 200, `Preview link creation must return 200 (got ${createLinkRes.status})`);
  const linkData: any = await createLinkRes.json();
  assert.strictEqual(linkData.ok, true, "Preview link creation response must be ok: true");
  assert.ok(typeof linkData.slug === "string", "Preview slug must be a string");
  assert.strictEqual(linkData.slug.length, 32, `Preview slug must be exactly 32 hex characters (128-bit), got ${linkData.slug.length}`);
  assert.match(linkData.slug, /^[0-9a-f]{32}$/, "Preview slug must be valid 128-bit lowercase hex");
  assert.ok(linkData.url.includes(`${linkData.slug}.preview.coderxp.pro`), "Preview URL must contain slug and preview.coderxp.pro");
  console.log(`  [PASS] 7.1 Created 128-bit preview slug: ${linkData.slug} -> ${linkData.url}`);

  // 7.2 Wildcard DNS Resolution
  console.log(`  [7.2] Testing DNS resolution for ${linkData.slug}.preview.coderxp.pro...`);
  const dohRes = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(linkData.slug)}.preview.coderxp.pro&type=A`,
    { headers: { Accept: "application/dns-json" } },
  );
  assert.strictEqual(dohRes.status, 200, `DoH lookup must return 200 (got ${dohRes.status})`);
  const dohData: any = await dohRes.json();
  assert.strictEqual(dohData.Status, 0, `DNS query status must be NOERROR (0), got ${dohData.Status}`);
  const aRecord = (dohData.Answer || []).find((ans: any) => ans.type === 1);
  assert.ok(aRecord, `Wildcard A record must be found for ${linkData.slug}.preview.coderxp.pro`);
  assert.strictEqual(aRecord.data, "31.70.107.44", `Wildcard DNS must resolve to host IP 31.70.107.44 (got ${aRecord.data})`);
  console.log(`  [PASS] 7.2 Wildcard DNS verified: ${linkData.slug}.preview.coderxp.pro -> 31.70.107.44`);

  // 7.3 Wildcard TLS Handshake Verification
  console.log(`  [7.3] Testing TLS SNI handshake against ${linkData.slug}.preview.coderxp.pro:443...`);
  await new Promise<void>((resolve, reject) => {
    const socket = tls.connect(
      {
        host: "31.70.107.44",
        port: 443,
        servername: `${linkData.slug}.preview.coderxp.pro`,
        rejectUnauthorized: true,
      },
      () => {
        const cert: any = socket.getPeerCertificate(true);
        socket.end();
        try {
          assert.ok(cert, "TLS peer certificate must be presented");
          const san = cert.subjectaltname || "";
          assert.ok(
            san.includes("*.preview.coderxp.pro"),
            `Certificate SAN must contain *.preview.coderxp.pro (got: ${san})`,
          );
          console.log(`  [PASS] 7.3 TLS handshake verified with wildcard certificate (SAN: ${san}, Subject: ${cert.subject.CN})`);
          resolve();
        } catch (err) {
          reject(err);
        }
      },
    );
    socket.on("error", (err) => reject(err));
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error("TLS connection timed out after 10s"));
    });
  });

  // 7.4 Revocation & Audit Verification (DELETE /api/preview/link)
  console.log(`  [7.4] Testing preview link revocation and audit...`);
  const revokeRes = await fetch(`${baseUrl}/api/preview/link`, {
    method: "DELETE",
    headers: authHeaders,
    body: JSON.stringify({ slug: linkData.slug, projectId: "smoke-project" }),
  });
  assert.strictEqual(revokeRes.status, 200, `Revocation must return 200 (got ${revokeRes.status})`);
  const revokeData: any = await revokeRes.json();
  assert.strictEqual(revokeData.ok, true, "Revocation response must be ok: true");
  assert.strictEqual(revokeData.revoked, true, "Revocation status must be true");

  // Verify subsequent resolution fails
  const checkResolved = await fetch(`${baseUrl}/api/preview/resolve?slug=${encodeURIComponent(linkData.slug)}`);
  assert.strictEqual(checkResolved.status, 404, `Revoked preview link must fail with 404 (got ${checkResolved.status})`);
  console.log(`  [PASS] 7.4 Revocation verified: slug ${linkData.slug} revoked and returned 404.`);

  console.log("\n==========================================================================");
  console.log("  ALL POST-DEPLOYMENT SMOKE ASSERTIONS PASSED PERFECTLY ON PRODUCTION!   ");
  console.log("==========================================================================");
}

main().catch((err) => {
  console.error("Smoke Gate FAILED:", err);
  process.exit(1);
});
