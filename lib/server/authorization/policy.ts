/**
 * Authorization slice (DRAFT) — project access and per-action policy.
 *
 * Deliberately NOT command-name based: package scripts, tests, interpreters,
 * and free-form shell input are arbitrary code. No command substring or
 * regular-expression allowlist appears in this file; `exec` always requires
 * a scoped grant or an explicit approval, regardless of what the command is
 * named. This supersedes the substring tiering in lib/devbox/action-policy.ts
 * as a security boundary (that module is untouched by this draft).
 */

import {
  ActionCategory,
  ActionKind,
  AuthorizationError,
  AuthorizationPrincipal,
  GrantableCategory,
  NetworkNeed,
  OperationDescriptor,
} from "./types";
import { normalizeResourcePath, validateDestinationTransport, validateId } from "./util";

export const ACTION_CATEGORY: Record<ActionKind, ActionCategory> = {
  "session.status": "read",
  "file.read": "read",
  "logs.read": "read",
  "file.write": "write",
  "file.delete": "write",
  "agent.stop": "write",
  "agent.restore": "write",
  "project.delete": "write",
  "runtime.allocate": "execute",
  exec: "execute",
  "terminal.attach": "execute",
  "terminal.input": "execute",
  "terminal.resize": "execute",
  "terminal.interrupt": "execute",
  "preview.create": "preview",
  "preview.access": "preview",
  "preview.revoke": "preview",
  "git.push": "external",
  "remote.delete": "external",
  disclosure: "external",
  deploy: "external",
  "credential.use": "external",
  spend: "external",
};

const KNOWN_ACTIONS = new Set<string>(Object.keys(ACTION_CATEGORY));

export const GRANTABLE_CATEGORIES: ReadonlySet<GrantableCategory> = new Set([
  "read",
  "write",
  "execute",
  "preview",
]);

export function categorize(action: ActionKind): ActionCategory {
  const category = ACTION_CATEGORY[action];
  if (!category) {
    throw new AuthorizationError("UNKNOWN_ACTION", `Unknown action: ${String(action)}.`, 403);
  }
  return category;
}

/** Trusted server state: project ownership and per-project push destinations. */
export interface ProjectRegistry {
  getProjectOwner(projectId: string): string | null;
  isAllowedPushDestination(projectId: string, destination: string): boolean;
}

/** Trusted server state: agent-session home project (owned by the runtime broker). */
export interface SessionRegistry {
  getSessionProject(agentSessionId: string): string | null;
}

export class InMemoryProjectRegistry implements ProjectRegistry {
  private owners = new Map<string, string>();
  private pushDestinations = new Map<string, Set<string>>();

  registerPilotProject(projectId: string, ownerUserId: string, allowedPushDestinations?: string[]): void {
    validateId(projectId, "projectId");
    validateId(ownerUserId, "ownerUserId");
    this.owners.set(projectId, ownerUserId);
    this.pushDestinations.set(projectId, new Set(allowedPushDestinations ?? []));
  }

  getProjectOwner(projectId: string): string | null {
    return this.owners.get(projectId) ?? null;
  }

  isAllowedPushDestination(projectId: string, destination: string): boolean {
    return this.pushDestinations.get(projectId)?.has(destination) ?? false;
  }
}

export class InMemorySessionRegistry implements SessionRegistry {
  private sessions = new Map<string, string>();

  registerSession(agentSessionId: string, projectId: string): void {
    validateId(agentSessionId, "agentSessionId");
    validateId(projectId, "projectId");
    this.sessions.set(agentSessionId, projectId);
  }

  getSessionProject(agentSessionId: string): string | null {
    return this.sessions.get(agentSessionId) ?? null;
  }
}

const NETWORK_NEEDS: ReadonlySet<string> = new Set(["none", "loopback", "external"]);

