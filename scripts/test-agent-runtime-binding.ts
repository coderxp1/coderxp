/**
 * Agent runtime slice — request-binding regression tests.
 *
 * Scope: the authorization request binding along the REAL exec path. The rule
 * under test is that the COMPLETE normalized effective operation is bound
 * before dispatch — executable arguments, working directory (resource),
 * network scope, exec capability, and the timeout that bounds the isolated
 * workload — and that the dispatched request is derived from the authorized
 * descriptor rather than re-read from the request body.
 *
 * Two independent gates are exercised:
 *   1. the approval hash (lib/server/authorization/approvals.ts), and
 *   2. dispatch equality (lib/server/agent-runtime/authorized-provider.ts).
 * Both must use the SAME canonical encoding, so key order cannot make them
 * disagree about what "the same operation" means.
 *
 * Every refusal asserts the provider was NOT called. PTY/child factories are
 * deterministic stubs; the live PTY path is covered by
 * scripts/smoke-agent-runtime-live.ts.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __resetAuthSecretCacheForTests, createSessionToken } from "../lib/server/auth";
import { ApprovalIssuer } from "../lib/server/authorization/approvals";
import { createDefaultSessionValidator } from "../lib/server/authorization/enforce";
import { GrantStore } from "../lib/server/authorization/grants";
import { stableStringify } from "../lib/server/authorization/util";
import {
  boundExecRequest,
  DEFAULT_BOUND_TIMEOUT_MS,
  AuthorizedRuntime,
} from "../lib/server/agent-runtime/authorized-provider";
import {
  handleAllocate,
  handleExec,
  handleIssueApproval,
  handleIssueGrant,
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

process.env.AUTH_SESSION_SECRET = "test-only-binding-session-secret-03!!";
process.env.AUTH_ADMIN_PASSWORD = "disposable-runtime-binding-test-03";
__resetAuthSecretCacheForTests();

const TOKEN_A = createSessionToken("userA", "a@example.com");

/* ------------------------------------------------------------------ */
/* Deterministic stub factories                                        */
/* ------------------------------------------------------------------ */

interface StubChild extends ChildHandle {
  emitExit(code: number | null, signal: string | null): void;
}

interface Fixture {
  ctx: RuntimeContext;
  registry: RuntimeSessionRegistry;
  dataDir: string;
  childSpawns(): number;
  children: StubChild[];
  cleanup(): void;
}

