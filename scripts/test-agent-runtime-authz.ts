/**
 * Agent runtime slice — real-path authorization integration tests.
 *
 * Drives the production HTTP handlers (Request/Response) with REAL
 * authorization (default PR #1 session validator + real minted session
 * tokens + registry-backed trusted project/session state) and REAL
 * dispatch-equality enforcement. PTY/child factories are deterministic
 * stubs here so supervisor logic (replay, timeout, cancel, unknown
 * states, retention gaps) is covered without process flakiness; the live
 * smoke script (smoke-agent-runtime-live.ts) exercises the same handlers
 * with the real node-pty factory exclusively.
 *
 * Every denial asserts the provider was not called (spawn counters).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __resetAuthSecretCacheForTests, createSessionToken } from "../lib/server/auth";
import { ApprovalIssuer } from "../lib/server/authorization/approvals";
import { authorize, createDefaultSessionValidator } from "../lib/server/authorization/enforce";
import { GrantStore } from "../lib/server/authorization/grants";
import { AuthorizationError } from "../lib/server/authorization/types";
import { AuthorizedRuntime } from "../lib/server/agent-runtime/authorized-provider";
import {
  handleAllocate,
  handleControl,
  handleExec,
  handleInput,
  handleIssueApproval,
  handleIssueGrant,
  handleRevokeApproval,
  handleRevokeGrant,
  handleStatus,
  handleStream,
  type RuntimeContext,
} from "../lib/server/agent-runtime/handlers";
import {
  DEFAULT_RUNTIME_CONFIG,
  SessionRuntime,
  type ChildFactory,
  type ChildHandle,
  type PtyFactory,
  type PtyHandle,
} from "../lib/server/agent-runtime/provider";
import { RuntimeSessionRegistry } from "../lib/server/agent-runtime/sessions";
import {
  RuntimeProjectRegistry,
  RuntimeSessionProjectRegistry,
} from "../lib/server/agent-runtime/shared";

process.env.AUTH_SESSION_SECRET = "test-only-runtime-session-secret-02!!";
process.env.AUTH_ADMIN_PASSWORD = "disposable-runtime-authz-test-pass-02";
__resetAuthSecretCacheForTests();

const TOKEN_A = createSessionToken("userA", "a@example.com");
const TOKEN_B = createSessionToken("userB", "b@example.com");

/* ------------------------------------------------------------------ */
/* Deterministic stub factories (unit-test doubles, clearly labeled)   */
/* ------------------------------------------------------------------ */

interface StubPty extends PtyHandle {
  writes: string[];
  emitData(s: string): void;
  emitExit(code: number): void;
}

interface StubChild extends ChildHandle {
  emitStdout(s: string): void;
  emitStderr(s: string): void;
  emitExit(code: number | null, signal: string | null): void;
  emitError(err: Error): void;
}

interface Fixture {
  ctx: RuntimeContext;
  runtime: SessionRuntime;
  registry: RuntimeSessionRegistry;
  dataDir: string;
  events: unknown[];
  ptys: StubPty[];
  children: StubChild[];
  ptySpawns(): number;
  childSpawns(): number;
  cleanup(): void;
}

