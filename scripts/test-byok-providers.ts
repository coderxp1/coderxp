import assert from "node:assert/strict";
import { maskApiKey, encryptSecret, decryptSecret } from "../lib/workspace/byok-crypto";
import {
  BYOK_PROVIDER_DEFS,
  type ByokProviderId,
} from "../lib/workspace/byok-providers";
import { saveServerByok } from "../lib/workspace/byok-server-store";

async function main() {
  console.log("=== RUNNING REVISION 2.3 BYOK PROVIDERS TEST ===");

  // 1. Key Masking Tests
  console.log("--- 1. Key Masking Tests ---");
  assert.equal(maskApiKey(""), "");
  assert.equal(maskApiKey(null), "");
  assert.equal(maskApiKey("123"), "••••");
  assert.equal(maskApiKey("sk-ant-api03-1234567890abcdef"), "…cdef");
  assert.equal(maskApiKey("AIzaSyD-abcdef1234"), "…1234");
  console.log("[PASS] Key masking returns …last4 as expected.");

  // 2. Encryption & Decryption Round-Trip
  console.log("--- 2. Key Encryption & Decryption ---");
  const plain = "sk-secret-key-1234567890-test-payload";
  const encrypted = await encryptSecret(plain);
  assert.notEqual(encrypted, plain, "Encrypted text differs from plaintext");
  assert.equal(typeof encrypted, "string");

  const decrypted = await decryptSecret(encrypted);
  assert.equal(decrypted, plain, "Decrypted text matches original plaintext");
  console.log("[PASS] AES-GCM encryption & decryption round-trip verified.");

  // 3. Provider Definitions Parity
  console.log("--- 3. Provider Registry Coverage ---");
  const expectedProviders: ByokProviderId[] = [
    "anthropic",
    "openai",
    "gemini",
    "mistral",
    "openrouter",
    "ollama",
    "xai",
    "huggingface",
    "custom",
  ];

  for (const pid of expectedProviders) {
    const def = BYOK_PROVIDER_DEFS[pid];
    assert.ok(def, `Provider "${pid}" is registered in registry`);
    assert.ok(def.name, `Provider "${pid}" has human-readable name`);
    assert.ok(Array.isArray(def.defaultModels), `Provider "${pid}" has models array`);
    assert.ok(def.defaultModels.length > 0, `Provider "${pid}" has at least 1 default model`);
  }
  console.log(`[PASS] All ${expectedProviders.length} BYOK providers defined with models.`);

  // 4. Custom Provider SSRF Guard
  console.log("--- 4. SSRF Guard on Custom Base URL ---");
  const loopbackCustom = await saveServerByok("test_user", "custom", "key-123", {
    baseUrl: "http://127.0.0.1:8080/v1",
  });
  assert.equal(loopbackCustom.ok, false, "Localhost/loopback base URL is rejected by SSRF guard");
  assert.ok(loopbackCustom.error?.includes("Invalid or forbidden Base URL"));

  const metadataCustom = await saveServerByok("test_user", "custom", "key-123", {
    baseUrl: "http://169.254.169.254/v1",
  });
  assert.equal(metadataCustom.ok, false, "Cloud metadata base URL is rejected by SSRF guard");

  console.log("[PASS] Custom provider endpoints gated by SSRF guard.");

  console.log("=== ALL BYOK PROVIDERS TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
