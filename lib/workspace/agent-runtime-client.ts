/**
 * Browser client for the agent shell/session runtime (`/api/runtime/*`).
 *
 * Honesty rules enforced client-side:
 * - The server issues the stream cursor. This client only echoes it back, so a
 *   reconnect resumes the SAME surviving session and never re-runs a command.
 * - Retention is bounded server-side; an eviction arrives as an explicit gap
 *   notice and is surfaced verbatim. It is never silently papered over.
 * - `unknown` state and unconfirmed outcomes are passed through unchanged. The
 *   UI must not upgrade them to "stopped" or "success".
 * - Observation (attach/stream) is independent of input authority. Writing
 *   requires a lease token; a lease held by `user` pauses agent input.
 */

export type AgentStreamKind = "pty" | "exec-stdout" | "exec-stderr" | "control" | "state";

export interface AgentStreamFrame {
  seq: number;
  ts: number;
  stream: AgentStreamKind;
  /** Already redacted server-side before it reached the buffer. */
  data: string;
}

export interface AgentStreamGap {
  fromSeq: number;
  toSeq: number;
  reason: "retention-evicted" | "retention-overflow";
}

export type AgentSessionState = "running" | "dead" | "unknown";

export interface AgentLease {
  holder: "agent" | "user";
  token: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface AgentSessionStatus {
  sessionId: string;
  projectId: string;
  state: AgentSessionState;
  stateDetail: string;
  isolation: {
    user?: string;
    netns?: string;
    prlimit?: boolean;
  };
  lease: AgentLease | null;
  activeOps: string[];
  stream: {
    oldestSeq: number;
    newestSeq: number;
    retainedFrames: number;
    droppedFrames: number;
  };
}

export interface AgentExecOutcome {
  kind: "completed" | "signaled" | "timeout" | "cancelled" | "failed-to-start" | "unknown";
  exitCode: number | null;
  signal: string | null;
  confirmed: boolean;
  reconciled: boolean;
  outputBytes: number;
  outputTruncated: boolean;
  durationMs: number;
}

export class AgentRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}

/**
 * Renders an exec outcome exactly as observed. Never upgrades uncertainty:
 * `unknown` stays `unknown`, a null exit code stays "exit unknown", and an
 * unconfirmed outcome is labelled unconfirmed rather than "stopped".
 */
export function describeOutcome(outcome: AgentExecOutcome): string {
  const exit = outcome.exitCode === null ? "exit unknown" : `exit ${outcome.exitCode}`;
  const sig = outcome.signal ? ` signal ${outcome.signal}` : "";
  const confirm = outcome.confirmed ? "" : " [UNCONFIRMED — supervisor lost contact]";
  const replay = outcome.reconciled ? " [reconciled from ledger, not re-run]" : "";
  const trunc = outcome.outputTruncated ? " [output truncated]" : "";
  return `${outcome.kind}: ${exit}${sig}${confirm}${replay}${trunc} (${outcome.durationMs}ms)`;
}

export interface AgentRuntimeClientOptions {
  projectId: string;
  /** Optional credential forwarded as a header for grant-backed calls. */
  grantId?: string;
}

async function unwrap<T>(res: Response): Promise<T> {
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const obj = (parsed ?? {}) as { error?: unknown; message?: unknown };
    throw new AgentRuntimeError(
      typeof obj.error === "string" ? obj.error : `HTTP_${res.status}`,
      typeof obj.message === "string" ? obj.message : res.statusText || "Request failed.",
      res.status,
    );
  }
  return parsed as T;
}

