/**
 * Agent runtime slice — authorized dispatch.
 *
 * The provider never runs from caller-supplied parameters alone. Every
 * dispatch takes the AuthorizationSuccess PLUS the exact descriptor that
 * was authorized, and asserts the runtime request equals that descriptor
 * (operation, project, session, action, resource, arguments, network
 * scope, exec mode). Any divergence fails closed with APPROVAL_MISMATCH
 * semantics and the provider is never invoked.
 */

import { AuthorizationError } from "../authorization/types";
import type { SessionRuntime } from "./provider";
import type {
  AuthorizedCall,
  ControlLease,
  ExecOutcome,
  ExecRequest,
  LeaseHolder,
  SessionInfo,
} from "./types";

function stableJson(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function mismatch(operationId: string, what: string): AuthorizationError {
  return new AuthorizationError(
    "APPROVAL_MISMATCH",
    `Refusing to dispatch: request ${what} differs from the authorized operation.`,
    403,
    operationId,
  );
}

function requireBase(call: AuthorizedCall, action: string, projectId: string, agentSessionId?: string): void {
  if (call.authz.action !== action || call.descriptor.action !== action) {
    throw mismatch(call.authz.operationId, "action");
  }
  if (call.authz.projectId !== projectId || call.descriptor.projectId !== projectId) {
    throw mismatch(call.authz.operationId, "project");
  }
  const authedSession = call.authz.agentSessionId ?? call.descriptor.agentSessionId;
  if (agentSessionId !== undefined && authedSession !== agentSessionId) {
    throw mismatch(call.authz.operationId, "agent session");
  }
  if (call.descriptor.operationId !== call.authz.operationId) {
    throw mismatch(call.authz.operationId, "operation id");
  }
}

export class AuthorizedRuntime {
  constructor(private readonly runtime: SessionRuntime) {}

  async allocate(
    call: AuthorizedCall,
    req: { operationId: string; projectId: string; ownerUserId: string; agentSessionId?: string; cols: number; rows: number },
  ): Promise<{ info: SessionInfo; lease: ControlLease }> {
    requireBase(call, "runtime.allocate", req.projectId, req.agentSessionId);
    if (call.authz.operationId !== req.operationId) throw mismatch(req.operationId, "operation id");
    if (call.authz.principal.userId !== req.ownerUserId) throw mismatch(req.operationId, "owner");
    return this.runtime.allocate(req);
  }

  async exec(call: AuthorizedCall, req: ExecRequest): Promise<ExecOutcome> {
    requireBase(call, "exec", req.projectId, req.agentSessionId);
    if (call.authz.operationId !== req.operationId) throw mismatch(req.operationId, "operation id");
    if ((call.descriptor.resource ?? "") !== req.resource) throw mismatch(req.operationId, "resource");
    if (stableJson(call.descriptor.args ?? null) !== stableJson(req.args)) throw mismatch(req.operationId, "arguments");
    if ((call.descriptor.networkNeed ?? "") !== req.networkNeed) throw mismatch(req.operationId, "network scope");
    if ((call.descriptor.execMode ?? "") !== req.execMode) throw mismatch(req.operationId, "exec mode");
    return this.runtime.exec(req);
  }

  attach(call: AuthorizedCall, sessionId: string, cursor: number): ReturnType<SessionRuntime["attach"]> {
    requireBase(call, "terminal.attach", call.descriptor.projectId, sessionId);
    return this.runtime.attach(sessionId, cursor);
  }

  input(
    call: AuthorizedCall,
    sessionId: string,
    data: string,
    lease: { holder: LeaseHolder; token: string },
  ): { acceptedBytes: number } {
    requireBase(call, "terminal.input", call.descriptor.projectId, sessionId);
    if (call.descriptor.operationId !== call.authz.operationId) throw mismatch(call.authz.operationId, "operation id");
    return this.runtime.input(sessionId, data, lease);
  }

  resize(call: AuthorizedCall, sessionId: string, cols: number, rows: number): void {
    requireBase(call, "terminal.resize", call.descriptor.projectId, sessionId);
    return this.runtime.resize(sessionId, cols, rows);
  }

  interrupt(call: AuthorizedCall, sessionId: string): void {
    requireBase(call, "terminal.interrupt", call.descriptor.projectId, sessionId);
    return this.runtime.interrupt(sessionId);
  }

  acquireLease(call: AuthorizedCall, sessionId: string, holder: LeaseHolder, takeover: boolean): ControlLease {
    requireBase(call, "terminal.lease", call.descriptor.projectId, sessionId);
    return this.runtime.acquireLease(sessionId, holder, takeover);
  }

  releaseLease(call: AuthorizedCall, sessionId: string, holder: LeaseHolder, token: string): void {
    requireBase(call, "terminal.lease", call.descriptor.projectId, sessionId);
    return this.runtime.releaseLease(sessionId, holder, token);
  }

  cancelOp(call: AuthorizedCall, sessionId: string, operationId: string): { cancelled: boolean; outcome: ExecOutcome | null } {
    requireBase(call, "agent.stop", call.descriptor.projectId, sessionId);
    return this.runtime.cancelOp(sessionId, operationId);
  }

  stopSession(call: AuthorizedCall, sessionId: string): Promise<{ state: string; detail: string }> {
    requireBase(call, "agent.stop", call.descriptor.projectId, sessionId);
    return this.runtime.stopSession(sessionId);
  }

  status(call: AuthorizedCall, sessionId: string): ReturnType<SessionRuntime["status"]> {
    requireBase(call, "session.status", call.descriptor.projectId, sessionId);
    return this.runtime.status(sessionId);
  }
}
