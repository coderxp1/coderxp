"use client";

/**
 * Workspace state hook for CoderXP M2 Workspace Alpha.
 *
 * Correction (fix(workspace): unify operation ownership):
 *
 * 1. Token-owned actual-operation guard:
 *    WorkspaceOperationOwner { token: symbol; kind: ... }
 *    Release by exact owner identity (===), not by kind match.
 *    Retry is NOT a workspace operation kind.
 *
 * 2. retryingRef as synchronous Retry guard:
 *    retry() sets retryingRef = true, then the actual retried operation
 *    claims its real workspace operation (create/rename/delete/open/startup).
 *    Public user operations reject while retryingRef.current === true.
 *    Internal execution initiated by retry() is allowed to claim.
 *
 * 3. Centralized failure helpers with ref:
 *    installFailure(error, action) — updates ref + state synchronously
 *    clearFailureIfCurrent(actionId) — compare-and-set via ref, not closure
 *    dismissFailure() — clears ref + state
 *
 * 4. Internal execute functions report success/failure only.
 *    executeDelete does not clear error/retryAction on success.
 *    Retry settlement or the normal public wrapper owns failure-state clearing.
 *
 * 5. Split openProject into executeOpenProject (internal, takes owner) and
 *    handleOpenProject (public, claims open ownership).
 *    openProjectById returned to WorkspaceShell is the guarded public handler.
 *
 * 6. Synchronous ownership handoff from create to follow-up open.
 *    No async gap between release of create and claim of internal follow-up open.
 *
 * 7. PendingProjectOpen ownership remains until actual settlement.
 *    backToLauncher marks cancelled but does not null pendingOpenRef.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isWorkspacePersistenceAvailable,
  listProjects,
  getProject,
  getActiveProjectId,
  setActiveProjectId,
  createProjectFromTemplate,
  renameProject,
  deleteProject,
  listProjectEntries,
} from "@/lib/workspace/persistence";

import {
  getPersistenceErrorCode,
  type PersistenceErrorCode,
  type WorkspaceProject,
  type WorkspaceFileRecord,
  type ProjectTemplateId,
} from "@/lib/workspace/types";

export type WorkspaceView = "loading" | "launcher" | "project" | "error";

export interface WorkspaceError {
  code: PersistenceErrorCode;
  message: string;
}

export type RetryActionType =
  | "startup"
  | "openProject"
  | "createProject"
  | "renameProject"
  | "deleteProject";

export interface RetryAction {
  id: number;
  type: RetryActionType;
  projectId?: string;
  name?: string;
  templateId?: ProjectTemplateId;
}

/** Structured create result: creation and opening are separate outcomes. */
export type CreateProjectResult =
  | { created: false }
  | { created: true; project: WorkspaceProject; openStarted: boolean };

interface PendingProjectOpen {
  token: symbol;
  projectId: string;
  promise: Promise<WorkspaceProject | null>;
  cancelled: boolean;
}

/** Hook-level workspace operation guard: token-owned actual-operation guard. */
type WorkspaceOperationKind = "startup" | "create" | "open" | "rename" | "delete";

interface WorkspaceOperationOwner {
  token: symbol;
  kind: WorkspaceOperationKind;
  projectId?: string;
}

