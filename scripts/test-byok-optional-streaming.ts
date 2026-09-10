import assert from "node:assert/strict";
import { HttpAgentTransport } from "../lib/workspace/agent-http-transport";
import type { AgentTransportRequest, AgentTransportEvent } from "../lib/workspace/agent-transport-types";

async function run() {
  console.log("=== RUNNING BYOK OPTIONAL STREAMING REGRESSION TESTS ===");

  const originalFetch = globalThis.fetch;

  try {
    // Test 1: In Logicc/internal mode (getApiKey returns null), HttpAgentTransport does NOT reject client-side
    console.log("--- 1. Null Key in Server-Managed Mode ---");

    // Mock server response stream returning valid text deltas
    (globalThis as any).fetch = async (url: string, init: any) => {
      assert.equal(url, "/api/agent/stream", "dispatched to /api/agent/stream");
      assert.equal(init.headers["x-coderxp-byok-key"], undefined, "no byok header sent when key is null");

      const encoder = new TextEncoder();
      const sseData = [
        'event: turn-started\ndata: {"type":"turn-started","eventId":"evt-1","sequence":0,"turnId":"turn-1","requestId":"req-1","timestamp":1000}\n\n',
        'event: text-delta\ndata: {"type":"text-delta","eventId":"evt-2","sequence":1,"turnId":"turn-1","requestId":"req-1","text":"Hello from Logicc","timestamp":1001}\n\n',
        'event: turn-completed\ndata: {"type":"turn-completed","eventId":"evt-3","sequence":2,"turnId":"turn-1","requestId":"req-1","stopReason":"end_turn","metrics":{"inputTokens":10,"outputTokens":5},"timestamp":1002}\n\n',
      ].join("");

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData));
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const transport = new HttpAgentTransport({
      getApiKey: () => null, // Server owns credentials (Logicc mode)
    });

    const request: AgentTransportRequest = {
      runId: "run-1",
      turnId: "turn-1",
      requestId: "req-1",
      projectId: "proj-1",
      generation: 1,
      messages: [{ id: "m-1", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 1000, status: "complete" }],
      tools: [],
    };

    const controller = new AbortController();
    const events: AgentTransportEvent[] = [];

    for await (const event of transport.send(request, controller.signal)) {
      events.push(event);
    }

    console.log("RECEIVED EVENTS:", JSON.stringify(events));
    assert.equal(events.length, 3, "Received 3 SSE events (turn-started, text-delta, turn-completed)");
    assert.equal(events[0].type, "turn-started", "First event is turn-started");
    assert.equal(events[1].type, "text-delta", "Second event is text-delta");
    assert.equal((events[1] as any).text, "Hello from Logicc", "Streamed text received cleanly");
    assert.equal(events[2].type, "turn-completed", "Third event is turn-completed");

    console.log("[PASS] Server-managed Logicc mode streams tokens without requiring client BYOK key.");

    // Test 2: Client provided key is passed in header
    console.log("--- 2. Provided Key Passed in Header ---");

    let receivedHeader: string | undefined;
    (globalThis as any).fetch = async (url: string, init: any) => {
      receivedHeader = init.headers["x-coderxp-byok-key"];
      const encoder = new TextEncoder();
      const sseData = 'event: turn-completed\ndata: {"type":"turn-completed","eventId":"e","sequence":0,"turnId":"turn-2","requestId":"req-2","stopReason":"end_turn","metrics":{},"timestamp":1000}\n\n';
      return new Response(new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(sseData));
          c.close();
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    const byokTransport = new HttpAgentTransport({
      getApiKey: () => "sk-ant-test-key-12345",
    });

    for await (const _ of byokTransport.send({ ...request, turnId: "turn-2", requestId: "req-2" }, controller.signal)) {
      // consume
    }

    assert.equal(receivedHeader, "sk-ant-test-key-12345", "BYOK key passed in x-coderxp-byok-key header");
    console.log("[PASS] Client BYOK key forwarded correctly when present.");

    console.log("=== ALL BYOK STREAMING REGRESSION TESTS PASSED ===");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
