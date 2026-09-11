/**
 * Agent runtime slice — bounded redacting stream buffer.
 *
 * Every byte is redacted BEFORE it is stored or emitted: exact extra
 * secrets (e.g. per-session synthetic values) are scrubbed with a
 * carry-over tail so secrets split across chunk boundaries never leak,
 * then the shared StreamingRedactor withholds trailing secret-prefix
 * candidates and applies the base secret patterns.
 *
 * Retention is bounded (bytes + frames). Evicted ranges are reported as
 * explicit gaps on read; reconnect-by-cursor never silently skips output
 * and never replays evicted frames as new.
 */

import { StreamingRedactor } from "../../workspace/agent-process-stream";
import type { StreamFrame, StreamGap, StreamKind } from "./types";

export const REDACTED_MARKER = "[REDACTED]";

/**
 * Exact-secret stream scrubber with carry-over. Holds back enough trailing
 * input that a secret spanning a chunk boundary (including a partial-secret
 * prefix at the head/tail split) is never emitted unscrubbed.
 */
export class ExactSecretStreamRedactor {
  private readonly secrets: string[];
  private readonly tailKeep: number;
  private tail = "";

  constructor(secrets: string[]) {
    this.secrets = [...new Set((secrets ?? []).filter((s) => typeof s === "string" && s.length > 0))];
    const longest = this.secrets.reduce((m, s) => Math.max(m, s.length), 0);
    this.tailKeep = Math.max(0, longest - 1);
  }

  push(chunk: string): string {
    if (!chunk || typeof chunk !== "string") return "";
    const combined = this.tail + chunk;
    this.tail = "";
    if (this.secrets.length === 0) return combined;
    if (combined.length <= this.tailKeep) {
      this.tail = combined;
      return "";
    }
    // Move the split point earlier until the emitted head neither ends
    // inside a secret occurrence nor ends with a proper secret prefix.
    // Only over-holds (delays emission); never emits a completable fragment.
    let holdFrom = combined.length - this.tailKeep;
    while (holdFrom > 0 && this.splitViolates(combined, holdFrom)) holdFrom -= 1;
    const head = combined.slice(0, holdFrom);
    this.tail = combined.slice(holdFrom);
    return this.scrub(head);
  }

  private splitViolates(combined: string, holdFrom: number): boolean {
    const head = combined.slice(0, holdFrom);
    for (const secret of this.secrets) {
      let idx = combined.indexOf(secret);
      while (idx !== -1) {
        if (idx < holdFrom && holdFrom < idx + secret.length) return true;
        idx = combined.indexOf(secret, idx + 1);
      }
      const maxLen = Math.min(secret.length - 1, head.length);
      for (let len = maxLen; len >= 1; len--) {
        if (head.endsWith(secret.slice(0, len))) return true;
      }
    }
    return false;
  }

  flush(): string {
    const rest = this.tail;
    this.tail = "";
    return this.scrub(rest);
  }

  private scrub(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED_MARKER);
    }
    return out;
  }
}

export interface StreamRedactor {
  push(chunk: string): string;
  flush(): string;
}

/**
 * Composed redactor: exact extra secrets first (with carry-over), then the
 * shared streaming redactor (secret-prefix withholding + base patterns via
 * sanitizeString). Single sink path for every stored or emitted byte.
 */
export function createStreamRedactor(extraSecrets: string[] = []): StreamRedactor {
  const exact = new ExactSecretStreamRedactor(extraSecrets);
  const streaming = new StreamingRedactor();
  return {
    push(chunk: string): string {
      return streaming.processChunk(exact.push(chunk));
    },
    flush(): string {
      const rest = exact.flush();
      return (rest ? streaming.processChunk(rest) : "") + streaming.flush();
    },
  };
}

export interface StreamBufferOptions {
  maxRetainedBytes: number;
  maxFrames: number;
  now?: () => number;
}

export interface StreamReadResult {
  frames: StreamFrame[];
  nextCursor: number;
  gap: StreamGap | null;
}

export class StreamBuffer {
  private readonly frames: StreamFrame[] = [];
  private readonly now: () => number;
  private readonly subscribers = new Set<(frame: StreamFrame) => void>();
  private nextSeq = 1;
  private retainedBytes = 0;
  private evictedThroughSeq = 0;
  private droppedFrameCount = 0;

  constructor(
    private readonly redact: StreamRedactor,
    private readonly opts: StreamBufferOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Redacts, labels, stores, and enforces retention. */
  append(stream: StreamKind, data: string): void {
    const safe = this.redact.push(data ?? "");
    if (!safe) return;
    this.store(stream, safe);
  }

  /** Flushes redactor tails (exec end / session end) as one frame when non-empty. */
  flush(stream: StreamKind): void {
    const rest = this.redact.flush();
    if (rest) this.store(stream, rest);
  }

  /** Live subscription (SSE). Receives already-redacted frames only. Returns an unsubscribe function. */
  subscribe(cb: (frame: StreamFrame) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  private store(stream: StreamKind, data: string): void {
    const frame: StreamFrame = { seq: this.nextSeq++, ts: this.now(), stream, data };
    this.frames.push(frame);
    this.retainedBytes += Buffer.byteLength(data, "utf8");
    for (const cb of this.subscribers) {
      try {
        cb(frame);
      } catch {
        // A failing subscriber must not break the stream for others.
      }
    }
    while (
      (this.retainedBytes > this.opts.maxRetainedBytes || this.frames.length > this.opts.maxFrames) &&
      this.frames.length > 0
    ) {
      const evicted = this.frames.shift();
      if (!evicted) break;
      this.retainedBytes -= Buffer.byteLength(evicted.data, "utf8");
      this.evictedThroughSeq = evicted.seq;
      this.droppedFrameCount += 1;
    }
    if (this.retainedBytes < 0) this.retainedBytes = 0;
  }

  /**
   * Reads frames after `cursor` (cursor = last seen seq; 0 = from start).
   * Reports an explicit gap when retention evicted frames the cursor covers.
   */
  read(cursor: number): StreamReadResult {
    const at = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
    const frames = this.frames.filter((f) => f.seq > Math.max(at, this.evictedThroughSeq));
    const latest = this.frames.length > 0 ? this.frames[this.frames.length - 1].seq : 0;
    const gap: StreamGap | null =
      at < this.evictedThroughSeq
        ? { fromSeq: at + 1, toSeq: this.evictedThroughSeq, reason: "retention-evicted" }
        : null;
    const nextCursor = frames.length > 0 ? frames[frames.length - 1].seq : Math.max(at, latest);
    return { frames, nextCursor, gap };
  }

  stats(): { retainedBytes: number; frameCount: number; droppedFrameCount: number; latestSeq: number } {
    return {
      retainedBytes: this.retainedBytes,
      frameCount: this.frames.length,
      droppedFrameCount: this.droppedFrameCount,
      latestSeq: this.nextSeq - 1,
    };
  }
}
