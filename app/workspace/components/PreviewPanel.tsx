"use client";

/**
 * Preview panel for CoderXP M2 Workspace Alpha.
 *
 * Commit 5 scope: real live preview using the WebContainer server-ready URL.
 *
 * - Shows the real preview URL from the actual server-ready event
 * - Run / Stop / Refresh controls
 * - Open in new tab where browser policy permits
 * - Empty state before runtime: "Run this project to open a live preview."
 * - No hard-coded fake localhost URLs
 */

import { ExternalLink, RefreshCw, Play, Square } from "lucide-react";
import type { RuntimeState } from "@/lib/workspace/runtime";

interface PreviewPanelProps {
  /** Preview URL from the real server-ready event, or null. */
  previewUrl: string | null;
  /** Current runtime state. */
  runtimeState: RuntimeState;
  /** Whether a Run is in progress. */
  isStarting: boolean;
  /** Whether the runtime is running. */
  isRunning: boolean;
  /** Key to force iframe refresh. */
  previewKey: number;
  /** Called when Run is clicked. */
  onRun: () => void;
  /** Called when Stop is clicked. */
  onStop: () => void;
  /** Called when Refresh is clicked. */
  onRefresh: () => void;
}

export function PreviewPanel({
  previewUrl,
  runtimeState,
  isStarting,
  isRunning,
  previewKey,
  onRun,
  onStop,
  onRefresh,
}: PreviewPanelProps) {
  return (
    <div className="flex flex-col h-full bg-[#0a0b0d]">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-800 bg-gray-900/50">
        <span className="text-xs text-gray-500 uppercase tracking-wide">Preview</span>
        <div className="flex items-center gap-1.5">
          {!isRunning ? (
            <button
              onClick={onRun}
              disabled={isStarting}
              className="flex items-center gap-1 px-2 py-1 text-xs text-cyan-400 hover:text-cyan-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Play className="w-3 h-3" />
              Run
            </button>
          ) : (
            <button
              onClick={onStop}
              className="flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:text-red-300 transition-colors"
            >
              <Square className="w-3 h-3" />
              Stop
            </button>
          )}
          <button
            onClick={onRefresh}
            disabled={!previewUrl}
            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
          {previewUrl && (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              Open
            </a>
          )}
        </div>
      </div>

      {/* Preview content */}
      <div className="flex-1 overflow-hidden">
        {previewUrl ? (
          <iframe
            key={previewKey}
            src={previewUrl}
            title="Live Preview"
            className="w-full h-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-gray-600">
            {isStarting ? (
              <>
                <div className="w-5 h-5 border-2 border-gray-700 border-t-cyan-500 rounded-full animate-spin mb-3" />
                <p className="text-sm capitalize">{runtimeState}...</p>
              </>
            ) : (
              <>
                <p className="text-sm">Run this project to open a live preview.</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
