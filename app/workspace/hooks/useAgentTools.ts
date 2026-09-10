"use client";

/**
 * Agent tool binding for CoderXP M3.5 + M3.6.
 *
 * M3.5: builds the AgentToolContext from the live workspace layers and reaches
 * the M3.5 handlers under an ownership guard.
 *
 * M3.6: wraps tool invocation in a permission gate. `invoke` takes a full
 * AgentToolCall and calls gateAndInvoke, which consults the permission
 * controller and only reaches the handlers when a decision allows it:
 *
 *   future agent loop
 *        ↓
 *   gateAndInvoke (M3.6)
 *        ↓
 *   invokeAgentTool (M3.5)
 *        ↓
 *   real handler
 *
 * No agent-facing unchecked route is exposed.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { listProjectEntries } from "@/lib/workspace/persistence";
import { getRuntime, getRuntimeKind, type RuntimeState } from "@/lib/workspace/runtime";
import { isProjectPresentInContainer } from "@/lib/workspace/file-sync";
import {
  invokeAgentTool,
  type AgentToolContext,
} from "@/lib/workspace/agent-tool-handlers";
import {
  AGENT_TOOLS,
  type AgentToolDefinition,
  type AgentToolResult,
  type RuntimeStatusData,
} from "@/lib/workspace/agent-tools";
import {
  gateAndInvoke,
  type AgentPermissionController,
  type AgentToolCall,
  type GatedToolOutcome,
} from "@/lib/workspace/agent-permissions-gate";

import type { ToolExecutionContext } from "@/lib/workspace/agent-execution-runtime";

export interface AgentToolsApi {
  /** The tool manifest, for the M3.6 permission UI and the M3.9 adapters. */
  tools: readonly AgentToolDefinition[];
  /**
   * Invoke one exact tool call, subject to the permission layer.
   *
   * Returns an outcome rather than a bare tool result: a call may be executed,
   * paused awaiting approval, denied, or stale. M3.7 resumes a paused call by
   * invoking the identical AgentToolCall again after the user approves.
   */
  invoke: (call: AgentToolCall) => Promise<GatedToolOutcome>;
  /**
   * Direct handler executor passed to the M3.7 AgentExecutionRuntime.
   * Runs inside gateAndInvoke() under ownership checks.
   */
  executeTool: (
    name: string,
    params: unknown,
    context: ToolExecutionContext,
  ) => Promise<AgentToolResult<unknown>>;
  /** Invalidate in-flight tool calls. Only for a real project change. */
  invalidateProject: () => void;
}

export interface UseAgentToolsOptions {
  projectId: string;
  templateId: string | null;
  /**
   * The permission controller. Every agent-requested call is evaluated by it
   * before a handler runs. Supplied by useAgentPermissions so the controller
   * that the approval UI resolves is the same one the gate consults.
   */
  controller: AgentPermissionController;
  /**
   * Reads the live project generation. Shared with the permission controller
   * via useProjectGeneration: an approval is bound to a generation, and a call
   * captures one, so both must read the same counter.
   */
  getGeneration: () => number;
  /** Bumps the shared generation. Only for a real project change. */
  invalidateGeneration: () => void;
  /** Live runtime state from useRuntime. */
  runtimeState: RuntimeState;
  /** Live preview URL from useRuntime, or null. */
  previewUrl: string | null;
  /** Live runtime error from useRuntime, or null. */
  runtimeError: string | null;
  /** Refresh the workspace's authoritative file list. */
  onRefreshFiles: () => Promise<void>;
  /** Start the project. Supplied by useRuntime so flush-before-run is preserved. */
  onRunProject: () => Promise<void>;
  /** Stop the project. Supplied by useRuntime. */
  onStopProject: () => Promise<void>;
  /**
   * Flushes pending editor drafts to IndexedDB. This is the editor's existing
   * `flushAll`, exposed by EditorPanel. Resolves false when a save failed.
   */
  onFlushEditor: () => Promise<boolean>;
  /**
   * Drops editor buffers for paths the agent mutated. This is EditorPanel's
   * wrapper around the editor's existing `clearFile`.
   */
  onInvalidateEditorPaths: (paths: string[]) => void;
}

