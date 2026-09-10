"use client";

/**
 * React lifecycle adapter for AgentExecutionRuntime (CoderXP M3.7).
 *
 * Binds the pure execution runtime controller to React components, the project
 * generation counter, the M3.6 permission controller, and tool handlers.
 *
 * ProjectShell remains the authoritative lifecycle owner.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AgentExecutionRuntime,
  type AgentExecutionAttempt,
  type AgentExecutionEvent,
  type SubmitOptions,
  type ToolExecutionContext,
} from "@/lib/workspace/agent-execution-runtime";
import type { AgentPermissionController, AgentToolCall } from "@/lib/workspace/agent-permissions";
import type { AgentToolResult } from "@/lib/workspace/agent-tools";

export interface UseAgentExecutionRuntimeOptions {
  projectId: string;
  generation: number;
  controller: AgentPermissionController;
  executeTool: (
    name: string,
    params: unknown,
    context: ToolExecutionContext,
  ) => Promise<AgentToolResult<unknown>>;
  onEvent?: (event: AgentExecutionEvent) => void;
}

export interface AgentExecutionRuntimeApi {
  runtime: AgentExecutionRuntime;
  activeHead: AgentExecutionAttempt | null;
  queueLength: number;
  attempts: AgentExecutionAttempt[];
  submit: (
    call: AgentToolCall,
    options?: SubmitOptions,
  ) => { attempt: AgentExecutionAttempt; isNew: boolean };
  resume: (attemptId: string) => Promise<boolean>;
  deny: (attemptId: string) => boolean;
  cancel: (attemptId: string) => boolean;
  cancelAll: () => number;
}

export function useAgentExecutionRuntime(
  options: UseAgentExecutionRuntimeOptions,
): AgentExecutionRuntimeApi {
  const { projectId, generation, controller, executeTool, onEvent } = options;

  const [revision, setRevision] = useState(0);

  const runtime = useMemo(() => {
    return new AgentExecutionRuntime({
      projectId,
      generation,
      controller,
      executeTool,
    });
  }, [projectId, generation, controller, executeTool]);

  useEffect(() => {
    return runtime.onEvent((event) => {
      setRevision((n) => n + 1);
      onEvent?.(event);
    });
  }, [runtime, onEvent]);

  // Sync generation changes to runtime
  useEffect(() => {
    if (runtime.getGeneration() !== generation) {
      runtime.invalidateGeneration(generation);
    }
  }, [generation, runtime]);

  // Cleanup on unmount or project change
  useEffect(() => {
    return () => {
      runtime.cancelAll("Workspace unmounted");
    };
  }, [runtime]);

  const submit = useCallback(
    (call: AgentToolCall, opts?: SubmitOptions) => {
      return runtime.submit(call, opts);
    },
    [runtime],
  );

  const resume = useCallback(
    (attemptId: string) => {
      return runtime.resume(attemptId);
    },
    [runtime],
  );

  const deny = useCallback(
    (attemptId: string) => {
      return runtime.deny(attemptId);
    },
    [runtime],
  );

  const cancel = useCallback(
    (attemptId: string) => {
      return runtime.cancel(attemptId);
    },
    [runtime],
  );

  const cancelAll = useCallback(() => {
    return runtime.cancelAll();
  }, [runtime]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const activeHead = useMemo(() => runtime.getActiveHead(), [runtime, revision]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const queueLength = useMemo(() => runtime.getQueueLength(), [runtime, revision]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const attempts = useMemo(() => runtime.getAllAttempts(), [runtime, revision]);

  return {
    runtime,
    activeHead,
    queueLength,
    attempts,
    submit,
    resume,
    deny,
    cancel,
    cancelAll,
  };
}
