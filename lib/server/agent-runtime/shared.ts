/**
 * Agent runtime slice — production singletons and trusted registries.
 *
 * Single authority per process: one approval issuer (one epoch), one grant
 * store, one session registry, one runtime provider. Authorization inputs
 * (project owner, session home project) come from server-side runtime
 * state, never from client claims. Project names are unique per data dir:
 * the first allocating owner wins and later cross-owner claims conflict.
 *
 * Environment: ACTION_AUTH_SECRET (required, ≥32 chars, fail closed),
 * RUNTIME_DATA_DIR (default .data/agent-runtime), RUNTIME_NETNS
 * (required|off, default required), RUNTIME_LIMITS (required|off, default
 * required), RUNTIME_SHELL (default /bin/sh).
 */

import path from "node:path";
import { ApprovalIssuer } from "../authorization/approvals";
import { authorize, type AuthorizeDeps, createDefaultSessionValidator, createEventStoreAuditSink } from "../authorization/enforce";
import { GrantStore } from "../authorization/grants";
import type { ProjectRegistry, SessionRegistry } from "../authorization/policy";
import { AuthorizedRuntime } from "./authorized-provider";
import { createNodePtyFactory, defaultChildFactory, defaultPidAlive, DEFAULT_RUNTIME_CONFIG, SessionRuntime } from "./provider";
import { RuntimeSessionRegistry } from "./sessions";

/** Trusted server state: project owner resolved from the runtime registry. */
export class RuntimeProjectRegistry implements ProjectRegistry {
  constructor(private readonly sessions: RuntimeSessionRegistry) {}

  getProjectOwner(projectId: string): string | null {
    try {
      return this.sessions.findProjectOwner(projectId);
    } catch {
      return null;
    }
  }

  isAllowedPushDestination(_projectId: string, _destination: string): boolean {
    // This slice offers no git push path; the allowlist is empty by construction.
    return false;
  }
}

/** Trusted server state: session home project from the live registry. */
export class RuntimeSessionProjectRegistry implements SessionRegistry {
  constructor(private readonly sessions: RuntimeSessionRegistry) {}

  getSessionProject(agentSessionId: string): string | null {
    try {
      return this.sessions.getSessionProject(agentSessionId);
    } catch {
      return null;
    }
  }
}

export interface RuntimeSingletons {
  authz: AuthorizeDeps;
  registry: RuntimeSessionRegistry;
  runtime: SessionRuntime;
  authorized: AuthorizedRuntime;
  authorize: typeof authorize;
}

let singletons: RuntimeSingletons | null = null;

function readSecret(): string {
  const secret = process.env.ACTION_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("ACTION_AUTH_SECRET must be set to at least 32 characters (fail closed).");
  }
  return secret;
}

export function getRuntimeSingletons(): RuntimeSingletons {
  if (singletons) return singletons;
  const dataDir = process.env.RUNTIME_DATA_DIR ?? path.join(process.cwd(), ".data", "agent-runtime");
  const registry = new RuntimeSessionRegistry(dataDir);
  const runtime = new SessionRuntime({
    registry,
    ptyFactory: createNodePtyFactory(),
    childFactory: defaultChildFactory,
    pidAlive: defaultPidAlive,
    config: {
      ...DEFAULT_RUNTIME_CONFIG,
      shell: process.env.RUNTIME_SHELL ?? DEFAULT_RUNTIME_CONFIG.shell,
      netnsRequired: (process.env.RUNTIME_NETNS ?? "required") !== "off",
      limitsRequired: (process.env.RUNTIME_LIMITS ?? "required") !== "off",
    },
  });
  const authz: AuthorizeDeps = {
    validateSession: createDefaultSessionValidator(),
    projects: new RuntimeProjectRegistry(registry),
    sessions: new RuntimeSessionProjectRegistry(registry),
    approvals: new ApprovalIssuer(readSecret()),
    grants: new GrantStore(),
    sink: createEventStoreAuditSink(),
  };
  singletons = { authz, registry, runtime, authorized: new AuthorizedRuntime(runtime), authorize };
  return singletons;
}

/** Test-only escape hatch; production code never resets the single authority. */
export function __resetRuntimeSingletonsForTests(): void {
  singletons = null;
}

/** Route-entry helper: throws fail-closed when singletons cannot initialize. */
export function getHandlerContext(): import("./handlers").RuntimeContext {
  const s = getRuntimeSingletons();
  return { authz: s.authz, authorized: s.authorized, runtime: s.runtime, registry: s.registry };
}
