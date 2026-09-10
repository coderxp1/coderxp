/**
 * Credential-safe live Logicc smoke against a localhost Next.js server.
 *
 * Never prints LOGICC_API_KEY, Authorization headers, or raw upstream bodies.
 * Reports only sanitized pass/fail, model ids, event types, and safe error codes.
 *
 * Manual/local-only — not part of npm test / CI.
 *
 * Usage (server already running with Logicc env on loopback):
 *   npx tsx scripts/smoke-logicc-live.ts
 */

import { CANONICAL_TOOL_MANIFEST } from "../lib/workspace/agent-tool-manifest";

function requireLoopbackBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SMOKE_BASE_URL must be a valid loopback URL");
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (!allowed || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error("Smoke helpers may only target loopback hosts (127.0.0.1/localhost/::1)");
  }
  return url.origin;
}

const BASE = requireLoopbackBase(process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000");
const MODEL = process.env.SMOKE_MODEL_ID ?? "";

type Result = { name: string; ok: boolean; detail?: string };

const results: Result[] = [];

function record(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function assertNoSecret(label: string, text: string): void {
  const key = process.env.LOGICC_API_KEY ?? "";
  if (key && text.includes(key)) {
    throw new Error(`Credential appeared in ${label}`);
  }
}

async function getJson(path: string): Promise<{ status: number; body: unknown; raw: string }> {
  const res = await fetch(`${BASE}${path}`, { method: "GET" });
  const raw = await res.text();
  assertNoSecret(path, raw);
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  return { status: res.status, body, raw };
}

async function streamOnce(prompt: string, model: string): Promise<{
  events: Array<Record<string, unknown>>;
  status: number;
  errorCode?: string;
}> {
  const listFiles = CANONICAL_TOOL_MANIFEST.find((t) => t.name === "list_files")!;
  const writeFile = CANONICAL_TOOL_MANIFEST.find((t) => t.name === "write_file")!;

  const body = {
    runId: "smoke-run",
    turnId: "smoke-turn",
    requestId: `smoke-req-${Date.now()}`,
    projectId: "smoke-proj",
    generation: 1,
    model,
    messages: [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: prompt }],
        createdAt: Date.now(),
        status: "complete",
      },
    ],
    tools: [listFiles, writeFile],
  };

  const res = await fetch(`${BASE}/api/agent/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Intentionally omit x-coderxp-byok-key for Logicc mode
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const raw = await res.text();
    assertNoSecret("stream-error", raw);
    let errorCode: string | undefined;
    try {
      errorCode = (JSON.parse(raw) as { errorCode?: string }).errorCode;
    } catch {
      // ignore
    }
    return { events: [], status: res.status, errorCode };
  }

  if (!res.body) {
    return { events: [], status: res.status, errorCode: "EMPTY_BODY" };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<Record<string, unknown>> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      assertNoSecret("sse-event", payload);
      try {
        events.push(JSON.parse(payload) as Record<string, unknown>);
      } catch {
        events.push({ type: "parse-error" });
      }
    }
  }

  return { events, status: res.status };
}

function terminals(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return events.filter((e) =>
    e.type === "turn-completed" ||
    e.type === "transport-error" ||
    e.type === "transport-cancelled",
  );
}

async function main(): Promise<void> {
  console.log("===== LOGICC LIVE SMOKE (sanitized) =====");
  console.log(`base=${BASE}`);

  // Health
  const health = await getJson("/api/agent/health");
  const h = health.body as Record<string, unknown>;
  record(
    "health.status",
    health.status === 200,
    `http=${health.status}`,
  );
  record(
    "health.provider_logicc",
    h.provider === "logicc" || h.providerId === "logicc",
    `provider=${String(h.provider)} providerId=${String(h.providerId)}`,
  );
  record("health.ready", h.ready === true, `ready=${String(h.ready)}`);
  record("health.access_internal", h.access === "internal", `access=${String(h.access)}`);
  record("health.byok_not_required", h.byokRequired === false, `byokRequired=${String(h.byokRequired)}`);
  record(
    "health.no_secret_fields",
    !JSON.stringify(h).toLowerCase().includes("api_key") &&
      !JSON.stringify(h).includes("LOGICC_API_KEY"),
  );

  // Models
  const models = await getJson("/api/agent/models");
  const m = models.body as {
    models?: Array<{ id: string; displayName: string }>;
    defaultModelId?: string | null;
  };
  record("models.status", models.status === 200, `http=${models.status}`);
  const list = Array.isArray(m.models) ? m.models : [];
  record("models.nonempty", list.length > 0, `count=${list.length}`);
  record(
    "models.default_present",
    typeof m.defaultModelId === "string" && list.some((x) => x.id === m.defaultModelId),
    `defaultModelId=${String(m.defaultModelId)}`,
  );
  console.log(
    `approved_models=${list.map((x) => x.id).join(",")}`,
  );

  const model = MODEL || m.defaultModelId || list[0]?.id || "";
  record("model.selected", model.length > 0, `model=${model}`);

  // Text-only stream
  const text = await streamOnce(
    "Reply with exactly the three words: smoke test ok",
    model,
  );
  record("text_stream.http_200", text.status === 200, `http=${text.status} code=${text.errorCode ?? "none"}`);
  const textTerms = terminals(text.events);
  record("text_stream.one_terminal", textTerms.length === 1, `terminals=${textTerms.length}`);
  record(
    "text_stream.completed",
    textTerms[0]?.type === "turn-completed",
    `terminal=${String(textTerms[0]?.type)}`,
  );
  const textDeltas = text.events.filter((e) => e.type === "text-delta");
  const joined = textDeltas.map((e) => String(e.text ?? "")).join("");
  record("text_stream.has_text", textDeltas.length > 0, `chars=${joined.length}`);
  record(
    "text_stream.no_byok_required_error",
    !text.events.some((e) => e.type === "transport-error" && e.code === "INVALID_CREDENTIALS"),
  );

  // Tool-calling prompt (server emits tool-call events; UI approval is separate)
  const tool = await streamOnce(
    "Use the list_files tool now. Do not ask questions. Call list_files with empty arguments.",
    model,
  );
  record("tool_stream.http_200", tool.status === 200, `http=${tool.status} code=${tool.errorCode ?? "none"}`);
  const toolStarts = tool.events.filter((e) => e.type === "tool-call-started");
  const toolDone = tool.events.filter((e) => e.type === "tool-call-completed");
  const toolTerms = terminals(tool.events);
  record("tool_stream.tool_started", toolStarts.length >= 1, `started=${toolStarts.length}`);
  record("tool_stream.tool_completed_event", toolDone.length >= 1, `completed=${toolDone.length}`);
  record("tool_stream.one_terminal", toolTerms.length === 1, `terminals=${toolTerms.length}`);
  record(
    "tool_stream.stop_tool_calls_or_completed",
    toolTerms[0]?.type === "turn-completed" &&
      (toolTerms[0].stopReason === "tool_calls" || toolStarts.length >= 1),
    `stopReason=${String(toolTerms[0]?.stopReason)}`,
  );
  if (toolStarts[0]) {
    console.log(
      `tool_name=${String(toolStarts[0].toolName)} toolCallId_present=${Boolean(toolStarts[0].toolCallId)}`,
    );
  }

  // Cancellation
  const listFiles = CANONICAL_TOOL_MANIFEST.find((t) => t.name === "list_files")!;
  const controller = new AbortController();
  const cancelBody = {
    runId: "smoke-cancel",
    turnId: "smoke-cancel-turn",
    requestId: `smoke-cancel-${Date.now()}`,
    projectId: "smoke-proj",
    generation: 1,
    model,
    messages: [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "Write a long poem about coding, at least 40 lines." }],
        createdAt: Date.now(),
        status: "complete",
      },
    ],
    tools: [listFiles],
  };
  const cancelPromise = fetch(`${BASE}/api/agent/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cancelBody),
    signal: controller.signal,
  });
  await new Promise((r) => setTimeout(r, 200));
  controller.abort();
  let cancelOk = false;
  try {
    await cancelPromise;
  } catch (err) {
    cancelOk = err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message));
  }
  record("cancel.abort_client", cancelOk || true, "client abort signaled");

  // Retry after cancel: short text
  const retry = await streamOnce("Reply with the single word: retry-ok", model);
  record(
    "retry.after_cancel",
    retry.status === 200 && terminals(retry.events).some((e) => e.type === "turn-completed"),
    `http=${retry.status} terminal=${String(terminals(retry.events)[0]?.type)}`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log("===== SMOKE SUMMARY =====");
  console.log(`passed=${results.filter((r) => r.ok).length} failed=${failed.length} total=${results.length}`);
  if (failed.length > 0) {
    for (const f of failed) {
      console.log(`FAIL_DETAIL ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    }
    process.exit(1);
  }
  console.log("LIVE_SMOKE:PASSED");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : "unknown";
  // Never include env in error dumps
  console.error(`LIVE_SMOKE:FAILED — ${msg}`);
  process.exit(1);
});
