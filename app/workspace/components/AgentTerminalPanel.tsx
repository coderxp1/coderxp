"use client";

/**
 * Agent terminal panel — the labelled view onto ONE per-agent runtime session.
 *
 * This is deliberately NOT the user's own terminal (see TerminalPanel /
 * DevboxTerminalPanel). It attaches to `/api/runtime/sessions/[id]` and shows
 * the agent's isolated session with:
 *
 *  - session identity (session id, project, owner-derived server state)
 *  - connection state (connecting / attached / reconnecting / detached)
 *  - command activity (active op ids) and observed outcomes
 *  - the control-lease state that separates observation from input authority
 *
 * Honesty rules:
 *  - The stream multiplexes PTY output with structured exec output. Every line
 *    is labelled with its real source; combined output is labelled as combined
 *    and never presented as a single clean stream.
 *  - `unknown` stays `unknown`. An unconfirmed outcome is reported as
 *    unconfirmed, never as "stopped" or "success".
 *  - A retention gap is printed verbatim. We never invent the missing bytes.
 *  - Reconnect replays from the SERVER-ISSUED cursor, so no command re-runs.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  AgentRuntimeClient,
  AgentRuntimeError,
  describeOutcome,
  type AgentExecOutcome,
  type AgentLease,
  type AgentSessionState,
  type AgentStreamFrame,
} from "@/lib/workspace/agent-runtime-client";

type ConnectionState = "idle" | "connecting" | "attached" | "reconnecting" | "detached" | "error";

interface AgentTerminalPanelProps {
  projectId: string;
  active: boolean;
  /** Caller-supplied grant id for grant-backed calls. */
  grantId?: string;
}

const STREAM_LABEL: Record<AgentStreamFrame["stream"], string> = {
  pty: "pty",
  "exec-stdout": "exec:out",
  "exec-stderr": "exec:err",
  control: "control",
  state: "state",
};

const STATE_STYLE: Record<AgentStreamFrame["stream"], string> = {
  pty: "\x1b[0m",
  "exec-stdout": "\x1b[36m",
  "exec-stderr": "\x1b[31m",
  control: "\x1b[35m",
  state: "\x1b[33m",
};