export function useAgentTools(options: UseAgentToolsOptions): AgentToolsApi {
  const {
    projectId,
    templateId,
    controller,
    getGeneration,
    invalidateGeneration,
    runtimeState,
    previewUrl,
    runtimeError,
    onRefreshFiles,
    onRunProject,
    onStopProject,
    onFlushEditor,
    onInvalidateEditorPaths,
  } = options;

  const getGenerationRef = useRef(getGeneration);
  const invalidateGenerationRef = useRef(invalidateGeneration);
  const controllerRef = useRef(controller);
  const projectIdRef = useRef(projectId);
  const runtimeStateRef = useRef(runtimeState);
  const previewUrlRef = useRef(previewUrl);
  const runtimeErrorRef = useRef(runtimeError);
  const templateIdRef = useRef(templateId);

  const refreshFilesRef = useRef(onRefreshFiles);
  const runProjectRef = useRef(onRunProject);
  const stopProjectRef = useRef(onStopProject);
  const flushEditorRef = useRef(onFlushEditor);
  const invalidateEditorPathsRef = useRef(onInvalidateEditorPaths);

  useEffect(() => {
    getGenerationRef.current = getGeneration;
    invalidateGenerationRef.current = invalidateGeneration;
    controllerRef.current = controller;
    projectIdRef.current = projectId;
    runtimeStateRef.current = runtimeState;
    previewUrlRef.current = previewUrl;
    runtimeErrorRef.current = runtimeError;
    templateIdRef.current = templateId;
    refreshFilesRef.current = onRefreshFiles;
    runProjectRef.current = onRunProject;
    stopProjectRef.current = onStopProject;
    flushEditorRef.current = onFlushEditor;
    invalidateEditorPathsRef.current = onInvalidateEditorPaths;
  });

  const invalidateProject = useCallback(() => {
    invalidateGenerationRef.current();
  }, []);

  const buildContext = useCallback(
    (owner: string, generation: number): AgentToolContext => {
      const ownsCall = () =>
        getGenerationRef.current() === generation &&
        projectIdRef.current === owner;

      const ctx: AgentToolContext = {
        projectId: owner,

        ownsCall,

        flushEditor: async () => {
          if (!ownsCall()) return true;
          return flushEditorRef.current();
        },

        invalidateEditorPaths: (paths: string[]) => {
          if (!ownsCall()) return;
          invalidateEditorPathsRef.current(paths);
        },

        refreshFiles: async () => {
          if (!ownsCall()) return;
          await refreshFilesRef.current();
        },

        syncProjectSource: async () => {
          if (!ownsCall()) return;
          const files = await listProjectEntries(owner);
          if (!ownsCall()) return;

          // 1. Sync to in-browser WebContainer if mounted
          const runtime = getRuntime();
          if (runtime.isMounted()) {
            const kind = getRuntimeKind(templateIdRef.current ?? "static-html");
            await runtime.syncProject(files, kind);
          }

          // 2. Sync to Linux Devbox container /workspace
          try {
            const textFiles = files
              .filter((f) => f.kind === "file" && typeof f.contents === "string")
              .map((f) => ({ path: f.path, contents: f.contents! }));
            if (textFiles.length > 0) {
              await fetch("/api/devbox/fs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId: owner, files: textFiles }),
              });
            }
          } catch {
            // ignore network/sync warnings
          }
        },

        getRuntimeStatus: (): RuntimeStatusData => ({
          state: runtimeStateRef.current,
          previewUrl: previewUrlRef.current,
          mounted: isProjectPresentInContainer(),
          error: runtimeErrorRef.current,
        }),

        runProject: async () => {
          await runProjectRef.current();
        },

        stopProject: async () => {
          await stopProjectRef.current();
        },
      };

      return ctx;
    },
    [],
  );

  const invoke = useCallback(
    async (call: AgentToolCall): Promise<GatedToolOutcome> => {
      const generation = getGenerationRef.current();
      return gateAndInvoke({
        controller: controllerRef.current,
        call,
        generation,
        execute: (name, params) =>
          invokeAgentTool(buildContext(call.projectId, generation), name, params),
      });
    },
    [buildContext],
  );

  const executeTool = useCallback(
    async (
      name: string,
      params: unknown,
      context: ToolExecutionContext,
    ): Promise<AgentToolResult<unknown>> => {
      const generation = getGenerationRef.current();
      return invokeAgentTool(buildContext(context.projectId, generation), name, params);
    },
    [buildContext],
  );

  return useMemo(
    () => ({ tools: AGENT_TOOLS, invoke, executeTool, invalidateProject }),
    [invoke, executeTool, invalidateProject],
  );
}
