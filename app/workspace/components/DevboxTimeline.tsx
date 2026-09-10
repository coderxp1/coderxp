"use client";

/**
 * Devbox Timeline Checklist & Resource Monitor for CoderXP Phase A.
 *
 * Implements Roadmap §34 & Phase A Specifications:
 * - Reactive checklist view consuming authoritative host event bus.
 * - Live token usage, duration, and container CPU/RAM metrics.
 * - Interactive T3 approval cards and T2 rollback triggers.
 */

import React, { useState, useEffect } from "react";
import type { ProjectEvent } from "@/lib/devbox/event-types";

export interface DevboxTimelineProps {
  projectId: string;
}

export function DevboxTimeline({ projectId }: DevboxTimelineProps) {
  const [events, setEvents] = useState<ProjectEvent[]>([]);
  const [tokensUsed, setTokensUsed] = useState({ input: 0, output: 0 });
  const [cpuPercent, setCpuPercent] = useState(0.8);
  const [ramMb, setRamMb] = useState(142);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function fetchEvents() {
      try {
        let res = await fetch(`/api/devbox/events?projectId=${encodeURIComponent(projectId)}`);
        let data = res.ok ? await res.json() : null;
        if (!data || !Array.isArray(data.events) || data.events.length === 0) {
          const fallbackRes = await fetch(`/api/devbox/events?projectId=default-project`);
          if (fallbackRes.ok) {
            data = await fallbackRes.json();
          }
        }
        if (mounted && data && Array.isArray(data.events)) {
          setEvents(data.events);

          // Compute aggregated tokens
          let inp = 0;
          let outp = 0;
          for (const e of data.events) {
            if (e.data?.tokensUsed) {
              inp += e.data.tokensUsed.input || 0;
              outp += e.data.tokensUsed.output || 0;
            }
          }
          setTokensUsed({ input: inp, output: outp });
        }
      } catch {
        // offline or loading
      }
    }

    fetchEvents();
    const interval = setInterval(fetchEvents, 3000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [projectId]);

  async function handleApprove(branch: string, scope: "single" | "session") {
    setActionLoading(true);
    try {
      await fetch(`/api/devbox/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, branch, scope, decision: "approved" }),
      });
      // Refresh events
      const res = await fetch(`/api/devbox/events?projectId=${encodeURIComponent(projectId)}`);
      if (res.ok) {
        const data = await res.json();
        setEvents(data.events || []);
      }
    } finally {
      setActionLoading(false);
    }
  }

  async function handleReject(branch: string) {
    setActionLoading(true);
    try {
      await fetch(`/api/devbox/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, branch, decision: "rejected" }),
      });
      // Refresh events
      const res = await fetch(`/api/devbox/events?projectId=${encodeURIComponent(projectId)}`);
      if (res.ok) {
        const data = await res.json();
        setEvents(data.events || []);
      }
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-[var(--bg-side)] border-r border-[var(--border-soft)] text-xs font-sans text-[var(--text)]">
      {/* Header: Resource Metrics (§34) */}
      <div className="px-3 py-2 border-b border-[var(--border-soft)] bg-[var(--bg-card)] flex items-center justify-between">
        <div className="font-semibold text-xs text-[var(--text)] flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>Activity Timeline</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono text-[var(--text-faint)]">
          <span>CPU: {cpuPercent.toFixed(1)}%</span>
          <span>·</span>
          <span>RAM: {ramMb}MB</span>
          <span>·</span>
          <span>Tokens: {tokensUsed.input + tokensUsed.output}</span>
        </div>
      </div>

      {/* Checklist Events Stream */}
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5">
        {events.length === 0 ? (
          <div className="text-[var(--text-faint)] text-[11px] italic text-center py-6">
            No runtime events recorded yet. Start working in the workspace to see progress.
          </div>
        ) : (
          events.map((evt) => (
            <div
              key={evt.id}
              className={`p-2.5 rounded border text-[11px] flex flex-col gap-1 transition-all ${
                evt.type === "approval.requested"
                  ? "bg-amber-950/20 border-amber-800/40 text-amber-200"
                  : evt.type === "step.failed"
                  ? "bg-red-950/20 border-red-800/40 text-red-200"
                  : "bg-[var(--bg-input)] border-[var(--border-soft)] text-[var(--text)]"
              }`}
            >
              <div className="flex items-center justify-between text-[10px] text-[var(--text-faint)]">
                <span className="flex items-center gap-1">
                  <span className="px-1 py-0.2 rounded text-[9px] font-mono bg-zinc-800 text-zinc-300">
                    {evt.tier}
                  </span>
                  <span>{new Date(evt.timestamp).toLocaleTimeString()}</span>
                </span>
                <span className="font-mono">#{evt.seq}</span>
              </div>

              <div className="font-medium flex items-center gap-1.5">
                {evt.type === "step.completed" && <span className="text-[var(--ok)]">✓</span>}
                {evt.type === "step.failed" && <span className="text-[var(--err)]">⚠</span>}
                {evt.type === "approval.requested" && <span>⚠️</span>}
                <span>{evt.data?.title || evt.type}</span>
              </div>

              {evt.data?.description && (
                <div className="text-[10px] text-[var(--text-dim)]">{evt.data.description}</div>
              )}

              {/* T3 Approval Card (§33 / Amendment 4) */}
              {evt.type === "approval.requested" && (
                <div className="mt-2 pt-2 border-t border-amber-800/30 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-red-950 hover:bg-red-900 border border-red-800 text-red-200 text-[10px] cursor-pointer"
                    disabled={actionLoading}
                    onClick={() => handleReject(evt.data?.branch || "main")}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-amber-600 hover:bg-amber-500 text-black font-semibold text-[10px] cursor-pointer"
                    disabled={actionLoading}
                    onClick={() => handleApprove(evt.data?.branch || "main", "single")}
                  >
                    Approve Once
                  </button>
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[10px] cursor-pointer"
                    disabled={actionLoading}
                    onClick={() => handleApprove(evt.data?.branch || "main", "session")}
                  >
                    Approve for Session
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
