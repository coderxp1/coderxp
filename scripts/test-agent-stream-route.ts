/**
 * Deterministic route-level tests for the real M3.9 agent stream handler.
 *
 * Coverage index:
 *  1. Missing BYOK rejection
 *  2. Invalid content type
 *  3. Malformed JSON
 *  4. Oversized request rejection
 *  5. Disallowed model
 *  6. Invalid options (temperature / maxTokens)
 *  7. Unknown tool rejection
 *  8. Modified tool rejection
 *  9. Canonical text streaming
 * 10. Fragmented tool-call streaming
 * 11. Upstream error normalization
 * 12. Premature EOF
 * 13. Malformed upstream SSE
 * 14. Browser cancellation propagating upstream
 * 15. Connect timeout
 * 16. Exactly one canonical terminal event
 * 17. No events after the terminal event
 * 18. Normal response closure
 * 19. Request-scoped cleanup
 * 20. Connect-timeout races
 * 21. Synthetic fixture absent from events, errors, transcripts, URLs
 *
 * Zero production network. The handler is the same factory bound by POST.
 */

import { CANONICAL_TOOL_MANIFEST } from "../lib/workspace/agent-tool-manifest";
import {
  createAgentStreamHandler,
  createConcurrencyGate,
  defaultStreamLimits,
  PRODUCTION_ANTHROPIC_MESSAGES_URL,
  type AgentStreamHandlerDeps,
  type FetchUpstream,
} from "../lib/server/agent-stream-handler";
import type {
  AgentTransportEvent,
  AgentTransportRequest,
  CanonicalAgentMessage,
} from "../lib/workspace/agent-transport-types";

/** Intentionally invalid. Not an Anthropic key format. Never a live credential. */
const SYNTHETIC_BYOK_FIXTURE = "cxp-test-invalid-not-a-credential";

let passCount = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
  passCount++;
  console.log(`[PASS #${passCount}] ${message}`);
}

function assertFixtureAbsent(label: string, value: unknown): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  assert(
    !serialized.includes(SYNTHETIC_BYOK_FIXTURE),
    `${label} does not contain the synthetic BYOK fixture`,
  );
}

const validMessages: CanonicalAgentMessage[] = [
  {
    id: "msg-1",
    role: "user",
    parts: [{ type: "text", text: "Hello from the route harness." }],
    createdAt: 1000,
    status: "complete",
  },
];

function validRequest(overrides: Partial<AgentTransportRequest> = {}): AgentTransportRequest {
  return {
    runId: "run-route-1",
    turnId: "turn-route-1",
    requestId: "req-route-1",
    projectId: "proj-route-1",
    generation: 1,
    messages: validMessages,
    tools: [CANONICAL_TOOL_MANIFEST.find((t) => t.name === "list_files")!],
    ...overrides,
  };
}

