/**
 * IndexedDB persistence layer for CoderXP M2 Workspace Alpha.
 *
 * Commit 2 scope: native IndexedDB persistence, typed errors, atomic
 * project and filesystem transactions, workspace path validation.
 *
 * Limitations documented as code contracts:
 * - IndexedDB unavailable: isWorkspacePersistenceAvailable() returns false;
 *   openWorkspaceDatabase() throws PERSISTENCE_UNAVAILABLE.
 * - Browser quota exceeded: mutations throw QUOTA_EXCEEDED with the
 *   original error preserved through `cause`.
 * - Database blocked by another tab: openWorkspaceDatabase() rejects with
 *   DATABASE_OPEN_FAILED; the blocked event is captured.
 * - Database version changed: the cached connection is closed and cleared
 *   on versionchange; the next open re-creates it.
 * - Transaction aborted: mutations throw TRANSACTION_FAILED with the
 *   original error preserved through `cause`.
 *
 * No UI messages are implemented in this commit. All failures surface as
 * typed PersistenceError instances for later UI handling.
 */

import {
  FILES_INDEX_BY_PROJECT,
  FILES_KEY_PATH,
  MAX_PROJECT_NAME_LENGTH,
  MIN_PROJECT_NAME_LENGTH,
  PREF_ACTIVE_PROJECT_ID,
  STORE_FILES,
  STORE_PREFERENCES,
  STORE_PROJECTS,
  WORKSPACE_DB_NAME,
  WORKSPACE_DB_VERSION,
} from "./constants";
import {
  normalizeAndValidateWorkspacePath,
  isDescendantPath,
  replacePathPrefix,
} from "./path-utils";
import {
  PersistenceError,
  type WorkspaceFileRecord,
  type WorkspacePreferenceRecord,
  type WorkspaceProject,
  type ProjectTemplateId,
} from "./types";
import { getTemplate } from "./templates";

// ---------------------------------------------------------------------------
// Database connection lifecycle
// ---------------------------------------------------------------------------

/**
 * Pending database open record. Tracks ownership and lifecycle state
 * of an in-flight IndexedDB open request.
 *
 * The browser's IDBOpenDBRequest cannot be cancelled. Instead, we use
 * explicit invalidation: a cancelled record's callbacks verify ownership
 * and discard results from stale or cancelled opens.
 */
interface PendingDatabaseOpen {
  /** The promise exposed to callers. */
  promise: Promise<IDBDatabase>;
  /** Set by closeWorkspaceDatabase() to invalidate this open. */
  cancelled: boolean;
  /** Set when the underlying IDB request reaches success or error. */
  settled: boolean;
  /** Set when the exposed promise has been rejected (onblocked, onerror, or cancel). */
  rejected: boolean;
  /** Reject function for the exposed promise. */
  reject: (error: PersistenceError) => void;
  /** Resolves when the underlying IDB request settles (success/error). */
  settlePromise: Promise<void>;
  /** Resolve function for settlePromise. */
  resolveSettle: () => void;
}

/** Cached open database connection (singleton). */
let dbConnection: IDBDatabase | null = null;

/** Current pending open record, or null when no open is in flight. */
let pendingOpen: PendingDatabaseOpen | null = null;

/**
 * Returns true when `pending` is the current owner of the open lifecycle.
 * Only the current owner may modify global state (dbConnection, pendingOpen).
 */
function isCurrentOwner(pending: PendingDatabaseOpen): boolean {
  return pendingOpen === pending;
}

/**
 * Returns true when the pending open should be discarded: the open was
 * cancelled or the exposed promise was already rejected via onblocked.
 * The resulting database must be closed without caching or resolving.
 */
function shouldDiscardOpen(pending: PendingDatabaseOpen): boolean {
  return pending.cancelled || pending.rejected;
}

/**
 * Returns true when a pending open exists and its underlying IDB request
 * has not yet settled.
 */
function isPendingOpenInFlight(): boolean {
  return pendingOpen !== null && !pendingOpen.settled;
}

/**
 * Returns true when IndexedDB is available in the current environment.
 * Checks for the API and a valid factory function.
 */
export function isWorkspacePersistenceAvailable(): boolean {
  try {
    return (
      typeof indexedDB !== "undefined" &&
      typeof indexedDB.open === "function"
    );
  } catch {
    return false;
  }
}

/**
 * Opens (or returns the cached) workspace database connection.
 *
 * Uses an owned pending-open record so concurrent callers share one open.
 * Every callback verifies ownership before mutating global state.
 *
 * Safety contracts:
 * - closeWorkspaceDatabase() marks the pending record cancelled and
 *   rejects the exposed promise. The underlying IDB request remains in
 *   flight until it settles; its later onsuccess closes the database
 *   without caching or resolving.
 * - A new open waits for a cancelled-but-unsettled request to settle
 *   before starting, preventing parallel opens.
 * - onblocked rejects the exposed promise but does not settle the
 *   request; the later onsuccess closes the database.
 * - Synchronous indexedDB.open() failure clears the pending record
 *   and rejects without leaving a cached rejected promise.
 *
 * Preserves the original browser error through cause when available.
 */
