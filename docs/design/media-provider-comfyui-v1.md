# ComfyUI Media Provider — Design v1.1

**Status:** Draft for review  
**Branch:** `feat/media-provider-v1.1`  
**Author:** Hartmann <jp@coderxp.pro>  
**Department:** GPU/Media stream  
**Accountable:** Klaus Hoffmann  
**Date:** 2026-09-24  
**Implements:** `IMediaJobService` from `lib/server/providers/types.ts` (`IMediaJobService:70-75`, `MediaGenerationRequest:37-47`, `JobRecord:51-62`, `JobStatus:49`, introduced in PR #4 (head 52cf941), pending merge)  
**Supersedes:** PR #5 (`feat/media-provider-design`)

---

## Overview

This document specifies the design for `ComfyUiMediaJobService`, the concrete implementation of `IMediaJobService` that drives image and video generation through the local ComfyUI v0.36.0 instance on the GPU host. The text-provider layer (PR #4) is not touched here — this service builds alongside it, implementing the same provider-layer interfaces for the `media` domain.

**Baseline status:** The interfaces `IMediaJobService` (`lib/server/providers/types.ts:70-75`), `MediaGenerationRequest` (`lib/server/providers/types.ts:37-47`), and `JobRecord` (`lib/server/providers/types.ts:51-62`) were introduced in PR #4 (head 52cf941), pending merge into `main`. The implementation PR must not be opened until PR #4 has been merged into `main`.

**What this is NOT:** implementation code. This PR contains only the design document. The implementation PR follows after design review and PR #4 merge.

**Node constraint:** ComfyUI v0.36.0, hardened container, **native nodes only**. No custom nodes will ever be installed (no WanVideoWrapper, no VideoHelperSuite, no ComfyUI-Manager). The workflow templates in §2 use only nodes available in a stock ComfyUI v0.36.0 installation.

**Runtime assumption:** Node.js ≥ 22. Built-in `fetch` (WHATWG Fetch API) and built-in `WebSocket` are used for all HTTP and WebSocket communication with ComfyUI. No new npm packages are added.

---

## 1. ComfyUI API Surface

ComfyUI v0.36.0 exposes an HTTP + WebSocket API on `127.0.0.1:8188` (loopback only — see §1.3).

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
        "images": [
          { "filename": "cxp_img_00001_.png", "subfolder": "", "type": "output" }
        ]
      }
    },
    "status": { "status_str": "success", "completed": true }
  }
}
```

*Output parsing rule (no hardcoded keys):* Native ComfyUI v0.36.0 nodes (`SaveImage`, `SaveAnimatedWEBP`, and `SaveVideo`) all report their generated output files inside the `outputs` object under array-valued entries (native animated WebP and native MP4 SaveVideo both report under `"images"`, with WebP carrying `"animated": [true]`; custom keys like `"gifs"` are produced by custom nodes such as VideoHelperSuite, which are not installed).  
To remain resilient and fail-safe, the provider **iterates over all output nodes and all array-valued keys in `outputs`**, filters entries where `"type": "output"`, and captures both `filename` and `subfolder` for retrieval via `GET /view?filename=<filename>&subfolder=<subfolder>&type=output`. No output key name is hardcoded.  
Furthermore, `mimeType` is **derived directly from the returned file extension** (`.png` → `image/png`, `.webp` → `image/webp`, `.mp4` → `video/mp4`), rather than inferred from the startup node probe.

The provider uses this as a fallback poll when the WebSocket connection drops. Primary completion detection is via WebSocket.

---

#### `GET /view` — Retrieve output artifact

Downloads a generated file by name.

| Parameter   | Required | Description |
|-------------|----------|-------------|
| `filename`  | ✓        | File name from the history outputs |
| `subfolder` |          | Subdirectory inside type folder (carried from history entry) |
| `type`      |          | `input` / `temp` / `output` (default: `output`) |

Returns raw bytes with the appropriate `Content-Type` derived from the artifact's extension (`image/png`, `image/webp`, or `video/mp4`). The provider always uses `type=output` and passes `subfolder` if present.

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

#### `GET /object_info` — Node availability

Called once at startup to discover which native output nodes are available in this ComfyUI build. Used to select the video output node at integration time (see §2.4).

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

| Event type              | When                                 | Key fields in `data`                               |
|-------------------------|--------------------------------------|----------------------------------------------------|
| `status`                | Queue depth changes                  | `status.exec_info.queue_remaining`                 |
| `execution_start`       | Workflow begins executing            | `prompt_id`                                        |
| `execution_cached`      | Node skipped (result cached)         | `nodes`, `prompt_id`                               |
| `executing`             | A node starts; or workflow finishes  | `node` (null = done), `prompt_id`                  |
| `progress`              | Sampler denoising step               | `value`, `max`, `node`                             |
| `executed`              | Node finished with output            | `node`, `output`, `prompt_id`                      |
| `execution_error`       | Unrecoverable failure                | `exception_message`, `exception_type`, `prompt_id` |
| `execution_interrupted` | Prompt was cancelled                 | `prompt_id`, `node_id`                             |

**Completion signal:** `executing` event with `data.node === null` and `data.prompt_id` matching the submitted prompt. At that point, `outputs` are available via `GET /history/{prompt_id}`.

Binary frames (sampler preview PNGs) are received during image generation. The provider ignores them — they are not exposed to clients in v1.

---

### 1.3 Connectivity

The provider reads `COMFYUI_URL` (e.g. `http://127.0.0.1:8188`) and knows nothing about SSH tunnels or key paths. Tunnel setup is an infrastructure concern, not a provider concern.

