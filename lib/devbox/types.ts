/**
 * Type definitions for CoderXP Revision 2.4: Agent Devbox.
 *
 * Real persistent Linux execution environment per Directive §2.4 & Amendments.
 */

export type DevboxState =
  | "creating"
  | "running"
  | "idle"
  | "stopped"
  | "paused"
  | "pending-purge"
  | "terminating"
  | "deleted";

export type UserPlanTier = "free" | "pro" | "byok-compute";

export const MAX_GLOBAL_CONCURRENT_DEVBOXES = 5;
export const DEVBOX_PURGE_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface DevboxResourceLimits {
  memoryBytes: number; // 2 GB
  cpus: number; // 2.0
  pidsLimit: number; // 256
  diskQuotaBytes: number; // 10 GB
}

export const DEFAULT_DEVBOX_LIMITS: DevboxResourceLimits = {
  memoryBytes: 2 * 1024 * 1024 * 1024, // 2 GB
  cpus: 2.0,
  pidsLimit: 256,
  diskQuotaBytes: 10 * 1024 * 1024 * 1024, // 10 GB
};

export interface DevboxConfig {
  projectId: string;
  userId: string;
  tier: UserPlanTier;
  containerName: string;
  volumeName: string;
  idleTimeoutMinutes: number; // 10 minutes
  limits: DevboxResourceLimits;
  gitPat?: string; // Stored server-side only
}

export interface DevboxStatus {
  projectId: string;
  userId: string;
  state: DevboxState;
  containerId?: string;
  uptimeSeconds: number;
  idleSeconds: number;
  tier: UserPlanTier;
  quotaRemainingHours: number;
  isPausedDueToQuota: boolean;
  activeProcesses: number;
  lastActiveTimestamp: number;
  purgeAt?: number;
}

export interface DevboxAuditRecord {
  id: string;
  projectId: string;
  timestamp: number;
  command: string;
  args: string[];
  exitCode: number | null;
  durationMs: number;
  initiatedBy: "agent" | "user";
  outputSnippet?: string;
}

export interface DevboxGitSnapshot {
  id: string;
  projectId: string;
  timestamp: number;
  branch: string;
  remoteRef: string;
  prePushCommitSha: string;
  postPushCommitSha?: string;
  rollbackCommand: string;
}

export interface DevboxMeteringEvent {
  event: "devbox.started" | "devbox.stopped" | "devbox.paused";
  timestamp: number;
  projectId: string;
  userId: string;
  containerId: string;
  tier: UserPlanTier;
  startedAt: number;
  stoppedAt?: number;
  activeSeconds: number;
  billableHours: number;
  reason?: "idle_timeout" | "user_freeze" | "quota_exhausted" | "shutdown";
}
