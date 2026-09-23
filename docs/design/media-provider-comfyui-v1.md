# ComfyUI Media Provider — Design v1

**Status:** Draft for review  
**Branch:** `feat/media-provider-design`  
**Author:** GPU/Media stream (dev-alex)  
**Date:** 2026-09-23  
**Implements:** `IMediaJobService` from `lib/server/providers/types.ts` (merged after PR #4)

---

## Overview

This document specifies the design for `ComfyUiMediaJobService`, the concrete implementation of `IMediaJobService` that drives image and video generation through the local ComfyUI v0.36.0 instance on the GPU host. The text-provider layer (PR #4) is not touched here — this service builds alongside it, implementing the same provider-layer interfaces for the `media` domain.

**What this is NOT:** implementation code. This PR contains only the design document. The implementation PR follows after design review.

---

## 1. ComfyUI API Surface

ComfyUI v0.36.0 exposes an HTTP + WebSocket API on `127.0.0.1:8188` (loopback only — see Authentication below).

### 1.1 HTTP Endpoints Used

#### `POST /prompt` — Submit workflow

Enqueues a compiled workflow graph for execution.

**Request**
```json
{
  "prompt": { "<node_id>": { "class_type": "...", "inputs": {} } },
  "client_id": "<uuid-v4>",
  "extra_data": {},
  "front": false
}
```

`client_id` must be a stable UUID generated per-job so that WebSocket events are routable back to the originating job. It is never reused across jobs.

**Success response (200)**
```json
{
  "prompt_id": "a3f9e2b1-4c5d-4e6f-8a9b-0c1d2e3f4a5b",
  "number": 0,
  "node_errors": {}
}
```

**Validation failure (400)**
```json
{
  "error": { "type": "prompt_outputs_failed_validation", "message": "..." },
  "node_errors": {
    "<node_id>": { "class_type": "...", "dependent_outputs": [], "errors": [...] }
  }
}
```

---

#### `GET /history/{prompt_id}` — Poll for completion

Returns execution history for a specific prompt. Empty object `{}` means the prompt is still pending or unknown.

**Response (completed)**
```json
{
  "<prompt_id>": {
    "prompt": [...],
    "outputs": {
      "<output_node_id>": {
        "images": [{ "filename": "cxp_img_00001_.png", "subfolder": "", "type": "output" }],
        "gifs":   [{ "filename": "cxp_vid_00001_.mp4",  "subfolder": "", "type": "output" }]
      }
    },
    "status": { "status_str": "success", "completed": true }
  }
}
```

The provider uses this as a fallback poll when the WebSocket connection drops. Primary completion detection is via WebSocket.

---

#### `GET /view` — Retrieve output artifact

Downloads a generated file by name.

| Parameter  | Required | Description |
|------------|----------|-------------|
| `filename` | ✓        | File name from the history outputs |
| `subfolder` |         | Subdirectory inside type folder (usually empty) |
| `type`     |          | `input` / `temp` / `output` (default: `output`) |

Returns raw bytes with the appropriate `Content-Type` (`image/png` or `video/mp4`). The provider always uses `type=output`.

---

#### `GET /queue` — Queue state (health / cancel check)

```json
{
  "queue_running": [[3, "<prompt_id>", {}, {}, ["<node_id>"]]],
  "queue_pending": []
}
```

Used on startup health checks and to confirm cancel delivery.

#### `POST /queue` — Cancel a running prompt

```json
{ "delete": ["<prompt_id>"] }
```

ComfyUI stops the running prompt and emits `execution_interrupted` on the WebSocket.

---

### 1.2 WebSocket — Real-Time Progress

Connect once per job:

```
ws://127.0.0.1:8188/ws?clientId=<client_id>
```

The `clientId` query parameter must match the `client_id` submitted with `/prompt`. ComfyUI routes events for that prompt exclusively to this connection.

**Event message structure** (JSON frames):
```json
{ "type": "<event_type>", "data": { ... } }
```

| Event type             | When                                  | Key fields in `data`                              |
|------------------------|---------------------------------------|---------------------------------------------------|
| `status`               | Queue depth changes                   | `status.exec_info.queue_remaining`                |
| `execution_start`      | Workflow begins executing             | `prompt_id`                                       |
| `execution_cached`     | Node skipped (result cached)          | `nodes`, `prompt_id`                              |
| `executing`            | A node starts; or workflow finishes   | `node` (null = done), `prompt_id`                 |
| `progress`             | Sampler denoising step                | `value`, `max`, `node`                            |
| `executed`             | Node finished with output             | `node`, `output`, `prompt_id`                     |
| `execution_error`      | Unrecoverable failure                 | `exception_message`, `exception_type`, `prompt_id`|
| `execution_interrupted`| Prompt was cancelled                  | `prompt_id`, `node_id`                            |

**Completion signal:** `executing` event with `data.node === null` and `data.prompt_id` matching the submitted prompt. At that point, `outputs` are available via `GET /history/{prompt_id}`.

Binary frames (sampler preview PNGs) are received during image generation. The provider ignores them — they are not exposed to clients in v1.

---

### 1.3 Authentication

ComfyUI is bound to `127.0.0.1:8188` inside the hardened container on the GPU host. It is **not reachable from the public internet**. ComfyUI has no token-based authentication of its own.

The provider reaches it via an SSH tunnel maintained by the server process:

```
ssh -i ~/.ssh/coderxp_alex -o IdentitiesOnly=yes -N \
    -L 8188:127.0.0.1:8188 dev-alex@31.47.228.14
```

**Security properties:**
- Network isolation (loopback binding + SSH tunnel) is the sole authentication layer.
- The tunnel endpoint is never exposed to app clients, directly or indirectly.
- The provider validates and fills whitelisted parameters into fixed templates before any data reaches ComfyUI — arbitrary graphs from clients are rejected before touching the tunnel.
- No credentials or secrets flow through ComfyUI's HTTP interface.

If the tunnel is down, `POST /prompt` fails with a connection-refused error. The provider surfaces this as `ComfyUnavailableError` and does not queue the job.

---

## 2. Workflow Templates

### 2.1 Policy

The provider maintains **two fixed, server-side workflow graphs** stored under `lib/server/providers/workflows/`. These are read at startup and never reloaded at runtime. Clients submit a whitelisted parameter set; the provider fills those values into the frozen template before submission. **Arbitrary ComfyUI graphs from clients are rejected** at the validation layer and never reach the GPU.

### 2.2 Whitelisted Parameters

| Parameter        | Type    | Image | Video | Constraints                                    |
|------------------|---------|:-----:|:-----:|------------------------------------------------|
| `prompt`         | string  | ✓     | ✓     | Required. max 1 000 chars.                     |
| `negativePrompt` | string  | ✓     | ✓     | Optional. max 1 000 chars.                     |
| `width`          | integer | ✓     | —     | 64–1024, divisible by 8. Default 512.          |
| `height`         | integer | ✓     | —     | 64–1024, divisible by 8. Default 512.          |
| `seed`           | uint32  | ✓     | ✓     | [0, 4 294 967 295]. Default: random.           |
| `steps`          | integer | ✓     | ✓     | Image [1, 30] default 4. Video [1, 50] default 30. |
| `durationFrames` | integer | —     | ✓     | [1, 81]. Default 49 (~3 s @ 16 fps).           |
| `fps`            | integer | —     | ✓     | Default 16.                                    |

Any parameter outside this list, or any value outside the stated range, is a validation error. The job is rejected before any GPU resources are touched.

### 2.3 Template A — Flux1-schnell fp8 (image)

**File:** `lib/server/providers/workflows/flux1-schnell.json`

Uses the Advanced Sampling API (native Flux ComfyUI nodes). Substitution tokens are `__UPPER_SNAKE_CASE__` strings replaced at job-submit time.

```json
{
  "1": {
    "class_type": "UNETLoader",
    "inputs": {
      "unet_name": "flux1-schnell-fp8.safetensors",
      "weight_dtype": "fp8_e4m3fn"
    }
  },
  "2": {
    "class_type": "DualCLIPLoader",
    "inputs": {
      "clip_name1": "t5xxl_fp8_e4m3fn.safetensors",
      "clip_name2": "clip_l.safetensors",
      "type": "flux",
      "device": "default"
    }
  },
  "3": {
    "class_type": "VAELoader",
    "inputs": { "vae_name": "ae.safetensors" }
  },
  "4": {
    "class_type": "CLIPTextEncode",
    "inputs": { "clip": ["2", 0], "text": "__PROMPT__" }
  },
  "5": {
    "class_type": "FluxGuidance",
    "inputs": { "conditioning": ["4", 0], "guidance": 3.5 }
  },
  "6": {
    "class_type": "EmptySD3LatentImage",
    "inputs": { "width": "__WIDTH__", "height": "__HEIGHT__", "batch_size": 1 }
  },
  "7": {
    "class_type": "KSamplerSelect",
    "inputs": { "sampler_name": "euler" }
  },
  "8": {
    "class_type": "BasicScheduler",
    "inputs": {
      "model": ["1", 0],
      "scheduler": "simple",
      "steps": "__STEPS__",
      "denoise": 1.0
    }
  },
  "9": {
    "class_type": "SamplerCustomAdvanced",
    "inputs": {
      "noise":        ["10", 0],
      "guider":       ["11", 0],
      "sampler":      ["7",  0],
      "sigmas":       ["8",  0],
      "latent_image": ["6",  0]
    }
  },
  "10": {
    "class_type": "RandomNoise",
    "inputs": { "noise_seed": "__SEED__" }
  },
  "11": {
    "class_type": "BasicGuider",
    "inputs": { "model": ["1", 0], "conditioning": ["5", 0] }
  },
  "12": {
    "class_type": "VAEDecode",
    "inputs": { "samples": ["9", 0], "vae": ["3", 0] }
  },
  "13": {
    "class_type": "SaveImage",
    "inputs": { "images": ["12", 0], "filename_prefix": "cxp_img" }
  }
}
```

**Required model files** (read-only model store):
- `image/checkpoints/flux1-schnell-fp8.safetensors`
- `image/clip/t5xxl_fp8_e4m3fn.safetensors`
- `image/clip/clip_l.safetensors`
- `image/vae/ae.safetensors`

**Substitution map:**

| Token       | Source field      | Default |
|-------------|-------------------|---------|
| `__PROMPT__`  | `req.prompt`      | — (required) |
| `__WIDTH__`   | `req.width`       | 512 |
| `__HEIGHT__`  | `req.height`      | 512 |
| `__STEPS__`   | `req.steps`       | 4 |
| `__SEED__`    | `req.seed`        | `Math.floor(Math.random() * 4294967295)` |

Negative prompt is not used for Flux-schnell (the model is a flow-matching distilled model and does not use a negative conditioning path). The `negativePrompt` field is accepted by the API for forward-compatibility but silently ignored in the image template.

---

### 2.4 Template B — Wan 2.1 t2v 1.3B fp16 (video)

**File:** `lib/server/providers/workflows/wan21-t2v.json`

```json
{
  "1": {
    "class_type": "WanVideoModelLoader",
    "inputs": {
      "model":           "wan2.1_t2v_1.3B_fp16.safetensors",
      "base_precision":  "fp16",
      "quantization":    "disabled",
      "load_device":     "offload_device",
      "attention_mode":  "sdpa"
    }
  },
  "2": {
    "class_type": "WanVideoT5TextEncoder",
    "inputs": {
      "t5":        "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
      "precision": "bf16"
    }
  },
  "3": {
    "class_type": "WanVideoVAE",
    "inputs": { "vae": "wan_2.1_vae.safetensors" }
  },
  "4": {
    "class_type": "WanVideoTextEncode",
    "inputs": {
      "t5":               ["2", 0],
      "positive_prompt":  "__PROMPT__",
      "negative_prompt":  "__NEGATIVE_PROMPT__",
      "force_offload":    true
    }
  },
  "5": {
    "class_type": "WanVideoEmptyEmbeds",
    "inputs": {
      "width":       832,
      "height":      480,
      "num_frames":  "__DURATION_FRAMES__",
      "batch_size":  1,
      "force_offload": true
    }
  },
  "6": {
    "class_type": "WanVideoSampler",
    "inputs": {
      "model":              ["1", 0],
      "positive":           ["4", 0],
      "negative":           ["4", 1],
      "embeds":             ["5", 0],
      "steps":              "__STEPS__",
      "cfg":                5.0,
      "seed":               "__SEED__",
      "sampler":            "dpmpp_2m",
      "scheduler":          "linear",
      "riflex_freq_index":  0,
      "force_offload":      true
    }
  },
  "7": {
    "class_type": "WanVideoDecoder",
    "inputs": {
      "samples":                    ["6", 0],
      "vae":                        ["3", 0],
      "enable_vae_tiling":          true,
      "tile_sample_min_height":     272,
      "tile_sample_min_width":      272,
      "tile_overlap_factor_height": 0.2,
      "tile_overlap_factor_width":  0.2
    }
  },
  "8": {
    "class_type": "VHS_VideoCombine",
    "inputs": {
      "images":           ["7", 0],
      "frame_rate":       "__FPS__",
      "loop_count":       0,
      "filename_prefix":  "cxp_vid",
      "format":           "video/h264-mp4",
      "pix_fmt":          "yuv420p",
      "crf":              19,
      "save_metadata":    false,
      "pingpong":         false,
      "save_output":      true
    }
  }
}
```

**Required model files:**
- `video/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors`
- `video/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`
- `video/vae/wan_2.1_vae.safetensors`

**Substitution map:**

| Token                | Source field         | Default |
|----------------------|----------------------|---------|
| `__PROMPT__`           | `req.prompt`         | — (required) |
| `__NEGATIVE_PROMPT__`  | `req.negativePrompt` | `""` |
| `__DURATION_FRAMES__`  | `req.durationFrames` | 49 (~3 s @ 16 fps) |
| `__STEPS__`            | `req.steps`          | 30 |
| `__SEED__`             | `req.seed`           | random uint32 |
| `__FPS__`              | `req.fps`            | 16 |

Width and height are **fixed at 832×480** for the 1.3B model in v1 (optimal for the 48 GB VRAM budget at the target frame count). The `width`/`height` fields from `MediaGenerationRequest` are accepted at the API layer but are ignored for video domain requests; this constraint will be revisited when the 14B model is onboarded.

---

## 3. Job Queue

### 3.1 Goals

- **One GPU job at a time.** ComfyUI's internal queue is single-lane; the provider enforces this at the application layer with a serial queue rather than relying on ComfyUI back-pressure.
- **Per-user limit: 1 active or queued job.** A second `submitJob` from the same `userId` while a job is `QUEUED` or `RUNNING` is rejected with a 429-equivalent error.
- **Timeout enforcement independent of ComfyUI.** ComfyUI has no native job timeout; the provider enforces wall-clock limits and issues a cancel on breach.
- **Cancel propagation.** Cancelling a `QUEUED` job removes it from the internal queue without touching ComfyUI. Cancelling a `RUNNING` job sends `POST /queue { "delete": [prompt_id] }`.
- **Polling-friendly status.** All status is readable via `getJobStatus` with no WebSocket requirement on the client side.

### 3.2 Data Model

```typescript
// Internal (extends the public JobRecord)
interface InternalJobRecord extends JobRecord {
  comfyPromptId?: string;   // set after POST /prompt succeeds
  comfyClientId:  string;   // UUID used for WS correlation
  timeoutAt:      number;   // epoch ms; enforced by the serial worker
}
```

State is held in an in-process `Map<jobId, InternalJobRecord>`. On every state transition the map is serialised to `$COMFY_JOB_STORE_PATH` (default: `/tmp/comfy-jobs.json`) so the server can recover queued/running jobs across a restart (though a restart during `RUNNING` transitions the job to `FAILED` since the ComfyUI connection is lost).

### 3.3 IMediaJobService: Method Contracts

#### `submitJob(userId, req): Promise<{ jobId, status }>`

1. **Validate** all whitelisted parameters (range, type, format). Throw `ValidationError` on any violation — reject before touching the GPU.
2. **Per-user guard:** look up any `QUEUED` or `RUNNING` record for `userId`. If found, throw `UserJobLimitError` (HTTP 429 at the route layer).
3. **Compile template** for the domain (`req.modelId` maps to `image` or `video`). Substitute all tokens; deep-copy the template JSON; never mutate the cached template.
4. **Assign** `jobId` (UUID v4), `comfyClientId` (UUID v4), `createdAt` (epoch ms), `timeoutAt`.
5. Write `JobRecord` with `status: "QUEUED"` to the in-process store; persist to disk.
6. **Enqueue** a `QueueEntry` on the internal `SerialQueue`.
7. Return `{ jobId, status: "QUEUED" }` immediately — before execution starts.

#### `SerialQueue` (internal, single consumer)

A single async worker loop that processes one job at a time:

```
loop:
  entry = await queue.dequeue()
  record.status = "RUNNING"; record.startedAt = now()
  persist()
  try:
    response = POST /prompt { prompt: entry.graph, client_id: entry.comfyClientId }
    record.comfyPromptId = response.prompt_id
    persist()
    await runWithTimeout(watchViaWebSocket(entry), record.timeoutAt)
  catch TimeoutError:
    POST /queue { delete: [record.comfyPromptId] }
    record.status = "TIMED_OUT"
    persist()
  catch ExecutionError as e:
    record.status = "FAILED"; record.error = e.message
    persist()
  finally:
    proceed to next entry
```

`watchViaWebSocket(entry)` opens `ws://127.0.0.1:8188/ws?clientId=<entry.comfyClientId>` and resolves on `executing { node: null, prompt_id: matching }`, or rejects on `execution_error` / `execution_interrupted`.

On `executing { node: null }`:
- `record.status = "COMPLETED"`
- `record.completedAt = now()`
- `record.outputFile` = first filename from `GET /history/{prompt_id}` outputs
- persist

#### Timeouts

| Domain | Default | Env override |
|--------|---------|--------------|
| Image (Flux-schnell, 4–30 steps) | 120 s | `COMFY_IMAGE_TIMEOUT_S` |
| Video (Wan 2.1, 1–50 steps, 81 frames max) | 600 s | `COMFY_VIDEO_TIMEOUT_S` |

#### `getJobStatus(userId, jobId): Promise<JobRecord>`

- Look up `jobId` in the store. If not found or `record.userId !== userId`, throw `NotFoundError`.
- Return the `JobRecord` (public fields only — strip `comfyClientId`, `comfyPromptId`, `timeoutAt`).

#### `cancelJob(userId, jobId): Promise<boolean>`

| Current status | Action | Returns |
|----------------|--------|---------|
| `QUEUED` | Remove from internal queue; set `status: "CANCELLED"` | `true` |
| `RUNNING` | `POST /queue { delete: [comfyPromptId] }`; set `status: "CANCELLED"` on `execution_interrupted` WS event | `true` |
| Terminal (`COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`) | No-op | `false` |

If `userId !== record.userId`, throw `NotFoundError`.

#### `getJobArtifact(userId, jobId): Promise<{ stream, mimeType }>`

- Validate `status === "COMPLETED"`. Throw `JobNotCompleteError` otherwise.
- If local cache file exists (see §4), return a `ReadStream` from it.
- Otherwise: `GET /view?filename=<outputFile>&type=output` → pipe the response stream.
- `mimeType`: `"image/png"` for image domain, `"video/mp4"` for video domain.

---

## 4. Output Storage and Retention

### 4.1 ComfyUI Output Directory

ComfyUI writes files to `output/` inside its container. The provider retrieves them via `GET /view` (loopback only) — it does **not** mount or read the container filesystem directly.

### 4.2 Provider-Side Artifact Cache

On the first successful `getJobArtifact` call the provider downloads and stores the artifact at:

```
$COMFY_ARTIFACT_DIR/<jobId>.<ext>
```

`COMFY_ARTIFACT_DIR` defaults to `/tmp/comfy-artifacts`. Extension is `png` (image) or `mp4` (video). Subsequent calls stream from this local file.

### 4.3 Retention Policy

| Trigger | Action |
|---------|--------|
| Job completes | Artifact stored for `COMFY_ARTIFACT_TTL_HOURS` hours (default 24) |
| Job fails or is cancelled | No artifact written |
| TTL elapsed | Sweep deletes local file; `record.outputFile` cleared; `getJobArtifact` returns `ArtifactExpiredError` (HTTP 410) |
| Job store cap exceeded | Oldest terminal records evicted (LRU) when count > `COMFY_MAX_JOB_RECORDS` (default 1 000) |

Background sweep interval: `COMFY_SWEEP_INTERVAL_MINUTES` (default 15).

### 4.4 Artifact Streaming to Client

`getJobArtifact` returns `{ stream: NodeJS.ReadableStream; mimeType: string }`.

The consuming route (app API layer) is expected to:
- Set `Content-Type: <mimeType>`.
- Set `Content-Disposition: attachment; filename=<jobId>.<ext>`.
- Pipe the stream directly to the HTTP response without buffering the entire file in memory.

### 4.5 Logging

Every state transition emits a structured JSON log line to stdout:

```json
{
  "ts":           1716000000000,
  "level":        "info",
  "event":        "job.state_change",
  "jobId":        "...",
  "userId":       "...",
  "domain":       "image",
  "fromStatus":   "QUEUED",
  "toStatus":     "RUNNING",
  "comfyPromptId": "..."
}
```

**Never logged:** prompt text, negative prompt text, or any user-supplied content. Job IDs, status transitions, timing, error codes, and ComfyUI prompt IDs only.

---

## 5. Test Plan

### 5.1 Unit Tests (no server required)

**File:** `scripts/test-provider-comfyui.ts`

All unit tests inject mock HTTP and WebSocket clients via the constructor — no real network, no GPU, no ComfyUI process.

| # | Test description | Pass condition |
|---|-----------------|----------------|
| 1 | `submitJob` — prompt > 1 000 chars | throws `ValidationError` |
| 2 | `submitJob` — width not divisible by 8 | throws `ValidationError` |
| 3 | `submitJob` — width > 1 024 | throws `ValidationError` |
| 4 | `submitJob` — steps = 31 for image domain | throws `ValidationError` |
| 5 | `submitJob` — steps = 51 for video domain | throws `ValidationError` |
| 6 | `submitJob` — durationFrames = 82 | throws `ValidationError` |
| 7 | `submitJob` — second job same userId (one QUEUED) | throws `UserJobLimitError` |
| 8 | `submitJob` — second job same userId (one RUNNING) | throws `UserJobLimitError` |
| 9 | `submitJob` — second job different userId | succeeds (two jobs coexist) |
| 10 | `submitJob` — returns `{ jobId, status: "QUEUED" }` immediately | status is `QUEUED` before worker dequeues |
| 11 | `SerialQueue` — QUEUED → RUNNING on dequeue | `startedAt` is set; ComfyUI `/prompt` called |
| 12 | `SerialQueue` — RUNNING → COMPLETED on WS signal | `executing { node: null }` → `COMPLETED`; `outputFile` populated |
| 13 | `SerialQueue` — RUNNING → FAILED on `execution_error` | `error` field set; status `FAILED` |
| 14 | `SerialQueue` — timeout → TIMED_OUT | fake clock exceeds timeout; `/queue` delete called; status `TIMED_OUT` |
| 15 | `getJobStatus` — unknown jobId | throws `NotFoundError` |
| 16 | `getJobStatus` — userId mismatch | throws `NotFoundError` |
| 17 | `cancelJob` — QUEUED job | removed from queue; no ComfyUI call; status `CANCELLED`; returns `true` |
| 18 | `cancelJob` — RUNNING job | `/queue` delete issued; WS `execution_interrupted` → status `CANCELLED`; returns `true` |
| 19 | `cancelJob` — COMPLETED job | no-op; returns `false` |
| 20 | `getJobArtifact` — COMPLETED job | streams bytes; mimeType `image/png` or `video/mp4` |
| 21 | `getJobArtifact` — FAILED job | throws `JobNotCompleteError` |
| 22 | `getJobArtifact` — past TTL | throws `ArtifactExpiredError` |
| 23 | Template compile — image tokens substituted | compiled JSON matches expected snapshot |
| 24 | Template compile — video tokens substituted | compiled JSON matches expected snapshot |
| 25 | Template compile — unknown model ID rejected | throws `ValidationError` |
| 26 | Sweep — deletes artifact file past TTL | file removed; `outputFile` cleared |
| 27 | Sweep — evicts oldest records past cap | record evicted; newer records retained |

### 5.2 Integration Test (requires live ComfyUI)

**File:** `scripts/test-comfyui-integration.ts`

Auto-skipped when `COMFYUI_URL` is not set:

```typescript
if (!process.env.COMFYUI_URL) {
  console.log("COMFYUI_URL not set — skipping ComfyUI integration tests");
  process.exit(0);
}
```

Run locally with the SSH tunnel active:
```bash
COMFYUI_URL=http://127.0.0.1:8188 npx tsx scripts/test-comfyui-integration.ts
```

**Scenarios:**

| # | Scenario | What it verifies |
|---|----------|-----------------|
| 1 | Connectivity check | `GET /queue` returns HTTP 200 |
| 2 | Image job round-trip | Submit 512×512 Flux-schnell, 4 steps, fixed seed; poll until `COMPLETED` or timeout; `getJobArtifact` yields > 0 bytes, MIME `image/png` |
| 3 | Cancel running job | Submit image job; immediately `cancelJob`; status eventually `CANCELLED` |
| 4 | Per-user limit | Submit two image jobs for the same userId in rapid succession; second rejected with `UserJobLimitError` |

The integration test writes no files outside `COMFY_ARTIFACT_DIR`, requires no `sudo` or elevated permissions, and does not modify any model files or ComfyUI configuration.

---

## Open Questions for Klaus

1. **Wan 2.1 ComfyUI nodes:** Are the `WanVideoModelLoader`, `WanVideoT5TextEncoder`, `WanVideoVAE`, `WanVideoTextEncode`, `WanVideoEmptyEmbeds`, `WanVideoSampler`, `WanVideoDecoder` custom nodes already installed in the v0.36.0 container? If not, which custom node package provides them?
2. **VHS_VideoCombine:** Is `comfyanonymous/ComfyUI-VideoHelperSuite` (the VHS pack) installed and accessible for mp4 output? Fallback: save individual frames and zip them.
3. **Model store paths:** The design assumes `image/checkpoints/`, `image/clip/`, `image/vae/`, `video/diffusion_models/`, `video/text_encoders/`, `video/vae/` under `/srv/projects/coderxp/models`. Confirm these map to ComfyUI's `model_paths` config.
4. **SSH tunnel lifecycle:** Who owns the tunnel process? Should the provider start it on init, or is it a separate service-level concern managed by the host setup?

---

## Appendix — Key Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `COMFYUI_URL` | — | Base URL of ComfyUI (e.g. `http://127.0.0.1:8188`). Required at runtime; absence skips integration tests. |
| `COMFY_IMAGE_TIMEOUT_S` | `120` | Wall-clock timeout for image jobs (seconds) |
| `COMFY_VIDEO_TIMEOUT_S` | `600` | Wall-clock timeout for video jobs (seconds) |
| `COMFY_ARTIFACT_DIR` | `/tmp/comfy-artifacts` | Local artifact cache directory |
| `COMFY_ARTIFACT_TTL_HOURS` | `24` | Artifact retention window |
| `COMFY_MAX_JOB_RECORDS` | `1000` | Maximum job records before LRU eviction |
| `COMFY_SWEEP_INTERVAL_MINUTES` | `15` | Background sweep cadence |
| `COMFY_JOB_STORE_PATH` | `/tmp/comfy-jobs.json` | Crash-recovery job store path |
