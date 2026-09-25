/**
 * Unit tests for ComfyUiMediaJobService (31 test cases from Design Doc v1.1 Section 5.1).
 * Mock HTTP fetch and WebSocket — no external network, no GPU required.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import {
  ComfyUiMediaJobService,
  ValidationError,
  UserJobLimitError,
  NotFoundError,
  JobNotCompleteError,
  ArtifactExpiredError,
  InternalJobRecord,
} from "../lib/server/providers";

// ---------------------------------------------------------------------------
// Mock Helpers
// ---------------------------------------------------------------------------

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  emitMessage(data: unknown): void {
    if (this.onmessage) {
      this.onmessage({ data: typeof data === "string" ? data : JSON.stringify(data) });
    }
  }

  close(): void {}
}

interface MockFetchCall {
  url: string;
  init?: RequestInit;
}

function createMockEnvironment() {
  const fetchCalls: MockFetchCall[] = [];
  MockWebSocket.instances = [];

  const historyResponses: Record<string, unknown> = {};

  const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url: urlStr, init });

    if (urlStr.includes("/history/")) {
      const promptId = urlStr.split("/history/")[1].split("?")[0];
      const custom = historyResponses[promptId];
      if (custom !== undefined) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ [promptId]: custom }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          [promptId]: {
            outputs: {
              "7": {
                images: [{ filename: "test_output.png", subfolder: "", type: "output" }],
              },
            },
          },
        }),
      } as unknown as Response;
    }

    if (urlStr.endsWith("/prompt") || urlStr.includes("/prompt?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          prompt_id: "prompt-" + Math.random().toString(36).substring(2, 9),
          number: 1,
          node_errors: {},
        }),
      } as unknown as Response;
    }

    if (urlStr.includes("/queue")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      } as unknown as Response;
    }

    if (urlStr.includes("/view")) {
      const buf = Buffer.from("fake-binary-image-data");
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      } as unknown as Response;
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response;
  };

  return { mockFetch, fetchCalls, historyResponses };
}

function createTestDataDir(name: string): string {
  const dir = path.join(process.cwd(), ".unit-test-data", name + "-" + Date.now() + "-" + Math.random().toString(36).substring(2, 6));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Unit Tests Suite (31 Tests)
// ---------------------------------------------------------------------------

async function runTests() {
  console.log("=== RUNNING COMFYUI MEDIA PROVIDER UNIT TESTS (31 TESTS) ===");
  let passed = 0;

  const validImageReq = {
    modelId: "flux1-schnell",
    prompt: "a majestic golden retriever running in a park",
    width: 512,
    height: 512,
    steps: 4,
    seed: 42,
  };

  const validVideoReq = {
    modelId: "wan2.1-t2v-1.3b",
    prompt: "a cinematic view of ocean waves at sunset",
    negativePrompt: "low quality, blurry",
    width: 832,
    height: 480,
    steps: 30,
    durationFrames: 49,
    fps: 16,
    seed: 42,
  };

  // 1. submitJob — prompt > 1 000 chars
  {
    console.log("Test 1: submitJob — prompt > 1 000 chars throws ValidationError");
    const testDir = createTestDataDir("t1");
    const service = new ComfyUiMediaJobService({ dataDir: testDir });
    await assert.rejects(
      () => service.submitJob("u1", { ...validImageReq, prompt: "a".repeat(1001) }),
      ValidationError,
    );
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 1");
  }

  // 2. submitJob — image width not divisible by 8
  {
    console.log("Test 2: submitJob — image width not divisible by 8 throws ValidationError");
    const testDir = createTestDataDir("t2");
    const service = new ComfyUiMediaJobService({ dataDir: testDir });
    await assert.rejects(
      () => service.submitJob("u1", { ...validImageReq, width: 515 }),
      ValidationError,
    );
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 2");
  }

  // 3. submitJob — image width > 1 024
  {
    console.log("Test 3: submitJob — image width > 1 024 throws ValidationError");
    const testDir = createTestDataDir("t3");
    const service = new ComfyUiMediaJobService({ dataDir: testDir });
    await assert.rejects(
      () => service.submitJob("u1", { ...validImageReq, width: 1032 }),
      ValidationError,
    );
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 3");
  }

  // 4. submitJob — steps = 31 for image domain
  {
    console.log("Test 4: submitJob — steps = 31 for image domain throws ValidationError");
    const testDir = createTestDataDir("t4");
    const service = new ComfyUiMediaJobService({ dataDir: testDir });
    await assert.rejects(
      () => service.submitJob("u1", { ...validImageReq, steps: 31 }),
      ValidationError,
    );
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 4");
  }

  // 5. submitJob — steps = 51 for video domain
  {
    console.log("Test 5: submitJob — steps = 51 for video domain throws ValidationError");
    const testDir = createTestDataDir("t5");
    const service = new ComfyUiMediaJobService({ dataDir: testDir });
    await assert.rejects(
      () => service.submitJob("u1", { ...validVideoReq, steps: 51 }),
      ValidationError,
    );
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 5");
  }

  // 6. submitJob — video durationFrames not 4n+1 (e.g. 50 or 82)
  {
    console.log("Test 6: submitJob — video durationFrames not 4n+1 throws ValidationError");
    const testDir = createTestDataDir("t6");
    const service = new ComfyUiMediaJobService({ dataDir: testDir });
    await assert.rejects(
      () => service.submitJob("u1", { ...validVideoReq, durationFrames: 50 }),
      ValidationError,
    );
    await assert.rejects(
      () => service.submitJob("u1", { ...validVideoReq, durationFrames: 82 }),
      ValidationError,
    );
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 6");
  }

  // 7. submitJob — video width/height !== 832x480
  {
    console.log("Test 7: submitJob — video width/height !== 832x480 throws ValidationError");
    const testDir = createTestDataDir("t7");
    const service = new ComfyUiMediaJobService({ dataDir: testDir });
    await assert.rejects(
      () => service.submitJob("u1", { ...validVideoReq, width: 512, height: 512 }),
      ValidationError,
    );
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 7");
  }

  // 8. submitJob — fps outside [1, 30] (e.g. 0 or 31)
  {
    console.log("Test 8: submitJob — fps outside [1, 30] throws ValidationError");
    const testDir = createTestDataDir("t8");
    const service = new ComfyUiMediaJobService({ dataDir: testDir });
    await assert.rejects(
      () => service.submitJob("u1", { ...validVideoReq, fps: 0 }),
      ValidationError,
    );
    await assert.rejects(
      () => service.submitJob("u1", { ...validVideoReq, fps: 31 }),
      ValidationError,
    );
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 8");
  }

  // 9. submitJob — second job same userId (one QUEUED)
  {
    console.log("Test 9: submitJob — second job same userId (one QUEUED) throws UserJobLimitError");
    const testDir = createTestDataDir("t9");
    const { mockFetch } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });
    // First job queued
    const res1 = await service.submitJob("user-limit-1", validImageReq);
    assert.equal(res1.status, "QUEUED");
    // Immediately attempt second job for same user while first is active/queued
    await assert.rejects(
      () => service.submitJob("user-limit-1", validImageReq),
      UserJobLimitError,
    );
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 9");
  }

  // 10. submitJob — second job same userId (one RUNNING)
  {
    console.log("Test 10: submitJob — second job same userId (one RUNNING) throws UserJobLimitError");
    const testDir = createTestDataDir("t10");
    const { mockFetch } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });
    await service.submitJob("user-limit-2", validImageReq);
    // Allow queue worker to dequeue and transition to RUNNING
    await sleep(20);
    await assert.rejects(
      () => service.submitJob("user-limit-2", validImageReq),
      UserJobLimitError,
    );
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 10");
  }

  // 11. submitJob — second job different userId
  {
    console.log("Test 11: submitJob — second job different userId succeeds");
    const testDir = createTestDataDir("t11");
    const { mockFetch } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });
    const res1 = await service.submitJob("user-a", validImageReq);
    const res2 = await service.submitJob("user-b", validImageReq);
    assert.ok(res1.jobId);
    assert.ok(res2.jobId);
    assert.notEqual(res1.jobId, res2.jobId);
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 11");
  }

  // 12. submitJob — returns { jobId, status: "QUEUED" } immediately
  {
    console.log("Test 12: submitJob returns { jobId, status: 'QUEUED' } immediately");
    const testDir = createTestDataDir("t12");
    const { mockFetch } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });
    const res = await service.submitJob("user-immediate", validImageReq);
    assert.equal(res.status, "QUEUED");
    const initialStatus = await service.getJobStatus("user-immediate", res.jobId);
    assert.equal(initialStatus.status, "QUEUED");
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 12");
  }

  // 13. SerialQueue — QUEUED -> RUNNING on dequeue
  {
    console.log("Test 13: SerialQueue — QUEUED -> RUNNING on dequeue");
    const testDir = createTestDataDir("t13");
    const { mockFetch, fetchCalls } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });
    const res = await service.submitJob("user-dequeue", validImageReq);
    await sleep(25);
    const status = await service.getJobStatus("user-dequeue", res.jobId);
    assert.equal(status.status, "RUNNING");
    assert.ok(status.startedAt !== undefined && status.startedAt > 0);
    const promptCall = fetchCalls.find((c) => c.url.includes("/prompt"));
    assert.ok(promptCall, "ComfyUI /prompt must have been called");
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 13");
  }

  // 14. SerialQueue — RUNNING -> COMPLETED on WS signal
  {
    console.log("Test 14: SerialQueue — RUNNING -> COMPLETED on WS executing null");
    const testDir = createTestDataDir("t14");
    const { mockFetch } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });
    const res = await service.submitJob("user-complete", validImageReq);
    await sleep(25);

    // Find active mock WebSocket and trigger execution completion
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    assert.ok(ws, "WebSocket must be instantiated");
    // Read the internal promptId from provider
    const runningRec = (service as unknown as { jobs: Map<string, InternalJobRecord> }).jobs.get(res.jobId);
    assert.ok(runningRec?.comfyPromptId);
    ws.emitMessage({
      type: "executing",
      data: { node: null, prompt_id: runningRec.comfyPromptId },
    });

    await sleep(50);
    const finalStatus = await service.getJobStatus("user-complete", res.jobId);
    assert.equal(finalStatus.status, "COMPLETED");
    assert.equal(finalStatus.outputFile, "test_output.png");
    assert.ok(finalStatus.completedAt !== undefined && finalStatus.completedAt > 0);
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 14");
  }

  // 15. SerialQueue — RUNNING -> FAILED on execution_error
  {
    console.log("Test 15: SerialQueue — RUNNING -> FAILED on execution_error");
    const testDir = createTestDataDir("t15");
    const { mockFetch } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });
    const res = await service.submitJob("user-fail", validImageReq);
    await sleep(25);

    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    const runningRec = (service as unknown as { jobs: Map<string, InternalJobRecord> }).jobs.get(res.jobId);
    ws.emitMessage({
      type: "execution_error",
      data: {
        prompt_id: runningRec?.comfyPromptId,
        exception_message: "CUDA out of memory in KSampler",
      },
    });

    await sleep(50);
    const finalStatus = await service.getJobStatus("user-fail", res.jobId);
    assert.equal(finalStatus.status, "FAILED");
    assert.equal(finalStatus.error, "CUDA out of memory in KSampler");
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 15");
  }

  // 16. SerialQueue — timeout -> TIMED_OUT
  {
    console.log("Test 16: SerialQueue — timeout -> TIMED_OUT");
    const testDir = createTestDataDir("t16");
    const { mockFetch, fetchCalls } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      imageTimeoutS: 0.05, // 50ms
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });
    const res = await service.submitJob("user-timeout", validImageReq);
    await sleep(120);

    const finalStatus = await service.getJobStatus("user-timeout", res.jobId);
    assert.equal(finalStatus.status, "TIMED_OUT");
    const queueDeleteCall = fetchCalls.find((c) => c.url.includes("/queue") && c.init?.method === "POST");
    assert.ok(queueDeleteCall, "Must issue /queue delete on timeout");
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 16");
  }

  // 17. getJobStatus — unknown jobId
  {
    console.log("Test 17: getJobStatus — unknown jobId throws NotFoundError");
    const testDir = createTestDataDir("t17");
    const service = new ComfyUiMediaJobService({ dataDir: testDir });
    await assert.rejects(
      () => service.getJobStatus("u1", "nonexistent-job-id"),
      NotFoundError,
    );
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 17");
  }

  // 18. getJobStatus — userId mismatch
  {
    console.log("Test 18: getJobStatus — userId mismatch throws NotFoundError");
    const testDir = createTestDataDir("t18");
    const { mockFetch } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });
    const { jobId } = await service.submitJob("owner-user", validImageReq);
    await assert.rejects(
      () => service.getJobStatus("intruder-user", jobId),
      NotFoundError,
    );
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 18");
  }

  // 19. cancelJob — QUEUED job
  {
    console.log("Test 19: cancelJob — QUEUED job removed, returns true");
    const testDir = createTestDataDir("t19");
    const { mockFetch, fetchCalls } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });
    const { jobId } = await service.submitJob("user-cancel-queued", validImageReq);
    // Cancel immediately before worker processes it
    const cancelled = await service.cancelJob("user-cancel-queued", jobId);
    assert.equal(cancelled, true);
    const status = await service.getJobStatus("user-cancel-queued", jobId);
    assert.equal(status.status, "CANCELLED");

    // Wait a tick and verify /prompt was never called for this job
    await sleep(30);
    assert.equal(fetchCalls.length, 0, "No ComfyUI calls should occur for queued cancellation");
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 19");
  }

  // 20. cancelJob — RUNNING job
  {
    console.log("Test 20: cancelJob — RUNNING job issues /queue delete and handles interrupted");
    const testDir = createTestDataDir("t20");
    const { mockFetch, fetchCalls } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });
    const { jobId } = await service.submitJob("user-cancel-running", validImageReq);
    await sleep(25);

    const cancelled = await service.cancelJob("user-cancel-running", jobId);
    assert.equal(cancelled, true);
    const status = await service.getJobStatus("user-cancel-running", jobId);
    assert.equal(status.status, "CANCELLED");

    const deleteCall = fetchCalls.find((c) => c.url.includes("/queue") && c.init?.method === "POST");
    assert.ok(deleteCall, "ComfyUI /queue delete must be called");
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 20");
  }

  // 21. cancelJob — COMPLETED job
  {
    console.log("Test 21: cancelJob — COMPLETED job is a no-op, returns false");
    const testDir = createTestDataDir("t21");
    const { mockFetch } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });
    const { jobId } = await service.submitJob("user-cancel-done", validImageReq);
    await sleep(25);

    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    const rec = (service as unknown as { jobs: Map<string, InternalJobRecord> }).jobs.get(jobId);
    ws.emitMessage({
      type: "executing",
      data: { node: null, prompt_id: rec?.comfyPromptId },
    });
    await sleep(30);

    const cancelled = await service.cancelJob("user-cancel-done", jobId);
    assert.equal(cancelled, false);
    const finalStatus = await service.getJobStatus("user-cancel-done", jobId);
    assert.equal(finalStatus.status, "COMPLETED");
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 21");
  }

  // 22. getJobArtifact — COMPLETED job
  {
    console.log("Test 22: getJobArtifact — COMPLETED job streams bytes with derived MIME type");
    const testDir = createTestDataDir("t22");
    const { mockFetch } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });
    const { jobId } = await service.submitJob("user-art-ok", validImageReq);
    await sleep(25);

    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    const rec = (service as unknown as { jobs: Map<string, InternalJobRecord> }).jobs.get(jobId);
    ws.emitMessage({
      type: "executing",
      data: { node: null, prompt_id: rec?.comfyPromptId },
    });
    await sleep(30);

    const { stream, mimeType } = await service.getJobArtifact("user-art-ok", jobId);
    assert.equal(mimeType, "image/png");
    assert.ok(stream instanceof Readable);
    for await (const _ of stream) {
      // drain stream
    }
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 22");
  }

  // 23. getJobArtifact — FAILED job
  {
    console.log("Test 23: getJobArtifact — FAILED job throws JobNotCompleteError");
    const testDir = createTestDataDir("t23");
    const { mockFetch } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });
    const { jobId } = await service.submitJob("user-art-fail", validImageReq);
    await sleep(25);

    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    const rec = (service as unknown as { jobs: Map<string, InternalJobRecord> }).jobs.get(jobId);
    ws.emitMessage({
      type: "execution_error",
      data: { prompt_id: rec?.comfyPromptId, exception_message: "oom" },
    });
    await sleep(30);

    await assert.rejects(
      () => service.getJobArtifact("user-art-fail", jobId),
      JobNotCompleteError,
    );
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 23");
  }

  // 24. getJobArtifact — past TTL
  {
    console.log("Test 24: getJobArtifact — past TTL throws ArtifactExpiredError");
    const testDir = createTestDataDir("t24");
    const { mockFetch } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      artifactTtlHours: 1,
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });
    const { jobId } = await service.submitJob("user-art-ttl", validImageReq);
    await sleep(25);

    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    const rec = (service as unknown as { jobs: Map<string, InternalJobRecord> }).jobs.get(jobId);
    ws.emitMessage({
      type: "executing",
      data: { node: null, prompt_id: rec?.comfyPromptId },
    });
    await sleep(30);

    // Simulate completion 2 hours ago
    if (rec) rec.completedAt = Date.now() - 2 * 3600 * 1000;
    await service.runRetentionSweep();

    await assert.rejects(
      () => service.getJobArtifact("user-art-ttl", jobId),
      ArtifactExpiredError,
    );
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 24");
  }

  // 25. Template compile — image tokens substituted
  {
    console.log("Test 25: Template compile — image tokens substituted snapshot verification");
    const testDir = createTestDataDir("t25");
    const service = new ComfyUiMediaJobService({ dataDir: testDir });
    const compiled = service.compileWorkflow("image", {
      prompt: "a majestic golden retriever",
      width: 512,
      height: 768,
      seed: 12345,
      steps: 8,
      durationFrames: 49,
      fps: 16,
    }) as any;

    assert.equal(compiled["1"].class_type, "CheckpointLoaderSimple");
    assert.equal(compiled["1"].inputs.ckpt_name, "flux1-schnell-fp8.safetensors");
    assert.equal(compiled["2"].class_type, "CLIPTextEncode");
    assert.equal(compiled["2"].inputs.text, "a majestic golden retriever");
    assert.equal(compiled["4"].class_type, "EmptyLatentImage");
    assert.equal(compiled["4"].inputs.width, 512);
    assert.equal(compiled["4"].inputs.height, 768);
    assert.equal(compiled["5"].class_type, "KSampler");
    assert.equal(compiled["5"].inputs.seed, 12345);
    assert.equal(compiled["5"].inputs.steps, 8);
    assert.equal(compiled["5"].inputs.cfg, 1.0);
    assert.equal(compiled["5"].inputs.sampler_name, "euler");
    assert.equal(compiled["5"].inputs.scheduler, "simple");
    assert.equal(compiled["7"].class_type, "SaveImage");
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 25");
  }

  // 26. Template compile — video tokens substituted
  {
    console.log("Test 26: Template compile — video tokens substituted snapshot verification");
    const testDir = createTestDataDir("t26");
    const service = new ComfyUiMediaJobService({ dataDir: testDir });
    const compiled = service.compileWorkflow("video", {
      prompt: "ocean waves at sunset",
      negativePrompt: "blurry",
      width: 832,
      height: 480,
      seed: 9999,
      steps: 25,
      durationFrames: 33,
      fps: 24,
    }) as any;

    assert.equal(compiled["1"].class_type, "UNETLoader");
    assert.equal(compiled["2"].class_type, "ModelSamplingSD3");
    assert.equal(compiled["2"].inputs.shift, 8.0);
    assert.equal(compiled["3"].class_type, "CLIPLoader");
    assert.equal(compiled["3"].inputs.type, "wan");
    assert.equal(compiled["5"].class_type, "CLIPTextEncode");
    assert.equal(compiled["5"].inputs.text, "ocean waves at sunset");
    assert.equal(compiled["6"].class_type, "CLIPTextEncode");
    assert.equal(compiled["6"].inputs.text, "blurry");
    assert.equal(compiled["7"].class_type, "EmptyHunyuanLatentVideo");
    assert.equal(compiled["7"].inputs.width, 832);
    assert.equal(compiled["7"].inputs.height, 480);
    assert.equal(compiled["7"].inputs.length, 33);
    assert.equal(compiled["8"].class_type, "KSampler");
    assert.equal(compiled["8"].inputs.seed, 9999);
    assert.equal(compiled["8"].inputs.steps, 25);
    assert.equal(compiled["8"].inputs.cfg, 6.0);
    assert.equal(compiled["8"].inputs.sampler_name, "uni_pc");
    assert.equal(compiled["9"].class_type, "VAEDecode");
    assert.equal(compiled["10"].class_type, "CreateVideo");
    assert.equal(compiled["10"].inputs.fps, 24);
    assert.equal(compiled["11"].class_type, "SaveVideo");
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 26");
  }

  // 27. Template compile — unknown model ID rejected
  {
    console.log("Test 27: Template compile — unknown model ID rejected throws ValidationError");
    const testDir = createTestDataDir("t27");
    const service = new ComfyUiMediaJobService({ dataDir: testDir });
    await assert.rejects(
      () => service.submitJob("u1", { ...validImageReq, modelId: "unsupported-model-v9" }),
      ValidationError,
    );
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 27");
  }

  // 28. Sweep — deletes artifact file past TTL
  {
    console.log("Test 28: Sweep — deletes artifact file past TTL");
    const testDir = createTestDataDir("t28");
    const { mockFetch } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      artifactTtlHours: 1,
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });
    const { jobId } = await service.submitJob("user-sweep-ttl", validImageReq);
    await sleep(25);

    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    const rec = (service as unknown as { jobs: Map<string, InternalJobRecord> }).jobs.get(jobId)!;
    ws.emitMessage({
      type: "executing",
      data: { node: null, prompt_id: rec.comfyPromptId },
    });
    await sleep(30);

    // Download to artifact cache
    const { stream } = await service.getJobArtifact("user-sweep-ttl", jobId);
    for await (const _ of stream) {}
    const cachedFile = path.join(testDir, "artifacts", `${jobId}.png`);
    assert.ok(fs.existsSync(cachedFile), "Artifact file must exist in cache");

    // Age record by 2 hours and sweep
    rec.completedAt = Date.now() - 2 * 3600 * 1000;
    await service.runRetentionSweep();

    assert.equal(fs.existsSync(cachedFile), false, "Artifact file must be deleted after TTL sweep");
    assert.equal(rec.outputFile, undefined, "outputFile in record must be cleared");
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 28");
  }

  // 29. Sweep — evicts oldest artifacts when byte cap exceeded
  {
    console.log("Test 29: Sweep — evicts oldest artifacts when byte cap exceeded");
    const testDir = createTestDataDir("t29");
    const { mockFetch } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      artifactMaxBytes: 15, // Low byte cap
      fetchFn: mockFetch,
      WebSocketFn: MockWebSocket as unknown as typeof WebSocket,
    });

    const j1 = await service.submitJob("u-cap-1", validImageReq);
    await sleep(25);
    let ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    let r1 = (service as unknown as { jobs: Map<string, InternalJobRecord> }).jobs.get(j1.jobId)!;
    ws.emitMessage({ type: "executing", data: { node: null, prompt_id: r1.comfyPromptId } });
    await sleep(30);
    const art1 = await service.getJobArtifact("u-cap-1", j1.jobId);
    for await (const _ of art1.stream) {}
    r1.completedAt = 1000; // older

    const j2 = await service.submitJob("u-cap-2", validImageReq);
    await sleep(25);
    ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    let r2 = (service as unknown as { jobs: Map<string, InternalJobRecord> }).jobs.get(j2.jobId)!;
    ws.emitMessage({ type: "executing", data: { node: null, prompt_id: r2.comfyPromptId } });
    await sleep(30);
    const art2 = await service.getJobArtifact("u-cap-2", j2.jobId);
    for await (const _ of art2.stream) {}
    r2.completedAt = 2000; // newer

    // Both files exist (~22 bytes each, total ~44 bytes > 15 byte cap)
    const f1 = path.join(testDir, "artifacts", `${j1.jobId}.png`);
    const f2 = path.join(testDir, "artifacts", `${j2.jobId}.png`);
    assert.ok(fs.existsSync(f1));
    assert.ok(fs.existsSync(f2));

    await service.runRetentionSweep();

    // Oldest should have been deleted first
    assert.equal(fs.existsSync(f1), false, "Oldest artifact file must be deleted");
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 29");
  }

  // 30. Restart recovery — orphaned RUNNING prompt cancelled
  {
    console.log("Test 30: Restart recovery — orphaned RUNNING prompt cancelled and marked FAILED");
    const testDir = createTestDataDir("t30");
    const jobsFile = path.join(testDir, "jobs.jsonl");

    // Write a mock jobs.jsonl with a running job from previous crash
    const orphanedRecord = {
      jobId: "orphaned-job-999",
      userId: "u-crash",
      domain: "image",
      modelId: "flux1-schnell",
      status: "RUNNING",
      createdAt: Date.now() - 5000,
      comfyPromptId: "orphaned-prompt-xyz",
      comfyClientId: "c-xyz",
      timeoutAt: Date.now() + 60000,
    };
    fs.writeFileSync(jobsFile, JSON.stringify(orphanedRecord) + "\n");

    const { mockFetch, fetchCalls } = createMockEnvironment();
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      fetchFn: mockFetch,
    });

    const status = await service.getJobStatus("u-crash", "orphaned-job-999");
    assert.equal(status.status, "FAILED");
    assert.equal(status.error, "Service restarted while job was running");

    const deleteCall = fetchCalls.find(
      (c) => c.url.includes("/queue") && c.init?.body?.toString().includes("orphaned-prompt-xyz"),
    );
    assert.ok(deleteCall, "Startup recovery must send POST /queue delete for orphaned prompt");
    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 30");
  }

  // 31. Log compaction — atomic rewrite on startup and prune
  {
    console.log("Test 31: Log compaction — atomic rewrite on startup and prune via .tmp rename");
    const testDir = createTestDataDir("t31");
    const jobsFile = path.join(testDir, "jobs.jsonl");

    // Create 5 terminal records
    const lines: string[] = [];
    for (let i = 1; i <= 5; i++) {
      lines.push(
        JSON.stringify({
          jobId: `job-${i}`,
          userId: `u-${i}`,
          domain: "image",
          modelId: "flux1-schnell",
          status: "COMPLETED",
          createdAt: 1000 * i,
          completedAt: 1000 * i + 500,
        }),
      );
    }
    fs.writeFileSync(jobsFile, lines.join("\n") + "\n");

    // Start service with maxJobRecords = 3
    const service = new ComfyUiMediaJobService({
      dataDir: testDir,
      maxJobRecords: 3,
    });

    await service.runRetentionSweep();

    // Verify surviving records in file
    const fileContent = fs.readFileSync(jobsFile, "utf-8").trim().split("\n");
    assert.equal(fileContent.length, 3, "Compacted file must contain exactly 3 surviving records");

    // Oldest jobs (job-1, job-2) should have been evicted
    await assert.rejects(() => service.getJobStatus("u-1", "job-1"), NotFoundError);
    await assert.rejects(() => service.getJobStatus("u-2", "job-2"), NotFoundError);
    const surv = await service.getJobStatus("u-5", "job-5");
    assert.equal(surv.status, "COMPLETED");

    cleanupDir(testDir);
    passed++;
    console.log("[PASS] Test 31");
  }

  console.log(`\n=== ALL ${passed}/31 UNIT TESTS PASSED SUCCESSFULLY ===`);
}

runTests().catch((err) => {
  console.error("UNIT TESTS FAILED:", err);
  process.exit(1);
});
