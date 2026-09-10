/**
 * Agent tool permission layer for CoderXP M3.6.
 *
 * This module sits between the future agent execution loop and the M3.5 tool
 * registry. Once M3.7 lands, every tool invocation the agent requests passes
 * through here first:
 *
 *   Agent execution loop (M3.7)
 *             |
 *   Permission controller        <- this file
 *             |
 *   approval decision
 *             |
 *   M3.5 tool registry
 *             |
 *   real filesystem / commands / runtime
 *
 * Two properties make the gate real rather than decorative:
 *
 * 1. The engine evaluates the actual `AgentToolDefinition` from AGENT_TOOLS.
 *    There is no second, handwritten risk table that could drift from the
 *    registry, and an unrecognized name is denied rather than defaulted.
 *
 * 2. An approval authorizes one exact invocation, not a tool name. It is bound
 *    to the project, the project generation, the toolCallId, and a canonical
 *    fingerprint of the arguments. Change any of those and the approval no
 *    longer matches, so it cannot be replayed against a different call.
 */

import {
  getAgentTool,
  type AgentToolDefinition,
  type AgentToolRisk,
} from "./agent-tools";
import { isDestructiveCommand } from "./command-safety";

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export type AgentPermissionMode = "ask" | "auto-safe" | "autonomous";

export const AGENT_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  "ask",
  "auto-safe",
  "autonomous",
] as const;

export const PERMISSION_MODE_LABELS: Record<AgentPermissionMode, string> = {
  ask: "Ask before actions",
  "auto-safe": "Auto-run safe actions",
  autonomous: "Autonomous development",
};

export const PERMISSION_MODE_SHORT_LABELS: Record<AgentPermissionMode, string> = {
  ask: "Ask",
  "auto-safe": "Auto-safe",
  autonomous: "Autonomous",
};

export const PERMISSION_MODE_DESCRIPTIONS: Record<AgentPermissionMode, string> = {
  ask: "Reads run automatically. Everything else waits for your approval.",
  "auto-safe":
    "Reads and file edits run automatically. Commands and deletions wait for approval.",
  autonomous:
    "Reads, edits, and commands run automatically. Deletions and renames still ask.",
};

export const DEFAULT_PERMISSION_MODE: AgentPermissionMode = "autonomous";

