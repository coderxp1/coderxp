"use client";

/**
 * Error banner for CoderXP M2 Workspace Alpha.
 *
 * Displays typed persistence errors with a retry action.
 * Does not expose stack traces, browser internals, file contents, or secrets.
 *
 * Final correction scope:
 * - Uses controlled messages for all displayed codes and a generic fallback.
 * - Accepts a retrying prop to disable Retry while a retry is in flight.
 * - Accepts a retryAction presence check: do not render a functional-looking
 *   Retry button when there is no action.
 * - Dismiss is disabled while retrying.
 */

import { AlertTriangle, RotateCcw, X } from "lucide-react";
import type { WorkspaceError } from "../hooks/useWorkspaceState";

const ERROR_MESSAGES: Record<string, string> = {
  PERSISTENCE_UNAVAILABLE: "Local storage is not available in this browser. Project management requires IndexedDB.",
  DATABASE_OPEN_FAILED: "The local database could not be opened. It may be blocked by another tab.",
  QUOTA_EXCEEDED: "Storage quota exceeded. Remove unused projects to free space.",
  TRANSACTION_FAILED: "An unexpected local operation failed. Please try again.",
  PROJECT_NOT_FOUND: "The requested project was not found.",
  ENTRY_NOT_FOUND: "The requested file or directory was not found.",
  ENTRY_CONFLICT: "A file or directory with that path already exists.",
  REVISION_CONFLICT: "The project was modified by another operation. Please refresh.",
  INVALID_PROJECT_NAME: "The project name is invalid. Use 1 to 100 characters.",
  INVALID_PATH: "The file path is invalid.",
  INVALID_ENTRY: "The file or directory entry is invalid.",
  TEMPLATE_UNAVAILABLE: "This template is not available for project creation.",
};

/** Generic fallback message: never use error.message from an untrusted object. */
const GENERIC_FALLBACK_MESSAGE = "An unexpected local operation failed. Please try again.";

interface ErrorBannerProps {
  error: WorkspaceError;
  onRetry: () => void;
  retrying?: boolean;
  onDismiss?: () => void;
}

export function ErrorBanner({ error, onRetry, retrying, onDismiss }: ErrorBannerProps) {
  // Always use controlled messages: never error.message from an untrusted object.
  const message = ERROR_MESSAGES[error.code] ?? GENERIC_FALLBACK_MESSAGE;

  return (
    <div className="flex flex-col items-center justify-center space-y-4 p-6">
      <div className="flex items-center gap-3 text-amber-400">
        <AlertTriangle className="w-6 h-6" />
        <span className="text-sm font-medium">Something went wrong</span>
      </div>
      <p className="text-sm text-gray-400 max-w-md text-center">{message}</p>
      <div className="flex items-center gap-3">
        <button
          onClick={onRetry}
          disabled={retrying}
          className="flex items-center gap-2 px-4 py-2 text-sm text-cyan-400 border border-cyan-800 rounded-md hover:bg-cyan-950/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RotateCcw className="w-4 h-4" />
          {retrying ? "Retrying..." : "Retry"}
        </button>
        {onDismiss && (
          <button
            onClick={onDismiss}
            disabled={retrying}
            className="flex items-center gap-2 px-4 py-2 text-sm text-gray-400 border border-gray-700 rounded-md hover:bg-gray-800/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <X className="w-4 h-4" />
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
