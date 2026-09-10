"use client";

/**
 * Filesystem sync hook for CoderXP M3.4.
 *
 * Syncs WebContainer source files into IndexedDB after a completed
 * command (and after Run completes). Sync is allowed when the active
 * project is present in the shared WebContainer (isMounted), including
 * when Preview/runtime is currently idle — not only when runtime
 * state === "running".
 *
 * Lifecycle (M3.4 correction):
 * - invalidateProject() runs only on a real projectId change (ref compare).
 *   Sync status / progress / file-count must never be in that effect's deps.
 * - A generation token drops stale in-flight syncs so they cannot apply
 *   results or "invalidate" a newer pass.
 *
 * Contract:
 * - container -> IndexedDB additions YES
 * - container -> IndexedDB updates YES
 * - missing container file -> IndexedDB deletion NO
 *
 * Does not boot a second WebContainer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandResult } from "@/lib/workspace/command-controller";
import type { RuntimeState } from "@/lib/workspace/runtime";
import {
  isProjectPresentInContainer,
  syncContainerToIndexedDB,
  type FileSyncResult,
} from "@/lib/workspace/file-sync";

export type FileSyncStatus = "idle" | "syncing" | "error";

export interface FileSyncApi {
  /** Current sync status. */
  status: FileSyncStatus;
  /** Last successful sync result, or null. */
  lastResult: FileSyncResult | null;
  /** Last sync error message, or null. */
  error: string | null;
  /** Count of files added or updated in the last successful sync. */
  syncedCount: number;
  /** Files skipped as oversized or binary in the last sync. Not an error. */
  skippedCount: number;
  /** Run a sync pass now if the project is present in the container. */
  syncNow: () => Promise<void>;
  /**
   * Invalidate in-flight sync bookkeeping for a project switch.
   * Must only be used on a real project change.
   */
  invalidateProject: () => void;
}

function isCompletedState(state: CommandResult["state"]): boolean {
  return state === "exited" || state === "failed" || state === "cancelled";
}

/**
 * WebContainer -> IndexedDB sync, keyed to the open project.
 *
 * `onFilesChanged` is invoked after a sync that actually wrote files
 * so the caller can refresh the authoritative file list.
 */
export function useFileSync(
  projectId: string,
  commands: CommandResult[],
  runtimeState: RuntimeState,
  onFilesChanged?: () => void,
): FileSyncApi {
  const [status, setStatus] = useState<FileSyncStatus>("idle");
  const [lastResult, setLastResult] = useState<FileSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFilesChangedRef = useRef(onFilesChanged);
  const generationRef = useRef(0);
  const projectIdRef = useRef(projectId);
  const commandsRef = useRef(commands);
  const completedSeenRef = useRef<Set<string>>(new Set(commands.map((c) => c.id)));
  const prevRuntimeRef = useRef(runtimeState);

  useEffect(() => {
    onFilesChangedRef.current = onFilesChanged;
    commandsRef.current = commands;
  });

  const invalidateProject = useCallback(() => {
    generationRef.current += 1;
    setStatus("idle");
    setLastResult(null);
    setError(null);
    const seen = new Set<string>();
    for (const command of commandsRef.current) {
      seen.add(command.id);
    }
    completedSeenRef.current = seen;
  }, []);

  useEffect(() => {
    if (projectIdRef.current === projectId) return;
    projectIdRef.current = projectId;
    invalidateProject();
  }, [projectId, invalidateProject]);

  const syncNow = useCallback(async () => {
    if (!projectId) return;
    if (!isProjectPresentInContainer()) return;

    const gen = ++generationRef.current;
    setStatus("syncing");
    setError(null);

    const ownsSync = () => gen === generationRef.current;

    try {
      const result = await syncContainerToIndexedDB(projectId, ownsSync);
      if (gen !== generationRef.current) return;
      setLastResult(result);
      setStatus("idle");
      if (result.added > 0 || result.updated > 0) {
        onFilesChangedRef.current?.();
      }
    } catch (err) {
      if (gen !== generationRef.current) return;
      setStatus("error");
      setError(err instanceof Error ? err.message : "File sync failed.");
    }
  }, [projectId]);

  useEffect(() => {
    let sawNew = false;
    for (const command of commands) {
      if (!isCompletedState(command.state)) continue;
      if (completedSeenRef.current.has(command.id)) continue;
      completedSeenRef.current.add(command.id);
      sawNew = true;
    }
    if (!sawNew) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void syncNow();
  }, [commands, syncNow]);

  useEffect(() => {
    const prev = prevRuntimeRef.current;
    prevRuntimeRef.current = runtimeState;

    const runFinished =
      (prev === "starting" || prev === "installing") && runtimeState === "running";
    const runStopped = prev === "running" && runtimeState === "idle";
    if (runFinished || runStopped) {
      void syncNow();
    }
  }, [runtimeState, syncNow]);

  return {
    status,
    lastResult,
    error,
    syncedCount: lastResult ? lastResult.added + lastResult.updated : 0,
    skippedCount: lastResult ? lastResult.skipped : 0,
    syncNow,
    invalidateProject,
  };
}