- **dev:** SSH tunnel to loopback; prod: loopback, set by host configuration.
- The provider's only network dependency is that `COMFYUI_URL` is reachable when a job is submitted.
- If the URL is unreachable, `POST /prompt` fails with a connection error. The provider surfaces this as `ComfyUnavailableError` and does not queue the job.
- No credentials or secrets flow through ComfyUI's HTTP interface.
- The provider validates and fills whitelisted parameters into fixed templates before any data reaches ComfyUI — arbitrary graphs from clients are rejected before the network call.

---

## 2. Workflow Templates

### 2.1 Policy

The provider maintains **two fixed, server-side workflow graphs** stored under `lib/server/providers/workflows/`. These are read at startup and never reloaded at runtime. Clients submit a whitelisted parameter set; the provider fills those values into the frozen template before submission. **Arbitrary ComfyUI graphs from clients are rejected** at the validation layer and never reach the GPU.

### 2.2 Whitelisted Parameters

| Parameter        | Type    | Image | Video | Constraints                                     |
|------------------|---------|:-----:|:-----:|-------------------------------------------------|
| `prompt`         | string  | ✓     | ✓     | Required. max 1 000 chars.                      |
| `negativePrompt` | string  | ✓     | ✓     | Optional. max 1 000 chars.                      |
| `width`          | integer | ✓     | ✓     | Image: 64–1024, divisible by 8 (required by `MediaGenerationRequest`). Video: must be exactly 832 (fail closed with `ValidationError` otherwise). |
| `height`         | integer | ✓     | ✓     | Image: 64–1024, divisible by 8 (required by `MediaGenerationRequest`). Video: must be exactly 480 (fail closed with `ValidationError` otherwise). |
| `seed`           | uint32  | ✓     | ✓     | [0, 4 294 967 295]. Default: random.            |
| `steps`          | integer | ✓     | ✓     | Image [1, 30] default 4. Video [1, 50] default 30. |
| `durationFrames` | integer | —     | ✓     | [1, 81], strictly of the form 4n+1 (1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53, 57, 61, 65, 69, 73, 77, 81). Default 49 (~3 s @ 16 fps). Any value where `(frames - 1) % 4 !== 0` throws `ValidationError`. |
| `fps`            | integer | —     | ✓     | [1, 30]. Default 16.                            |

**Fail-closed parameter validation rules:**
- Any parameter outside this list, or any value outside the stated range or step constraint, is a `ValidationError`. The job is rejected before any GPU resources are touched.
- **Fail closed on ignored fields (House Rule):** User inputs are never silently ignored.
  - **Video dimensions:** For video requests, if `width` is supplied and `width !== 832`, or `height` is supplied and `height !== 480`, the provider rejects the request with `ValidationError("Wan 2.1 1.3B video model requires width=832 and height=480")`. Dimensions other than 832×480 are never silently ignored or coerced.
  - **Image dimensions:** For image requests, `width` and `height` are strictly required fields on `MediaGenerationRequest` (`types.ts:41-42`); the provider does not provide default dimensions. Any defaulting (e.g. 512×512) must be performed upstream at the API/route layer before invoking `submitJob`.
