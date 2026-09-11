/**
 * Authorization slice (DRAFT) — single-use HMAC-bound approvals.
 *
 * An approval binds the complete normalized effective operation: actor,
 * project, agent session, exact action, argument hash, resource, network
 * scope, execution capability, destination, revision, protected-target flag,
 * operation ID, issuer epoch, and expiry. It is consumed atomically on first
 * valid presentation; any second presentation is a replay rejection.
 * Verification performs no runtime, storage, credential, or network side
 * effects.
 *
 * Single authority: one issuer instance (one epoch) per process. The epoch
 * invalidates pre-restart approvals, since in-memory consume/revoke sets do
 * not survive restarts. Cross-process or restart-safe replay protection is
 * NOT claimed; durable credential storage is follow-up work. Unavailable
 * authorization state must fail closed at the enforce() layer.
 */

import crypto from "node:crypto";
import {
  ActionKind,
  ApprovalToken,
  AuditSink,
  AuthorizationError,
} from "./types";
import { argsHashFor, normalizeResourcePath, timingSafeEqualHex, validateId } from "./util";
import { ACTION_CATEGORY } from "./policy";

export interface ApprovalIssuerOptions {
  now?: () => number;
  defaultTtlMs?: number;
  maxTtlMs?: number;
  /** 8-byte hex instance epoch. Random per issuer unless injected (tests). */
  epoch?: string;
}

export interface ApprovalIssueParams {
  actorUserId: string;
  projectId: string;
  /** Empty string when the operation has no agent session. */
  agentSessionId: string;
  action: ActionKind;
  /** Validated arguments; bound by hash. */
  args: unknown;
  /** Project-relative resource ("" when the operation has none). */
  resource: string;
  /** Network scope ("" when the operation declares none). */
  networkNeed: string;
  /** Execution capability ("" when the operation declares none). */
  execMode: string;
  destination: string;
  revision: string;
  operationId: string;
  protectedTarget: boolean;
  ttlMs?: number;
}

export interface ApprovalBinding {
  actorUserId: string;
  projectId: string;
  agentSessionId: string;
  action: ActionKind;
  argsHash: string;
  resource: string;
  networkNeed: string;
  execMode: string;
  destination: string;
  revision: string;
  operationId: string;
  protectedTarget: boolean;
}

interface ApprovalPayload {
  v: 2;
  id: string;
  actorUserId: string;
  projectId: string;
  agentSessionId: string;
  action: ActionKind;
  argsHash: string;
  resource: string;
  networkNeed: string;
  execMode: string;
  destination: string;
  revision: string;
  operationId: string;
  protectedTarget: boolean;
  epoch: string;
  expiresAt: number;
}

function canonicalPayloadJson(p: ApprovalPayload): string {
  return JSON.stringify({
    v: p.v,
    id: p.id,
    actorUserId: p.actorUserId,
    projectId: p.projectId,
    agentSessionId: p.agentSessionId,
    action: p.action,
    argsHash: p.argsHash,
    resource: p.resource,
    networkNeed: p.networkNeed,
    execMode: p.execMode,
    destination: p.destination,
    revision: p.revision,
    operationId: p.operationId,
    protectedTarget: p.protectedTarget,
    epoch: p.epoch,
    expiresAt: p.expiresAt,
  });
}

function isHex(value: string, bytes: number): boolean {
  return new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value);
}

const NETWORK_SCOPES: ReadonlySet<string> = new Set(["", "none", "loopback", "external"]);
const EXEC_MODES: ReadonlySet<string> = new Set(["", "argv", "shell-script"]);

export class ApprovalIssuer {
  private readonly secret: string;
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;
  readonly epoch: string;
  private readonly consumed = new Set<string>();
  private readonly revoked = new Set<string>();

  constructor(secret: string, options?: ApprovalIssuerOptions) {
    if (!secret || secret.length < 32) {
      throw new Error("Approval issuer requires an explicit secret of at least 32 characters (fail closed).");
    }
    if (options?.epoch !== undefined && !isHex(options.epoch, 8)) {
      throw new Error("Approval issuer epoch must be 8-byte hex when provided.");
    }
    this.secret = secret;
    this.now = options?.now ?? Date.now;
    this.defaultTtlMs = options?.defaultTtlMs ?? 10 * 60 * 1000;
    this.maxTtlMs = options?.maxTtlMs ?? 60 * 60 * 1000;
    this.epoch = options?.epoch ?? crypto.randomBytes(8).toString("hex");
  }

