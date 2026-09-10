/**
 * Workspace runtime constants for CoderXP M2 Workspace Alpha.
 *
 * Commit 1 scope: constants and interfaces only. No runtime
 * boot, mount, or process execution.
 */

/** Dedicated runtime directory inside the WebContainer. */
export const WORKSPACE_PROJECT_ROOT = "project";

/** IndexedDB database name for workspace persistence. */
export const WORKSPACE_DB_NAME = "coderxp-workspace";

/** IndexedDB database version. */
export const WORKSPACE_DB_VERSION = 1;

/** Object store names. */
export const STORE_PROJECTS = "projects";
export const STORE_FILES = "files";
export const STORE_PREFERENCES = "preferences";

/** Compound key path for the files store. */
export const FILES_KEY_PATH = ["projectId", "path"];

/** Index name for querying files by project. */
export const FILES_INDEX_BY_PROJECT = "byProject";

/** Debounce delay (ms) for file content saves. */
export const SAVE_DEBOUNCE_MS = 500;

/** WebContainer boot options. */
export const WEBCONTAINER_BOOT_OPTIONS = {
  coep: "require-corp" as const,
  forwardPreviewErrors: true,
  workdirName: "coderxp",
};

/** Paths excluded from ZIP export. */
export const EXPORT_EXCLUDES = [
  "node_modules/**",
  ".next/**",
  "dist/**",
  ".turbo/**",
  ".cache/**",
];

// ---------------------------------------------------------------------------
// Commit 2 — Persistence and template constants
// ---------------------------------------------------------------------------

/** Preference key for the currently active project ID. */
export const PREF_ACTIVE_PROJECT_ID = "activeProjectId";

/** Minimum project name length after trimming. */
export const MIN_PROJECT_NAME_LENGTH = 1;

/** Maximum project name length. */
export const MAX_PROJECT_NAME_LENGTH = 100;

/** Default port for the static template dev server. */
export const DEFAULT_DEV_PORT = 3000;

// ---------------------------------------------------------------------------
// M3.4 — filesystem sync limits
// ---------------------------------------------------------------------------

/**
 * Maximum size of a text file persisted by the WebContainer -> IndexedDB
 * sync. Files above this are skipped before being decoded, so an oversized
 * generated artifact never reaches IndexedDB or the decoder.
 */
export const MAX_SYNC_TEXT_FILE_BYTES = 1 * 1024 * 1024;
