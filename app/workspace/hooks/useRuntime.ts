"use client";

/**
 * Runtime hook for CoderXP M2 Workspace Alpha.
 *
 * Commit 5 scope: manages the WebContainer runtime lifecycle from React.
 *
 * - Lazily boots WebContainer on first Run
 * - Mounts project files into /project
 * - Spawns the real static server process
 * - Captures real stdout/stderr
 * - Receives the real server-ready URL
 * - Generation-based process ownership
 * - Stop / switch / error recovery
 *
 * No fake terminal output, fake build messages, or fake preview URLs.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getRuntime, getRuntimeKind, type RuntimeState, type RuntimeKind, type OutputLine } from "@/lib/workspace/runtime";
import { getTerminal } from "@/lib/workspace/terminal";
import { getCommandController } from "@/lib/workspace/command-controller";
import { listProjectEntries } from "@/lib/workspace/persistence";
import type { WorkspaceFileRecord } from "@/lib/workspace/types";

export interface RuntimeApi {
  /** Current runtime state. */
  state: RuntimeState;
  /** Output lines from the process. */
  output: OutputLine[];
  /** Preview URL from the real server-ready event, or null. */
  previewUrl: string | null;
  /** Runtime error message, or null. */
  error: string | null;
  /** Whether a Run is in progress (booting/mounting/starting). */
  isStarting: boolean;
  /** Whether the runtime is currently running. */
  isRunning: boolean;
  /** Key to force iframe refresh. */
  previewKey: number;

  /**
   * Run the current project. Flushes all dirty editor buffers first.
   * If flush fails, Run does not begin.
   */
  run: () => Promise<void>;

  /** Stop the current runtime process. */
  stop: () => Promise<void>;

  /** Refresh the preview iframe. */
  refreshPreview: () => void;

  /** Clear the error state. */
  clearError: () => void;

  /** Switch to a new project (stop old, remount new). */
  switchProject: (files: WorkspaceFileRecord[]) => Promise<void>;

  /** Invalidate all commands for the current project (project switch). */
  invalidateCommands: () => void;
}

export function useRuntime(
  projectId: string | null,
  files: WorkspaceFileRecord[],
  flushAll: () => Promise<boolean>,
  templateId: string | null,
): RuntimeApi {
  const [state, setState] = useState<RuntimeState>("idle");
  const [output, setOutput] = useState<OutputLine[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);

  const runtimeRef = useRef<ReturnType<typeof getRuntime> | null>(null);
  const projectIdRef = useRef<string | null>(null);

  // Initialize runtime on mount, dispose on unmount.
  useEffect(() => {
    const runtime = getRuntime();
    runtimeRef.current = runtime;

    runtime.onStateChange((s) => setState(s));
    runtime.onOutput((line) => {
      setOutput((prev) => [...prev, line]);
    });
    runtime.onPreviewUrl((url) => setPreviewUrl(url));
    runtime.onError((msg) => setError(msg));

    return () => {
      runtime.dispose();
      runtimeRef.current = null;
    };
  }, []);

  // Switch project when projectId changes.
  useEffect(() => {
    if (projectIdRef.current === projectId) return;
    projectIdRef.current = projectId;

    if (projectId && files.length > 0 && runtimeRef.current) {
      // Clear output on project switch.
      setOutput([]);
      setError(null);
      setPreviewUrl(null);
      const kind = getRuntimeKind(templateId ?? "static-html");
      runtimeRef.current.switchProject(files, kind);
    }
  }, [projectId, files, templateId]);

  const run = useCallback(async () => {
    if (!runtimeRef.current) return;

    // Flush all dirty editor buffers before running.
    const ok = await flushAll();
    if (!ok) {
      setError("Some files could not be saved. Fix the errors before running.");
      setState("error");
      return;
    }

    // Clear previous output and error.
    setOutput([]);
    setError(null);
    setPreviewUrl(null);

    // Read the authoritative current project files from IndexedDB.
    // The files prop is the snapshot from when the project was opened;
    // editor putEntry() saves to IndexedDB but does not refresh that array.
    // After a successful flush, IndexedDB has the latest content.
    if (!projectId) {
      setError("No project open.");
      setState("error");
      return;
    }

    let freshFiles: WorkspaceFileRecord[];
    try {
      freshFiles = await listProjectEntries(projectId);
    } catch {
      setError("Failed to read project files from storage.");
      setState("error");
      return;
    }

    if (freshFiles.length === 0) {
      setError("Project has no files to run.");
      setState("error");
      return;
    }

    const kind = getRuntimeKind(templateId ?? "static-html");

    // If the same project is already mounted, sync source files without
    // destroying node_modules. This preserves installed dependencies across
    // Run presses. mountProject (full remount) is only used on first mount
    // or project switch.
    if (runtimeRef.current.isMounted()) {
      await runtimeRef.current.syncProject(freshFiles, kind);
    } else {
      await runtimeRef.current.mountProject(freshFiles, kind);
    }

    // Mark the command controller as mounted so commands can run.
    getCommandController().setMounted(true);

    await runtimeRef.current.run();
  }, [flushAll, projectId, templateId]);

  const stop = useCallback(async () => {
    if (!runtimeRef.current) return;
    await runtimeRef.current.stop();
  }, []);

  const refreshPreview = useCallback(() => {
    setPreviewKey((k) => k + 1);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setState("idle");
  }, []);

  const switchProject = useCallback(async (newFiles: WorkspaceFileRecord[]) => {
    if (!runtimeRef.current) return;
    setOutput([]);
    setError(null);
    setPreviewUrl(null);

    // Reset the terminal so it operates on the new project only.
    const terminal = getTerminal();
    await terminal.reset();

    // Invalidate all commands from the old project.
    const cmdController = getCommandController();
    cmdController.invalidateProject();
    cmdController.clearHistory();

    const kind = getRuntimeKind(templateId ?? "static-html");
    await runtimeRef.current.switchProject(newFiles, kind);
    cmdController.setMounted(true);
  }, [templateId]);

  const invalidateCommands = useCallback(() => {
    const cmdController = getCommandController();
    cmdController.invalidateProject();
    cmdController.clearHistory();
  }, []);

  return {
    state,
    output,
    previewUrl,
    error,
    isStarting: state === "booting" || state === "mounting" || state === "installing" || state === "starting",
    isRunning: state === "running",
    previewKey,
    run,
    stop,
    refreshPreview,
    clearError,
    invalidateCommands,
    switchProject,
  };
}
