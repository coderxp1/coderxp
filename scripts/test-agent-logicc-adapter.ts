/**
 * Deterministic Logicc OpenAI-compatible adapter harness.
 *
 * Coverage index (streaming):
 *  1. Text-only response
 *  2. Usage before completion / finish + usage + [DONE]
 *  3. Fragmented arguments
 *  4. Multiple/interleaved tool calls
 *  5. Conflicting index/ID/name
 *  6. Tool arguments before full identity
 *  7. Missing [DONE] after finish_reason (EOF finalize)
 *  8. [DONE] without finish reason
 *  9. Malformed SSE/JSON
 * 10. Premature EOF
 * 11. Exactly one canonical terminal event
 * 12. No events after terminal
 * 13. Manifest parity / unknown / modified / duplicate tools
 * 14. Canonical continuation translation (tool results)
 */

import { CANONICAL_TOOL_MANIFEST, getManifestTool } from "../lib/workspace/agent-tool-manifest";
import { AGENT_TOOLS } from "../lib/workspace/agent-tools";
import {
  LogiccStreamTranslator,
  createLogiccAdapter,
  validateAndTranslateLogiccRequest,
} from "../lib/server/agent-logicc-adapter";
import type {
  AgentTransportEvent,
  AgentTransportRequest,
  CanonicalAgentMessage,
} from "../lib/workspace/agent-transport-types";

const SYNTHETIC_KEY = "cxp-test-logicc-not-a-credential";

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
  assert(!serialized.includes(SYNTHETIC_KEY), `${label} has no credential fixture`);
}

function collectTranslator(): {
  events: AgentTransportEvent[];
  translator: LogiccStreamTranslator;
} {
  const events: AgentTransportEvent[] = [];
  const translator = new LogiccStreamTranslator("req-1", "turn-1", (e) => events.push(e));
  return { events, translator };
}

function terminals(events: AgentTransportEvent[]): AgentTransportEvent[] {
  return events.filter(
    (e) =>
      e.type === "turn-completed" ||
      e.type === "transport-error" ||
      e.type === "transport-cancelled",
  );
}

