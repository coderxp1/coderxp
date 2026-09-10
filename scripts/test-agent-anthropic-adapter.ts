/**
 * Deterministic Test Suite for CoderXP M3.9 Anthropic Adapter & Tool Manifest.
 *
 * Verifies:
 * - 100% parity between executable tool registry and canonical tool manifest
 * - Request validation and canonical -> Anthropic translation
 * - Rejection of unlisted models, invalid parameters, unknown tools, and malformed messages
 * - Single terminal event guard and fail-closed handling for malformed/premature upstream SSE
 * - Multi-block and interleaved content block index tracking
 *
 * Zero external network access, 100% deterministic assertions.
 */

import {
  CANONICAL_TOOL_MANIFEST,
  TOOL_MANIFEST_BY_NAME,
  getManifestTool,
  isValidManifestTool,
} from "../lib/workspace/agent-tool-manifest";
import { AGENT_TOOLS } from "../lib/workspace/agent-tools";
import {
  validateAndTranslateRequest,
  AnthropicStreamTranslator,
  ALLOWED_MODELS,
  DEFAULT_MODEL,
} from "../lib/server/agent-anthropic-adapter";
import type {
  AgentTransportRequest,
  AgentTransportEvent,
  CanonicalAgentMessage,
} from "../lib/workspace/agent-transport-types";

let passCount = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
  passCount++;
  console.log(`[PASS #${passCount}] ${message}`);
}

