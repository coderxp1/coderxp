/**
 * Authorization slice (DRAFT) — server-enforced project/action boundary contracts.
 *
 * Status: isolated draft work on the review branch. Depends on PR #1
 * (authentication) for verified user identity. Not yet wired into API routes,
 * the tool dispatcher, the runtime broker, storage, terminal attachment,
 * previews, or provider adapters; that integration is later work inside the
 * authorization slice's own review gate. Durable-storage and multi-process
 * follow-ups are documented in docs/authorization-slice-draft.md.
 *
 * Core rule: identity and project access derive from trusted server state
 * (verified session + server project registry). Request-body user IDs, model
 * claims, and frontend state are never authoritative here.
 */

export type ActionCategory = "read" | "write" | "execute" | "preview" | "external";

export type ActionKind =
  | "session.status"
  | "file.read"
  | "logs.read"
  | "file.write"
  | "file.delete"
  | "agent.stop"
  | "agent.restore"
  | "project.delete"
  | "runtime.allocate"
  | "exec"
  | "terminal.attach"
  | "terminal.input"
  | "terminal.resize"
  | "terminal.interrupt"
  | "terminal.lease"
  | "preview.create"
  | "preview.access"
  | "preview.revoke"
  | "git.push"
  | "remote.delete"
  | "disclosure"
  | "deploy"
  | "credential.use"
  | "spend";

export type NetworkNeed = "none" | "loopback" | "external";

/**
 * What the caller wants to do. The actor is deliberately absent: it is
 * derived server-side from the verified session, never accepted from input.
 */
export interface OperationDescriptor {
  operationId: string;
  projectId: string;
  agentSessionId?: string;
  action: ActionKind;
  /** Project-relative resource (path, slug, handle). Lexically validated. */
  resource?: string;
  /** Validated action arguments. Bound to approvals by hash, never trusted raw. */
  args?: unknown;
  destination?: string;
  revision?: string;
  protectedTarget?: boolean;
  /** Required for `exec`. Grants never cover `external`. */
  networkNeed?: NetworkNeed;
  /**
   * Required for `exec`. `"argv"` is direct structured dispatch;
   * `"shell-script"` is the explicit gated capability for shell-interpreted
   * execution and always requires an explicit approval (never a grant).
   */
  execMode?: "argv" | "shell-script";
}

export interface AuthorizationPrincipal {
  userId: string;
}

/** Grants may cover these categories only — never `external`. */
export type GrantableCategory = "read" | "write" | "execute" | "preview";

export interface SessionGrant {
  id: string;
  actorUserId: string;
  projectId: string;
  agentSessionIds: string[] | "*";
  categories: GrantableCategory[];
  /** Project-relative directory prefixes, or "*" entries for an explicitly broad grant. */
  resourcePrefixes: string[];
  egress: "none" | "loopback";
  /** True when any resource prefix is "*": shorter max TTL, still explicit and revocable. */
  broad: boolean;
  expiresAt: number;
  revokedAt: number | null;
  createdByOperationId: string;
  createdAt: number;
}

/**
 * Single-use, HMAC-bound approval. Binds the complete normalized effective
 * operation: actor, project, session, exact action, argument hash, resource,
 * network scope, execution capability, destination, revision,
 * protected-target flag, operation ID, issuer epoch, and expiry. Empty
 * string is the stable sentinel for unset optional bindings.
 */
export interface ApprovalToken {
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
  sig: string;
}

export type DenialCode =
  | "NOT_AUTHENTICATED"
  | "MALFORMED_REQUEST"
  | "NO_PROJECT_ACCESS"
  | "UNKNOWN_ACTION"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_INVALID"
  | "APPROVAL_MISMATCH"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_REVOKED"
  | "APPROVAL_REPLAYED"
  | "GRANT_NOT_FOUND"
  | "GRANT_EXPIRED"
  | "GRANT_REVOKED"
  | "GRANT_OUT_OF_SCOPE"
  | "DESTINATION_NOT_ALLOWED"
  | "AUTHORIZATION_UNAVAILABLE";

export class AuthorizationError extends Error {
  readonly code: DenialCode;
  readonly status: number;
  readonly operationId?: string;

  constructor(code: DenialCode, message: string, status: number, operationId?: string) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
    this.status = status;
    this.operationId = operationId;
  }
}

export interface AuthorizationSuccess {
  principal: AuthorizationPrincipal;
  projectId: string;
  agentSessionId?: string;
  operationId: string;
  action: ActionKind;
  via: { kind: "policy" | "grant" | "approval"; credentialId?: string };
}

export type AuthorizationOutcome =
  | "allowed"
  | "denied"
  | "approval-issued"
  | "approval-consumed"
  | "approval-revoked"
  | "grant-issued"
  | "grant-revoked";

export interface AuthorizationAuditEvent {
  ts: number;
  actorUserId: string | null;
  projectId: string;
  agentSessionId?: string;
  operationId: string;
  action: string;
  outcome: AuthorizationOutcome;
  via?: string;
  reason?: string;
  /** Arguments appear only as a hash. Raw args never enter the audit trail. */
  argsHash?: string;
}

export interface AuditSink {
  record(event: AuthorizationAuditEvent): void;
}
