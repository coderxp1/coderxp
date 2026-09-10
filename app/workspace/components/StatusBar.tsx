"use client";

/**
 * Status bar component for CoderXP Workspace v2.
 *
 * 22px full-width status bar row with VS Code-class styling (--status-bg).
 * Shows Git branch, problem count, WebContainer running status, sync status,
 * active AI model, active port, cursor position, and language mode.
 */

import React from "react";

export interface StatusBarProps {
  branch?: string;
  problemCount?: number;
  warningCount?: number;
  runtimeStatus?: string;
  syncStatus?: "Saved" | "Saving…" | "Offline";
  modelName?: string;
  activePort?: number | null;
  cursorLine?: number;
  cursorCol?: number;
  language?: string;
}

export function StatusBar({
  branch = "main",
  problemCount = 0,
  warningCount = 0,
  runtimeStatus = "Running",
  syncStatus = "Saved",
  modelName = "logicc/azure/gpt-4o",
  activePort = 3000,
  cursorLine = 1,
  cursorCol = 1,
  language = "HTML",
}: StatusBarProps) {
  return (
    <footer className="statusbar" role="status" aria-label="Status bar">
      <span className="sb-item" title={`Git branch: ${branch}`}>
        <svg viewBox="0 0 24 24">
          <circle cx="7" cy="7" r="2" />
          <circle cx="7" cy="17" r="2" />
          <circle cx="17" cy="10" r="2" />
          <path d="M7 9v6M17 12c0 2.5-3 3.4-8 3.7" />
        </svg>
        {branch}
      </span>
      <span
        className="sb-item"
        title={`${problemCount} Errors, ${warningCount} Warnings`}
      >
        ⊘ {problemCount} ⚠ {warningCount}
      </span>
      <span className="sb-item">
        <span className="sb-dot" /> WebContainer: {runtimeStatus}
      </span>
      <span className="sb-item">
        <span className="sb-dot" /> Sync: {syncStatus}
      </span>
      <span className="sb-spacer" />
      <span className="sb-item" id="sbModel" title="Active AI model">
        Agent: Ready · {modelName}
      </span>
      {activePort && (
        <span className="sb-item" title={`Port ${activePort} active`}>
          Port {activePort}
        </span>
      )}
      <span className="sb-item">
        Ln {cursorLine}, Col {cursorCol}
      </span>
      <span className="sb-item">{language}</span>
    </footer>
  );
}
