/**
 * ComfyUI Media Provider - Concrete implementation of IMediaJobService
 * Drives native image and video generation through local ComfyUI v0.36.0.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  IMediaJobService,
  MediaGenerationRequest,
  JobRecord,
  JobStatus,
} from "./types";

// ---------------------------------------------------------------------------
// Error Taxonomy (Fail-Closed)
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  readonly code = "VALIDATION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class UserJobLimitError extends Error {
  readonly code = "USER_JOB_LIMIT_EXCEEDED";
  constructor(message = "User already has an active or queued job") {
    super(message);
    this.name = "UserJobLimitError";
  }
}

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor(message = "Job not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class JobNotCompleteError extends Error {
  readonly code = "JOB_NOT_COMPLETE";
  constructor(message = "Job has not completed successfully") {
    super(message);
    this.name = "JobNotCompleteError";
  }
}

export class ArtifactExpiredError extends Error {
  readonly code = "ARTIFACT_EXPIRED";
  constructor(message = "Artifact is no longer available") {
    super(message);
    this.name = "ArtifactExpiredError";
  }
}

export class ComfyUnavailableError extends Error {
  readonly code = "COMFY_UNAVAILABLE";
  constructor(message = "ComfyUI service is unavailable") {
    super(message);
    this.name = "ComfyUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Internal Data Structures
// ---------------------------------------------------------------------------

export interface InternalJobRecord {
  jobId: string;
  userId: string;
  domain: "image" | "video";
  modelId: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  outputFile?: string;
  error?: string;
  comfyPromptId?: string;
  comfyClientId: string;
  subfolder?: string;
  timeoutAt: number;
  artifactEvicted?: boolean;
  cancelExecution?: () => void;
}

interface QueueEntry {
  jobId: string;
  comfyClientId: string;
  graph: Record<string, unknown>;
  timeoutAt: number;
  userId: string;
}

export interface ComfyUiServiceOptions {
  comfyUrl?: string;
  dataDir?: string;
  fetchFn?: typeof fetch;
  WebSocketFn?: typeof WebSocket;
  imageTimeoutS?: number;
  videoTimeoutS?: number;
  artifactTtlHours?: number;
  artifactMaxBytes?: number;
  maxJobRecords?: number;
  sweepIntervalMinutes?: number;
  workflowsDir?: string;
}

export class ComfyUiMediaJobService implements IMediaJobService {
  readonly comfyUrl: string;
  readonly dataDir: string;
  readonly artifactsDir: string;
  readonly jobsFilePath: string;
  private readonly workflowsDir: string;
  private readonly fetchFn: typeof fetch;
  private readonly WebSocketFn: typeof WebSocket;

  readonly imageTimeoutMs: number;
  readonly videoTimeoutMs: number;
  readonly artifactTtlMs: number;
  readonly artifactMaxBytes: number;
  readonly maxJobRecords: number;

  private readonly jobs = new Map<string, InternalJobRecord>();
  private readonly queue: QueueEntry[] = [];
  private isProcessing = false;
  private sweepTimer?: NodeJS.Timeout;

  private fluxTemplate!: Record<string, unknown>;
  private wanTemplate!: Record<string, unknown>;

  constructor(options: ComfyUiServiceOptions = {}) {
    const rawDataDir = options.dataDir ?? process.env.COMFY_DATA_DIR;
    if (!rawDataDir || rawDataDir.trim().length === 0) {
      throw new Error("COMFY_DATA_DIR is required and cannot be empty");
    }
    const resolvedDataDir = path.resolve(rawDataDir);
    const normalized = resolvedDataDir.replace(/\\/g, "/").toLowerCase();
    if (normalized === "/tmp" || normalized.startsWith("/tmp/")) {
      throw new Error("COMFY_DATA_DIR must not be located in /tmp");
    }

    this.dataDir = resolvedDataDir;
    this.artifactsDir = path.join(this.dataDir, "artifacts");
    this.jobsFilePath = path.join(this.dataDir, "jobs.jsonl");

    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.artifactsDir, { recursive: true });

    const rawComfyUrl = options.comfyUrl ?? process.env.COMFYUI_URL;
    if (!rawComfyUrl || rawComfyUrl.trim().length === 0) {
      throw new Error("COMFYUI_URL is required and cannot be empty");
    }
    this.comfyUrl = rawComfyUrl.trim().replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.WebSocketFn = options.WebSocketFn ?? globalThis.WebSocket;

    this.imageTimeoutMs = (options.imageTimeoutS ?? (process.env.COMFY_IMAGE_TIMEOUT_S ? parseInt(process.env.COMFY_IMAGE_TIMEOUT_S, 10) : 120)) * 1000;
    this.videoTimeoutMs = (options.videoTimeoutS ?? (process.env.COMFY_VIDEO_TIMEOUT_S ? parseInt(process.env.COMFY_VIDEO_TIMEOUT_S, 10) : 600)) * 1000;
    this.artifactTtlMs = (options.artifactTtlHours ?? (process.env.COMFY_ARTIFACT_TTL_HOURS ? parseInt(process.env.COMFY_ARTIFACT_TTL_HOURS, 10) : 24)) * 3600 * 1000;
    this.artifactMaxBytes = options.artifactMaxBytes ?? (process.env.COMFY_ARTIFACT_MAX_BYTES ? parseInt(process.env.COMFY_ARTIFACT_MAX_BYTES, 10) : 21474836480);
    this.maxJobRecords = options.maxJobRecords ?? (process.env.COMFY_MAX_JOB_RECORDS ? parseInt(process.env.COMFY_MAX_JOB_RECORDS, 10) : 1000);

    this.workflowsDir = options.workflowsDir ?? path.join(__dirname, "workflows");
    this.loadTemplates();
    this.replayJobStore();
  }

  private loadTemplates(): void {
    const fluxPath = path.join(this.workflowsDir, "flux1-schnell.json");
    const wanPath = path.join(this.workflowsDir, "wan21-t2v.json");

    if (!fs.existsSync(fluxPath)) {
      throw new Error(`Workflow template not found at ${fluxPath}`);
    }
    this.fluxTemplate = JSON.parse(fs.readFileSync(fluxPath, "utf-8"));

    if (!fs.existsSync(wanPath)) {
      throw new Error(`Workflow template not found at ${wanPath}`);
    }
    this.wanTemplate = JSON.parse(fs.readFileSync(wanPath, "utf-8"));
  }

  private replayJobStore(): void {
    if (!fs.existsSync(this.jobsFilePath)) {
      return;
    }

    const content = fs.readFileSync(this.jobsFilePath, "utf-8");
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (!ev.jobId) continue;
        const current = this.jobs.get(ev.jobId) || ({} as InternalJobRecord);
        Object.assign(current, ev);
        if (ev.artifactEvicted) {
          current.artifactEvicted = true;
          current.outputFile = undefined;
          current.subfolder = undefined;
        }
        this.jobs.set(ev.jobId, current);
      } catch {
        // Discard partially written trailing line from crash
      }
    }

    // Startup recovery: cancel orphaned RUNNING prompts and mark FAILED
    for (const rec of this.jobs.values()) {
      if (rec.status === "RUNNING") {
        if (rec.comfyPromptId) {
          try {
            this.fetchFn(`${this.comfyUrl}/queue`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ delete: [rec.comfyPromptId] }),
            }).catch(() => {});
          } catch {
            // best-effort
          }
        }
        rec.status = "FAILED";
        rec.error = "Service restarted while job was running";
      }
    }

    // Compact on startup
    this.compactJobStore();
  }

  public compactJobStore(): void {
    const tmpPath = `${this.jobsFilePath}.tmp`;
    const lines: string[] = [];
    for (const rec of this.jobs.values()) {
      const copy = { ...rec };
      if (copy.artifactEvicted) {
        copy.outputFile = undefined;
        copy.subfolder = undefined;
      }
      lines.push(JSON.stringify(copy));
    }
    const data = lines.length > 0 ? lines.join("\n") + "\n" : "";
    const fd = fs.openSync(tmpPath, "w");
    fs.writeFileSync(fd, data, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmpPath, this.jobsFilePath);
  }

  private appendEvent(event: Partial<InternalJobRecord> & { jobId: string }): void {
    const rec = this.jobs.get(event.jobId);
    if (rec) {
      Object.assign(rec, event);
    }
    const payload = JSON.stringify({ ts: Date.now(), ...event }) + "\n";
    try {
      fs.appendFileSync(this.jobsFilePath, payload, "utf-8");
    } catch {
      // file append failure
    }
  }

  async submitJob(userId: string, req: MediaGenerationRequest): Promise<{ jobId: string; status: JobStatus }> {
    // 1. Model Domain
    let domain: "image" | "video";
    if (req.modelId === "flux1-schnell" || req.modelId === "flux1-schnell-fp8") {
      domain = "image";
    } else if (req.modelId === "wan2.1-t2v-1.3b" || req.modelId === "wan21-t2v") {
      domain = "video";
    } else {
      throw new ValidationError(`Unknown or unsupported modelId: ${req.modelId}`);
    }

    // 2. Prompt validation
    if (!req.prompt || typeof req.prompt !== "string" || req.prompt.trim().length === 0 || req.prompt.length > 1000) {
      throw new ValidationError("Prompt is required and must be between 1 and 1000 characters");
    }

    // 3. Negative Prompt validation
    if (domain === "image") {
      if (req.negativePrompt !== undefined && req.negativePrompt !== null && req.negativePrompt.trim().length > 0) {
        throw new ValidationError("Flux1-schnell image model does not accept negative prompts");
      }
    } else {
      if (req.negativePrompt && req.negativePrompt.length > 1000) {
        throw new ValidationError("Negative prompt must be at most 1000 characters");
      }
    }

    // 4. Dimensions validation
    if (typeof req.width !== "number" || typeof req.height !== "number" || !Number.isInteger(req.width) || !Number.isInteger(req.height)) {
      throw new ValidationError("Width and height must be integers");
    }

    if (domain === "image") {
      if (req.width < 64 || req.width > 1024 || req.width % 8 !== 0) {
        throw new ValidationError("Image width must be an integer between 64 and 1024, divisible by 8");
      }
      if (req.height < 64 || req.height > 1024 || req.height % 8 !== 0) {
        throw new ValidationError("Image height must be an integer between 64 and 1024, divisible by 8");
      }
    } else {
      if (req.width !== 832 || req.height !== 480) {
        throw new ValidationError("Wan 2.1 1.3B video model requires width=832 and height=480");
      }
    }

    // 5. Seed validation
    let seed = req.seed;
    if (seed !== undefined) {
      if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
        throw new ValidationError("Seed must be an unsigned 32-bit integer [0, 4294967295]");
      }
    } else {
      seed = Math.floor(Math.random() * 4294967295);
    }

    // 6. Steps validation
    let steps: number;
    if (domain === "image") {
      steps = req.steps ?? 4;
      if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1 || steps > 30) {
        throw new ValidationError("Image steps must be an integer between 1 and 30");
      }
    } else {
      steps = req.steps ?? 30;
      if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1 || steps > 50) {
        throw new ValidationError("Video steps must be an integer between 1 and 50");
      }
    }

    // 7. DurationFrames & FPS validation
    let durationFrames: number | undefined;
    let fps: number | undefined;

    if (domain === "video") {
      durationFrames = req.durationFrames ?? 49;
      if (
        typeof durationFrames !== "number" ||
        !Number.isInteger(durationFrames) ||
        durationFrames < 1 ||
        durationFrames > 81 ||
        (durationFrames - 1) % 4 !== 0
      ) {
        throw new ValidationError("Video durationFrames must be an integer between 1 and 81 of the form 4n+1");
      }

      fps = req.fps ?? 16;
      if (typeof fps !== "number" || !Number.isInteger(fps) || fps < 1 || fps > 30) {
        throw new ValidationError("Video fps must be an integer between 1 and 30");
      }
    } else {
      if (req.durationFrames !== undefined) {
        throw new ValidationError("durationFrames is not supported for image domain");
      }
      if (req.fps !== undefined) {
        throw new ValidationError("fps is not supported for image domain");
      }
    }

    // 8. Per-user concurrency limit
    for (const rec of this.jobs.values()) {
      if (rec.userId === userId && (rec.status === "QUEUED" || rec.status === "RUNNING")) {
        throw new UserJobLimitError("User already has an active or queued job");
      }
    }

    // 9. Compile Template
    const graph = this.compileWorkflow(domain, {
      prompt: req.prompt,
      negativePrompt: req.negativePrompt ?? "",
      width: req.width,
      height: req.height,
      seed,
      steps,
      durationFrames: durationFrames ?? 49,
      fps: fps ?? 16,
    });

    const jobId = crypto.randomUUID();
    const comfyClientId = crypto.randomUUID();
    const createdAt = Date.now();
    const timeoutAt = createdAt + (domain === "image" ? this.imageTimeoutMs : this.videoTimeoutMs);

    const record: InternalJobRecord = {
      jobId,
      userId,
      domain,
      modelId: req.modelId,
      status: "QUEUED",
      createdAt,
      comfyClientId,
      timeoutAt,
    };

    this.jobs.set(jobId, record);
    this.appendEvent(record);

    this.queue.push({
      jobId,
      comfyClientId,
      graph,
      timeoutAt,
      userId,
    });

    setImmediate(() => {
      this.processQueue().catch(() => {});
    });

    return { jobId, status: "QUEUED" };
  }

  compileWorkflow(
    domain: "image" | "video",
    params: {
      prompt: string;
      negativePrompt?: string;
      width: number;
      height: number;
      seed: number;
      steps: number;
      durationFrames: number;
      fps: number;
    },
  ): Record<string, unknown> {
    const rawTemplate = domain === "image" ? this.fluxTemplate : this.wanTemplate;
    const cloned = JSON.parse(JSON.stringify(rawTemplate));

    if (domain === "image") {
      if (cloned["2"]?.inputs) cloned["2"].inputs.text = params.prompt;
      if (cloned["3"]?.inputs) cloned["3"].inputs.text = "";
      if (cloned["4"]?.inputs) {
        cloned["4"].inputs.width = params.width;
        cloned["4"].inputs.height = params.height;
      }
      if (cloned["5"]?.inputs) {
        cloned["5"].inputs.seed = params.seed;
        cloned["5"].inputs.steps = params.steps;
      }
    } else {
      if (cloned["5"]?.inputs) cloned["5"].inputs.text = params.prompt;
      if (cloned["6"]?.inputs) cloned["6"].inputs.text = params.negativePrompt ?? "";
      if (cloned["7"]?.inputs) {
        cloned["7"].inputs.width = params.width;
        cloned["7"].inputs.height = params.height;
        cloned["7"].inputs.length = params.durationFrames;
      }
      if (cloned["8"]?.inputs) {
        cloned["8"].inputs.seed = params.seed;
        cloned["8"].inputs.steps = params.steps;
      }
      if (cloned["10"]?.inputs) {
        cloned["10"].inputs.fps = params.fps;
      }
    }

    return cloned;
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        const entry = this.queue[0];
        const record = this.jobs.get(entry.jobId);

        if (!record || record.status === "CANCELLED") {
          this.queue.shift();
          continue;
        }

        const startedAt = Date.now();
        record.status = "RUNNING";
        record.startedAt = startedAt;
        this.appendEvent({ jobId: record.jobId, status: "RUNNING", startedAt });

        try {
          await this.executeJob(entry, record);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (record.status === "RUNNING") {
            record.status = "FAILED";
            record.error = message;
            this.appendEvent({ jobId: record.jobId, status: "FAILED", error: message });
          }
        } finally {
          this.queue.shift();
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async executeJob(entry: QueueEntry, record: InternalJobRecord): Promise<void> {
    // 1. Submit to ComfyUI
    let promptRes: Response;
    try {
      promptRes = await this.fetchFn(`${this.comfyUrl}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: entry.graph,
          client_id: entry.comfyClientId,
          extra_data: {},
          front: false,
        }),
      });
    } catch (err) {
      throw new ComfyUnavailableError(`Failed to connect to ComfyUI at ${this.comfyUrl}: ${(err as Error).message}`);
    }

    if (!promptRes.ok) {
      let errDetails = `HTTP ${promptRes.status}`;
      try {
        const errJson = await promptRes.json();
        if (errJson.node_errors && Object.keys(errJson.node_errors).length > 0) {
          errDetails = `node_errors: ${JSON.stringify(errJson.node_errors)}`;
        } else if (errJson.error) {
          errDetails = JSON.stringify(errJson.error);
        }
      } catch {
        // ignore parse error
      }
      throw new Error(`ComfyUI prompt submission failed: ${errDetails}`);
    }

    const promptData = await promptRes.json();
    const promptId = promptData.prompt_id as string;
    record.comfyPromptId = promptId;
    this.appendEvent({ jobId: record.jobId, comfyPromptId: promptId });

    // 2. Await execution via WebSocket or polling
    await this.watchExecution(promptId, entry.comfyClientId, record);
  }

  private async watchExecution(promptId: string, clientId: string, record: InternalJobRecord): Promise<void> {
    const wsUrl = this.comfyUrl.replace(/^http/, "ws") + `/ws?clientId=${clientId}`;

    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket | undefined;
      let pollInterval: NodeJS.Timeout | undefined;
      let timer: NodeJS.Timeout | undefined;
      let isDone = false;

      const cleanup = () => {
        isDone = true;
        delete record.cancelExecution;
        if (timer) clearTimeout(timer);
        if (pollInterval) clearInterval(pollInterval);
        if (ws) {
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
      };

      record.cancelExecution = () => {
        cleanup();
        resolve();
      };

      const remainingMs = Math.max(0, record.timeoutAt - Date.now());
      timer = setTimeout(async () => {
        if (isDone) return;
        if (record.status === "CANCELLED") {
          cleanup();
          resolve();
          return;
        }
        cleanup();
        record.status = "TIMED_OUT";
        this.appendEvent({ jobId: record.jobId, status: "TIMED_OUT" });
        try {
          await this.fetchFn(`${this.comfyUrl}/queue`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ delete: [promptId] }),
          });
        } catch {
          // ignore
        }
        reject(new Error(`Job timed out after ${record.domain === "image" ? this.imageTimeoutMs : this.videoTimeoutMs}ms`));
      }, remainingMs);

      const checkHistory = async (): Promise<boolean> => {
        try {
          const res = await this.fetchFn(`${this.comfyUrl}/history/${promptId}`);
          if (!res.ok) return false;
          const hist = await res.json();
          const promptHist = hist[promptId];
          if (promptHist) {
            if (promptHist.status && promptHist.status.status_str === "error") {
              const messages = promptHist.status.messages || [];
              const isInterrupted = messages.some((m: any) => Array.isArray(m) && m[0] === "execution_interrupted") || record.status === "CANCELLED";
              if (isInterrupted) {
                cleanup();
                record.status = "CANCELLED";
                this.appendEvent({ jobId: record.jobId, status: "CANCELLED" });
                resolve();
                return true;
              } else {
                cleanup();
                const errMsg = messages[0]?.[1]?.exception_message || "ComfyUI execution error";
                record.status = "FAILED";
                record.error = errMsg;
                this.appendEvent({ jobId: record.jobId, status: "FAILED", error: errMsg });
                reject(new Error(errMsg));
                return true;
              }
            }

            if (promptHist.outputs) {
            const outputs = promptHist.outputs;
            let foundFilename: string | undefined;
            let foundSubfolder: string | undefined;

            for (const nodeKey of Object.keys(outputs)) {
              const nodeOut = outputs[nodeKey];
              if (!nodeOut || typeof nodeOut !== "object") continue;
              for (const arrKey of Object.keys(nodeOut)) {
                const arr = nodeOut[arrKey];
                if (Array.isArray(arr)) {
                  for (const item of arr) {
                    if (item && item.type === "output" && item.filename) {
                      foundFilename = item.filename;
                      foundSubfolder = item.subfolder || "";
                      break;
                    }
                  }
                }
                if (foundFilename) break;
              }
              if (foundFilename) break;
            }

            if (foundFilename) {
              if (record.status === "CANCELLED") return true;
              cleanup();
              record.status = "COMPLETED";
              record.completedAt = Date.now();
              record.outputFile = foundFilename;
              record.subfolder = foundSubfolder;
              this.appendEvent({
                jobId: record.jobId,
                status: "COMPLETED",
                completedAt: record.completedAt,
                outputFile: foundFilename,
                subfolder: foundSubfolder,
              });
              resolve();
              return true;
            }
          }
        }
      } catch {
          // continue polling
        }
        return false;
      };

      try {
        ws = new this.WebSocketFn(wsUrl);

        ws.onmessage = async (event: MessageEvent) => {
          if (isDone) return;
          if (record.status === "CANCELLED") return;
          try {
            if (typeof event.data !== "string") return; // ignore preview binaries
            const msg = JSON.parse(event.data);

            if (msg.type === "executing" && msg.data?.node === null && msg.data?.prompt_id === promptId) {
              const finished = await checkHistory();
              if (!finished) {
                setTimeout(async () => {
                  if (!(await checkHistory())) {
                    cleanup();
                    record.status = "COMPLETED";
                    record.completedAt = Date.now();
                    this.appendEvent({ jobId: record.jobId, status: "COMPLETED", completedAt: record.completedAt });
                    resolve();
                  }
                }, 200);
              }
            } else if (msg.type === "execution_error" && msg.data?.prompt_id === promptId) {
              cleanup();
              const errMsg = msg.data.exception_message || "ComfyUI execution error";
              record.status = "FAILED";
              record.error = errMsg;
              this.appendEvent({ jobId: record.jobId, status: "FAILED", error: errMsg });
              reject(new Error(errMsg));
            } else if (msg.type === "execution_interrupted" && msg.data?.prompt_id === promptId) {
              cleanup();
              record.status = "CANCELLED";
              this.appendEvent({ jobId: record.jobId, status: "CANCELLED" });
              resolve();
            }
          } catch {
            // ignore JSON parse error on non-json ws frames
          }
        };

        ws.onerror = () => {
          if (!pollInterval && !isDone) {
            pollInterval = setInterval(checkHistory, 500);
          }
        };

        ws.onclose = () => {
          if (!pollInterval && !isDone) {
            pollInterval = setInterval(checkHistory, 500);
          }
        };
      } catch {
        pollInterval = setInterval(checkHistory, 500);
      }
    });
  }

  async getJobStatus(userId: string, jobId: string): Promise<JobRecord> {
    const record = this.jobs.get(jobId);
    if (!record || record.userId !== userId) {
      throw new NotFoundError(`Job '${jobId}' not found for user '${userId}'`);
    }

    return {
      jobId: record.jobId,
      userId: record.userId,
      domain: record.domain,
      modelId: record.modelId,
      status: record.status,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      outputFile: record.outputFile,
      error: record.error,
    };
  }

  async cancelJob(userId: string, jobId: string): Promise<boolean> {
    const record = this.jobs.get(jobId);
    if (!record || record.userId !== userId) {
      throw new NotFoundError(`Job '${jobId}' not found for user '${userId}'`);
    }

    if (record.status === "QUEUED") {
      const idx = this.queue.findIndex((entry) => entry.jobId === jobId);
      if (idx !== -1) {
        this.queue.splice(idx, 1);
      }
      record.status = "CANCELLED";
      this.appendEvent({ jobId, status: "CANCELLED" });
      return true;
    }

    if (record.status === "RUNNING") {
      record.status = "CANCELLED";
      this.appendEvent({ jobId, status: "CANCELLED" });

      if (record.cancelExecution) {
        record.cancelExecution();
      }

      if (record.comfyPromptId) {
        try {
          await this.fetchFn(`${this.comfyUrl}/interrupt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });
        } catch {
          // best-effort
        }
        try {
          await this.fetchFn(`${this.comfyUrl}/queue`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ delete: [record.comfyPromptId] }),
          });
        } catch {
          // best-effort
        }
      }
      return true;
    }

    return false;
  }

  async getJobArtifact(userId: string, jobId: string): Promise<{ stream: NodeJS.ReadableStream; mimeType: string }> {
    const record = this.jobs.get(jobId);
    if (!record || record.userId !== userId) {
      throw new NotFoundError(`Job '${jobId}' not found for user '${userId}'`);
    }

    if (record.status !== "COMPLETED") {
      throw new JobNotCompleteError(`Job '${jobId}' has status '${record.status}', expected 'COMPLETED'`);
    }

    if (record.artifactEvicted || !record.outputFile) {
      throw new ArtifactExpiredError(`Artifact for job '${jobId}' is no longer available`);
    }

    const ext = path.extname(record.outputFile).toLowerCase();
    let mimeType = "application/octet-stream";
    if (ext === ".png") mimeType = "image/png";
    else if (ext === ".mp4") mimeType = "video/mp4";
    else if (ext === ".webp") mimeType = "image/webp";

    const localCachePath = path.join(this.artifactsDir, `${jobId}${ext}`);

    if (!fs.existsSync(localCachePath)) {
      const viewUrl = new URL(`${this.comfyUrl}/view`);
      viewUrl.searchParams.set("filename", record.outputFile);
      if (record.subfolder) {
        viewUrl.searchParams.set("subfolder", record.subfolder);
      }
      viewUrl.searchParams.set("type", "output");

      const res = await this.fetchFn(viewUrl.toString());
      if (!res.ok) {
        throw new Error(`Failed to retrieve artifact from ComfyUI: HTTP ${res.status}`);
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(localCachePath, buffer);
    }

    const stream = fs.createReadStream(localCachePath);
    return { stream, mimeType };
  }

  // ---------------------------------------------------------------------------
  // Retention & Maintenance Sweeper
  // ---------------------------------------------------------------------------

  startSweepInterval(): void {
    if (this.sweepTimer) return;
    const intervalMs = (process.env.COMFY_SWEEP_INTERVAL_MINUTES ? parseInt(process.env.COMFY_SWEEP_INTERVAL_MINUTES, 10) : 15) * 60 * 1000;
    this.sweepTimer = setInterval(() => {
      this.runRetentionSweep().catch(() => {});
    }, intervalMs);
  }

  stopSweepInterval(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  async runRetentionSweep(): Promise<void> {
    const now = Date.now();
    let needsCompaction = false;

    // 1. TTL sweep
    for (const record of this.jobs.values()) {
      if (record.status === "COMPLETED" && record.completedAt && record.outputFile) {
        if (now - record.completedAt > this.artifactTtlMs) {
          const ext = path.extname(record.outputFile).toLowerCase();
          const localCachePath = path.join(this.artifactsDir, `${record.jobId}${ext}`);
          if (fs.existsSync(localCachePath)) {
            try {
              fs.unlinkSync(localCachePath);
            } catch {
              // ignore
            }
          }
          record.outputFile = undefined;
          record.artifactEvicted = true;
          this.appendEvent({ jobId: record.jobId, outputFile: undefined, artifactEvicted: true });
        }
      }
    }

    // 2. Byte cap sweep
    let totalBytes = 0;
    const artifactFiles: { filePath: string; jobId: string; size: number; completedAt: number }[] = [];

    if (fs.existsSync(this.artifactsDir)) {
      const files = fs.readdirSync(this.artifactsDir);
      for (const file of files) {
        const filePath = path.join(this.artifactsDir, file);
        try {
          const stat = fs.statSync(filePath);
          totalBytes += stat.size;
          const jobId = path.basename(file, path.extname(file));
          const rec = this.jobs.get(jobId);
          artifactFiles.push({
            filePath,
            jobId,
            size: stat.size,
            completedAt: rec?.completedAt ?? 0,
          });
        } catch {
          // ignore stat error
        }
      }
    }

    if (totalBytes > this.artifactMaxBytes) {
      artifactFiles.sort((a, b) => a.completedAt - b.completedAt);
      for (const item of artifactFiles) {
        if (totalBytes <= this.artifactMaxBytes) break;
        try {
          fs.unlinkSync(item.filePath);
          totalBytes -= item.size;
          const rec = this.jobs.get(item.jobId);
          if (rec) {
            rec.outputFile = undefined;
            rec.artifactEvicted = true;
            this.appendEvent({ jobId: rec.jobId, outputFile: undefined, artifactEvicted: true });
          }
        } catch {
          // ignore unlink error
        }
      }
    }

    // 3. Record cap eviction
    if (this.jobs.size > this.maxJobRecords) {
      const terminalRecords: InternalJobRecord[] = [];
      for (const rec of this.jobs.values()) {
        if (rec.status === "COMPLETED" || rec.status === "FAILED" || rec.status === "CANCELLED" || rec.status === "TIMED_OUT") {
          terminalRecords.push(rec);
        }
      }
      terminalRecords.sort((a, b) => a.createdAt - b.createdAt);

      while (this.jobs.size > this.maxJobRecords && terminalRecords.length > 0) {
        const oldest = terminalRecords.shift()!;
        this.jobs.delete(oldest.jobId);
        needsCompaction = true;
      }
    }

    if (needsCompaction) {
      this.compactJobStore();
    }
  }
}
