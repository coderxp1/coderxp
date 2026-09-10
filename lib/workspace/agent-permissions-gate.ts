/**
 * The single seam between an agent-requested tool call and the M3.5 registry.
 *
 * `gateAndInvoke` is the only place in the codebase where a permission
 * decision is turned into an execution. It is plain TypeScript, not a hook, so
 * the M3.7 execution loop can drive it from an async loop and the acceptance
 * tests can drive it with no DOM and no React.
 *
 * The shape is deliberately narrow. The caller supplies a controller, one
 * exact call, the generation that is current right now, and an `execute`
 * function that reaches the real handlers. There is no "skip the check" flag
 * and no default that permits execution, so a future caller cannot bypass the
 * layer by omitting an argument — the only way past the gate is to not call
 * this function, which is visible at the call site.
 *
 * Every non-executing path returns a structured, truthful result rather than
 * throwing. M3.7 surfaces these to the model verbatim: the model needs to
 * learn that a denial happened and that nothing was performed, otherwise it
 * will retry the same call forever.
 */

import type { AgentToolResult } from "./agent-tools";
import {
  APPROVAL_DENIED_MESSAGE,
  APPROVAL_STALE_MESSAGE,
  type AgentApprovalRequest,
  type AgentPermissionController,
  type AgentToolCall,
  type PermissionDenialReason,
} from "./agent-permissions";

export type {
  AgentPermissionController,
  AgentToolCall,
} from "./agent-permissions";

/**
 * What happened to one gated call.
 *
 * `executed` is the only variant that carries a tool result, because it is the
 * only variant in which a handler ran. Keeping the others resultless means a
 * caller cannot accidentally read a success value off a denied call.
 */
export type GatedToolOutcome =
  /** The call ran. `result` is the handler's own result, success or failure. */
  | { kind: "executed"; call: AgentToolCall; result: AgentToolResult<unknown> }
  /**
   * Execution paused. Nothing ran. The approval is now pending in the
   * controller and rendered by the approval card; when the user approves,
   * M3.7 calls gateAndInvoke again with the identical call.
   */
  | { kind: "awaiting-approval"; call: AgentToolCall; approval: AgentApprovalRequest }
  /** Refused. Nothing ran. */
  | {
      kind: "denied";
      call: AgentToolCall;
      reason: PermissionDenialReason;
      message: string;
    }
  /** The project or generation moved. Nothing ran. */
  | { kind: "stale"; call: AgentToolCall; message: string };

export interface GateAndInvokeOptions {
  controller: AgentPermissionController;
  /** The exact invocation, including its toolCallId and arguments. */
  call: AgentToolCall;
  /**
   * The generation that is current at this instant.
   *
   * Read once by the caller and passed to both the decision and the execution
   * context, so "approved for this exact call" and the handler's own ownership
   * check refer to the same generation rather than two separate reads that
   * could straddle a project switch.
   */
  generation: number;
  /** Reaches the M3.5 handlers. Called only on an allowed decision. */
  execute: (name: string, params: unknown) => Promise<AgentToolResult<unknown>>;
}

/**
 * Evaluate one call and run it only if the decision allows it.
 *
 * `requestApproval` is used rather than `evaluate` because it collapses the
 * decide-then-record step into one atomic operation. Calling evaluate and then
 * separately recording would leave a window in which two concurrent calls both
 * saw "approval-required" and created two cards for the same invocation;
 * requestApproval is idempotent per exact call, so it cannot.
 */
export async function gateAndInvoke(
  options: GateAndInvokeOptions,
): Promise<GatedToolOutcome> {
  const { controller, call, generation, execute } = options;

  const decision = controller.requestApproval(call, generation);

  if (decision.kind === "denied") {
    return {
      kind: "denied",
      call,
      reason: decision.reason,
      message: decision.message,
    };
  }

  if (decision.kind === "stale") {
    return { kind: "stale", call, message: decision.message };
  }

  if (decision.kind === "pending") {
    return { kind: "awaiting-approval", call, approval: decision.approval };
  }

  const result = await execute(call.name, call.args);
  return { kind: "executed", call, result };
}

/**
 * Renders an outcome as a tool result for the model.
 *
 * M3.7 puts this string in the tool-result block. The wording states plainly
 * that nothing was performed; a vague message would invite the model to assume
 * partial success and build on work that never happened.
 *
 * `awaiting-approval` has no representation here on purpose: a paused call has
 * no result yet, and inventing one would tell the model the call finished.
 */
export function outcomeToToolResult(
  outcome: GatedToolOutcome,
): AgentToolResult<unknown> | null {
  switch (outcome.kind) {
    case "executed":
      return outcome.result;
    case "denied":
      return {
        ok: false,
        error: {
          code: outcome.reason === "UNKNOWN_TOOL" ? "UNKNOWN_TOOL" : "PERMISSION_DENIED",
          message: outcome.message || APPROVAL_DENIED_MESSAGE,
        },
      };
    case "stale":
      return {
        ok: false,
        error: {
          code: "STALE_OWNERSHIP",
          message: outcome.message || APPROVAL_STALE_MESSAGE,
        },
      };
    case "awaiting-approval":
      return null;
  }
}
