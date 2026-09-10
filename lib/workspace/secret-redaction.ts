/**
 * Secret Redaction Utility for CoderXP M3 / Workspace v2.3.
 *
 * Implements Directive §9.2 & §10.4:
 * - Redacts GitHub tokens (ghp_, github_pat_), AI provider keys (Anthropic,
 *   OpenAI, OpenRouter, xAI/Grok, Hugging Face, Gemini), Bearer tokens,
 *   embedded URL credentials, and sensitive flags from all streamed process
 *   outputs, tool cards, terminal mirrors, and logs.
 */

export const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  // Basic Auth embedded in URLs: http(s)://user:pass@host -> http(s)://[REDACTED]@host
  {
    name: "URL Basic Auth",
    pattern: /(https?:\/\/)[^:\s]+:[^@\s]+@/gi,
    replacement: "$1[REDACTED]@",
  },
  // URL Query Parameters with sensitive names (e.g. ?key=..., ?token=..., ?apiKey=...)
  {
    name: "URL Sensitive Query Params",
    pattern: /([?&](?:token|password|passwd|secret|api_?key|access_?token|auth|cred|bearer|key)=)[^&\s]+/gi,
    replacement: "$1[REDACTED]",
  },
  // Authorization Headers and Bearer tokens
  {
    name: "Bearer Token",
    pattern: /(Bearer\s+)[A-Za-z0-9._~+/-]{10,}=*/gi,
    replacement: "$1[REDACTED_BEARER_TOKEN]",
  },
  // Shell flags and assignment parameters like --token=secret, token=secret, --api-key=123
  {
    name: "Flag/Option Secret Assignment",
    pattern: /((?:--)?(?:token|password|passwd|secret|api_?key|auth|credentials|key)=)[^\s'";]+/gi,
    replacement: "$1[REDACTED]",
  },
  // Google Gemini API Keys (AIza...)
  {
    name: "Google Gemini API Key",
    pattern: /\bAIza[0-9A-Za-z-_]{30,}\b/g,
    replacement: "[REDACTED_GEMINI_KEY]",
  },
  // GitHub Personal Access Tokens (Classic & Fine-grained)
  {
    name: "GitHub Classic PAT",
    pattern: /\bghp_[a-zA-Z0-9_]{30,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    name: "GitHub Fine-grained PAT",
    pattern: /\bgithub_pat_[a-zA-Z0-9_]{30,}\b/g,
    replacement: "[REDACTED_GITHUB_PAT]",
  },
  {
    name: "GitHub OAuth / App Token",
    pattern: /\b(?:gho|ghu|ghs|ghr)_[a-zA-Z0-9_]{30,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  // Anthropic API Keys
  {
    name: "Anthropic API Key",
    pattern: /\bsk-ant-api\d{2}-[a-zA-Z0-9_-]{20,}\b|\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g,
    replacement: "[REDACTED_ANTHROPIC_KEY]",
  },
  // OpenRouter Keys (sk-or-...)
  {
    name: "OpenRouter API Key",
    pattern: /\bsk-or-[a-zA-Z0-9_-]{20,}\b/g,
    replacement: "[REDACTED_OPENROUTER_KEY]",
  },
  // OpenAI & Live API Keys (sk-proj-..., sk-admin-..., sk_live_..., sk_test_..., sk-...)
  {
    name: "OpenAI / Live Key",
    pattern: /\b(?:sk_live|sk_test|sk-proj|sk-admin|sk-svcacct)-[A-Za-z0-9_-]{20,}\b|\bsk-[a-zA-Z0-9]{32,}\b/g,
    replacement: "[REDACTED_API_KEY]",
  },
  // xAI / Grok Keys (xai-...)
  {
    name: "xAI / Grok API Key",
    pattern: /\bxai-[a-zA-Z0-9_-]{20,}\b/g,
    replacement: "[REDACTED_XAI_KEY]",
  },
  // Hugging Face Tokens (hf_...)
  {
    name: "Hugging Face Token",
    pattern: /\bhf_[a-zA-Z0-9]{20,}\b/g,
    replacement: "[REDACTED_HF_TOKEN]",
  },
  // Slack Tokens
  {
    name: "Slack Token",
    pattern: /\bxox[baprs]-[0-9a-zA-Z]{10,48}\b/g,
    replacement: "[REDACTED_SLACK_TOKEN]",
  },
  // Env Secret Assignment
  {
    name: "Env Secret Assignment",
    pattern: /((?:GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|MISTRAL_API_KEY|OPENROUTER_API_KEY|XAI_API_KEY|HF_TOKEN|AZURE_OPENAI_API_KEY|API_KEY|SECRET_KEY|PASSWORD)\s*=\s*)[^\s"';]+/gi,
    replacement: "$1[REDACTED_SECRET]",
  },
];

/**
 * Strips all sensitive credentials, API keys, and authorization headers from a string.
 */
export function redactSecrets(input: string): string {
  if (!input || typeof input !== "string") return "";

  let result = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  return result;
}
