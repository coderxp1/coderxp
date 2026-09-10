/**
 * Deterministic Production End-to-End Test Suite for CoderXP M3.9.
 *
 * Uses the real agent stream handler behind a thin HTTP adapter (no duplicated
 * validation/security logic). A local fake Anthropic server is reached only
 * through the handler's injected fetchUpstream boundary.
 *
 * Zero external cloud calls.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { AgentOrchestrator } from "../lib/workspace/agent-orchestrator";
import { HttpAgentTransport } from "../lib/workspace/agent-http-transport";
import { AgentExecutionRuntime } from "../lib/workspace/agent-execution-runtime";
import { AgentPermissionController } from "../lib/workspace/agent-permissions";
import {
  createAgentStreamHandler,
  createConcurrencyGate,
  defaultStreamLimits,
  PRODUCTION_ANTHROPIC_MESSAGES_URL,
} from "../lib/server/agent-stream-handler";

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
  assert(!serialized.includes(SYNTHETIC_BYOK_FIXTURE), `${label} does not contain the synthetic BYOK fixture`);
}

interface FakeServerBehavior {
  status?: number;
  sseLines?: string[];
  prematureClose?: boolean;
  onReceivedHeaders?: (headers: http.IncomingHttpHeaders) => void;
  onReceivedBody?: (body: Record<string, unknown>) => void;
}

function createFakeAnthropicServer(): {
  server: http.Server;
  getUrl: () => string;
  setBehavior: (b: FakeServerBehavior) => void;
  close: () => Promise<void>;
} {
  let behavior: FakeServerBehavior = {};

  const server = http.createServer(async (req, res) => {
    behavior.onReceivedHeaders?.(req.headers);

    let bodyText = "";
    req.on("data", (chunk) => {
      bodyText += chunk.toString("utf8");
    });

    req.on("end", async () => {
      if (bodyText) {
        try {
          behavior.onReceivedBody?.(JSON.parse(bodyText));
        } catch {
          // ignore
        }
      }

      const status = behavior.status ?? 200;
      if (status !== 200) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { type: "upstream_error", message: `HTTP ${status}` } }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      if (behavior.prematureClose) {
        res.write('data: {"type":"message_start"}\n\n');
        res.destroy();
        return;
      }

      const lines = behavior.sseLines ?? [
        'data: {"type":"message_start"}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Done."}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}',
        'data: {"type":"message_stop"}',
      ];

      for (const line of lines) {
        res.write(`${line}\n\n`);
      }
      res.end();
    });
  });

  return {
    server,
    getUrl: () => {
      const addr = server.address() as AddressInfo;
      return `http://127.0.0.1:${addr.port}`;
    },
    setBehavior: (b: FakeServerBehavior) => {
      behavior = { ...behavior, ...b };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Thin HTTP adapter around the real stream handler. No request validation,
 * translation, or permission logic lives here.
 */
