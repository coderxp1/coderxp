/**
 * Authorization slice (DRAFT) — server-enforced boundary regression tests.
 *
 * Covers: unauthenticated denial; cross-user/project/agent denial; forged,
 * expired, revoked, replayed, and altered approvals; scoped session grants
 * (issue/check/revoke/expiry/review); exec-as-arbitrary-code (no
 * command-name bypass); external actions requiring their own approval;
 * terminal/preview ownership; full-operation approval binding (resource,
 * network scope, exec capability); shell-script as an approval-only gated
 * capability; issuer-epoch invalidation of pre-restart approvals; fail-closed
 * unavailable state (503); denial without provider side effects; and a
 * redacted audit trail. Deterministic: fixed fixtures plus a manual clock.
 */
import assert from "node:assert/strict";
import { ApprovalIssuer } from "../lib/server/authorization/approvals";
import {
  authorize,
  AuthorizeDeps,
  createDefaultSessionValidator,
} from "../lib/server/authorization/enforce";
import { GrantStore } from "../lib/server/authorization/grants";
import {
  InMemoryProjectRegistry,
  InMemorySessionRegistry,
} from "../lib/server/authorization/policy";
import {
  AuthorizationAuditEvent,
  AuthorizationError,
  AuthorizationSuccess,
} from "../lib/server/authorization/types";

let now = 1_700_000_000_000;
const clock = () => now;

const APPROVAL_SECRET = "test-only-action-auth-secret-for-authz-tests-01";

const TOKEN_A = "token-userA";
const TOKEN_B = "token-userB";

function fakeValidator(token: string): { userId: string } | null {
  if (token === TOKEN_A) return { userId: "userA" };
  if (token === TOKEN_B) return { userId: "userB" };
  return null;
}

interface Fixture {
  deps: AuthorizeDeps;
  events: AuthorizationAuditEvent[];
  providerCalls: string[];
  projects: InMemoryProjectRegistry;
  sessions: InMemorySessionRegistry;
  approvals: ApprovalIssuer;
  grants: GrantStore;
}

function buildFixture(): Fixture {
  const events: AuthorizationAuditEvent[] = [];
  const providerCalls: string[] = [];
  const projects = new InMemoryProjectRegistry();
  projects.registerPilotProject("projP", "userA", ["https://github.com/example/projP.git"]);
  projects.registerPilotProject("projQ", "userB");
  const sessions = new InMemorySessionRegistry();
  sessions.registerSession("sessA1", "projP");
  sessions.registerSession("sessA2", "projP");
  sessions.registerSession("sessB1", "projQ");
  const deps: AuthorizeDeps = {
    validateSession: fakeValidator,
    projects,
    sessions,
    approvals: new ApprovalIssuer(APPROVAL_SECRET, { now: clock }),
    grants: new GrantStore({ now: clock }),
    sink: { record: (e) => events.push(e) },
  };
  return { deps, events, providerCalls, projects, sessions, approvals: deps.approvals, grants: deps.grants };
}

async function runIfAuthorized(
  fx: Fixture,
  input: Parameters<typeof authorize>[1],
): Promise<AuthorizationSuccess> {
  const authz = authorize(fx.deps, input);
  fx.providerCalls.push(`${authz.action}:${authz.operationId}`);
  return authz;
}

async function expectDenial(
  fx: Fixture,
  input: Parameters<typeof authorize>[1],
  code: string,
): Promise<AuthorizationError> {
  const callsBefore = fx.providerCalls.length;
  try {
    await runIfAuthorized(fx, input);
  } catch (err) {
    assert.ok(err instanceof AuthorizationError, "denial must be a typed AuthorizationError");
    assert.equal(err.code, code, `expected denial ${code}`);
    assert.equal(fx.providerCalls.length, callsBefore, "denied requests must not touch the provider");
    return err;
  }
  assert.fail(`expected denial ${code}, but the action was allowed`);
}