async function main(): Promise<void> {
  console.log("==========================================================================");
  console.log("              LOGICC ADAPTER & STREAM TRANSLATOR HARNESS                  ");
  console.log("==========================================================================");

  // --- Manifest parity ---
  console.log("\n--- Tool manifest parity ---");
  assert(CANONICAL_TOOL_MANIFEST.length === AGENT_TOOLS.length, "Exact registry parity count");
  for (const tool of AGENT_TOOLS) {
    const m = getManifestTool(tool.name);
    assert(!!m, `Manifest has ${tool.name}`);
    assert(m!.risk === tool.risk, `Risk parity ${tool.name}`);
    assert(m!.requiresApproval === tool.requiresApproval, `Approval parity ${tool.name}`);
  }

  const approved = [
    { id: "gpt-4o", displayName: "gpt-4o" },
    { id: "gpt-4o-mini", displayName: "gpt-4o-mini" },
  ];

  const baseMessages: CanonicalAgentMessage[] = [
    {
      id: "sys",
      role: "system",
      parts: [{ type: "system-context", text: "You are a coding assistant." }],
      createdAt: 1,
      status: "complete",
    },
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "List files." }],
      createdAt: 2,
      status: "complete",
    },
  ];

  const baseRequest: AgentTransportRequest = {
    runId: "run-1",
    turnId: "turn-1",
    requestId: "req-1",
    projectId: "proj-1",
    generation: 1,
    messages: baseMessages,
    tools: [CANONICAL_TOOL_MANIFEST.find((t) => t.name === "list_files")!],
  };

  // --- Translation ---
  console.log("\n--- Canonical message translation ---");
  const translated = validateAndTranslateLogiccRequest(baseRequest, {
    approvedModels: approved,
    defaultModelId: "gpt-4o",
  });
  assert(translated.ok === true, "Valid request translates");
  if (translated.ok) {
    const body = translated.body as {
      model: string;
      n: number;
      stream: boolean;
      messages: Array<{ role: string; content?: string | null; tool_calls?: unknown[] }>;
      tools?: Array<{ type: string; function: { name: string; parameters: unknown } }>;
    };
    assert(body.model === "gpt-4o", "Model id applied");
    assert(body.n === 1, "n restricted to 1");
    assert(body.stream === true, "stream true");
    assert(body.messages[0]?.role === "system", "System-message placement first");
    assert(body.messages[1]?.role === "user", "User follows system");
    assert(body.tools?.length === 1, "One tool from manifest");
    assert(body.tools?.[0]?.function.name === "list_files", "Tool name from manifest");
    assertAbsent("translated body", body);
  }

  // Unknown tool
  const unknownTool = validateAndTranslateLogiccRequest(
    {
      ...baseRequest,
      tools: [
        {
          name: "hack_tool",
          category: "filesystem",
          risk: "read",
          summary: "x",
          parameters: [],
          requiresApproval: false,
        },
      ],
    },
    { approvedModels: approved, defaultModelId: "gpt-4o" },
  );
  assert(unknownTool.ok === false, "Unknown tools rejected");

  // Modified tool
  const listFiles = CANONICAL_TOOL_MANIFEST.find((t) => t.name === "list_files")!;
  const modified = validateAndTranslateLogiccRequest(
    {
      ...baseRequest,
      tools: [{ ...listFiles, risk: "destructive" }],
    },
    { approvedModels: approved, defaultModelId: "gpt-4o" },
  );
  assert(modified.ok === false, "Modified schemas/metadata rejected");

  // Duplicate tools
  const dup = validateAndTranslateLogiccRequest(
    { ...baseRequest, tools: [listFiles, listFiles] },
    { approvedModels: approved, defaultModelId: "gpt-4o" },
  );
  assert(dup.ok === false, "Duplicate tools rejected");

  // Excessive tools
  const many = validateAndTranslateLogiccRequest(
    {
      ...baseRequest,
      tools: Array.from({ length: 25 }, (_, i) => ({
        ...listFiles,
        name: i === 0 ? "list_files" : (`list_files` as typeof listFiles.name),
      })),
    },
    { approvedModels: approved, defaultModelId: "gpt-4o" },
  );
  assert(many.ok === false, "Excessive tool counts rejected");

  // Continuation flow
  const continuation: CanonicalAgentMessage[] = [
    ...baseMessages,
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-request",
          toolCallId: "call_1",
          name: "list_files",
          args: {},
        },
      ],
      createdAt: 3,
      status: "complete",
    },
    {
      id: "t1",
      role: "tool",
      parts: [
        {
          type: "tool-result",
          envelope: {
            toolCallId: "call_1",
            toolName: "list_files",
            attemptId: "att-1",
            status: "succeeded",
            isError: false,
            modelSafeResult: { files: ["a.ts"] },
          },
        },
      ],
      createdAt: 4,
      status: "complete",
    },
  ];
  const cont = validateAndTranslateLogiccRequest(
    { ...baseRequest, messages: continuation },
    { approvedModels: approved, defaultModelId: "gpt-4o" },
  );
  assert(cont.ok === true, "Continuation with tool result translates");
  if (cont.ok) {
    const msgs = (cont.body as { messages: Array<Record<string, unknown>> }).messages;
    const assistant = msgs.find((m) => m.role === "assistant" && m.tool_calls);
    const toolMsg = msgs.find((m) => m.role === "tool");
    assert(!!assistant, "Assistant tool_calls present");
    assert(!!toolMsg, "OpenAI tool message present");
    assert(toolMsg?.tool_call_id === "call_1", "Tool-result correlation");
  }

  // Failed/denied/cancelled/stale results
  for (const status of ["failed", "denied", "cancelled", "stale"] as const) {
    const msgs: CanonicalAgentMessage[] = [
      ...baseMessages,
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "tool-request", toolCallId: "call_x", name: "list_files", args: {} }],
        createdAt: 3,
        status: "complete",
      },
      {
        id: "t1",
        role: "tool",
        parts: [
          {
            type: "tool-result",
            envelope: {
              toolCallId: "call_x",
              toolName: "list_files",
              attemptId: "att",
              status,
              isError: true,
              modelSafeResult: { error: status },
            },
          },
        ],
        createdAt: 4,
        status: "complete",
      },
    ];
    const r = validateAndTranslateLogiccRequest(
      { ...baseRequest, messages: msgs },
      { approvedModels: approved, defaultModelId: "gpt-4o" },
    );
    assert(r.ok === true, `Model-safe ${status} result translates`);
  }

  // Orphan tool result
  const orphan = validateAndTranslateLogiccRequest(
    {
      ...baseRequest,
      messages: [
        ...baseMessages,
        {
          id: "t1",
          role: "tool",
          parts: [
            {
              type: "tool-result",
              envelope: {
                toolCallId: "missing",
                toolName: "list_files",
                attemptId: "a",
                status: "succeeded",
                isError: false,
                modelSafeResult: {},
              },
            },
          ],
          createdAt: 3,
          status: "complete",
        },
      ],
    },
    { approvedModels: approved, defaultModelId: "gpt-4o" },
  );
  assert(orphan.ok === false, "Orphan tool result rejected (no auto-repair)");

  // Duplicate tool result
  const dupResult = validateAndTranslateLogiccRequest(
    {
      ...baseRequest,
      messages: [
        ...baseMessages,
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "tool-request", toolCallId: "call_1", name: "list_files", args: {} }],
          createdAt: 3,
          status: "complete",
        },
        {
          id: "t1",
          role: "tool",
          parts: [
            {
              type: "tool-result",
              envelope: {
                toolCallId: "call_1",
                toolName: "list_files",
                attemptId: "a",
                status: "succeeded",
                isError: false,
                modelSafeResult: {},
              },
            },
          ],
          createdAt: 4,
          status: "complete",
        },
        {
          id: "t2",
          role: "tool",
          parts: [
            {
              type: "tool-result",
              envelope: {
                toolCallId: "call_1",
                toolName: "list_files",
                attemptId: "b",
                status: "succeeded",
                isError: false,
                modelSafeResult: {},
              },
            },
          ],
          createdAt: 5,
          status: "complete",
        },
      ],
    },
    { approvedModels: approved, defaultModelId: "gpt-4o" },
  );
  assert(dupResult.ok === false, "Duplicate tool result rejected");

  // --- Streaming ---
  console.log("\n--- Streaming semantics ---");

  // 1. Text-only
  {
    const { events, translator } = collectTranslator();
    translator.handleDataPayload(
      JSON.stringify({
        choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }],
      }),
    );
    translator.handleDataPayload(
      JSON.stringify({
        choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }],
      }),
    );
    translator.handleDataPayload(
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    );
    translator.handleDataPayload("[DONE]");
    assert(events.some((e) => e.type === "text-delta"), "Text-only emits text-delta");
    assert(events.some((e) => e.type === "usage"), "Usage emitted before terminal");
    assert(terminals(events).length === 1, "Exactly one terminal (text-only)");
    assert(
      terminals(events)[0]?.type === "turn-completed",
      "Terminal is turn-completed",
    );
    const completedIdx = events.findIndex((e) => e.type === "turn-completed");
    const usageIdx = events.findIndex((e) => e.type === "usage");
    assert(usageIdx >= 0 && usageIdx < completedIdx, "Usage before completion");
    assert(
      events.slice(completedIdx + 1).every(
        (e) =>
          e.type !== "text-delta" &&
          e.type !== "tool-call-started",
      ),
      "No content events after terminal",
    );
    assertAbsent("text-only events", events);
  }

  // 3+6. Fragmented args + args before identity
  {
    const { events, translator } = collectTranslator();
    translator.handleDataPayload(
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"path"' } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    assert(
      !events.some((e) => e.type === "tool-call-started"),
      "No tool-call-started before id+name known",
    );
    translator.handleDataPayload(
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  type: "function",
                  function: { name: "read_file", arguments: ':\"x.ts\"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    assert(
      events.filter((e) => e.type === "tool-call-started").length === 1,
      "tool-call-started exactly once",
    );
    assert(
      events.filter((e) => e.type === "tool-call-arguments-delta").length >= 2,
      "Buffered + live argument fragments preserved",
    );
    translator.handleDataPayload(
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }),
    );
    translator.handleDataPayload("[DONE]");
    assert(
      events.filter((e) => e.type === "tool-call-completed").length === 1,
      "tool-call-completed exactly once",
    );
    assert(terminals(events).length === 1, "One terminal after tool call");
  }

  // 4. Multiple/interleaved tool calls
  {
    const { events, translator } = collectTranslator();
    translator.handleDataPayload(
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "c0", type: "function", function: { name: "list_files", arguments: "" } },
                { index: 1, id: "c1", type: "function", function: { name: "read_file", arguments: "" } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    translator.handleDataPayload(
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 1, function: { arguments: '{"path":"a"}' } },
                { index: 0, function: { arguments: "{}" } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    translator.handleDataPayload(
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 1, completion_tokens: 4 },
      }),
    );
    translator.handleDataPayload("[DONE]");
    assert(
      events.filter((e) => e.type === "tool-call-started").length === 2,
      "Two interleaved tool-call-started",
    );
    assert(
      events.filter((e) => e.type === "tool-call-completed").length === 2,
      "Two tool-call-completed",
    );
    assert(terminals(events).length === 1, "One terminal for multi tool");
  }

  // 5. Conflicting identity
  {
    const { events, translator } = collectTranslator();
    translator.handleDataPayload(
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "c0", type: "function", function: { name: "list_files", arguments: "" } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    translator.handleDataPayload(
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "c_other", function: { name: "list_files", arguments: "" } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    assert(terminals(events).length === 1, "Conflict emits one terminal error");
    assert(
      terminals(events)[0]?.type === "transport-error",
      "Conflict is protocol error",
    );
  }

  // Empty name
  {
    const { events, translator } = collectTranslator();
    translator.handleDataPayload(
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "c0", function: { name: "", arguments: "" } }],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    assert(
      terminals(events)[0]?.type === "transport-error",
      "Empty tool name rejected",
    );
  }

  // 7. Missing [DONE] — EOF after finish_reason
  {
    const { events, translator } = collectTranslator();
    translator.handleDataPayload(
      JSON.stringify({
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    assert(terminals(events).length === 0, "No terminal before EOF/[DONE]");
    translator.notifyStreamEnded();
    assert(terminals(events).length === 1, "EOF after finish_reason completes");
    assert(events.some((e) => e.type === "usage"), "Usage emitted on EOF finalize");
  }

  // 8. [DONE] without finish reason
  {
    const { events, translator } = collectTranslator();
    translator.handleDataPayload(
      JSON.stringify({
        choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }],
      }),
    );
    translator.handleDataPayload("[DONE]");
    assert(terminals(events).length === 1, "[DONE] without finish → one terminal");
    const err = terminals(events)[0];
    assert(err?.type === "transport-error", "[DONE] without finish is error");
    if (err?.type === "transport-error") {
      assert(err.code === "UPSTREAM_PROTOCOL_ERROR", "UPSTREAM_PROTOCOL_ERROR code");
    }
  }

  // 9. Malformed JSON
  {
    const { events, translator } = collectTranslator();
    translator.handleDataPayload("{not-json");
    assert(terminals(events).length === 1, "Malformed JSON → one terminal");
    if (terminals(events)[0]?.type === "transport-error") {
      assert(
        (terminals(events)[0] as { code: string }).code === "UPSTREAM_PROTOCOL_ERROR",
        "Malformed → PROTOCOL_ERROR",
      );
    }
  }

  // 10. Premature EOF
  {
    const { events, translator } = collectTranslator();
    translator.handleDataPayload(
      JSON.stringify({
        choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
      }),
    );
    translator.notifyStreamEnded();
    const err = terminals(events)[0];
    assert(err?.type === "transport-error", "Premature EOF is error");
    if (err?.type === "transport-error") {
      assert(err.code === "UPSTREAM_PREMATURE_CLOSE", "UPSTREAM_PREMATURE_CLOSE");
    }
  }

  // Arguments after completion
  {
    const { events, translator } = collectTranslator();
    translator.handleDataPayload(
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "c0", type: "function", function: { name: "list_files", arguments: "{}" } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    translator.handleDataPayload(
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }),
    );
    // After finish, tool is completed; further args for same index should fail
    // (finish already completed tracks — send another chunk before DONE)
    // Actually after finish_reason, tracks are completed. A new delta with args:
    translator.handleDataPayload(
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: "extra" } }],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    assert(
      events.some(
        (e) => e.type === "transport-error" && e.code === "UPSTREAM_PROTOCOL_ERROR",
      ),
      "Arguments after completion rejected",
    );
  }

  // Adapter wiring smoke
  const adapter = createLogiccAdapter({
    env: {
      LOGICC_API_KEY: SYNTHETIC_KEY,
      LOGICC_INTERNAL_MODE: "true",
      LOGICC_ALLOWED_MODELS: "gpt-4o",
      LOGICC_DEFAULT_MODEL: "gpt-4o",
    },
    fixedApprovedModels: approved,
    fixedDefaultModelId: "gpt-4o",
  });
  const health = adapter.getSafeHealth();
  assertAbsent("adapter health", health);

  console.log(`\nSUCCESS: ALL ${passCount} LOGICC ADAPTER ASSERTIONS PASSED!`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
