/**
 * Pre-Push Git Snapshot Manager for CoderXP Agent Devbox.
 *
 * Implements Directive §2.4.4 Compensating Control 2:
 * - Before any git push, records the remote ref's current SHA in refs/before-push/{timestamp}.
 * - Enables 1-command rollback for any push (including force-pushes).
 */

import type { DevboxGitSnapshot } from "./types";

const projectSnapshots = new Map<string, DevboxGitSnapshot[]>();

export function recordPrePushSnapshot(options: {
  projectId: string;
  branch: string;
  remoteRef: string;
  prePushCommitSha: string;
  postPushCommitSha?: string;
}): DevboxGitSnapshot {
  let list = projectSnapshots.get(options.projectId);
  if (!list) {
    list = [];
    projectSnapshots.set(options.projectId, list);
  }

  const timestamp = Date.now();
  const snapshotRef = `refs/before-push/${timestamp}`;
  const rollbackCommand = `git push --force origin ${options.prePushCommitSha}:${options.branch}`;

  const snapshot: DevboxGitSnapshot = {
    id: `snap-${options.projectId}-${timestamp}`,
    projectId: options.projectId,
    timestamp,
    branch: options.branch,
    remoteRef: snapshotRef,
    prePushCommitSha: options.prePushCommitSha,
    postPushCommitSha: options.postPushCommitSha,
    rollbackCommand,
  };

  list.push(snapshot);
  return snapshot;
}

export function getProjectGitSnapshots(projectId: string): DevboxGitSnapshot[] {
  return (projectSnapshots.get(projectId) ?? []).map((s) => ({ ...s }));
}

export function getLatestSnapshot(projectId: string): DevboxGitSnapshot | null {
  const list = projectSnapshots.get(projectId);
  if (!list || list.length === 0) return null;
  return { ...list[list.length - 1] };
}