export class AgentRuntimeClient {
  constructor(private readonly opts: AgentRuntimeClientOptions) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.opts.grantId ? { "x-coderxp-grant": this.opts.grantId } : {}),
      ...extra,
    };
  }

  private base(sessionId: string): string {
    return `/api/runtime/sessions/${encodeURIComponent(sessionId)}`;
  }

  async allocate(input: {
    operationId: string;
    agentSessionId?: string;
    cols: number;
    rows: number;
  }): Promise<{ sessionId: string; lease: AgentLease }> {
    const res = await fetch("/api/runtime/sessions", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ projectId: this.opts.projectId, ...input }),
    });
    return unwrap(res);
  }

  async status(sessionId: string, operationId: string): Promise<AgentSessionStatus> {
    const qs = new URLSearchParams({ operationId });
    const res = await fetch(`${this.base(sessionId)}/status?${qs.toString()}`, {
      headers: this.headers(),
    });
    const body = await unwrap<{ status: AgentSessionStatus }>(res);
    return body.status;
  }

  async exec(
    sessionId: string,
    input: {
      operationId: string;
      resource: string;
      args: { argv?: string[]; script?: string };
      execMode: "argv" | "shell-script";
      networkNeed: "none" | "loopback" | "external";
      timeoutMs: number;
    },
    creds?: { approval?: string },
  ): Promise<{ outcome: AgentExecOutcome }> {
    const res = await fetch(`${this.base(sessionId)}/exec`, {
      method: "POST",
      headers: this.headers(creds?.approval ? { "x-coderxp-approval": creds.approval } : undefined),
      body: JSON.stringify(input),
    });
    return unwrap(res);
  }

  /** Bounded one-shot replay from a server cursor (no live subscription). */
  async attach(
    sessionId: string,
    cursor: number,
    operationId: string,
  ): Promise<{ frames: AgentStreamFrame[]; nextCursor: number; gap: AgentStreamGap | null; state: AgentSessionState }> {
    const qs = new URLSearchParams({ cursor: String(cursor), operationId });
    const res = await fetch(`${this.base(sessionId)}/stream?${qs.toString()}`, {
      headers: this.headers(),
    });
    return unwrap(res);
  }

  /**
   * Live SSE subscription resuming at `cursor`. Returns a disposer. The caller
   * owns the cursor: `onState` reports the server-issued cursor to persist.
   */
  subscribe(
    sessionId: string,
    cursor: number,
    handlers: {
      onFrame: (frame: AgentStreamFrame) => void;
      onGap: (gap: AgentStreamGap) => void;
      onState: (state: { state: AgentSessionState; cursor: number }) => void;
      onError: (err: unknown) => void;
      onClose: () => void;
    },
    operationId: string,
    signal?: AbortSignal,
  ): () => void {
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const qs = new URLSearchParams({ cursor: String(cursor), live: "1", operationId });
    void (async () => {
      try {
        const res = await fetch(`${this.base(sessionId)}/stream?${qs.toString()}`, {
          headers: this.headers(),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const err = await unwrap<never>(res).catch(() => new AgentRuntimeError(`HTTP_${res.status}`, "Stream unavailable.", res.status));
          handlers.onError(err);
          handlers.onClose();
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // Backpressure: we read only as fast as we drain, and we never buffer
        // unboundedly — a slow consumer naturally stalls the reader.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep = buffer.indexOf("\n\n");
          while (sep !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            sep = buffer.indexOf("\n\n");
            dispatchSse(raw, handlers);
          }
        }
        handlers.onClose();
      } catch (err) {
        if (controller.signal.aborted) {
          handlers.onClose();
          return;
        }
        handlers.onError(err);
        handlers.onClose();
      }
    })();
    return () => controller.abort();
  }

  async input(
    sessionId: string,
    data: string,
    lease: { holder: "agent" | "user"; token: string },
    operationId: string,
  ): Promise<{ acceptedBytes: number }> {
    const res = await fetch(`${this.base(sessionId)}/input`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ operationId, data, lease }),
    });
    return unwrap(res);
  }

  private async control(sessionId: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.base(sessionId)}/control`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return unwrap(res);
  }

  resize(sessionId: string, cols: number, rows: number, operationId: string): Promise<unknown> {
    return this.control(sessionId, { op: "resize", cols, rows, operationId });
  }

  interrupt(sessionId: string, operationId: string): Promise<unknown> {
    return this.control(sessionId, { op: "interrupt", operationId });
  }

  acquireLease(
    sessionId: string,
    holder: "agent" | "user",
    takeover: boolean,
    operationId: string,
  ): Promise<{ lease: AgentLease }> {
    return this.control(sessionId, { op: "lease-acquire", holder, takeover, operationId }) as Promise<{
      lease: AgentLease;
    }>;
  }

  releaseLease(
    sessionId: string,
    lease: { holder: "agent" | "user"; token: string },
    operationId: string,
  ): Promise<unknown> {
    return this.control(sessionId, { op: "lease-release", lease, operationId });
  }

  cancelOp(
    sessionId: string,
    targetOperationId: string,
    operationId: string,
  ): Promise<{ cancelled: boolean; outcome: AgentExecOutcome | null }> {
    return this.control(sessionId, { op: "cancel", targetOperationId, operationId }) as Promise<{
      cancelled: boolean;
      outcome: AgentExecOutcome | null;
    }>;
  }

  stopSession(sessionId: string, operationId: string): Promise<{ state: string; detail: string }> {
    return this.control(sessionId, { op: "stop", operationId }) as Promise<{ state: string; detail: string }>;
  }
}

/** Exported for tests: parses one raw SSE record into a typed callback. */
export function dispatchSse(
  raw: string,
  handlers: {
    onFrame: (frame: AgentStreamFrame) => void;
    onGap: (gap: AgentStreamGap) => void;
    onState: (state: { state: AgentSessionState; cursor: number }) => void;
    onError: (err: unknown) => void;
  },
): void {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // heartbeat / comment
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
  }
  if (dataLines.length === 0) return;
  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }
  if (event === "frame") handlers.onFrame(payload as AgentStreamFrame);
  else if (event === "gap") handlers.onGap(payload as AgentStreamGap);
  else if (event === "state") handlers.onState(payload as { state: AgentSessionState; cursor: number });
}
