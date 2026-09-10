/**
 * Full fake-Logicc end-to-end vertical slice:
 * Logicc fake stream → canonical tool call → M3.8 assembly → M3.7 queue →
 * M3.6 approval → tool executes exactly once → model-safe continuation →
 * final assistant response.
 *
 * Zero live credentials. Synthetic fixtures only.
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
} from "../lib/server/agent-stream-handler";
import { createLogiccAdapter } from "../lib/server/agent-logicc-adapter";
import { LOGICC_CHAT_COMPLETIONS_URL } from "../lib/server/agent-provider-config";
import type { AgentToolResult } from "../lib/workspace/agent-tools";

const SYNTHETIC_LOGICC_KEY = "cxp-test-logicc-not-a-credential";
const STALE_BROWSER_BYOK = "cxp-stale-browser-byok-should-not-be-sent";

let passCount = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
  passCount++;
  console.log(`[PASS #${passCount}] ${message}`);
}

function assertAbsent(label: string, value: unknown): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  assert(!serialized.includes(SYNTHETIC_LOGICC_KEY), `${label}: no Logicc credential`);
  assert(!serialized.includes(STALE_BROWSER_BYOK), `${label}: no stale BYOK`);
}

function openaiSse(chunks: unknown[]): string[] {
  return chunks.map((c) => `data: ${JSON.stringify(c)}`);
}

function createHandlerHttpAdapter(handler: (req: Request) => Promise<Response>): {
  server: http.Server;
  getUrl: () => string;
  close: () => Promise<void>;
} {
  const server = http.createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    incoming.on("aborted", () => abort.abort());
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

    // Capture whether browser sent BYOK on the canonical stream request.
    const browserByok = headers.get("x-coderxp-byok-key");
    assert(
      browserByok === null,
      "Browser stream request contains no Logicc/BYOK credential header",
    );

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
        outgoing.write(
          JSON.stringify({ errorCode: "INTERNAL_ERROR", message: "Handler adapter failed." }),
        );
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
  timeoutMs = 3000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = orchestrator.getState();
    if (predicate(current)) return current;
    await new Promise((r) => setTimeout(r, 10));
  }
  return orchestrator.getState();
}

async function main(): Promise<void> {
  console.log("==========================================================================");
  console.log("           FAKE-LOGICC END-TO-END VERTICAL SLICE HARNESS                  ");
  console.log("==========================================================================");

  let receivedAuth: string | undefined;
  let turnCount = 0;
  let toolExecuted = 0;

  const fakeLogicc = http.createServer((req, res) => {
    receivedAuth = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
    // Ensure browser BYOK never reaches upstream
    assert(
      req.headers["x-coderxp-byok-key"] === undefined,
      "Upstream Logicc request has no browser BYOK header",
    );

    let bodyText = "";
    req.on("data", (c) => {
      bodyText += c.toString("utf8");
    });
    req.on("end", () => {
      assertAbsent("upstream body", bodyText);
      turnCount += 1;

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      if (turnCount === 1) {
        const lines = openaiSse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content: "I will create the file now.",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-logicc-e2e-1",
                      type: "function",
                      function: { name: "write_file", arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        arguments: '{"path":"hello.txt","contents":"Hello World"}',
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 12, completion_tokens: 20 },
          },
        ]);
        for (const line of lines) res.write(`${line}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      // Turn 2: verify tool result continuation shape
      try {
        const parsed = JSON.parse(bodyText) as {
          messages: Array<Record<string, unknown>>;
        };
        assert(Array.isArray(parsed.messages), "Turn 2 has messages array");
        const toolMsg = parsed.messages.find((m) => m.role === "tool");
        assert(!!toolMsg, "Turn 2 includes OpenAI tool message");
        assert(toolMsg?.tool_call_id === "call-logicc-e2e-1", "Tool result correlated by id");
        assertAbsent("turn-2 messages", parsed.messages);
      } catch {
        // body may already have been asserted
      }

      const lines = openaiSse([
        {
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "The file hello.txt has been successfully created.",
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 30, completion_tokens: 12 },
        },
      ]);
      for (const line of lines) res.write(`${line}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => fakeLogicc.listen(0, "127.0.0.1", () => resolve()));
  const addr = fakeLogicc.address() as AddressInfo;
  const fakeBase = `http://127.0.0.1:${addr.port}`;

  assert(
    LOGICC_CHAT_COMPLETIONS_URL === "https://api.logicc.cloud/v1/chat/completions",
    "Production Logicc chat URL is fixed",
  );

  const adapter = createLogiccAdapter({
    env: {
      AGENT_PROVIDER: "logicc",
      LOGICC_API_KEY: SYNTHETIC_LOGICC_KEY,
      LOGICC_INTERNAL_MODE: "true",
      LOGICC_ALLOWED_MODELS: "gpt-4o",
      LOGICC_DEFAULT_MODEL: "gpt-4o",
    },
    fixedApprovedModels: [{ id: "gpt-4o", displayName: "gpt-4o" }],
    fixedDefaultModelId: "gpt-4o",
  });
  adapter.getUpstreamUrl = () => `${fakeBase}/v1/chat/completions`;

  const handler = createAgentStreamHandler({
    fetchUpstream: async (url, init) => {
      assert(url.startsWith(fakeBase), "Upstream fetch uses injected Logicc endpoint");
      assert(
        !("x-coderxp-byok-key" in init.headers) &&
          !("X-Coderxp-Byok-Key" in init.headers),
        "Handler does not forward browser BYOK in Logicc mode",
      );
      assertAbsent("upstream init headers keys", Object.keys(init.headers));
      return fetch(url, init);
    },
    clock: () => Date.now(),
    scheduleTimeout: (fn, ms) => setTimeout(fn, ms),
    cancelTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    limits: defaultStreamLimits,
    concurrency: createConcurrencyGate(50),
    provider: adapter,
    skipSameOriginCheck: true,
  });

  const streamAdapter = createHandlerHttpAdapter(handler);
  await new Promise<void>((resolve) => streamAdapter.server.listen(0, "127.0.0.1", () => resolve()));

  try {
    console.log("\n--- 1. COMPLETE TOOL WORKFLOW (APPROVAL → EXECUTE ONCE → FINAL) ---");

    const permissionCtrl = new AgentPermissionController();
    permissionCtrl.setMode("ask");

    const runtime = new AgentExecutionRuntime({
      projectId: "proj-logicc-e2e",
      generation: 1,
      controller: permissionCtrl,
      executeTool: async (name): Promise<AgentToolResult<unknown>> => {
        toolExecuted += 1;
        assert(name === "write_file", "Executable tool is write_file");
        return { ok: true, data: { path: "hello.txt", size: 11 } };
      },
      scheduleDrain: (fn) => queueMicrotask(fn),
    });

    const transport = new HttpAgentTransport({
      endpoint: streamAdapter.getUrl(),
      credentialMode: "server-owned",
      // Intentionally provide a stale key getter — must not be sent.
      getApiKey: () => STALE_BROWSER_BYOK,
      getModel: () => "gpt-4o",
    });

    const orchestrator = new AgentOrchestrator({
      projectId: "proj-logicc-e2e",
      generation: 1,
      runtime,
      transport,
    });

    orchestrator.submitRun("Create hello.txt");
    const stateAfterTurn1 = await waitForState(
      orchestrator,
      (s) => s === "waiting-for-approval" || s === "failed",
      5000,
    );
    assert(
      stateAfterTurn1 === "waiting-for-approval",
      `Paused at waiting-for-approval (actual: ${stateAfterTurn1})`,
    );

    const pending = permissionCtrl.getPending();
    assert(pending.length === 1, "Exactly one M3.6 approval pending");
    permissionCtrl.approve(pending[0].approvalId, 1);

    const activeAtt = runtime.getActiveHead();
    assert(activeAtt !== null, "Active execution attempt present");
    await runtime.resume(activeAtt!.attemptId);

    const stateAfterTurn2 = await waitForState(
      orchestrator,
      (s) => s === "completed" || s === "failed",
      5000,
    );
    assert(
      stateAfterTurn2 === "completed",
      `Run completed after continuation (actual: ${stateAfterTurn2})`,
    );
    assert(toolExecuted === 1, "Tool executes exactly once through M3.6/M3.7");
    assert(
      receivedAuth === `Bearer ${SYNTHETIC_LOGICC_KEY}`,
      "Server-owned Logicc credential used upstream",
    );

    const messages = orchestrator.getMessages();
    assert(
      messages.length === 4,
      "Conversation has user, assistant tool-call, tool result, final assistant",
    );
    assert(messages[0].role === "user", "Message 1 user");
    assert(messages[1].role === "assistant", "Message 2 assistant tool request");
    assert(messages[2].role === "tool", "Message 3 tool result");
    assert(messages[3].role === "assistant", "Message 4 final assistant");
    assertAbsent("orchestrator transcript", messages);
    assertAbsent("health-like status", adapter.getSafeHealth());

    console.log("\n--- 2. CANCELLATION ---");
    turnCount = 0;
    const cancelOrch = new AgentOrchestrator({
      projectId: "proj-logicc-cancel",
      generation: 1,
      runtime: new AgentExecutionRuntime({
        projectId: "proj-logicc-cancel",
        generation: 1,
        controller: new AgentPermissionController(),
        executeTool: async () => ({ ok: true, data: {} }),
        scheduleDrain: (fn) => queueMicrotask(fn),
      }),
      transport,
    });
    cancelOrch.submitRun("cancel please");
    await new Promise((r) => setTimeout(r, 5));
    cancelOrch.cancel();
    const cancelState = await waitForState(
      cancelOrch,
      (s) => s === "cancelled" || s === "failed" || s === "completed" || s === "idle",
      3000,
    );
    assert(
      cancelState === "cancelled" || cancelState === "failed" || cancelState === "idle",
      `Cancellation reaches a settled state (actual: ${cancelState})`,
    );

    console.log("\n--- 3. PUBLIC ACCESS FAILS CLOSED ---");
    const restrictedAdapter = createLogiccAdapter({
      env: {
        LOGICC_API_KEY: SYNTHETIC_LOGICC_KEY,
        LOGICC_ALLOWED_MODELS: "gpt-4o",
        LOGICC_DEFAULT_MODEL: "gpt-4o",
      },
      fixedApprovedModels: [{ id: "gpt-4o", displayName: "gpt-4o" }],
      fixedDefaultModelId: "gpt-4o",
    });
    const restrictedHandler = createAgentStreamHandler({
      fetchUpstream: async () => new Response("nope"),
      clock: () => Date.now(),
      scheduleTimeout: (fn, ms) => setTimeout(fn, ms),
      cancelTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      limits: defaultStreamLimits,
      concurrency: createConcurrencyGate(2),
      provider: restrictedAdapter,
      skipSameOriginCheck: true,
    });
    const restrictedRes = await restrictedHandler(
      new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: "r",
          turnId: "t",
          requestId: "q",
          projectId: "p",
          generation: 1,
          messages: [
            {
              id: "m",
              role: "user",
              parts: [{ type: "text", text: "hi" }],
              createdAt: 1,
              status: "complete",
            },
          ],
          tools: [],
        }),
      }),
    );
    assert(restrictedRes.status === 403, "Logicc without internal mode returns 403");
    const restrictedJson = (await restrictedRes.json()) as { errorCode?: string };
    assert(restrictedJson.errorCode === "ACCESS_RESTRICTED", "ACCESS_RESTRICTED");
    assertAbsent("restricted json", restrictedJson);

    console.log("==========================================================================");
    console.log(`  SUCCESS: ALL ${passCount} FAKE-LOGICC E2E ASSERTIONS PASSED!`);
    console.log("==========================================================================");
  } finally {
    await streamAdapter.close();
    await new Promise<void>((resolve) => fakeLogicc.close(() => resolve()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
