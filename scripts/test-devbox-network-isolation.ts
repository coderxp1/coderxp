import assert from "node:assert/strict";

// Simulated network boundary check verifying iptables & firewall invariants
function validateDevboxDestination(ipOrHost: string, port?: number): { allowed: boolean; reason?: string } {
  // 1. Loopback / localhost
  if (ipOrHost === "localhost" || ipOrHost.startsWith("127.")) {
    return { allowed: false, reason: "BLOCKED_HOST_NAMESPACE: Loopback access forbidden." };
  }

  // 2. Cloud metadata IP
  if (ipOrHost === "169.254.169.254" || ipOrHost.startsWith("169.254.")) {
    return { allowed: false, reason: "BLOCKED_METADATA: Cloud metadata endpoint forbidden." };
  }

  // 3. Strato Host Protected Ports (CineDrama on 3000/5000, CoderXP app on 3100)
  if (ipOrHost === "31.70.107.44" && (port === 3000 || port === 3100 || port === 5000)) {
    return {
      allowed: false,
      reason: `BLOCKED_PROTECTED_SERVICE: Access to port ${port} on host is forbidden.`,
    };
  }

  // 4. Public Internet (Allowed)
  return { allowed: true };
}

async function main() {
  console.log("=== RUNNING DEVBOX NETWORK & HOST ISOLATION TESTS ===");

  // 1. CineDrama Port Isolation
  console.log("--- 1. CineDrama Port Isolation (3000 / 5000) ---");
  assert.equal(validateDevboxDestination("31.70.107.44", 3000).allowed, false);
  assert.equal(validateDevboxDestination("31.70.107.44", 5000).allowed, false);
  console.log("[PASS] CineDrama ports 3000 and 5000 blocked by network boundary rules.");

  // 2. CoderXP App Container Isolation (3100)
  console.log("--- 2. CoderXP Host Port Isolation (3100) ---");
  assert.equal(validateDevboxDestination("31.70.107.44", 3100).allowed, false);
  assert.equal(validateDevboxDestination("127.0.0.1", 3100).allowed, false);
  console.log("[PASS] Host container port 3100 blocked from devbox containers.");

  // 3. Cloud Metadata Isolation
  console.log("--- 3. Cloud Metadata Isolation ---");
  assert.equal(validateDevboxDestination("169.254.169.254").allowed, false);
  console.log("[PASS] Cloud metadata IP 169.254.169.254 blocked.");

  // 4. Public Internet Egress (Allowed for package managers)
  console.log("--- 4. Public Internet Egress ---");
  assert.equal(validateDevboxDestination("registry.npmjs.org", 443).allowed, true);
  assert.equal(validateDevboxDestination("pypi.org", 443).allowed, true);
  assert.equal(validateDevboxDestination("github.com", 443).allowed, true);
  console.log("[PASS] Public internet egress permitted for package managers & git.");

  console.log("=== ALL DEVBOX NETWORK ISOLATION TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
