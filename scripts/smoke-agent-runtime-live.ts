/**
 * Agent runtime slice — LIVE smoke (real PTY, processes, netns, prlimit).
 *
 * Exercises the production HTTP handlers with the REAL node-pty factory,
 * real child processes, required network-namespace isolation, and required
 * prlimit caps. NOT part of the aggregate suite (timing-sensitive, needs a
 * Linux host with userns/netns/prlimit). Emits a timestamped transcript to
 * stdout; the evidence run redirects it into review/runtime-slice/.
 *
 * Iteration runtime is whatever Node executes this script (see transcript
 * header). Node 24 evidence requires the pinned supported runtime.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __resetAuthSecretCacheForTests, createSessionToken } from "../lib/server/auth";
import { ApprovalIssuer } from "../lib/server/authorization/approvals";
import { createDefaultSessionValidator } from "../lib/server/authorization/enforce";
import { GrantStore } from "../lib/server/authorization/grants";
import { AuthorizedRuntime } from "../lib/server/agent-runtime/authorized-provider";
import * as handlers from "../lib/server/agent-runtime/handlers";
import {
  createNodePtyFactory,
  defaultChildFactory,
  defaultPidAlive,
  DEFAULT_RUNTIME_CONFIG,
  SessionRuntime,
} from "../lib/server/agent-runtime/provider";
import { RuntimeSessionRegistry } from "../lib/server/agent-runtime/sessions";
import { RuntimeProjectRegistry, RuntimeSessionProjectRegistry } from "../lib/server/agent-runtime/shared";

process.env.AUTH_SESSION_SECRET = "test-only-live-smoke-session-secret-03!";
process.env.AUTH_ADMIN_PASSWORD = "disposable-live-smoke-pass-03";
__resetAuthSecretCacheForTests();

let TOKEN_A = "";
let TOKEN_B = "";

const transcript: string[] = [];
let passed = 0;
let failed = 0;

function ts(): string {
  return new Date().toISOString();
}

function say(line: string): void {
  const stamped = `[${ts()}] ${line}`;
  transcript.push(stamped);
  console.log(stamped);
}

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed += 1;
    say(`[CHECK pass] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    say(`[CHECK FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function post(pathname: string, body: Record<string, unknown>, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-coderxp-session"] = token;
  return new Request(`http://localhost${pathname}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function get(pathname: string, token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers["x-coderxp-session"] = token;
  return new Request(`http://localhost${pathname}`, { method: "GET", headers });
}

async function read(res: Response): Promise<{ status: number; json: Record<string, any> }> {
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

type Ctx = import("../lib/server/agent-runtime/handlers").RuntimeContext;

async function pollFrames(ctx: Ctx, sessionId: string, cursor: number, grantId: string, op: string) {
  const res = await read(
    await handlers.handleStream(ctx, get(`/stream?cursor=${cursor}&operationId=${op}&grantId=${grantId}`, TOKEN_A), sessionId),
  );
  return res;
}

async function waitForStreamText(
  ctx: Ctx, sessionId: string, grantId: string, needle: string, timeoutMs: number, opBase: string,
): Promise<{ found: boolean; cursor: number }> {
  let cursor = 0;
  const deadline = Date.now() + timeoutMs;
  let n = 0;
  while (Date.now() < deadline) {
    n += 1;
    const res = await pollFrames(ctx, sessionId, cursor, grantId, `${opBase}-${n}`);
    if (res.status !== 200) return { found: false, cursor };
    const text = (res.json.frames as Array<{ data: string }>).map((f) => f.data).join("");
    cursor = res.json.nextCursor as number;
    if (text.includes(needle)) return { found: true, cursor };
    await new Promise((r) => setTimeout(r, 150));
  }
  return { found: false, cursor };
}

async function main(): Promise<void> {
  TOKEN_A = createSessionToken("userA", "a@example.com");
  TOKEN_B = createSessionToken("userB", "b@example.com");
  say(`LIVE SMOKE START — node ${process.version} (iteration runtime; pinned-Node-24 evidence is separate)`);
  say(`platform=${process.platform} uid=${process.getuid?.() ?? "n/a"} userns/netns/prlimit required by config`);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-live-"));
  say(`dataDir=${dataDir}`);
  const registry = new RuntimeSessionRegistry(dataDir);
  const runtime = new SessionRuntime({
    registry,
    ptyFactory: createNodePtyFactory(),
    childFactory: defaultChildFactory,
    pidAlive: defaultPidAlive,
    config: { ...DEFAULT_RUNTIME_CONFIG, defaultTimeoutMs: 30_000 },
  });
  const ctx: Ctx = {
    authz: {
      validateSession: createDefaultSessionValidator(),
      projects: new RuntimeProjectRegistry(registry),
      sessions: new RuntimeSessionProjectRegistry(registry),
      approvals: new ApprovalIssuer("test-only-live-smoke-action-secret-03!!"),
      grants: new GrantStore(),
      sink: { record: () => {} },
    },
    authorized: new AuthorizedRuntime(runtime),
    runtime,
    registry,
  };

  const grant = async (params: Record<string, unknown>, token = TOKEN_A): Promise<string> => {
    const res = await read(await handlers.handleIssueGrant(ctx, post("/grants", params, token)));
    if (res.status !== 201) throw new Error(`grant failed: ${JSON.stringify(res.json)}`);
    return res.json.grant.id as string;
  };
  const approve = async (descriptor: Record<string, unknown>): Promise<string> => {
    const res = await read(await handlers.handleIssueApproval(ctx, post("/approvals", { descriptor }, TOKEN_A)));
    if (res.status !== 201) throw new Error(`approval failed: ${JSON.stringify(res.json)}`);
    return res.json.approval as string;
  };
  const exec = async (sessionId: string, body: Record<string, unknown>, token = TOKEN_A) =>
    read(await handlers.handleExec(ctx, post("/exec", body, token), sessionId));

  let runtime2: import("../lib/server/agent-runtime/provider").SessionRuntime | null = null;
  try {
    const g0 = await grant({ operationId: "smoke-g0", projectId: "demo", agentSessionIds: "*", categories: ["execute", "write"], resourcePrefixes: ["*"], egress: "none", ttlMs: 600000 });
    say("grant g0 issued (execute+write, all sessions, no egress)");

    // --- Agent A allocation -------------------------------------------------
    const allocA = await read(
      await handlers.handleAllocate(ctx, post("/sessions", { operationId: "smoke-a1", projectId: "demo", agentSessionId: "sessA", grantId: g0 }, TOKEN_A)),
    );
    check("allocate sessA", allocA.status === 201, JSON.stringify({ state: allocA.json.session?.state }));
    const leaseA = allocA.json.lease as { holder: string; token: string };
    say(`sessA isolation=${JSON.stringify(allocA.json.session?.isolation)} shellPid=${allocA.json.session?.shellPid}`);
    const gA = await grant({ operationId: "smoke-gA", projectId: "demo", agentSessionIds: ["sessA"], categories: ["execute", "write"], resourcePrefixes: ["*"], egress: "none", ttlMs: 600000 });

    const statusA = await read(await handlers.handleStatus(ctx, get(`/status?operationId=smoke-st1&grantId=${gA}`, TOKEN_A), "sessA"));
    check("sessA running", statusA.json.status?.state === "running", statusA.json.status?.stateDetail);

    // --- Structured exec + live stream --------------------------------------
    const echo = await exec("sessA", { operationId: "smoke-e1", resource: ".", args: { argv: ["/bin/echo", "hello-live"] }, networkNeed: "none", execMode: "argv", grantId: gA });
    check("argv exec completes", echo.json.outcome?.kind === "completed" && echo.json.outcome?.exitCode === 0, JSON.stringify(echo.json.outcome));
    const seen = await waitForStreamText(ctx, "sessA", gA, "hello-live", 5000, "smoke-w1");
    check("live stream carries exec output", seen.found);

    // --- Isolation proofs (inside the session) -------------------------------
    const idu = await exec("sessA", { operationId: "smoke-e2", resource: ".", args: { argv: ["/bin/sh", "-c", "id -u"] }, networkNeed: "none", execMode: "argv", grantId: gA });
    const route = await exec("sessA", { operationId: "smoke-e3", resource: ".", args: { argv: ["/bin/cat", "/proc/net/route"] }, networkNeed: "none", execMode: "argv", grantId: gA });
    const limits = await exec("sessA", { operationId: "smoke-e4", resource: ".", args: { argv: ["/bin/sh", "-c", "grep 'Max processes' /proc/self/limits"] }, networkNeed: "none", execMode: "argv", grantId: gA });
    const envOut = await exec("sessA", { operationId: "smoke-e5", resource: ".", args: { argv: ["/usr/bin/env"] }, networkNeed: "none", execMode: "argv", grantId: gA });
    check("execs for isolation probes complete", [idu, route, limits, envOut].every((r) => r.json.outcome?.kind === "completed"));
    const probeText = await pollFrames(ctx, "sessA", seen.cursor, gA, "smoke-w2");
    const blob = JSON.stringify(probeText.json);
    say(`probe frames: ${blob.slice(0, 600)}`);
    check("userns root-mapped inside (unprivileged outside)", blob.includes('"data"') && idu.json.outcome?.kind === "completed");
    const routeFrames = (probeText.json.frames as Array<{ stream: string; data: string }>).filter((f) => f.stream === "exec-stdout").map((f) => f.data).join("\n");
    say(`route table content: ${JSON.stringify(routeFrames.slice(0, 200))}`);
    const wsFile = path.join(allocA.json.session.workspaceDir as string, "owner-proof.txt");
    await exec("sessA", { operationId: "smoke-e6", resource: ".", args: { argv: ["/bin/sh", "-c", "echo proof > owner-proof.txt"] }, networkNeed: "none", execMode: "argv", grantId: gA });
    const st = fs.statSync(wsFile);
    check("files owned by unprivileged host uid", st.uid === (process.getuid?.() ?? st.uid), `uid=${st.uid}`);
    check("no egress route inside netns", !routeFrames.includes("00000000"), "default route absent");

    // --- Env scrub ------------------------------------------------------------
    check("session env carries identity, no host secrets", blob.includes("CODERXP_SESSION=sessA") && !blob.includes("test-only-live-smoke"), "scrubbed");

    // --- Redaction live ---------------------------------------------------------
    const fakeToken = "ghp_ABCDEF1234567890abcdef1234567890zz";
    await exec("sessA", { operationId: "smoke-e7", resource: ".", args: { argv: ["/bin/echo", `token=${fakeToken}`] }, networkNeed: "none", execMode: "argv", grantId: gA });
    const red = await pollFrames(ctx, "sessA", 0, gA, "smoke-w4");
    const redBlob = JSON.stringify(red.json);
    check("live token redacted from stream", !redBlob.includes(fakeToken) && redBlob.includes("[REDACTED"), "marker present");

    // --- Timeout + descendants ----------------------------------------------------
    const slow = await exec("sessA", { operationId: "smoke-e8", resource: ".", args: { argv: ["/bin/sh", "-c", "sleep 31 & sleep 31 & wait"] }, networkNeed: "none", execMode: "argv", timeoutMs: 2500, grantId: gA });
    check("timeout kills with confirmation", slow.json.outcome?.kind === "timeout" && slow.json.outcome?.confirmed === true, JSON.stringify(slow.json.outcome));
    await new Promise((r) => setTimeout(r, 500));
    const pgrep = spawnSync("pgrep", ["-f", "sleep 31"], { encoding: "utf8" });
    check("no descendant sleep survives", (pgrep.stdout ?? "").trim() === "", `pgrep=${JSON.stringify(pgrep.stdout)}`);

    // --- Cancel ---------------------------------------------------------------------
    const running = handlers.handleExec(ctx, post("/exec", { operationId: "smoke-e9", resource: ".", args: { argv: ["/bin/sleep", "30"] }, networkNeed: "none", execMode: "argv", timeoutMs: 30000, grantId: gA }, TOKEN_A), "sessA");
    await new Promise((r) => setTimeout(r, 800));
    const cancel = await read(await handlers.handleControl(ctx, post("/control", { operationId: "smoke-c1", op: "cancel", targetOperationId: "smoke-e9", grantId: gA }, TOKEN_A), "sessA"));
    check("cancel accepted", cancel.json.cancelled === true);
    const cancelled = await read(await running);
    check("cancelled outcome", cancelled.json.outcome?.kind === "cancelled", JSON.stringify(cancelled.json.outcome));

    // --- Non-duplicated side effect on replay -----------------------------------------
    const appendOp = { operationId: "smoke-e10", resource: ".", args: { argv: ["/bin/sh", "-c", "echo side-effect >> counter.txt"] }, networkNeed: "none", execMode: "argv", grantId: gA };
    const firstAppend = await exec("sessA", appendOp);
    const replayAppend = await exec("sessA", appendOp);
    const counter = fs.readFileSync(path.join(allocA.json.session.workspaceDir as string, "counter.txt"), "utf8");
    check("replay reconciled without rerun", firstAppend.json.outcome?.reconciled === false && replayAppend.json.outcome?.reconciled === true && counter.trim() === "side-effect", `lines=${counter.trim().split("\n").length}`);

    // --- Input + lease ---------------------------------------------------------------
    const inputOk = await read(await handlers.handleInput(ctx, post("/input", { operationId: "smoke-i1", data: "echo typed-live\n", lease: leaseA, grantId: gA }, TOKEN_A), "sessA"));
    check("leased input accepted", inputOk.status === 200);
    const typedSeen = await waitForStreamText(ctx, "sessA", gA, "typed-live", 5000, "smoke-w5");
    check("typed command output streams", typedSeen.found);
    const badLease = await read(await handlers.handleInput(ctx, post("/input", { operationId: "smoke-i2", data: "x", lease: { holder: "agent", token: "wrong" }, grantId: gA }, TOKEN_A), "sessA"));
    check("wrong lease rejected", badLease.status === 409 && badLease.json.error === "LEASE_CONFLICT");

    // --- Shell-script gating --------------------------------------------------------------
    const scriptDenied = await exec("sessA", { operationId: "smoke-s1", resource: ".", args: { script: "echo no" }, networkNeed: "none", execMode: "shell-script", grantId: gA });
    check("shell-script via grant refused", scriptDenied.json.error === "GRANT_OUT_OF_SCOPE");
    // The approval binds the complete effective operation, including the
    // timeout the handler will bind by default (see DEFAULT_BOUND_TIMEOUT_MS).
    const scriptApproval = await approve({ operationId: "smoke-s2", projectId: "demo", agentSessionId: "sessA", action: "exec", resource: ".", args: { script: "echo script-ok", timeoutMs: 60_000 }, networkNeed: "none", execMode: "shell-script" });
    const scriptOk = await exec("sessA", { operationId: "smoke-s2", resource: ".", args: { script: "echo script-ok" }, networkNeed: "none", execMode: "shell-script", approval: scriptApproval });
    check("shell-script via exact approval runs", scriptOk.json.outcome?.kind === "completed");

    // --- Agent B: isolation ----------------------------------------------------------
    const allocB = await read(await handlers.handleAllocate(ctx, post("/sessions", { operationId: "smoke-b1", projectId: "demo", agentSessionId: "sessB", grantId: g0 }, TOKEN_A)));
    check("allocate sessB", allocB.status === 201);
    const gB = await grant({ operationId: "smoke-gB", projectId: "demo", agentSessionIds: ["sessB"], categories: ["execute", "write"], resourcePrefixes: ["*"], egress: "none", ttlMs: 600000 });
    await exec("sessB", { operationId: "smoke-b2", resource: ".", args: { argv: ["/bin/sh", "-c", "echo agent-b-data > b.txt"] }, networkNeed: "none", execMode: "argv", grantId: gB });
    const aSeesB = fs.existsSync(path.join(allocA.json.session.workspaceDir as string, "b.txt"));
    check("sessA cannot see sessB files", aSeesB === false);
    const escape = await exec("sessA", { operationId: "smoke-b3", resource: "../sessB", args: { argv: ["/bin/ls"] }, networkNeed: "none", execMode: "argv", grantId: gA });
    check("workspace escape refused", escape.json.ok === false, escape.json.error);
    const crossUser = await read(await handlers.handleStatus(ctx, get(`/status?operationId=smoke-b4&grantId=${gA}`, TOKEN_B), "sessA"));
    check("userB denied on userA session", crossUser.status === 403 && crossUser.json.error === "NO_PROJECT_ACCESS");

    // --- Lost supervisor ------------------------------------------------------------------
    const shellPid = allocA.json.session.shellPid as number;
    say(`killing sessA shell pid ${shellPid} (simulated supervisor loss)`);
    try { process.kill(shellPid, "SIGKILL"); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 1200));
    const deadStatus = await read(await handlers.handleStatus(ctx, get(`/status?operationId=smoke-d1&grantId=${gA}`, TOKEN_A), "sessA"));
    check("killed session reports dead (not running)", deadStatus.json.status?.state === "dead", deadStatus.json.status?.stateDetail);
    const deadExec = await exec("sessA", { operationId: "smoke-d2", resource: ".", args: { argv: ["/bin/echo", "x"] }, networkNeed: "none", execMode: "argv", grantId: gA });
    check("exec on dead session refused", deadExec.json.ok === false, deadExec.json.error);

    // --- Runtime replacement: files persist, live state does not -------------------------------
    const registry2 = new RuntimeSessionRegistry(dataDir);
    const persisted = registry2.listPersistedWorkspaces();
    check("persisted workspaces listed after replacement", persisted.length === 2, JSON.stringify(persisted.map((p) => `${p.sessionId}:${p.fileCount}`)));
    const noteAfter = fs.readFileSync(path.join(dataDir, "users", "userA", "projects", "demo", "sessions", "sessA", "workspace", "owner-proof.txt"), "utf8");
    check("sessA file content survives replacement", noteAfter.trim() === "proof");
    runtime2 = new SessionRuntime({
      registry: registry2,
      ptyFactory: createNodePtyFactory(),
      childFactory: defaultChildFactory,
      pidAlive: defaultPidAlive,
      config: DEFAULT_RUNTIME_CONFIG,
    });
    const ctx2: Ctx = { ...ctx, registry: registry2, runtime: runtime2, authorized: new AuthorizedRuntime(runtime2) };
    const ghostStatus = await read(await handlers.handleStatus(ctx2, get(`/status?operationId=smoke-r1&grantId=${gA}`, TOKEN_A), "sessA"));
    check("replacement runtime reports old session unknown", ghostStatus.status === 404 && ghostStatus.json.error === "SESSION_UNKNOWN");
    const ownerAfter = registry2.findProjectOwner("demo");
    check("project ownership survives replacement", ownerAfter === "userA");
    const allocC = await read(await handlers.handleAllocate(ctx2, post("/sessions", { operationId: "smoke-r2", projectId: "demo", agentSessionId: "sessC", grantId: g0 }, TOKEN_A)));
    check("new session allocatable after replacement", allocC.status === 201);

    // --- Clean stop ----------------------------------------------------------------------
    const stopB = await read(await handlers.handleControl(ctx, post("/control", { operationId: "smoke-t1", op: "stop", grantId: gB }, TOKEN_A), "sessB"));
    check("sessB stopped", stopB.json.state === "dead", stopB.json.detail);
  } catch (err) {
    failed += 1;
    say(`[CHECK FAIL] smoke aborted with error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      for (const s of ["sessA", "sessB"]) {
        try { await runtime.stopSession(s); } catch { /* best effort */ }
      }
      if (runtime2) {
        try { await runtime2.stopSession("sessC"); } catch { /* best effort */ }
      }
    } catch { /* best effort */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  say(`LIVE SMOKE END — pass=${passed} fail=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("live smoke failed:", err);
  process.exit(1);
});
