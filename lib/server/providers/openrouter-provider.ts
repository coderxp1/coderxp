/**
 * OpenRouter Hosted API Adapter
 *
 * Implements ITextModelProvider with:
 * - Server-side key storage (never exposed to client).
 * - Mandatory data policy gate (ALLOW_EXTERNAL_TEXT_PROVIDERS).
 * - Strict allowlist enforcement (no unreviewed models).
 * - No silent paid fallback.
 * - Proper rate-limit (429) backoff/error handling.
 * - Testable with dependency injection for fetch / baseUrl.
 */
import {
  ITextModelProvider,
  ModelDescriptor,
  TextGenerationRequest,
  TextStreamChunk,
  ExternalProvidersDisabledError,
  ModelNotPermittedError,
  ModelUnavailableError,
  ProviderRateLimitError,
} from "./types";
import {
  getAllowlistDescriptors,
  isModelInAllowlist,
} from "./openrouter-allowlist";

export interface OpenRouterOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly allowExternalProviders?: boolean;
  readonly fetchFn?: typeof fetch;
}

export class OpenRouterProvider implements ITextModelProvider {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly customApiKey?: string;
  private readonly customAllowExternal?: boolean;

  constructor(options: OpenRouterOptions = {}) {
    this.baseUrl = options.baseUrl || "https://openrouter.ai/api/v1";
    this.fetchFn = options.fetchFn || fetch;
    this.customApiKey = options.apiKey;
    this.customAllowExternal = options.allowExternalProviders;
  }

  private isExternalAllowed(): boolean {
    if (this.customAllowExternal !== undefined) {
      return this.customAllowExternal;
    }
    return process.env.ALLOW_EXTERNAL_TEXT_PROVIDERS === "true";
  }

  private getApiKey(): string {
    const key = (this.customApiKey || process.env.OPENROUTER_API_KEY || "").trim();
    if (!key) {
      throw new Error(
        "OPENROUTER_API_KEY is not configured on the server. External text generation is unavailable.",
      );
    }
    return key;
  }

  private validateRequest(req: TextGenerationRequest): void {
    if (!this.isExternalAllowed()) {
      throw new ExternalProvidersDisabledError();
    }
    if (!isModelInAllowlist(req.modelId)) {
      throw new ModelNotPermittedError(req.modelId);
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (!this.isExternalAllowed()) {
      return [];
    }
    return getAllowlistDescriptors();
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Title": "CoderXP",
    };
    const referer = process.env.APP_PUBLIC_URL?.trim();
    if (referer) {
      headers["HTTP-Referer"] = referer;
    }
    return headers;
  }

  async generateText(req: TextGenerationRequest, signal?: AbortSignal): Promise<string> {
    this.validateRequest(req);
    const apiKey = this.getApiKey();

    const payload = {
      model: req.modelId,
      messages: req.messages,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens,
      stream: false,
    };

    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(apiKey),
      body: JSON.stringify(payload),
      signal,
    });

    if (res.status === 429) {
      const retryHeader = res.headers.get("Retry-After");
      const retrySeconds = retryHeader ? parseInt(retryHeader, 10) : undefined;
      throw new ProviderRateLimitError(
        Number.isFinite(retrySeconds) ? retrySeconds : undefined,
      );
    }

    if (res.status === 404 || res.status === 503) {
      const body = await res.text().catch(() => "");
      throw new ModelUnavailableError(req.modelId, `Upstream status ${res.status}: ${body}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter request failed with status ${res.status}: ${body}`);
    }

    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("Invalid response schema from OpenRouter: missing message content.");
    }

    return content;
  }

  async *streamText(
    req: TextGenerationRequest,
    signal?: AbortSignal,
  ): AsyncIterable<TextStreamChunk> {
    this.validateRequest(req);
    const apiKey = this.getApiKey();

    const payload = {
      model: req.modelId,
      messages: req.messages,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens,
      stream: true,
    };

    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(apiKey),
      body: JSON.stringify(payload),
      signal,
    });

    if (res.status === 429) {
      const retryHeader = res.headers.get("Retry-After");
      const retrySeconds = retryHeader ? parseInt(retryHeader, 10) : undefined;
      throw new ProviderRateLimitError(
        Number.isFinite(retrySeconds) ? retrySeconds : undefined,
      );
    }

    if (res.status === 404 || res.status === 503) {
      const body = await res.text().catch(() => "");
      throw new ModelUnavailableError(req.modelId, `Upstream status ${res.status}: ${body}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter stream request failed with status ${res.status}: ${body}`);
    }

    if (!res.body) {
      throw new Error("OpenRouter stream response has no readable body.");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue; // heartbeat or comment
          if (trimmed === "data: [DONE]") return;

          if (trimmed.startsWith("data: ")) {
            const rawJson = trimmed.slice(6);
            try {
              const parsed = JSON.parse(rawJson);
              const choice = parsed.choices?.[0];
              const delta = choice?.delta?.content || "";
              const finishReason = choice?.finish_reason || null;
              const usage = parsed.usage
                ? {
                    promptTokens: parsed.usage.prompt_tokens,
                    completionTokens: parsed.usage.completion_tokens,
                  }
                : undefined;

              if (delta || finishReason || usage) {
                yield { delta, finishReason, usage };
              }
            } catch {
              // Ignore malformed individual chunk lines
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
