/**
 * Agent runtime slice — runtime session registry (single-process authority).
 *
 * Owns live session records, the idempotency op ledger, and the on-disk
 * workspace layout. Ownership is structural: every workspace lives under
 * `users/<ownerUserId>/projects/<projectId>/sessions/<sessionId>/`, so a
 * session id can never resolve into another owner's files.
 *
 * Workspace FILES persist across runtime replacement (they live under the
 * data dir); live PROCESS handles do not — a replacement registry reports
 * pre-replacement sessions as unknown and never fabricates their state.
 * Reconnect re-attaches to a live session's stream only; it never
 * re-executes recorded operations.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExecOutcome, SessionRuntimeState } from "./types";
import { RuntimeError } from "./types";

export interface RuntimeSessionRecord {
  sessionId: string;
  projectId: string;
  ownerUserId: string;
  workspaceDir: string;
  createdAt: number;
  state: SessionRuntimeState;
  stateDetail: string;
  shellPid: number | null;
  endedAt: number | null;
}

export interface PersistedWorkspaceSummary {
  ownerUserId: string;
  projectId: string;
  sessionId: string;
  workspaceDir: string;
  fileCount: number;
}

function isSafeId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

export class RuntimeSessionRegistry {
  private readonly sessions = new Map<string, RuntimeSessionRecord>();
  private readonly opLedger = new Map<string, ExecOutcome>();

  constructor(private readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  getDataDir(): string {
    return this.dataDir;
  }

  allocate(projectId: string, ownerUserId: string, agentSessionId?: string): RuntimeSessionRecord {
    if (!isSafeId(projectId)) throw new RuntimeError("CONSTRAINT_VIOLATION", "Refusing to allocate: unsafe project id.", 400);
    if (!isSafeId(ownerUserId)) throw new RuntimeError("CONSTRAINT_VIOLATION", "Refusing to allocate: unsafe owner id.", 400);
    const sessionId =
      agentSessionId !== undefined && agentSessionId !== ""
        ? agentSessionId
        : `sess-${crypto.randomBytes(8).toString("hex")}`;
    if (!isSafeId(sessionId)) throw new RuntimeError("CONSTRAINT_VIOLATION", "Refusing to allocate: unsafe session id.", 400);
    if (this.sessions.has(sessionId)) {
      throw new RuntimeError("OP_CONFLICT", "Session id is already allocated in this runtime.", 409);
    }
    const existingOwner = this.findProjectOwner(projectId);
    if (existingOwner !== null && existingOwner !== ownerUserId) {
      throw new RuntimeError("OP_CONFLICT", "Project name is already owned by another owner in this runtime.", 409);
    }
    const workspaceDir = path.join(this.dataDir, "users", ownerUserId, "projects", projectId, "sessions", sessionId, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const record: RuntimeSessionRecord = {
      sessionId,
      projectId,
      ownerUserId,
      workspaceDir,
      createdAt: Date.now(),
      state: "running",
      stateDetail: "allocated",
      shellPid: null,
      endedAt: null,
    };
    this.sessions.set(sessionId, record);
    return { ...record };
  }

  get(sessionId: string): RuntimeSessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new RuntimeError("SESSION_UNKNOWN", "Session is unknown to this runtime.", 404);
    return { ...record };
  }

  /** Trusted server state for authorization: session home project. */
  getSessionProject(agentSessionId: string): string | null {
    return this.sessions.get(agentSessionId)?.projectId ?? null;
  }

  /** Trusted server state for authorization: session owner. */
  getSessionOwner(agentSessionId: string): string | null {
    return this.sessions.get(agentSessionId)?.ownerUserId ?? null;
  }

  /**
   * Trusted server state for authorization: project owner. Resolves from
   * live records first, then from persisted workspace roots. Returns null
   * for unknown or unsafe names (callers fail closed).
   */
  findProjectOwner(projectId: string): string | null {
    if (!isSafeId(projectId)) return null;
    for (const record of this.sessions.values()) {
      if (record.projectId === projectId) return record.ownerUserId;
    }
    const usersDir = path.join(this.dataDir, "users");
    let owners: string[];
    try {
      owners = fs.readdirSync(usersDir);
    } catch {
      return null;
    }
    const matches: string[] = [];
    for (const owner of owners) {
      if (!isSafeId(owner)) continue;
      try {
        const stat = fs.statSync(path.join(usersDir, owner, "projects", projectId));
        if (stat.isDirectory()) matches.push(owner);
      } catch {
        continue;
      }
    }
    // Allocate-time uniqueness keeps this at most one; ambiguity fails closed.
    return matches.length === 1 ? matches[0] : null;
  }

  update(sessionId: string, patch: Partial<Pick<RuntimeSessionRecord, "state" | "stateDetail" | "shellPid" | "endedAt">>): RuntimeSessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new RuntimeError("SESSION_UNKNOWN", "Session is unknown to this runtime.", 404);
    Object.assign(record, patch);
    return { ...record };
  }

  listByProject(projectId: string): RuntimeSessionRecord[] {
    return [...this.sessions.values()].filter((r) => r.projectId === projectId).map((r) => ({ ...r }));
  }

  /** Idempotency ledger: first write wins; replays return the recorded outcome. */
  recordOp(operationId: string, outcome: ExecOutcome): void {
    if (!this.opLedger.has(operationId)) this.opLedger.set(operationId, { ...outcome, reconciled: false });
  }

  replayOp(operationId: string): ExecOutcome | null {
    const recorded = this.opLedger.get(operationId);
    return recorded ? { ...recorded, reconciled: true } : null;
  }

  hasOp(operationId: string): boolean {
    return this.opLedger.has(operationId);
  }

  /**
   * Lists persisted WORKSPACE DIRECTORIES (files), not live sessions. Used
   * after runtime replacement to prove file persistence without claiming
   * any live process state. Never clobbers: read-only walk.
   */
  listPersistedWorkspaces(): PersistedWorkspaceSummary[] {
    const out: PersistedWorkspaceSummary[] = [];
    const usersDir = path.join(this.dataDir, "users");
    let owners: string[] = [];
    try {
      owners = fs.readdirSync(usersDir);
    } catch {
      return out;
    }
    for (const ownerUserId of owners) {
      const projectsDir = path.join(usersDir, ownerUserId, "projects");
      let projects: string[] = [];
      try {
        projects = fs.readdirSync(projectsDir);
      } catch {
        continue;
      }
      for (const projectId of projects) {
        const sessionsDir = path.join(projectsDir, projectId, "sessions");
        let sessions: string[] = [];
        try {
          sessions = fs.readdirSync(sessionsDir);
        } catch {
          continue;
        }
        for (const sessionId of sessions) {
          const workspaceDir = path.join(sessionsDir, sessionId, "workspace");
          let fileCount = 0;
          try {
            fileCount = countFiles(workspaceDir);
          } catch {
            continue;
          }
          out.push({ ownerUserId, projectId, sessionId, workspaceDir, fileCount });
        }
      }
    }
    return out;
  }
}

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
    else count += 1;
  }
  return count;
}
