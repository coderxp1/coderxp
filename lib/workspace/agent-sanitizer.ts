/**
 * Security sanitization and 4-tier disclosure policies for CoderXP M3.7.
 *
 * This module enforces strict boundaries between:
 * 1. Internal raw results (transient, private to runtime/adapters)
 * 2. Model-facing results (allowlisted per-tool structured fields, secret-sanitized, size-capped)
 * 3. User-facing results (human-readable summaries with secrets and long outputs redacted)
 * 4. Diagnostics and errors (sanitized logs; never leaking credentials or raw payloads)
 *
 * Implements recursive deep-cloning and freezing for immutable event snapshots.
 */

import {
  sanitizeString,
  summarizeToolCall,
  fingerprintArgs,
} from "./agent-permissions";
import type { AgentToolResult, AgentToolError } from "./agent-tools";

// ---------------------------------------------------------------------------
// Constants & Limits
// ---------------------------------------------------------------------------

export const MAX_MODEL_OUTPUT_BYTES = 32 * 1024; // 32KB limit for model output
export const MAX_USER_SUMMARY_BYTES = 16 * 1024; // 16KB limit for transcript preview

const TRUNCATION_NOTICE = "\n[... truncated by security policy ...]";

// ---------------------------------------------------------------------------
// Deep Cloning & Immutability
// ---------------------------------------------------------------------------

/**
 * Recursively deep clones a plain object/array and freezes every level.
 * Prevents subsequent mutations of source objects from altering recorded event history.
 */
export function deepFreezeSafeSnapshot<T>(data: T): Readonly<T> {
  if (data === null || typeof data !== "object") {
    return data;
  }

  if (Array.isArray(data)) {
    const clone = data.map((item) => deepFreezeSafeSnapshot(item));
    return Object.freeze(clone) as unknown as Readonly<T>;
  }

  const record = data as Record<string, unknown>;
  const clone: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    // Drop unrepresentable primitives like functions/symbols
    if (typeof value === "function" || typeof value === "symbol") {
      continue;
    }
    clone[key] = deepFreezeSafeSnapshot(value);
  }

  return Object.freeze(clone) as unknown as Readonly<T>;
}

// ---------------------------------------------------------------------------
// Safe Truncation & String Scrubbing
// ---------------------------------------------------------------------------

export function truncateAndSanitize(
  text: string,
  maxBytes: number = MAX_MODEL_OUTPUT_BYTES,
): string {
  if (!text || typeof text !== "string") return "";
  const sanitized = sanitizeString(text);
  if (sanitized.length <= maxBytes) {
    return sanitized;
  }
  const keep = Math.max(0, maxBytes - TRUNCATION_NOTICE.length);
  return sanitized.slice(0, keep) + TRUNCATION_NOTICE;
}

// ---------------------------------------------------------------------------
// Tier 2: Model-Facing Tool Result Disclosure Policy
// ---------------------------------------------------------------------------

export interface ModelFacingToolResult {
  ok: boolean;
  tool: string;
  data?: Readonly<Record<string, unknown>>;
  error?: Readonly<AgentToolError>;
}

/**
 * Projects a raw tool result into a safe, allowlisted, secret-redacted model-facing payload.
 *
 * Never passes raw command line env maps or unscrubbed credential blocks.
 */