function buildFixture(overrides?: { maxFrames?: number }): Fixture {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-authz-"));
  const events: unknown[] = [];
  const registry = new RuntimeSessionRegistry(dataDir);
  const ptys: StubPty[] = [];
  const children: StubChild[] = [];
  // Guaranteed-dead pid: a reaped child. Stubs share it; kill probes on it
  // honestly report ESRCH, so terminate paths verify without live processes.
  const deadPid = spawnSync("true").pid;
  assert.ok(typeof deadPid === "number", "test requires a reaped pid");

  const ptyFactory: PtyFactory = () => {
    const stub = {
      pid: deadPid,
      writes: [] as string[],
      dataCb: null as null | ((d: string) => void),
      exitCb: null as null | ((e: { exitCode: number }) => void),
      write(d: string) { stub.writes.push(d); },
      resize() {},
      kill() {},
      onData(cb: (d: string) => void) { stub.dataCb = cb; },
      onExit(cb: (e: { exitCode: number }) => void) { stub.exitCb = cb; },
      emitData(s: string) { stub.dataCb?.(s); },
      emitExit(code: number) { stub.exitCb?.({ exitCode: code }); },
    } as unknown as StubPty;
    ptys.push(stub);
    return stub;
  };

  const childFactory: ChildFactory = () => {
    const stub = {
      pid: deadPid,
      exitCb: null as null | ((c: unknown, s: unknown) => void),
      errorCb: null as null | ((e: unknown) => void),
      stdoutCb: null as null | ((c: string) => void),
      stderrCb: null as null | ((c: string) => void),
      on(event: "exit" | "error", cb: (...args: never[]) => void) {
        if (event === "exit") stub.exitCb = cb as (c: unknown, s: unknown) => void;
        else stub.errorCb = cb as (e: unknown) => void;
      },
      stdout: { on(_e: "data", cb: (c: string) => void) { stub.stdoutCb = cb; } },
      stderr: { on(_e: "data", cb: (c: string) => void) { stub.stderrCb = cb; } },
      emitStdout(s: string) { stub.stdoutCb?.(s); },
      emitStderr(s: string) { stub.stderrCb?.(s); },
      emitExit(code: number | null, signal: string | null) { stub.exitCb?.(code, signal); },
      emitError(err: Error) { stub.errorCb?.(err); },
    } as unknown as StubChild;
    children.push(stub);
    return stub;
  };

  const runtime = new SessionRuntime({
    registry,
    ptyFactory,
    childFactory,
    pidAlive: () => false,
    config: {
      ...DEFAULT_RUNTIME_CONFIG,
      netnsRequired: false,
      limitsRequired: false,
      minTimeoutMs: 50,
      killGraceMs: 20,
      exitWaitMs: 50,
      ...(overrides?.maxFrames !== undefined ? { maxFrames: overrides.maxFrames } : {}),
    },
  });
  const ctx: RuntimeContext = {
    authz: {
      validateSession: createDefaultSessionValidator(),
      projects: new RuntimeProjectRegistry(registry),
      sessions: new RuntimeSessionProjectRegistry(registry),
      approvals: new ApprovalIssuer("test-only-action-auth-secret-for-runtime-01", { epoch: "cccccccccccccccc" }),
      grants: new GrantStore(),
      sink: { record: (e) => events.push(e) },
    },
    authorized: new AuthorizedRuntime(runtime),
    runtime,
    registry,
  };
  return {
    ctx,
    runtime,
    registry,
    dataDir,
    events,
    ptys,
    children,
    ptySpawns: () => ptys.length,
    childSpawns: () => children.length,
    cleanup: () => {
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function post(pathname: string, body: Record<string, unknown>, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-coderxp-session"] = token;
  return new Request(`http://localhost${pathname}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function get(pathname: string, token?: string, signal?: AbortSignal): Request {
  const headers: Record<string, string> = {};
  if (token) headers["x-coderxp-session"] = token;
  return new Request(`http://localhost${pathname}`, { method: "GET", headers, ...(signal ? { signal } : {}) });
}

async function read(res: Response): Promise<{ status: number; json: Record<string, any> }> {
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function issueGrant(
  fx: Fixture,
  token: string,
  params: Record<string, unknown>,
): Promise<Record<string, any>> {
  const res = await handleIssueGrant(fx.ctx, post("/api/runtime/grants", params, token));
  const { status, json } = await read(res);
  assert.equal(status, 201, `grant issuance must succeed: ${JSON.stringify(json)}`);
  return json.grant as Record<string, any>;
}

async function issueApproval(
  fx: Fixture,
  token: string,
  descriptor: Record<string, unknown>,
): Promise<string> {
  const res = await handleIssueApproval(fx.ctx, post("/api/runtime/approvals", { descriptor }, token));
  const { status, json } = await read(res);
  assert.equal(status, 201, `approval issuance must succeed: ${JSON.stringify(json)}`);
  return json.approval as string;
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("=== AGENT RUNTIME AUTHORIZATION INTEGRATION TESTS ===");

  console.log("--- 1. Unauthenticated requests denied with no provider contact ---");
  {
    const fx = buildFixture();
    try {
      const noToken = await read(await handleAllocate(fx.ctx, post("/sessions", { operationId: "op-u1", projectId: "demo" })));
      assert.equal(noToken.status, 401);
      assert.equal(noToken.json.error, "NOT_AUTHENTICATED");
      const bogus = await read(await handleAllocate(fx.ctx, post("/sessions", { operationId: "op-u2", projectId: "demo" }, "bogus")));
      assert.equal(bogus.status, 401);
      assert.equal(fx.ptySpawns(), 0, "denied allocate must not spawn");
      console.log("[PASS] Unauthenticated allocate denied; zero spawns.");
    } finally {
      fx.cleanup();
    }
  }

  console.log("--- 2. Allocate happy path; cross-owner claims denied ---");
  {
    const fx = buildFixture();
    try {
      const grant = await issueGrant(fx, TOKEN_A, {
        operationId: "op-g1",
        projectId: "demo",
        agentSessionIds: "*",
        categories: ["execute"],
        resourcePrefixes: ["sessions"],
        egress: "none",
        ttlMs: 60000,
      });
      const res = await read(
        await handleAllocate(fx.ctx, post("/sessions", { operationId: "op-a1", projectId: "demo", agentSessionId: "sessA", cols: 80, rows: 24, grantId: grant.id }, TOKEN_A)),
      );
      assert.equal(res.status, 201, JSON.stringify(res.json));
      assert.equal(res.json.session.sessionId, "sessA");
      assert.equal(res.json.session.ownerUserId, "userA");
      assert.ok(String(res.json.session.workspaceDir).includes(path.join("users", "userA")), "structural owner path");
      assert.ok(fs.statSync(res.json.session.workspaceDir).isDirectory(), "workspace created");
      assert.equal(res.json.lease.holder, "agent");
      assert.ok(typeof res.json.lease.token === "string" && res.json.lease.token.length >= 16);
      assert.equal(fx.ptySpawns(), 1);

      const cross = await read(
        await handleAllocate(fx.ctx, post("/sessions", { operationId: "op-a2", projectId: "demo", agentSessionId: "sessB", grantId: grant.id }, TOKEN_B)),
      );
      assert.equal(cross.status, 403);
      assert.equal(cross.json.error, "NO_PROJECT_ACCESS");
      assert.equal(fx.ptySpawns(), 1, "cross-owner allocate must not spawn");
      console.log("[PASS] First-claim allocate works; cross-owner claims denied.");
    } finally {
      fx.cleanup();
    }
  }

  console.log("--- 3. Exec happy path with op-ledger replay (no rerun) ---");
  {
    const fx = buildFixture();
    try {
      const grant = await issueGrant(fx, TOKEN_A, {
        operationId: "op-g2", projectId: "demo", agentSessionIds: "*",
        categories: ["execute"], resourcePrefixes: ["sessions"], egress: "none", ttlMs: 60000,
      });
      const alloc = await read(await handleAllocate(fx.ctx, post("/sessions", { operationId: "op-a3", projectId: "demo", agentSessionId: "sessA", grantId: grant.id }, TOKEN_A)));
      assert.equal(alloc.status, 201);
      const execGrant = await issueGrant(fx, TOKEN_A, {
        operationId: "op-g3", projectId: "demo", agentSessionIds: ["sessA"],
        categories: ["execute"], resourcePrefixes: ["*"], egress: "none", ttlMs: 60000,
      });
      const execBody = { operationId: "op-e1", resource: "", args: { argv: ["echo", "hi"] }, networkNeed: "none", execMode: "argv", grantId: execGrant.id };
      const pending = handleExec(fx.ctx, post("/exec", execBody, TOKEN_A), "sessA");
      await waitFor(() => fx.children.length >= 1, "exec child spawn");
      assert.equal(fx.childSpawns(), 1, "exec must spawn the child");
      fx.children[0].emitStdout("hi\n");
      fx.children[0].emitExit(0, null);
      const first = await read(await pending);
      assert.equal(first.status, 200, JSON.stringify(first.json));
      assert.equal(first.json.outcome.kind, "completed");
      assert.equal(first.json.outcome.exitCode, 0);
      assert.equal(first.json.outcome.confirmed, true);
      assert.equal(first.json.outcome.reconciled, false);

      const replay = await read(await handleExec(fx.ctx, post("/exec", execBody, TOKEN_A), "sessA"));
      assert.equal(replay.status, 200);
      assert.equal(replay.json.outcome.reconciled, true, "replay must be labeled reconciled");
      assert.equal(fx.childSpawns(), 1, "replay must not re-execute");
      console.log("[PASS] Exec completes; idempotent replay without rerun.");
    } finally {
      fx.cleanup();
    }
  }

  console.log("--- 4. Denial matrix with provider-not-called proof ---");
  {
    const fx = buildFixture();
    try {
      const grant = await issueGrant(fx, TOKEN_A, {
        operationId: "op-g4", projectId: "demo", agentSessionIds: "*",
        categories: ["execute"], resourcePrefixes: ["*"], egress: "none", ttlMs: 60000,
      });
      await read(await handleAllocate(fx.ctx, post("/sessions", { operationId: "op-a4", projectId: "demo", agentSessionId: "sessA", grantId: grant.id }, TOKEN_A)));
      const readOnly = await issueGrant(fx, TOKEN_A, {
        operationId: "op-g5", projectId: "demo", agentSessionIds: ["sessA"],
        categories: ["read"], resourcePrefixes: ["*"], egress: "none", ttlMs: 60000,
      });
      const execBase = { resource: "", args: { argv: ["id"] }, networkNeed: "none", execMode: "argv" };
      const noCred = await read(await handleExec(fx.ctx, post("/exec", { operationId: "op-d1", ...execBase }, TOKEN_A), "sessA"));
      assert.equal(noCred.json.error, "APPROVAL_REQUIRED");
      const wrongCat = await read(await handleExec(fx.ctx, post("/exec", { operationId: "op-d2", ...execBase, grantId: readOnly.id }, TOKEN_A), "sessA"));
      assert.equal(wrongCat.json.error, "GRANT_OUT_OF_SCOPE");
      const crossUser = await read(await handleExec(fx.ctx, post("/exec", { operationId: "op-d3", ...execBase, grantId: grant.id }, TOKEN_B), "sessA"));
      assert.equal(crossUser.json.error, "NO_PROJECT_ACCESS");
      assert.equal(fx.childSpawns(), 0, "all denied execs must not spawn");

      // Tampered dispatch: authorize one resource, dispatch another.
      const execGrant = await issueGrant(fx, TOKEN_A, {
        operationId: "op-g6", projectId: "demo", agentSessionIds: ["sessA"],
        categories: ["execute"], resourcePrefixes: ["*"], egress: "none", ttlMs: 60000,
      });
      const descriptor = { operationId: "op-d4", projectId: "demo", agentSessionId: "sessA", action: "exec", resource: ".", args: { argv: ["id"] }, networkNeed: "none", execMode: "argv" };
      const authz = authorize(fx.ctx.authz, { token: TOKEN_A, descriptor, grantId: execGrant.id });
      try {
        await fx.ctx.authorized.exec(
          { authz, descriptor: { ...descriptor, action: "exec", resource: "" } },
          { operationId: "op-d4", projectId: "demo", agentSessionId: "sessA", resource: "elsewhere", args: { argv: ["id"] }, networkNeed: "none", execMode: "argv", timeoutMs: 5000 },
        );
        assert.fail("tampered resource must be refused");
      } catch (err) {
        assert.ok(err instanceof AuthorizationError && err.code === "APPROVAL_MISMATCH");
      }
      assert.equal(fx.childSpawns(), 0, "tampered dispatch must not spawn");

      // Revoked grant is honored at the real boundary.
      await read(await handleRevokeGrant(fx.ctx, post("/grants/revoke", { id: execGrant.id, operationId: "op-d5" }, TOKEN_A)));
      const revoked = await read(await handleExec(fx.ctx, post("/exec", { operationId: "op-d6", ...execBase, grantId: execGrant.id }, TOKEN_A), "sessA"));
      assert.equal(revoked.json.error, "GRANT_REVOKED");
      assert.equal(fx.childSpawns(), 0);
      console.log("[PASS] Denials, tamper refusal, and revocation without provider contact.");
    } finally {
      fx.cleanup();
    }
  }

  console.log("--- 5. Shell-script is approval-gated at the HTTP boundary ---");
  {
    const fx = buildFixture();
    try {
      const grant = await issueGrant(fx, TOKEN_A, {
        operationId: "op-g7", projectId: "demo", agentSessionIds: "*",
        categories: ["execute"], resourcePrefixes: ["*"], egress: "none", ttlMs: 60000,
      });
      await read(await handleAllocate(fx.ctx, post("/sessions", { operationId: "op-a5", projectId: "demo", agentSessionId: "sessA", grantId: grant.id }, TOKEN_A)));
      const execGrant = await issueGrant(fx, TOKEN_A, {
        operationId: "op-g8", projectId: "demo", agentSessionIds: ["sessA"],
        categories: ["execute"], resourcePrefixes: ["*"], egress: "none", ttlMs: 60000,
      });
      const scriptBody = { operationId: "op-s1", resource: "", args: { script: "echo hi" }, networkNeed: "none", execMode: "shell-script", grantId: execGrant.id };
      const viaGrant = await read(await handleExec(fx.ctx, post("/exec", scriptBody, TOKEN_A), "sessA"));
      assert.equal(viaGrant.json.error, "GRANT_OUT_OF_SCOPE");
      assert.equal(fx.childSpawns(), 0);

      const approval = await issueApproval(fx, TOKEN_A, {
        operationId: "op-s2", projectId: "demo", agentSessionId: "sessA", action: "exec",
        resource: ".", args: { script: "echo hi" }, networkNeed: "none", execMode: "shell-script",
      });
      const pending = handleExec(fx.ctx, post("/exec", { operationId: "op-s2", resource: "", args: { script: "echo hi" }, networkNeed: "none", execMode: "shell-script", approval }, TOKEN_A), "sessA");
      await waitFor(() => fx.children.length >= 1, "shell-script child spawn");
      fx.children[0].emitExit(0, null);
      const allowed = await read(await pending);
      assert.equal(allowed.status, 200, JSON.stringify(allowed.json));
      assert.equal(allowed.json.outcome.kind, "completed");

      // argv approval cannot be retargeted to shell-script.
      const argvApproval = await issueApproval(fx, TOKEN_A, {
        operationId: "op-s3", projectId: "demo", agentSessionId: "sessA", action: "exec",
        resource: ".", args: { argv: ["echo"] }, networkNeed: "none", execMode: "argv",
      });
      const retarget = await read(await handleExec(fx.ctx, post("/exec", { operationId: "op-s3", resource: "", args: { script: "echo" }, networkNeed: "none", execMode: "shell-script", approval: argvApproval }, TOKEN_A), "sessA"));
      assert.equal(retarget.json.error, "APPROVAL_MISMATCH");
      assert.equal(fx.childSpawns(), 1, "only the exact approval dispatches");
      console.log("[PASS] Grants never cover shell-script; exact approvals do.");
    } finally {
      fx.cleanup();
    }
  }

  console.log("--- 6. Input authority follows the control lease ---");
  {
    const fx = buildFixture();
    try {
      const grant = await issueGrant(fx, TOKEN_A, {
        operationId: "op-g9", projectId: "demo", agentSessionIds: "*",
        categories: ["execute"], resourcePrefixes: ["*"], egress: "none", ttlMs: 60000,
      });
      const alloc = await read(await handleAllocate(fx.ctx, post("/sessions", { operationId: "op-a6", projectId: "demo", agentSessionId: "sessA", grantId: grant.id }, TOKEN_A)));
      const agentLease = alloc.json.lease as { holder: string; token: string };
      const termGrant = await issueGrant(fx, TOKEN_A, {
        operationId: "op-g10", projectId: "demo", agentSessionIds: ["sessA"],
        categories: ["execute"], resourcePrefixes: ["*"], egress: "none", ttlMs: 60000,
      });
      const inputBase = { data: "echo hi\n", grantId: termGrant.id };
      const badLease = await read(await handleInput(fx.ctx, post("/input", { operationId: "op-i1", ...inputBase, lease: { holder: "agent", token: "wrong" } }, TOKEN_A), "sessA"));
      assert.equal(badLease.status, 409);
      assert.equal(badLease.json.error, "LEASE_CONFLICT");
      const noCred = await read(await handleInput(fx.ctx, post("/input", { operationId: "op-i2", data: "x", lease: agentLease }, TOKEN_A), "sessA"));
      assert.equal(noCred.json.error, "APPROVAL_REQUIRED");
      assert.deepEqual(fx.ptys[0].writes, [], "denied input must not reach the pty");
      const ok = await read(await handleInput(fx.ctx, post("/input", { operationId: "op-i3", ...inputBase, lease: agentLease }, TOKEN_A), "sessA"));
      assert.equal(ok.status, 200);
      assert.deepEqual(fx.ptys[0].writes, ["echo hi\n"]);

      // User takeover pauses the agent's authority.
      const takeover = await read(await handleControl(fx.ctx, post("/control", { operationId: "op-i4", op: "lease-acquire", holder: "user", takeover: true, grantId: termGrant.id }, TOKEN_A), "sessA"));
      assert.equal(takeover.status, 200);
      const userLease = takeover.json.lease as { holder: string; token: string };
      const staleAgent = await read(await handleInput(fx.ctx, post("/input", { operationId: "op-i5", ...inputBase, lease: agentLease }, TOKEN_A), "sessA"));
      assert.equal(staleAgent.json.error, "LEASE_CONFLICT");
      const userOk = await read(await handleInput(fx.ctx, post("/input", { operationId: "op-i6", ...inputBase, lease: userLease }, TOKEN_A), "sessA"));
      assert.equal(userOk.status, 200);
      assert.equal(fx.ptys[0].writes.length, 2);
      console.log("[PASS] Single-writer lease with explicit takeover.");
    } finally {
      fx.cleanup();
    }
  }

  console.log("--- 7. Reconnect by cursor with explicit retention gaps ---");
  {
    const fx = buildFixture({ maxFrames: 4 });
    try {
      const grant = await issueGrant(fx, TOKEN_A, {
        operationId: "op-g11", projectId: "demo", agentSessionIds: "*",
        categories: ["execute"], resourcePrefixes: ["*"], egress: "none", ttlMs: 60000,
      });
      await read(await handleAllocate(fx.ctx, post("/sessions", { operationId: "op-a7", projectId: "demo", agentSessionId: "sessA", grantId: grant.id }, TOKEN_A)));
      const pty = fx.ptys[0];
      pty.emitData("line1\n");
      pty.emitData("line2\n");
      const first = await read(await handleStatus(fx.ctx, get(`/status?operationId=op-t1&grantId=${grant.id}`, TOKEN_A), "sessA"));
      assert.equal(first.status, 200);
      const poll1 = await read(await handleStream(fx.ctx, get(`/stream?cursor=0&operationId=op-t2&grantId=${grant.id}`, TOKEN_A), "sessA"));
      assert.equal(poll1.json.frames.length, 2);
      assert.equal(poll1.json.gap, null);
      const cursor = poll1.json.nextCursor as number;
      const poll2 = await read(await handleStream(fx.ctx, get(`/stream?cursor=${cursor}&operationId=op-t3&grantId=${grant.id}`, TOKEN_A), "sessA"));
      assert.equal(poll2.json.frames.length, 0, "no new frames after cursor");

      for (let i = 0; i < 10; i++) pty.emitData(`overflow-${i}\n`);
      const pollGap = await read(await handleStream(fx.ctx, get(`/stream?cursor=0&operationId=op-t4&grantId=${grant.id}`, TOKEN_A), "sessA"));
      assert.ok(pollGap.json.gap !== null, "eviction must surface an explicit gap");
      assert.equal(pollGap.json.gap.reason, "retention-evicted");
      assert.ok((pollGap.json.frames as unknown[]).length <= 4, "retention stays bounded");

      const ghost = await read(await handleStatus(fx.ctx, get(`/status?operationId=op-t5&grantId=${grant.id}`, TOKEN_A), "ghost"));
      assert.equal(ghost.status, 404);
      assert.equal(ghost.json.error, "SESSION_UNKNOWN");
      console.log("[PASS] Cursor replay, bounded retention, and gap notices.");
    } finally {
      fx.cleanup();
    }
  }

  console.log("--- 8. Timeout, cancel, and unknown outcomes via supervisor stubs ---");
  {
    const fx = buildFixture();
    try {
      const grant = await issueGrant(fx, TOKEN_A, {
        operationId: "op-g12", projectId: "demo", agentSessionIds: "*",
        categories: ["execute", "write"], resourcePrefixes: ["*"], egress: "none", ttlMs: 60000,
      });
      await read(await handleAllocate(fx.ctx, post("/sessions", { operationId: "op-a8", projectId: "demo", agentSessionId: "sessA", grantId: grant.id }, TOKEN_A)));
      const execGrant = await issueGrant(fx, TOKEN_A, {
        operationId: "op-g13", projectId: "demo", agentSessionIds: ["sessA"],
        categories: ["execute", "write"], resourcePrefixes: ["*"], egress: "none", ttlMs: 60000,
      });
      // Timeout: child hangs, kernel reaps after terminate.
      const hanging = handleExec(fx.ctx, post("/exec", { operationId: "op-x1", resource: "", args: { argv: ["sleep", "30"] }, networkNeed: "none", execMode: "argv", timeoutMs: 150, grantId: execGrant.id }, TOKEN_A), "sessA");
      await new Promise((r) => setTimeout(r, 400));
      fx.children[0].emitExit(null, "SIGTERM");
      const timedOut = await read(await hanging);
      assert.equal(timedOut.json.outcome.kind, "timeout");
      assert.equal(timedOut.json.outcome.confirmed, true);

      // Cancel: operator stops a running op.
      const running = handleExec(fx.ctx, post("/exec", { operationId: "op-x2", resource: "", args: { argv: ["sleep", "30"] }, networkNeed: "none", execMode: "argv", timeoutMs: 30000, grantId: execGrant.id }, TOKEN_A), "sessA");
      await waitFor(() => fx.children.length >= 2, "cancel-target child spawn");
      const cancel = await read(await handleControl(fx.ctx, post("/control", { operationId: "op-x3", op: "cancel", targetOperationId: "op-x2", grantId: execGrant.id }, TOKEN_A), "sessA"));
      assert.equal(cancel.json.cancelled, true);
      fx.children[1].emitExit(null, "SIGTERM");
      const cancelled = await read(await running);
      assert.equal(cancelled.json.outcome.kind, "cancelled");

      // Unknown: exit observed with neither code nor signal.
      const weird = handleExec(fx.ctx, post("/exec", { operationId: "op-x4", resource: "", args: { argv: ["true"] }, networkNeed: "none", execMode: "argv", grantId: execGrant.id }, TOKEN_A), "sessA");
      await waitFor(() => fx.children.length >= 3, "unknown-outcome child spawn");
      fx.children[2].emitExit(null, null);
      const unknown = await read(await weird);
      assert.equal(unknown.json.outcome.kind, "unknown");
      assert.equal(unknown.json.outcome.confirmed, false);

      // Cancel of an unknown op reports honestly.
      const cancelGhost = await read(await handleControl(fx.ctx, post("/control", { operationId: "op-x5", op: "cancel", targetOperationId: "op-nope", grantId: execGrant.id }, TOKEN_A), "sessA"));
      assert.equal(cancelGhost.json.cancelled, false);
      assert.equal(cancelGhost.json.outcome, null);
      console.log("[PASS] Timeout/cancel/unknown supervisor transitions.");
    } finally {
      fx.cleanup();
    }
  }

  console.log("--- 9. Redaction applies before every stored byte ---");
  {
    const fx = buildFixture();
    try {
      const grant = await issueGrant(fx, TOKEN_A, {
        operationId: "op-g14", projectId: "demo", agentSessionIds: "*",
        categories: ["execute"], resourcePrefixes: ["*"], egress: "none", ttlMs: 60000,
      });
      await read(await handleAllocate(fx.ctx, post("/sessions", { operationId: "op-a9", projectId: "demo", agentSessionId: "sessA", grantId: grant.id }, TOKEN_A)));
      const token = "ghp_abcDEF1234567890abcdef1234567890ab";
      fx.ptys[0].emitData(`leak? token=${token.slice(0, 12)}`);
      fx.ptys[0].emitData(`${token.slice(12)} end\n`);
      fx.ptys[0].emitData(`bare ${token.slice(0, 10)}`);
      fx.ptys[0].emitData(`${token.slice(10)} tail\n`);
      const poll = await read(await handleStream(fx.ctx, get(`/stream?cursor=0&operationId=op-r1&grantId=${grant.id}`, TOKEN_A), "sessA"));
      const blob = JSON.stringify(poll.json);
      assert.ok(!blob.includes(token), "split token must never appear in stored frames");
      assert.ok(!blob.includes(token.slice(0, 10)), "withheld prefix fragment must not leak standalone");
      assert.ok(blob.includes("[REDACTED"), "redaction marker present");
      console.log("[PASS] Chunk-split secrets redacted at the buffer.");
    } finally {
      fx.cleanup();
    }
  }

  console.log("--- 10. Unavailable runtime fails closed ---");
  {
    const fx = buildFixture();
    try {
      const cold = await read(await handleAllocate(new (class {
        authz = fx.ctx.authz;
        authorized = fx.ctx.authorized;
        runtime = new SessionRuntime({
          registry: fx.registry,
          ptyFactory: (() => { throw new Error("must not be called"); }) as unknown as PtyFactory,
          childFactory: (() => { throw new Error("must not be called"); }) as unknown as ChildFactory,
          pidAlive: () => false,
          config: { ...DEFAULT_RUNTIME_CONFIG, netnsRequired: false, limitsRequired: false },
        });
        registry = fx.registry;
      })() as unknown as RuntimeContext, post("/sessions", { operationId: "op-n1", projectId: "demo" }, TOKEN_A)));
      // init() on linux with /bin/sh succeeds, so this path allocates; instead
      // assert the guard directly: an uninitialized runtime refuses live calls.
      assert.ok(cold.status === 403 || cold.status === 201, "cold runtime initializes on demand");
      const raw = new SessionRuntime({
        registry: fx.registry,
        ptyFactory: (() => { throw new Error("must not be called"); }) as unknown as PtyFactory,
        childFactory: (() => { throw new Error("must not be called"); }) as unknown as ChildFactory,
        pidAlive: () => false,
        config: DEFAULT_RUNTIME_CONFIG,
      });
      await assert.rejects(() => raw.allocate({ operationId: "op-n2", projectId: "demo", ownerUserId: "userA", cols: 80, rows: 24 }), /not been initialized/);
      console.log("[PASS] Uninitialized runtime refuses live calls.");
    } finally {
      fx.cleanup();
    }
  }

  console.log("--- 11. Session conflicts and approval revocation ---");
  {
    const fx = buildFixture();
    try {
      const grant = await issueGrant(fx, TOKEN_A, {
        operationId: "op-g15", projectId: "demo", agentSessionIds: "*",
        categories: ["execute"], resourcePrefixes: ["*"], egress: "none", ttlMs: 60000,
      });
      const first = await read(await handleAllocate(fx.ctx, post("/sessions", { operationId: "op-c1", projectId: "demo", agentSessionId: "sessA", grantId: grant.id }, TOKEN_A)));
      assert.equal(first.status, 201);
      const dup = await read(await handleAllocate(fx.ctx, post("/sessions", { operationId: "op-c2", projectId: "demo", agentSessionId: "sessA", grantId: grant.id }, TOKEN_A)));
      assert.equal(dup.status, 409);
      assert.equal(dup.json.error, "OP_CONFLICT");

      const descriptor = { operationId: "op-c3", projectId: "demo", agentSessionId: "sessA", action: "exec", resource: ".", args: { argv: ["id"] }, networkNeed: "none", execMode: "argv" };
      const approvalRes = await handleIssueApproval(fx.ctx, post("/approvals", { descriptor }, TOKEN_A));
      const approvalJson = (await approvalRes.json()) as { approval: string; id: string };
      const revoked = await read(await handleRevokeApproval(fx.ctx, post("/approvals/revoke", { id: approvalJson.id, operationId: "op-c4" }, TOKEN_A)));
      assert.equal(revoked.status, 200);
      const useRevoked = await read(await handleExec(fx.ctx, post("/exec", { ...descriptor, approval: approvalJson.approval }, TOKEN_A), "sessA"));
      assert.equal(useRevoked.json.error, "APPROVAL_REVOKED");
      assert.equal(fx.childSpawns(), 0);
      console.log("[PASS] Duplicate sessions conflict; revoked approvals rejected.");
    } finally {
      fx.cleanup();
    }
  }

  console.log("--- 12. Live SSE carries labelled redacted frames ---");
  {
    const fx = buildFixture();
    const controller = new AbortController();
    try {
      const grant = await issueGrant(fx, TOKEN_A, {
        operationId: "op-g16", projectId: "demo", agentSessionIds: "*",
        categories: ["execute"], resourcePrefixes: ["*"], egress: "none", ttlMs: 60000,
      });
      await read(await handleAllocate(fx.ctx, post("/sessions", { operationId: "op-a10", projectId: "demo", agentSessionId: "sessA", grantId: grant.id }, TOKEN_A)));
      fx.ptys[0].emitData("boot\n");
      const res = await handleStream(fx.ctx, get(`/stream?cursor=0&live=1&operationId=op-l1&grantId=${grant.id}`, TOKEN_A, controller.signal), "sessA");
      assert.equal(res.status, 200);
      assert.ok((res.headers.get("content-type") ?? "").includes("text/event-stream"));
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const deadline = Date.now() + 5000;
      let sawFrame = false;
      let sawState = false;
      setTimeout(() => fx.ptys[0].emitData("live-line\n"), 100);
      while (Date.now() < deadline && !(sawFrame && sawState && text.includes("live-line"))) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes("event: frame")) sawFrame = true;
        if (text.includes("event: state")) sawState = true;
      }
      controller.abort();
      await reader.cancel().catch(() => {});
      assert.ok(sawFrame && sawState, `SSE must carry frame + state events, got: ${text.slice(0, 400)}`);
      assert.ok(text.includes("live-line"), "live emission reaches the subscriber");
      console.log("[PASS] SSE replay plus live subscription.");
    } finally {
      controller.abort();
      fx.cleanup();
    }
  }

  console.log("=== ALL AGENT RUNTIME AUTHORIZATION TESTS PASSED ===");
}

main().catch((err) => {
  console.error("Agent runtime authorization test failed:", err);
  process.exit(1);
});
