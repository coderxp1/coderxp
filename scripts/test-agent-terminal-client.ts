/**
 * Agent terminal client — logic tests for the UI-facing layer.
 *
 * Covers the pure/observable behaviour of lib/workspace/agent-runtime-client.ts,
 * which is the code the agent terminal panel depends on:
 *   - SSE record parsing (frame / gap / state, heartbeats ignored)
 *   - live subscription over a real ReadableStream body, including cursor
 *     advance, gap surfacing, backpressure-by-draining, and clean dispose
 *   - outcome rendering that never upgrades uncertainty
 *
 * `fetch` is stubbed; no network is used. The server side of this contract is
 * covered by scripts/test-agent-runtime-authz.ts (section 12) and the live
 * PTY smoke script.
 */
import assert from "node:assert/strict";
import {
  AgentRuntimeClient,
  AgentRuntimeError,
  describeOutcome,
  dispatchSse,
  type AgentExecOutcome,
  type AgentStreamFrame,
} from "../lib/workspace/agent-runtime-client";

function collected() {
  return {
    frames: [] as AgentStreamFrame[],
    gaps: [] as Array<{ fromSeq: number; toSeq: number; reason: string }>,
    states: [] as Array<{ state: string; cursor: number }>,
    errors: [] as unknown[],
    closes: 0,
  };
}

