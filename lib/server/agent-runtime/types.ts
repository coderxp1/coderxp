/**
 * Agent runtime slice — shared types for the real per-agent shell/session path.
 *
 * One persistent PTY-backed shell per agent session plus structured exec
 * children in the same session scope. Every entry point on the real path
 * (allocate, exec, file-adjacent resource use, attach, input, control)
 * requires an AuthorizationSuccess whose operation matches the dispatched
 * request exactly; see authorized-provider.ts.
 *
 * Honesty rules: session state is `running` | `dead` | `unknown` and is
 * never guessed — lost supervisor contact reports `unknown`, never a
 * fabricated status. Exec outcomes distinguish completed / signaled /
 * timeout / cancelled / failed-to-start / unknown, with `confirmed: false`
 * only for `unknown`.
 */

import type { AuthorizationSuccess } from "../authorization/types";

export type SessionRuntimeState = "running" | "dead" | "unknown";

export type ExecOutcomeKind =
  | "completed"
  | "signaled"
  | "timeout"
  | "cancelled"
  | "failed-to-start"
  | "unknown";

export interface ExecOutcome {
  kind: ExecOutcomeKind;
  /** Exit code when observed; null when signaled, unstarted, or unknown. */
  exitCode: number | null;
  /** Signal name when the process ended by signal, else null. */
  signal: string | null;
  /** False only for `unknown`: the supervisor lost contact. */
  confirmed: boolean;
  /** True when replayed from the op ledger without re-execution. */
  reconciled: boolean;
  /** Bytes of captured output retained for this op (bounded). */
  outputBytes: number;
  /** True when output exceeded the per-op capture cap. */
  outputTruncated: boolean;
  durationMs: number;
}

export interface ExecArgs {
  /** Structured argv dispatch. argv[0] is executed directly (no shell). */
  argv?: string[];
  /** Shell-interpreted execution (explicit gated capability). */
  script?: string;
}

export interface ExecRequest {
  operationId: string;
  projectId: string;
  agentSessionId: string;
  /** Project-relative working directory for this exec (authorized resource). */
  resource: string;
  args: ExecArgs;
  execMode: "argv" | "shell-script";
  networkNeed: "none" | "loopback" | "external";
  timeoutMs: number;
}

export interface AllocateRequest {
  operationId: string;
  projectId: string;
  agentSessionId?: string;
  cols: number;
  rows: number;
}

export interface SessionInfo {
  sessionId: string;
  projectId: string;
  ownerUserId: string;
  workspaceDir: string;
  state: SessionRuntimeState;
  shellPid: number | null;
  isolation: {
    user: string;
    netns: "no-egress" | "off";
    prlimit: boolean;
  };
}

export type StreamKind = "pty" | "exec-stdout" | "exec-stderr" | "control" | "state";

export interface StreamFrame {
  seq: number;
  ts: number;
  stream: StreamKind;
  data: string;
}

export interface StreamGap {
  fromSeq: number;
  toSeq: number;
  reason: "retention-evicted" | "retention-overflow";
}

export interface AttachResult {
  frames: StreamFrame[];
  nextCursor: number;
  gap: StreamGap | null;
  state: SessionRuntimeState;
}

export type LeaseHolder = "agent" | "user";

export interface ControlLease {
  holder: LeaseHolder;
  token: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface RuntimeErrorInfo {
  code:
    | "RUNTIME_UNAVAILABLE"
    | "SESSION_UNKNOWN"
    | "SESSION_DEAD"
    | "OP_CONFLICT"
    | "OP_UNKNOWN"
    | "LEASE_CONFLICT"
    | "LEASE_REQUIRED"
    | "CONTROL_REJECTED"
    | "CONSTRAINT_VIOLATION";
  message: string;
  status: number;
}

export class RuntimeError extends Error {
  readonly code: RuntimeErrorInfo["code"];
  readonly status: number;

  constructor(code: RuntimeErrorInfo["code"], message: string, status: number) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.status = status;
  }
}

/** An authorized call: the success plus the exact descriptor it authorized. */
export interface AuthorizedCall {
  authz: AuthorizationSuccess;
  descriptor: {
    operationId: string;
    projectId: string;
    agentSessionId?: string;
    action: string;
    resource?: string;
    args?: unknown;
    networkNeed?: string;
    execMode?: string;
  };
}
