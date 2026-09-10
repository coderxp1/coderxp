"use client";

/**
 * React lifecycle adapter for AgentOrchestrator (CoderXP M3.8).
 *
 * Binds the pure iterative agent orchestrator to React components, the project
 * generation counter, the M3.7 execution runtime, and the streaming transport.
 *
 * Structural Invariant:
 * - Instance identity is strictly keyed by `projectId + generation`.
 * - All component callbacks, runtimes, and transports are routed through mutable refs,
 *   guaranteeing that component re-renders NEVER cause orchestrator recreation or disposal.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AgentOrchestrator,
  type OrchestrationBudgetOptions,
  type OrchestrationState,
  type OrchestratorLifecycleEvent,
} from "@/lib/workspace/agent-orchestrator";
import type { AgentExecutionRuntime } from "@/lib/workspace/agent-execution-runtime";
import type { AgentTransport, CanonicalAgentMessage } from "@/lib/workspace/agent-transport-types";

export interface UseAgentOrchestratorOptions {
  projectId: string;
  generation: number;
  runtime: AgentExecutionRuntime;
  transport?: AgentTransport;
  systemContext?: string;
  budgets?: OrchestrationBudgetOptions;
  onEvent?: (event: OrchestratorLifecycleEvent) => void;
}

export interface AgentOrchestratorApi {
  orchestrator: AgentOrchestrator;
  state: OrchestrationState;
  messages: CanonicalAgentMessage[];
  currentRunId: string | null;
  submitRun: (prompt: string) => { runId: string };
  cancel: (reason?: string) => boolean;
  setTransport: (transport: AgentTransport | null) => void;
}

export function useAgentOrchestrator(
  options: UseAgentOrchestratorOptions,
): AgentOrchestratorApi {
  const {
    projectId,
    generation,
    runtime,
    transport,
    systemContext,
    budgets,
    onEvent,
  } = options;

  const [revision, setRevision] = useState(0);

  // Store mutable options in refs to decouple from instance identity
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const systemContextRef = useRef(systemContext);
  systemContextRef.current = systemContext;
  const budgetsRef = useRef(budgets);
  budgetsRef.current = budgets;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // Key instance strictly by projectId + generation
  const orchestratorRef = useRef<AgentOrchestrator | null>(null);
  const keyRef = useRef<{ projectId: string; generation: number } | null>(null);

  if (
    !orchestratorRef.current ||
    keyRef.current?.projectId !== projectId ||
    keyRef.current?.generation !== generation
  ) {
    if (orchestratorRef.current) {
      orchestratorRef.current.dispose();
    }
    keyRef.current = { projectId, generation };
    orchestratorRef.current = new AgentOrchestrator({
      projectId,
      generation,
      runtime: runtimeRef.current,
      transport: transportRef.current,
      systemContext: systemContextRef.current,
      budgets: budgetsRef.current,
      onEvent: (event) => {
        setRevision((n) => n + 1);
        onEventRef.current?.(event);
      },
    });
  }

  const orchestrator = orchestratorRef.current;

  // Sync latest transport and runtime references into active instance
  useEffect(() => {
    if (transport) {
      orchestrator.setTransport(transport);
    }
  }, [transport, orchestrator]);

  // Dispose strictly on unmount
  useEffect(() => {
    return () => {
      orchestratorRef.current?.dispose();
    };
  }, []);

  const submitRun = useCallback(
    (prompt: string) => {
      return orchestrator.submitRun(prompt);
    },
    [orchestrator],
  );

  const cancel = useCallback(
    (reason?: string) => {
      return orchestrator.cancel(reason);
    },
    [orchestrator],
  );

  const setTransport = useCallback(
    (newTransport: AgentTransport | null) => {
      orchestrator.setTransport(newTransport);
    },
    [orchestrator],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const state = useMemo(() => orchestrator.getState(), [orchestrator, revision]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const messages = useMemo(() => orchestrator.getMessages(), [orchestrator, revision]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const currentRunId = useMemo(() => orchestrator.getRunId(), [orchestrator, revision]);

  return {
    orchestrator,
    state,
    messages,
    currentRunId,
    submitRun,
    cancel,
    setTransport,
  };
}
