/**
 * Authorization slice (DRAFT) — explicit, bounded session grants.
 *
 * Grants cover the local development loop (read/write/execute/preview within
 * an explicit scope) so every harmless-looking step does not need another
 * approval click. They are reviewable (listActive), revocable, TTL-bounded,
 * and constrained by actor, project, agent sessions, action categories,
 * resource prefixes, and network egress. Grants NEVER cover `external`
 * actions (push, remote deletion, disclosure, deployment, credential use,
 * spending): those always require their own approval decision.
 */

import crypto from "node:crypto";
import {
  AuditSink,
  AuthorizationError,
  DenialCode,
  GrantableCategory,
  OperationDescriptor,
  SessionGrant,
} from "./types";
import { categorize, GRANTABLE_CATEGORIES } from "./policy";
import { normalizeResourcePath, validateId } from "./util";

export interface GrantStoreOptions {
  now?: () => number;
  maxGrantTtlMs?: number;
  maxBroadGrantTtlMs?: number;
}

export interface GrantIssueParams {
  actorUserId: string;
  projectId: string;
  agentSessionIds: string[] | "*";
  categories: GrantableCategory[];
  resourcePrefixes: string[];
  egress: "none" | "loopback";
  ttlMs: number;
  createdByOperationId: string;
}

function prefixMatches(prefix: string, resource: string): boolean {
  if (prefix === "*") return true;
  return resource === prefix || resource.startsWith(`${prefix}/`);
}

export class GrantStore {
  private readonly now: () => number;
  private readonly maxGrantTtlMs: number;
  private readonly maxBroadGrantTtlMs: number;
  private readonly grants = new Map<string, SessionGrant>();

  constructor(options?: GrantStoreOptions) {
    this.now = options?.now ?? Date.now;
    this.maxGrantTtlMs = options?.maxGrantTtlMs ?? 8 * 60 * 60 * 1000;
    this.maxBroadGrantTtlMs = options?.maxBroadGrantTtlMs ?? 60 * 60 * 1000;
  }

  issue(params: GrantIssueParams, sink?: AuditSink): SessionGrant {
    validateId(params.actorUserId, "actorUserId", params.createdByOperationId);
    validateId(params.projectId, "projectId", params.createdByOperationId);
    validateId(params.createdByOperationId, "createdByOperationId");
    if (params.agentSessionIds !== "*") {
      if (params.agentSessionIds.length === 0) throw new Error("Grant requires explicit agent sessions or '*'.");
      for (const s of params.agentSessionIds) validateId(s, "agentSessionId", params.createdByOperationId);
    }
    if (params.categories.length === 0) throw new Error("Grant requires at least one category.");
    for (const c of params.categories) {
      if (!GRANTABLE_CATEGORIES.has(c)) {
        throw new Error(`Category is not grantable (external actions need approvals): ${String(c)}.`);
      }
    }
    if (params.resourcePrefixes.length === 0) throw new Error("Grant requires explicit resource prefixes.");
    const prefixes = params.resourcePrefixes.map((p) =>
      p === "*" ? "*" : normalizeResourcePath(p, params.createdByOperationId),
    );
    if (params.egress !== "none" && params.egress !== "loopback") {
      throw new Error("Grant egress must be 'none' or 'loopback' (external egress needs approvals).");
    }
    const broad = prefixes.includes("*");
    const maxTtl = broad ? this.maxBroadGrantTtlMs : this.maxGrantTtlMs;
    if (!Number.isInteger(params.ttlMs) || params.ttlMs < 1000 || params.ttlMs > maxTtl) {
      throw new Error("Grant ttlMs is out of bounds for its scope.");
    }
    const grant: SessionGrant = {
      id: crypto.randomBytes(8).toString("hex"),
      actorUserId: params.actorUserId,
      projectId: params.projectId,
      agentSessionIds: params.agentSessionIds === "*" ? "*" : [...params.agentSessionIds],
      categories: [...params.categories],
      resourcePrefixes: prefixes,
      egress: params.egress,
      broad,
      expiresAt: this.now() + params.ttlMs,
      revokedAt: null,
      createdByOperationId: params.createdByOperationId,
      createdAt: this.now(),
    };
    this.grants.set(grant.id, grant);
    sink?.record({
      ts: this.now(),
      actorUserId: grant.actorUserId,
      projectId: grant.projectId,
      operationId: grant.createdByOperationId,
      action: "grant.issue",
      outcome: "grant-issued",
      via: grant.id,
    });
    return { ...grant, agentSessionIds: grant.agentSessionIds === "*" ? "*" : [...grant.agentSessionIds], categories: [...grant.categories], resourcePrefixes: [...grant.resourcePrefixes] };
  }

