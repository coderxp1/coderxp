import assert from "node:assert";
import { validateAndTranslateLogiccRequest } from "../lib/server/agent-logicc-adapter";
import { validateAndTranslateRequest as validateAndTranslateAnthropicRequest } from "../lib/server/agent-anthropic-adapter";

console.log("==========================================================================");
console.log("              MESSAGE NORMALIZATION REGRESSION TEST SUITE                 ");
console.log("==========================================================================\n");

const logiccOptions = {
  model: "azure/gpt-4o",
  approvedModels: [{ id: "azure/gpt-4o", displayName: "GPT-4o", tier: "default" as const }],
  defaultModelId: "azure/gpt-4o",
};

// 1. Test Format 1: Canonical parts format
console.log("--- 1. Canonical parts format ---");
const canonicalRequest = {
  protocolVersion: 1,
  requestId: "req-canonical-1",
  turnId: "turn-canonical-1",
  messages: [
    { id: "m1", role: "user" as const, parts: [{ type: "text" as const, text: "Canonical user message" }] },
  ],
};

const logiccRes1 = validateAndTranslateLogiccRequest(canonicalRequest as any, logiccOptions);
assert.strictEqual(logiccRes1.ok, true, "Logicc should accept canonical parts");
if (logiccRes1.ok && "body" in logiccRes1) {
  const body = logiccRes1.body as any;
  assert.strictEqual(body.messages[0].role, "user");
  assert.strictEqual(body.messages[0].content, "Canonical user message");
}
console.log("[PASS] Logicc accepted canonical parts format.");

const anthropicRes1 = validateAndTranslateAnthropicRequest(canonicalRequest as any, { model: "claude-3-5-sonnet-20241022" });
assert.strictEqual(anthropicRes1.ok, true, "Anthropic should accept canonical parts");
console.log("[PASS] Anthropic accepted canonical parts format.");

// 2. Test Format 2: Content block array format (from client UI)
console.log("\n--- 2. Content block array format (UI client) ---");
const blockRequest = {
  protocolVersion: 1,
  requestId: "req-block-1",
  turnId: "turn-block-1",
  messages: [
    { id: "m2", role: "user" as const, content: [{ kind: "text", text: "Block user message" }] },
  ],
};

const logiccRes2 = validateAndTranslateLogiccRequest(blockRequest as any, logiccOptions);
assert.strictEqual(logiccRes2.ok, true, "Logicc should accept block content array");
if (logiccRes2.ok && "body" in logiccRes2) {
  const body = logiccRes2.body as any;
  assert.strictEqual(body.messages[0].role, "user");
  assert.strictEqual(body.messages[0].content, "Block user message");
}
console.log("[PASS] Logicc accepted content block array format.");

const anthropicRes2 = validateAndTranslateAnthropicRequest(blockRequest as any, { model: "claude-3-5-sonnet-20241022" });
assert.strictEqual(anthropicRes2.ok, true, "Anthropic should accept block content array");
console.log("[PASS] Anthropic accepted content block array format.");

// 3. Test Format 3: Plain string content format
console.log("\n--- 3. Plain string content format ---");
const stringRequest = {
  protocolVersion: 1,
  requestId: "req-str-1",
  turnId: "turn-str-1",
  messages: [
    { id: "m3", role: "user" as const, content: "Plain string user message" },
  ],
};

const logiccRes3 = validateAndTranslateLogiccRequest(stringRequest as any, logiccOptions);
assert.strictEqual(logiccRes3.ok, true, "Logicc should accept plain string content");
if (logiccRes3.ok && "body" in logiccRes3) {
  const body = logiccRes3.body as any;
  assert.strictEqual(body.messages[0].role, "user");
  assert.strictEqual(body.messages[0].content, "Plain string user message");
}
console.log("[PASS] Logicc accepted plain string content format.");

const anthropicRes3 = validateAndTranslateAnthropicRequest(stringRequest as any, { model: "claude-3-5-sonnet-20241022" });
assert.strictEqual(anthropicRes3.ok, true, "Anthropic should accept plain string content");
console.log("[PASS] Anthropic accepted plain string content format.");

console.log("\n==========================================================================");
console.log("       ALL MESSAGE NORMALIZATION REGRESSION TESTS PASSED (100%)           ");
console.log("==========================================================================");