export function projectModelFacingResult(
  toolName: string,
  result: AgentToolResult<unknown> | { ok: false; error?: { code?: string; message?: string } },
): ModelFacingToolResult {
  if (!result || !result.ok) {
    const err = (result as any)?.error;
    return {
      ok: false,
      tool: toolName,
      error: {
        code: (err?.code as any) || "TOOL_ERROR",
        message: truncateAndSanitize(err?.message || "Tool execution failed", 1024),
      },
    };
  }

  const rawData = result.data;
  let safeData: Record<string, unknown> = {};

  if (rawData && typeof rawData === "object" && !Array.isArray(rawData)) {
    const rec = rawData as Record<string, unknown>;

    switch (toolName) {
      case "read_file":
        safeData = {
          path: typeof rec.path === "string" ? rec.path : undefined,
          bytes: typeof rec.bytes === "number" ? rec.bytes : undefined,
          content:
            typeof rec.content === "string"
              ? truncateAndSanitize(rec.content, MAX_MODEL_OUTPUT_BYTES)
              : undefined,
        };
        break;

      case "read_files":
        if (Array.isArray(rec.files)) {
          safeData = {
            files: rec.files.slice(0, 50).map((f) => ({
              path: typeof f?.path === "string" ? f.path : "",
              bytes: typeof f?.bytes === "number" ? f.bytes : 0,
              content:
                typeof f?.content === "string"
                  ? truncateAndSanitize(f.content, 8192)
                  : "",
            })),
          };
        }
        break;

      case "list_files":
        if (Array.isArray(rec.entries)) {
          safeData = {
            entries: rec.entries.slice(0, 500).map((e) => ({
              path: typeof e?.path === "string" ? e.path : "",
              kind: e?.kind === "directory" ? "directory" : "file",
              size: typeof e?.size === "number" ? e.size : undefined,
            })),
          };
        }
        break;

      case "create_file":
      case "write_file":
      case "apply_patch":
      case "rename_file":
      case "delete_file":
        safeData = {
          path: typeof rec.path === "string" ? rec.path : undefined,
          success: rec.success === true,
          bytesWritten: typeof rec.bytesWritten === "number" ? rec.bytesWritten : undefined,
          oldPath: typeof rec.oldPath === "string" ? rec.oldPath : undefined,
          newPath: typeof rec.newPath === "string" ? rec.newPath : undefined,
        };
        break;

      case "run_command":
      case "read_command_output":
        safeData = {
          commandId: typeof rec.commandId === "string" ? rec.commandId : undefined,
          exitCode: typeof rec.exitCode === "number" ? rec.exitCode : null,
          stdout:
            typeof rec.stdout === "string"
              ? truncateAndSanitize(rec.stdout, MAX_MODEL_OUTPUT_BYTES)
              : undefined,
          stderr:
            typeof rec.stderr === "string"
              ? truncateAndSanitize(rec.stderr, MAX_MODEL_OUTPUT_BYTES)
              : undefined,
        };
        break;

      case "start_process":
        safeData = {
          pid: typeof rec.pid === "number" || typeof rec.pid === "string" ? rec.pid : undefined,
          processId: typeof rec.processId === "string" ? rec.processId : undefined,
          port: typeof rec.port === "number" ? rec.port : 3000,
          status: "running",
          output:
            typeof rec.output === "string"
              ? truncateAndSanitize(rec.output, MAX_MODEL_OUTPUT_BYTES)
              : "Server running on port 3000",
        };
        break;

      case "stop_command":
        safeData = {
          commandId: typeof rec.commandId === "string" ? rec.commandId : undefined,
          stopped: rec.stopped === true,
        };
        break;

      case "run_project":
      case "stop_project":
      case "get_runtime_status":
        safeData = {
          state: typeof rec.state === "string" ? rec.state : "unknown",
          mounted: rec.mounted === true,
          previewUrl: typeof rec.previewUrl === "string" ? rec.previewUrl : null,
        };
        break;

      case "run_build":
      case "run_tests":
        safeData = {
          success: rec.success === true,
          exitCode: typeof rec.exitCode === "number" ? rec.exitCode : null,
          summary:
            typeof rec.summary === "string"
              ? truncateAndSanitize(rec.summary, 4096)
              : undefined,
        };
        break;

      default:
        // Conservative fallback for unregistered or extended tools
        for (const [k, v] of Object.entries(rec)) {
          if (typeof v === "string") {
            safeData[k] = truncateAndSanitize(v, 4096);
          } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
            safeData[k] = v;
          }
        }
        break;
    }
  }

  return {
    ok: true,
    tool: toolName,
    data: deepFreezeSafeSnapshot(safeData),
  };
}

// ---------------------------------------------------------------------------
// Tier 3: User-Facing Transcript & UI Summaries
// ---------------------------------------------------------------------------

/**
 * Creates a human-readable, secret-redacted summary for tool output.
 */
export function formatUserFacingResultSummary(
  toolName: string,
  result: AgentToolResult<unknown>,
): string {
  if (!result.ok) {
    return `Error: ${sanitizeString(result.error.message)}`;
  }

  const rec = (result.data ?? {}) as Record<string, unknown>;

  switch (toolName) {
    case "read_file":
      return `Read ${rec.bytes ?? 0} bytes from ${sanitizeString(String(rec.path ?? ""))}`;
    case "write_file":
    case "create_file":
      return `Saved ${sanitizeString(String(rec.path ?? ""))}`;
    case "delete_file":
      return `Deleted ${sanitizeString(String(rec.path ?? ""))}`;
    case "rename_file":
      return `Renamed ${sanitizeString(String(rec.oldPath ?? ""))} to ${sanitizeString(String(rec.newPath ?? ""))}`;
    case "apply_patch":
      return `Applied patch to ${sanitizeString(String(rec.path ?? ""))}`;
    case "list_files":
      return `Listed ${Array.isArray(rec.entries) ? rec.entries.length : 0} file entries`;
    case "run_command":
      return `Command finished with exit code ${rec.exitCode ?? 0}`;
    case "start_process":
      return `Server running on port ${rec.port ?? 3000} (pid ${rec.pid ?? "active"})`;
    case "stop_command":
      return `Stopped process ${sanitizeString(String(rec.commandId ?? ""))}`;
    case "read_files":
      return `Read ${Array.isArray(rec.files) ? rec.files.length : 0} files`;
    case "read_command_output":
      return `Read output for command ${sanitizeString(String(rec.commandId ?? ""))}`;
    case "get_runtime_status":
      return `Runtime state: ${sanitizeString(String(rec.state ?? "unknown"))}`;
    case "run_build":
      return `Build ${rec.success ? "succeeded" : "failed"} (exit code ${rec.exitCode ?? 0})`;
    case "run_tests":
      return `Tests ${rec.success ? "passed" : "failed"} (exit code ${rec.exitCode ?? 0})`;
    default:
      return summarizeToolCall(toolName, rec);
  }
}

// ---------------------------------------------------------------------------
// Tier 4: Diagnostics & Safe Error Scrubbing
// ---------------------------------------------------------------------------

/**
 * Formats diagnostic error messages safely without leaking raw tokens or environment variables.
 */
export function formatSafeDiagnostic(err: unknown): string {
  if (err instanceof Error) {
    const cleanMsg = sanitizeString(err.message);
    const cleanStack = err.stack ? sanitizeString(err.stack) : undefined;
    return cleanStack ? `${cleanMsg}\n${cleanStack}` : cleanMsg;
  }
  if (typeof err === "string") {
    return sanitizeString(err);
  }
  return "Unknown internal error";
}

export {
  sanitizeString,
  summarizeToolCall,
  fingerprintArgs,
};