const CONTROLLED_ERROR_MESSAGES: Record<PersistenceErrorCode, string> = {
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

const GENERIC_ERROR_MESSAGE = "An unexpected local operation failed. Please try again.";

let retryActionIdCounter = 0;
function nextRetryActionId(): number {
  return ++retryActionIdCounter;
}

export function useWorkspaceState() {
  const [view, setView] = useState<WorkspaceView>("loading");
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [activeProject, setActiveProject] = useState<WorkspaceProject | null>(null);
  const [activeProjectFiles, setActiveProjectFiles] = useState<WorkspaceFileRecord[]>([]);
  const [error, setError] = useState<WorkspaceError | null>(null);
  const [persistenceAvailable, setPersistenceAvailable] = useState(true);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<RetryAction | null>(null);
  const [creationSuccessVersion, setCreationSuccessVersion] = useState(0);
  const [renameSuccessVersion, setRenameSuccessVersion] = useState(0);
  const [fileOperationVersion, setFileOperationVersion] = useState(0);

  const mountedRef = useRef(true);
  const openGenerationRef = useRef(0);
  const pendingOpenRef = useRef<PendingProjectOpen | null>(null);
  const retryingRef = useRef(false);
  const creatingRef = useRef(false);
  const renamingRef = useRef(false);
  const deletingRef = useRef(false);

  // Synchronous retry-action ref: updated by installFailure/clearFailureIfCurrent
  // before React state, so compare-and-set never uses a stale render closure.
  const retryActionRef = useRef<RetryAction | null>(null);

  // Hook-level workspace-operation guard: one synchronous token-owned record.
  const workspaceOpRef = useRef<WorkspaceOperationOwner | null>(null);
  const executeOpenProjectRef = useRef<(projectId: string, owner: WorkspaceOperationOwner) => Promise<WorkspaceProject | null>>(async () => null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Centralized failure helpers
  // -------------------------------------------------------------------------

  /** Install a failure: updates ref synchronously, then React state. */
  const installFailure = useCallback((err: WorkspaceError, action: RetryAction) => {
    retryActionRef.current = action;
    setError(err);
    setRetryAction(action);
  }, []);

  /** Compare-and-set clear: only clears if the current ref action matches actionId. */
  const clearFailureIfCurrent = useCallback((actionId: number) => {
    if (retryActionRef.current?.id === actionId) {
      retryActionRef.current = null;
      setError(null);
      setRetryAction(null);
    }
  }, []);

  /** Dismiss all failure state. */
  const dismissFailure = useCallback(() => {
    retryActionRef.current = null;
    setError(null);
    setRetryAction(null);
  }, []);

  // -------------------------------------------------------------------------
  // Workspace operation guard: token-owned, exact-identity release
  // -------------------------------------------------------------------------

  /** Claim a workspace operation. Returns the owner or null if already occupied. */
  const claimOperation = useCallback(
    (kind: WorkspaceOperationKind, projectId?: string): WorkspaceOperationOwner | null => {
      if (workspaceOpRef.current !== null) return null;
      const owner: WorkspaceOperationOwner = { token: Symbol(), kind, projectId };
      workspaceOpRef.current = owner;
      return owner;
    },
    [],
  );

  /** Release the workspace operation if the current owner is exactly `owner`. */
  const releaseOperation = useCallback(
    (owner: WorkspaceOperationOwner): void => {
      if (workspaceOpRef.current === owner) {
        workspaceOpRef.current = null;
      }
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Data helpers
  // -------------------------------------------------------------------------

  const toWorkspaceError = useCallback((err: unknown): WorkspaceError => {
    const code = getPersistenceErrorCode(err);
    if (code) {
      return {
        code,
        message: CONTROLLED_ERROR_MESSAGES[code] ?? GENERIC_ERROR_MESSAGE,
      };
    }
    return {
      code: "TRANSACTION_FAILED",
      message: GENERIC_ERROR_MESSAGE,
    };
  }, []);

  const reloadProjects = useCallback(async (): Promise<WorkspaceProject[]> => {
    const list = await listProjects();
    if (mountedRef.current) {
      setProjects(list);
    }
    return list;
  }, []);

  const insertProjectOrdered = useCallback((project: WorkspaceProject) => {
    setProjects((prev) => {
      const next = [...prev, project];
      next.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.id < b.id ? -1 : 1;
      });
      return next;
    });
  }, []);

  const replaceProjectInState = useCallback((updated: WorkspaceProject) => {
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== updated.id) return p;
        // Monotonic: reject older revisions.
        if (p.revision > updated.revision) return p;
        return updated;
      }),
    );
  }, []);

  const filterProjectFromState = useCallback((projectId: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
  }, []);

  // -------------------------------------------------------------------------
  // executeOpenProject: internal owned single-flight open
  // -------------------------------------------------------------------------

  /**
   * Internal executor: performs the actual project open.
   * Takes a pre-claimed owner; releases it by exact identity in finally.
   *
   * Single-flight using PendingProjectOpen:
   * - Same project: returns existing promise, releases caller's owner.
   * - Different project: serializes behind existing promise, releases
   *   caller's owner, then claims a new owner for the follow-up open.
   * - No existing: starts new open with the given owner.
   *
   * Does NOT clear error/retryAction on success — caller owns that.
   * Installs failure on error via installFailure (keeps ref in sync).
   */
  const executeOpenProject = useCallback(
    async (projectId: string, owner: WorkspaceOperationOwner): Promise<WorkspaceProject | null> => {
      const existing = pendingOpenRef.current;
      if (existing) {
        if (existing.projectId === projectId) {
          // Same project: return existing promise, release caller's owner.
          releaseOperation(owner);
          return existing.promise;
        }
        // Different project: serialize behind the existing promise.
        releaseOperation(owner);
        return existing.promise.then(async () => {
          if (pendingOpenRef.current === null) {
            const newOwner = claimOperation("open", projectId);
            if (newOwner) {
              return executeOpenProjectRef.current(projectId, newOwner);
            }
          }
          return null;
        });
      }

      const token = Symbol("projectOpen");
      const generation = ++openGenerationRef.current;

      let resolveOpen!: (project: WorkspaceProject | null) => void;
      const openPromise = new Promise<WorkspaceProject | null>((res) => {
        resolveOpen = res;
      });

      const pending: PendingProjectOpen = {
        token,
        projectId,
        promise: openPromise,
        cancelled: false,
      };
      pendingOpenRef.current = pending;
      setOpeningProjectId(projectId);

      try {
        const project = await getProject(projectId);

        if (pending.cancelled || generation !== openGenerationRef.current) {
          resolveOpen(null);
          return null;
        }
        if (!mountedRef.current) {
          resolveOpen(null);
          return null;
        }

        const files = await listProjectEntries(projectId);

        if (pending.cancelled || generation !== openGenerationRef.current) {
          resolveOpen(null);
          return null;
        }
        if (!mountedRef.current) {
          resolveOpen(null);
          return null;
        }

        // Write the active-project preference.
        await setActiveProjectId(projectId);

        if (pending.cancelled || generation !== openGenerationRef.current) {
          resolveOpen(null);
          return null;
        }
        if (!mountedRef.current) {
          resolveOpen(null);
          return null;
        }

        // Only the owned, non-cancelled open may update state.
        // Does NOT clear error/retryAction — caller owns that.
        setActiveProject(project);
        setActiveProjectFiles(files);
        setView("project");
        resolveOpen(project);
        return project;
      } catch (err) {
        if (pending.cancelled || generation !== openGenerationRef.current) {
          resolveOpen(null);
          return null;
        }
        if (!mountedRef.current) {
          resolveOpen(null);
          return null;
        }

        const we = toWorkspaceError(err);
        installFailure(we, { id: nextRetryActionId(), type: "openProject", projectId });
        resolveOpen(null);
        return null;
      } finally {
        // Release pending-open ownership: only if this exact record still owns it.
        if (pendingOpenRef.current === pending) {
          pendingOpenRef.current = null;
          if (mountedRef.current) {
            setOpeningProjectId(null);
          }
        }
        // Release workspace operation guard: only by exact owner identity.
        releaseOperation(owner);
      }
    },
    [toWorkspaceError, installFailure, releaseOperation, claimOperation],
  );

  // Keep the ref in sync so serialized opens can call the latest version.
  useEffect(() => {
    executeOpenProjectRef.current = executeOpenProject;
  }, [executeOpenProject]);

  // -------------------------------------------------------------------------
  // handleOpenProject: public UI entry, claims open ownership
  // -------------------------------------------------------------------------

  /**
   * Public handler for opening a project from the launcher.
   * Rejects if retrying or another operation is in progress.
   * Clears failure on success.
   */
  const handleOpenProject = useCallback(
    async (projectId: string): Promise<WorkspaceProject | null> => {
      if (retryingRef.current) return null;
      const owner = claimOperation("open", projectId);
      if (!owner) return null;
      const result = await executeOpenProject(projectId, owner);
      if (result) {
        dismissFailure();
      }
      return result;
    },
    [executeOpenProject, claimOperation, dismissFailure],
  );

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  /**
   * Startup: check persistence, load projects, open active project.
   *
   * Claims "startup" workspace operation. On success, clears prior errors.
   * On failure, installs error and retryAction.
   * Transfers ownership to "open" synchronously when opening active project.
   */
  const startup = useCallback(async () => {
    const owner = claimOperation("startup");
    if (!owner) return;

    const generation = ++openGenerationRef.current;

    if (!isWorkspacePersistenceAvailable()) {
      if (generation !== openGenerationRef.current) {
        releaseOperation(owner);
        return;
      }
      if (!mountedRef.current) {
        releaseOperation(owner);
        return;
      }
      setPersistenceAvailable(false);
      installFailure(
        {
          code: "PERSISTENCE_UNAVAILABLE",
          message: CONTROLLED_ERROR_MESSAGES.PERSISTENCE_UNAVAILABLE,
        },
        { id: nextRetryActionId(), type: "startup" },
      );
      setView("error");
      releaseOperation(owner);
      return;
    }

    try {
      const list = await reloadProjects();
      if (generation !== openGenerationRef.current) {
        releaseOperation(owner);
        return;
      }
      if (!mountedRef.current) {
        releaseOperation(owner);
        return;
      }

      setPersistenceAvailable(true);

      const activeId = await getActiveProjectId();
      if (generation !== openGenerationRef.current) {
        releaseOperation(owner);
        return;
      }
      if (!mountedRef.current) {
        releaseOperation(owner);
        return;
      }

      if (activeId) {
        const found = list.find((p) => p.id === activeId);
        if (found) {
          // Synchronous ownership handoff: startup → open
          const openOwner: WorkspaceOperationOwner = { token: Symbol(), kind: "open", projectId: activeId };
          workspaceOpRef.current = openOwner;
          const result = await executeOpenProject(activeId, openOwner);
          if (!mountedRef.current) return;
          if (result) {
            // Startup succeeded with active project: clear errors.
            dismissFailure();
          } else {
            // Open failed: show launcher with error + retry.
            setView("launcher");
          }
          return;
        }
      }
      // No active project or not found: clean launcher.
      dismissFailure();
      setView("launcher");
    } catch (err) {
      if (generation !== openGenerationRef.current) {
        releaseOperation(owner);
        return;
      }
      if (!mountedRef.current) {
        releaseOperation(owner);
        return;
      }
      const we = toWorkspaceError(err);
      installFailure(we, { id: nextRetryActionId(), type: "startup" });
      setView("error");
    } finally {
      // Release startup owner by exact identity.
      // If ownership was transferred to open, this is a no-op.
      releaseOperation(owner);
    }
  }, [reloadProjects, executeOpenProject, toWorkspaceError, installFailure, dismissFailure, claimOperation, releaseOperation]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!cancelled) await startup();
    };
    run();
    return () => { cancelled = true; };
  }, [startup]);

  // -------------------------------------------------------------------------
  // Execute functions: report success/failure only, do NOT clear failure
  // -------------------------------------------------------------------------

  /**
   * Execute creation WITHOUT clearing error/retryAction.
   * Claims "create" workspace operation.
   * On success: inserts project, increments creationSuccessVersion,
   *   synchronously hands off to "open" and fire-and-forgets the open.
   * Returns structured CreateProjectResult.
   */
  const executeCreate = useCallback(
    async (name: string, templateId: ProjectTemplateId): Promise<CreateProjectResult> => {
      if (creatingRef.current) return { created: false };
      const owner = claimOperation("create");
      if (!owner) return { created: false };
      creatingRef.current = true;

      setCreating(true);

      try {
        const project = await createProjectFromTemplate(name, templateId);
        if (!mountedRef.current) {
          releaseOperation(owner);
          return { created: true, project, openStarted: false };
        }

        // Creation committed: insert into state, signal success.
        insertProjectOrdered(project);
        setCreationSuccessVersion((v) => v + 1);

        // Release creation lock.
        creatingRef.current = false;
        if (mountedRef.current) {
          setCreating(false);
        }

        // Synchronous ownership handoff: create → open.
        // No async gap between release of create and claim of follow-up open.
        const openOwner: WorkspaceOperationOwner = { token: Symbol(), kind: "open", projectId: project.id };
        workspaceOpRef.current = openOwner;

        // Fire-and-forget: do NOT await opening as part of creation success.
        executeOpenProject(project.id, openOwner).then(() => {
          // executeOpenProject handles its own error/retryAction on failure.
        });

        return { created: true, project, openStarted: true };
      } catch (err) {
        if (!mountedRef.current) {
          releaseOperation(owner);
          return { created: false };
        }
        installFailure(toWorkspaceError(err), { id: nextRetryActionId(), type: "createProject", name, templateId });
        return { created: false };
      } finally {
        if (creatingRef.current) {
          creatingRef.current = false;
          if (mountedRef.current) {
            setCreating(false);
          }
        }
        // Release create owner by exact identity.
        // If ownership was transferred to open, this is a no-op.
        releaseOperation(owner);
      }
    },
    [insertProjectOrdered, executeOpenProject, toWorkspaceError, installFailure, claimOperation, releaseOperation],
  );

  /**
   * Public create handler. Rejects while retrying.
   * Clears failure at entry (not during retry).
   */
  const handleCreateProject = useCallback(
    async (name: string, templateId: ProjectTemplateId): Promise<boolean> => {
      if (retryingRef.current) return false;
      dismissFailure();
      const result = await executeCreate(name, templateId);
      return result.created;
    },
    [executeCreate, dismissFailure],
  );

  /**
   * Execute rename WITHOUT clearing error/retryAction.
   * Claims "rename" workspace operation.
   */
  const executeRename = useCallback(
    async (projectId: string, newName: string): Promise<boolean> => {
      if (renamingRef.current) return false;
      const owner = claimOperation("rename");
      if (!owner) return false;
      renamingRef.current = true;

      setRenaming(true);

      try {
        const updated = await renameProject(projectId, newName);
        if (!mountedRef.current) {
          releaseOperation(owner);
          return true;
        }

        setActiveProject(updated);
        replaceProjectInState(updated);
        setRenameSuccessVersion((v) => v + 1);

        return true;
      } catch (err) {
        if (!mountedRef.current) {
          releaseOperation(owner);
          return false;
        }
        installFailure(toWorkspaceError(err), { id: nextRetryActionId(), type: "renameProject", projectId, name: newName });
        return false;
      } finally {
        renamingRef.current = false;
        if (mountedRef.current) {
          setRenaming(false);
        }
        releaseOperation(owner);
      }
    },
    [replaceProjectInState, toWorkspaceError, installFailure, claimOperation, releaseOperation],
  );

  /**
   * Public rename handler. Rejects while retrying.
   * Clears failure at entry (not during retry).
   */
  const handleRenameProject = useCallback(
    async (projectId: string, newName: string): Promise<boolean> => {
      if (retryingRef.current) return false;
      dismissFailure();
      return executeRename(projectId, newName);
    },
    [executeRename, dismissFailure],
  );

  /**
   * Execute delete WITHOUT clearing error/retryAction.
   * Claims "delete" workspace operation.
   * On success: updates state (filter, clear active, set view) but does
   *   NOT clear error/retryAction — caller owns that.
   */
  const executeDelete = useCallback(
    async (projectId: string): Promise<boolean> => {
      if (deletingRef.current) return false;
      const owner = claimOperation("delete");
      if (!owner) return false;
      deletingRef.current = true;

      setDeleting(true);

      try {
        await deleteProject(projectId);
        if (!mountedRef.current) {
          releaseOperation(owner);
          return true;
        }

        filterProjectFromState(projectId);
        setActiveProject(null);
        setActiveProjectFiles([]);
        setView("launcher");

        return true;
      } catch (err) {
        if (!mountedRef.current) {
          releaseOperation(owner);
          return false;
        }
        installFailure(toWorkspaceError(err), { id: nextRetryActionId(), type: "deleteProject", projectId });
        return false;
      } finally {
        deletingRef.current = false;
        if (mountedRef.current) {
          setDeleting(false);
        }
        releaseOperation(owner);
      }
    },
    [filterProjectFromState, toWorkspaceError, installFailure, claimOperation, releaseOperation],
  );

  /**
   * Public delete handler. Rejects while retrying.
   * Clears failure at entry (not during retry).
   */
  const handleDeleteProject = useCallback(
    async (projectId: string): Promise<boolean> => {
      if (retryingRef.current) return false;
      dismissFailure();
      return executeDelete(projectId);
    },
    [executeDelete, dismissFailure],
  );

  // -------------------------------------------------------------------------
  // backToLauncher
  // -------------------------------------------------------------------------

  /**
   * Go back to the launcher view.
   *
   * Rejects while retrying (hook-level guard).
   * Marks the pending open as cancelled but does NOT null pendingOpenRef
   * while its database sequence is still running. The finally block in
   * executeOpenProject will clear it when the sequence settles.
   */
  const backToLauncher = useCallback(() => {
    if (retryingRef.current) return;
    openGenerationRef.current++;
    if (pendingOpenRef.current) {
      pendingOpenRef.current.cancelled = true;
      // Do NOT set pendingOpenRef.current = null here.
      // The finally block in executeOpenProject will clear it when the DB
      // sequence actually settles. This prevents a new open from
      // starting in parallel with the old one.
    }
    if (!pendingOpenRef.current) {
      setOpeningProjectId(null);
    }
    setActiveProject(null);
    setActiveProjectFiles([]);
    dismissFailure();
    setView("launcher");
  }, [dismissFailure]);

  // -------------------------------------------------------------------------
  // retry
  // -------------------------------------------------------------------------

  /**
   * Retry the actual failed operation.
   *
   * retryingRef is the synchronous Retry guard. retry() does NOT claim
   * a workspace operation — the actual retried operation claims its own
   * real operation (create/rename/delete/open/startup).
   *
   * Public user operations reject while retryingRef.current === true.
   * Internal execution initiated by retry() is allowed to claim.
   *
   * Uses compare-and-set via retryActionRef (not stale render closure):
   * clearFailureIfCurrent(action.id) only clears if no newer failure
   * was installed.
   */
  const retry = useCallback(async () => {
    const action = retryActionRef.current;
    if (!action) return;
    if (retryingRef.current) return;

    retryingRef.current = true;
    setRetrying(true);

    try {
      switch (action.type) {
        case "startup": {
          await startup();
          // startup installs its own failure on error, or clears on success.
          // Compare-and-set: only clear if still our action.
          clearFailureIfCurrent(action.id);
          break;
        }
        case "openProject": {
          if (action.projectId) {
            const owner = claimOperation("open", action.projectId);
            if (owner) {
              const result = await executeOpenProject(action.projectId, owner);
              if (result) {
                clearFailureIfCurrent(action.id);
              }
            }
          }
          break;
        }
        case "createProject": {
          if (action.name && action.templateId) {
            const result = await executeCreate(action.name, action.templateId);
            if (result.created) {
              // Creation succeeded. But follow-up open may have installed
              // a NEW retryAction (openProject failure). Compare-and-set:
              // only clear if the current action is still ours.
              clearFailureIfCurrent(action.id);
            }
          }
          break;
        }
        case "renameProject": {
          if (action.projectId && action.name) {
            const success = await executeRename(action.projectId, action.name);
            if (success) {
              clearFailureIfCurrent(action.id);
            }
          }
          break;
        }
        case "deleteProject": {
          if (action.projectId) {
            const success = await executeDelete(action.projectId);
            if (success) {
              clearFailureIfCurrent(action.id);
            }
          }
          break;
        }
      }
    } finally {
      retryingRef.current = false;
      if (mountedRef.current) {
        setRetrying(false);
      }
    }
  }, [startup, executeOpenProject, executeCreate, executeRename, executeDelete, claimOperation, clearFailureIfCurrent]);

  const dismissError = useCallback(() => {
    dismissFailure();
  }, [dismissFailure]);

  /**
   * Handles project state updates from the editor (activeFile, openTabs).
   * Updates both the active project state and the projects list.
   * Does NOT claim a workspace operation: this is a lightweight metadata
   * update, not a project lifecycle operation.
   *
   * Monotonic update: an older project revision arriving after a newer
   * revision is already in state is ignored, preventing stale overwrites.
   */
  const handleProjectUpdate = useCallback(
    (updated: WorkspaceProject) => {
      setActiveProject((prev) => {
        if (prev && prev.id === updated.id && prev.revision > updated.revision) {
          // Stale revision: ignore the older update.
          return prev;
        }
        return updated;
      });
      replaceProjectInState(updated);
    },
    [replaceProjectInState],
  );

  const refreshActiveProjectFiles = useCallback(
    async (projectId: string): Promise<void> => {
      try {
        const updatedFiles = await listProjectEntries(projectId);
        const updatedProject = await getProject(projectId);
        if (mountedRef.current) {
          setActiveProjectFiles(updatedFiles);
          setActiveProject(updatedProject);
          replaceProjectInState(updatedProject);
          setFileOperationVersion((v) => v + 1);
        }
      } catch {
        // Silently fail — the calling operation surfaces its own error.
      }
    },
    [replaceProjectInState],
  );

  return {
    view,
    projects,
    activeProject,
    activeProjectFiles,
    error,
    persistenceAvailable,
    creating,
    renaming,
    deleting,
    retrying,
    openingProjectId,
    retryAction,
    creationSuccessVersion,
    renameSuccessVersion,
    handleCreateProject,
    handleRenameProject,
    handleDeleteProject,
    handleProjectUpdate,
    backToLauncher,
    retry,
    dismissError,
    openProjectById: handleOpenProject,
    refreshActiveProjectFiles,
    fileOperationVersion,
  };
}