export function openWorkspaceDatabase(): Promise<IDBDatabase> {
  if (dbConnection) {
    return Promise.resolve(dbConnection);
  }

  if (pendingOpen) {
    // If the pending open is cancelled but the underlying request hasn't
    // settled yet, wait for it to settle before starting a new open.
    if (pendingOpen.cancelled && !pendingOpen.settled) {
      const stale = pendingOpen;
      return stale.settlePromise.then(() => openWorkspaceDatabase());
    }
    // If not cancelled, share the existing pending open.
    if (!pendingOpen.cancelled) {
      return pendingOpen.promise;
    }
    // Cancelled and settled: fall through to start a new open.
  }

  if (!isWorkspacePersistenceAvailable()) {
    return Promise.reject(
      new PersistenceError(
        "PERSISTENCE_UNAVAILABLE",
        "IndexedDB is not available in this environment.",
      ),
    );
  }

  let resolveSettle!: () => void;
  const settlePromise = new Promise<void>((r) => {
    resolveSettle = r;
  });

  let resolveDb!: (db: IDBDatabase) => void;
  let rejectDb!: (error: PersistenceError) => void;
  const promise = new Promise<IDBDatabase>((res, rej) => {
    resolveDb = res;
    rejectDb = rej;
  });

  const pending: PendingDatabaseOpen = {
    promise,
    cancelled: false,
    settled: false,
    rejected: false,
    reject: rejectDb,
    settlePromise,
    resolveSettle,
  };

  pendingOpen = pending;

  let request: IDBOpenDBRequest;
  try {
    request = indexedDB.open(WORKSPACE_DB_NAME, WORKSPACE_DB_VERSION);
  } catch (error) {
    pending.settled = true;
    pending.resolveSettle();
    if (isCurrentOwner(pending)) {
      pendingOpen = null;
    }
    pending.reject(
      new PersistenceError("DATABASE_OPEN_FAILED", "Failed to open database.", error),
    );
    return promise;
  }

  request.onupgradeneeded = (_event: IDBVersionChangeEvent) => {
    const db = request.result;
    const tx = request.transaction;

    // Create stores only when absent.
    if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
      db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
    }

    if (!db.objectStoreNames.contains(STORE_FILES)) {
      const fileStore = db.createObjectStore(STORE_FILES, {
        keyPath: FILES_KEY_PATH,
      });
      if (!fileStore.indexNames.contains(FILES_INDEX_BY_PROJECT)) {
        fileStore.createIndex(FILES_INDEX_BY_PROJECT, "projectId", {
          unique: false,
        });
      }
    } else if (tx) {
      // Obtain the existing files store from the upgrade transaction.
      const fileStore = tx.objectStore(STORE_FILES);
      if (!fileStore.indexNames.contains(FILES_INDEX_BY_PROJECT)) {
        fileStore.createIndex(FILES_INDEX_BY_PROJECT, "projectId", {
          unique: false,
        });
      }
    }

    if (!db.objectStoreNames.contains(STORE_PREFERENCES)) {
      db.createObjectStore(STORE_PREFERENCES, { keyPath: "key" });
    }
  };

  request.onsuccess = (_event: Event) => {
    const db = request.result;
    pending.settled = true;
    pending.resolveSettle();

    // Verify ownership: only the current pending record may modify global state.
    if (!isCurrentOwner(pending)) {
      db.close();
      return;
    }

    // If cancelled or already rejected (via onblocked), close without caching.
    if (shouldDiscardOpen(pending)) {
      db.close();
      pendingOpen = null;
      return;
    }

    // Close and clear the cached connection when another tab upgrades.
    db.onversionchange = (_e: IDBVersionChangeEvent) => {
      db.close();
      if (dbConnection === db) {
        dbConnection = null;
      }
    };

    dbConnection = db;
    pendingOpen = null;
    resolveDb(db);
  };

  request.onerror = (_event: Event) => {
    pending.settled = true;
    pending.resolveSettle();

    // Verify ownership.
    if (!isCurrentOwner(pending)) {
      return;
    }

    pendingOpen = null;
    if (!pending.rejected) {
      pending.rejected = true;
      pending.reject(
        new PersistenceError("DATABASE_OPEN_FAILED", "Database open request failed.", request.error),
      );
    }
  };

  request.onblocked = (_event: IDBVersionChangeEvent) => {
    // Reject the exposed operation, but the underlying request remains owned
    // until its eventual success/error. Its later success must be closed.
    if (isCurrentOwner(pending) && !pending.rejected) {
      pending.rejected = true;
      pending.reject(
        new PersistenceError(
          "DATABASE_OPEN_FAILED",
          "Database open blocked by another tab or connection.",
        ),
      );
    }
    // Do NOT mark settled or clear pendingOpen: the request is still in flight.
  };

  return promise;
}

/**
 * Closes the cached database connection and invalidates any pending open.
 *
 * If a pending open exists, marks it cancelled and rejects the exposed
 * promise. The underlying IDB request remains in flight until it settles;
 * its later onsuccess closes the database without caching or resolving.
 *
 * A new open called after this will wait for the old request to settle
 * before starting, preventing parallel opens.
 */
