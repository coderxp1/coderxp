/**
 * Agent runtime slice — honest HTTP-facing projections.
 *
 * Status and outcome values pass through unchanged: `unknown` stays
 * `unknown`, null exit codes stay null, and unconfirmed outcomes stay
 * unconfirmed. Output text is byte-capped with the fixed sanitizer (notice
 * inside the budget). Nothing here invents success.
 */

import { truncateAndSanitize } from "../../workspace/agent-sanitizer";
import type { ExecOutcome, SessionRuntimeState, StreamFrame } from "./types";
import type { SessionStatus } from "./provider";

export interface ExecOutcomeView {
  kind: ExecOutcome["kind"];
  exitCode: number | null;
  signal: string | null;
  confirmed: boolean;
  reconciled: boolean;
  outputBytes: number;
  outputTruncated: boolean;
  durationMs: number;
}

export function projectExecOutcome(outcome: ExecOutcome): ExecOutcomeView {
  return {
    kind: outcome.kind,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    confirmed: outcome.confirmed,
    reconciled: outcome.reconciled,
    outputBytes: outcome.outputBytes,
    outputTruncated: outcome.outputTruncated,
    durationMs: outcome.durationMs,
  };
}

export interface SessionStatusView {
  sessionId: string;
  projectId: string;
  state: SessionRuntimeState;
  stateDetail: string;
  isolation: SessionStatus["isolation"];
  lease: SessionStatus["lease"];
  activeOps: string[];
  stream: SessionStatus["stream"];
}

export function projectSessionStatus(status: SessionStatus): SessionStatusView {
  return {
    sessionId: status.sessionId,
    projectId: status.projectId,
    state: status.state,
    stateDetail: status.stateDetail,
    isolation: status.isolation,
    lease: status.lease,
    activeOps: [...status.activeOps],
    stream: { ...status.stream },
  };
}

export interface StreamFrameView {
  seq: number;
  ts: number;
  stream: StreamFrame["stream"];
  data: string;
}

/** Frames are already redacted at the buffer; this only enforces a per-frame byte cap. */
export function projectStreamFrame(frame: StreamFrame, maxBytes = 32 * 1024): StreamFrameView {
  return {
    seq: frame.seq,
    ts: frame.ts,
    stream: frame.stream,
    data: truncateAndSanitize(frame.data, maxBytes),
  };
}
