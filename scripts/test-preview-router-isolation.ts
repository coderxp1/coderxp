import assert from "node:assert";
import http from "node:http";
import { isValidContainerIp, resolveContainerDestination, server } from "../server/preview-router-server";

async function runTests() {
  console.log("==========================================================================");
  console.log("       CODERXP PREVIEW ROUTER ISOLATION & FAIL-CLOSED REGRESSION TEST     ");
  console.log("==========================================================================");

  // 1. IP Validation Unit Tests
  console.log("\n--- 1. Testing isValidContainerIp SSRF & Loopback Filter ---");
  const rejectedIps = [
    "127.0.0.1",
    "127.0.0.2",
    "127.1.2.3",
    "0.0.0.0",
    "::1",
    "localhost",
    "169.254.169.254",
    "fe80::1",
    "",
    "   ",
    "999.999.999.999",
    "not-an-ip",
  ];

  for (const ip of rejectedIps) {
    assert.strictEqual(
      isValidContainerIp(ip),
      false,
      `IP '${ip}' MUST be rejected by isValidContainerIp`,
    );
  }
  console.log("[PASS] All loopback, link-local, unspecified, and invalid IPs rejected.");

  const validIps = ["172.20.0.2", "172.17.0.5", "10.0.4.15", "192.168.1.50"];
  for (const ip of validIps) {
    assert.strictEqual(
      isValidContainerIp(ip),
      true,
      `Valid container IP '${ip}' must be accepted`,
    );
  }
  console.log("[PASS] Valid container private IPs accepted.");

  // 2. Container Destination Resolution Fail-Closed Tests
  console.log("\n--- 2. Testing resolveContainerDestination Fail-Closed Guarantees ---");

  // Missing / undefined project ID
  const missingProject = await resolveContainerDestination(undefined, 3000);
  assert.strictEqual(missingProject.ok, false);
  assert.strictEqual(missingProject.status, 502);
  console.log("[PASS] Missing project ID fails closed with 502.");

  // Malicious / traversal project ID
  const traversalProject = await resolveContainerDestination("../../../bin/sh", 3000);
  assert.strictEqual(traversalProject.ok, false);
  assert.strictEqual(traversalProject.status, 502);
  console.log("[PASS] Path-traversal project ID fails closed with 502.");

  // Missing / invalid port
  const invalidPort0 = await resolveContainerDestination("test-proj", 0);
  assert.strictEqual(invalidPort0.ok, false);
  assert.strictEqual(invalidPort0.status, 502);

  const invalidPortNeg = await resolveContainerDestination("test-proj", -1);
  assert.strictEqual(invalidPortNeg.ok, false);
  assert.strictEqual(invalidPortNeg.status, 502);

  const invalidPortHigh = await resolveContainerDestination("test-proj", 70000);
  assert.strictEqual(invalidPortHigh.ok, false);
  assert.strictEqual(invalidPortHigh.status, 502);

  const invalidPortUndef = await resolveContainerDestination("test-proj", undefined);
  assert.strictEqual(invalidPortUndef.ok, false);
  assert.strictEqual(invalidPortUndef.status, 502);
  console.log("[PASS] Missing, negative, zero, and out-of-range ports fail closed with 502.");

  // Non-existent container
  const nonExistent = await resolveContainerDestination("non-existent-proj-9999", 3000);
  assert.strictEqual(nonExistent.ok, false);
  assert.strictEqual(nonExistent.status, 502);
  assert.ok(nonExistent.error.includes("not found"));
  console.log("[PASS] Non-existent container fails closed with 502 (error: not found on Docker network).");

  // 3. Loopback Honeypot End-to-End Prevention Test
  console.log("\n--- 3. Testing Loopback Honeypot Isolation via Live HTTP Request ---");
  let honeypotHitCount = 0;
  const honeypotPort = 3998;
  const honeypotServer = http.createServer((_req, res) => {
    honeypotHitCount++;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("HONEYPOT_TRIGGERED");
  });

  await new Promise<void>((resolve) => honeypotServer.listen(honeypotPort, "127.0.0.1", resolve));

  const routerPort = 3499;
  await new Promise<void>((resolve) => server.listen(routerPort, "127.0.0.1", resolve));

  try {
    // Send a request with a slug whose container does NOT exist
    const res = await fetch(`http://127.0.0.1:${routerPort}/`, {
      headers: {
        "x-preview-slug": "test-isolation-slug-nonexistent",
        Host: "test-isolation-slug-nonexistent.preview.coderxp.pro",
      },
    });

    // It must return 404 (unknown slug) or 502, but NEVER touch loopback!
    assert.ok(
      res.status === 404 || res.status === 502 || res.status === 400,
      `Status must be 404 or 502, got ${res.status}`,
    );
    assert.strictEqual(
      honeypotHitCount,
      0,
      "CRITICAL ISOLATION FAILURE: Router contacted loopback honeypot server!",
    );
    console.log(`[PASS] Request returned status ${res.status}. Honeypot hits: 0 (Zero loopback contact verified).`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => honeypotServer.close(() => resolve()));
  }

  console.log("\n==========================================================================");
  console.log("   SUCCESS: ALL PREVIEW ROUTER ISOLATION REGRESSION TESTS PASSED (100%)   ");
  console.log("==========================================================================");
}

runTests().catch((err) => {
  console.error("FATAL ERROR in test-preview-router-isolation:", err);
  process.exit(1);
});
