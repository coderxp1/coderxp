/**
 * Integration tests for ComfyUiMediaJobService against a live ComfyUI instance.
 * Auto-skipped if COMFYUI_URL is not set.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import {
  ComfyUiMediaJobService,
  UserJobLimitError,
} from "../lib/server/providers";

if (!process.env.COMFYUI_URL) {
  console.log("COMFYUI_URL not set — skipping ComfyUI integration tests");
  process.exit(0);
}

const comfyUrl = process.env.COMFYUI_URL.trim().replace(/\/+$/, "");

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== RUNNING COMFYUI INTEGRATION TESTS (5 SCENARIOS) ===");
  console.log(`Connecting to ComfyUI at: ${comfyUrl}`);

  const testDataDir = path.join(process.cwd(), ".integration-test-data-" + Date.now());
  fs.mkdirSync(testDataDir, { recursive: true });

  const service = new ComfyUiMediaJobService({
    comfyUrl,
    dataDir: testDataDir,
    imageTimeoutS: 120,
    videoTimeoutS: 600,
  });

  try {
    // -------------------------------------------------------------
    // Scenario 1: Connectivity check
    // -------------------------------------------------------------
    console.log("\n--- Scenario 1: Connectivity check ---");
    const queueRes = await fetch(`${comfyUrl}/queue`);
    assert.equal(queueRes.status, 200, "GET /queue must return HTTP 200");
    const queueData = (await queueRes.json()) as { queue_running: unknown[]; queue_pending: unknown[] };
    console.log(`Queue status: running=${queueData.queue_running?.length ?? 0}, pending=${queueData.queue_pending?.length ?? 0}`);

    const objectInfoRes = await fetch(`${comfyUrl}/object_info`);
    assert.equal(objectInfoRes.status, 200, "GET /object_info must return HTTP 200");
    const objectInfo = (await objectInfoRes.json()) as Record<string, unknown>;

    assert.ok(objectInfo["SaveImage"], "ComfyUI must have native SaveImage node");
    assert.ok(objectInfo["CreateVideo"], "ComfyUI must have native CreateVideo node");
    assert.ok(objectInfo["SaveVideo"], "ComfyUI must have native SaveVideo node");
    console.log("Output nodes confirmed: SaveImage, CreateVideo, SaveVideo present.");
    console.log("[PASS] Scenario 1: Connectivity check");

    // -------------------------------------------------------------
    // Scenario 2: Image job round-trip
    // -------------------------------------------------------------
    console.log("\n--- Scenario 2: Image job round-trip (Flux.1-schnell 512x512, 4 steps) ---");
    const userId = "integ-user-img";
    const imgSubmit = await service.submitJob(userId, {
      modelId: "flux1-schnell",
      prompt: "a clean studio photograph of an orange cat wearing green sunglasses",
      width: 512,
      height: 512,
      steps: 4,
      seed: 42,
    });

    console.log(`Submitted image job: jobId=${imgSubmit.jobId}, initialStatus=${imgSubmit.status}`);
    assert.equal(imgSubmit.status, "QUEUED");

    let imgRecord = await service.getJobStatus(userId, imgSubmit.jobId);
    const startImgWait = Date.now();
    while (imgRecord.status === "QUEUED" || imgRecord.status === "RUNNING") {
      if (Date.now() - startImgWait > 120_000) {
        throw new Error("Image job timed out after 120s");
      }
      await sleep(1000);
      imgRecord = await service.getJobStatus(userId, imgSubmit.jobId);
      process.stdout.write(`\rJob ${imgSubmit.jobId} status: ${imgRecord.status} (elapsed: ${Math.round((Date.now() - startImgWait) / 1000)}s)... `);
    }
    console.log();

    assert.equal(imgRecord.status, "COMPLETED", `Image job must complete successfully, error: ${imgRecord.error}`);
    assert.ok(imgRecord.outputFile, "Image job must have outputFile");
    assert.ok(imgRecord.outputFile.endsWith(".png"), "Image outputFile must end in .png");

    const imgPromptId = (service as any).jobs.get(imgSubmit.jobId)?.comfyPromptId;
    console.log(`Image job completed: promptId=${imgPromptId}, outputFile=${imgRecord.outputFile}`);

    const imgArtifact = await service.getJobArtifact(userId, imgSubmit.jobId);
    assert.equal(imgArtifact.mimeType, "image/png", "MIME type must be image/png");
    let imgBytes = 0;
    for await (const chunk of imgArtifact.stream) {
      imgBytes += (chunk as Buffer).length;
    }
    assert.ok(imgBytes > 0, "Artifact stream must yield > 0 bytes");
    console.log(`Image artifact verified: ${imgBytes} bytes, MIME: ${imgArtifact.mimeType}`);
    console.log("[PASS] Scenario 2: Image job round-trip");

    // -------------------------------------------------------------
    // Scenario 3: Cancel running job
    // -------------------------------------------------------------
    console.log("\n--- Scenario 3: Cancel running job ---");
    const cancelUserId = "integ-user-cancel";
    const cancelSubmit = await service.submitJob(cancelUserId, {
      modelId: "flux1-schnell",
      prompt: "a landscape of misty mountains at sunrise",
      width: 512,
      height: 512,
      steps: 15,
      seed: 101,
    });
    console.log(`Submitted job to cancel: jobId=${cancelSubmit.jobId}`);

    // Wait until RUNNING with comfyPromptId
    const startRunningWait = Date.now();
    let promptIdToCancel: string | undefined;
    while (Date.now() - startRunningWait < 15_000) {
      const rec = (service as any).jobs.get(cancelSubmit.jobId);
      if (rec?.status === "RUNNING" && rec?.comfyPromptId) {
        promptIdToCancel = rec.comfyPromptId;
        break;
      }
      await sleep(100);
    }
    console.log(`Job transitioned to RUNNING on ComfyUI (promptId=${promptIdToCancel}), issuing cancelJob...`);
    const cancelResult = await service.cancelJob(cancelUserId, cancelSubmit.jobId);
    assert.equal(cancelResult, true, "cancelJob must return true");

    let cancelRecord = await service.getJobStatus(cancelUserId, cancelSubmit.jobId);
    const startCancelWait = Date.now();
    while (cancelRecord.status !== "CANCELLED" && Date.now() - startCancelWait < 15_000) {
      await sleep(500);
      cancelRecord = await service.getJobStatus(cancelUserId, cancelSubmit.jobId);
    }
    assert.equal(cancelRecord.status, "CANCELLED", "Cancelled job must reach CANCELLED status");
    console.log(`Job ${cancelSubmit.jobId} successfully reached CANCELLED status (execution_interrupted event handled).`);
    console.log("[PASS] Scenario 3: Cancel running job");

    // -------------------------------------------------------------
    // Scenario 4: Per-user limit
    // -------------------------------------------------------------
    console.log("\n--- Scenario 4: Per-user limit ---");
    const limitUserId = "integ-user-limit";
    const jobA = await service.submitJob(limitUserId, {
      modelId: "flux1-schnell",
      prompt: "job A prompt",
      width: 512,
      height: 512,
      steps: 4,
    });
    assert.ok(jobA.jobId);

    // Second job submitted for same user in rapid succession must be rejected
    await assert.rejects(
      () =>
        service.submitJob(limitUserId, {
          modelId: "flux1-schnell",
          prompt: "job B prompt",
          width: 512,
          height: 512,
          steps: 4,
        }),
      UserJobLimitError,
      "Second active job for same user must throw UserJobLimitError",
    );
    console.log("Second job for same user rejected with UserJobLimitError as expected.");

    // Clean up job A
    await service.cancelJob(limitUserId, jobA.jobId);
    console.log("[PASS] Scenario 4: Per-user limit");

    // -------------------------------------------------------------
    // Scenario 5: Video job round-trip (MP4)
    // -------------------------------------------------------------
    console.log("\n--- Scenario 5: Video job round-trip (Wan 2.1 832x480, 17 frames, 10 steps, MP4) ---");
    const vidUserId = "integ-user-vid";
    const vidSubmit = await service.submitJob(vidUserId, {
      modelId: "wan2.1-t2v-1.3b",
      prompt: "cinematic drone flight over calm blue ocean waves at golden hour",
      negativePrompt: "blurry, low quality, distorted",
      width: 832,
      height: 480,
      steps: 10,
      durationFrames: 17,
      fps: 16,
      seed: 42,
    });

    console.log(`Submitted video job: jobId=${vidSubmit.jobId}, initialStatus=${vidSubmit.status}`);
    assert.equal(vidSubmit.status, "QUEUED");

    let vidRecord = await service.getJobStatus(vidUserId, vidSubmit.jobId);
    const startVidWait = Date.now();
    while (vidRecord.status === "QUEUED" || vidRecord.status === "RUNNING") {
      if (Date.now() - startVidWait > 600_000) {
        throw new Error("Video job timed out after 600s");
      }
      await sleep(2000);
      vidRecord = await service.getJobStatus(vidUserId, vidSubmit.jobId);
      process.stdout.write(`\rJob ${vidSubmit.jobId} status: ${vidRecord.status} (elapsed: ${Math.round((Date.now() - startVidWait) / 1000)}s)... `);
    }
    console.log();

    assert.equal(vidRecord.status, "COMPLETED", `Video job must complete successfully, error: ${vidRecord.error}`);
    assert.ok(vidRecord.outputFile, "Video job must have outputFile");
    assert.ok(vidRecord.outputFile.endsWith(".mp4"), `Video outputFile must end in .mp4, got: ${vidRecord.outputFile}`);

    const vidPromptId = (service as any).jobs.get(vidSubmit.jobId)?.comfyPromptId;
    console.log(`Video job completed: promptId=${vidPromptId}, outputFile=${vidRecord.outputFile}`);

    const vidArtifact = await service.getJobArtifact(vidUserId, vidSubmit.jobId);
    assert.equal(vidArtifact.mimeType, "video/mp4", "MIME type must be video/mp4");
    let vidBytes = 0;
    for await (const chunk of vidArtifact.stream) {
      vidBytes += (chunk as Buffer).length;
    }
    assert.ok(vidBytes > 0, "Artifact stream must yield > 0 bytes");
    console.log(`Video artifact verified: ${vidBytes} bytes, MIME: ${vidArtifact.mimeType}`);
    console.log("[PASS] Scenario 5: Video job round-trip (MP4)");

    console.log("\n=== ALL 5 INTEGRATION SCENARIOS PASSED SUCCESSFULLY ===");
  } finally {
    try {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  }
}

main().catch((err) => {
  console.error("INTEGRATION TESTS FAILED:", err);
  process.exit(1);
});