- **Temporal frame grouping (`durationFrames`):** `EmptyHunyuanLatentVideo` works in latent frame groups of 4. Supplying a frame count that does not satisfy `(durationFrames - 1) % 4 === 0` causes the underlying node to silently floor the frame count, resulting in fewer generated frames than the user requested. To prevent silent truncation, the provider strictly validates that `durationFrames` is of the form $4n+1$; any non-compliant integer (e.g. 50, 82) throws `ValidationError`.

### 2.3 Template A — Flux1-schnell fp8 (image)

**File:** `lib/server/providers/workflows/flux1-schnell.json`

Uses `CheckpointLoaderSimple` to load the all-in-one `flux1-schnell-fp8.safetensors` file (provides MODEL, CLIP, and VAE outputs in one node). Substitution tokens are `__UPPER_SNAKE_CASE__` strings replaced at job-submit time.

```json
{
  "1": {
    "class_type": "CheckpointLoaderSimple",
    "inputs": {
      "ckpt_name": "flux1-schnell-fp8.safetensors"
    }
  },
  "2": {
    "class_type": "CLIPTextEncode",
    "inputs": {
      "clip": ["1", 1],
      "text": "__PROMPT__"
    }
  },
  "3": {
    "class_type": "CLIPTextEncode",
    "inputs": {
      "clip": ["1", 1],
      "text": ""
    }
  },
  "4": {
    "class_type": "EmptyLatentImage",
    "inputs": {
      "width": "__WIDTH__",
      "height": "__HEIGHT__",
      "batch_size": 1
    }
  },
  "5": {
    "class_type": "KSampler",
    "inputs": {
      "model": ["1", 0],
      "positive": ["2", 0],
      "negative": ["3", 0],
      "latent_image": ["4", 0],
      "seed": "__SEED__",
      "steps": "__STEPS__",
      "cfg": 1.0,
      "sampler_name": "euler",
      "scheduler": "simple",
      "denoise": 1.0
    }
  },
  "6": {
    "class_type": "VAEDecode",
    "inputs": {
      "samples": ["5", 0],
      "vae": ["1", 2]
    }
  },
  "7": {
    "class_type": "SaveImage",
    "inputs": {
      "images": ["6", 0],
      "filename_prefix": "cxp_img"
    }
  }
}
```

**Required model file** (ComfyUI standard folder, read-only):
- `checkpoints/flux1-schnell-fp8.safetensors`

**Substitution map:**

| Token         | Source field  | Default |
|---------------|---------------|---------|
| `__PROMPT__`  | `req.prompt`  | — (required) |
| `__WIDTH__`   | `req.width`   | — (required in `MediaGenerationRequest`) |
| `__HEIGHT__`  | `req.height`  | — (required in `MediaGenerationRequest`) |
| `__STEPS__`   | `req.steps`   | 4 |
| `__SEED__`    | `req.seed`    | `Math.floor(Math.random() * 4294967295)` |

Node 3 is a fixed empty-string negative conditioning. The `negativePrompt` field is accepted by the API for forward-compatibility but silently ignored in the image template — Flux-schnell is a flow-matching distilled model without a conventional negative conditioning path.

---

### 2.4 Template B — Wan 2.1 t2v 1.3B fp16 (video)

**File:** `lib/server/providers/workflows/wan21-t2v.json`

Uses only native ComfyUI v0.36.0 nodes, following the official Wan 2.1 t2v example. No custom nodes are required or permitted.

