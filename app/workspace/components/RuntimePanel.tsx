"use client";

/**
 * Bottom panel for CoderXP Workspace v2.
 *
 * 42vh resizable panel with tabs:
 * - PROBLEMS (with count badge)
 * - OUTPUT (runtime / sync / agent execution logs)
 * - TERMINAL (live xterm.js WebContainer shell)
 * - PORTS (active ports and Open Preview actions)
 *
 * Right-side action buttons: New terminal, Split, Kill, Maximize.
 */

import React, { useState, useCallback } from "react";
import { TerminalPanel } from "./TerminalPanel";
import { DevboxTerminalPanel } from "./DevboxTerminalPanel";
import type { OutputLine } from "@/lib/workspace/runtime";

export type BottomPanelTab = "problems" | "output" | "terminal" | "ports";

interface RuntimePanelProps {
  output: OutputLine[];
  previewUrl: string | null;
  activePort?: number | null;
  projectId?: string;
  useDevbox?: boolean;
  onOpenPreview?: () => void;
  onKillTerminal?: () => void;
  onNewTerminal?: () => void;
  isMaximized?: boolean;
  onToggleMaximize?: () => void;
}

export function RuntimePanel({
  output,
  previewUrl,
  activePort = 3000,
  projectId = "default-project",
  useDevbox = true,
  onOpenPreview,
  onKillTerminal,
  onNewTerminal,
  isMaximized = false,
  onToggleMaximize,
}: RuntimePanelProps) {
  const [activeTab, setActiveTab] = useState<BottomPanelTab>("terminal");

  const handleOpenPreview = useCallback(() => {
    if (onOpenPreview) {
      onOpenPreview();
    } else if (previewUrl) {
      window.open(previewUrl, "_blank");
    }
  }, [onOpenPreview, previewUrl]);

  return (
    <section className="panel" id="panel" aria-label="Bottom Panel">
      {/* Panel Tab Bar (32px) */}
      <div className="panel-tabs" role="tablist" aria-label="Panel tabs">
        <button
          className={`ptab ${activeTab === "problems" ? "active" : ""}`}
          role="tab"
          aria-selected={activeTab === "problems"}
          onClick={() => setActiveTab("problems")}
        >
          PROBLEMS <span className="count">0</span>
        </button>
        <button
          className={`ptab ${activeTab === "output" ? "active" : ""}`}
          role="tab"
          aria-selected={activeTab === "output"}
          onClick={() => setActiveTab("output")}
        >
          OUTPUT
        </button>
        <button
          className={`ptab ${activeTab === "terminal" ? "active" : ""}`}
          role="tab"
          aria-selected={activeTab === "terminal"}
          onClick={() => setActiveTab("terminal")}
        >
          TERMINAL
        </button>
        <button
          className={`ptab ${activeTab === "ports" ? "active" : ""}`}
          role="tab"
          aria-selected={activeTab === "ports"}
          onClick={() => setActiveTab("ports")}
        >
          PORTS <span className="count">{activePort ? 1 : 0}</span>
        </button>

        <span className="grow" />

        {/* Right-side Action Buttons */}
        <div className="panel-actions">
          <button
            className="icon-btn"
            title="New terminal"
            aria-label="New terminal"
            type="button"
            onClick={onNewTerminal}
          >
            <svg viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            className="icon-btn"
            title="Split terminal"
            aria-label="Split terminal"
            type="button"
          >
            <svg viewBox="0 0 24 24">
              <rect x="4" y="5" width="16" height="14" rx="1.5" />
              <path d="M12 5v14" />
            </svg>
          </button>
          <button
            className="icon-btn"
            title="Kill terminal"
            aria-label="Kill terminal"
            type="button"
            onClick={onKillTerminal}
          >
            <svg viewBox="0 0 24 24">
              <rect x="5" y="5" width="14" height="14" rx="2" />
              <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
            </svg>
          </button>
          <button
            className="icon-btn"
            title={isMaximized ? "Restore panel" : "Maximize panel"}
            aria-label={isMaximized ? "Restore panel" : "Maximize panel"}
            type="button"
            onClick={onToggleMaximize}
          >
            <svg viewBox="0 0 24 24">
              {isMaximized ? (
                <path d="M7 10l5 5 5-5" />
              ) : (
                <path d="M7 14l5-5 5 5" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* PROBLEMS Pane */}
      <div
        className={`panel-body ${activeTab === "problems" ? "active" : ""}`}
        data-pane="problems"
      >
        <div className="empty-state">No problems detected in the workspace.</div>
      </div>

      {/* OUTPUT Pane */}
      <div
        className={`panel-body ${activeTab === "output" ? "active" : ""}`}
        data-pane="output"
      >
        <div className="term">
          <div className="dim">
            [{new Date().toLocaleTimeString()}] WebContainer runtime booted (node v20)
          </div>
          <div className="dim">
            [{new Date().toLocaleTimeString()}] Project files mounted · file sync ready
          </div>
          {output.map((line) => (
            <div key={line.id} className="ok">
              {line.text}
            </div>
          ))}
        </div>
      </div>

      {/* TERMINAL Pane */}
      <div
        className={`panel-body ${activeTab === "terminal" ? "active" : ""}`}
        data-pane="terminal"
        style={{ height: "100%", overflow: "hidden" }}
      >
        {useDevbox ? (
          <DevboxTerminalPanel projectId={projectId} active={activeTab === "terminal"} />
        ) : (
          <TerminalPanel active={activeTab === "terminal"} />
        )}
      </div>

      {/* PORTS Pane */}
      <div
        className={`panel-body ${activeTab === "ports" ? "active" : ""}`}
        data-pane="ports"
      >
        {activePort ? (
          <div className="ports-row">
            <span className="pill">RUNNING</span>
            <span>
              Port <b>{activePort}</b>
            </span>
            <span className="dim">·</span>
            <button
              className="link"
              type="button"
              onClick={handleOpenPreview}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              Open preview
            </button>
            <span className="dim">·</span>
            <span className="dim">Started in workspace runtime (active)</span>
          </div>
        ) : (
          <div className="empty-state">No active ports listening.</div>
        )}
      </div>
    </section>
  );
}
