/**
 * Authorization slice (DRAFT) — the single server-enforced entry point.
 *
 * `authorize` is the only function that turns a session token plus an
 * operation descriptor into permission to act. Providers, brokers, storage,
 * terminal attachment, previews, and external adapters must only be invoked
 * with an AuthorizationSuccess in hand. Every denial path throws a typed
 * AuthorizationError and performs no runtime, storage, credential, or
 * network side effects (callers authorize BEFORE touching providers).
 *
 * Dependency on PR #1: the default session validator uses
 * `verifySessionToken` from lib/server/auth, so password-change generation
 * invalidation and fail-closed secret configuration are inherited. Tests
 * inject a fake validator and never touch real auth state.
 *
 * Fail-closed unavailability: missing or throwing authorization
 * dependencies (session validation, project/session registries, audit
 * sink) deny with AUTHORIZATION_UNAVAILABLE (HTTP 503). An unaudited
 * success is never returned.
 */

import { verifySessionToken } from "../auth";
import { hostEventStore } from "../devbox-event-store";
import { ApprovalIssuer } from "./approvals";
import { GrantStore } from "./grants";
import {
  ApprovalToken,
  AuditSink,
  AuthorizationError,
  AuthorizationSuccess,
  OperationDescriptor,
} from "./types";
import { evaluatePolicy, ProjectRegistry, SessionRegistry, validateDescriptor } from "./policy";
import { argsHashFor } from "./util";

export type SessionValidator = (token: string) => { userId: string } | null;

export function createDefaultSessionValidator(): SessionValidator {
  return (token: string) => {
    if (!token || typeof token !== "string") return null;
    const result = verifySessionToken(token);
    if (!result.valid || !result.payload) return null;
    return { userId: result.payload.userId };
  };
}

/** Production audit sink: authorization decisions as host events (no raw args). */
export function createEventStoreAuditSink(): AuditSink {
  return {
    record(event) {
      const tier =
        event.outcome === "denied"
          ? event.action === "git.push" ||
            event.action === "deploy" ||
            event.action === "spend" ||
            event.action === "credential.use"
            ? "T3"
            : "T2"
          : event.outcome === "allowed" && event.via === "policy"
            ? "T0"
            : "T2";
      // NOTE (draft): the ProjectEventType union has no authz-specific member and
      // this draft does not modify shared contracts. Decisions map onto
      // "approval.decided" with the outcome in data; a dedicated event type is
      // follow-up work inside the authorization slice's own review gate.
      hostEventStore.recordEvent({
        projectId: event.projectId,
        tier,
        type: "approval.decided",
        data: {
          actorUserId: event.actorUserId,
          agentSessionId: event.agentSessionId ?? "",
          operationId: event.operationId,
          action: event.action,
          outcome: event.outcome,
          via: event.via ?? "",
          reason: event.reason ?? "",
          argsHash: event.argsHash ?? "",
        },
      });
    },
  };
}

export interface AuthorizeDeps {
  validateSession: SessionValidator;
  projects: ProjectRegistry;
  sessions: SessionRegistry;
  approvals: ApprovalIssuer;
  grants: GrantStore;
  sink: AuditSink;
}

export interface AuthorizeInput {
  token: unknown;
  descriptor: unknown;
  grantId?: unknown;
  approval?: string | ApprovalToken;
}

