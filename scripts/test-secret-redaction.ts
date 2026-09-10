import assert from "node:assert/strict";
import { redactSecrets } from "../lib/workspace/secret-redaction";
import { StreamingRedactor } from "../lib/workspace/agent-process-stream";

console.log("=== RUNNING SECRET REDACTION TESTS (V2.3 EXPANDED) ===");

// 1. GitHub Classic & Fine-grained PAT Redaction
console.log("--- 1. GitHub Token Redaction ---");
const ghpToken = "ghp_1234567890abcdef1234567890abcdef1234";
const ghpOutput = `git clone https://${ghpToken}@github.com/org/repo.git`;
const redactedGhp = redactSecrets(ghpOutput);
assert.equal(redactedGhp.includes(ghpToken), false, "ghp token is redacted");
assert.equal(redactedGhp.includes("[REDACTED"), true, "redaction marker present");

const patToken = "github_pat_11AABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";
const patOutput = `Authorization: Bearer ${patToken}`;
const redactedPat = redactSecrets(patOutput);
assert.equal(redactedPat.includes(patToken), false, "github_pat token is redacted");
console.log("[PASS] GitHub Classic & Fine-grained PATs redacted.");

// 2. AI Provider Key Redaction
console.log("--- 2. AI Provider Key Redaction ---");
const anthropicKey = "sk-ant-api03-abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const antOutput = `export ANTHROPIC_API_KEY=${anthropicKey}`;
const redactedAnt = redactSecrets(antOutput);
assert.equal(redactedAnt.includes(anthropicKey), false, "Anthropic API key is redacted");

const openAiKey = "sk-1234567890abcdef1234567890abcdef1234567890";
const openAiOutput = `const key = "${openAiKey}";`;
const redactedOpenAi = redactSecrets(openAiOutput);
assert.equal(redactedOpenAi.includes(openAiKey), false, "OpenAI API key is redacted");

// OpenRouter key
const openRouterKey = "sk-or-v1-abcdef1234567890abcdef1234567890abcdef";
const orOutput = `OPENROUTER_API_KEY=${openRouterKey}`;
const redactedOr = redactSecrets(orOutput);
assert.equal(redactedOr.includes(openRouterKey), false, "OpenRouter API key is redacted");

// xAI / Grok key
const xaiKey = "xai-1234567890abcdef1234567890abcdef1234";
const xaiOutput = `Authorization: Bearer ${xaiKey}`;
const redactedXai = redactSecrets(xaiOutput);
assert.equal(redactedXai.includes(xaiKey), false, "xAI API key is redacted");

// Hugging Face token
const hfToken = "hf_abcdefghijklmnopqrstuvwxyz01234567";
const hfOutput = `HUGGING_FACE_HUB_TOKEN=${hfToken}`;
const redactedHf = redactSecrets(hfOutput);
assert.equal(redactedHf.includes(hfToken), false, "Hugging Face token is redacted");

// Google Gemini API key
const geminiKey = "AIzaSyD-1234567890abcdefghijklmnopqrstuv";
const geminiOutput = `curl https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`;
const redactedGemini = redactSecrets(geminiOutput);
assert.equal(redactedGemini.includes(geminiKey), false, "Gemini API key is redacted");

console.log("[PASS] All AI provider API keys (Anthropic, OpenAI, OpenRouter, xAI, Hugging Face, Gemini) redacted.");

// 3. Streaming Redactor Cross-Chunk Withholding
console.log("--- 3. Streaming Redactor Cross-Chunk Withholding ---");
const redactor = new StreamingRedactor();
const chunk1 = "Connecting to upstream with Bearer ";
const chunk2 = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.do_not_leak_me";

const out1 = redactor.processChunk(chunk1);
assert.equal(out1.includes("eyJ"), false, "Payload not emitted prematurely");

const out2 = redactor.processChunk(chunk2);
const finalOut = out2 + redactor.flush();
assert.equal(finalOut.includes("do_not_leak_me"), false, "Bearer token redacted across chunks");
assert.equal(finalOut.includes("[REDACTED"), true, "Contains redaction indicator");
console.log("[PASS] Streaming redactor withholds and redacts secrets split across chunk boundaries.");

console.log("=== ALL SECRET REDACTION TESTS PASSED ===");
