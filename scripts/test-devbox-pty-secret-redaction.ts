import assert from "node:assert/strict";
import { devboxBroker } from "../lib/server/devbox-broker";

async function main() {
  console.log("=== RUNNING DEVBOX PTY STREAM SECRET REDACTION TESTS ===");

  const projectId = "test-project-pty-redact-1";
  const userId = "test-user-pty-1";

  await devboxBroker.getOrCreateDevbox(projectId, userId, "pro");

  // 1. Echo GitHub PAT in PTY
  console.log("--- 1. Echoing GitHub Fine-grained PAT in Devbox PTY ---");
  const secretPat = "github_pat_11AABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";
  const patRes = await devboxBroker.executeCommand(projectId, "echo", [`PAT=${secretPat}`]);
  assert.equal(patRes.ok, true);
  assert.equal(patRes.output.includes(secretPat), false, "Raw GitHub PAT is NOT present in terminal output");
  assert.ok(patRes.output.includes("[REDACTED"), "Redaction placeholder present in PTY stream");
  console.log("[PASS] Echoed GitHub PAT redacted on PTY stream before reaching WebSocket.");

  // 2. Echo Anthropic API Key in PTY
  console.log("--- 2. Echoing Anthropic API Key in Devbox PTY ---");
  const secretAnt = "sk-ant-api03-abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
  const antRes = await devboxBroker.executeCommand(projectId, "echo", [`KEY=${secretAnt}`]);
  assert.equal(antRes.ok, true);
  assert.equal(antRes.output.includes(secretAnt), false, "Raw Anthropic key is NOT present in terminal output");
  assert.ok(antRes.output.includes("[REDACTED"), "Anthropic key redaction placeholder present");
  console.log("[PASS] Echoed Anthropic API key redacted on PTY stream.");

  console.log("=== ALL PTY STREAM SECRET REDACTION TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