export function authorize(deps: AuthorizeDeps, input: AuthorizeInput): AuthorizationSuccess {
  try {
    if (
      !deps ||
      typeof deps.validateSession !== "function" ||
      !deps.projects ||
      !deps.sessions ||
      !deps.approvals ||
      !deps.grants ||
      !deps.sink
    ) {
      throw new AuthorizationError("AUTHORIZATION_UNAVAILABLE", "Authorization dependencies are unavailable; failing closed.", 503);
    }
    if (typeof input.token !== "string" || input.token === "") {
      throw new AuthorizationError("NOT_AUTHENTICATED", "Authentication required.", 401);
    }
    const session = deps.validateSession(input.token);
    if (!session) {
      throw new AuthorizationError("NOT_AUTHENTICATED", "Invalid or expired session.", 401);
    }
    const descriptor: OperationDescriptor = validateDescriptor(input.descriptor);
    const principal = { userId: session.userId };
    const { needs } = evaluatePolicy(descriptor, principal, deps.projects, deps.sessions);

    if (needs === "none") {
      deps.sink.record({
        ts: Date.now(),
        actorUserId: principal.userId,
        projectId: descriptor.projectId,
        ...(descriptor.agentSessionId !== undefined ? { agentSessionId: descriptor.agentSessionId } : {}),
        operationId: descriptor.operationId,
        action: descriptor.action,
        outcome: "allowed",
        via: "policy",
        argsHash: argsHashFor(descriptor.args),
      });
      return {
        principal,
        projectId: descriptor.projectId,
        ...(descriptor.agentSessionId !== undefined ? { agentSessionId: descriptor.agentSessionId } : {}),
        operationId: descriptor.operationId,
        action: descriptor.action,
        via: { kind: "policy" },
      };
    }

    if (input.approval !== undefined) {
      const credentialId = deps.approvals.verifyAndConsume(
        input.approval,
        {
          actorUserId: principal.userId,
          projectId: descriptor.projectId,
          agentSessionId: descriptor.agentSessionId ?? "",
          action: descriptor.action,
          argsHash: argsHashFor(descriptor.args),
          resource: descriptor.resource ?? "",
          networkNeed: descriptor.networkNeed ?? "",
          execMode: descriptor.execMode ?? "",
          destination: descriptor.destination ?? "",
          revision: descriptor.revision ?? "",
          operationId: descriptor.operationId,
          protectedTarget: descriptor.protectedTarget ?? false,
        },
        deps.sink,
      );
      deps.sink.record({
        ts: Date.now(),
        actorUserId: principal.userId,
        projectId: descriptor.projectId,
        ...(descriptor.agentSessionId !== undefined ? { agentSessionId: descriptor.agentSessionId } : {}),
        operationId: descriptor.operationId,
        action: descriptor.action,
        outcome: "allowed",
        via: `approval:${credentialId}`,
        argsHash: argsHashFor(descriptor.args),
      });
      return {
        principal,
        projectId: descriptor.projectId,
        ...(descriptor.agentSessionId !== undefined ? { agentSessionId: descriptor.agentSessionId } : {}),
        operationId: descriptor.operationId,
        action: descriptor.action,
        via: { kind: "approval", credentialId },
      };
    }

    if (needs === "explicit-approval") {
      throw new AuthorizationError(
        "APPROVAL_REQUIRED",
        "This action requires its own explicit approval; grants cannot satisfy it.",
        403,
        descriptor.operationId,
      );
    }

    if (typeof input.grantId !== "string" || input.grantId === "") {
      throw new AuthorizationError(
        "APPROVAL_REQUIRED",
        "This action requires a scoped grant or an explicit approval.",
        403,
        descriptor.operationId,
      );
    }
    const grant = deps.grants.get(input.grantId);
    if (!grant) {
      throw new AuthorizationError("GRANT_NOT_FOUND", "Grant does not exist.", 403, descriptor.operationId);
    }
    const check = deps.grants.check(grant, descriptor, principal.userId);
    if (!check.ok) {
      const messages: Record<string, string> = {
        GRANT_EXPIRED: "Grant has expired.",
        GRANT_REVOKED: "Grant was revoked.",
        GRANT_OUT_OF_SCOPE: "Grant does not cover this actor, session, action, resource, or network scope.",
      };
      throw new AuthorizationError(check.code, messages[check.code] ?? "Grant cannot satisfy this action.", 403, descriptor.operationId);
    }
    deps.sink.record({
      ts: Date.now(),
      actorUserId: principal.userId,
      projectId: descriptor.projectId,
      ...(descriptor.agentSessionId !== undefined ? { agentSessionId: descriptor.agentSessionId } : {}),
      operationId: descriptor.operationId,
      action: descriptor.action,
      outcome: "allowed",
      via: `grant:${grant.id}`,
      argsHash: argsHashFor(descriptor.args),
    });
    return {
      principal,
      projectId: descriptor.projectId,
      ...(descriptor.agentSessionId !== undefined ? { agentSessionId: descriptor.agentSessionId } : {}),
      operationId: descriptor.operationId,
      action: descriptor.action,
      via: { kind: "grant", credentialId: grant.id },
    };
  } catch (err) {
    const rawDescriptor =
      input !== null && typeof input === "object"
        ? (input.descriptor as Partial<OperationDescriptor> | null)
        : null;
    const fallbackProjectId = typeof rawDescriptor?.projectId === "string" ? rawDescriptor.projectId : "";
    const fallbackSessionId = typeof rawDescriptor?.agentSessionId === "string" ? rawDescriptor.agentSessionId : undefined;
    const fallbackOperationId = typeof rawDescriptor?.operationId === "string" ? rawDescriptor.operationId : "";
    const fallbackAction = typeof rawDescriptor?.action === "string" ? rawDescriptor.action : "unknown";
    if (err instanceof AuthorizationError) {
      try {
        deps.sink.record({
          ts: Date.now(),
          actorUserId: null,
          projectId: fallbackProjectId,
          ...(fallbackSessionId !== undefined ? { agentSessionId: fallbackSessionId } : {}),
          operationId: fallbackOperationId,
          action: fallbackAction,
          outcome: "denied",
          reason: err.code,
        });
      } catch {
        throw new AuthorizationError(
          "AUTHORIZATION_UNAVAILABLE",
          "Authorization audit is unavailable; failing closed.",
          503,
          fallbackOperationId === "" ? undefined : fallbackOperationId,
        );
      }
      throw err;
    }
    // Any unexpected dependency failure (session validation, registries,
    // audit sink) fails closed: best-effort denial audit, then deny.
    try {
      deps.sink.record({
        ts: Date.now(),
        actorUserId: null,
        projectId: fallbackProjectId,
        ...(fallbackSessionId !== undefined ? { agentSessionId: fallbackSessionId } : {}),
        operationId: fallbackOperationId,
        action: fallbackAction,
        outcome: "denied",
        reason: "AUTHORIZATION_UNAVAILABLE",
      });
    } catch {
      // Already failing closed; an unauditable failure still denies.
    }
    throw new AuthorizationError(
      "AUTHORIZATION_UNAVAILABLE",
      "Authorization state is unavailable; failing closed.",
      503,
      fallbackOperationId === "" ? undefined : fallbackOperationId,
    );
  }
}