```json
{
  "1": {
    "class_type": "UNETLoader",
    "inputs": {
      "unet_name": "wan2.1_t2v_1.3B_fp16.safetensors",
      "weight_dtype": "default"
    }
  },
  "2": {
    "class_type": "ModelSamplingSD3",
    "inputs": {
      "model": ["1", 0],
      "shift": 8.0
    }
  },
  "3": {
    "class_type": "CLIPLoader",
    "inputs": {
      "clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
      "type": "wan"
    }
  },
  "4": {
    "class_type": "VAELoader",
    "inputs": {
      "vae_name": "wan_2.1_vae.safetensors"
    }
  },
  "5": {
    "class_type": "CLIPTextEncode",
    "inputs": {
      "clip": ["3", 0],
      "text": "__PROMPT__"
    }
  },
  "6": {
    "class_type": "CLIPTextEncode",
    "inputs": {
      "clip": ["3", 0],
      "text": "__NEGATIVE_PROMPT__"
    }
  },
  "7": {
    "class_type": "EmptyHunyuanLatentVideo",
    "inputs": {
      "width": 832,
      "height": 480,
      "length": "__DURATION_FRAMES__",
      "batch_size": 1
    }
  },
  "8": {
    "class_type": "KSampler",
    "inputs": {
      "model": ["2", 0],
      "positive": ["5", 0],
      "negative": ["6", 0],
      "latent_image": ["7", 0],
      "seed": "__SEED__",
      "steps": "__STEPS__",
      "cfg": 6.0,
      "sampler_name": "uni_pc",
      "scheduler": "simple",
      "denoise": 1.0
    }
  },
  "9": {
    "class_type": "VAEDecode",
    "inputs": {
      "samples": ["8", 0],
      "vae": ["4", 0]
    }
  },
  "10": {
    "class_type": "CreateVideo",
    "inputs": {
      "images": ["9", 0],
      "fps": "__FPS__"
    }
  },
  "11": {
    "class_type": "SaveVideo",
    "inputs": {
      "video": ["10", 0],
      "filename_prefix": "cxp_vid",
      "format": "auto",
      "codec": "auto"
    }
  }
}
```

**Video output node selection (MP4 primary with WebP fallback):**  
At startup, `GET /object_info` is queried on ComfyUI to discover available node types:
- **Primary path (MP4):** When `CreateVideo` and `SaveVideo` are registered in the target ComfyUI build (as verified on the Blackwell GPU server running ComfyUI v0.36.0), node 9 (`VAEDecode`) feeds node 10 (`CreateVideo`), which feeds node 11 (`SaveVideo`) producing an MP4 video container (`video/mp4`).
- **Fallback path (Animated WebP):** If `CreateVideo` or `SaveVideo` is absent in older or minimal ComfyUI builds, node 10 falls back to native `SaveAnimatedWEBP`:
  ```json
  "10": {
    "class_type": "SaveAnimatedWEBP",
    "inputs": {
      "images": ["9", 0],
      "filename_prefix": "cxp_vid",
      "fps": "__FPS__",
      "lossless": false,
      "quality": 80,
      "method": "default"
    }
  }
  ```
  In fallback mode, node 9 connects directly to `SaveAnimatedWEBP` emitting an animated WebP file (`image/webp`). The integration test (§5.2) verifies which path is active.

**Note on `SaveVideo` validation and smoke testing:**  
While `CreateVideo` and `SaveVideo` are registered native nodes in ComfyUI v0.36.0, `SaveVideo` has not been previously executed on our host (earlier host smoke tests exercised `SaveAnimatedWEBP`). The smoke test script (`scripts/comfyui-smoke.sh`) in the implementation PR must run the real MP4 path through the tunnel, and the implementation PR body must show the resulting `.mp4` filename from `/history`. If `SaveVideo` fails validation upstream in ComfyUI for any reason, the service captures and surfaces the exact `node_errors` payload from ComfyUI rather than silently falling back.

**Required model files** (ComfyUI standard folders, read-only):
- `diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors`
- `text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`
- `vae/wan_2.1_vae.safetensors`

**Substitution map:**

| Token                  | Source field         | Default |
|------------------------|----------------------|---------|
| `__PROMPT__`           | `req.prompt`         | — (required) |
| `__NEGATIVE_PROMPT__`  | `req.negativePrompt` | `""` |
| `__DURATION_FRAMES__`  | `req.durationFrames` | 49 (~3 s @ 16 fps, form 4n+1) |
| `__STEPS__`            | `req.steps`          | 30 |
| `__SEED__`             | `req.seed`           | random uint32 |
| `__FPS__`              | `req.fps`            | 16 |

Width and height are **fixed at 832×480** for the Wan 2.1 1.3B model in v1 (optimal for the VRAM budget at the target frame count). If `req.width` or `req.height` is provided with any value other than 832 and 480 respectively, `submitJob` fails closed and throws a `ValidationError("Wan 2.1 1.3B video model requires width=832 and height=480")`. User dimensions are never silently ignored or coerced.

---

## 3. Job Queue

### 3.1 Goals

