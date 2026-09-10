/**
 * Workspace type definitions for CoderXP M2 Workspace Alpha.
 *
 * These types define the core domain model for the workspace:
 * projects, files, templates, and runtime state.
 *
 * Commit 1 scope: type definitions only. No persistence, runtime,
 * or template implementation.
 */

/** Supported project template identifiers. */
export type ProjectTemplateId =
  | "react-ts"
  | "nextjs-ts"
  | "static-html";

/** Whether a stored entry is a file or a directory. */
export type WorkspaceEntryKind = "file" | "directory";

/** A single file or directory entry stored in IndexedDB. */
export interface WorkspaceFileRecord {
  /** Project UUID this entry belongs to. */
  projectId: string;
  /** Normalized path relative to project root, e.g. "src/App.tsx". */
  path: string;
  /** Whether this entry is a file or a directory. */
  kind: WorkspaceEntryKind;
  /** File contents (UTF-8 text). Directories must not have contents. */
  contents?: string;
  /** Unix timestamp (ms) of creation. */
  createdAt: number;
  /** Unix timestamp (ms) of last modification. */
  updatedAt: number;
}

/** Project metadata stored in the IndexedDB "projects" store. */
export interface WorkspaceProject {
  /** Unique project identifier (UUID). */
  id: string;
  /** Human-readable project name. */
  name: string;
  /** Template this project was created from. */
  templateId: ProjectTemplateId;
  /** Currently active file path, or null if none. */
  activeFile: string | null;
  /** List of open tab file paths. */
  openTabs: string[];
  /** Unix timestamp (ms) of creation. */
  createdAt: number;
  /** Unix timestamp (ms) of last modification. */
  updatedAt: number;
  /** Monotonically increasing revision number for optimistic concurrency. */
  revision: number;
}

/** Workspace-level preference stored in the "preferences" store. */
export interface WorkspacePreferenceRecord {
  /** Preference key, e.g. "activeProjectId", "theme". */
  key: string;
  /** Preference value (type varies per key). */
  value: unknown;
}

/** Process labels for terminal output streams. */
export type ProcessLabel =
  | "system"
  | "install"
  | "dev-server"
  | "build"
  | "preview"
  | "exit"
  | "error";

/** A single output line from a runtime process. */
export interface ProcessOutputEntry {
  /** Process that produced this output. */
  label: ProcessLabel;
  /** Output text (combined stdout/stderr, not labeled separately). */
  text: string;
  /** Unix timestamp (ms). */
  timestamp: number;
}

/** Runtime status of the workspace. */
export type RuntimeStatus =
  | "idle"
  | "starting"
  | "installing"
  | "running"
  | "stopped"
  | "failed";

// ---------------------------------------------------------------------------
// Commit 2 — Persistence error model
// ---------------------------------------------------------------------------

/** Typed persistence error codes. */
export type PersistenceErrorCode =
  | "PERSISTENCE_UNAVAILABLE"
  | "DATABASE_OPEN_FAILED"
  | "PROJECT_NOT_FOUND"
  | "ENTRY_NOT_FOUND"
  | "ENTRY_CONFLICT"
  | "REVISION_CONFLICT"
  | "INVALID_PROJECT_NAME"
  | "INVALID_PATH"
  | "INVALID_ENTRY"
  | "QUOTA_EXCEEDED"
  | "TRANSACTION_FAILED"
  | "TEMPLATE_UNAVAILABLE";

/**
 * Typed persistence error. Wraps browser-level failures with a stable
 * code so the UI layer can present meaningful messages without exposing
 * internal browser details.
 *
 * The original error (when available) is preserved through `cause`.
 * File contents and secrets are never placed inside error messages.
 */
export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly cause: unknown;

  constructor(code: PersistenceErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * Allowlist of all valid PersistenceErrorCode values.
 * Used to verify that an unknown error object carries a trusted code
 * before accepting it as a PersistenceError.
 */
export const PERSISTENCE_ERROR_CODES: readonly PersistenceErrorCode[] = [
  "PERSISTENCE_UNAVAILABLE",
  "DATABASE_OPEN_FAILED",
  "PROJECT_NOT_FOUND",
  "ENTRY_NOT_FOUND",
  "ENTRY_CONFLICT",
  "REVISION_CONFLICT",
  "INVALID_PROJECT_NAME",
  "INVALID_PATH",
  "INVALID_ENTRY",
  "QUOTA_EXCEEDED",
  "TRANSACTION_FAILED",
  "TEMPLATE_UNAVAILABLE",
];

/**
 * Returns true when `err` is a trusted PersistenceError instance,
 * or an object whose `code` is in the PERSISTENCE_ERROR_CODES allowlist.
 */
export function isPersistenceError(err: unknown): boolean {
  if (err instanceof PersistenceError) {
    return true;
  }
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    return (PERSISTENCE_ERROR_CODES as readonly string[]).includes(code as string);
  }
  return false;
}

/**
 * Extracts a trusted PersistenceErrorCode from an unknown error,
 * or returns null if the error is not a recognized persistence error.
 */
export function getPersistenceErrorCode(err: unknown): PersistenceErrorCode | null {
  if (err instanceof PersistenceError) {
    return err.code;
  }
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if ((PERSISTENCE_ERROR_CODES as readonly string[]).includes(code as string)) {
      return code as PersistenceErrorCode;
    }
  }
  return null;
}

/** Template availability metadata. */
export interface TemplateMetadata {
  /** Template identifier. */
  id: ProjectTemplateId;
  /** Human-readable template name. */
  name: string;
  /** Whether the template can be used to create a new project. */
  available: boolean;
  /** Reason the template is unavailable, if applicable. */
  unavailableReason?: string;
}

/** A single file within a project template definition. */
export interface TemplateFile {
  /** Path relative to the project root. */
  path: string;
  /** File contents (UTF-8 text). */
  contents: string;
}

/** A complete project template definition. */
export interface ProjectTemplate {
  /** Template identifier. */
  id: ProjectTemplateId;
  /** Human-readable template name. */
  name: string;
  /** Whether the template can be used to create a new project. */
  available: boolean;
  /** Reason the template is unavailable, if applicable. */
  unavailableReason?: string;
  /** Files to seed when a project is created from this template. */
  files: TemplateFile[];
}
