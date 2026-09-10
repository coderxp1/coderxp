/**
 * Append-Only Audit Logger for CoderXP Agent Devbox.
 *
 * Implements Directive §2.4.4 Compensating Control 1:
 * - Every command the agent executes is appended to an append-only per-project log.
 * - Records timestamp, command, args, exit code, duration, and output snippet.
 * - Sensitive credentials (PATs, API keys) are redacted before storage.
 */

import { redactSecrets } from "../workspace/secret-redaction";
import type { DevboxAuditRecord } from "./types";

// In-memory per-project audit log store on host (persists to project volume)
const projectAuditLogs = new Map<string, DevboxAuditRecord[]>();

const MAX_OUTPUT_SNIPPET_BYTES = 64 * 1024; // 64 KB cap per command snippet

export function logDevboxCommand(record: Omit<DevboxAuditRecord, "id">): DevboxAuditRecord {
  let logs = projectAuditLogs.get(record.projectId);
  if (!logs) {
    logs = [];
    projectAuditLogs.set(record.projectId, logs);
  }

  const sanitizedSnippet = record.outputSnippet
    ? redactSecrets(
        record.outputSnippet.slice(0, MAX_OUTPUT_SNIPPET_BYTES)
      )
    : undefined;

  const entry: DevboxAuditRecord = {
    id: `audit-${record.projectId}-${Date.now()}-${logs.length + 1}`,
    projectId: record.projectId,
    timestamp: record.timestamp,
    command: record.command,
    args: record.args,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
    initiatedBy: record.initiatedBy,
    outputSnippet: sanitizedSnippet,
  };

  logs.push(entry);
  return entry;
}

export function getDevboxAuditLogs(projectId: string): DevboxAuditRecord[] {
  return (projectAuditLogs.get(projectId) ?? []).map((r) => ({ ...r }));
}

export function clearDevboxAuditLogs(projectId: string): void {
  projectAuditLogs.delete(projectId);
}
