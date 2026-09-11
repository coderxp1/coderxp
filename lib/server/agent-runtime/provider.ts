/**
 * Agent runtime slice — real PTY session provider.
 *
 * One persistent PTY-backed shell per agent session (node-pty) plus
 * structured exec children spawned directly (argv) or via `sh -c`
 * (shell-script, approval-gated upstream). Isolation per session:
 * unprivileged host uid, optional no-egress network namespace
 * (`unshare -U -n -r`), prlimit resource caps, scrubbed environment,
 * workspace confinement. No general egress is offered in this slice.
 *
 * Health is fail-closed: lost supervisor contact reports `unknown` (never
 * a fabricated state); exec on a non-running session is refused; kills
 * are verified (ESRCH) and unverified kills are reported unconfirmed.
 *
 * The pty/child factories are injectable so supervisor logic (timeouts,
 * cancel, unknown-state handling, op-ledger replay) is covered by
 * deterministic unit tests. Live evidence comes from the smoke script,
 * which uses the real factories exclusively.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeResourcePath } from "../authorization/util";
import type { RuntimeSessionRegistry } from "./sessions";
import { createStreamRedactor, StreamBuffer, type StreamRedactor } from "./stream-buffer";
import {
  type AttachResult,
  type ControlLease,
  type ExecOutcome,
  type ExecRequest,
  type LeaseHolder,
  RuntimeError,
  type SessionInfo,
  type SessionRuntimeState,
  type StreamFrame,
} from "./types";

/* ------------------------------------------------------------------ */
/* Factories (real default; injectable for deterministic tests)         */
/* ------------------------------------------------------------------ */

export interface PtyHandle {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): void;
}

export interface PtySpawnOptions {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export type PtyFactory = (file: string, args: string[], opts: PtySpawnOptions) => PtyHandle;

export function createNodePtyFactory(): PtyFactory {
  let loaded: unknown;
  try {
    loaded = require("node-pty") as unknown;
  } catch (err) {
    throw new RuntimeError(
      "RUNTIME_UNAVAILABLE",
      `node-pty is unavailable in this runtime (${err instanceof Error ? err.message : String(err)}).`,
      503,
    );
  }
  const spawnFn = (loaded as { spawn?: unknown } | null)?.spawn;
  if (typeof spawnFn !== "function") {
    throw new RuntimeError("RUNTIME_UNAVAILABLE", "node-pty loaded without a spawn function.", 503);
  }
  const spawn = (spawnFn as (file: string, args: string[], opts: Record<string, unknown>) => PtyHandle).bind(loaded);
  return (file, args, opts) => spawn(file, args, { name: "xterm-256color", ...opts });
}

export interface ChildHandle {
  readonly pid: number | undefined;
  on(event: "exit" | "error", cb: (...args: never[]) => void): void;
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): void } | null;
}

export interface ChildSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  detached: boolean;
}

export type ChildFactory = (file: string, args: string[], opts: ChildSpawnOptions) => ChildHandle;

export const defaultChildFactory: ChildFactory = (file, args, opts) => {
  const spawnOptions: SpawnOptions = {
    cwd: opts.cwd,
    env: { ...opts.env } as NodeJS.ProcessEnv,
    detached: opts.detached,
    stdio: ["ignore", "pipe", "pipe"],
  };
  const child: ChildProcess = nodeSpawn(file, args, spawnOptions);
  return child as unknown as ChildHandle;
};

export type PidAliveFn = (pid: number) => boolean;