function sseResponse(lines: string[], extraAfterTerminal?: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n\n`));
      }
      if (extraAfterTerminal) {
        for (const line of extraAfterTerminal) {
          controller.enqueue(encoder.encode(`${line}\n\n`));
        }
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}

const TEXT_SSE = [
  'data: {"type":"message_start"}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"CoderXP"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
  'data: {"type":"message_stop"}',
];

const FRAGMENTED_TOOL_SSE = [
  'data: {"type":"message_start"}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Writing now."}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-route-1","name":"write_file"}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"hello.txt\\","}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"contents\\":\\"Hi\\"}"}}',
  'data: {"type":"content_block_stop","index":1}',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}',
  'data: {"type":"message_stop"}',
];

interface FakeTimer {
  scheduleTimeout: (fn: () => void, ms: number) => unknown;
  cancelTimeout: (id: unknown) => void;
  advance: (ms: number) => void;
  pendingCount: () => number;
  connectCallback: () => (() => void) | undefined;
}

function createFakeTimer(): FakeTimer {
  let nextId = 1;
  let now = 0;
  const pending = new Map<number, { fn: () => void; due: number; ms: number }>();
  let connectCb: (() => void) | undefined;

  return {
    scheduleTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, due: now + ms, ms });
      if (connectCb === undefined) {
        connectCb = fn;
      }
      return id;
    },
    cancelTimeout(id) {
      pending.delete(id as number);
    },
    advance(ms) {
      now += ms;
      const due = [...pending.entries()].filter(([, timer]) => timer.due <= now);
      for (const [id, timer] of due) {
        pending.delete(id);
        timer.fn();
      }
    },
    pendingCount() {
      return pending.size;
    },
    connectCallback() {
      return connectCb;
    },
  };
}

function parseSse(raw: string): AgentTransportEvent[] {
  const events: AgentTransportEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr) continue;
    events.push(JSON.parse(jsonStr) as AgentTransportEvent);
  }
  return events;
}

function terminalEvents(events: AgentTransportEvent[]): AgentTransportEvent[] {
  return events.filter(
    (event) =>
      event.type === "turn-completed" ||
      event.type === "transport-error" ||
      event.type === "transport-cancelled",
  );
}

async function readBody(response: Response): Promise<string> {
  return response.text();
}

function makeHandler(
  fetchUpstream: FetchUpstream,
  overrides: Partial<AgentStreamHandlerDeps> = {},
): {
  handler: (req: Request) => Promise<Response>;
  gate: ReturnType<typeof createConcurrencyGate>;
  timer: FakeTimer;
} {
  const timer = createFakeTimer();
  const gate = createConcurrencyGate(50);
  const handler = createAgentStreamHandler({
    fetchUpstream,
    clock: () => 1,
    scheduleTimeout: timer.scheduleTimeout,
    cancelTimeout: timer.cancelTimeout,
    limits: { ...defaultStreamLimits, connectTimeoutMs: 20, streamTimeoutMs: 5_000 },
    concurrency: gate,
    ...overrides,
  });
  return { handler, gate, timer };
}

function postRequest(
  body: unknown,
  options: { key?: string | null; contentType?: string; signal?: AbortSignal } = {},
): Request {
  const headers = new Headers();
  headers.set("content-type", options.contentType ?? "application/json");
  if (options.key !== null) {
    headers.set("x-coderxp-byok-key", options.key ?? SYNTHETIC_BYOK_FIXTURE);
  }
  return new Request("http://127.0.0.1/api/agent/stream", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: options.signal,
  });
}

async function runRouteTests() {
  console.log("==========================================================================");
  console.log("      M3.9 AGENT STREAM ROUTE HANDLER (DETERMINISTIC HARNESS)             ");
  console.log("==========================================================================");

  const unusedFetch: FetchUpstream = async () => {
    throw new Error("fetchUpstream must not be called for this case");
  };

  // 1. Missing BYOK
  {
    console.log("\n--- 1. MISSING BYOK ---");
    const { handler, gate } = makeHandler(unusedFetch);
    const res = await handler(postRequest(validRequest(), { key: null }));
    assert(res.status === 401, "Missing BYOK returns 401");
    const json = (await res.json()) as { errorCode: string };
    assert(json.errorCode === "INVALID_CREDENTIALS", "Missing BYOK uses INVALID_CREDENTIALS");
    assert(gate.active() === 0, "Concurrency released after missing BYOK");
    assertFixtureAbsent("missing-BYOK error body", json);
  }

  // 2. Invalid content type
  {
    console.log("\n--- 2. INVALID CONTENT TYPE ---");
    const { handler, gate } = makeHandler(unusedFetch);
    const res = await handler(postRequest(validRequest(), { contentType: "text/plain" }));
    assert(res.status === 400, "Invalid content type returns 400");
    const json = (await res.json()) as { errorCode: string };
    assert(json.errorCode === "INVALID_REQUEST", "Invalid content type uses INVALID_REQUEST");
    assert(gate.active() === 0, "Concurrency released after invalid content type");
  }

  // 3. Malformed JSON
  {
    console.log("\n--- 3. MALFORMED JSON ---");
    const { handler, gate } = makeHandler(unusedFetch);
    const res = await handler(postRequest("{not-json", {}));
    assert(res.status === 400, "Malformed JSON returns 400");
    const json = (await res.json()) as { errorCode: string };
    assert(json.errorCode === "INVALID_REQUEST", "Malformed JSON uses INVALID_REQUEST");
    assert(gate.active() === 0, "Concurrency released after malformed JSON");
  }

  // 4. Oversized request
  {
    console.log("\n--- 4. OVERSIZED REQUEST ---");
    const { handler, gate } = makeHandler(unusedFetch, {
      limits: { ...defaultStreamLimits, maxRequestBodyBytes: 32, connectTimeoutMs: 20, streamTimeoutMs: 5000 },
    });
    const res = await handler(postRequest("x".repeat(64)));
    assert(res.status === 413, "Oversized body returns 413");
    const json = (await res.json()) as { errorCode: string };
    assert(json.errorCode === "REQUEST_TOO_LARGE", "Oversized body uses REQUEST_TOO_LARGE");
    assert(gate.active() === 0, "Concurrency released after oversized body");
  }

  // 5. Disallowed model
  {
    console.log("\n--- 5. DISALLOWED MODEL ---");
    const { handler, gate } = makeHandler(unusedFetch);
    const res = await handler(postRequest({ ...validRequest(), model: "claude-unapproved-model" }));
    assert(res.status === 400, "Disallowed model returns 400");
    const json = (await res.json()) as { errorCode: string };
    assert(json.errorCode === "MODEL_NOT_ALLOWED", "Disallowed model uses MODEL_NOT_ALLOWED");
    assert(gate.active() === 0, "Concurrency released after disallowed model");
  }

  // 6. Invalid options
  {
    console.log("\n--- 6. INVALID OPTIONS ---");
    const { handler } = makeHandler(unusedFetch);
    const tempRes = await handler(postRequest({ ...validRequest(), temperature: 1.5 }));
    assert(tempRes.status === 400, "Out-of-range temperature returns 400");
    const tempJson = (await tempRes.json()) as { errorCode: string };
    assert(tempJson.errorCode === "INVALID_REQUEST", "Out-of-range temperature uses INVALID_REQUEST");

    const tokenRes = await handler(postRequest({ ...validRequest(), maxTokens: 100000 }));
    assert(tokenRes.status === 400, "Out-of-range maxTokens returns 400");
    const tokenJson = (await tokenRes.json()) as { errorCode: string };
    assert(tokenJson.errorCode === "INVALID_REQUEST", "Out-of-range maxTokens uses INVALID_REQUEST");
  }

  // 7. Unknown tool
  {
    console.log("\n--- 7. UNKNOWN TOOL ---");
    const { handler } = makeHandler(unusedFetch);
    const res = await handler(
      postRequest(
        validRequest({
          tools: [
            {
              name: "eval_code_arbitrary",
              category: "command",
              risk: "execute",
              summary: "execute arbitrary code",
              parameters: [],
              requiresApproval: true,
            },
          ],
        }),
      ),
    );
    assert(res.status === 400, "Unknown tool returns 400");
    const json = (await res.json()) as { errorCode: string };
    assert(json.errorCode === "TOOL_NOT_ALLOWED", "Unknown tool uses TOOL_NOT_ALLOWED");
  }

  // 8. Modified tool
  {
    console.log("\n--- 8. MODIFIED TOOL ---");
    const { handler } = makeHandler(unusedFetch);
    const listFiles = CANONICAL_TOOL_MANIFEST.find((t) => t.name === "write_file")!;
    const res = await handler(
      postRequest(
        validRequest({
          tools: [{ ...listFiles, risk: "read", requiresApproval: false }],
        }),
      ),
    );
    assert(res.status === 400, "Modified tool risk returns 400");
    const json = (await res.json()) as { errorCode: string };
    assert(json.errorCode === "TOOL_NOT_ALLOWED", "Modified tool uses TOOL_NOT_ALLOWED");
  }

  let lastFetchedUrl = "";
  const recordingFetch: FetchUpstream = async (url, init) => {
    lastFetchedUrl = url;
    assert(url === PRODUCTION_ANTHROPIC_MESSAGES_URL, "Upstream URL is the server-owned Anthropic origin");
    assert(!url.includes(SYNTHETIC_BYOK_FIXTURE), "Upstream URL does not contain the BYOK fixture");
    assert(init.headers["x-api-key"] === SYNTHETIC_BYOK_FIXTURE, "Upstream receives the request-scoped BYOK header");
    assertFixtureAbsent("upstream request body", init.body);
    return sseResponse(TEXT_SSE);
  };

  // 9. Canonical text streaming
  {
    console.log("\n--- 9. CANONICAL TEXT STREAMING ---");
    const { handler, gate } = makeHandler(recordingFetch);
    const res = await handler(postRequest(validRequest()));
    assert(res.status === 200, "Text stream returns 200");
    assert(res.headers.get("Content-Type")?.includes("text/event-stream") === true, "Content-Type is SSE");
    assert(res.headers.get("X-Accel-Buffering") === "no", "X-Accel-Buffering is no");
    const raw = await readBody(res);
    const events = parseSse(raw);
    assert(events[0]?.type === "turn-started", "First event is turn-started");
    const text = events
      .filter((event) => event.type === "text-delta")
      .map((event) => (event.type === "text-delta" ? event.text : ""))
      .join("");
    assert(text === "Hello CoderXP", "Text deltas assemble to Hello CoderXP");
    const terminals = terminalEvents(events);
    assert(terminals.length === 1, "Exactly one terminal event for text stream");
    assert(terminals[0].type === "turn-completed", "Text stream terminal is turn-completed");
    assert(gate.active() === 0, "Concurrency released after text stream");
    assertFixtureAbsent("text stream raw SSE", raw);
    assertFixtureAbsent("text stream events", events);
    assert(lastFetchedUrl === PRODUCTION_ANTHROPIC_MESSAGES_URL, "Recorded upstream URL is the production origin");
  }

  // 10. Fragmented tool-call streaming
  {
    console.log("\n--- 10. FRAGMENTED TOOL-CALL STREAMING ---");
    const { handler } = makeHandler(async (url, init) => {
      assert(url === PRODUCTION_ANTHROPIC_MESSAGES_URL, "Tool-call stream uses production Anthropic origin");
      assert(init.headers["x-api-key"] === SYNTHETIC_BYOK_FIXTURE, "Tool-call stream forwards BYOK header");
      return sseResponse(FRAGMENTED_TOOL_SSE);
    });
    const res = await handler(
      postRequest(validRequest({ tools: [CANONICAL_TOOL_MANIFEST.find((t) => t.name === "write_file")!] })),
    );
    const raw = await readBody(res);
    const events = parseSse(raw);
    assert(
      events.some((event) => event.type === "tool-call-started"),
      "Fragmented tool stream emits tool-call-started",
    );
    const chunks = events
      .filter((event) => event.type === "tool-call-arguments-delta")
      .map((event) => (event.type === "tool-call-arguments-delta" ? event.chunk : ""))
      .join("");
    assert(chunks.includes("hello.txt"), "Fragmented argument chunks assemble path");
    assert(
      events.some((event) => event.type === "tool-call-completed"),
      "Fragmented tool stream emits tool-call-completed",
    );
    const completed = events.find((event) => event.type === "turn-completed");
    assert(completed?.type === "turn-completed" && completed.stopReason === "tool_calls", "Stop reason is tool_calls");
    assert(terminalEvents(events).length === 1, "Exactly one terminal event for tool stream");
    assertFixtureAbsent("tool stream events", events);
  }

  // 11. Upstream error normalization
  {
    console.log("\n--- 11. UPSTREAM ERROR NORMALIZATION ---");
    for (const [status, code] of [
      [401, "INVALID_CREDENTIALS"],
      [429, "RATE_LIMITED"],
      [500, "PROVIDER_UNAVAILABLE"],
    ] as const) {
      const { handler, gate } = makeHandler(async () => new Response("nope", { status }));
      const res = await handler(postRequest(validRequest()));
      const raw = await readBody(res);
      const events = parseSse(raw);
      const terminals = terminalEvents(events);
      assert(terminals.length === 1, `Exactly one terminal for HTTP ${status}`);
      assert(terminals[0].type === "transport-error", `HTTP ${status} emits transport-error`);
      assert(
        terminals[0].type === "transport-error" && terminals[0].code === code,
        `HTTP ${status} normalizes to ${code}`,
      );
      assert(!raw.toLowerCase().includes("stack"), `HTTP ${status} error has no stack`);
      assertFixtureAbsent(`HTTP ${status} events`, events);
      assert(gate.active() === 0, `Concurrency released after HTTP ${status}`);
    }
  }

  // 12. Premature EOF
  {
    console.log("\n--- 12. PREMATURE EOF ---");
    const { handler, gate } = makeHandler(async () =>
      sseResponse(['data: {"type":"message_start"}', 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"partial"}}']),
    );
    const res = await handler(postRequest(validRequest()));
    const events = parseSse(await readBody(res));
    const terminals = terminalEvents(events);
    assert(terminals.length === 1, "Premature EOF emits one terminal");
    assert(
      terminals[0].type === "transport-error" && terminals[0].code === "UPSTREAM_PREMATURE_CLOSE",
      "Premature EOF uses UPSTREAM_PREMATURE_CLOSE",
    );
    assert(gate.active() === 0, "Concurrency released after premature EOF");
  }

  // 13. Malformed upstream SSE
  {
    console.log("\n--- 13. MALFORMED UPSTREAM SSE ---");
    const { handler } = makeHandler(async () =>
      sseResponse(['data: {"type":"message_start"}', "data: {not-json"]),
    );
    const events = parseSse(await readBody(await handler(postRequest(validRequest()))));
    const terminals = terminalEvents(events);
    assert(terminals.length === 1, "Malformed SSE emits one terminal");
    assert(
      terminals[0].type === "transport-error" && terminals[0].code === "UPSTREAM_PROTOCOL_ERROR",
      "Malformed SSE uses UPSTREAM_PROTOCOL_ERROR",
    );
  }

  // 14. Browser cancellation propagating upstream
  {
    console.log("\n--- 14. BROWSER CANCELLATION ---");
    const clientAbort = new AbortController();
    let upstreamAborted = false;
    const { handler, gate } = makeHandler(async (_url, init) => {
      return new Promise<Response>((_, reject) => {
        const fail = () => {
          upstreamAborted = true;
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (init.signal.aborted) {
          fail();
          return;
        }
        init.signal.addEventListener("abort", fail);
      });
    });

    const res = await handler(postRequest(validRequest(), { signal: clientAbort.signal }));
    clientAbort.abort();
    const events = parseSse(await readBody(res));
    assert(upstreamAborted, "Client abort propagated to upstream fetch signal");
    const terminals = terminalEvents(events);
    assert(terminals.length === 1, "Client abort emits one terminal");
    assert(terminals[0].type === "transport-cancelled", "Client abort emits transport-cancelled");
    assert(gate.active() === 0, "Concurrency released after client abort");
    assertFixtureAbsent("cancel events", events);
  }

  // 15 + 20. Connect timeout and races
  {
    console.log("\n--- 15/20. CONNECT TIMEOUT AND RACES ---");

    // Timeout wins before connection
    {
      let upstreamAborted = false;
      const timer = createFakeTimer();
      const gate = createConcurrencyGate(50);
      const handler = createAgentStreamHandler({
        fetchUpstream: async (_url, init) =>
          new Promise<Response>((_, reject) => {
            const fail = () => {
              upstreamAborted = true;
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            };
            if (init.signal.aborted) {
              fail();
              return;
            }
            init.signal.addEventListener("abort", fail);
          }),
        clock: () => 1,
        scheduleTimeout: timer.scheduleTimeout,
        cancelTimeout: timer.cancelTimeout,
        limits: { ...defaultStreamLimits, connectTimeoutMs: 20, streamTimeoutMs: 5000 },
        concurrency: gate,
      });
      const res = await handler(postRequest(validRequest()));
      timer.advance(20);
      const events = parseSse(await readBody(res));
      assert(upstreamAborted, "Connect timeout aborts upstream");
      const terminals = terminalEvents(events);
      assert(terminals.length === 1, "Connect timeout emits one terminal");
      assert(
        terminals[0].type === "transport-error" && terminals[0].code === "PROVIDER_TIMEOUT",
        "Connect timeout uses PROVIDER_TIMEOUT",
      );
      assert(gate.active() === 0, "Concurrency released after connect timeout");
      assert(timer.pendingCount() === 0, "Timers cleared after connect timeout");
    }

    // Upstream connects just before timeout
    {
      const timer = createFakeTimer();
      const gate = createConcurrencyGate(50);
      let fetchStarted: (value: (response: Response) => void) => void;
      const waitForFetch = new Promise<(response: Response) => void>((resolve) => {
        fetchStarted = resolve;
      });
      const handler = createAgentStreamHandler({
        fetchUpstream: async (_url, init) =>
          new Promise<Response>((resolve, reject) => {
            const fail = () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            };
            init.signal.addEventListener("abort", fail);
            fetchStarted(resolve);
          }),
        clock: () => 1,
        scheduleTimeout: timer.scheduleTimeout,
        cancelTimeout: timer.cancelTimeout,
        limits: { ...defaultStreamLimits, connectTimeoutMs: 20, streamTimeoutMs: 5000 },
        concurrency: gate,
      });
      const pending = handler(postRequest(validRequest()));
      const resolveFetch = await waitForFetch;
      resolveFetch(sseResponse(TEXT_SSE));
      const events = parseSse(await readBody(await pending));
      timer.advance(20);
      const terminals = terminalEvents(events);
      assert(terminals.length === 1, "Connect-before-timeout emits one terminal");
      assert(terminals[0].type === "turn-completed", "Healthy connect is not treated as timeout");
      assert(gate.active() === 0, "Concurrency released after successful connect");
    }

    // Client cancellation wins before timeout
    {
      const clientAbort = new AbortController();
      const timer = createFakeTimer();
      const handler = createAgentStreamHandler({
        fetchUpstream: async (_url, init) =>
          new Promise<Response>((_, reject) => {
            const fail = () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            };
            if (init.signal.aborted) {
              fail();
              return;
            }
            init.signal.addEventListener("abort", fail);
          }),
        clock: () => 1,
        scheduleTimeout: timer.scheduleTimeout,
        cancelTimeout: timer.cancelTimeout,
        limits: { ...defaultStreamLimits, connectTimeoutMs: 20, streamTimeoutMs: 5000 },
        concurrency: createConcurrencyGate(50),
      });
      const res = await handler(postRequest(validRequest(), { signal: clientAbort.signal }));
      clientAbort.abort();
      timer.advance(20);
      const events = parseSse(await readBody(res));
      const terminals = terminalEvents(events);
      assert(terminals.length === 1, "Client-cancel-before-timeout emits one terminal");
      assert(terminals[0].type === "transport-cancelled", "Client cancel wins over connect timeout");
    }

    // Stale timeout callback after successful connect causes no state change
    {
      const timer = createFakeTimer();
      const handler = createAgentStreamHandler({
        fetchUpstream: async () => sseResponse(TEXT_SSE),
        clock: () => 1,
        scheduleTimeout: timer.scheduleTimeout,
        cancelTimeout: timer.cancelTimeout,
        limits: { ...defaultStreamLimits, connectTimeoutMs: 20, streamTimeoutMs: 5000 },
        concurrency: createConcurrencyGate(50),
      });
      const pending = handler(postRequest(validRequest()));
      const res = await pending;
      const firstRaw = await readBody(res);
      const before = parseSse(firstRaw);
      const stale = timer.connectCallback();
      assert(typeof stale === "function", "Captured connect-timeout callback for stale fire");
      stale!();
      assert(terminalEvents(before).length === 1, "Stale timeout does not add a terminal event");
      assert(before[before.length - 1].type === "turn-completed", "Successful completion remains the terminal event");
    }

    // Upstream failure and timeout race without duplicate terminal
    {
      const timer = createFakeTimer();
      const handler = createAgentStreamHandler({
        fetchUpstream: async (_url, init) =>
          new Promise<Response>((resolve, reject) => {
            const fail = () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            };
            init.signal.addEventListener("abort", fail);
            resolve(new Response("nope", { status: 500 }));
          }),
        clock: () => 1,
        scheduleTimeout: timer.scheduleTimeout,
        cancelTimeout: timer.cancelTimeout,
        limits: { ...defaultStreamLimits, connectTimeoutMs: 20, streamTimeoutMs: 5000 },
        concurrency: createConcurrencyGate(50),
      });
      const res = await handler(postRequest(validRequest()));
      timer.advance(20);
      const events = parseSse(await readBody(res));
      assert(terminalEvents(events).length === 1, "Failure/timeout race emits exactly one terminal");
    }
  }

  // 16 + 17. One terminal, no events after
  {
    console.log("\n--- 16/17. SINGLE TERMINAL AND NO TRAILING EVENTS ---");
    const { handler } = makeHandler(async () =>
      sseResponse(TEXT_SSE, [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"TRAILING"}}',
      ]),
    );
    const events = parseSse(await readBody(await handler(postRequest(validRequest()))));
    const terminals = terminalEvents(events);
    assert(terminals.length === 1, "Exactly one canonical terminal event");
    const terminalIndex = events.findIndex((event) => terminals[0] === event);
    const after = events.slice(terminalIndex + 1);
    assert(after.length === 0, "No canonical events after the terminal event");
    assert(!JSON.stringify(events).includes("TRAILING"), "Trailing upstream text after stop is dropped");
  }

  // 18 + 19. Normal closure and request-scoped cleanup
  {
    console.log("\n--- 18/19. NORMAL CLOSURE AND CLEANUP ---");
    const timer = createFakeTimer();
    const gate = createConcurrencyGate(50);
    const handler = createAgentStreamHandler({
      fetchUpstream: async () => sseResponse(TEXT_SSE),
      clock: () => 1,
      scheduleTimeout: timer.scheduleTimeout,
      cancelTimeout: timer.cancelTimeout,
      limits: { ...defaultStreamLimits, connectTimeoutMs: 20, streamTimeoutMs: 5000 },
      concurrency: gate,
    });
    const res = await handler(postRequest(validRequest()));
    const raw = await readBody(res);
    const events = parseSse(raw);
    assert(res.body === null || res.bodyUsed, "Response body is consumed/closed after read");
    assert(events[events.length - 1].type === "turn-completed", "Normal closure ends with turn-completed");
    assert(gate.active() === 0, "Request-scoped concurrency released");
    assert(timer.pendingCount() === 0, "Request-scoped timers cleared");
    assertFixtureAbsent("normal-closure snapshot", raw);
    assertFixtureAbsent("normal-closure events", events);
  }

  // Upstream throw must not leak exception text or the fixture
  {
    console.log("\n--- NEGATIVE: UPSTREAM THROW IS GENERIC ---");
    const { handler } = makeHandler(async () => {
      throw new Error(`leaked-exception ${SYNTHETIC_BYOK_FIXTURE}`);
    });
    const raw = await readBody(await handler(postRequest(validRequest())));
    const events = parseSse(raw);
    assertFixtureAbsent("thrown-upstream raw", raw);
    assert(!raw.includes("leaked-exception"), "Raw upstream exception text is not disclosed");
    const terminals = terminalEvents(events);
    assert(
      terminals[0].type === "transport-error" && terminals[0].code === "PROVIDER_UNAVAILABLE",
      "Thrown upstream becomes PROVIDER_UNAVAILABLE",
    );
  }

  console.log("==========================================================================");
  console.log(`  SUCCESS: ALL ${passCount} STREAM ROUTE ASSERTIONS PASSED!`);
  console.log("==========================================================================");
}

runRouteTests().catch((err) => {
  console.error("Stream route harness failed:", err);
  process.exit(1);
});
