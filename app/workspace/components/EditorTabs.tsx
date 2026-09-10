"use client";

/**
 * Editor tab bar for CoderXP Workspace v2.
 *
 * 35px height tab bar matching coderxp-workspace-v2.html:
 * - File-type icons
 * - Filename
 * - Dirty indicator dot (mod)
 * - Close button (x)
 * - Active tab with top accent border line and editor background
 */

import React from "react";
import { getEntryName } from "@/lib/workspace/path-utils";

interface EditorTabsProps {
  openTabs: string[];
  activeFile: string | null;
  dirtyPaths: Set<string>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}

function getFileIcon(filename: string) {
  if (filename.endsWith(".html") || filename.endsWith(".htm")) {
    return (
      <svg
        className="fico"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#e5534b"
        strokeWidth="1.6"
        style={{ width: 13, height: 13, flex: "none" }}
      >
        <path d="M4 4l1.5 15L12 21l6.5-2L20 4H4z" />
      </svg>
    );
  }
  if (filename.endsWith(".css") || filename.endsWith(".scss")) {
    return (
      <svg
        className="fico"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#3aa3ff"
        strokeWidth="1.6"
        style={{ width: 13, height: 13, flex: "none" }}
      >
        <path d="M4 4l1.5 15L12 21l6.5-2L20 4H4z" />
      </svg>
    );
  }
  if (filename.endsWith(".js") || filename.endsWith(".ts") || filename.endsWith(".tsx") || filename.endsWith(".jsx")) {
    return (
      <svg
        className="fico"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#e5b567"
        strokeWidth="1.6"
        style={{ width: 13, height: 13, flex: "none" }}
      >
        <rect x="4" y="4" width="16" height="16" rx="2" />
      </svg>
    );
  }
  return (
    <svg
      className="fico"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#8b8f95"
      strokeWidth="1.6"
      style={{ width: 13, height: 13, flex: "none" }}
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

export function EditorTabs({
  openTabs,
  activeFile,
  dirtyPaths,
  onSelect,
  onClose,
}: EditorTabsProps) {
  if (openTabs.length === 0) return null;

  return (
    <div className="tabsbar" role="tablist" aria-label="Editor tabs">
      {openTabs.map((path) => {
        const isActive = path === activeFile;
        const isDirty = dirtyPaths.has(path);
        const name = getEntryName(path);

        return (
          <button
            key={path}
            type="button"
            className={`etab ${isActive ? "active" : ""}`}
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(path)}
          >
            {getFileIcon(name)}
            <span>{name}</span>
            {isDirty && <span className="mod" title="Unsaved changes" />}
            <span
              className="x"
              role="button"
              tabIndex={0}
              aria-label={`Close ${name}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(path);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  onClose(path);
                }
              }}
            >
              ×
            </span>
          </button>
        );
      })}
    </div>
  );
}