  issue(params: ApprovalIssueParams, sink?: AuditSink): { token: ApprovalToken; serialized: string } {
    validateId(params.actorUserId, "actorUserId", params.operationId);
    validateId(params.projectId, "projectId", params.operationId);
    if (params.agentSessionId !== "") validateId(params.agentSessionId, "agentSessionId", params.operationId);
    if (!ACTION_CATEGORY[params.action]) {
      throw new AuthorizationError("UNKNOWN_ACTION", "approval action is unknown.", 403, params.operationId);
    }
    validateId(params.operationId, "operationId");
    if (typeof params.protectedTarget !== "boolean" || typeof params.destination !== "string" || typeof params.revision !== "string") {
      throw new AuthorizationError("MALFORMED_REQUEST", "approval bindings are malformed.", 400, params.operationId);
    }
    const resource = params.resource === "" ? "" : normalizeResourcePath(params.resource, params.operationId);
    if (!NETWORK_SCOPES.has(params.networkNeed) || !EXEC_MODES.has(params.execMode)) {
      throw new AuthorizationError("MALFORMED_REQUEST", "approval network scope or exec mode is malformed.", 400, params.operationId);
    }
    const ttlMs = params.ttlMs ?? this.defaultTtlMs;
    if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > this.maxTtlMs) {
      throw new AuthorizationError("MALFORMED_REQUEST", "approval ttlMs is out of bounds.", 400, params.operationId);
    }
    const payload: ApprovalPayload = {
      v: 2,
      id: crypto.randomBytes(8).toString("hex"),
      actorUserId: params.actorUserId,
      projectId: params.projectId,
      agentSessionId: params.agentSessionId,
      action: params.action,
      argsHash: argsHashFor(params.args),
      resource,
      networkNeed: params.networkNeed,
      execMode: params.execMode,
      destination: params.destination,
      revision: params.revision,
      operationId: params.operationId,
      protectedTarget: params.protectedTarget,
      epoch: this.epoch,
      expiresAt: this.now() + ttlMs,
    };
    const payloadJson = canonicalPayloadJson(payload);
    const sig = crypto.createHmac("sha256", this.secret).update(payloadJson, "utf8").digest("hex");
    const token: ApprovalToken = { ...payload, sig };
    sink?.record({
      ts: this.now(),
      actorUserId: payload.actorUserId,
      projectId: payload.projectId,
      ...(payload.agentSessionId !== "" ? { agentSessionId: payload.agentSessionId } : {}),
      operationId: payload.operationId,
      action: payload.action,
      outcome: "approval-issued",
      via: payload.id,
      argsHash: payload.argsHash,
    });
    return { token, serialized: `${Buffer.from(payloadJson, "utf8").toString("base64url")}.${sig}` };
  }

  parse(serialized: unknown): { token: ApprovalToken; payloadJson: string } {
    if (typeof serialized !== "string") {
      throw new AuthorizationError("APPROVAL_INVALID", "Approval is malformed.", 403);
    }
    const dot = serialized.indexOf(".");
    if (dot <= 0) {
      throw new AuthorizationError("APPROVAL_INVALID", "Approval is malformed.", 403);
    }
    const payloadJson = Buffer.from(serialized.slice(0, dot), "base64url").toString("utf8");
    const sig = serialized.slice(dot + 1);
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(payloadJson);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      raw = parsed as Record<string, unknown>;
    } catch {
      throw new AuthorizationError("APPROVAL_INVALID", "Approval payload is malformed.", 403);
    }
    if (
      raw.v !== 2 ||
      typeof raw.id !== "string" ||
      !isHex(raw.id, 8) ||
      typeof raw.actorUserId !== "string" ||
      typeof raw.projectId !== "string" ||
      typeof raw.agentSessionId !== "string" ||
      typeof raw.action !== "string" ||
      !ACTION_CATEGORY[raw.action as ActionKind] ||
      typeof raw.argsHash !== "string" ||
      !isHex(raw.argsHash, 32) ||
      typeof raw.resource !== "string" ||
      typeof raw.networkNeed !== "string" ||
      !NETWORK_SCOPES.has(raw.networkNeed) ||
      typeof raw.execMode !== "string" ||
      !EXEC_MODES.has(raw.execMode) ||
      typeof raw.destination !== "string" ||
      typeof raw.revision !== "string" ||
      typeof raw.operationId !== "string" ||
      typeof raw.protectedTarget !== "boolean" ||
      typeof raw.epoch !== "string" ||
      !isHex(raw.epoch, 8) ||
      typeof raw.expiresAt !== "number" ||
      !Number.isInteger(raw.expiresAt) ||
      !isHex(sig, 32)
    ) {
      throw new AuthorizationError("APPROVAL_INVALID", "Approval fields are malformed.", 403);
    }
    const token: ApprovalToken = {
      v: 2,
      id: raw.id,
      actorUserId: raw.actorUserId,
      projectId: raw.projectId,
      agentSessionId: raw.agentSessionId,
      action: raw.action as ActionKind,
      argsHash: raw.argsHash,
      resource: raw.resource,
      networkNeed: raw.networkNeed,
      execMode: raw.execMode,
      destination: raw.destination,
      revision: raw.revision,
      operationId: raw.operationId,
      protectedTarget: raw.protectedTarget,
      epoch: raw.epoch,
      expiresAt: raw.expiresAt,
      sig,
    };
    return { token, payloadJson };
  }

  /**
   * Verification order: signature → epoch → revocation → expiry →
   * bindings → replay. Returns the token ID on success (consumed atomically).
   */
  verifyAndConsume(input: string | ApprovalToken, expected: ApprovalBinding, sink?: AuditSink): string {
    let token: ApprovalToken;
    let payloadJson: string;
    if (typeof input === "string") {
      const parsed = this.parse(input);
      token = parsed.token;
      payloadJson = parsed.payloadJson;
    } else {
      token = input;
      payloadJson = canonicalPayloadJson({
        v: token.v,
        id: token.id,
        actorUserId: token.actorUserId,
        projectId: token.projectId,
        agentSessionId: token.agentSessionId,
        action: token.action,
        argsHash: token.argsHash,
        resource: token.resource,
        networkNeed: token.networkNeed,
        execMode: token.execMode,
        destination: token.destination,
        revision: token.revision,
        operationId: token.operationId,
        protectedTarget: token.protectedTarget,
        epoch: token.epoch,
        expiresAt: token.expiresAt,
      });
    }
    const expectedSig = crypto.createHmac("sha256", this.secret).update(payloadJson, "utf8").digest("hex");
    if (!timingSafeEqualHex(token.sig, expectedSig)) {
      throw new AuthorizationError("APPROVAL_INVALID", "Approval signature is invalid.", 403, expected.operationId);
    }
    if (token.epoch !== this.epoch) {
      throw new AuthorizationError(
        "APPROVAL_INVALID",
        "Approval was issued by a stale issuer epoch (pre-restart approvals are invalid).",
        403,
        expected.operationId,
      );
    }
    if (this.revoked.has(token.id)) {
      throw new AuthorizationError("APPROVAL_REVOKED", "Approval was revoked.", 403, expected.operationId);
    }
    if (this.now() >= token.expiresAt) {
      throw new AuthorizationError("APPROVAL_EXPIRED", "Approval has expired.", 403, expected.operationId);
    }
    const matches =
      token.actorUserId === expected.actorUserId &&
      token.projectId === expected.projectId &&
      token.agentSessionId === expected.agentSessionId &&
      token.action === expected.action &&
      token.argsHash === expected.argsHash &&
      token.resource === expected.resource &&
      token.networkNeed === expected.networkNeed &&
      token.execMode === expected.execMode &&
      token.destination === expected.destination &&
      token.revision === expected.revision &&
      token.operationId === expected.operationId &&
      token.protectedTarget === expected.protectedTarget;
    if (!matches) {
      throw new AuthorizationError(
        "APPROVAL_MISMATCH",
        "Approval does not match this effective operation (actor, session, action, arguments, resource, network scope, exec mode, destination, revision, or operation).",
        403,
        expected.operationId,
      );
    }
    if (this.consumed.has(token.id)) {
      throw new AuthorizationError("APPROVAL_REPLAYED", "Approval was already consumed.", 403, expected.operationId);
    }
    this.consumed.add(token.id);
    sink?.record({
      ts: this.now(),
      actorUserId: token.actorUserId,
      projectId: token.projectId,
      ...(token.agentSessionId !== "" ? { agentSessionId: token.agentSessionId } : {}),
      operationId: token.operationId,
      action: token.action,
      outcome: "approval-consumed",
      via: token.id,
      argsHash: token.argsHash,
    });
    return token.id;
  }

  revoke(tokenId: string, byOperationId: string, sink?: AuditSink): void {
    validateId(byOperationId, "operationId");
    if (!isHex(tokenId, 8)) {
      throw new AuthorizationError("APPROVAL_INVALID", "Approval id is malformed.", 403, byOperationId);
    }
    this.revoked.add(tokenId);
    sink?.record({
      ts: this.now(),
      actorUserId: null,
      projectId: "",
      operationId: byOperationId,
      action: "approval.revoke",
      outcome: "approval-revoked",
      via: tokenId,
    });
  }
}
