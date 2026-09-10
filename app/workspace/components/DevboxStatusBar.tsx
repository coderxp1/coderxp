"use client";

/**
 * Devbox Status & Control Bar for CoderXP Revision 2.4.
 *
 * Implements Directive §2.4:
 * - Runtime Switcher (WebContainer vs Linux Devbox)
 * - Devbox lifecycle & quota indicators
 * - Kill switches ("Stop Agent" / "Freeze Devbox")
 * - Audit Log & Git Snapshot Rollback inspector
 */

import React, { useState, useEffect } from "react";
import type { DevboxStatus, DevboxAuditRecord, DevboxGitSnapshot } from "@/lib/devbox/types";

export interface DevboxStatusBarProps {
  projectId: string;
  activeRuntime: "webcontainer" | "devbox";
  onRuntimeChange: (runtime: "webcontainer" | "devbox") => void;
}

export function DevboxStatusBar({
  projectId,
  activeRuntime,
  onRuntimeChange,
}: DevboxStatusBarProps) {
  const [status, setStatus] = useState<DevboxStatus | null>(null);
  const [auditLogs, setAuditLogs] = useState<DevboxAuditRecord[]>([]);
  const [gitSnapshots, setGitSnapshots] = useState<DevboxGitSnapshot[]>([]);
  const [isAuditModalOpen, setIsAuditModalOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function fetchStatus() {
      try {
        const res = await fetch(`/api/devbox?projectId=${encodeURIComponent(projectId)}`);
        if (res.ok) {
          const data = await res.json();
          if (mounted) {
            setStatus(data.status);
            setAuditLogs(data.auditLogs || []);
            setGitSnapshots(data.gitSnapshots || []);
          }
        }
      } catch {
        // offline or loading
      }
    }

    fetchStatus();
    const timer = setInterval(fetchStatus, 5000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [projectId]);

  async function handleStopAgent() {
    setActionLoading(true);
    try {
      await fetch("/api/devbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, action: "stop-agent" }),
      });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleFreezeDevbox() {
    setActionLoading(true);
    try {
      await fetch("/api/devbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, action: "freeze" }),
      });
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--bg-side)] border-t border-[var(--border-soft)] text-xs font-sans text-[var(--text-dim)] select-none">
        {/* Left: Runtime Switcher */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-[var(--text-faint)]">Runtime:</span>
          <div className="flex items-center bg-[var(--bg-input)] border border-[var(--border)] rounded p-0.5 text-[11px]">
            <button
              type="button"
              className={`px-2 py-0.5 rounded cursor-pointer transition-colors ${
                activeRuntime === "webcontainer"
                  ? "bg-[var(--accent)] text-white font-medium"
                  : "text-[var(--text-dim)] hover:text-[var(--text)]"
              }`}
              onClick={() => onRuntimeChange("webcontainer")}
            >
              WebContainer
            </button>
            <button
              type="button"
              className={`px-2 py-0.5 rounded cursor-pointer transition-colors flex items-center gap-1 ${
                activeRuntime === "devbox"
                  ? "bg-[var(--accent)] text-white font-medium"
                  : "text-[var(--text-dim)] hover:text-[var(--text)]"
              }`}
              onClick={() => onRuntimeChange("devbox")}
            >
              <span>Linux Devbox</span>
              <span className="px-1 py-0.2 rounded text-[9px] bg-blue-500/20 text-blue-300 font-mono">
                Ubuntu 24
              </span>
            </button>
          </div>

          {/* Devbox Status Indicator */}
          {activeRuntime === "devbox" && (
            <div className="flex items-center gap-1.5 ml-2 text-[11px]">
              <span
                className={`w-2 h-2 rounded-full ${
                  status?.state === "running"
                    ? "bg-emerald-500 animate-pulse"
                    : status?.state === "idle"
                    ? "bg-amber-500"
                    : "bg-zinc-500"
                }`}
              />
              <span className="capitalize font-mono">{status?.state || "Connecting..."}</span>
              {status?.quotaRemainingHours !== undefined && (
                <span className="text-[var(--text-faint)]">
                  ({status.quotaRemainingHours.toFixed(1)}h remaining)
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right: Kill Switches & Audit Controls */}
        <div className="flex items-center gap-2">
          {activeRuntime === "devbox" && (
            <>
              <button
                type="button"
                className="text-[11px] px-2 py-0.5 rounded bg-red-950/40 text-red-300 border border-red-800/40 hover:bg-red-900/60 cursor-pointer flex items-center gap-1"
                title="Immediately terminate running agent process"
                disabled={actionLoading}
                onClick={handleStopAgent}
              >
                <span>Stop Agent</span>
              </button>

              <button
                type="button"
                className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700 hover:bg-zinc-700 cursor-pointer"
                title="Freeze container"
                disabled={actionLoading}
                onClick={handleFreezeDevbox}
              >
                <span>Freeze</span>
              </button>
            </>
          )}

          <button
            type="button"
            className="text-[11px] px-2 py-0.5 rounded border border-[var(--border)] hover:bg-[var(--bg-input)] cursor-pointer text-[var(--text-dim)] hover:text-[var(--text)] flex items-center gap-1"
            onClick={() => setIsAuditModalOpen(true)}
          >
            <span>Activity & Audit ({auditLogs.length})</span>
          </button>
        </div>
      </div>

      {/* Audit Log & Git Snapshot Drawer / Modal */}
      {isAuditModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-2xl w-full max-w-[650px] max-h-[80vh] flex flex-col font-sans text-[var(--text)]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-soft)] bg-[var(--bg-side)]">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <span>Devbox Audit Log & Pre-Push Snapshots</span>
              </h3>
              <button
                type="button"
                className="text-[var(--text-faint)] hover:text-[var(--text)] cursor-pointer p-1"
                onClick={() => setIsAuditModalOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="p-4 overflow-y-auto flex flex-col gap-4 text-xs">
              {/* Git Snapshots */}
              <div>
                <h4 className="font-medium text-[var(--text)] mb-2">Pre-Push Git Snapshots</h4>
                {gitSnapshots.length === 0 ? (
                  <div className="text-[var(--text-faint)] text-[11px] italic">
                    No git push operations recorded yet.
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {gitSnapshots.map((snap) => (
                      <div
                        key={snap.id}
                        className="p-2.5 rounded bg-[var(--bg-input)] border border-[var(--border-soft)] flex items-center justify-between"
                      >
                        <div>
                          <div className="font-mono font-medium text-[var(--accent)]">
                            {snap.branch} ({snap.prePushCommitSha.slice(0, 7)})
                          </div>
                          <div className="text-[10px] text-[var(--text-faint)]">
                            Recorded: {new Date(snap.timestamp).toLocaleTimeString()}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="px-2 py-1 text-[11px] rounded bg-[var(--bg-card)] border border-[var(--border)] hover:border-[var(--accent)] text-[var(--text)] cursor-pointer"
                          onClick={() => navigator.clipboard.writeText(snap.rollbackCommand)}
                        >
                          Copy Rollback Command
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Audit Log Entries */}
              <div>
                <h4 className="font-medium text-[var(--text)] mb-2">Append-Only Command Audit Log</h4>
                {auditLogs.length === 0 ? (
                  <div className="text-[var(--text-faint)] text-[11px] italic">
                    No commands executed yet.
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {auditLogs.map((log) => (
                      <div
                        key={log.id}
                        className="p-2 rounded bg-[var(--bg-input)] border border-[var(--border-soft)] font-mono text-[11px]"
                      >
                        <div className="flex items-center justify-between text-[10px] text-[var(--text-faint)] mb-1">
                          <span>{new Date(log.timestamp).toLocaleTimeString()} · [{log.initiatedBy}]</span>
                          <span className={log.exitCode === 0 ? "text-[var(--ok)]" : "text-[var(--err)]"}>
                            exit {log.exitCode ?? "?"}
                          </span>
                        </div>
                        <div className="text-[var(--text)] font-semibold">
                          $ {log.command} {log.args.join(" ")}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end px-4 py-3 border-t border-[var(--border-soft)] bg-[var(--bg-side)]">
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded border border-[var(--border)] hover:bg-[var(--bg-input)] cursor-pointer"
                onClick={() => setIsAuditModalOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