export function isPermissionMode(value: unknown): value is AgentPermissionMode {
  return (
    typeof value === "string" &&
    (AGENT_PERMISSION_MODES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type PermissionOutcome = "auto" | "approval";

const POLICY: Record<AgentToolRisk, Record<AgentPermissionMode, PermissionOutcome>> = {
  read: { ask: "auto", "auto-safe": "auto", autonomous: "auto" },
  write: { ask: "approval", "auto-safe": "auto", autonomous: "auto" },
  execute: { ask: "approval", "auto-safe": "approval", autonomous: "auto" },
  destructive: {
    ask: "approval",
    "auto-safe": "approval",
    autonomous: "approval",
  },
};

export function policyFor(
  risk: AgentToolRisk,
  mode: AgentPermissionMode,
): PermissionOutcome {
  return POLICY[risk][mode];
}

export function alwaysRequiresApproval(risk: AgentToolRisk): boolean {
  return AGENT_PERMISSION_MODES.every((mode) => POLICY[risk][mode] === "approval");
}

// ---------------------------------------------------------------------------
// Tool calls and approvals
// ---------------------------------------------------------------------------

export interface AgentToolCall {
  toolCallId: string;
  name: string;
  args: unknown;
  projectId: string;
  generation: number;
}

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "cancelled"
  | "expired"
  | "consumed";

export interface AgentApprovalRequest {
  approvalId: string;
  toolCallId: string;
  projectId: string;
  generation: number;
  toolName: string;
  risk: AgentToolRisk;
  argsFingerprint: string;
  args: unknown;
  summary: string;
  createdAt: number;
  status: ApprovalStatus;
}

export type PermissionDenialReason =
  | "UNKNOWN_TOOL"
  | "USER_DENIED"
  | "STALE"
  | "INVALID_CALL";

export type PermissionDecision =
  | { kind: "allowed"; tool: AgentToolDefinition }
  | {
      kind: "approval-required";
      tool: AgentToolDefinition;
      approvalId: string | null;
    }
  | { kind: "denied"; reason: PermissionDenialReason; message: string }
  | { kind: "stale"; message: string };

export const APPROVAL_DENIED_MESSAGE =
  "The user denied this action. It was not performed.";

export const APPROVAL_STALE_MESSAGE =
  "This action is no longer valid because the project changed. It was not performed.";

export const UNKNOWN_TOOL_MESSAGE =
  "That tool does not exist. Nothing was performed.";

// ---------------------------------------------------------------------------
// Argument fingerprinting
// ---------------------------------------------------------------------------

export function fingerprintArgs(args: unknown): string {
  return canonicalize(args);
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  const type = typeof value;
  if (type === "number") {
    return Number.isFinite(value as number) ? String(value) : `#${String(value)}`;
  }
  if (type === "boolean") return String(value);
  if (type === "string") return JSON.stringify(value);
  if (type === "bigint") return `${String(value)}n`;

  if (type === "function" || type === "symbol") return `#unrepresentable`;

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

// ---------------------------------------------------------------------------
// Secret Redaction & Safe Summaries
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERN = /(token|password|passwd|secret|api_?key|access_?token|auth|cred|private_?key|bearer|cert)/i;
const REDACTED_ARG_KEYS = new Set([
  "env",
  "contents",
  "edits",
  "input",
  "body",
  "payload",
  "data",
  "headers",
  "credentials",
  "secret",
  "secrets",
  "config",
]);
const SUMMARY_VALUE_MAX = 80;

import { redactSecrets } from "./secret-redaction";

/**
 * Sanitizes arbitrary string content by redacting tokens, keys, embedded URL
 * credentials, passwords, and authorization headers.
 */
export function sanitizeString(str: string): string {
  if (!str || typeof str !== "string") return "";
  return redactSecrets(str);
}

/**
 * Extracts ONLY the sanitized executable name for a command, omitting raw command
 * line paths, arguments, flags, and embedded credentials.
 */
export function getExecutableName(cmd: string): string {
  if (!cmd || typeof cmd !== "string") return "process";
  const clean = sanitizeString(cmd.trim());
  const parts = clean.split(/[\/\\]/);
  const base = parts[parts.length - 1] || clean;
  const executable = base.split(/\s+/)[0] || base;
  return executable.length <= 40 ? executable : `${executable.slice(0, 39)}…`;
}

/**
 * Generates a security-safe summary for a tool call.
 *
 * Never displays raw command line strings or sensitive payload values. Shows
 * safe metadata (operation summary, executable name, argument count, path) and
 * redacts sensitive key patterns recursively.
 */
export function summarizeToolCall(toolName: string, args: unknown): string {
  const tool = getAgentTool(toolName);
  const base = tool ? tool.summary : `Run ${toolName}`;

  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return base;
  }

  const record = args as Record<string, unknown>;
  const parts: string[] = [];

  // For run_command: show ONLY executable name and argument count. NEVER raw command string.
  if (typeof record.command === "string" && record.command.length > 0) {
    parts.push(`command ${getExecutableName(record.command)}`);
  }

  for (const key of ["path", "from", "to", "processId"]) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) continue;
    parts.push(`${key} ${truncate(sanitizeString(value))}`);
  }

  if (Array.isArray(record.args) && record.args.length > 0) {
    parts.push(`Arguments: ${record.args.length}`);
  }

  if (Array.isArray(record.paths)) {
    parts.push(`${record.paths.length} path(s)`);
  }

  // Identify keys that must be withheld by name
  const withheld = Object.keys(record).filter(
    (key) => REDACTED_ARG_KEYS.has(key) || SENSITIVE_KEY_PATTERN.test(key),
  );
  if (withheld.length > 0) {
    const sorted = Array.from(new Set(withheld)).sort();
    parts.push(`${sorted.join(", ")} not shown`);
  }

  return parts.length > 0 ? `${base} — ${parts.join(", ")}` : base;
}

function truncate(value: string): string {
  return value.length <= SUMMARY_VALUE_MAX
    ? value
    : `${value.slice(0, SUMMARY_VALUE_MAX - 1)}…`;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface PermissionControllerOptions {
  mode?: AgentPermissionMode;
  now?: () => number;
  generateId?: () => string;
  onChange?: () => void;
}

function getEffectiveRisk(tool: AgentToolDefinition, args: unknown): AgentToolRisk {
  if (tool.name === "run_command" && typeof args === "object" && args !== null) {
    const record = args as Record<string, unknown>;
    const cmd = typeof record.command === "string" ? record.command : "";
    const argv = Array.isArray(record.args)
      ? [cmd, ...record.args.map(String)]
      : cmd.split(/\s+/).filter(Boolean);
    if (isDestructiveCommand(argv)) {
      return "destructive";
    }
  }
  return tool.risk;
}

export class AgentPermissionController {
  private mode: AgentPermissionMode;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly onChange: (() => void) | undefined;

  private readonly approvals = new Map<string, AgentApprovalRequest>();
  private readonly pendingByCallKey = new Map<string, string>();

  constructor(options: PermissionControllerOptions = {}) {
    this.mode = options.mode ?? DEFAULT_PERMISSION_MODE;
    this.now = options.now ?? (() => Date.now());
    this.onChange = options.onChange;

    let counter = 0;
    this.generateId =
      options.generateId ??
      (() => {
        counter += 1;
        return `apr-${counter}-${Math.random().toString(36).slice(2, 10)}`;
      });
  }

  getMode(): AgentPermissionMode {
    return this.mode;
  }

  setMode(mode: AgentPermissionMode): void {
    if (!isPermissionMode(mode)) return;
    if (this.mode === mode) return;
    this.mode = mode;
    this.onChange?.();
  }

  getPending(): AgentApprovalRequest[] {
    const pending: AgentApprovalRequest[] = [];
    for (const approvalId of this.pendingByCallKey.values()) {
      const approval = this.approvals.get(approvalId);
      if (approval && approval.status === "pending") pending.push(approval);
    }
    return pending.sort((a, b) => a.createdAt - b.createdAt);
  }

  getApproval(approvalId: string): AgentApprovalRequest | null {
    return this.approvals.get(approvalId) ?? null;
  }

  evaluate(call: AgentToolCall, currentGeneration: number): PermissionDecision {
    const invalid = validateCall(call);
    if (invalid) return invalid;

    const tool = getAgentTool(call.name);
    if (!tool) {
      return { kind: "denied", reason: "UNKNOWN_TOOL", message: UNKNOWN_TOOL_MESSAGE };
    }

    if (call.generation !== currentGeneration) {
      return { kind: "stale", message: APPROVAL_STALE_MESSAGE };
    }

    const existing = this.findActiveApprovalForCall(call);
    if (existing) {
      if (existing.status === "denied") {
        return { kind: "denied", reason: "USER_DENIED", message: APPROVAL_DENIED_MESSAGE };
      }
      if (existing.status === "approved") {
        return { kind: "allowed", tool };
      }
      if (existing.status === "cancelled" || existing.status === "expired" || existing.status === "consumed") {
        return { kind: "stale", message: APPROVAL_STALE_MESSAGE };
      }
      return { kind: "approval-required", tool, approvalId: existing.approvalId };
    }

    const effectiveRisk = getEffectiveRisk(tool, call.args);
    if (policyFor(effectiveRisk, this.mode) === "auto") {
      return { kind: "allowed", tool };
    }

    return { kind: "approval-required", tool, approvalId: null };
  }

  requestApproval(
    call: AgentToolCall,
    currentGeneration: number,
  ):
    | { kind: "pending"; approval: AgentApprovalRequest }
    | { kind: "allowed"; tool: AgentToolDefinition }
    | { kind: "denied"; reason: PermissionDenialReason; message: string }
    | { kind: "stale"; message: string } {
    const invalid = validateCall(call);
    if (invalid) return invalid;

    const tool = getAgentTool(call.name);
    if (!tool) {
      return { kind: "denied", reason: "UNKNOWN_TOOL", message: UNKNOWN_TOOL_MESSAGE };
    }

    if (call.generation !== currentGeneration) {
      return { kind: "stale", message: APPROVAL_STALE_MESSAGE };
    }

    const existing = this.findActiveApprovalForCall(call);
    if (existing) {
      if (existing.status === "denied") {
        return { kind: "denied", reason: "USER_DENIED", message: APPROVAL_DENIED_MESSAGE };
      }
      if (existing.status === "approved") {
        // ONE-SHOT CONSUMPTION: authorization is consumed atomically before handler runs
        existing.status = "consumed";
        this.pendingByCallKey.delete(callKeyOf(existing));
        this.onChange?.();
        return { kind: "allowed", tool };
      }
      if (existing.status === "pending") {
        return { kind: "pending", approval: existing };
      }
    }

    const effectiveRisk = getEffectiveRisk(tool, call.args);
    if (policyFor(effectiveRisk, this.mode) === "auto") {
      return { kind: "allowed", tool };
    }

    const approval: AgentApprovalRequest = {
      approvalId: this.generateId(),
      toolCallId: call.toolCallId,
      projectId: call.projectId,
      generation: call.generation,
      toolName: call.name,
      risk: effectiveRisk,
      argsFingerprint: fingerprintArgs(call.args),
      args: call.args,
      summary: summarizeToolCall(call.name, call.args),
      createdAt: this.now(),
      status: "pending",
    };

    this.approvals.set(approval.approvalId, approval);
    this.pendingByCallKey.set(callKey(call), approval.approvalId);
    this.onChange?.();
    return { kind: "pending", approval };
  }

  approve(approvalId: string, currentGeneration: number): boolean {
    return this.resolve(approvalId, "approved", currentGeneration);
  }

  deny(approvalId: string, currentGeneration: number): boolean {
    return this.resolve(approvalId, "denied", currentGeneration);
  }

  cancel(approvalId: string): boolean {
    return this.invalidateApproval(approvalId);
  }

  /**
   * Explicitly invalidates an exact unconsumed authorization.
   *
   * May ONLY invalidate an approval in "pending" or "approved" state.
   * Cannot modify terminal/consumed states ("consumed", "denied", "cancelled", "expired").
   *
   * Verifies optional match criteria (projectId, generation, toolCallId, argsFingerprint)
   * if provided.
   *
   * Returns true if invalidated, false otherwise.
   */
  invalidateApproval(
    approvalId: string,
    options?: {
      projectId?: string;
      generation?: number;
      toolCallId?: string;
      argsFingerprint?: string;
    },
  ): boolean {
    const approval = this.approvals.get(approvalId);
    if (!approval) return false;

    // Must be in an invalidatable (unconsumed) state
    if (approval.status !== "pending" && approval.status !== "approved") {
      return false;
    }

    // Verify exact match criteria if supplied
    if (options?.projectId !== undefined && approval.projectId !== options.projectId) {
      return false;
    }
    if (options?.generation !== undefined && approval.generation !== options.generation) {
      return false;
    }
    if (options?.toolCallId !== undefined && approval.toolCallId !== options.toolCallId) {
      return false;
    }
    if (options?.argsFingerprint !== undefined && approval.argsFingerprint !== options.argsFingerprint) {
      return false;
    }

    // Transition status to cancelled
    approval.status = "cancelled";

    // Clean up callKey entry if it points to this exact approval
    const key = callKeyOf(approval);
    if (this.pendingByCallKey.get(key) === approval.approvalId) {
      this.pendingByCallKey.delete(key);
    }

    this.onChange?.();
    return true;
  }

  cancelAll(reason: "cancelled" | "expired" = "expired"): number {
    let count = 0;
    for (const approvalId of this.pendingByCallKey.values()) {
      const approval = this.approvals.get(approvalId);
      if (!approval || approval.status !== "pending") continue;
      approval.status = reason;
      count += 1;
    }
    this.pendingByCallKey.clear();
    if (count > 0) this.onChange?.();
    return count;
  }

  private resolve(
    approvalId: string,
    status: "approved" | "denied",
    currentGeneration: number,
  ): boolean {
    const approval = this.approvals.get(approvalId);
    if (!approval) return false;

    if (approval.status !== "pending") return false;

    if (approval.generation !== currentGeneration) {
      approval.status = "expired";
      this.pendingByCallKey.delete(callKeyOf(approval));
      this.onChange?.();
      return false;
    }

    approval.status = status;
    this.pendingByCallKey.delete(callKeyOf(approval));
    this.onChange?.();
    return true;
  }

  private findActiveApprovalForCall(call: AgentToolCall): AgentApprovalRequest | null {
    const key = callKey(call);
    for (const approval of this.approvals.values()) {
      if (
        callKeyOf(approval) === key &&
        (approval.status === "pending" || approval.status === "approved" || approval.status === "denied")
      ) {
        return approval;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Call identity
// ---------------------------------------------------------------------------

const KEY_SEPARATOR = "\u001f";

function callKey(call: AgentToolCall): string {
  return [
    call.projectId,
    String(call.generation),
    call.toolCallId,
    call.name,
    fingerprintArgs(call.args),
  ].join(KEY_SEPARATOR);
}

function callKeyOf(approval: AgentApprovalRequest): string {
  return [
    approval.projectId,
    String(approval.generation),
    approval.toolCallId,
    approval.toolName,
    approval.argsFingerprint,
  ].join(KEY_SEPARATOR);
}

function validateCall(
  call: AgentToolCall,
): { kind: "denied"; reason: PermissionDenialReason; message: string } | null {
  if (!call || typeof call !== "object") {
    return { kind: "denied", reason: "INVALID_CALL", message: "Malformed tool call." };
  }
  if (typeof call.toolCallId !== "string" || call.toolCallId.length === 0) {
    return {
      kind: "denied",
      reason: "INVALID_CALL",
      message: "Tool call is missing an identifier.",
    };
  }
  if (typeof call.name !== "string" || call.name.length === 0) {
    return {
      kind: "denied",
      reason: "INVALID_CALL",
      message: "Tool call is missing a tool name.",
    };
  }
  if (typeof call.projectId !== "string" || call.projectId.length === 0) {
    return {
      kind: "denied",
      reason: "INVALID_CALL",
      message: "Tool call is missing a project.",
    };
  }
  if (!Number.isInteger(call.generation)) {
    return {
      kind: "denied",
      reason: "INVALID_CALL",
      message: "Tool call is missing a project generation.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mode persistence
// ---------------------------------------------------------------------------

export function permissionModePreferenceKey(projectId: string): string {
  return `agentPermissionMode:${projectId}`;
}