export function closeWorkspaceDatabase(): void {
  if (dbConnection) {
    dbConnection.close();
    dbConnection = null;
  }

  if (pendingOpen) {
    pendingOpen.cancelled = true;
    if (!pendingOpen.rejected) {
      pendingOpen.rejected = true;
      pendingOpen.reject(
        new PersistenceError("DATABASE_OPEN_FAILED", "Database open cancelled."),
      );
    }
    // Do NOT clear pendingOpen: the old request is still in flight.
    // It will be cleared when the request settles (onsuccess/onerror).
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Wraps an IDBRequest in a Promise that resolves with the result
 * or rejects with a PersistenceError.
 */
function wrapRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      const error = request.error;
      if (error && error.name === "QuotaExceededError") {
        reject(new PersistenceError("QUOTA_EXCEEDED", "Storage quota exceeded.", error));
      } else {
        reject(new PersistenceError("TRANSACTION_FAILED", "Request failed.", error));
      }
    };
  });
}

/**
 * Wraps an IDBTransaction in a Promise that resolves on complete
 * or rejects on error/abort.
 */
function wrapTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      const error = tx.error;
      if (error && error.name === "QuotaExceededError") {
        reject(new PersistenceError("QUOTA_EXCEEDED", "Storage quota exceeded.", error));
      } else {
        reject(new PersistenceError("TRANSACTION_FAILED", "Transaction failed.", error));
      }
    };
    tx.onabort = () => {
      const error = tx.error;
      if (error && error.name === "QuotaExceededError") {
        reject(new PersistenceError("QUOTA_EXCEEDED", "Storage quota exceeded.", error));
      } else {
        reject(new PersistenceError("TRANSACTION_FAILED", "Transaction aborted.", error));
      }
    };
  });
}

/** Returns the current Unix timestamp in milliseconds. */
function now(): number {
  return Date.now();
}

/**
 * Validates a project name. Must be a string, trimmed and non-empty,
 * within length limits. Throws INVALID_PROJECT_NAME on failure.
 *
 * A non-string runtime value throws a typed INVALID_PROJECT_NAME rather
 * than an untyped .trim() failure.
 */