let opCounter = 0;
function nextOpId(prefix: string): string {
  opCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${opCounter}`;
}


export function AgentTerminalPanel({ projectId, active, grantId }: AgentTerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const clientRef = useRef<AgentRuntimeClient | null>(null);
  const disposeRef = useRef<(() => void) | null>(null);
  /** Server-issued cursor. Persisted across reconnects so nothing re-runs. */
  const cursorRef = useRef(0);
  const leaseRef = useRef<AgentLease | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const [conn, setConn] = useState<ConnectionState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [serverState, setServerState] = useState<AgentSessionState | "none">("none");
  const [lease, setLease] = useState<AgentLease | null>(null);
  const [activeOps, setActiveOps] = useState<string[]>([]);
  const [lastOutcome, setLastOutcome] = useState<AgentExecOutcome | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inputEnabled, setInputEnabled] = useState(false);

  const write = useCallback((text: string) => {
    termRef.current?.write(text);
  }, []);

  const writeLabelled = useCallback(
    (frame: AgentStreamFrame) => {
      const label = STREAM_LABEL[frame.stream] ?? frame.stream;
      const reset = "\x1b[0m";
      // Label every line with its true source. PTY output is a combined
      // interleaved stream and is labelled as such.
      const prefix =
        frame.stream === "pty"
          ? `\x1b[2m[combined pty]\x1b[0m `
          : `\x1b[2m[${label} #${frame.seq}]\x1b[0m `;
      write(`${STATE_STYLE[frame.stream] ?? ""}${prefix}${reset}${frame.data.replace(/\n$/, "")}\r\n`);
    },
    [write],
  );

  /* ---------------- terminal lifecycle ---------------- */

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true, // input is lease-gated, see setInputEnabled
      fontSize: 12,
      fontFamily: "'JetBrains Mono', 'Cascadia Mono', monospace",
      theme: { background: "#0b0f14", foreground: "#d7e0ea" },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try {
      fit.fit();
    } catch {
      // Container not laid out yet; ResizeObserver will fit it.
    }
    termRef.current = term;
    fitRef.current = fit;
    term.writeln("\x1b[1mAGENT SESSION TERMINAL\x1b[0m — distinct from the user terminal.");
    term.writeln("Observation and input authority are separate: input needs a control lease.");
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // ignore transient layout errors
      }
    });
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      disposeRef.current?.();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  /* ---------------- session lifecycle ---------------- */

  const attach = useCallback(
    (sid: string, resumeCursor: number) => {
      const client = clientRef.current;
      if (!client) return;
      disposeRef.current?.();
      setConn(resumeCursor > 0 ? "reconnecting" : "connecting");
      disposeRef.current = client.subscribe(
        sid,
        resumeCursor,
        {
          onFrame: (frame) => {
            cursorRef.current = Math.max(cursorRef.current, frame.seq + 1);
            if (frame.stream === "control" && /^op /.test(frame.data)) {
              setActiveOps((prev) => prev.filter((o) => !frame.data.startsWith(`op ${o}:`)));
            }
            writeLabelled(frame);
          },
          onGap: (gap) => {
            // Explicit gap notice, verbatim. Never fabricate the missing bytes.
            setNotice(`Stream gap: seq ${gap.fromSeq}..${gap.toSeq} (${gap.reason})`);
            write(`\r\n\x1b[33m[stream gap] seq ${gap.fromSeq}..${gap.toSeq} lost (${gap.reason}) — not recoverable from this session\x1b[0m\r\n`);
          },
          onState: (st) => {
            cursorRef.current = st.cursor;
            setServerState(st.state);
            setConn("attached");
          },
          onError: (err) => {
            const msg = err instanceof AgentRuntimeError ? `${err.code}: ${err.message}` : String(err);
            setNotice(msg);
            setConn("error");
            write(`\r\n\x1b[31m[stream error] ${msg}\x1b[0m\r\n`);
          },
          onClose: () => {
            setConn((prev) => (prev === "error" ? prev : "detached"));
            setInputEnabled(false);
          },
        },
        nextOpId("attach"),
      );
    },
    [write, writeLabelled],
  );

  const refreshStatus = useCallback(
    async (sid: string) => {
      const client = clientRef.current;
      if (!client) return;
      try {
        const st = await client.status(sid, nextOpId("status"));
        setServerState(st.state);
        setActiveOps(st.activeOps);
        setLease(st.lease);
        leaseRef.current = st.lease;
      } catch (err) {
        const msg = err instanceof AgentRuntimeError ? `${err.code}: ${err.message}` : String(err);
        setNotice(msg);
      }
    },
    [],
  );

  const startSession = useCallback(async () => {
    setNotice(null);
    clientRef.current = new AgentRuntimeClient({ projectId, ...(grantId ? { grantId } : {}) });
    const client = clientRef.current;
    const cols = termRef.current?.cols ?? 80;
    const rows = termRef.current?.rows ?? 24;
    try {
      setConn("connecting");
      const allocated = await client.allocate({
        operationId: nextOpId("alloc"),
        cols,
        rows,
      });
      sessionIdRef.current = allocated.sessionId;
      setSessionId(allocated.sessionId);
      leaseRef.current = allocated.lease;
      setLease(allocated.lease);
      cursorRef.current = 0;
      write(`\r\n\x1b[32m[session]\x1b[0m allocated ${allocated.sessionId} (project ${projectId})\r\n`);
      attach(allocated.sessionId, 0);
      void refreshStatus(allocated.sessionId);
    } catch (err) {
      const msg = err instanceof AgentRuntimeError ? `${err.code}: ${err.message}` : String(err);
      setNotice(msg);
      setConn("error");
      write(`\r\n\x1b[31m[allocate failed] ${msg}\x1b[0m\r\n`);
    }
  }, [attach, grantId, projectId, refreshStatus, write]);

  /* Reconnect by server-issued cursor — never re-runs a command. */
  const reconnect = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) {
      void startSession();
      return;
    }
    write(`\r\n\x1b[2m[reconnect] resuming at server cursor ${cursorRef.current} (no command is re-run)\x1b[0m\r\n`);
    attach(sid, cursorRef.current);
    void refreshStatus(sid);
  }, [attach, refreshStatus, startSession, write]);

  /* ---------------- input authority ---------------- */

  const takeInputLease = useCallback(async () => {
    const sid = sessionIdRef.current;
    const client = clientRef.current;
    if (!sid || !client) return;
    try {
      const { lease: acquired } = await client.acquireLease(sid, "user", false, nextOpId("lease"));
      leaseRef.current = acquired;
      setLease(acquired);
      setInputEnabled(true);
      if (termRef.current) termRef.current.options.disableStdin = false;
      write("\r\n\x1b[32m[input lease acquired]\x1b[0m user input enabled; agent input is paused.\r\n");
    } catch (err) {
      const msg = err instanceof AgentRuntimeError ? `${err.code}: ${err.message}` : String(err);
      setNotice(msg);
      write(`\r\n\x1b[31m[lease refused] ${msg}\x1b[0m\r\n`);
    }
  }, [write]);

  const dropInputLease = useCallback(async () => {
    const sid = sessionIdRef.current;
    const client = clientRef.current;
    if (!sid || !client || !leaseRef.current) return;
    try {
      await client.releaseLease(
        sid,
        { holder: leaseRef.current.holder, token: leaseRef.current.token },
        nextOpId("lease-rel"),
      );
    } catch {
      // Release is best-effort; the lease TTL expires server-side regardless.
    }
    leaseRef.current = null;
    setLease(null);
    setInputEnabled(false);
    if (termRef.current) termRef.current.options.disableStdin = true;
    write("\r\n\x1b[2m[input lease released]\x1b[0m agent input may resume.\r\n");
  }, [write]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const disp = term.onData((data) => {
      const sid = sessionIdRef.current;
      const client = clientRef.current;
      const held = leaseRef.current;
      if (!sid || !client || !held || held.holder !== "user") {
        // Observation-only: keystrokes are refused, not silently dropped.
        term.write("\r\n\x1b[33m[input refused]\x1b[0m no user control lease held.\r\n");
        return;
      }
      void client
        .input(sid, data, { holder: "user", token: held.token }, nextOpId("input"))
        .catch((err: unknown) => {
          const msg = err instanceof AgentRuntimeError ? `${err.code}: ${err.message}` : String(err);
          term.write(`\r\n\x1b[31m[input rejected] ${msg}\x1b[0m\r\n`);
          setInputEnabled(false);
        });
    });
    return () => disp.dispose();
  }, []);

  /* ---------------- process control ---------------- */

  const doResize = useCallback(async () => {
    const sid = sessionIdRef.current;
    const client = clientRef.current;
    if (!sid || !client || !termRef.current) return;
    try {
      fitRef.current?.fit();
      await client.resize(sid, termRef.current.cols, termRef.current.rows, nextOpId("resize"));
    } catch (err) {
      const msg = err instanceof AgentRuntimeError ? `${err.code}: ${err.message}` : String(err);
      setNotice(msg);
    }
  }, []);

  const doInterrupt = useCallback(async () => {
    const sid = sessionIdRef.current;
    const client = clientRef.current;
    if (!sid || !client) return;
    try {
      await client.interrupt(sid, nextOpId("int"));
      write("\r\n\x1b[33m[interrupt]\x1b[0m SIGINT sent to the session's foreground group.\r\n");
    } catch (err) {
      const msg = err instanceof AgentRuntimeError ? `${err.code}: ${err.message}` : String(err);
      setNotice(msg);
    }
  }, [write]);

  const doStop = useCallback(async () => {
    const sid = sessionIdRef.current;
    const client = clientRef.current;
    if (!sid || !client) return;
    try {
      const res = await client.stopSession(sid, nextOpId("stop"));
      // Report the server's own words; do not translate to a friendlier claim.
      write(`\r\n\x1b[33m[stop]\x1b[0m state=${res.state} — ${res.detail}\r\n`);
      setServerState(res.state === "dead" ? "dead" : "unknown");
      setInputEnabled(false);
    } catch (err) {
      const msg = err instanceof AgentRuntimeError ? `${err.code}: ${err.message}` : String(err);
      setNotice(msg);
      // A failed stop is NOT a stopped session.
      setServerState("unknown");
    }
  }, [write]);

  /** Run a structured argv command through the exec path and show its outcome. */
  const runCommand = useCallback(
    async (argv: string[]) => {
      const sid = sessionIdRef.current;
      const client = clientRef.current;
      if (!sid || !client) return;
      const opId = nextOpId("exec");
      setActiveOps((prev) => [...prev, opId]);
      write(`\r\n\x1b[2m[exec ${opId}]\x1b[0m ${argv.join(" ")}\r\n`);
      try {
        const { outcome } = await client.exec(
          sid,
          {
            operationId: opId,
            resource: "",
            args: { argv },
            execMode: "argv",
            networkNeed: "none",
            timeoutMs: 60_000,
          },
        );
        setLastOutcome(outcome);
        write(`\x1b[2m[outcome ${opId}]\x1b[0m ${describeOutcome(outcome)}\r\n`);
      } catch (err) {
        const msg = err instanceof AgentRuntimeError ? `${err.code}: ${err.message}` : String(err);
        setNotice(msg);
        write(`\x1b[31m[exec refused ${opId}]\x1b[0m ${msg}\r\n`);
      } finally {
        setActiveOps((prev) => prev.filter((o) => o !== opId));
        void refreshStatus(sid);
      }
    },
    [refreshStatus, write],
  );

  useEffect(() => {
    if (active) {
      try {
        fitRef.current?.fit();
      } catch {
        // ignore
      }
      termRef.current?.focus();
    }
  }, [active]);

  const stateBadge =
    serverState === "running"
      ? { text: "RUNNING", cls: "ok" }
      : serverState === "dead"
        ? { text: "DEAD", cls: "bad" }
        : serverState === "unknown"
          ? { text: "UNKNOWN", cls: "warn" }
          : { text: "NO SESSION", cls: "muted" };

  return (
    <div className="agent-terminal" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        className="agent-terminal-bar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          flexWrap: "wrap",
        }}
      >
        <strong style={{ letterSpacing: "0.06em" }}>AGENT</strong>
        <span style={{ opacity: 0.7 }}>{sessionId ?? "no session"}</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span style={{ opacity: 0.7 }}>conn: {conn}</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>
          session: <b className={`badge-${stateBadge.cls}`}>{stateBadge.text}</b>
        </span>
        {lease ? (
          <>
            <span style={{ opacity: 0.5 }}>·</span>
            <span>
              lease: <b>{lease.holder}</b>
            </span>
          </>
        ) : null}
        {activeOps.length > 0 ? (
          <>
            <span style={{ opacity: 0.5 }}>·</span>
            <span>active ops: {activeOps.join(", ")}</span>
          </>
        ) : null}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => void startSession()} disabled={conn === "connecting"}>
          {sessionId ? "New session" : "Allocate"}
        </button>
        <button type="button" onClick={reconnect} disabled={!sessionId}>
          Reconnect
        </button>
        <button type="button" onClick={() => void takeInputLease()} disabled={!sessionId || inputEnabled}>
          Take input
        </button>
        <button type="button" onClick={() => void dropInputLease()} disabled={!inputEnabled}>
          Release input
        </button>
        <button type="button" onClick={() => void doResize()} disabled={!sessionId}>
          Resize
        </button>
        <button type="button" onClick={() => void doInterrupt()} disabled={!sessionId}>
          Interrupt
        </button>
        <button type="button" onClick={() => void doStop()} disabled={!sessionId}>
          Stop
        </button>
        <button type="button" onClick={() => void runCommand(["uname", "-a"])} disabled={!sessionId}>
          Probe
        </button>
      </div>

      {notice ? (
        <div
          role="status"
          style={{
            padding: "4px 8px",
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            color: "#ffd479",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          {notice}
        </div>
      ) : null}

      {lastOutcome ? (
        <div
          style={{
            padding: "4px 8px",
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            opacity: 0.85,
            borderBottom: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          last observed outcome: {describeOutcome(lastOutcome)}
        </div>
      ) : null}

      <div ref={containerRef} style={{ flex: 1, minHeight: 120 }} aria-label="Agent session terminal" />
      {!inputEnabled ? (
        <div
          style={{
            padding: "3px 8px",
            fontSize: 10,
            fontFamily: "'JetBrains Mono', monospace",
            opacity: 0.6,
          }}
        >
          observe-only — keystrokes are refused until you hold the user control lease
        </div>
      ) : null}
    </div>
  );
}
