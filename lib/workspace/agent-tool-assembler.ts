/**
 * Fragmented Tool-Call Assembler & Schema Validator for CoderXP M3.8.
 *
 * Buffers and validates incremental tool calls emitted across arbitrary chunk
 * boundaries by streaming model transports.
 *
 * Invariants:
 * - Rejects malformed JSON, non-object arguments, missing required fields.
 * - Rejects path traversal and invalid workspace paths via normalizeAndValidateWorkspacePath.
 * - Enforces strict 64 KB UTF-8 byte limits using TextEncoder.
 * - Rejects out-of-order assembler transitions (deltas before start or after completion).
 * - Never mutates assembled argument objects.
 */

import {
  AGENT_TOOLS,
  getAgentTool,
  type AgentToolDefinition,
} from "./agent-tools";
import { normalizeAndValidateWorkspacePath } from "./path-utils";

/** Maximum allowed assembled argument size in UTF-8 bytes (64 KB). */
export const MAX_ASSEMBLED_ARGUMENT_BYTES = 64 * 1024;

export type ToolAssemblerErrorCode =
  | "UNKNOWN_TOOL"
  | "INVALID_PARAMS"
  | "ARGUMENT_LIMIT_EXCEEDED"
  | "PROTOCOL_ERROR";

export interface ToolAssemblerError {
  code: ToolAssemblerErrorCode;
  message: string;
}

export type ToolAssemblerResult =
  | { ok: true; name: string; args: Record<string, unknown> }
  | { ok: false; error: ToolAssemblerError };

interface InFlightToolCall {
  toolCallId: string;
  toolName: string;
  argumentBuffer: string;
  utf8ByteLength: number;
  isCompleted: boolean;
}

const utf8Encoder = new TextEncoder();

/**
 * Validates assembled tool arguments against the canonical tool definition.
 * Does not mutate the input argument object.
 */