/** Runtime shape validation for untrusted descriptor input. Never throws for policy reasons. */
export function validateDescriptor(input: unknown, operationId?: string): OperationDescriptor {
  if (typeof input !== "object" || input === null) {
    throw new AuthorizationError("MALFORMED_REQUEST", "descriptor must be an object.", 400, operationId);
  }
  const raw = input as Record<string, unknown>;
  const descOperationId = validateId(raw.operationId, "operationId", operationId);
  const projectId = validateId(raw.projectId, "projectId", descOperationId);
  if (typeof raw.action !== "string" || !KNOWN_ACTIONS.has(raw.action)) {
    throw new AuthorizationError("UNKNOWN_ACTION", "descriptor action is unknown.", 403, descOperationId);
  }
  const action = raw.action as ActionKind;

  let agentSessionId: string | undefined;
  if (raw.agentSessionId !== undefined) {
    agentSessionId = validateId(raw.agentSessionId, "agentSessionId", descOperationId);
  }
  let resource: string | undefined;
  if (raw.resource !== undefined) {
    resource = normalizeResourcePath(raw.resource, descOperationId);
  }
  let destination: string | undefined;
  if (raw.destination !== undefined) {
    destination = validateDestinationTransport(raw.destination, descOperationId);
  }
  let revision: string | undefined;
  if (raw.revision !== undefined) {
    if (typeof raw.revision !== "string" || raw.revision.length === 0 || raw.revision.length > 256) {
      throw new AuthorizationError("MALFORMED_REQUEST", "revision must be 1..256 chars.", 400, descOperationId);
    }
    if (/[\0-\x1F\x7F]/.test(raw.revision)) {
      throw new AuthorizationError("MALFORMED_REQUEST", "revision contains control characters.", 400, descOperationId);
    }
    revision = raw.revision;
  }
  let protectedTarget: boolean | undefined;
  if (raw.protectedTarget !== undefined) {
    if (typeof raw.protectedTarget !== "boolean") {
      throw new AuthorizationError("MALFORMED_REQUEST", "protectedTarget must be boolean.", 400, descOperationId);
    }
    protectedTarget = raw.protectedTarget;
  }
  let networkNeed: NetworkNeed | undefined;
  if (raw.networkNeed !== undefined) {
    if (typeof raw.networkNeed !== "string" || !NETWORK_NEEDS.has(raw.networkNeed)) {
      throw new AuthorizationError("MALFORMED_REQUEST", "networkNeed is invalid.", 400, descOperationId);
    }
    networkNeed = raw.networkNeed as NetworkNeed;
  }
  if (action === "exec" && networkNeed === undefined) {
    throw new AuthorizationError("MALFORMED_REQUEST", "exec must declare networkNeed.", 400, descOperationId);
  }
  if ((action === "git.push" || action === "deploy") && destination === undefined) {
    throw new AuthorizationError("MALFORMED_REQUEST", `${action} requires a destination.`, 400, descOperationId);
  }

  return {
    operationId: descOperationId,
    projectId,
    ...(agentSessionId !== undefined ? { agentSessionId } : {}),
    action,
    ...(resource !== undefined ? { resource } : {}),
    ...(raw.args !== undefined ? { args: raw.args } : {}),
    ...(destination !== undefined ? { destination } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(protectedTarget !== undefined ? { protectedTarget } : {}),
    ...(networkNeed !== undefined ? { networkNeed } : {}),
  };
}

export type CredentialNeed = "none" | "grant-or-approval" | "explicit-approval";

/**
 * Pure policy step: project ownership, session home project, destination
 * allowlist, and what kind of credential (if any) can satisfy the action.
 * Throws typed AuthorizationError denials; performs no side effects.
 */
export function evaluatePolicy(
  descriptor: OperationDescriptor,
  principal: AuthorizationPrincipal,
  projects: ProjectRegistry,
  sessions: SessionRegistry,
): { needs: CredentialNeed } {
  const owner = projects.getProjectOwner(descriptor.projectId);
  if (owner === null || owner !== principal.userId) {
    throw new AuthorizationError(
      "NO_PROJECT_ACCESS",
      "No access to this project.",
      403,
      descriptor.operationId,
    );
  }
  if (descriptor.agentSessionId !== undefined) {
    const home = sessions.getSessionProject(descriptor.agentSessionId);
    if (home === null || home !== descriptor.projectId) {
      throw new AuthorizationError(
        "NO_PROJECT_ACCESS",
        "Agent session does not belong to this project.",
        403,
        descriptor.operationId,
      );
    }
  }
  if (descriptor.destination !== undefined && descriptor.action === "git.push") {
    if (!projects.isAllowedPushDestination(descriptor.projectId, descriptor.destination)) {
      throw new AuthorizationError(
        "DESTINATION_NOT_ALLOWED",
        "Push destination is not allowlisted for this project.",
        403,
        descriptor.operationId,
      );
    }
  }
  const category = categorize(descriptor.action);
  if (category === "read") return { needs: "none" };
  if (category === "external") return { needs: "explicit-approval" };
  return { needs: "grant-or-approval" };
}
