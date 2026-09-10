/**
 * Unified Event Bus & Action Policy Types for CoderXP Phase A.
 *
 * Implements Roadmap §0, §4 & Amendments 1-4:
 * - Authoritative host event stream with monotonic sequence numbers.
 * - 5-tier risk taxonomy (T0 Free -> T4 Hard Gate).
 * - Server-side enforcement contracts.
 */

export type EventTier = "T0" | "T1" | "T2" | "T3" | "T4";
export type EventActor = "agent" | "user" | "system";

export type ProjectEventType =
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "fs.file_written"
  | "cmd.executed"
  | "pkg.installed"
  | "test.run_completed"
  | "git.committed"
  | "git.pushed"
  | "deploy.requested"
  | "approval.requested"
  | "approval.decided"
  | "devbox.lifecycle"
  | "preview.created";

export interface ProjectEvent<TData = Record<string, any>> {
  id: string;
  projectId: string;
  sessionId: string;
  seq: number; // Monotonic sequence per project
  schemaVersion: 1;
  timestamp: number;
  actor: EventActor;
  tier: EventTier;
  type: ProjectEventType;
  data: TData;
}

export interface ActionPolicyDecision {
  tier: EventTier;
  allowed: boolean;
  requiresApproval: boolean;
  requiresTypedConfirmation: boolean;
  undoable: boolean;
  rollbackCommand?: string;
  reason?: string;
}

export interface ActionPolicyRequest {
  type:
    | "fs_read"
    | "fs_write"
    | "exec_cmd"
    | "git_commit"
    | "git_push"
    | "pr_merge"
    | "deploy"
    | "billing";
  command?: string;
  args?: string[];
  branch?: string;
  remote?: string;
  isForce?: boolean;
  isDefaultBranch?: boolean;
  isDelete?: boolean;
  untrustedContext?: boolean; // elevated tier if processing untrusted input
}