export function validateToolArguments(
  toolName: string,
  args: Record<string, unknown>,
): { ok: true } | { ok: false; error: ToolAssemblerError } {
  const definition = getAgentTool(toolName);
  if (!definition) {
    return {
      ok: false,
      error: {
        code: "UNKNOWN_TOOL",
        message: `Tool "${toolName}" is not registered in canonical tool manifest.`,
      },
    };
  }

  // Check required parameters and basic types
  for (const param of definition.parameters) {
    const val = args[param.name];
    if (param.required && (val === undefined || val === null)) {
      return {
        ok: false,
        error: {
          code: "INVALID_PARAMS",
          message: `Missing required parameter "${param.name}" for tool "${toolName}".`,
        },
      };
    }

    if (val !== undefined && val !== null) {
      if (param.type === "string" && typeof val !== "string") {
        return {
          ok: false,
          error: {
            code: "INVALID_PARAMS",
            message: `Parameter "${param.name}" for tool "${toolName}" must be a string.`,
          },
        };
      }
      if (param.type === "number" && typeof val !== "number") {
        return {
          ok: false,
          error: {
            code: "INVALID_PARAMS",
            message: `Parameter "${param.name}" for tool "${toolName}" must be a number.`,
          },
        };
      }
      if (param.type === "boolean" && typeof val !== "boolean") {
        return {
          ok: false,
          error: {
            code: "INVALID_PARAMS",
            message: `Parameter "${param.name}" for tool "${toolName}" must be a boolean.`,
          },
        };
      }
      if (param.type === "string[]") {
        if (!Array.isArray(val) || !val.every((item) => typeof item === "string")) {
          return {
            ok: false,
            error: {
              code: "INVALID_PARAMS",
              message: `Parameter "${param.name}" for tool "${toolName}" must be an array of strings.`,
            },
          };
        }
      }
      if (param.type === "object") {
        if (typeof val !== "object" || Array.isArray(val)) {
          return {
            ok: false,
            error: {
              code: "INVALID_PARAMS",
              message: `Parameter "${param.name}" for tool "${toolName}" must be an object.`,
            },
          };
        }
      }
    }
  }

  // Path validation for filesystem tools
  if (definition.category === "filesystem") {
    for (const pathKey of ["path", "from", "to"]) {
      const rawPath = args[pathKey];
      if (typeof rawPath === "string" && rawPath.length > 0) {
        try {
          normalizeAndValidateWorkspacePath(rawPath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Invalid workspace path";
          return {
            ok: false,
            error: {
              code: "INVALID_PARAMS",
              message: `Invalid path in "${pathKey}": ${msg}`,
            },
          };
        }
      }
    }

    if (Array.isArray(args.paths)) {
      for (const p of args.paths) {
        if (typeof p === "string" && p.length > 0) {
          try {
            normalizeAndValidateWorkspacePath(p);
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Invalid workspace path";
            return {
              ok: false,
              error: {
                code: "INVALID_PARAMS",
                message: `Invalid path in "paths": ${msg}`,
              },
            };
          }
        }
      }
    }
  }

  return { ok: true };
}

/**
 * Manages incremental assembly of fragmented tool calls for an assistant turn.
 */
export class ToolCallAssembler {
  private inFlight = new Map<string, InFlightToolCall>();
  private orderedToolCallIds: string[] = [];

  /**
   * Records the start of a tool call.
   */
  startToolCall(
    toolCallId: string,
    toolName: string,
  ): { ok: true } | { ok: false; error: ToolAssemblerError } {
    if (!toolCallId || typeof toolCallId !== "string") {
      return {
        ok: false,
        error: {
          code: "PROTOCOL_ERROR",
          message: "toolCallId must be a non-empty string.",
        },
      };
    }
    if (!toolName || typeof toolName !== "string" || toolName.trim().length === 0) {
      return {
        ok: false,
        error: {
          code: "PROTOCOL_ERROR",
          message: "toolName must be a non-empty string.",
        },
      };
    }
    if (this.inFlight.has(toolCallId)) {
      return {
        ok: false,
        error: {
          code: "PROTOCOL_ERROR",
          message: `Duplicate tool-call-started event for toolCallId "${toolCallId}".`,
        },
      };
    }

    this.inFlight.set(toolCallId, {
      toolCallId,
      toolName,
      argumentBuffer: "",
      utf8ByteLength: 0,
      isCompleted: false,
    });
    this.orderedToolCallIds.push(toolCallId);
    return { ok: true };
  }

  /**
   * Appends an argument chunk to an in-flight tool call.
   */
  appendArgumentChunk(
    toolCallId: string,
    chunk: string,
  ): { ok: true } | { ok: false; error: ToolAssemblerError } {
    const call = this.inFlight.get(toolCallId);
    if (!call) {
      return {
        ok: false,
        error: {
          code: "PROTOCOL_ERROR",
          message: `Argument chunk received for unstarted toolCallId "${toolCallId}".`,
        },
      };
    }
    if (call.isCompleted) {
      return {
        ok: false,
        error: {
          code: "PROTOCOL_ERROR",
          message: `Argument chunk received for already completed toolCallId "${toolCallId}".`,
        },
      };
    }

    const chunkBytes = utf8Encoder.encode(chunk).length;
    if (call.utf8ByteLength + chunkBytes > MAX_ASSEMBLED_ARGUMENT_BYTES) {
      return {
        ok: false,
        error: {
          code: "ARGUMENT_LIMIT_EXCEEDED",
          message: `Assembled argument size exceeded maximum limit of ${MAX_ASSEMBLED_ARGUMENT_BYTES} bytes.`,
        },
      };
    }

    call.argumentBuffer += chunk;
    call.utf8ByteLength += chunkBytes;
    return { ok: true };
  }

  /**
   * Marks a tool call assembly as completed.
   */
  completeToolCall(
    toolCallId: string,
  ): { ok: true } | { ok: false; error: ToolAssemblerError } {
    const call = this.inFlight.get(toolCallId);
    if (!call) {
      return {
        ok: false,
        error: {
          code: "PROTOCOL_ERROR",
          message: `Completion received for unstarted toolCallId "${toolCallId}".`,
        },
      };
    }
    if (call.isCompleted) {
      return {
        ok: false,
        error: {
          code: "PROTOCOL_ERROR",
          message: `Duplicate completion received for toolCallId "${toolCallId}".`,
        },
      };
    }

    call.isCompleted = true;
    return { ok: true };
  }

  /**
   * Returns all started tool call IDs in the exact order they were started.
   */
  getStartedToolCallIds(): string[] {
    return [...this.orderedToolCallIds];
  }

  /**
   * Validates and returns all assembled tool calls.
   * Fails if any started tool call was not marked completed or fails schema validation.
   */
  finalizeAll():
    | { ok: true; calls: Array<{ toolCallId: string; name: string; args: Record<string, unknown> }> }
    | { ok: false; error: ToolAssemblerError } {
    const results: Array<{ toolCallId: string; name: string; args: Record<string, unknown> }> = [];

    for (const id of this.orderedToolCallIds) {
      const call = this.inFlight.get(id);
      if (!call || !call.isCompleted) {
        return {
          ok: false,
          error: {
            code: "PROTOCOL_ERROR",
            message: `Tool call "${id}" (${call?.toolName ?? "unknown"}) was started but not completed.`,
          },
        };
      }

      const rawJson = call.argumentBuffer.trim();
      let parsed: unknown;

      if (rawJson.length === 0) {
        parsed = {};
      } else {
        try {
          parsed = JSON.parse(rawJson);
        } catch {
          return {
            ok: false,
            error: {
              code: "PROTOCOL_ERROR",
              message: `Malformed JSON arguments in tool call "${id}" (${call.toolName}).`,
            },
          };
        }
      }

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {
          ok: false,
          error: {
            code: "PROTOCOL_ERROR",
            message: `Arguments for tool call "${id}" (${call.toolName}) must be a plain JSON object.`,
          },
        };
      }

      const argsRecord = parsed as Record<string, unknown>;
      const validation = validateToolArguments(call.toolName, argsRecord);
      if (!validation.ok) {
        return validation;
      }

      results.push({
        toolCallId: id,
        name: call.toolName,
        args: argsRecord,
      });
    }

    return { ok: true, calls: results };
  }

  /**
   * Resets all in-flight buffers.
   */
  clear(): void {
    this.inFlight.clear();
    this.orderedToolCallIds = [];
  }
}