export const defaultPidAlive: PidAliveFn = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface RuntimeProviderConfig {
  shell: string;
  shellArgs: string[];
  netnsRequired: boolean;
  limitsRequired: boolean;
  minTimeoutMs: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxExecOutputBytes: number;
  maxRetainedBytes: number;
  maxFrames: number;
  killGraceMs: number;
  exitWaitMs: number;
  leaseTtlMs: number;
  nprocLimit: number;
  cpuSecondsLimit: number;
  fsizeBytesLimit: number;
  maxArgvCount: number;
  maxArgvBytes: number;
  maxScriptBytes: number;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeProviderConfig = {
  shell: "/bin/sh",
  shellArgs: ["-i"],
  netnsRequired: true,
  limitsRequired: true,
  minTimeoutMs: 1000,
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 120_000,
  maxExecOutputBytes: 256 * 1024,
  maxRetainedBytes: 1024 * 1024,
  maxFrames: 4000,
  killGraceMs: 2000,
  exitWaitMs: 5000,
  leaseTtlMs: 15 * 60 * 1000,
  nprocLimit: 256,
  cpuSecondsLimit: 300,
  fsizeBytesLimit: 512 * 1024 * 1024,
  maxArgvCount: 128,
  maxArgvBytes: 32 * 1024,
  maxScriptBytes: 64 * 1024,
};

export interface ProviderDeps {
  registry: RuntimeSessionRegistry;
  ptyFactory: PtyFactory;
  childFactory: ChildFactory;
  pidAlive: PidAliveFn;
  config: RuntimeProviderConfig;
  now?: () => number;
  redactorFactory?: (extraSecrets: string[]) => StreamRedactor;
}

interface LiveSession {
  record: { sessionId: string; projectId: string; ownerUserId: string; workspaceDir: string };
  pty: PtyHandle;
  buffer: StreamBuffer;
  lease: ControlLease;
  shellExited: boolean;
  shellExitCode: number | null;
  activeOps: Map<string, ActiveOp>;
}

interface ActiveOp {
  operationId: string;
  childPid: number | undefined;
  cancelRequested: boolean;
  cancel: () => void;
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

export class SessionRuntime {
  private readonly registry: RuntimeSessionRegistry;
  private readonly ptyFactory: PtyFactory;
  private readonly childFactory: ChildFactory;
  private readonly pidAlive: PidAliveFn;
  private readonly config: RuntimeProviderConfig;
  private readonly now: () => number;
  private readonly redactorFactory: (extraSecrets: string[]) => StreamRedactor;
  private readonly live = new Map<string, LiveSession>();
  private initialized = false;

  constructor(deps: ProviderDeps) {
    this.registry = deps.registry;
    this.ptyFactory = deps.ptyFactory;
    this.childFactory = deps.childFactory;
    this.pidAlive = deps.pidAlive ?? defaultPidAlive;
    this.config = deps.config;
    this.now = deps.now ?? Date.now;
    this.redactorFactory = deps.redactorFactory ?? createStreamRedactor;
  }

  /** Verifies platform, shell, netns, and prlimit. Fails closed. */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (process.platform !== "linux") {
      throw new RuntimeError("RUNTIME_UNAVAILABLE", `Agent sessions require Linux isolation primitives (platform: ${process.platform}).`, 503);
    }
    try {
      fs.accessSync(this.config.shell, fs.constants.X_OK);
    } catch {
      throw new RuntimeError("RUNTIME_UNAVAILABLE", `Session shell is not executable: ${this.config.shell}.`, 503);
    }
    if (this.config.netnsRequired) {
      await this.probe(["unshare", "-U", "-n", "-r", "true"], "network-namespace isolation (unshare -U -n -r)");
    }
    if (this.config.limitsRequired) {
      await this.probe(["prlimit", "--version"], "resource limits (prlimit)");
    }
    this.initialized = true;
  }

  private probe(argv: string[], what: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(argv[0], argv.slice(1), { timeout: 10_000 }, (err) => {
        if (err) {
          reject(new RuntimeError("RUNTIME_UNAVAILABLE", `Required ${what} is unavailable: ${err.message}.`, 503));
        } else {
          resolve();
        }
      });
    });
  }

  /* ---------------- allocate ---------------- */

  async allocate(input: { operationId: string; projectId: string; ownerUserId: string; agentSessionId?: string; cols: number; rows: number }): Promise<{ info: SessionInfo; lease: ControlLease }> {
    this.requireInit();
    const cols = clampInt(input.cols, 20, 500, 80);
    const rows = clampInt(input.rows, 5, 200, 24);
    const record = this.registry.allocate(input.projectId, input.ownerUserId, input.agentSessionId);
    const env = buildIsolatedEnv({ projectId: record.projectId, sessionId: record.sessionId, home: record.workspaceDir, term: true });
    const shellArgv = this.config.netnsRequired
      ? { file: "unshare", args: ["-U", "-n", "-r", this.config.shell, ...this.config.shellArgs] }
      : { file: this.config.shell, args: this.config.shellArgs };
    let pty: PtyHandle;
    try {
      pty = this.ptyFactory(shellArgv.file, shellArgv.args, { cwd: record.workspaceDir, env, cols, rows });
    } catch (err) {
      this.registry.update(record.sessionId, { state: "unknown", stateDetail: "pty spawn failed", endedAt: this.now() });
      throw new RuntimeError("RUNTIME_UNAVAILABLE", `Failed to spawn session shell: ${err instanceof Error ? err.message : String(err)}.`, 503);
    }
    if (this.config.limitsRequired) {
      try {
        await this.applyPidLimits(pty.pid);
      } catch (err) {
        try { pty.kill("SIGKILL"); } catch { /* best effort */ }
        this.registry.update(record.sessionId, { state: "unknown", stateDetail: "resource limits could not be applied", endedAt: this.now() });
        throw new RuntimeError("RUNTIME_UNAVAILABLE", `Session resource limits could not be applied: ${err instanceof Error ? err.message : String(err)}.`, 503);
      }
    }
    const buffer = new StreamBuffer(this.redactorFactory([]), {
      maxRetainedBytes: this.config.maxRetainedBytes,
      maxFrames: this.config.maxFrames,
      now: this.now,
    });
    const lease: ControlLease = {
      holder: "agent",
      token: crypto.randomBytes(16).toString("hex"),
      acquiredAt: this.now(),
      expiresAt: this.now() + this.config.leaseTtlMs,
    };
    const live: LiveSession = {
      record: { sessionId: record.sessionId, projectId: record.projectId, ownerUserId: record.ownerUserId, workspaceDir: record.workspaceDir },
      pty,
      buffer,
      lease,
      shellExited: false,
      shellExitCode: null,
      activeOps: new Map(),
    };
    this.live.set(record.sessionId, live);
    pty.onData((data) => {
      try { buffer.append("pty", data); } catch { /* retention-bounded; append does not throw */ }
    });
    pty.onExit((event) => {
      live.shellExited = true;
      live.shellExitCode = typeof event?.exitCode === "number" ? event.exitCode : null;
      buffer.flush("pty");
      buffer.append("state", `shell exited (code ${live.shellExitCode === null ? "unknown" : live.shellExitCode})`);
      try {
        this.registry.update(record.sessionId, { state: "dead", stateDetail: "shell exited", shellPid: null, endedAt: this.now() });
      } catch { /* registry is authoritative; ignore late updates */ }
    });
    this.registry.update(record.sessionId, { state: "running", stateDetail: "shell spawned", shellPid: pty.pid });
    return {
      info: this.toSessionInfo(record.sessionId),
      lease: { ...lease },
    };
  }

  private applyPidLimits(pid: number): Promise<void> {
    const c = this.config;
    return new Promise((resolve, reject) => {
      execFile(
        "prlimit",
        [
          `--pid=${pid}`,
          `--nproc=${c.nprocLimit}`,
          `--cpu=${c.cpuSecondsLimit}`,
          `--fsize=${c.fsizeBytesLimit}`,
        ],
        { timeout: 10_000 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  /* ---------------- exec ---------------- */

  async exec(req: ExecRequest): Promise<ExecOutcome> {
    this.requireInit();
    const live = this.requireLive(req.agentSessionId);
    const stored = this.registry.get(req.agentSessionId);
    if (stored.projectId !== req.projectId) {
      throw new RuntimeError("CONSTRAINT_VIOLATION", "Exec project does not match the session project.", 400);
    }
    if (stored.state !== "running") {
      throw new RuntimeError("RUNTIME_UNAVAILABLE", `Cannot exec: session is ${stored.state}.`, 503);
    }
    const replay = this.registry.replayOp(req.operationId);
    if (replay) return replay;

    const cwd = this.resolveCwd(live.record.workspaceDir, req.resource, req.operationId);
    this.checkNetworkCapability(req.networkNeed);
    const argv = this.buildArgv(req);
    const timeoutMs = clampInt(req.timeoutMs, this.config.minTimeoutMs, this.config.maxTimeoutMs, this.config.defaultTimeoutMs);
    const wrapped = this.wrapArgv(argv);
    const env = buildIsolatedEnv({ projectId: req.projectId, sessionId: req.agentSessionId, home: live.record.workspaceDir, op: req.operationId, term: false });

    const startedAt = this.now();
    let child: ChildHandle;
    try {
      child = this.childFactory(wrapped[0], wrapped.slice(1), { cwd, env, detached: true });
    } catch (err) {
      return this.finishOp(req.operationId, {
        kind: "failed-to-start",
        exitCode: null,
        signal: null,
        confirmed: true,
        reconciled: false,
        outputBytes: 0,
        outputTruncated: false,
        durationMs: this.now() - startedAt,
      }, `spawn failed: ${err instanceof Error ? err.message : String(err)}`, live);
    }

    return await new Promise<ExecOutcome>((resolve) => {
      const state = {
        settled: false,
        spawnError: null as string | null,
        exited: false,
        exitCode: null as number | null,
        exitSignal: null as string | null,
        timedOut: false,
        cancelled: false,
        outputBytes: 0,
        truncated: false,
        truncationNoted: false,
      };
      const active: ActiveOp = {
        operationId: req.operationId,
        childPid: child.pid,
        cancelRequested: false,
        cancel: () => {
          state.cancelled = true;
          void this.terminateChild(child, live, req.operationId);
        },
      };
      live.activeOps.set(req.operationId, active);
      const cleanup = () => {
        clearTimeout(timer);
        live.activeOps.delete(req.operationId);
      };
      const settle = (outcome: ExecOutcome, detail?: string) => {
        if (state.settled) return;
        state.settled = true;
        cleanup();
        resolve(this.finishOp(req.operationId, outcome, detail, live));
      };
      const noteTruncation = () => {
        if (state.truncationNoted) return;
        state.truncationNoted = true;
        state.truncated = true;
        live.buffer.append("control", `[OUTPUT TRUNCATED after ${state.outputBytes} bytes for ${req.operationId}]`);
      };
      const onData = (stream: "exec-stdout" | "exec-stderr") => (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const bytes = Buffer.byteLength(text, "utf8");
        if (state.outputBytes + bytes > this.config.maxExecOutputBytes) {
          noteTruncation();
          return;
        }
        state.outputBytes += bytes;
        live.buffer.append(stream, text);
      };
      if (child.stdout) child.stdout.on("data", onData("exec-stdout"));
      if (child.stderr) child.stderr.on("data", onData("exec-stderr"));
      child.on("error", (err: unknown) => {
        state.spawnError = err instanceof Error ? err.message : String(err);
        if (!state.exited) {
          // Spawn-level failure (e.g. ENOENT): the process never started.
          settle({
            kind: "failed-to-start",
            exitCode: null,
            signal: null,
            confirmed: true,
            reconciled: false,
            outputBytes: state.outputBytes,
            outputTruncated: state.truncated,
            durationMs: this.now() - startedAt,
          }, `spawn error: ${state.spawnError}`);
        }
      });
      child.on("exit", (code: unknown, signal: unknown) => {
        state.exited = true;
        state.exitCode = typeof code === "number" ? code : null;
        state.exitSignal = typeof signal === "string" ? signal : null;
        if (state.cancelled || active.cancelRequested) {
          settle({
            kind: "cancelled",
            exitCode: state.exitCode,
            signal: state.exitSignal,
            confirmed: true,
            reconciled: false,
            outputBytes: state.outputBytes,
            outputTruncated: state.truncated,
            durationMs: this.now() - startedAt,
          }, "cancelled by operator");
          return;
        }
        if (state.timedOut) {
          settle({
            kind: "timeout",
            exitCode: state.exitCode,
            signal: state.exitSignal,
            confirmed: true,
            reconciled: false,
            outputBytes: state.outputBytes,
            outputTruncated: state.truncated,
            durationMs: this.now() - startedAt,
          }, `exceeded ${timeoutMs}ms`);
          return;
        }
        if (state.exitCode !== null) {
          settle({
            kind: "completed",
            exitCode: state.exitCode,
            signal: null,
            confirmed: true,
            reconciled: false,
            outputBytes: state.outputBytes,
            outputTruncated: state.truncated,
            durationMs: this.now() - startedAt,
          });
          return;
        }
        settle({
          kind: state.exitSignal ? "signaled" : "unknown",
          exitCode: null,
          signal: state.exitSignal,
          confirmed: state.exitSignal !== null,
          reconciled: false,
          outputBytes: state.outputBytes,
          outputTruncated: state.truncated,
          durationMs: this.now() - startedAt,
        }, state.exitSignal ? `ended by signal ${state.exitSignal}` : "exit observed without code or signal");
      });
      const timer = setTimeout(() => {
        if (state.settled || state.exited) return;
        state.timedOut = true;
        void this.terminateChild(child, live, req.operationId).then((verified) => {
          if (state.settled) return;
          // If the exit event still arrives it will settle with kind timeout.
          setTimeout(() => {
            if (state.settled) return;
            const pidDead = child.pid === undefined || !this.pidAlive(child.pid);
            if (!verified || !pidDead) {
              this.registry.update(req.agentSessionId, { state: "unknown", stateDetail: `exec ${req.operationId} could not be verified dead` });
              settle({
                kind: "unknown",
                exitCode: null,
                signal: null,
                confirmed: false,
                reconciled: false,
                outputBytes: state.outputBytes,
                outputTruncated: state.truncated,
                durationMs: this.now() - startedAt,
              }, "supervisor lost contact with the exec child");
            }
          }, this.config.exitWaitMs);
        });
      }, timeoutMs);
      // Do not let a long timeout keep the event loop alive by itself.
      if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }
    });
  }

  private finishOp(operationId: string, outcome: ExecOutcome, detail: string | undefined, live: LiveSession): ExecOutcome {
    this.registry.recordOp(operationId, outcome);
    live.buffer.append("control", `op ${operationId}: ${outcome.kind}${detail ? ` (${detail})` : ""}`);
    return { ...outcome };
  }

  /** Cancels a running exec. Unknown op ids are reported, never invented. */
  cancelOp(sessionId: string, operationId: string): { cancelled: boolean; outcome: ExecOutcome | null } {
    this.requireInit();
    const live = this.requireLive(sessionId);
    const active = live.activeOps.get(operationId);
    if (!active) {
      return { cancelled: false, outcome: this.registry.replayOp(operationId) };
    }
    active.cancelRequested = true;
    active.cancel();
    return { cancelled: true, outcome: null };
  }

  private async terminateChild(child: ChildHandle, live: LiveSession, operationId: string): Promise<boolean> {
    void live;
    void operationId;
    const pgid = child.pid;
    if (pgid === undefined) return false;
    return this.terminateGroup(pgid, this.config.killGraceMs);
  }

  private async terminateGroup(pgid: number, graceMs: number): Promise<boolean> {
    try {
      process.kill(-pgid, "SIGTERM");
    } catch (err) {
      if (groupCannotExist(err)) return true;
    }
    await sleep(Math.min(graceMs, 5000));
    if (groupDead(pgid)) return true;
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (err) {
      if (groupCannotExist(err)) return true;
    }
    await sleep(Math.min(graceMs, 5000));
    return groupDead(pgid);
  }

  /* ---------------- attach / input / control ---------------- */

  attach(sessionId: string, cursor: number): AttachResult {
    this.requireInit();
    const live = this.requireLive(sessionId);
    const stored = this.registry.get(sessionId);
    const read = live.buffer.read(cursor);
    return { ...read, state: stored.state };
  }

  /** Live frame subscription for an authorized attacher. Caller must unsubscribe. */
  subscribe(sessionId: string, cb: (frame: StreamFrame) => void): () => void {
    this.requireInit();
    return this.requireLive(sessionId).buffer.subscribe(cb);
  }

  input(sessionId: string, data: string, lease: { holder: LeaseHolder; token: string }): { acceptedBytes: number } {
    this.requireInit();
    const live = this.requireLive(sessionId);
    const stored = this.registry.get(sessionId);
    if (stored.state !== "running") {
      throw new RuntimeError("SESSION_DEAD", `Cannot write input: session is ${stored.state}.`, 409);
    }
    this.requireLease(live, lease.holder, lease.token);
    if (typeof data !== "string" || data.length === 0) {
      throw new RuntimeError("CONSTRAINT_VIOLATION", "Input must be a non-empty string.", 400);
    }
    if (Buffer.byteLength(data, "utf8") > 64 * 1024) {
      throw new RuntimeError("CONSTRAINT_VIOLATION", "Input exceeds the 64 KiB per-call cap.", 400);
    }
    live.pty.write(data);
    return { acceptedBytes: Buffer.byteLength(data, "utf8") };
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.requireInit();
    const live = this.requireLive(sessionId);
    live.pty.resize(clampInt(cols, 20, 500, 80), clampInt(rows, 5, 200, 24));
  }

  /** Sends ETX (Ctrl-C) to the foreground PTY process. Structured execs stop via cancel/stop. */
  interrupt(sessionId: string): void {
    this.requireInit();
    const live = this.requireLive(sessionId);
    const stored = this.registry.get(sessionId);
    if (stored.state !== "running") {
      throw new RuntimeError("SESSION_DEAD", `Cannot interrupt: session is ${stored.state}.`, 409);
    }
    live.pty.write("\x03");
    live.buffer.append("control", "interrupt sent to foreground process (ETX)");
  }

  acquireLease(sessionId: string, holder: LeaseHolder, takeover: boolean): ControlLease {
    this.requireInit();
    const live = this.requireLive(sessionId);
    const current = live.lease;
    const valid = this.now() < current.expiresAt;
    if (valid && current.holder !== holder && !takeover) {
      throw new RuntimeError("LEASE_CONFLICT", `Input is controlled by ${current.holder}; explicit takeover required.`, 409);
    }
    live.lease = {
      holder,
      token: crypto.randomBytes(16).toString("hex"),
      acquiredAt: this.now(),
      expiresAt: this.now() + this.config.leaseTtlMs,
    };
    live.buffer.append("control", `input lease ${takeover && valid && current.holder !== holder ? `taken over by ${holder} from ${current.holder}` : `acquired by ${holder}`}`);
    return { ...live.lease };
  }

  releaseLease(sessionId: string, holder: LeaseHolder, token: string): void {
    this.requireInit();
    const live = this.requireLive(sessionId);
    this.requireLease(live, holder, token);
    live.lease = { holder, token: "", acquiredAt: this.now(), expiresAt: this.now() };
    live.buffer.append("control", `input lease released by ${holder}`);
  }

  private requireLease(live: LiveSession, holder: LeaseHolder, token: string): void {
    if (!token || live.lease.token === "" || live.lease.token !== token || live.lease.holder !== holder) {
      throw new RuntimeError("LEASE_CONFLICT", "Input lease does not match the current holder.", 409);
    }
    if (this.now() >= live.lease.expiresAt) {
      throw new RuntimeError("LEASE_REQUIRED", "Input lease has expired; renew via terminal.lease.", 409);
    }
  }

  /** Stops the session: cancels active execs, kills the shell group, verifies death. */
  async stopSession(sessionId: string): Promise<{ state: SessionRuntimeState; detail: string }> {
    this.requireInit();
    const live = this.requireLive(sessionId);
    for (const op of live.activeOps.values()) {
      op.cancelRequested = true;
      try { op.cancel(); } catch { /* best effort */ }
    }
    const ptyPid = live.pty.pid;
    let verified = false;
    if (!live.shellExited) {
      verified = await this.terminateGroup(ptyPid, this.config.killGraceMs);
      try { live.pty.kill("SIGKILL"); } catch { /* best effort */ }
      await sleep(200);
    } else {
      verified = true;
    }
    live.buffer.flush("pty");
    if (live.shellExited || verified) {
      this.registry.update(sessionId, { state: "dead", stateDetail: "stopped by operator", shellPid: null, endedAt: this.now() });
      this.live.delete(sessionId);
      return { state: "dead", detail: "session stopped; shell group verified dead" };
    }
    this.registry.update(sessionId, { state: "unknown", stateDetail: "stop issued but death unverified", shellPid: ptyPid });
    return { state: "unknown", detail: "stop issued but the shell group could not be verified dead" };
  }

  status(sessionId: string): SessionStatus {
    this.requireInit();
    const stored = this.registry.get(sessionId);
    const live = this.live.get(sessionId);
    return {
      sessionId: stored.sessionId,
      projectId: stored.projectId,
      ownerUserId: stored.ownerUserId,
      workspaceDir: stored.workspaceDir,
      state: stored.state,
      stateDetail: stored.stateDetail,
      shellPid: stored.shellPid,
      isolation: {
        user: currentUsername(),
        netns: this.config.netnsRequired ? "no-egress" : "off",
        prlimit: this.config.limitsRequired,
      },
      lease: live ? { holder: live.lease.holder, expiresAt: live.lease.expiresAt } : null,
      activeOps: live ? [...live.activeOps.keys()] : [],
      stream: live ? live.buffer.stats() : { retainedBytes: 0, frameCount: 0, droppedFrameCount: 0, latestSeq: 0 },
    };
  }

  private toSessionInfo(sessionId: string): SessionInfo {
    const s = this.status(sessionId);
    return {
      sessionId: s.sessionId,
      projectId: s.projectId,
      ownerUserId: s.ownerUserId,
      workspaceDir: s.workspaceDir,
      state: s.state,
      shellPid: s.shellPid,
      isolation: s.isolation,
    };
  }

  /* ---------------- helpers ---------------- */

  private requireInit(): void {
    if (!this.initialized) {
      throw new RuntimeError("RUNTIME_UNAVAILABLE", "Runtime has not been initialized.", 503);
    }
  }

  private requireLive(sessionId: string): LiveSession {
    const live = this.live.get(sessionId);
    if (!live) {
      // Known-but-ended sessions report their stored state honestly via status();
      // live operations on them are unknown to this process.
      throw new RuntimeError("SESSION_UNKNOWN", "Session has no live supervisor in this runtime.", 404);
    }
    return live;
  }

  private resolveCwd(workspaceDir: string, resource: string, operationId: string): string {
    const rel = resource === "" ? "." : normalizeResourcePath(resource, operationId);
    const cwd = path.resolve(workspaceDir, rel);
    const within = cwd === workspaceDir || cwd.startsWith(`${workspaceDir}${path.sep}`);
    if (!within) {
      throw new RuntimeError("CONSTRAINT_VIOLATION", "Exec working directory escapes the session workspace.", 400);
    }
    try {
      if (!fs.statSync(cwd).isDirectory()) {
        throw new RuntimeError("CONSTRAINT_VIOLATION", "Exec working directory is not a directory.", 400);
      }
    } catch (err) {
      if (err instanceof RuntimeError) throw err;
      throw new RuntimeError("CONSTRAINT_VIOLATION", "Exec working directory does not exist.", 400);
    }
    return cwd;
  }

  private checkNetworkCapability(networkNeed: ExecRequest["networkNeed"]): void {
    if (networkNeed === "external") {
      throw new RuntimeError("CONSTRAINT_VIOLATION", "This runtime slice offers no general egress; external exec is refused.", 400);
    }
    if (this.config.netnsRequired && networkNeed !== "none") {
      throw new RuntimeError("CONSTRAINT_VIOLATION", "No-egress sessions cannot provide loopback; declare networkNeed none.", 400);
    }
  }

  private buildArgv(req: ExecRequest): string[] {
    if (req.execMode === "argv") {
      const argv = req.args.argv;
      if (!Array.isArray(argv) || argv.length === 0) {
        throw new RuntimeError("CONSTRAINT_VIOLATION", "argv exec requires a non-empty argv array.", 400);
      }
      if (argv.length > this.config.maxArgvCount) {
        throw new RuntimeError("CONSTRAINT_VIOLATION", `argv exceeds ${this.config.maxArgvCount} entries.`, 400);
      }
      let bytes = 0;
      for (const entry of argv) {
        if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0")) {
          throw new RuntimeError("CONSTRAINT_VIOLATION", "argv entries must be non-empty NUL-free strings.", 400);
        }
        bytes += Buffer.byteLength(entry, "utf8");
      }
      if (bytes > this.config.maxArgvBytes) {
        throw new RuntimeError("CONSTRAINT_VIOLATION", `argv exceeds ${this.config.maxArgvBytes} bytes.`, 400);
      }
      return [...argv];
    }
    const script = req.args.script;
    if (typeof script !== "string" || script.length === 0) {
      throw new RuntimeError("CONSTRAINT_VIOLATION", "shell-script exec requires a non-empty script.", 400);
    }
    if (Buffer.byteLength(script, "utf8") > this.config.maxScriptBytes) {
      throw new RuntimeError("CONSTRAINT_VIOLATION", `script exceeds ${this.config.maxScriptBytes} bytes.`, 400);
    }
    return [this.config.shell, "-c", script];
  }

  private wrapArgv(argv: string[]): string[] {
    let out = [...argv];
    if (this.config.limitsRequired) {
      const c = this.config;
      out = ["prlimit", `--nproc=${c.nprocLimit}`, `--cpu=${c.cpuSecondsLimit}`, `--fsize=${c.fsizeBytesLimit}`, "--", ...out];
    }
    if (this.config.netnsRequired) {
      out = ["unshare", "-U", "-n", "-r", ...out];
    }
    return out;
  }
}

export interface SessionStatus {
  sessionId: string;
  projectId: string;
  ownerUserId: string;
  workspaceDir: string;
  state: SessionRuntimeState;
  stateDetail: string;
  shellPid: number | null;
  isolation: SessionInfo["isolation"];
  lease: { holder: LeaseHolder; expiresAt: number } | null;
  activeOps: string[];
  stream: { retainedBytes: number; frameCount: number; droppedFrameCount: number; latestSeq: number };
}

function buildIsolatedEnv(input: { projectId: string; sessionId: string; home: string; op?: string; term: boolean }): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: input.home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CODERXP_PROJECT: input.projectId,
    CODERXP_SESSION: input.sessionId,
  };
  if (input.op !== undefined) env.CODERXP_OP = input.op;
  if (input.term) env.TERM = "xterm-256color";
  return env;
}

function currentUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEsrch(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ESRCH";
}

/** True when the process group provably cannot exist (never EPERM: owned-by-other means alive). */
function groupCannotExist(err: unknown): boolean {
  if (isEsrch(err)) return true;
  const code = typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;
  return code === "EINVAL" || code === "ERANGE" || code === "ERR_OUT_OF_RANGE";
}

function groupDead(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (err) {
    return groupCannotExist(err);
  }
}

export type { StreamFrame };