function validateProjectName(name: unknown): void {
  if (typeof name !== "string") {
    throw new PersistenceError("INVALID_PROJECT_NAME", "Project name must be a string.");
  }
  const trimmed = name.trim();
  if (trimmed.length < MIN_PROJECT_NAME_LENGTH) {
    throw new PersistenceError("INVALID_PROJECT_NAME", "Project name must not be empty.");
  }
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) {
    throw new PersistenceError(
      "INVALID_PROJECT_NAME",
      `Project name exceeds maximum length of ${MAX_PROJECT_NAME_LENGTH} characters.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Project operations
// ---------------------------------------------------------------------------

/**
 * Creates a new project with a unique ID and the given template.
 * Returns the created project record.
 */
export async function createProject(
  name: string,
  templateId: ProjectTemplateId,
): Promise<WorkspaceProject> {
  validateProjectName(name);

  const db = await openWorkspaceDatabase();

  const project: WorkspaceProject = {
    id: crypto.randomUUID(),
    name: name.trim(),
    templateId,
    activeFile: null,
    openTabs: [],
    createdAt: now(),
    updatedAt: now(),
    revision: 1,
  };

  const tx = db.transaction(STORE_PROJECTS, "readwrite");
  const store = tx.objectStore(STORE_PROJECTS);
  store.add(project);

  await wrapTransaction(tx);
  return project;
}

/**
 * Retrieves a project by ID. Throws PROJECT_NOT_FOUND if absent.
 */
export async function getProject(projectId: string): Promise<WorkspaceProject> {
  const db = await openWorkspaceDatabase();

  const tx = db.transaction(STORE_PROJECTS, "readonly");
  const store = tx.objectStore(STORE_PROJECTS);
  const result = await wrapRequest(store.get(projectId) as IDBRequest<WorkspaceProject | undefined>);

  if (!result) {
    throw new PersistenceError("PROJECT_NOT_FOUND", `Project not found: ${projectId}`);
  }

  return result;
}

/**
 * Lists all projects ordered by creation time (oldest first).
 */
export async function listProjects(): Promise<WorkspaceProject[]> {
  const db = await openWorkspaceDatabase();

  const tx = db.transaction(STORE_PROJECTS, "readonly");
  const store = tx.objectStore(STORE_PROJECTS);
  const all = await wrapRequest(store.getAll() as IDBRequest<WorkspaceProject[]>);

  return all.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * Updates a project record using one read-write transaction.
 *
 * Validates the project name before opening the transaction.
 * Reads the current stored project, throws PROJECT_NOT_FOUND when absent,
 * compares the caller's expected revision with the stored revision,
 * rejects stale writes with REVISION_CONFLICT, derives the next revision
 * from the stored record, preserves immutable identity and creation fields
 * (id, createdAt, templateId), stores the trimmed name, and increments
 * revision exactly once.
 *
 * updateProject() cannot change templateId.
 *
 * Returns the updated project.
 */
export async function updateProject(
  project: WorkspaceProject,
): Promise<WorkspaceProject> {
  validateProjectName(project.name);

  const db = await openWorkspaceDatabase();

  const tx = db.transaction(STORE_PROJECTS, "readwrite");
  const store = tx.objectStore(STORE_PROJECTS);

  // Read the current stored project.
  const stored = await wrapRequest(
    store.get(project.id) as IDBRequest<WorkspaceProject | undefined>,
  );

  if (!stored) {
    throw new PersistenceError("PROJECT_NOT_FOUND", `Project not found: ${project.id}`);
  }

  // Compare the caller's expected revision with the stored revision.
  if (project.revision !== stored.revision) {
    throw new PersistenceError(
      "REVISION_CONFLICT",
      `Revision conflict: expected ${project.revision}, found ${stored.revision}.`,
    );
  }

  // Derive the next revision from the stored record.
  // Preserve immutable identity and creation fields: id, createdAt, templateId.
  // Do not allow updateProject() to change templateId.
  const updated: WorkspaceProject = {
    ...stored,
    name: project.name.trim(),
    activeFile: project.activeFile,
    openTabs: project.openTabs,
    updatedAt: now(),
    revision: stored.revision + 1,
  };

  store.put(updated);

  await wrapTransaction(tx);
  return updated;
}

/**
 * Updates only the editor metadata (activeFile, openTabs) of a project.
 *
 * This is a dedicated persistence operation that reads the current stored
 * project as the source of truth inside its transaction, validates the
 * metadata against current file records, applies only editor metadata,
 * increments the stored revision exactly once, and returns the
 * authoritative updated project.
 *
 * Unlike updateProject(), this does NOT take a revision parameter from
 * the caller. It always reads the current stored revision and increments
 * it, so it cannot conflict with concurrent file-content saves.
 *
 * Validation:
 * - openTabs: filtered to existing file records only
 * - directories rejected/removed
 * - duplicates removed deterministically (preserving order)
 * - activeFile: must reference an existing file, otherwise null
 *
 * Returns the authoritative updated project.
 */
export async function updateProjectEditorState(
  projectId: string,
  openTabs: string[],
  activeFile: string | null,
): Promise<WorkspaceProject> {
  const db = await openWorkspaceDatabase();

  const tx = db.transaction([STORE_PROJECTS, STORE_FILES], "readwrite");
  const projectStore = tx.objectStore(STORE_PROJECTS);
  const fileStore = tx.objectStore(STORE_FILES);

  // Read the current stored project as the source of truth.
  const stored = await wrapRequest(
    projectStore.get(projectId) as IDBRequest<WorkspaceProject | undefined>,
  );

  if (!stored) {
    throw new PersistenceError("PROJECT_NOT_FOUND", `Project not found: ${projectId}`);
  }

  // Read all file records for this project to validate metadata.
  const index = fileStore.index(FILES_INDEX_BY_PROJECT);
  const allFiles = await wrapRequest(
    index.getAll(projectId) as IDBRequest<WorkspaceFileRecord[]>,
  );

  // Build a set of valid file paths (files only, not directories).
  const validFilePaths = new Set<string>();
  for (const f of allFiles) {
    if (f.kind === "file") {
      validFilePaths.add(f.path);
    }
  }

  // Sanitize openTabs: remove missing paths, directories, and duplicates.
  const sanitizedTabs: string[] = [];
  const seenTabs = new Set<string>();
  for (const tab of openTabs) {
    if (validFilePaths.has(tab) && !seenTabs.has(tab)) {
      sanitizedTabs.push(tab);
      seenTabs.add(tab);
    }
  }

  // Validate activeFile: must reference an existing file.
  let sanitizedActiveFile: string | null = null;
  if (activeFile && validFilePaths.has(activeFile)) {
    sanitizedActiveFile = activeFile;
  }

  // Ensure activeFile is represented in openTabs.
  if (sanitizedActiveFile && !seenTabs.has(sanitizedActiveFile)) {
    sanitizedTabs.push(sanitizedActiveFile);
    seenTabs.add(sanitizedActiveFile);
  }

  // If activeFile is null but there are valid tabs, fall back to the first tab.
  if (!sanitizedActiveFile && sanitizedTabs.length > 0) {
    sanitizedActiveFile = sanitizedTabs[0];
  }

  // Apply only editor metadata to the stored project.
  const updated: WorkspaceProject = {
    ...stored,
    openTabs: sanitizedTabs,
    activeFile: sanitizedActiveFile,
    updatedAt: now(),
    revision: stored.revision + 1,
  };

  projectStore.put(updated);

  await wrapTransaction(tx);
  return updated;
}

/**
 * Renames a project in one read-write transaction.
 *
 * Performs read, validation, rename, timestamp update, and revision
 * increment in a single transaction. Does not call a separate getProject()
 * transaction followed by another transaction.
 *
 * Returns the updated project.
 */
export async function renameProject(
  projectId: string,
  newName: string,
): Promise<WorkspaceProject> {
  validateProjectName(newName);

  const db = await openWorkspaceDatabase();

  const tx = db.transaction(STORE_PROJECTS, "readwrite");
  const store = tx.objectStore(STORE_PROJECTS);

  // Read the current stored project.
  const stored = await wrapRequest(
    store.get(projectId) as IDBRequest<WorkspaceProject | undefined>,
  );

  if (!stored) {
    throw new PersistenceError("PROJECT_NOT_FOUND", `Project not found: ${projectId}`);
  }

  // Rename, update timestamp, increment revision.
  const updated: WorkspaceProject = {
    ...stored,
    name: newName.trim(),
    updatedAt: now(),
    revision: stored.revision + 1,
  };

  store.put(updated);

  await wrapTransaction(tx);
  return updated;
}

/**
 * Deletes a project and all associated data in one atomic transaction.
 *
 * Removes:
 * - The project record
 * - Every associated file/directory record
 * - activeProjectId preference when it references the deleted project
 *
 * No orphaned file records are allowed.
 */
export async function deleteProject(projectId: string): Promise<void> {
  const db = await openWorkspaceDatabase();

  const tx = db.transaction(
    [STORE_PROJECTS, STORE_FILES, STORE_PREFERENCES],
    "readwrite",
  );

  const projectStore = tx.objectStore(STORE_PROJECTS);
  const fileStore = tx.objectStore(STORE_FILES);
  const prefStore = tx.objectStore(STORE_PREFERENCES);

  // --- PREFLIGHT: all reads before any writes ---

  // 1. Read and verify the project exists.
  const project = await wrapRequest(
    projectStore.get(projectId) as IDBRequest<WorkspaceProject | undefined>,
  );
  if (!project) {
    throw new PersistenceError("PROJECT_NOT_FOUND", `Project not found: ${projectId}`);
  }

  // 2. Read all associated file keys via the byProject index.
  const index = fileStore.index(FILES_INDEX_BY_PROJECT);
  const fileKeys = await wrapRequest(index.getAllKeys(projectId) as IDBRequest<IDBValidKey[]>);

  // 3. Read the active-project preference.
  const pref = await wrapRequest(
    prefStore.get(PREF_ACTIVE_PROJECT_ID) as IDBRequest<WorkspacePreferenceRecord | undefined>,
  );

  // --- WRITE PHASE: all writes after all preflight reads succeed ---

  try {
    // Queue the project deletion.
    projectStore.delete(projectId);

    // Queue all file-record deletions.
    for (const key of fileKeys) {
      fileStore.delete(key);
    }

    // Queue the preference deletion if it references this project.
    if (pref && pref.value === projectId) {
      prefStore.delete(PREF_ACTIVE_PROJECT_ID);
    }
  } catch (syncError) {
    // If a synchronous write error occurs, explicitly abort before rethrowing.
    // No synchronous exception may allow a partially queued deletion
    // transaction to commit.
    try {
      tx.abort();
    } catch {
      // Abort may throw if already aborted; ignore.
    }
    throw syncError;
  }

  await wrapTransaction(tx);
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

/**
 * Retrieves a single file or directory entry by project ID and path.
 * Throws ENTRY_NOT_FOUND if absent.
 */
export async function getEntry(
  projectId: string,
  path: string,
): Promise<WorkspaceFileRecord> {
  const db = await openWorkspaceDatabase();

  const normalisedPath = normalizeAndValidateWorkspacePath(path);

  const tx = db.transaction(STORE_FILES, "readonly");
  const store = tx.objectStore(STORE_FILES);
  const result = await wrapRequest(
    store.get([projectId, normalisedPath]) as IDBRequest<WorkspaceFileRecord | undefined>,
  );

  if (!result) {
    throw new PersistenceError("ENTRY_NOT_FOUND", `Entry not found: ${normalisedPath}`);
  }

  return result;
}

/**
 * Lists all file and directory entries for a project, ordered by path.
 */
export async function listProjectEntries(
  projectId: string,
): Promise<WorkspaceFileRecord[]> {
  const db = await openWorkspaceDatabase();

  const tx = db.transaction(STORE_FILES, "readonly");
  const store = tx.objectStore(STORE_FILES);
  const index = store.index(FILES_INDEX_BY_PROJECT);
  const all = await wrapRequest(
    index.getAll(projectId) as IDBRequest<WorkspaceFileRecord[]>,
  );

  return all.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Creates or updates a file or directory entry.
 *
 * File records require contents. Directory records must not store contents.
 * Paths are normalised before storage. Rejects conflicts before mutation.
 * Confirms the project exists inside the same transaction before performing
 * mutations. Throws PROJECT_NOT_FOUND when it does not.
 */
export async function putEntry(
  projectId: string,
  path: string,
  kind: "file" | "directory",
  contents?: string,
): Promise<WorkspaceFileRecord> {
  const db = await openWorkspaceDatabase();

  const normalisedPath = normalizeAndValidateWorkspacePath(path);

  // Validate entry constraints.
  if (kind === "file" && contents === undefined) {
    throw new PersistenceError("INVALID_ENTRY", "File entries require contents.");
  }
  if (kind === "directory" && contents !== undefined) {
    throw new PersistenceError("INVALID_ENTRY", "Directory entries must not have contents.");
  }

  const tx = db.transaction([STORE_FILES, STORE_PROJECTS], "readwrite");
  const fileStore = tx.objectStore(STORE_FILES);
  const projectStore = tx.objectStore(STORE_PROJECTS);

  // Confirm the project exists before performing mutations.
  const project = await wrapRequest(
    projectStore.get(projectId) as IDBRequest<WorkspaceProject | undefined>,
  );
  if (!project) {
    throw new PersistenceError("PROJECT_NOT_FOUND", `Project not found: ${projectId}`);
  }

  // Check for existing entry.
  const existing = await wrapRequest(
    fileStore.get([projectId, normalisedPath]) as IDBRequest<WorkspaceFileRecord | undefined>,
  );

  // Conflict: cannot put a file where a directory exists, or vice versa.
  if (existing && existing.kind !== kind) {
    throw new PersistenceError(
      "ENTRY_CONFLICT",
      `An entry of a different kind already exists at: ${normalisedPath}`,
    );
  }

  const timestamp = now();

  // Construct file and directory records separately: directories must not
  // have an own contents property.
  let record: WorkspaceFileRecord;
  if (kind === "file") {
    record = {
      projectId,
      path: normalisedPath,
      kind: "file",
      contents: contents as string,
      createdAt: existing ? existing.createdAt : timestamp,
      updatedAt: timestamp,
    };
  } else {
    record = {
      projectId,
      path: normalisedPath,
      kind: "directory",
      createdAt: existing ? existing.createdAt : timestamp,
      updatedAt: timestamp,
    };
  }

  fileStore.put(record);

  // Update project revision.
  project.updatedAt = timestamp;
  project.revision += 1;
  projectStore.put(project);

  await wrapTransaction(tx);
  return record;
}

/**
 * Deletes a file or directory entry. When the entry is a directory,
 * atomically deletes the directory and all descendants in one transaction.
 *
 * The same transaction updates the project: activeFile, openTabs, updatedAt, revision.
 * Deleted paths are removed from activeFile and openTabs using equality-or-descendant
 * semantics for directories. Confirms the project exists inside the same transaction
 * before performing mutations. Throws PROJECT_NOT_FOUND when it does not.
 */
export async function deleteEntry(
  projectId: string,
  path: string,
): Promise<void> {
  const db = await openWorkspaceDatabase();

  const normalisedPath = normalizeAndValidateWorkspacePath(path);

  const tx = db.transaction([STORE_FILES, STORE_PROJECTS], "readwrite");
  const fileStore = tx.objectStore(STORE_FILES);
  const projectStore = tx.objectStore(STORE_PROJECTS);

  // Confirm the project exists before performing mutations.
  const project = await wrapRequest(
    projectStore.get(projectId) as IDBRequest<WorkspaceProject | undefined>,
  );
  if (!project) {
    throw new PersistenceError("PROJECT_NOT_FOUND", `Project not found: ${projectId}`);
  }

  // Get the entry to determine if it's a file or directory.
  const entry = await wrapRequest(
    fileStore.get([projectId, normalisedPath]) as IDBRequest<WorkspaceFileRecord | undefined>,
  );

  if (!entry) {
    throw new PersistenceError("ENTRY_NOT_FOUND", `Entry not found: ${normalisedPath}`);
  }

  // Collect all paths to delete.
  const pathsToDelete: string[] = [normalisedPath];

  if (entry.kind === "directory") {
    // Find all descendants.
    const allEntries = await wrapRequest(
      fileStore.index(FILES_INDEX_BY_PROJECT).getAll(projectId) as IDBRequest<WorkspaceFileRecord[]>,
    );
    for (const e of allEntries) {
      if (isDescendantPath(normalisedPath, e.path)) {
        pathsToDelete.push(e.path);
      }
    }
  }

  // Delete all collected paths.
  for (const p of pathsToDelete) {
    fileStore.delete([projectId, p]);
  }

  // Update project: remove deleted paths from activeFile and openTabs.
  // For directory deletion, clear/remove metadata paths when they are
  // equal to the deleted directory or descendants of the deleted directory.
  // Do this even when a stale tab path has no corresponding file record.
  const deletedSet = new Set(pathsToDelete);

  if (project.activeFile) {
    if (deletedSet.has(project.activeFile)) {
      project.activeFile = null;
    } else if (entry.kind === "directory" && isDescendantPath(normalisedPath, project.activeFile)) {
      project.activeFile = null;
    }
  }

  if (entry.kind === "directory") {
    // For directory deletion, filter tabs using equality-or-descendant semantics.
    project.openTabs = project.openTabs.filter((tab) => {
      if (deletedSet.has(tab)) return false;
      if (isDescendantPath(normalisedPath, tab)) return false;
      return true;
    });
  } else {
    // For file deletion, affect only the exact file path.
    project.openTabs = project.openTabs.filter((tab) => !deletedSet.has(tab));
  }

  project.updatedAt = now();
  project.revision += 1;
  projectStore.put(project);

  await wrapTransaction(tx);
}

/**
 * Renames a file or directory entry. When the entry is a directory,
 * atomically updates the directory path and every descendant path.
 *
 * The same transaction updates: activeFile, every affected openTabs path,
 * project updatedAt, project revision.
 *
 * Checks every destination path for conflicts before writing any changes.
 * If any operation fails, the entire transaction aborts.
 *
 * Confirms the project exists inside the same transaction before performing
 * mutations. Throws PROJECT_NOT_FOUND when it does not.
 */
export async function renameEntry(
  projectId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  const db = await openWorkspaceDatabase();

  const normalisedOldPath = normalizeAndValidateWorkspacePath(oldPath);
  const normalisedNewPath = normalizeAndValidateWorkspacePath(newPath);

  // Always reject oldPath === newPath.
  if (normalisedOldPath === normalisedNewPath) {
    throw new PersistenceError("INVALID_PATH", "New path must differ from old path.");
  }

  const tx = db.transaction([STORE_FILES, STORE_PROJECTS], "readwrite");
  const fileStore = tx.objectStore(STORE_FILES);
  const projectStore = tx.objectStore(STORE_PROJECTS);

  // Confirm the project exists before performing mutations.
  const project = await wrapRequest(
    projectStore.get(projectId) as IDBRequest<WorkspaceProject | undefined>,
  );
  if (!project) {
    throw new PersistenceError("PROJECT_NOT_FOUND", `Project not found: ${projectId}`);
  }

  // Get the entry to rename.
  const entry = await wrapRequest(
    fileStore.get([projectId, normalisedOldPath]) as IDBRequest<WorkspaceFileRecord | undefined>,
  );

  if (!entry) {
    throw new PersistenceError("ENTRY_NOT_FOUND", `Entry not found: ${normalisedOldPath}`);
  }

  // Reject newPath being a descendant of oldPath only after loading the
  // entry and confirming it is a directory. A file rename must not be
  // rejected merely because the destination string begins with oldPath + "/".
  if (entry.kind === "directory" && isDescendantPath(normalisedOldPath, normalisedNewPath)) {
    throw new PersistenceError(
      "INVALID_PATH",
      "Cannot rename a directory into itself or one of its descendants.",
    );
  }

  // Collect all entries to move (the entry itself + descendants if directory).
  const entriesToMove: WorkspaceFileRecord[] = [entry];
  if (entry.kind === "directory") {
    const allEntries = await wrapRequest(
      fileStore.index(FILES_INDEX_BY_PROJECT).getAll(projectId) as IDBRequest<WorkspaceFileRecord[]>,
    );
    for (const e of allEntries) {
      if (isDescendantPath(normalisedOldPath, e.path)) {
        entriesToMove.push(e);
      }
    }
  }

  // Build the complete source-path set.
  const sourcePaths = new Set(entriesToMove.map((e) => e.path));

  // Build every destination path and confirm they are unique.
  const destPaths = entriesToMove.map((e) =>
    replacePathPrefix(e.path, normalisedOldPath, normalisedNewPath),
  );
  const destSet = new Set(destPaths);
  if (destSet.size !== destPaths.length) {
    throw new PersistenceError("ENTRY_CONFLICT", "Destination paths are not unique.");
  }

  // Check every destination against stored entries.
  // Permit an occupied destination only when that exact stored key is part
  // of the source set being moved.
  for (const destPath of destPaths) {
    const existing = await wrapRequest(
      fileStore.get([projectId, destPath]) as IDBRequest<WorkspaceFileRecord | undefined>,
    );
    if (existing && !sourcePaths.has(existing.path)) {
      throw new PersistenceError("ENTRY_CONFLICT", `Destination path already exists: ${destPath}`);
    }
  }

  // All conflict checks passed. Now perform the moves.
  const timestamp = now();

  for (const e of entriesToMove) {
    const destPath = replacePathPrefix(e.path, normalisedOldPath, normalisedNewPath);
    // Delete the old key and put the new one.
    fileStore.delete([projectId, e.path]);
    fileStore.put({
      ...e,
      path: destPath,
      updatedAt: timestamp,
    });
  }

  // Update project: activeFile, openTabs, updatedAt, revision.
  // For directory rename, replace the prefix on activeFile and every
  // affected openTabs path using equality-or-descendant semantics,
  // independently of entriesToMove.
  if (project.activeFile) {
    if (project.activeFile === normalisedOldPath) {
      project.activeFile = normalisedNewPath;
    } else if (entry.kind === "directory" && isDescendantPath(normalisedOldPath, project.activeFile)) {
      project.activeFile = replacePathPrefix(project.activeFile, normalisedOldPath, normalisedNewPath);
    }
  }

  if (entry.kind === "directory") {
    // For directory rename, replace prefix on every affected openTabs path
    // using equality-or-descendant semantics, independently of entriesToMove.
    project.openTabs = project.openTabs.map((tab) => {
      if (tab === normalisedOldPath) {
        return normalisedNewPath;
      }
      if (isDescendantPath(normalisedOldPath, tab)) {
        return replacePathPrefix(tab, normalisedOldPath, normalisedNewPath);
      }
      return tab;
    });
  } else {
    // For file rename, affect only the exact file path.
    project.openTabs = project.openTabs.map((tab) =>
      tab === normalisedOldPath ? normalisedNewPath : tab,
    );
  }

  project.updatedAt = timestamp;
  project.revision += 1;
  projectStore.put(project);

  await wrapTransaction(tx);
}

// ---------------------------------------------------------------------------
// Preference operations
// ---------------------------------------------------------------------------

/**
 * Gets a workspace preference by key. Returns undefined if not found.
 */
export async function getPreference(
  key: string,
): Promise<WorkspacePreferenceRecord | undefined> {
  const db = await openWorkspaceDatabase();

  const tx = db.transaction(STORE_PREFERENCES, "readonly");
  const store = tx.objectStore(STORE_PREFERENCES);
  return wrapRequest(store.get(key) as IDBRequest<WorkspacePreferenceRecord | undefined>);
}

/**
 * Sets a workspace preference. Creates or updates the record.
 */
export async function setPreference(
  key: string,
  value: unknown,
): Promise<void> {
  const db = await openWorkspaceDatabase();

  const tx = db.transaction(STORE_PREFERENCES, "readwrite");
  const store = tx.objectStore(STORE_PREFERENCES);
  store.put({ key, value } satisfies WorkspacePreferenceRecord);

  await wrapTransaction(tx);
}

/**
 * Gets the active project ID from preferences, or undefined.
 */
export async function getActiveProjectId(): Promise<string | undefined> {
  const pref = await getPreference(PREF_ACTIVE_PROJECT_ID);
  return pref?.value as string | undefined;
}

/**
 * Sets the active project ID preference.
 */
export async function setActiveProjectId(projectId: string): Promise<void> {
  await setPreference(PREF_ACTIVE_PROJECT_ID, projectId);
}

// ---------------------------------------------------------------------------
// Commit 3 — Atomic project creation from template
// ---------------------------------------------------------------------------

/**
 * Creates a complete project from a template in a single atomic
 * read-write transaction across the projects, files, and preferences
 * stores.
 *
 * Steps performed inside one transaction:
 * 1. Validate and trim the project name.
 * 2. Reject unavailable templates with TEMPLATE_UNAVAILABLE.
 * 3. Generate the project UUID.
 * 4. Create the project at revision 1.
 * 5. Insert all template files.
 * 6. Set initial activeFile (index.html if present, else first file).
 * 7. Set initial openTabs to the same initial file.
 * 8. Set the active-project preference.
 *
 * No partially created project may remain after failure: the entire
 * operation is one transaction, so any error rolls back all writes.
 *
 * Does not remove or modify existing lower-level persistence operations.
 */
export async function createProjectFromTemplate(
  name: string,
  templateId: ProjectTemplateId,
): Promise<WorkspaceProject> {
  validateProjectName(name);

  // --- PREFLIGHT: all validation before opening any transaction ---

  // 1. Retrieve and verify the available template.
  const template = getTemplate(templateId);
  if (!template || !template.available) {
    throw new PersistenceError(
      "TEMPLATE_UNAVAILABLE",
      `Template is not available: ${templateId}`,
    );
  }

  // 2. Confirm the template contains only valid file definitions.
  if (!Array.isArray(template.files) || template.files.length === 0) {
    throw new PersistenceError(
      "TEMPLATE_UNAVAILABLE",
      `Template has no file definitions: ${templateId}`,
    );
  }

  for (const file of template.files) {
    if (!file || typeof file.path !== "string" || typeof file.contents !== "string") {
      throw new PersistenceError(
        "TEMPLATE_UNAVAILABLE",
        `Template contains an invalid file definition: ${templateId}`,
      );
    }
  }

  // 3. Normalize and validate every template path.
  const normalizedPaths: string[] = [];
  for (const file of template.files) {
    const normalisedPath = normalizeAndValidateWorkspacePath(file.path);
    normalizedPaths.push(normalisedPath);
  }

  // 4. Reject duplicate normalized paths with a typed error.
  const seenPaths = new Set<string>();
  for (const p of normalizedPaths) {
    if (seenPaths.has(p)) {
      throw new PersistenceError(
        "TEMPLATE_UNAVAILABLE",
        `Template contains duplicate path: ${p}`,
      );
    }
    seenPaths.add(p);
  }

  // 5. Build the complete file-record seed list.
  const timestamp = now();
  const projectId = crypto.randomUUID();
  const trimmedName = name.trim();

  const fileRecords: WorkspaceFileRecord[] = normalizedPaths.map((p, i) => ({
    projectId,
    path: p,
    kind: "file" as const,
    contents: template.files[i].contents,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));

  // 6. Determine activeFile from the normalized seed paths.
  const indexHtmlPath = normalizedPaths.find((p) => p === "index.html");
  const initialActiveFile = indexHtmlPath ?? normalizedPaths[0] ?? null;

  const project: WorkspaceProject = {
    id: projectId,
    name: trimmedName,
    templateId,
    activeFile: initialActiveFile,
    openTabs: initialActiveFile ? [initialActiveFile] : [],
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
  };

  // --- TRANSACTION: only writes, no validation that can throw ---

  const db = await openWorkspaceDatabase();

  const tx = db.transaction(
    [STORE_PROJECTS, STORE_FILES, STORE_PREFERENCES],
    "readwrite",
  );

  const projectStore = tx.objectStore(STORE_PROJECTS);
  const fileStore = tx.objectStore(STORE_FILES);
  const prefStore = tx.objectStore(STORE_PREFERENCES);

  try {
    // Insert the project record (add, not put: duplicate key aborts).
    projectStore.add(project);

    // Insert all template file records (add, not put: duplicate key aborts).
    for (const record of fileRecords) {
      fileStore.add(record);
    }

    // Set the active project preference.
    prefStore.put({
      key: PREF_ACTIVE_PROJECT_ID,
      value: projectId,
    } satisfies WorkspacePreferenceRecord);
  } catch (syncError) {
    // If a synchronous error occurs after the transaction starts,
    // explicitly abort before rethrowing.
    try {
      tx.abort();
    } catch {
      // Abort may throw if already aborted; ignore.
    }
    throw syncError;
  }

  await wrapTransaction(tx);
  return project;
}