- **One GPU job at a time.** ComfyUI's internal queue is single-lane; the provider enforces this at the application layer with a serial queue rather than relying on ComfyUI back-pressure.
- **Per-user limit: 1 active or queued job.** A second `submitJob` from the same `userId` while a job is `QUEUED` or `RUNNING` is rejected with a 429-equivalent error.
- **Timeout enforcement independent of ComfyUI.** ComfyUI has no native job timeout; the provider enforces wall-clock limits and issues a cancel on breach.
- **Cancel propagation.** Cancelling a `QUEUED` job removes it from the internal queue without touching ComfyUI. Cancelling a `RUNNING` job sends `POST /queue { "delete": [prompt_id] }`.
- **Polling-friendly status.** All status is readable via `getJobStatus` with no WebSocket requirement on the client side.

### 3.2 Data Model & Durability

```typescript
// Internal (extends the public JobRecord)
interface InternalJobRecord extends JobRecord {
  comfyPromptId?: string;   // set after POST /prompt succeeds
  comfyClientId:  string;   // UUID used for WS correlation
  timeoutAt:      number;   // epoch ms; enforced by the serial worker
}
```

State is held in an in-process `Map<jobId, InternalJobRecord>`. On every state transition, an event line is **appended** to `$COMFY_DATA_DIR/jobs.jsonl` (the append-only job store). Each line is a self-contained JSON object:

```json
{ "ts": 1716000000000, "jobId": "...", "status": "RUNNING", "comfyPromptId": "...", "startedAt": 1716000000000 }
```

`COMFY_DATA_DIR` has **no default**. The provider fails at startup if this variable is unset or if the directory is not writable. No `/tmp` paths are used anywhere in this service.

#### Startup Replay and Restart Recovery
On startup, the provider reads `$COMFY_DATA_DIR/jobs.jsonl` line by line, applying each event sequentially to reconstruct the in-process map. A partially written last line (from a host or process crash mid-write) is detected by failed `JSON.parse` and discarded — the previous complete line's state is preserved, ensuring crash durability.

**Orphaned job cleanup (Restart Recovery):**  
If a replayed record remains in `RUNNING` status from a previous process termination:
1. If `record.comfyPromptId` is known, the provider immediately sends:
   ```json
   POST /queue { "delete": [record.comfyPromptId] }
   ```
   to ComfyUI before updating status. This cancellation prevents an orphaned prompt from continuing to monopolize the single GPU lane on the host with a job whose client connection is gone.
2. The record is then transitioned to `FAILED` with `error: "Service restarted while job was running"`, and the state transition is recorded in the map.

#### `jobs.jsonl` File Compaction
Because the append-only event log would otherwise grow indefinitely over time, the provider implements atomic file compaction:
1. **Startup compaction:** After completing replay and executing restart recovery cancellations, the provider rewrites the job store atomically:
   - Writes all surviving records from the in-memory map (one consolidated JSON line per surviving record) to a temporary file:
     ```
     $COMFY_DATA_DIR/jobs.jsonl.tmp
     ```
   - Calls `fsync` on the file descriptor to ensure durability.
   - Atomically renames `jobs.jsonl.tmp` over `$COMFY_DATA_DIR/jobs.jsonl`.
2. **Periodic compaction on retention sweep:** When background sweeps evict terminal records exceeding `COMFY_MAX_JOB_RECORDS` (default 1,000) or purge expired artifacts, compaction is executed via the same atomic write-and-rename mechanism, keeping physical disk usage strictly bounded.

### 3.3 IMediaJobService: Method Contracts

#### `submitJob(userId, req): Promise<{ jobId, status }>`

1. **Validate** all whitelisted parameters (range, type, format). Throw `ValidationError` on any violation — reject before touching the GPU.
2. **Per-user guard:** look up any `QUEUED` or `RUNNING` record for `userId`. If found, throw `UserJobLimitError` (HTTP 429 at the route layer).
3. **Compile template** for the domain (`req.modelId` maps to `image` or `video`). Substitute all tokens; deep-copy the template JSON; never mutate the cached template.
4. **Assign** `jobId` (UUID v4), `comfyClientId` (UUID v4), `createdAt` (epoch ms), `timeoutAt`.
5. Write `JobRecord` with `status: "QUEUED"` event to the JSONL store; update in-process map.
6. **Enqueue** a `QueueEntry` on the internal `SerialQueue`.
7. Return `{ jobId, status: "QUEUED" }` immediately — before execution starts.

#### `SerialQueue` (internal, single consumer)