function handlers(sink: ReturnType<typeof collected>) {
  return {
    onFrame: (f: AgentStreamFrame) => sink.frames.push(f),
    onGap: (g: { fromSeq: number; toSeq: number; reason: string }) => sink.gaps.push(g),
    onState: (s: { state: string; cursor: number }) => sink.states.push(s),
    onError: (e: unknown) => sink.errors.push(e),
    onClose: () => {
      sink.closes += 1;
    },
  };
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function main(): Promise<void> {
  console.log("=== AGENT TERMINAL CLIENT TESTS ===");

  console.log("--- 1. SSE records parse into typed events ---");
  {
    const sink = collected();
    const h = handlers(sink);
    // Heartbeat/comment lines must be ignored, not treated as data.
    dispatchSse(": heartbeat", h);
    assert.equal(sink.frames.length + sink.gaps.length + sink.states.length, 0, "comments carry no payload");

    dispatchSse('event: frame\ndata: {"seq":1,"ts":10,"stream":"pty","data":"hello"}', h);
    assert.equal(sink.frames.length, 1);
    assert.equal(sink.frames[0].stream, "pty");
    assert.equal(sink.frames[0].data, "hello");

    dispatchSse('event: gap\ndata: {"fromSeq":2,"toSeq":9,"reason":"retention-evicted"}', h);
    assert.equal(sink.gaps.length, 1);
    assert.equal(sink.gaps[0].reason, "retention-evicted");

    dispatchSse('event: state\ndata: {"state":"unknown","cursor":42}', h);
    assert.equal(sink.states.length, 1);
    assert.equal(sink.states[0].state, "unknown", "unknown must pass through unchanged");
    assert.equal(sink.states[0].cursor, 42);

    // Malformed JSON must not throw into the reader loop.
    dispatchSse("event: frame\ndata: {not json", h);
    assert.equal(sink.frames.length, 1, "malformed record is dropped, not fatal");
    console.log("[PASS] frame/gap/state parsed; heartbeats and malformed records ignored.");
  }

  console.log("--- 2. Outcomes never upgrade uncertainty ---");
  {
    const unknown: AgentExecOutcome = {
      kind: "unknown",
      exitCode: null,
      signal: null,
      confirmed: false,
      reconciled: false,
      outputBytes: 0,
      outputTruncated: false,
      durationMs: 1200,
    };
    const text = describeOutcome(unknown);
    assert.ok(text.includes("unknown"), `must stay unknown: ${text}`);
    assert.ok(text.includes("UNCONFIRMED"), `must be labelled unconfirmed: ${text}`);
    assert.ok(text.includes("exit unknown"), `null exit must not become 0: ${text}`);
    assert.ok(!/stopped|success|exit 0/i.test(text), `must not fabricate success: ${text}`);

    const reconciled: AgentExecOutcome = { ...unknown, kind: "completed", exitCode: 0, confirmed: true, reconciled: true };
    const rtext = describeOutcome(reconciled);
    assert.ok(rtext.includes("not re-run"), `replay must be labelled: ${rtext}`);

    const signaled: AgentExecOutcome = { ...unknown, kind: "signaled", signal: "SIGKILL", confirmed: true };
    assert.ok(describeOutcome(signaled).includes("SIGKILL"));
    console.log("[PASS] unknown/unconfirmed/replayed outcomes rendered honestly.");
  }

  console.log("--- 3. Live subscription delivers frames and advances the cursor ---");
  {
    const encoder = new TextEncoder();
    let push: ((chunk: string) => void) | null = null;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        push = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      },
    });
    const realFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      // Faithful to real fetch: aborting the signal tears down the body, which
      // is how the client learns the subscription ended.
      const signal = init?.signal;
      if (signal) {
        const onAbort = () => {
          try {
            streamController?.error(new Error("aborted"));
          } catch {
            // already closed
          }
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const client = new AgentRuntimeClient({ projectId: "demo" });
    const sink = collected();
    try {
      const dispose = client.subscribe("sessA", 7, handlers(sink), "op-sub-1");
      await waitFor(() => push !== null, "stream start");
      assert.ok(requestedUrl.includes("cursor=7"), `must resume at the server cursor: ${requestedUrl}`);
      assert.ok(requestedUrl.includes("live=1"), "must request the live stream");

      push!('event: state\ndata: {"state":"running","cursor":7}\n\n');
      push!('event: frame\ndata: {"seq":7,"ts":1,"stream":"exec-stdout","data":"a"}\n\n');
      push!('event: frame\ndata: {"seq":8,"ts":2,"stream":"exec-stderr","data":"b"}\n\n');
      push!('event: gap\ndata: {"fromSeq":9,"toSeq":12,"reason":"retention-overflow"}\n\n');
      push!('event: frame\ndata: {"seq":13,"ts":3,"stream":"pty","data":"c"}\n\n');
      push!(": heartbeat\n\n");

      await waitFor(() => sink.frames.length === 3, "three frames");
      assert.equal(sink.gaps.length, 1, "gap surfaced verbatim");
      assert.equal(sink.gaps[0].fromSeq, 9);
      assert.equal(sink.gaps[0].toSeq, 12);
      assert.equal(sink.states[0].cursor, 7);
      // Cursor monotonicity: the client must be able to resume past the newest
      // frame it saw, without re-requesting anything already delivered.
      const newest = Math.max(...sink.frames.map((f) => f.seq));
      assert.equal(newest, 13, "newest delivered seq");
      console.log("[PASS] Live frames/gap/state delivered; cursor resumable past seq 13.");

      // Dispose must stop the subscription without throwing.
      dispose();
      await waitFor(() => sink.closes >= 1, "close after dispose");
      const closesAfterDispose = sink.closes;
      try {
        push!('event: frame\ndata: {"seq":14,"ts":4,"stream":"pty","data":"after-dispose"}\n\n');
      } catch {
        // Expected: the body was torn down by the abort.
      }
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(sink.frames.length, 3, "no frames delivered after dispose");
      assert.equal(sink.closes, closesAfterDispose, "close is reported once");
      console.log("[PASS] Dispose stops delivery exactly once.");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log("--- 4. Error responses surface as typed errors ---");
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: "APPROVAL_REQUIRED", message: "approval needed" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const client = new AgentRuntimeClient({ projectId: "demo" });
    try {
      await assert.rejects(
        () => client.status("sessA", "op-err-1"),
        (err: unknown) => {
          assert.ok(err instanceof AgentRuntimeError);
          assert.equal(err.code, "APPROVAL_REQUIRED");
          assert.equal(err.status, 403);
          return true;
        },
      );
      console.log("[PASS] Denials surface as typed AgentRuntimeError with the server code.");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log("=== ALL AGENT TERMINAL CLIENT TESTS PASSED ===");
}

main().catch((err) => {
  console.error("Agent terminal client test failed:", err);
  process.exit(1);
});