async function runAnthropicAdapterTests() {
  console.log("==========================================================================");
  console.log("      M3.9 ANTHROPIC ADAPTER & CANONICAL MANIFEST TEST HARNESS            ");
  console.log("==========================================================================");

  // -------------------------------------------------------------------------
  // 1. TOOL MANIFEST PARITY WITH EXECUTABLE REGISTRY
  // -------------------------------------------------------------------------
  console.log("\n--- 1. TOOL MANIFEST PARITY WITH EXECUTABLE REGISTRY ---");

  assert(CANONICAL_TOOL_MANIFEST.length === 17, "Manifest contains exactly 17 tools");
  assert(AGENT_TOOLS.length === 17, "Executable registry contains exactly 17 tools");

  for (const execDef of AGENT_TOOLS) {
    const manifestTool = getManifestTool(execDef.name);
    assert(manifestTool !== undefined, `Manifest contains tool '${execDef.name}'`);
    assert(manifestTool!.category === execDef.category, `Category matches for '${execDef.name}'`);
    assert(manifestTool!.risk === execDef.risk, `Risk matches for '${execDef.name}'`);
    assert(manifestTool!.requiresApproval === execDef.requiresApproval, `Approval requirement matches for '${execDef.name}'`);
    assert(manifestTool!.jsonSchema.type === "object", `JSON Schema is an object for '${execDef.name}'`);
  }

  assert(isValidManifestTool("write_file") === true, "isValidManifestTool returns true for valid tool");
  assert(isValidManifestTool("arbitrary_tool_hack") === false, "isValidManifestTool returns false for unknown tool");

  // -------------------------------------------------------------------------
  // 2. REQUEST VALIDATION & CANONICAL TRANSLATION
  // -------------------------------------------------------------------------
  console.log("\n--- 2. REQUEST VALIDATION & CANONICAL TRANSLATION ---");

  const validCanonicalMessages: CanonicalAgentMessage[] = [
    {
      id: "msg-1",
      role: "system",
      parts: [{ type: "system-context", text: "You are a helpful software engineering assistant." }],
      createdAt: 1000,
      status: "complete",
    },
    {
      id: "msg-2",
      role: "user",
      parts: [{ type: "text", text: "Please create a new file named test.ts." }],
      createdAt: 1001,
      status: "complete",
    },
  ];

  const validRequest: AgentTransportRequest = {
    runId: "run-1",
    turnId: "turn-1",
    requestId: "req-1",
    projectId: "proj-1",
    generation: 1,
    messages: validCanonicalMessages,
    tools: CANONICAL_TOOL_MANIFEST,
  };

  const validResult = validateAndTranslateRequest(validRequest, {
    model: DEFAULT_MODEL,
    temperature: 0.2,
    maxTokens: 2048,
  });

  assert(validResult.ok === true, "Valid request translated successfully");
  if (validResult.ok) {
    assert(validResult.body.model === DEFAULT_MODEL, "Model is set to default model");
    assert(validResult.body.temperature === 0.2, "Temperature is translated");
    assert(validResult.body.max_tokens === 2048, "max_tokens is translated");
    assert(validResult.body.system === "You are a helpful software engineering assistant.", "System prompt translated");
    assert(validResult.body.messages.length === 1, "User message present in Anthropic messages array");
    assert(validResult.body.messages[0].role === "user", "User role mapped correctly");
    assert(validResult.body.tools?.length === CANONICAL_TOOL_MANIFEST.length, "All tools mapped to Anthropic tools format");
    assert(validResult.body.stream === true, "Stream parameter is explicitly true");
  }

  // -------------------------------------------------------------------------
  // 3. PARAMETER REJECTION & NEGATIVE CONTROLS (NO SILENT CLAMPING)
  // -------------------------------------------------------------------------
  console.log("\n--- 3. PARAMETER REJECTION & NEGATIVE CONTROLS ---");

  // 3.1 Unlisted Model Rejection
  const invalidModelResult = validateAndTranslateRequest(validRequest, {
    model: "claude-unapproved-model",
  });
  assert(invalidModelResult.ok === false, "Unlisted model rejected");
  if (!invalidModelResult.ok) {
    assert(invalidModelResult.errorCode === "MODEL_NOT_ALLOWED", "Returns MODEL_NOT_ALLOWED error code");
  }

  // 3.2 Out-of-bounds Temperature Rejection
  const invalidTempResult = validateAndTranslateRequest(validRequest, {
    temperature: 1.5,
  });
  assert(invalidTempResult.ok === false, "Temperature > 1.0 rejected");
  if (!invalidTempResult.ok) {
    assert(invalidTempResult.errorCode === "INVALID_REQUEST", "Returns INVALID_REQUEST for temperature > 1.0");
  }

  // 3.3 Out-of-bounds maxTokens Rejection
  const invalidTokensResult = validateAndTranslateRequest(validRequest, {
    maxTokens: 100000,
  });
  assert(invalidTokensResult.ok === false, "maxTokens > 8192 rejected");
  if (!invalidTokensResult.ok) {
    assert(invalidTokensResult.errorCode === "INVALID_REQUEST", "Returns INVALID_REQUEST for maxTokens > 8192");
  }

  // 3.4 Unknown Tool Rejection
  const invalidToolRequest: AgentTransportRequest = {
    ...validRequest,
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
  };
  const invalidToolResult = validateAndTranslateRequest(invalidToolRequest);
  assert(invalidToolResult.ok === false, "Unknown tool rejected");
  if (!invalidToolResult.ok) {
    assert(invalidToolResult.errorCode === "TOOL_NOT_ALLOWED", "Returns TOOL_NOT_ALLOWED error code");
  }

  // 3.5 Orphaned Tool Result Rejection
  const orphanedToolMessages: CanonicalAgentMessage[] = [
    {
      id: "msg-tool-orphan",
      role: "tool",
      parts: [
        {
          type: "tool-result",
          envelope: {
            toolCallId: "non-existent-call",
            toolName: "write_file",
            attemptId: "att-1",
            status: "succeeded",
            isError: false,
            modelSafeResult: { status: "ok" },
          },
        },
      ],
      createdAt: 1002,
      status: "complete",
    },
  ];
  const orphanRequest: AgentTransportRequest = {
    ...validRequest,
    messages: orphanedToolMessages,
  };
  const orphanResult = validateAndTranslateRequest(orphanRequest);
  assert(orphanResult.ok === false, "Orphaned tool result without prior tool request rejected");
  if (!orphanResult.ok) {
    assert(orphanResult.errorCode === "INVALID_REQUEST", "Returns INVALID_REQUEST error code");
  }

  // -------------------------------------------------------------------------
  // 4. TWO-TURN TOOL REQUEST & RESULT FLOW TRANSLATION
  // -------------------------------------------------------------------------
  console.log("\n--- 4. TWO-TURN TOOL REQUEST & RESULT FLOW TRANSLATION ---");

  const twoTurnMessages: CanonicalAgentMessage[] = [
    {
      id: "msg-user-1",
      role: "user",
      parts: [{ type: "text", text: "Create index.html" }],
      createdAt: 2000,
      status: "complete",
    },
    {
      id: "msg-assistant-1",
      role: "assistant",
      parts: [
        { type: "text", text: "Creating the file now." },
        {
          type: "tool-request",
          toolCallId: "call-100",
          name: "write_file",
          args: { path: "index.html", contents: "<h1>Hello</h1>" },
        },
      ],
      createdAt: 2001,
      status: "complete",
    },
    {
      id: "msg-tool-1",
      role: "tool",
      parts: [
        {
          type: "tool-result",
          envelope: {
            toolCallId: "call-100",
            toolName: "write_file",
            attemptId: "att-100",
            status: "succeeded",
            isError: false,
            modelSafeResult: { ok: true, path: "index.html" },
          },
        },
      ],
      createdAt: 2002,
      status: "complete",
    },
  ];

  const twoTurnRequest: AgentTransportRequest = {
    ...validRequest,
    messages: twoTurnMessages,
  };

  const twoTurnResult = validateAndTranslateRequest(twoTurnRequest);
  assert(twoTurnResult.ok === true, "Two-turn conversation translated successfully");
  if (twoTurnResult.ok) {
    assert(twoTurnResult.body.messages.length === 3, "Anthropic messages contains 3 turns (user, assistant, user-tool-result)");
    const assistantMsg = twoTurnResult.body.messages[1];
    assert(assistantMsg.role === "assistant", "Turn 2 is assistant");
    assert(Array.isArray(assistantMsg.content), "Assistant content is an array of blocks");
    const assistantBlocks = assistantMsg.content as unknown as Array<Record<string, unknown>>;
    assert(assistantBlocks[0].type === "text", "First assistant block is text");
    assert(assistantBlocks[1].type === "tool_use", "Second assistant block is tool_use");
    assert(assistantBlocks[1].id === "call-100", "tool_use id matches toolCallId");

    const toolResultMsg = twoTurnResult.body.messages[2];
    assert(toolResultMsg.role === "user", "Turn 3 tool result is placed in user role for Anthropic API");
    const toolBlocks = toolResultMsg.content as unknown as Array<Record<string, unknown>>;
    assert(toolBlocks[0].type === "tool_result", "Block type is tool_result");
    assert(toolBlocks[0].tool_use_id === "call-100", "tool_use_id matches toolCallId");
    assert(toolBlocks[0].is_error === false, "is_error is false");
  }

  // -------------------------------------------------------------------------
  // 5. ANTHROPIC STREAM TRANSLATOR & CANONICAL SSE EMISSION
  // -------------------------------------------------------------------------
  console.log("\n--- 5. ANTHROPIC STREAM TRANSLATOR & CANONICAL SSE EMISSION ---");

  const emittedEvents: AgentTransportEvent[] = [];
  const translator = new AnthropicStreamTranslator("req-test-1", "turn-test-1", (evt) => {
    emittedEvents.push(evt);
  });

  // Step 1: message_start
  translator.handleAnthropicEvent({ type: "message_start" });
  assert(emittedEvents.length === 1, "Emitted turn-started on message_start");
  assert(emittedEvents[0].type === "turn-started", "First event is turn-started");
  assert(emittedEvents[0].sequence === 1, "turn-started has sequence 1");

  // Step 2: content_block_start for text
  translator.handleAnthropicEvent({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "Hello" },
  });
  assert(emittedEvents.length === 2, "Emitted text-delta for initial text block");
  assert(emittedEvents[1].type === "text-delta" && emittedEvents[1].text === "Hello", "text-delta contains initial text");

  // Step 3: content_block_delta for text
  translator.handleAnthropicEvent({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: " world!" },
  });
  assert(emittedEvents.length === 3, "Emitted text-delta for stream delta");
  assert(emittedEvents[2].type === "text-delta" && emittedEvents[2].text === " world!", "text-delta matches chunk");

  // Step 4: content_block_stop for text
  translator.handleAnthropicEvent({ type: "content_block_stop", index: 0 });

  // Step 5: content_block_start for tool_use
  translator.handleAnthropicEvent({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "call-live-1", name: "read_file" },
  });
  assert(emittedEvents.length === 4, "Emitted tool-call-started");
  assert(
    emittedEvents[3].type === "tool-call-started" &&
      emittedEvents[3].toolCallId === "call-live-1" &&
      emittedEvents[3].toolName === "read_file",
    "tool-call-started event properties match",
  );

  // Step 6: content_block_delta for tool_use (fragmented JSON)
  translator.handleAnthropicEvent({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"path":' },
  });
  translator.handleAnthropicEvent({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '"package.json"}' },
  });
  assert(emittedEvents.length === 6, "Emitted 2 tool-call-arguments-delta events for fragments");
  assert(
    emittedEvents[4].type === "tool-call-arguments-delta" && emittedEvents[4].chunk === '{"path":',
    "Fragment 1 emitted correctly",
  );
  assert(
    emittedEvents[5].type === "tool-call-arguments-delta" && emittedEvents[5].chunk === '"package.json"}',
    "Fragment 2 emitted correctly",
  );

  // Step 7: content_block_stop for tool_use
  translator.handleAnthropicEvent({ type: "content_block_stop", index: 1 });
  assert(emittedEvents.length === 7, "Emitted tool-call-completed");
  assert(
    emittedEvents[6].type === "tool-call-completed" && emittedEvents[6].toolCallId === "call-live-1",
    "tool-call-completed matches toolCallId",
  );

  // Step 8: message_delta with stop_reason: "tool_use"
  translator.handleAnthropicEvent({
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 42 },
  });
  assert(emittedEvents.length === 9, "Emitted usage and turn-completed events");
  assert(emittedEvents[7].type === "usage" && emittedEvents[7].outputTokens === 42, "usage event matches output tokens");
  assert(
    emittedEvents[8].type === "turn-completed" && emittedEvents[8].stopReason === "tool_calls",
    "turn-completed maps stop_reason 'tool_use' to canonical 'tool_calls'",
  );

  // Step 9: message_stop after terminal
  translator.handleAnthropicEvent({ type: "message_stop" });
  assert(emittedEvents.length === 9, "Zero additional events emitted after terminal completed");

  // -------------------------------------------------------------------------
  // 6. FAIL-CLOSED GUARD & SINGLE TERMINAL INVARIANT
  // -------------------------------------------------------------------------
  console.log("\n--- 6. FAIL-CLOSED GUARD & SINGLE TERMINAL INVARIANT ---");

  // 6.1 Malformed block index fails closed with UPSTREAM_PROTOCOL_ERROR
  const errEvents: AgentTransportEvent[] = [];
  const errTranslator = new AnthropicStreamTranslator("req-err-1", "turn-err-1", (evt) => {
    errEvents.push(evt);
  });

  errTranslator.handleAnthropicEvent({
    type: "content_block_delta",
    index: 99, // unknown index
    delta: { type: "text_delta", text: "fail" },
  });

  assert(errEvents.some((e) => e.type === "transport-error"), "Emitted transport-error on unknown block index delta");
  const terminalErr = errEvents.find((e) => e.type === "transport-error");
  assert(terminalErr?.type === "transport-error" && terminalErr.code === "UPSTREAM_PROTOCOL_ERROR", "Error code is UPSTREAM_PROTOCOL_ERROR");

  // Verify post-terminal events are discarded
  errTranslator.handleAnthropicEvent({ type: "message_stop" });
  assert(errEvents.filter((e) => e.type === "transport-error" || e.type === "turn-completed").length === 1, "Exactly one terminal event emitted");

  console.log("==========================================================================");
  console.log(`  SUCCESS: ALL ${passCount} ANTHROPIC ADAPTER & MANIFEST ASSERTIONS PASSED!`);
  console.log("==========================================================================");
}

runAnthropicAdapterTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