A single async worker loop that processes one job at a time:

```
loop:
  entry = await queue.dequeue()
  append { status: "RUNNING", startedAt: now() } to jobs.jsonl; update map
  try:
    response = POST /prompt { prompt: entry.graph, client_id: entry.comfyClientId }
    record.comfyPromptId = response.prompt_id
    append { comfyPromptId: response.prompt_id } to jobs.jsonl; update map
    await runWithTimeout(watchViaWebSocket(entry), record.timeoutAt)
  catch TimeoutError:
    POST /queue { delete: [record.comfyPromptId] }
    append { status: "TIMED_OUT" } to jobs.jsonl; update map
  catch ExecutionError as e:
    append { status: "FAILED", error: e.message } to jobs.jsonl; update map
  finally:
    proceed to next entry
```

`watchViaWebSocket(entry)` opens `ws://<COMFYUI_URL>/ws?clientId=<entry.comfyClientId>` and resolves on `executing { node: null, prompt_id: matching }`, or rejects on `execution_error` / `execution_interrupted`.

On `executing { node: null }`:
- Append `{ status: "COMPLETED", completedAt: now(), outputFile: "<filename>" }` to jobs.jsonl; update map
- `outputFile` is the first filename from `GET /history/{prompt_id}` outputs

#### Timeouts

| Domain | Default | Env override |
|--------|---------|--------------|
| Image (Flux-schnell, 4–30 steps) | 120 s | `COMFY_IMAGE_TIMEOUT_S` |
| Video (Wan 2.1, 1–50 steps, 81 frames max) | 600 s | `COMFY_VIDEO_TIMEOUT_S` |

#### `getJobStatus(userId, jobId): Promise<JobRecord>`

- Look up `jobId` in the in-process map. If not found or `record.userId !== userId`, throw `NotFoundError`.
- Return the `JobRecord` (public fields only — strip `comfyClientId`, `comfyPromptId`, `timeoutAt`).

#### `cancelJob(userId, jobId): Promise<boolean>`

| Current status | Action | Returns |
|----------------|--------|---------|
| `QUEUED` | Remove from internal queue; append `{ status: "CANCELLED" }` to jobs.jsonl | `true` |
| `RUNNING` | `POST /queue { delete: [comfyPromptId] }`; append `{ status: "CANCELLED" }` on `execution_interrupted` WS event | `true` |
| Terminal (`COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`) | No-op | `false` |

If `userId !== record.userId`, throw `NotFoundError`.

#### `getJobArtifact(userId, jobId): Promise<{ stream, mimeType }>`

- Validate `status === "COMPLETED"`. Throw `JobNotCompleteError` otherwise.
- If local cache file exists at `$COMFY_DATA_DIR/artifacts/<jobId>.<ext>`, return a `ReadStream` from it.
- Otherwise: `GET /view?filename=<filename>&subfolder=<subfolder>&type=output` (using the `filename` and `subfolder` recorded from history outputs) → pipe the response stream into local cache file and client.
- `mimeType`: derived directly from the `outputFile` extension (`.png` → `"image/png"`, `.mp4` → `"video/mp4"`, `.webp` → `"image/webp"`), never hardcoded or coupled to startup probe.

---

## 4. Output Storage and Retention

### 4.1 ComfyUI Output Directory

ComfyUI writes files to `output/` inside its container. The provider retrieves them via `GET /view` (loopback only) — it does **not** mount or read the container filesystem directly.

### 4.2 Provider-Side Artifact Cache

`COMFY_DATA_DIR` is the single data root for the service. It has **no default** and the provider fails at startup if it is unset or not writable.

On the first successful `getJobArtifact` call the provider downloads and stores the artifact at:

```
$COMFY_DATA_DIR/artifacts/<jobId>.<ext>
```

Extension is `png` (image) or `webp`/`mp4` (video, matching the output node). Subsequent calls stream from this local file. The job JSONL store is at `$COMFY_DATA_DIR/jobs.jsonl`.

### 4.3 Retention Policy