function buildFixture(): Fixture {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-binding-"));
  const registry = new RuntimeSessionRegistry(dataDir);
  const children: StubChild[] = [];
  const deadPid = spawnSync("true").pid;
  assert.ok(typeof deadPid === "number", "test requires a reaped pid");

  const ptyFactory: PtyFactory = () => {
    const stub = {
      pid: deadPid,
      write() {},
      resize() {},
      kill() {},
      onData() {},
      onExit() {},
    } as unknown as PtyHandle;
    return stub;
  };

  const childFactory: ChildFactory = () => {
    const stub = {
      pid: deadPid,
      exitCb: null as null | ((c: unknown, s: unknown) => void),
      on(event: "exit" | "error", cb: (...args: never[]) => void) {
        if (event === "exit") stub.exitCb = cb as (c: unknown, s: unknown) => void;
      },
      stdout: { on() {} },
      stderr: { on() {} },
      emitExit(code: number | null, signal: string | null) {
        stub.exitCb?.(code, signal);
      },
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
    },
  });

  const ctx: RuntimeContext = {
    authz: {
      validateSession: createDefaultSessionValidator(),
      projects: new RuntimeProjectRegistry(registry),
      sessions: new RuntimeSessionProjectRegistry(registry),
      approvals: new ApprovalIssuer("test-only-action-auth-secret-for-binding-1", {
        epoch: "dddddddddddddddd",
      }),
      grants: new GrantStore(),
      sink: { record: () => {} },
    },
    authorized: new AuthorizedRuntime(runtime),
    runtime,
    registry,
  };

  return {
    ctx,
    registry,
    dataDir,
    children,
    childSpawns: () => children.length,
    cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }),
  };
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function post(pathname: string, body: Record<string, unknown>, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-coderxp-session"] = token;
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
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

async function allocate(fx: Fixture, sessionId: string): Promise<void> {
  const grant = await (async () => {
    const res = await (await import("../lib/server/agent-runtime/handlers")).handleIssueGrant(
      fx.ctx,
      post(
        "/api/runtime/grants",
        {
          operationId: `op-g-${sessionId}`,
          projectId: "demo",
          agentSessionIds: "*",
          categories: ["execute"],
          resourcePrefixes: ["*"],
          egress: "none",
          ttlMs: 60_000,
        },
        TOKEN_A,
      ),
    );
    const { json } = await read(res);
    return json.grant as { id: string };
  })();
  const res = await handleAllocate(
    fx.ctx,
    post(
      "/sessions",
      { operationId: `op-a-${sessionId}`, projectId: "demo", agentSessionId: sessionId, grantId: grant.id },
      TOKEN_A,
    ),
    sessionId,
  );
  const { status, json } = await read(res);
  assert.equal(status, 201, `allocate must succeed: ${JSON.stringify(json)}`);
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("=== AGENT RUNTIME REQUEST-BINDING TESTS ===");

  console.log("--- 1. Canonical encoding is shared by hash and dispatch gate ---");
  {
    // The approval hash uses sorted-key stableStringify. The dispatch gate must
    // use the SAME canonical form, otherwise key order alone could make the two
    // disagree (a false mismatch, or worse, a false match).
    const a = { argv: ["echo", "hi"], timeoutMs: 60_000 };
    const b = { timeoutMs: 60_000, argv: ["echo", "hi"] };
    assert.equal(stableStringify(a), stableStringify(b), "key order must not change the canonical form");
    // A genuinely different operation must differ.
    const c = { argv: ["echo", "bye"], timeoutMs: 60_000 };
    assert.notEqual(stableStringify(a), stableStringify(c));
    console.log("[PASS] Hash and dispatch gate share one canonical encoding.");
  }

  console.log("--- 2. Every bound field is individually tamper-proof ---");
  {
    const fx = buildFixture();
    try {
      await allocate(fx, "sessA");
      const base = {
        operationId: "op-b1",
        projectId: "demo",
        agentSessionId: "sessA",
        action: "exec",
        resource: ".",
        args: { argv: ["echo", "hi"], timeoutMs: DEFAULT_BOUND_TIMEOUT_MS },
        networkNeed: "none",
        execMode: "argv",
      };
      const approval = await issueApproval(fx, TOKEN_A, base);

      // Each mutation below reuses the SAME approval token but changes one
      // bound field. All must be refused with the provider untouched.
      const mutations: Array<[string, Record<string, unknown>]> = [
        ["argv[1]", { ...base, args: { argv: ["echo", "bye"], timeoutMs: DEFAULT_BOUND_TIMEOUT_MS } }],
        ["argv length", { ...base, args: { argv: ["echo"], timeoutMs: DEFAULT_BOUND_TIMEOUT_MS } }],
        ["cwd (resource)", { ...base, resource: "subdir" }],
        ["networkNeed", { ...base, networkNeed: "loopback" }],
        ["execMode", { ...base, execMode: "shell-script" }],
        ["timeoutMs", { ...base, args: { argv: ["echo", "hi"], timeoutMs: 600_000 } }],
      ];

      for (const [label, descriptor] of mutations) {
        const res = await handleExec(
          fx.ctx,
          post(
            "/exec",
            {
              operationId: descriptor.operationId,
              resource: descriptor.resource === "." ? "" : descriptor.resource,
              args: descriptor.args,
              networkNeed: descriptor.networkNeed,
              execMode: descriptor.execMode,
              timeoutMs: (descriptor.args as { timeoutMs: number }).timeoutMs,
              approval,
            },
            TOKEN_A,
          ),
          "sessA",
        );
        const { json } = await read(res);
        assert.equal(
          json.error,
          "APPROVAL_MISMATCH",
          `mutating ${label} must be refused, got ${JSON.stringify(json)}`,
        );
        assert.equal(fx.childSpawns(), 0, `mutating ${label} must not reach the provider`);
      }
      console.log("[PASS] All six bound-field mutations refused; provider never called.");

      // The exact bound operation does dispatch.
      const ok = handleExec(
        fx.ctx,
        post(
          "/exec",
          {
            operationId: base.operationId,
            resource: "",
            args: { argv: ["echo", "hi"] },
            networkNeed: "none",
            execMode: "argv",
            timeoutMs: DEFAULT_BOUND_TIMEOUT_MS,
            approval,
          },
          TOKEN_A,
        ),
        "sessA",
      );
      await waitFor(() => fx.children.length >= 1, "exact-operation child spawn");
      fx.children[0].emitExit(0, null);
      const okRes = await read(await ok);
      assert.equal(okRes.status, 200, JSON.stringify(okRes.json));
      assert.equal(okRes.json.outcome.kind, "completed");
      console.log("[PASS] The exact bound operation dispatches and completes.");
    } finally {
      fx.cleanup();
    }
  }

  console.log("--- 3. Key order alone cannot break or bypass the binding ---");
  {
    const fx = buildFixture();
    try {
      await allocate(fx, "sessA");
      // Approve with one key order.
      const approval = await issueApproval(fx, TOKEN_A, {
        operationId: "op-k1",
        projectId: "demo",
        agentSessionId: "sessA",
        action: "exec",
        resource: ".",
        args: { timeoutMs: DEFAULT_BOUND_TIMEOUT_MS, argv: ["echo", "hi"] },
        networkNeed: "none",
        execMode: "argv",
      });
      // Dispatch with the same values; the handler rebuilds args in its own key
      // order. Canonical encoding must make this a match, not a mismatch.
      const pending = handleExec(
        fx.ctx,
        post(
          "/exec",
          {
            operationId: "op-k1",
            resource: "",
            args: { argv: ["echo", "hi"] },
            networkNeed: "none",
            execMode: "argv",
            timeoutMs: DEFAULT_BOUND_TIMEOUT_MS,
            approval,
          },
          TOKEN_A,
        ),
        "sessA",
      );
      await waitFor(() => fx.children.length >= 1, "key-order-equivalent child spawn");
      fx.children[0].emitExit(0, null);
      const res = await read(await pending);
      assert.equal(res.status, 200, `key order must not cause a false mismatch: ${JSON.stringify(res.json)}`);
      console.log("[PASS] Key-order-equivalent operations match; no false mismatch or bypass.");
    } finally {
      fx.cleanup();
    }
  }

  console.log("--- 4. Dispatch is derived from the descriptor, never the body ---");
  {
    const fx = buildFixture();
    try {
      await allocate(fx, "sessA");
      const descriptor = {
        operationId: "op-dv1",
        projectId: "demo",
        agentSessionId: "sessA",
        action: "exec",
        resource: ".",
        args: { argv: ["echo", "bound"], timeoutMs: DEFAULT_BOUND_TIMEOUT_MS },
        networkNeed: "none",
        execMode: "argv",
      };
      const { authorize } = await import("../lib/server/authorization/enforce");
      const { validateDescriptor } = await import("../lib/server/authorization/policy");
      const grantRes = await (await import("../lib/server/agent-runtime/handlers")).handleIssueGrant(
        fx.ctx,
        post(
          "/api/runtime/grants",
          {
            operationId: "op-gdv",
            projectId: "demo",
            agentSessionIds: ["sessA"],
            categories: ["execute"],
            resourcePrefixes: ["*"],
            egress: "none",
            ttlMs: 60_000,
          },
          TOKEN_A,
        ),
      );
      const grant = ((await read(grantRes)).json.grant ?? grantRes) as { id: string };
      const authz = authorize(fx.ctx.authz, { token: TOKEN_A, descriptor, grantId: grant.id });
      // The real handler binds the VALIDATED descriptor (authorizeCall), so the
      // binding sees the normalized resource (".\" -> ""), not the raw input.
      const validated = validateDescriptor(descriptor);
      const boundDescriptor = {
        operationId: validated.operationId,
        projectId: validated.projectId,
        agentSessionId: validated.agentSessionId,
        action: validated.action,
        resource: validated.resource,
        args: validated.args,
        networkNeed: validated.networkNeed,
        execMode: validated.execMode,
      };
      const derived = boundExecRequest({ authz, descriptor: boundDescriptor }, "sessA");
      assert.deepEqual(derived.args, { argv: ["echo", "bound"] }, "args derive from bound descriptor");
      assert.equal(derived.resource, "", "cwd derives from the bound resource");
      assert.equal(derived.networkNeed, "none");
      assert.equal(derived.execMode, "argv");
      assert.equal(derived.timeoutMs, DEFAULT_BOUND_TIMEOUT_MS, "timeout is bound, not caller-chosen");
      assert.equal(derived.projectId, "demo");
      assert.equal(derived.agentSessionId, "sessA");
      // A hand-built divergent request must be refused by the equality gate.
      await assert.rejects(
        () =>
          fx.ctx.authorized.exec(
            { authz, descriptor: boundDescriptor },
            { ...derived, timeoutMs: 999_999 },
          ),
        (err: unknown) => {
          const e = err as { code?: string };
          assert.equal(e.code, "APPROVAL_MISMATCH");
          return true;
        },
        "a divergent timeout must be refused",
      );
      assert.equal(fx.childSpawns(), 0, "divergent dispatch must not reach the provider");
      console.log("[PASS] Dispatch derives from the descriptor; divergent timeout refused.");
    } finally {
      fx.cleanup();
    }
  }

  console.log("=== ALL AGENT RUNTIME REQUEST-BINDING TESTS PASSED ===");
}

main().catch((err) => {
  console.error("Agent runtime binding test failed:", err);
  process.exit(1);
});
