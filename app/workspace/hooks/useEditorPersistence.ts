"use client";

/**
 * Per-file persistence coordinator for CoderXP M2 Workspace Alpha.
 *
 * Correction (fix(workspace): make editor persistence lossless):
 *
 * Replaces component-local debounce saving with a per-file persistence
 * coordinator that owns save scheduling, serialization, version tracking,
 * and dirty-state management outside the CodeEditor component lifecycle.
 *
 * Per file, maintains:
 * - current buffer (in-memory content)
 * - current edit version number (monotonically increasing)
 * - last successfully persisted version
 * - pending debounce timer
 * - pending/in-flight save promise
 * - dirty state
 * - save error
 *
 * Saves for a project/file are explicitly serialized via a per-project
 * persistence queue so file-content saves and metadata updates cannot
 * race each other.
 *
 * Lifecycle transitions (flushPath, flushAll) are lossless: they clear
 * timers and await persistence of the newest dirty buffer before
 * allowing destructive state transitions.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { putEntry, updateProjectEditorState } from "@/lib/workspace/persistence";
import { SAVE_DEBOUNCE_MS } from "@/lib/workspace/constants";
import { isPersistenceError, type PersistenceErrorCode } from "@/lib/workspace/types";
import type { WorkspaceProject } from "@/lib/workspace/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-file state tracked by the coordinator. */
interface FilePersistenceState {
  /** Current in-memory buffer content. */
  buffer: string;
  /** Monotonically increasing edit version. Incremented on every edit. */
  editVersion: number;
  /** Last successfully persisted edit version. */
  lastPersistedVersion: number;
  /** Pending debounce timer, or null. */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Pending in-flight save promise, or null. */
  inFlightSave: Promise<boolean> | null;
  /** Whether this file has unsaved changes. */
  dirty: boolean;
  /** Save error message, or null if no error. */
  error: string | null;
}

/** A file-open request with explicit identity. */
export interface FileOpenRequest {
  path: string;
  requestId: number;
}

// ---------------------------------------------------------------------------
// Controlled error messages (no raw browser/IndexedDB internals)
// ---------------------------------------------------------------------------

const ERROR_MESSAGES: Record<PersistenceErrorCode, string> = {
  PERSISTENCE_UNAVAILABLE: "Local storage is not available. Changes cannot be saved.",
  DATABASE_OPEN_FAILED: "The local database could not be opened. Changes cannot be saved.",
  QUOTA_EXCEEDED: "Storage quota exceeded. Remove unused projects to free space.",
  TRANSACTION_FAILED: "Save failed. Your changes are preserved in memory.",
  PROJECT_NOT_FOUND: "The project was not found. Changes cannot be saved.",
  ENTRY_NOT_FOUND: "The file was not found.",
  ENTRY_CONFLICT: "A conflicting entry exists at this path.",
  REVISION_CONFLICT: "The project was modified by another operation. Please refresh.",
  INVALID_PROJECT_NAME: "The project name is invalid.",
  INVALID_PATH: "The file path is invalid.",
  INVALID_ENTRY: "The file entry is invalid.",
  TEMPLATE_UNAVAILABLE: "This template is not available.",
};

function getErrorMessage(err: unknown): string {
  if (isPersistenceError(err)) {
    const code = (err as { code: PersistenceErrorCode }).code;
    return ERROR_MESSAGES[code] ?? "Save failed. Your changes are preserved in memory.";
  }
  return "Save failed. Your changes are preserved in memory.";
}

// ---------------------------------------------------------------------------
// Per-project serialized persistence queue
// ---------------------------------------------------------------------------

/**
 * A serialized queue for all persistence operations on a single project.
 * File-content saves and metadata updates are chained so they cannot race.
 */
class ProjectPersistenceQueue {
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * Enqueue a persistence operation. Returns a promise that resolves
   * with the operation's result once all prior operations complete.
   */
  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation, operation);
    // Keep the chain going even if this operation fails.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// ---------------------------------------------------------------------------
// useEditorPersistence hook
// ---------------------------------------------------------------------------

export interface EditorPersistenceApi {
  /** Current dirty paths. */
  dirtyPaths: Set<string>;
  /** Save errors per path. */
  saveErrors: Map<string, string>;
  /** Metadata error, or null. */
  metadataError: string | null;
  /** Whether any save is currently in flight. */
  isSaving: boolean;

  /**
   * Called on every content change from the editor.
   * Updates the in-memory buffer, marks the file dirty, and schedules
   * a debounced save.
   */
  onContentChange: (path: string, contents: string) => void;

  /**
   * Flush a single file's pending save. Clears its debounce timer and
   * awaits persistence of the newest dirty buffer.
   * Returns true on success, false on failure (error is in saveErrors).
   */
  flushPath: (path: string) => Promise<boolean>;

