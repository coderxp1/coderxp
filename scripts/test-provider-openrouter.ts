/**
 * Unit tests for OpenRouterProvider and Provider-Independent Interfaces.
 * Mock HTTP fetch — no external network or API keys required.
 */
import assert from "node:assert/strict";
import {
  OpenRouterProvider,
  ExternalProvidersDisabledError,
  ModelNotPermittedError,
  ModelUnavailableError,
  ProviderRateLimitError,
} from "../lib/server/providers";

async function main() {
  console.log("=== RUNNING OPENROUTER PROVIDER UNIT TESTS ===");

  // -------------------------------------------------------------
  // 1. Gating: Fails closed when ALLOW_EXTERNAL_TEXT_PROVIDERS is false
  // -------------------------------------------------------------
  console.log("--- 1. Testing data policy gate (ALLOW_EXTERNAL_TEXT_PROVIDERS) ---");
  const gatedProvider = new OpenRouterProvider({
    apiKey: "sk-or-test-mock-key-12345",
    allowExternalProviders: false,
  });

  await assert.rejects(
    () =>
      gatedProvider.generateText({
        modelId: "qwen/qwen3.8-27b:free",
        messages: [{ role: "user", content: "hello" }],
      }),
    ExternalProvidersDisabledError,
    "Must throw ExternalProvidersDisabledError when gate is false",
  );

  const emptyModels = await gatedProvider.listModels();
  assert.equal(emptyModels.length, 0, "listModels must return empty array when gate is false");
  console.log("[PASS] Data policy gate strictly fails closed.");

  // -------------------------------------------------------------
  // 2. Secret Gating: Fails closed when OPENROUTER_API_KEY is missing
  // -------------------------------------------------------------
  console.log("--- 2. Testing missing API key fails closed ---");
  const unconfiguredProvider = new OpenRouterProvider({
    apiKey: "",
    allowExternalProviders: true,
  });

  await assert.rejects(
    () =>
      unconfiguredProvider.generateText({
        modelId: "qwen/qwen3.8-27b:free",
        messages: [{ role: "user", content: "hello" }],
      }),
    /OPENROUTER_API_KEY is not configured/,
    "Must throw configuration error when API key is missing",
  );
  console.log("[PASS] Missing API key strictly fails closed.");

  // -------------------------------------------------------------
  // 3. Allowlist Enforcement: Reject unreviewed models
  // -------------------------------------------------------------
  console.log("--- 3. Testing explicit allowlist enforcement ---");
  const provider = new OpenRouterProvider({
    apiKey: "sk-or-test-mock-key-12345",
    allowExternalProviders: true,
  });

  // Test paid/unlisted model
  await assert.rejects(
    () =>
      provider.generateText({
        modelId: "openai/gpt-4o",
        messages: [{ role: "user", content: "hello" }],
      }),
    ModelNotPermittedError,
    "Paid model must be rejected",
  );

  // Test random unreviewed model with :free suffix
  await assert.rejects(
    () =>
      provider.generateText({
        modelId: "random-vendor/unreviewed-model:free",
        messages: [{ role: "user", content: "hello" }],
      }),
    ModelNotPermittedError,
    "Unreviewed model with :free suffix must be rejected",
  );
  console.log("[PASS] Allowlist strictly enforced; unreviewed models rejected.");

  // -------------------------------------------------------------
  // 4. No Silent Fallback: Upstream 404 / 503 throws ModelUnavailableError
  // -------------------------------------------------------------
  console.log("--- 4. Testing no silent fallback on model unavailability ---");
  const unavailableProvider = new OpenRouterProvider({
    apiKey: "sk-or-test-mock-key-12345",
    allowExternalProviders: true,
    fetchFn: (async () => {
      return new Response("Model currently offline", {
        status: 503,
        statusText: "Service Unavailable",
      });
    }) as any,
  });

  await assert.rejects(
    () =>
      unavailableProvider.generateText({
        modelId: "qwen/qwen3.8-27b:free",
        messages: [{ role: "user", content: "write code" }],
      }),
    ModelUnavailableError,
    "503 must throw ModelUnavailableError without attempting paid fallback",
  );
  console.log("[PASS] Model unavailability fails closed without fallback.");

  // -------------------------------------------------------------
  // 5. Rate Limiting: Parses Retry-After header on HTTP 429
  // -------------------------------------------------------------
  console.log("--- 5. Testing rate limit handling (HTTP 429) ---");
  const rateLimitedProvider = new OpenRouterProvider({
    apiKey: "sk-or-test-mock-key-12345",
    allowExternalProviders: true,
    fetchFn: (async () => {
      return new Response("Too many requests", {
        status: 429,
        headers: { "Retry-After": "15" },
      });
    }) as any,
  });

  let caughtRateLimit: ProviderRateLimitError | null = null;
  try {
    await rateLimitedProvider.generateText({
      modelId: "qwen/qwen3.8-27b:free",
      messages: [{ role: "user", content: "hello" }],
    });
  } catch (err) {
    if (err instanceof ProviderRateLimitError) {
      caughtRateLimit = err;
    }
  }

  assert.ok(caughtRateLimit, "Must throw ProviderRateLimitError");
  assert.equal(caughtRateLimit.retryAfterSeconds, 15, "Must parse Retry-After header");
  console.log("[PASS] HTTP 429 parsed with Retry-After header.");

  // -------------------------------------------------------------
  // 6. Successful Non-Streaming Generation
  // -------------------------------------------------------------
  console.log("--- 6. Testing successful non-streaming text generation ---");
  let capturedHeaders: Headers | undefined;
  let capturedBody: string | undefined;

  const successProvider = new OpenRouterProvider({
    apiKey: "sk-or-test-mock-key-12345",
    allowExternalProviders: true,
    fetchFn: (async (_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      capturedBody = init?.body as string;
      const mockResponse = {
        id: "gen-123",
        choices: [{ message: { role: "assistant", content: "console.log('hello world');" } }],
      };
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any,
  });

  delete process.env.APP_PUBLIC_URL;
  const resultText = await successProvider.generateText({
    modelId: "qwen/qwen3.8-27b:free",
    messages: [{ role: "user", content: "Write a hello world program in JS" }],
  });

  assert.equal(resultText, "console.log('hello world');");
  assert.equal(capturedHeaders?.get("Authorization"), "Bearer sk-or-test-mock-key-12345");
  assert.equal(capturedHeaders?.get("HTTP-Referer"), null, "HTTP-Referer must be omitted when APP_PUBLIC_URL is not set");
  assert.equal(capturedHeaders?.get("X-Title"), "CoderXP");
  const parsedReq = JSON.parse(capturedBody || "{}");
  assert.equal(parsedReq.stream, false);

  // Also test with APP_PUBLIC_URL set
  process.env.APP_PUBLIC_URL = "https://preview.coderxp.example";
  await successProvider.generateText({
    modelId: "qwen/qwen3.8-27b:free",
    messages: [{ role: "user", content: "test referer" }],
  });
  assert.equal(capturedHeaders?.get("HTTP-Referer"), "https://preview.coderxp.example");
  delete process.env.APP_PUBLIC_URL;
  console.log("[PASS] Non-streaming text generation verified.");

  // -------------------------------------------------------------
  // 7. Successful Streaming Text Generation
  // -------------------------------------------------------------
  console.log("--- 7. Testing streaming text generation ---");
  const streamChunks = [
    'data: {"choices":[{"delta":{"content":"function"}}]}\n\n',
    ': heartbeat\n\n',
    'data: {"choices":[{"delta":{"content":" add(a, b)"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" { return a + b; }"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":15}}\n\n',
    "data: [DONE]\n\n",
  ];

  const streamProvider = new OpenRouterProvider({
    apiKey: "sk-or-test-mock-key-12345",
    allowExternalProviders: true,
    fetchFn: (async () => {
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of streamChunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as any,
  });

  const deltas: string[] = [];
  let finalUsage: any;
  let finalFinishReason: string | undefined;

  for await (const chunk of streamProvider.streamText({
    modelId: "qwen/qwen3.8-27b:free",
    messages: [{ role: "user", content: "write add function" }],
  })) {
    if (chunk.delta) deltas.push(chunk.delta);
    if (chunk.usage) finalUsage = chunk.usage;
    if (chunk.finishReason) finalFinishReason = chunk.finishReason;
  }

  assert.equal(deltas.join(""), "function add(a, b) { return a + b; }");
  assert.equal(finalFinishReason, "stop");
  assert.deepEqual(finalUsage, { promptTokens: 10, completionTokens: 15 });
  console.log("[PASS] Streaming text generation verified.");

  console.log("=== ALL OPENROUTER PROVIDER TESTS PASSED ===");
}

main().catch((err) => {
  console.error("TEST SUITE FAILED:", err);
  process.exit(1);
});