async function main(): Promise<void> {
  console.log("=== ACTION AUTHORIZATION BOUNDARY TESTS (DRAFT) ===");

  console.log("--- 1. Unauthenticated requests are denied ---");
  {
    const fx = buildFixture();
    await expectDenial(fx, { token: "", descriptor: { operationId: "op-1", projectId: "projP", action: "file.read" } }, "NOT_AUTHENTICATED");
    await expectDenial(fx, { token: "bogus", descriptor: { operationId: "op-2", projectId: "projP", action: "file.read" } }, "NOT_AUTHENTICATED");
    const err = await expectDenial(fx, { token: "", descriptor: { operationId: "op-3", projectId: "projP", action: "exec", networkNeed: "none", args: { argv: ["id"] } } }, "NOT_AUTHENTICATED");
    assert.equal(err.status, 401);
    console.log("[PASS] Unauthenticated denied with no provider side effects.");
  }

  console.log("--- 2. Reads allowed by policy; cross-project reads denied ---");
  {
    const fx = buildFixture();
    const ok = await runIfAuthorized(fx, {
      token: TOKEN_A,
      descriptor: { operationId: "op-10", projectId: "projP", action: "file.read", resource: "src/app.ts" },
    });
    assert.equal(ok.via.kind, "policy");
    const okStatus = await runIfAuthorized(fx, {
      token: TOKEN_A,
      descriptor: { operationId: "op-11", projectId: "projP", action: "session.status", agentSessionId: "sessA1" },
    });
    assert.equal(okStatus.via.kind, "policy");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-12", projectId: "projQ", action: "file.read", resource: "src/app.ts" } }, "NO_PROJECT_ACCESS");
    await expectDenial(fx, { token: TOKEN_B, descriptor: { operationId: "op-13", projectId: "projP", action: "logs.read" } }, "NO_PROJECT_ACCESS");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-14", projectId: "nope", action: "file.read" } }, "NO_PROJECT_ACCESS");
    console.log("[PASS] Policy reads and project boundary enforced.");
  }

  console.log("--- 3. Writes need a grant or approval; malformed input rejected ---");
  {
    const fx = buildFixture();
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-20", projectId: "projP", action: "file.write", resource: "src/app.ts", args: { content: "x" } } }, "APPROVAL_REQUIRED");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-21", projectId: "projP", action: "file.write", resource: "../escape.ts", args: {} } }, "MALFORMED_REQUEST");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-22", projectId: "projP", action: "file.write", resource: "/abs/path.ts", args: {} } }, "MALFORMED_REQUEST");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "bad op!", projectId: "projP", action: "file.read" } }, "MALFORMED_REQUEST");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-23", projectId: "projP", action: "nope.action" } }, "UNKNOWN_ACTION");
    console.log("[PASS] Credential requirement and descriptor validation enforced.");
  }

  console.log("--- 4. Scoped grant happy path ---");
  {
    const fx = buildFixture();
    const grant = fx.grants.issue(
      {
        actorUserId: "userA",
        projectId: "projP",
        agentSessionIds: ["sessA1"],
        categories: ["write", "execute"],
        resourcePrefixes: ["src"],
        egress: "loopback",
        ttlMs: 60 * 60 * 1000,
        createdByOperationId: "op-30",
      },
      fx.deps.sink,
    );
    const ok = await runIfAuthorized(fx, {
      token: TOKEN_A,
      grantId: grant.id,
      descriptor: { operationId: "op-31", projectId: "projP", agentSessionId: "sessA1", action: "file.write", resource: "src/app.ts", args: { content: "x" } },
    });
    assert.equal(ok.via.kind, "grant");
    assert.equal(ok.via.credentialId, grant.id);
    const okExec = await runIfAuthorized(fx, {
      token: TOKEN_A,
      grantId: grant.id,
      descriptor: { operationId: "op-32", projectId: "projP", agentSessionId: "sessA1", action: "exec", resource: "src", args: { argv: ["npm", "test"] }, networkNeed: "loopback", execMode: "argv" },
    });
    assert.equal(okExec.via.kind, "grant");
    assert.equal(fx.providerCalls.length, 2);
    console.log("[PASS] In-scope grant authorizes write and exec.");
  }

  console.log("--- 5. Grant scope denials (resource, session, category, network) ---");
  {
    const fx = buildFixture();
    const grant = fx.grants.issue({
      actorUserId: "userA",
      projectId: "projP",
      agentSessionIds: ["sessA1"],
      categories: ["write", "execute"],
      resourcePrefixes: ["src"],
      egress: "loopback",
      ttlMs: 60 * 60 * 1000,
      createdByOperationId: "op-40",
    });
    await expectDenial(fx, { token: TOKEN_A, grantId: grant.id, descriptor: { operationId: "op-41", projectId: "projP", agentSessionId: "sessA1", action: "file.write", resource: "etc/config", args: {} } }, "GRANT_OUT_OF_SCOPE");
    await expectDenial(fx, { token: TOKEN_A, grantId: grant.id, descriptor: { operationId: "op-42", projectId: "projP", agentSessionId: "sessA2", action: "file.write", resource: "src/app.ts", args: {} } }, "GRANT_OUT_OF_SCOPE");
    await expectDenial(fx, { token: TOKEN_A, grantId: grant.id, descriptor: { operationId: "op-43", projectId: "projP", agentSessionId: "sessA1", action: "preview.create", resource: "previews/a" } }, "GRANT_OUT_OF_SCOPE");
    await expectDenial(fx, { token: TOKEN_B, grantId: grant.id, descriptor: { operationId: "op-44", projectId: "projP", agentSessionId: "sessA1", action: "file.write", resource: "src/app.ts", args: {} } }, "NO_PROJECT_ACCESS");
    await expectDenial(fx, { token: TOKEN_A, grantId: grant.id, descriptor: { operationId: "op-45", projectId: "projP", agentSessionId: "sessA1", action: "exec", resource: "src", args: { argv: ["curl", "https://example.com"] }, networkNeed: "external", execMode: "argv" } }, "GRANT_OUT_OF_SCOPE");
    await expectDenial(fx, { token: TOKEN_A, grantId: grant.id, descriptor: { operationId: "op-46", projectId: "projP", agentSessionId: "sessA1", action: "exec", resource: "src", args: { script: "npm test" }, networkNeed: "none", execMode: "shell-script" } }, "GRANT_OUT_OF_SCOPE");
    console.log("[PASS] Out-of-scope grant use denied across all scope axes (incl. shell-script).");
  }

  console.log("--- 6. Grant lifecycle: revoke, expiry, unknown, reviewability ---");
  {
    const fx = buildFixture();
    const g1 = fx.grants.issue({ actorUserId: "userA", projectId: "projP", agentSessionIds: ["sessA1"], categories: ["write"], resourcePrefixes: ["src"], egress: "none", ttlMs: 60 * 60 * 1000, createdByOperationId: "op-50" }, fx.deps.sink);
    const g2 = fx.grants.issue({ actorUserId: "userA", projectId: "projP", agentSessionIds: ["sessA1"], categories: ["read"], resourcePrefixes: ["src"], egress: "none", ttlMs: 2000, createdByOperationId: "op-51" }, fx.deps.sink);
    assert.equal(fx.grants.listActive({ projectId: "projP" }).length, 2);
    fx.grants.revoke(g1.id, "op-52", fx.deps.sink);
    await expectDenial(fx, { token: TOKEN_A, grantId: g1.id, descriptor: { operationId: "op-53", projectId: "projP", agentSessionId: "sessA1", action: "file.write", resource: "src/a.ts", args: {} } }, "GRANT_REVOKED");
    now += 5000;
    await expectDenial(fx, { token: TOKEN_A, grantId: g2.id, descriptor: { operationId: "op-54", projectId: "projP", agentSessionId: "sessA1", action: "file.write", resource: "src/a.ts", args: {} } }, "GRANT_EXPIRED");
    await expectDenial(fx, { token: TOKEN_A, grantId: "deadbeefdeadbeef", descriptor: { operationId: "op-55", projectId: "projP", action: "file.write", resource: "src/a.ts", args: {} } }, "GRANT_NOT_FOUND");
    assert.equal(fx.grants.listActive({ projectId: "projP" }).length, 0);
    console.log("[PASS] Revocation, expiry, unknown grants, and review listing behave.");
  }

  console.log("--- 7. Grant issuance is bounded by construction ---");
  {
    const fx = buildFixture();
    assert.throws(() =>
      fx.grants.issue({ actorUserId: "userA", projectId: "projP", agentSessionIds: ["sessA1"], categories: ["external" as unknown as "write"], resourcePrefixes: ["src"], egress: "none", ttlMs: 60000, createdByOperationId: "op-60" }),
    );
    assert.throws(() =>
      fx.grants.issue({ actorUserId: "userA", projectId: "projP", agentSessionIds: ["sessA1"], categories: ["write"], resourcePrefixes: [], egress: "none", ttlMs: 60000, createdByOperationId: "op-61" }),
    );
    assert.throws(() =>
      fx.grants.issue({ actorUserId: "userA", projectId: "projP", agentSessionIds: ["sessA1"], categories: ["write"], resourcePrefixes: ["src"], egress: "external" as unknown as "none", ttlMs: 60000, createdByOperationId: "op-62" }),
    );
    assert.throws(() =>
      fx.grants.issue({ actorUserId: "userA", projectId: "projP", agentSessionIds: ["sessA1"], categories: ["write"], resourcePrefixes: ["src"], egress: "none", ttlMs: 24 * 60 * 60 * 1000, createdByOperationId: "op-63" }),
    );
    assert.throws(() =>
      fx.grants.issue({ actorUserId: "userA", projectId: "projP", agentSessionIds: ["sessA1"], categories: ["write"], resourcePrefixes: ["*"], egress: "none", ttlMs: 8 * 60 * 60 * 1000, createdByOperationId: "op-64" }),
    );
    const broad = fx.grants.issue({ actorUserId: "userA", projectId: "projP", agentSessionIds: ["sessA1"], categories: ["write"], resourcePrefixes: ["*"], egress: "none", ttlMs: 30 * 60 * 1000, createdByOperationId: "op-65" });
    assert.equal(broad.broad, true);
    assert.throws(() => new ApprovalIssuer("short"), /at least 32/);
    console.log("[PASS] External categories, unbounded TTL/egress, and weak secrets rejected at issuance.");
  }

  console.log("--- 8. Approval happy path and single-use replay rejection ---");
  {
    const fx = buildFixture();
    const args = { argv: ["npm", "test"] };
    const { serialized } = fx.approvals.issue(
      { actorUserId: "userA", projectId: "projP", agentSessionId: "sessA1", action: "exec", args, resource: "src", networkNeed: "external", execMode: "argv", destination: "", revision: "", operationId: "op-70", protectedTarget: false },
      fx.deps.sink,
    );
    const ok = await runIfAuthorized(fx, {
      token: TOKEN_A,
      approval: serialized,
      descriptor: { operationId: "op-70", projectId: "projP", agentSessionId: "sessA1", action: "exec", resource: "src", args, networkNeed: "external", execMode: "argv" },
    });
    assert.equal(ok.via.kind, "approval");
    assert.equal(fx.providerCalls.length, 1);
    await expectDenial(fx, {
      token: TOKEN_A,
      approval: serialized,
      descriptor: { operationId: "op-70", projectId: "projP", agentSessionId: "sessA1", action: "exec", resource: "src", args, networkNeed: "external", execMode: "argv" },
    }, "APPROVAL_REPLAYED");
    assert.equal(fx.providerCalls.length, 1);
    console.log("[PASS] Approval authorizes once; replay rejected without provider contact.");
  }

  console.log("--- 9. Forged, altered, expired, and revoked approvals fail ---");
  {
    const fx = buildFixture();
    const args = { argv: ["npm", "run", "build"] };
    const base = { actorUserId: "userA", projectId: "projP", agentSessionId: "sessA1", action: "exec" as const, resource: "src", networkNeed: "none", execMode: "argv", destination: "", revision: "", protectedTarget: false };
    const good = fx.approvals.issue({ ...base, args, operationId: "op-80" });
    const forged = good.serialized.slice(0, -1) + (good.serialized.endsWith("0") ? "1" : "0");
    await expectDenial(fx, { token: TOKEN_A, approval: forged, descriptor: { operationId: "op-80", projectId: "projP", agentSessionId: "sessA1", action: "exec", resource: "src", args, networkNeed: "none", execMode: "argv" } }, "APPROVAL_INVALID");
    await expectDenial(fx, { token: TOKEN_A, approval: "not-a-token", descriptor: { operationId: "op-81", projectId: "projP", action: "file.write", resource: "src/a.ts", args: {} } }, "APPROVAL_INVALID");
    await expectDenial(fx, { token: TOKEN_A, approval: good.serialized, descriptor: { operationId: "op-80", projectId: "projP", agentSessionId: "sessA1", action: "exec", resource: "src", args: { argv: ["rm", "-rf", "/"] }, networkNeed: "none", execMode: "argv" } }, "APPROVAL_MISMATCH");
    await expectDenial(fx, { token: TOKEN_A, approval: good.serialized, descriptor: { operationId: "op-82", projectId: "projP", agentSessionId: "sessA1", action: "exec", resource: "src", args, networkNeed: "none", execMode: "argv" } }, "APPROVAL_MISMATCH");
    await expectDenial(fx, { token: TOKEN_A, approval: good.serialized, descriptor: { operationId: "op-80", projectId: "projP", agentSessionId: "sessA2", action: "exec", resource: "src", args, networkNeed: "none", execMode: "argv" } }, "APPROVAL_MISMATCH");
    await expectDenial(fx, { token: TOKEN_B, approval: good.serialized, descriptor: { operationId: "op-80", projectId: "projP", agentSessionId: "sessA1", action: "exec", resource: "src", args, networkNeed: "none", execMode: "argv" } }, "NO_PROJECT_ACCESS");
    const short = fx.approvals.issue({ ...base, args, operationId: "op-83", ttlMs: 1000 });
    now += 2000;
    await expectDenial(fx, { token: TOKEN_A, approval: short.serialized, descriptor: { operationId: "op-83", projectId: "projP", agentSessionId: "sessA1", action: "exec", resource: "src", args, networkNeed: "none", execMode: "argv" } }, "APPROVAL_EXPIRED");
    const rev = fx.approvals.issue({ ...base, args, operationId: "op-84" });
    fx.approvals.revoke(rev.token.id, "op-85", fx.deps.sink);
    await expectDenial(fx, { token: TOKEN_A, approval: rev.serialized, descriptor: { operationId: "op-84", projectId: "projP", agentSessionId: "sessA1", action: "exec", resource: "src", args, networkNeed: "none", execMode: "argv" } }, "APPROVAL_REVOKED");
    console.log("[PASS] All approval attack variants rejected.");
  }

  console.log("--- 10. Exec is arbitrary code: no command-name bypass ---");
  {
    const fx = buildFixture();
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-90", projectId: "projP", agentSessionId: "sessA1", action: "exec", resource: "src", args: { argv: ["npm", "test"] }, networkNeed: "none", execMode: "argv" } }, "APPROVAL_REQUIRED");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-91", projectId: "projP", action: "exec", resource: "src", args: { argv: ["lint-all"] } } }, "MALFORMED_REQUEST");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-91b", projectId: "projP", action: "exec", resource: "src", args: { argv: ["lint-all"] }, networkNeed: "none" } }, "MALFORMED_REQUEST");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-91c", projectId: "projP", action: "exec", resource: "src", args: { argv: ["lint-all"] }, networkNeed: "none", execMode: "eval" } }, "MALFORMED_REQUEST");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-91d", projectId: "projP", action: "file.write", resource: "src/a.ts", args: {}, execMode: "argv" } }, "MALFORMED_REQUEST");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-91e", projectId: "projP", action: "file.write", resource: "src/a.ts", args: {}, networkNeed: "none" } }, "MALFORMED_REQUEST");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-91f", projectId: "projP", action: "exec", args: { argv: ["id"] }, networkNeed: "none", execMode: "argv" } }, "MALFORMED_REQUEST");
    const readOnly = fx.grants.issue({ actorUserId: "userA", projectId: "projP", agentSessionIds: ["sessA1"], categories: ["read"], resourcePrefixes: ["src"], egress: "none", ttlMs: 60000, createdByOperationId: "op-92" });
    await expectDenial(fx, { token: TOKEN_A, grantId: readOnly.id, descriptor: { operationId: "op-93", projectId: "projP", agentSessionId: "sessA1", action: "exec", resource: "src", args: { argv: ["build", "all"] }, networkNeed: "none", execMode: "argv" } }, "GRANT_OUT_OF_SCOPE");
    console.log("[PASS] Harmless-looking command names grant nothing.");
  }

  console.log("--- 11. External actions need their own explicit approval ---");
  {
    const fx = buildFixture();
    const grant = fx.grants.issue({ actorUserId: "userA", projectId: "projP", agentSessionIds: ["sessA1"], categories: ["write", "execute", "preview"], resourcePrefixes: ["*"], egress: "loopback", ttlMs: 30 * 60 * 1000, createdByOperationId: "op-100" });
    await expectDenial(fx, { token: TOKEN_A, grantId: grant.id, descriptor: { operationId: "op-101", projectId: "projP", agentSessionId: "sessA1", action: "git.push", destination: "https://github.com/example/projP.git", revision: "abc123", args: { branch: "feature" } } }, "APPROVAL_REQUIRED");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-102", projectId: "projP", action: "git.push", destination: "https://evil.example/stoat.git", args: { branch: "main" } } }, "DESTINATION_NOT_ALLOWED");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-103", projectId: "projP", action: "git.push", destination: "https://user:pass@github.com/example/projP.git", args: {} } }, "MALFORMED_REQUEST");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-104", projectId: "projP", action: "deploy", destination: "https://prod.example/app" } }, "APPROVAL_REQUIRED");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-105", projectId: "projP", action: "spend", args: { amount: 1 } } }, "APPROVAL_REQUIRED");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-106", projectId: "projP", action: "credential.use", resource: "providers/github" } }, "APPROVAL_REQUIRED");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-107", projectId: "projP", action: "remote.delete", destination: "https://github.com/example/projP.git", args: { branch: "old" } } }, "APPROVAL_REQUIRED");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-108", projectId: "projP", action: "disclosure", args: { channel: "pastebin" } } }, "APPROVAL_REQUIRED");
    const pushArgs = { branch: "feature" };
    const { serialized } = fx.approvals.issue({ actorUserId: "userA", projectId: "projP", agentSessionId: "sessA1", action: "git.push", args: pushArgs, resource: "", networkNeed: "", execMode: "", destination: "https://github.com/example/projP.git", revision: "abc123", operationId: "op-109", protectedTarget: false }, fx.deps.sink);
    const ok = await runIfAuthorized(fx, { token: TOKEN_A, approval: serialized, descriptor: { operationId: "op-109", projectId: "projP", agentSessionId: "sessA1", action: "git.push", destination: "https://github.com/example/projP.git", revision: "abc123", args: pushArgs } });
    assert.equal(ok.via.kind, "approval");
    const prot = fx.approvals.issue({ actorUserId: "userA", projectId: "projP", agentSessionId: "sessA1", action: "git.push", args: { branch: "main" }, resource: "", networkNeed: "", execMode: "", destination: "https://github.com/example/projP.git", revision: "abc123", operationId: "op-110", protectedTarget: true });
    await expectDenial(fx, { token: TOKEN_A, approval: prot.serialized, descriptor: { operationId: "op-110", projectId: "projP", agentSessionId: "sessA1", action: "git.push", destination: "https://github.com/example/projP.git", revision: "abc123", protectedTarget: false, args: { branch: "main" } } }, "APPROVAL_MISMATCH");
    console.log("[PASS] External actions gated on exact approvals; no carried-forward auto rules.");
  }

  console.log("--- 12. Terminal attach and preview access enforce ownership ---");
  {
    const fx = buildFixture();
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-120", projectId: "projP", agentSessionId: "sessB1", action: "terminal.attach", resource: "sessions/sessB1" } }, "NO_PROJECT_ACCESS");
    await expectDenial(fx, { token: TOKEN_B, descriptor: { operationId: "op-121", projectId: "projP", agentSessionId: "sessA1", action: "terminal.attach", resource: "sessions/sessA1" } }, "NO_PROJECT_ACCESS");
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-122", projectId: "projP", agentSessionId: "ghost", action: "terminal.attach", resource: "sessions/ghost" } }, "NO_PROJECT_ACCESS");
    await expectDenial(fx, { token: TOKEN_B, descriptor: { operationId: "op-123", projectId: "projP", action: "preview.access", resource: "previews/slugA" } }, "NO_PROJECT_ACCESS");
    const grant = fx.grants.issue({ actorUserId: "userA", projectId: "projP", agentSessionIds: ["sessA1"], categories: ["execute", "preview"], resourcePrefixes: ["sessions", "previews"], egress: "none", ttlMs: 60000, createdByOperationId: "op-124" });
    const okAttach = await runIfAuthorized(fx, { token: TOKEN_A, grantId: grant.id, descriptor: { operationId: "op-125", projectId: "projP", agentSessionId: "sessA1", action: "terminal.attach", resource: "sessions/sessA1" } });
    assert.equal(okAttach.via.kind, "grant");
    const okPreview = await runIfAuthorized(fx, { token: TOKEN_A, grantId: grant.id, descriptor: { operationId: "op-126", projectId: "projP", agentSessionId: "sessA1", action: "preview.access", resource: "previews/slugA" } });
    assert.equal(okPreview.via.kind, "grant");
    console.log("[PASS] Reconnect and preview paths enforce the same boundary.");
  }

  console.log("--- 13. Audit trail is ordered, typed, and secret-free ---");
  {
    const fx = buildFixture();
    await expectDenial(fx, { token: TOKEN_A, descriptor: { operationId: "op-130", projectId: "projP", action: "spend", args: { token: "TOP-SECRET-should-never-appear" } } }, "APPROVAL_REQUIRED");
    await runIfAuthorized(fx, { token: TOKEN_A, descriptor: { operationId: "op-131", projectId: "projP", action: "file.read", resource: "src/a.ts" } });
    const denied = fx.events.filter((e) => e.outcome === "denied");
    const allowed = fx.events.filter((e) => e.outcome === "allowed");
    assert.equal(denied.length, 1);
    assert.equal(denied[0]?.reason, "APPROVAL_REQUIRED");
    assert.equal(allowed.length, 1);
    assert.equal(allowed[0]?.via, "policy");
    const blob = JSON.stringify(fx.events);
    assert.ok(!blob.includes("TOP-SECRET"), "raw args must never enter the audit trail");
    assert.ok(!blob.includes(APPROVAL_SECRET), "issuer secret must never enter the audit trail");
    const hashes = fx.events.map((e) => e.argsHash).filter((h): h is string => !!h);
    for (const h of hashes) assert.match(h, /^[0-9a-f]{64}$/);
    console.log("[PASS] Audit events complete with args bound by hash only.");
  }

  console.log("--- 14. Default session validator fails closed without auth env ---");
  {
    const validate = createDefaultSessionValidator();
    assert.equal(validate("garbage-token"), null);
    assert.equal(validate(""), null);
    console.log("[PASS] PR #1 identity dependency fails closed on invalid sessions.");
  }

  console.log("--- 15. Approvals bind resource, network scope, and exec mode ---");
  {
    const fx = buildFixture();
    const args = { argv: ["npm", "test"] };
    const good = fx.approvals.issue({
      actorUserId: "userA", projectId: "projP", agentSessionId: "sessA1", action: "exec",
      args, resource: "src", networkNeed: "none", execMode: "argv",
      destination: "", revision: "", operationId: "op-140", protectedTarget: false,
    });
    const descBase = { projectId: "projP", agentSessionId: "sessA1", action: "exec" as const, args, resource: "src", networkNeed: "none" as const, execMode: "argv" as const };
    await expectDenial(fx, { token: TOKEN_A, approval: good.serialized, descriptor: { ...descBase, operationId: "op-140", resource: "etc" } }, "APPROVAL_MISMATCH");
    await expectDenial(fx, { token: TOKEN_A, approval: good.serialized, descriptor: { ...descBase, operationId: "op-140", networkNeed: "loopback" as const } }, "APPROVAL_MISMATCH");
    await expectDenial(fx, { token: TOKEN_A, approval: good.serialized, descriptor: { ...descBase, operationId: "op-140", execMode: "shell-script" as const } }, "APPROVAL_MISMATCH");
    const scriptArgs = { script: "npm test" };
    const script = fx.approvals.issue({
      actorUserId: "userA", projectId: "projP", agentSessionId: "sessA1", action: "exec",
      args: scriptArgs, resource: "src", networkNeed: "none", execMode: "shell-script",
      destination: "", revision: "", operationId: "op-141", protectedTarget: false,
    }, fx.deps.sink);
    const ok = await runIfAuthorized(fx, {
      token: TOKEN_A,
      approval: script.serialized,
      descriptor: { operationId: "op-141", projectId: "projP", agentSessionId: "sessA1", action: "exec", args: scriptArgs, resource: "src", networkNeed: "none", execMode: "shell-script" },
    });
    assert.equal(ok.via.kind, "approval");
    console.log("[PASS] Changed resource/network/exec-mode rejected; shell-script allowed only via exact approval.");
  }

  console.log("--- 16. Issuer epoch invalidates pre-restart approvals ---");
  {
    const issuerA = new ApprovalIssuer(APPROVAL_SECRET, { now: clock, epoch: "aaaaaaaaaaaaaaaa" });
    const issuerB = new ApprovalIssuer(APPROVAL_SECRET, { now: clock, epoch: "bbbbbbbbbbbbbbbb" });
    const fx = buildFixture();
    fx.deps.approvals = issuerA;
    const fxRestarted = buildFixture();
    fxRestarted.deps.approvals = issuerB;
    const args = { argv: ["npm", "test"] };
    const issued = issuerA.issue({
      actorUserId: "userA", projectId: "projP", agentSessionId: "sessA1", action: "exec",
      args, resource: "src", networkNeed: "none", execMode: "argv",
      destination: "", revision: "", operationId: "op-150", protectedTarget: false,
    });
    await expectDenial(fxRestarted, {
      token: TOKEN_A,
      approval: issued.serialized,
      descriptor: { operationId: "op-150", projectId: "projP", agentSessionId: "sessA1", action: "exec", args, resource: "src", networkNeed: "none", execMode: "argv" },
    }, "APPROVAL_INVALID");
    const ok = await runIfAuthorized(fx, {
      token: TOKEN_A,
      approval: issued.serialized,
      descriptor: { operationId: "op-150", projectId: "projP", agentSessionId: "sessA1", action: "exec", args, resource: "src", networkNeed: "none", execMode: "argv" },
    });
    assert.equal(ok.via.kind, "approval");
    assert.throws(() => new ApprovalIssuer(APPROVAL_SECRET, { now: clock, epoch: "not-hex" }), /epoch/);
    console.log("[PASS] Stale-epoch approvals rejected; same-epoch approvals still honored.");
  }

  console.log("--- 17. Unavailable authorization state fails closed ---");
  {
    const badValidator = buildFixture();
    badValidator.deps.validateSession = () => { throw new Error("session store down"); };
    const e1 = await expectDenial(badValidator, { token: TOKEN_A, descriptor: { operationId: "op-160", projectId: "projP", action: "file.read" } }, "AUTHORIZATION_UNAVAILABLE");
    assert.equal(e1.status, 503);
    const badRegistry = buildFixture();
    badRegistry.deps.projects = {
      getProjectOwner: () => { throw new Error("registry down"); },
      isAllowedPushDestination: () => true,
    };
    await expectDenial(badRegistry, { token: TOKEN_A, descriptor: { operationId: "op-161", projectId: "projP", action: "file.read" } }, "AUTHORIZATION_UNAVAILABLE");
    const badSink = buildFixture();
    badSink.deps.sink = { record: () => { throw new Error("sink down"); } };
    await expectDenial(badSink, { token: TOKEN_A, descriptor: { operationId: "op-162", projectId: "projP", action: "file.read" } }, "AUTHORIZATION_UNAVAILABLE");
    await expectDenial(badSink, { token: "bogus", descriptor: { operationId: "op-163", projectId: "projP", action: "file.read" } }, "AUTHORIZATION_UNAVAILABLE");
    const missing = buildFixture();
    const missingDeps = { ...missing, deps: { ...missing.deps, sink: undefined as unknown as AuthorizeDeps["sink"] } };
    await expectDenial(missingDeps, { token: TOKEN_A, descriptor: { operationId: "op-164", projectId: "projP", action: "file.read" } }, "AUTHORIZATION_UNAVAILABLE");
    console.log("[PASS] Throwing/missing dependencies deny closed (503); unaudited success never returned.");
  }

  console.log("=== ALL ACTION AUTHORIZATION TESTS PASSED ===");
}

main().catch((err) => {
  console.error("Action authorization test failed:", err);
  process.exit(1);
});