  /**
   * Flush all dirty files. Returns true if all succeeded, false if any failed.
   */
  flushAll: () => Promise<boolean>;

  /**
   * Retry saving a file that previously failed.
   * Saves the current/latest buffer, not an older captured value.
   */
  retrySave: (path: string) => Promise<boolean>;

  /**
   * Persist editor metadata (activeFile, openTabs) to the project record.
   * Uses the dedicated updateProjectEditorState operation that reads the
   * current stored project, validates metadata, increments revision once,
   * and returns the authoritative project.
   */
  persistEditorState: (
    openTabs: string[],
    activeFile: string | null,
  ) => Promise<WorkspaceProject | null>;

  /** Clear the metadata error. */
  clearMetadataError: () => void;

  /** Clear all state for a file (on tab close). */
  clearFile: (path: string) => void;

  /** Get the current buffer for a file. */
  getBuffer: (path: string) => string | undefined;

  /** Seed a file's initial buffer from persisted file records. */
  seedBuffer: (path: string, contents: string) => void;
}

export function useEditorPersistence(
  projectId: string,
  onProjectUpdate: (updated: WorkspaceProject) => void,
): EditorPersistenceApi {
  // Per-file state, stored in a ref for synchronous access.
  const fileStatesRef = useRef<Map<string, FilePersistenceState>>(new Map());
  const queueRef = useRef<ProjectPersistenceQueue>(new ProjectPersistenceQueue());

  // React state mirrors for rendering.
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  const [saveErrors, setSaveErrors] = useState<Map<string, string>>(new Map());
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Track active save count for isSaving state.
  const activeSavesRef = useRef(0);

  const updateDirtyState = useCallback((path: string, dirty: boolean) => {
    setDirtyPaths((prev) => {
      const next = new Set(prev);
      if (dirty) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  }, []);

  const updateErrorState = useCallback((path: string, error: string | null) => {
    setSaveErrors((prev) => {
      const next = new Map(prev);
      if (error) {
        next.set(path, error);
      } else {
        next.delete(path);
      }
      return next;
    });
  }, []);

  const startSaving = useCallback(() => {
    activeSavesRef.current++;
    if (activeSavesRef.current === 1) {
      setIsSaving(true);
    }
  }, []);

  const stopSaving = useCallback(() => {
    activeSavesRef.current = Math.max(0, activeSavesRef.current - 1);
    if (activeSavesRef.current === 0) {
      setIsSaving(false);
    }
  }, []);

  /**
   * Perform the actual file save through the serialized queue.
   * Returns true on success, false on failure.
   */
  const doSave = useCallback(
    (path: string): Promise<boolean> => {
      const state = fileStatesRef.current.get(path);
      if (!state) return Promise.resolve(true);

      // If there's already an in-flight save for this file, chain after it.
      const prevSave = state.inFlightSave;

      const saveOperation = async (): Promise<boolean> => {
        // Read the latest buffer and version at execution time.
        const currentBuffer = state.buffer;
        const currentVersion = state.editVersion;

        // If already persisted at this version, no save needed.
        if (currentVersion === state.lastPersistedVersion) {
          return true;
        }

        try {
          await putEntry(projectId, path, "file", currentBuffer);
          // Only clear dirty if no newer edits occurred during the save.
          if (state.editVersion === currentVersion) {
            state.lastPersistedVersion = currentVersion;
            state.dirty = false;
            state.error = null;
            updateDirtyState(path, false);
            updateErrorState(path, null);
          } else {
            // Newer edits occurred during save. Keep dirty.
            state.lastPersistedVersion = currentVersion;
            state.error = null;
            updateErrorState(path, null);
          }
          return true;
        } catch (err) {
          // Save failed: dirty remains, error is surfaced.
          state.error = getErrorMessage(err);
          updateErrorState(path, state.error);
          return false;
        }
      };

      startSaving();
      const result = queueRef.current.enqueue(saveOperation);
      const wrapped = result.then(
        (ok) => {
          stopSaving();
          return ok;
        },
        () => {
          stopSaving();
          return false;
        },
      );

      state.inFlightSave = wrapped;
      return wrapped;
    },
    [projectId, updateDirtyState, updateErrorState, startSaving, stopSaving],
  );

  /**
   * Schedule a debounced save for a file.
   */
  const scheduleSave = useCallback(
    (path: string) => {
      const state = fileStatesRef.current.get(path);
      if (!state) return;

      // Clear any existing debounce timer.
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
      }

      // Schedule a new save after SAVE_DEBOUNCE_MS.
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        doSave(path);
      }, SAVE_DEBOUNCE_MS);
    },
    [doSave],
  );

  /**
   * Called on every content change from the editor.
   */
  const onContentChange = useCallback(
    (path: string, contents: string) => {
      let state = fileStatesRef.current.get(path);
      if (!state) {
        state = {
          buffer: contents,
          editVersion: 1,
          lastPersistedVersion: 0,
          debounceTimer: null,
          inFlightSave: null,
          dirty: true,
          error: null,
        };
        fileStatesRef.current.set(path, state);
      } else {
        state.buffer = contents;
        state.editVersion++;
        state.dirty = true;
        state.error = null;
        updateErrorState(path, null);
      }

      updateDirtyState(path, true);
      scheduleSave(path);
    },
    [scheduleSave, updateDirtyState, updateErrorState],
  );

  /**
   * Flush a single file's pending save.
   */
  const flushPath = useCallback(
    async (path: string): Promise<boolean> => {
      const state = fileStatesRef.current.get(path);
      if (!state) return true;

      // Clear the debounce timer.
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
      }

      // If not dirty, nothing to flush.
      if (!state.dirty) return true;

      // Await any in-flight save, then save the latest buffer.
      if (state.inFlightSave) {
        await state.inFlightSave;
      }

      return doSave(path);
    },
    [doSave],
  );

  /**
   * Flush all dirty files.
   */
  const flushAll = useCallback(async (): Promise<boolean> => {
    const allPaths = Array.from(fileStatesRef.current.keys());
    let allOk = true;
    for (const path of allPaths) {
      const ok = await flushPath(path);
      if (!ok) allOk = false;
    }
    return allOk;
  }, [flushPath]);

  /**
   * Retry saving a file that previously failed.
   */
  const retrySave = useCallback(
    async (path: string): Promise<boolean> => {
      const state = fileStatesRef.current.get(path);
      if (!state) return true;

      // Clear any debounce timer.
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
      }

      // Mark as dirty to force a save.
      state.dirty = true;
      updateDirtyState(path, true);

      // Await any in-flight save first.
      if (state.inFlightSave) {
        await state.inFlightSave;
      }

      return doSave(path);
    },
    [doSave, updateDirtyState],
  );

  /**
   * Persist editor metadata using the dedicated operation.
   * Surfaces metadata persistence errors via metadataError state.
   */
  const persistEditorState = useCallback(
    async (
      openTabs: string[],
      activeFile: string | null,
    ): Promise<WorkspaceProject | null> => {
      try {
        const updated = await queueRef.current.enqueue(() =>
          updateProjectEditorState(projectId, openTabs, activeFile),
        );
        setMetadataError(null);
        onProjectUpdate(updated);
        return updated;
      } catch (err) {
        // Surface metadata persistence errors as a visible controlled error.
        const msg = getErrorMessage(err);
        setMetadataError(msg);
        return null;
      }
    },
    [projectId, onProjectUpdate],
  );

  /**
   * Clear the metadata error.
   */
  const clearMetadataError = useCallback(() => {
    setMetadataError(null);
  }, []);

  /**
   * Clear all state for a file (on tab close).
   */
  const clearFile = useCallback((path: string) => {
    const state = fileStatesRef.current.get(path);
    if (state) {
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
      }
      fileStatesRef.current.delete(path);
    }
    updateDirtyState(path, false);
    updateErrorState(path, null);
  }, [updateDirtyState, updateErrorState]);

  /**
   * Get the current buffer for a file.
   */
  const getBuffer = useCallback((path: string): string | undefined => {
    const state = fileStatesRef.current.get(path);
    return state?.buffer;
  }, []);

  /**
   * Seed a file's initial buffer from persisted file records.
   * Only seeds if no buffer exists yet (doesn't overwrite unsaved changes).
   */
  const seedBuffer = useCallback((path: string, contents: string) => {
    const existing = fileStatesRef.current.get(path);
    if (existing) return; // Don't overwrite existing buffer

    fileStatesRef.current.set(path, {
      buffer: contents,
      editVersion: 0,
      lastPersistedVersion: 0,
      debounceTimer: null,
      inFlightSave: null,
      dirty: false,
      error: null,
    });
  }, []);

  // Cleanup all timers on unmount.
  useEffect(() => {
    const states = fileStatesRef.current;
    return () => {
      for (const [, state] of states) {
        if (state.debounceTimer) {
          clearTimeout(state.debounceTimer);
        }
      }
    };
  }, []);

  // Memoize the returned API object so it has stable identity across
  // renders. This prevents effect dependency cycles where a new object
  // identity triggers effects that cause re-renders.
  return useMemo(
    () => ({
      dirtyPaths,
      saveErrors,
      metadataError,
      isSaving,
      onContentChange,
      flushPath,
      flushAll,
      retrySave,
      persistEditorState,
      clearMetadataError,
      clearFile,
      getBuffer,
      seedBuffer,
    }),
    [
      dirtyPaths,
      saveErrors,
      metadataError,
      isSaving,
      onContentChange,
      flushPath,
      flushAll,
      retrySave,
      persistEditorState,
      clearMetadataError,
      clearFile,
      getBuffer,
      seedBuffer,
    ],
  );
}