| Trigger | Action |
|---------|--------|
| Job completes | Artifact stored for `COMFY_ARTIFACT_TTL_HOURS` hours (default 24) |
| Job fails or is cancelled | No artifact written |
| TTL elapsed | Sweep deletes local file; `outputFile` cleared in map and jobs.jsonl; `getJobArtifact` returns `ArtifactExpiredError` (HTTP 410) |
| Byte cap exceeded | Oldest artifacts deleted first (oldest-first by `completedAt`) until total bytes under `COMFY_ARTIFACT_MAX_BYTES` (default 20 GB). Checked on every sweep. |
| Record cap exceeded | Oldest terminal records evicted (LRU by `createdAt`) when count > `COMFY_MAX_JOB_RECORDS` (default 1 000). Atomic file compaction (`jobs.jsonl.tmp` → `jobs.jsonl`) runs immediately to reclaim disk space. |

Background sweep interval: `COMFY_SWEEP_INTERVAL_MINUTES` (default 15).

**Eviction order for byte cap:** oldest-first by `completedAt`. Eviction stops as soon as total bytes drop below `COMFY_ARTIFACT_MAX_BYTES`. Eviction of a record's artifact file is followed by appending a `{ status: "ARTIFACT_EVICTED" }` event to `jobs.jsonl`, followed by atomic compaction when records are pruned.

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
  "ts":            1716000000000,
  "level":         "info",
  "event":         "job.state_change",
  "jobId":         "...",
  "userId":        "...",
  "domain":        "image",
  "fromStatus":    "QUEUED",
  "toStatus":      "RUNNING",
  "comfyPromptId": "..."
}
```

**Never logged:** prompt text, negative prompt text, or any user-supplied content. Job IDs, status transitions, timing, error codes, and ComfyUI prompt IDs only.

---

## 5. Test Plan

### 5.1 Unit Tests (no server required)

**File:** `scripts/test-provider-comfyui.ts`

All unit tests inject mock HTTP and WebSocket clients via the constructor — no real network, no GPU, no ComfyUI process. Mocked clients use Node.js built-in fetch and WebSocket interfaces (Node ≥ 22).

| # | Test description | Pass condition |
|---|-----------------|----------------|
| 1 | `submitJob` — prompt > 1 000 chars | throws `ValidationError` |
| 2 | `submitJob` — image width not divisible by 8 | throws `ValidationError` |
| 3 | `submitJob` — image width > 1 024 | throws `ValidationError` |
| 4 | `submitJob` — steps = 31 for image domain | throws `ValidationError` |
| 5 | `submitJob` — steps = 51 for video domain | throws `ValidationError` |
| 6 | `submitJob` — video durationFrames not 4n+1 (e.g. 50 or 82) | throws `ValidationError` |
| 7 | `submitJob` — video width/height !== 832×480 | throws `ValidationError` |
| 8 | `submitJob` — fps outside [1, 30] (e.g. 0 or 31) | throws `ValidationError` |
| 9 | `submitJob` — second job same userId (one QUEUED) | throws `UserJobLimitError` |
| 10 | `submitJob` — second job same userId (one RUNNING) | throws `UserJobLimitError` |
| 11 | `submitJob` — second job different userId | succeeds (two jobs coexist) |
| 12 | `submitJob` — returns `{ jobId, status: "QUEUED" }` immediately | status is `QUEUED` before worker dequeues |
| 13 | `SerialQueue` — QUEUED → RUNNING on dequeue | `startedAt` is set; ComfyUI `/prompt` called |
| 14 | `SerialQueue` — RUNNING → COMPLETED on WS signal | `executing { node: null }` → `COMPLETED`; `outputFile` populated |
| 15 | `SerialQueue` — RUNNING → FAILED on `execution_error` | `error` field set; status `FAILED` |
| 16 | `SerialQueue` — timeout → TIMED_OUT | fake clock exceeds timeout; `/queue` delete called; status `TIMED_OUT` |
| 17 | `getJobStatus` — unknown jobId | throws `NotFoundError` |
| 18 | `getJobStatus` — userId mismatch | throws `NotFoundError` |
| 19 | `cancelJob` — QUEUED job | removed from queue; no ComfyUI call; status `CANCELLED`; returns `true` |
| 20 | `cancelJob` — RUNNING job | `/queue` delete issued; WS `execution_interrupted` → status `CANCELLED`; returns `true` |
| 21 | `cancelJob` — COMPLETED job | no-op; returns `false` |
| 22 | `getJobArtifact` — COMPLETED job | streams bytes; mimeType derived from extension (`image/png`, `video/mp4`, `image/webp`) |
| 23 | `getJobArtifact` — FAILED job | throws `JobNotCompleteError` |
| 24 | `getJobArtifact` — past TTL | throws `ArtifactExpiredError` |
| 25 | Template compile — image tokens substituted | compiled JSON matches snapshot: `CheckpointLoaderSimple` on `flux1-schnell-fp8.safetensors`; node 5 is `KSampler` with `cfg=1.0`, `sampler_name=euler`, `scheduler=simple`; node 7 is `SaveImage` |
| 26 | Template compile — video tokens substituted | compiled JSON matches snapshot: node 1 `UNETLoader` → node 2 `ModelSamplingSD3 shift=8.0` → node 3 `CLIPLoader type=wan` → nodes 5/6 `CLIPTextEncode` → node 7 `EmptyHunyuanLatentVideo 832×480` → node 8 `KSampler cfg=6.0 uni_pc` → node 9 `VAEDecode` → node 10 `CreateVideo` → node 11 `SaveVideo` (or fallback node 10 `SaveAnimatedWEBP`) |
| 27 | Template compile — unknown model ID rejected | throws `ValidationError` |
| 28 | Sweep — deletes artifact file past TTL | file removed; `outputFile` cleared |
| 29 | Sweep — evicts oldest artifacts when byte cap exceeded | oldest artifact by `completedAt` deleted first; total bytes drop below `COMFY_ARTIFACT_MAX_BYTES` |
| 30 | Restart recovery — orphaned RUNNING prompt cancelled | sends `POST /queue { delete: [promptId] }`, transitions to `FAILED`, and rewrites `jobs.jsonl` atomically via `.tmp` rename |
| 31 | Log compaction — atomic rewrite on startup and prune | `jobs.jsonl.tmp` written and renamed atomically over `jobs.jsonl` with surviving records |

### 5.2 Integration Test (requires live ComfyUI)

**File:** `scripts/test-comfyui-integration.ts`

Auto-skipped when `COMFYUI_URL` is not set:

```typescript
if (!process.env.COMFYUI_URL) {
  console.log("COMFYUI_URL not set — skipping ComfyUI integration tests");
  process.exit(0);
}
```

Run locally with the tunnel active (or on-host against loopback):
```bash
COMFYUI_URL=http://127.0.0.1:8188 COMFY_DATA_DIR=/var/lib/comfy-test \
  npx tsx scripts/test-comfyui-integration.ts