function createHandlerHttpAdapter(handler: (req: Request) => Promise<Response>): {
  server: http.Server;
  getUrl: () => string;
  close: () => Promise<void>;
} {
  const server = http.createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    incoming.on("aborted", () => {
      abort.abort();
    });
    outgoing.on("close", () => {
      if (!outgoing.writableEnded) abort.abort();
    });

    const chunks: Buffer[] = [];
    for await (const chunk of incoming) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }

    const method = incoming.method ?? "POST";
    const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
      signal: abort.signal,
    });

    try {
      const response = await handler(request);
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      outgoing.writeHead(response.status, responseHeaders);
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          outgoing.write(value);
        }
      }
    } catch {
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { "Content-Type": "application/json" });
        outgoing.write(JSON.stringify({ errorCode: "INTERNAL_ERROR", message: "Handler adapter failed." }));
      }
    } finally {
      if (!outgoing.writableEnded) outgoing.end();
    }
  });

  return {
    server,
    getUrl: () => {
      const addr = server.address() as AddressInfo;
      return `http://127.0.0.1:${addr.port}`;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function waitForState(
  orchestrator: AgentOrchestrator,
  predicate: (state: string) => boolean,
  timeoutMs = 2000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = orchestrator.getState();
    if (predicate(current)) return current;
    await new Promise((r) => setTimeout(r, 10));
  }
  return orchestrator.getState();
}

async function runProductionE2ETests() {
  console.log("==========================================================================");
  console.log("      M3.9 PRODUCTION END-TO-END ORCHESTRATION & BYOK HARNESS             ");
  console.log("==========================================================================");

  const fakeAnthropic = createFakeAnthropicServer();
  await new Promise<void>((resolve) => fakeAnthropic.server.listen(0, "127.0.0.1", () => resolve()));

  const handler = createAgentStreamHandler({
    fetchUpstream: async (url, init) => {
      assert(url === PRODUCTION_ANTHROPIC_MESSAGES_URL, "E2E upstream URL is the server-owned Anthropic origin");
      assert(!url.includes(SYNTHETIC_BYOK_FIXTURE), "E2E upstream URL does not contain the BYOK fixture");
      return fetch(fakeAnthropic.getUrl(), init);
    },
    clock: () => Date.now(),
    scheduleTimeout: (fn, ms) => setTimeout(fn, ms),
    cancelTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    limits: defaultStreamLimits,
    concurrency: createConcurrencyGate(50),
  });

  const adapter = createHandlerHttpAdapter(handler);
  await new Promise<void>((resolve) => adapter.server.listen(0, "127.0.0.1", () => resolve()));

  try {
    console.log("\n--- 1. COMPLETE TWO-TURN REAL-TOOL EXECUTION LOOP ---");

    let turnCount = 0;
    fakeAnthropic.setBehavior({
      sseLines: [
        'data: {"type":"message_start"}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"I will create the file now."}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-e2e-1","name":"write_file"}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"hello.txt\\",\\"contents\\":\\"Hello World\\"}"}}',
        'data: {"type":"content_block_stop","index":1}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}',
        'data: {"type":"message_stop"}',
      ],
      onReceivedHeaders: (headers) => {
        assert(headers["x-api-key"] === SYNTHETIC_BYOK_FIXTURE, "Upstream received exact BYOK key in header");
      },
      onReceivedBody: (body) => {
        turnCount++;
        if (turnCount === 2) {
          const msgs = body.messages as Array<Record<string, unknown>>;
          assert(msgs.length === 3, "Upstream turn 2 payload contains 3 messages (user, assistant, tool_result)");
          const toolResultMsg = msgs[2];
          assert(toolResultMsg.role === "user", "Tool result message is in user role");
          const blocks = toolResultMsg.content as Array<Record<string, unknown>>;
          assert(blocks[0].type === "tool_result", "Block is tool_result");
          assert(blocks[0].tool_use_id === "call-e2e-1", "tool_use_id matches call-e2e-1");
          assertFixtureAbsent("upstream turn-2 body", body);

          fakeAnthropic.setBehavior({
            sseLines: [
              'data: {"type":"message_start"}',
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"The file hello.txt has been successfully created."}}',
              'data: {"type":"content_block_stop","index":0}',
              'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}',
              'data: {"type":"message_stop"}',
            ],
          });
        }
      },
    });

    const permissionCtrl = new AgentPermissionController();
    permissionCtrl.setMode("ask");

    let toolExecuted = 0;
    const runtime = new AgentExecutionRuntime({
      projectId: "proj-e2e",
      generation: 1,
      controller: permissionCtrl,
      executeTool: async () => {
        toolExecuted++;
        return { ok: true, data: { path: "hello.txt", size: 11 } };
      },
      scheduleDrain: (fn) => queueMicrotask(fn),
    });

    let currentApiKey: string | null = SYNTHETIC_BYOK_FIXTURE;
    const transport = new HttpAgentTransport({
      endpoint: adapter.getUrl(),
      getApiKey: () => currentApiKey,
    });

    const orchestrator = new AgentOrchestrator({
      projectId: "proj-e2e",
      generation: 1,
      runtime,
      transport,
    });

    orchestrator.submitRun("Create hello.txt");
    assert(
      orchestrator.getState() === "starting" ||
        orchestrator.getState() === "streaming" ||
        orchestrator.getState() === "waiting-for-approval",
      "Run started",
    );

    const stateAfterTurn1 = await waitForState(
      orchestrator,
      (s) => s === "waiting-for-approval" || s === "failed",
      3000,
    );
    assert(
      stateAfterTurn1 === "waiting-for-approval",
      `Orchestrator paused at waiting-for-approval (actual: ${stateAfterTurn1})`,
    );

    const pending = permissionCtrl.getPending();
    assert(pending.length === 1, "Exactly one approval pending");
    permissionCtrl.approve(pending[0].approvalId, 1);

    const activeAtt = runtime.getActiveHead();
    assert(activeAtt !== null, "Found active execution attempt in runtime");
    await runtime.resume(activeAtt!.attemptId);

    const stateAfterTurn2 = await waitForState(orchestrator, (s) => s === "completed" || s === "failed", 3000);
    assert(stateAfterTurn2 === "completed", `Orchestrator run completed after Turn 2 (actual: ${stateAfterTurn2})`);
    assert(toolExecuted === 1, "Tool handler executed exactly 1 time through gate");

    const messages = orchestrator.getMessages();
    assert(
      messages.length === 4,
      "Conversation contains 4 canonical messages (user, assistant-call, tool-result, assistant-done)",
    );
    assert(messages[0].role === "user", "Message 1 is user");
    assert(messages[1].role === "assistant", "Message 2 is assistant tool request");
    assert(messages[2].role === "tool", "Message 3 is tool result envelope");
    assert(messages[3].role === "assistant", "Message 4 is final assistant message");
    assertFixtureAbsent("orchestrator transcript", messages);

    console.log("\n--- 2. SECURITY & CREDENTIAL PRIVACY ASSERTIONS ---");
    assertFixtureAbsent("serialized transcript", messages);

    console.log("\n--- 3. NEGATIVE CONTROLS: MISSING/INVALID BYOK KEY ---");
    currentApiKey = null;
    const noKeyOrchestrator = new AgentOrchestrator({
      projectId: "proj-no-key",
      generation: 1,
      runtime,
      transport,
    });
    noKeyOrchestrator.submitRun("Hello without key");
    const noKeyState = await waitForState(noKeyOrchestrator, (s) => s === "failed", 2000);
    assert(noKeyState === "failed", "Run fails immediately when BYOK key is missing");
    assertFixtureAbsent("no-key orchestrator messages", noKeyOrchestrator.getMessages());

    console.log("\n--- 4. NEGATIVE CONTROLS: RATE LIMIT (429) & UPSTREAM 500 ---");
    currentApiKey = SYNTHETIC_BYOK_FIXTURE;
    fakeAnthropic.setBehavior({ status: 429 });
    const rateLimitOrch = new AgentOrchestrator({
      projectId: "proj-429",
      generation: 1,
      runtime,
      transport,
    });
    rateLimitOrch.submitRun("Rate limit test");
    const rateLimitState = await waitForState(rateLimitOrch, (s) => s === "failed", 2000);
    assert(rateLimitState === "failed", "Run fails when provider returns 429 Rate Limit");
    assertFixtureAbsent("429 orchestrator messages", rateLimitOrch.getMessages());

    fakeAnthropic.setBehavior({ status: 500 });
    const serverErrOrch = new AgentOrchestrator({
      projectId: "proj-500",
      generation: 1,
      runtime,
      transport,
    });
    serverErrOrch.submitRun("Server error test");
    const serverErrState = await waitForState(serverErrOrch, (s) => s === "failed", 2000);
    assert(serverErrState === "failed", "Run fails when provider returns 500 Server Error");
    assertFixtureAbsent("500 orchestrator messages", serverErrOrch.getMessages());

    console.log("\n--- 5. NEGATIVE CONTROLS: PREMATURE UPSTREAM EOF ---");
    fakeAnthropic.setBehavior({ status: 200, prematureClose: true });
    const eofOrch = new AgentOrchestrator({
      projectId: "proj-eof",
      generation: 1,
      runtime,
      transport,
    });
    eofOrch.submitRun("Premature EOF test");
    const eofState = await waitForState(eofOrch, (s) => s === "failed", 2000);
    assert(eofState === "failed", "Run fails closed when upstream stream closes prematurely without terminal event");
    assertFixtureAbsent("eof orchestrator messages", eofOrch.getMessages());

    console.log("==========================================================================");
    console.log(`  SUCCESS: ALL ${passCount} PRODUCTION E2E ASSERTIONS PASSED!`);
    console.log("==========================================================================");
  } finally {
    await adapter.close();
    await fakeAnthropic.close();
  }
}

runProductionE2ETests().catch((err) => {
  console.error("E2E Test execution failed:", err);
  process.exit(1);
});
