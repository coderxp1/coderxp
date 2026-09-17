/**
 * CoderXP Provider Layer - Core Typed Interfaces
 * Defines decoupled, provider-independent contracts for text/coding and media generation.
 */

export type TaskDomain = "text" | "image" | "video";

export interface ModelDescriptor {
  readonly id: string;
  readonly domain: TaskDomain;
  readonly name: string;
  readonly contextWindowTokens?: number;
  readonly isLocal: boolean;
  readonly isFree: boolean;
  readonly verifiedAt?: string;
}

export interface TextGenerationMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface TextGenerationRequest {
  readonly modelId: string;
  readonly messages: TextGenerationMessage[];
  readonly temperature?: number; // [0.0, 2.0], default 0.7
  readonly maxTokens?: number;
  readonly stream?: boolean;
}

export interface TextStreamChunk {
  readonly delta: string;
  readonly finishReason?: "stop" | "length" | "error" | null;
  readonly usage?: { promptTokens: number; completionTokens: number };
}

export interface MediaGenerationRequest {
  readonly modelId: string;
  readonly prompt: string; // max 1000 chars
  readonly negativePrompt?: string; // max 1000 chars
  readonly width: number; // max 1024, divisible by 8
  readonly height: number; // max 1024, divisible by 8
  readonly seed?: number; // unsigned 32-bit integer [0, 4294967295]
  readonly steps?: number; // image: [1, 30] (default 4 for distilled flux1-schnell); video: [1, 50] (default 30)
  readonly durationFrames?: number; // range [1, 81] (max ~5s @ 16 fps)
  readonly fps?: number; // default 16
}

export type JobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT";

export interface JobRecord {
  readonly jobId: string;
  readonly userId: string;
  readonly domain: "image" | "video";
  readonly modelId: string;
  readonly status: JobStatus;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly outputFile?: string;
  readonly error?: string;
}

export interface ITextModelProvider {
  listModels(): Promise<ModelDescriptor[]>;
  generateText(req: TextGenerationRequest, signal?: AbortSignal): Promise<string>;
  streamText(req: TextGenerationRequest, signal?: AbortSignal): AsyncIterable<TextStreamChunk>;
}

export interface IMediaJobService {
  submitJob(userId: string, req: MediaGenerationRequest): Promise<{ jobId: string; status: JobStatus }>;
  getJobStatus(userId: string, jobId: string): Promise<JobRecord>;
  cancelJob(userId: string, jobId: string): Promise<boolean>;
  getJobArtifact(userId: string, jobId: string): Promise<{ stream: NodeJS.ReadableStream; mimeType: string }>;
}

// -------------------------------------------------------------
// Provider Error Taxonomy (Fail-Closed)
// -------------------------------------------------------------

export class ExternalProvidersDisabledError extends Error {
  readonly code = "EXTERNAL_PROVIDERS_DISABLED";
  constructor(
    message = "External text providers are disabled by policy (ALLOW_EXTERNAL_TEXT_PROVIDERS is false).",
  ) {
    super(message);
    this.name = "ExternalProvidersDisabledError";
  }
}

export class ModelNotPermittedError extends Error {
  readonly code = "MODEL_NOT_PERMITTED";
  constructor(modelId: string) {
    super(
      `Model '${modelId}' is not in the reviewed free-model allowlist. Silent fallback to paid or unreviewed models is prohibited.`,
    );
    this.name = "ModelNotPermittedError";
  }
}

export class ModelUnavailableError extends Error {
  readonly code = "MODEL_UNAVAILABLE";
  constructor(modelId: string, details?: string) {
    super(
      `Allowlisted model '${modelId}' is currently unavailable upstream. ${details || "No paid fallback authorized."}`,
    );
    this.name = "ModelUnavailableError";
  }
}

export class ProviderRateLimitError extends Error {
  readonly code = "PROVIDER_RATE_LIMITED";
  readonly retryAfterSeconds?: number;
  constructor(retryAfterSeconds?: number) {
    super(
      `Upstream provider rate limit exceeded.${retryAfterSeconds ? ` Retry after ${retryAfterSeconds}s.` : ""}`,
    );
    this.name = "ProviderRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