```

**Scenarios:**

| # | Scenario | What it verifies |
|---|----------|-----------------|
| 1 | Connectivity check | `GET /queue` returns HTTP 200; `GET /object_info` reveals available output nodes; video output path (SaveVideo vs SaveAnimatedWEBP) confirmed |
| 2 | Image job round-trip | Submit 512×512 Flux-schnell, 4 steps, fixed seed; poll until `COMPLETED` or timeout; `getJobArtifact` yields > 0 bytes, MIME `image/png` |
| 3 | Cancel running job | Submit image job; immediately `cancelJob`; status eventually `CANCELLED` |
| 4 | Per-user limit | Submit two image jobs for the same userId in rapid succession; second rejected with `UserJobLimitError` |

The integration test writes no files outside `COMFY_DATA_DIR`, requires no `sudo` or elevated permissions, and does not modify any model files or ComfyUI configuration.

---

## Appendix — Key Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `COMFYUI_URL` | — | Base URL of ComfyUI (e.g. `http://127.0.0.1:8188`). Required at runtime; absence skips integration tests. |
| `COMFY_DATA_DIR` | **none — required** | Root data directory for artifact cache (`artifacts/`) and job store (`jobs.jsonl`). Provider **fails at startup** if unset or directory not writable. No `/tmp` paths are used. |
| `COMFY_IMAGE_TIMEOUT_S` | `120` | Wall-clock timeout for image jobs (seconds) |
| `COMFY_VIDEO_TIMEOUT_S` | `600` | Wall-clock timeout for video jobs (seconds) |
| `COMFY_ARTIFACT_TTL_HOURS` | `24` | Artifact retention window |
| `COMFY_ARTIFACT_MAX_BYTES` | `21474836480` (20 GB) | Maximum total bytes of stored artifacts; oldest-first eviction when exceeded |
| `COMFY_MAX_JOB_RECORDS` | `1000` | Maximum job records before LRU eviction |
| `COMFY_SWEEP_INTERVAL_MINUTES` | `15` | Background sweep cadence |