  revoke(grantId: string, byOperationId: string, sink?: AuditSink): void {
    validateId(byOperationId, "operationId");
    const grant = this.grants.get(grantId);
    if (!grant) {
      throw new AuthorizationError("GRANT_NOT_FOUND", "Grant does not exist.", 403, byOperationId);
    }
    grant.revokedAt = this.now();
    sink?.record({
      ts: this.now(),
      actorUserId: grant.actorUserId,
      projectId: grant.projectId,
      operationId: byOperationId,
      action: "grant.revoke",
      outcome: "grant-revoked",
      via: grant.id,
    });
  }

  get(grantId: string): SessionGrant | null {
    const grant = this.grants.get(grantId);
    if (!grant) return null;
    return {
      ...grant,
      agentSessionIds: grant.agentSessionIds === "*" ? "*" : [...grant.agentSessionIds],
      categories: [...grant.categories],
      resourcePrefixes: [...grant.resourcePrefixes],
    };
  }

  /** Reviewability: active (unexpired, unrevoked) grants, optionally filtered. */
  listActive(filter?: { actorUserId?: string; projectId?: string }): SessionGrant[] {
    const out: SessionGrant[] = [];
    for (const grant of this.grants.values()) {
      if (grant.revokedAt !== null || this.now() >= grant.expiresAt) continue;
      if (filter?.actorUserId !== undefined && grant.actorUserId !== filter.actorUserId) continue;
      if (filter?.projectId !== undefined && grant.projectId !== filter.projectId) continue;
      out.push(this.get(grant.id) as SessionGrant);
    }
    return out;
  }

  check(
    grant: SessionGrant,
    descriptor: OperationDescriptor,
    actorUserId: string,
  ): { ok: true } | { ok: false; code: DenialCode } {
    if (this.now() >= grant.expiresAt) return { ok: false, code: "GRANT_EXPIRED" };
    if (grant.revokedAt !== null) return { ok: false, code: "GRANT_REVOKED" };
    if (grant.actorUserId !== actorUserId || grant.projectId !== descriptor.projectId) {
      return { ok: false, code: "GRANT_OUT_OF_SCOPE" };
    }
    const category = categorize(descriptor.action);
    if (!grant.categories.includes(category as GrantableCategory)) {
      return { ok: false, code: "GRANT_OUT_OF_SCOPE" };
    }
    if (grant.agentSessionIds !== "*") {
      if (descriptor.agentSessionId === undefined || !grant.agentSessionIds.includes(descriptor.agentSessionId)) {
        return { ok: false, code: "GRANT_OUT_OF_SCOPE" };
      }
    }
    if (descriptor.resource !== undefined) {
      const covered = grant.resourcePrefixes.some((p) => prefixMatches(p, descriptor.resource as string));
      if (!covered) return { ok: false, code: "GRANT_OUT_OF_SCOPE" };
    }
    const need = descriptor.networkNeed ?? "none";
    if (need === "external") return { ok: false, code: "GRANT_OUT_OF_SCOPE" };
    if (need === "loopback" && grant.egress !== "loopback") return { ok: false, code: "GRANT_OUT_OF_SCOPE" };
    // Shell-script execution is an explicit gated capability: it always
    // requires a one-time approval, never a standing grant.
    if (descriptor.action === "exec" && descriptor.execMode === "shell-script") {
      return { ok: false, code: "GRANT_OUT_OF_SCOPE" };
    }
    return { ok: true };
  }
}
