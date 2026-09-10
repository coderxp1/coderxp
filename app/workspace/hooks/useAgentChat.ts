"use client";

/**
 * Agent conversation controller for CoderXP M3.3 + M3.8.
 *
 * Owns the provider-independent transcript, connects to the M3.8 AgentOrchestrator,
 * and handles streaming lifecycle events and process outputs.
 *
 * Ownership rules:
 * - A generation token is bumped on project switch, on cancel, on clear,
 *   and at the start of each send. Any stream from an older generation is
 *   dropped: it cannot append chunks, finish, or fail a newer turn.
 * - Project switching aborts the active stream, so Project A can never
 *   write into Project B's transcript.
 * - When an orchestrator is attached, send() submits directly to the M3.8
 *   orchestrator engine.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_NOT_CONNECTED_MESSAGE,
  type AgentBlock,
  type AgentMessage,
  type AgentTransport,
} from "@/lib/workspace/agent-protocol";
import { TranscriptIngestionDispatcher } from "@/lib/workspace/agent-transcript-projector";
import type { ProcessStreamEvent } from "@/lib/workspace/agent-process-stream";
import type { AgentExecutionEvent } from "@/lib/workspace/agent-execution-runtime";
import type { OrchestratorLifecycleEvent } from "@/lib/workspace/agent-orchestrator";
import type { AgentOrchestratorApi } from "./useAgentOrchestrator";

export interface UseAgentChatOptions {
  generation?: number;
  orchestrator?: AgentOrchestratorApi;
}

export interface AgentChatApi {
  /** Transcript for the open project, oldest first. */
  messages: AgentMessage[];
  /** True while an assistant turn is streaming. */
  isStreaming: boolean;
  /** True when a transport is configured. */
  isConnected: boolean;
  /** Append a user message and start an assistant turn. */
  send: (text: string) => void;
  /** Abort the active stream and mark the message cancelled. */
  cancel: () => void;
  /** Abort any active stream and start a new conversation. */
  clear: () => void;
  /** Install or remove the transport. Null means not connected. */
  setTransport: (transport: AgentTransport | null) => void;
  /** Project execution runtime events into the active assistant message transcript. */
  handleExecutionEvent: (event: AgentExecutionEvent) => void;
  /** Project process stream events into the active assistant message transcript. */
  handleProcessEvent: (event: ProcessStreamEvent) => void;
  /** Handle orchestrator lifecycle events. */
  handleOrchestratorEvent: (event: OrchestratorLifecycleEvent) => void;
}

/** Appends a text delta to the trailing text block, or starts one. */
function appendTextDelta(content: AgentBlock[], text: string): AgentBlock[] {
  const last = content[content.length - 1];
  if (last && last.kind === "text") {
    const merged: AgentBlock = { ...last, text: last.text + text };
    return [...content.slice(0, -1), merged];
  }
  return [...content, { id: `b-${content.length}`, kind: "text", text }];
}

/** Appends a block, or replaces an existing block with the same id. */
function upsertBlock(content: AgentBlock[], block: AgentBlock): AgentBlock[] {
  const index = content.findIndex((existing) => existing.id === block.id);
  if (index === -1) return [...content, block];
  const next = content.slice();
  next[index] = block;
  return next;
}

/**
 * Conversation state keyed to the open project.
 */
export function useAgentChat(
  projectId: string,
  options?: UseAgentChatOptions,
): AgentChatApi {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  const idRef = useRef(0);
  const projectIdRef = useRef(projectId);
  const transportRef = useRef<AgentTransport | null>(null);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const activeProjectRef = useRef(projectId);
  activeProjectRef.current = projectId;

  const dispatcherRef = useRef(new TranscriptIngestionDispatcher());

  const orchestrator = options?.orchestrator;

  const nextId = useCallback((prefix: string) => {
    idRef.current += 1;
    return `${prefix}-${idRef.current}`;
  }, []);

  /** Aborts the active stream and invalidates any stream still running. */
  const invalidateStream = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  }, []);

  const setProject = useCallback(() => {
    invalidateStream();
    idRef.current = 0;
    dispatcherRef.current.clear();
    setMessages([]);
  }, [invalidateStream]);

  // Real project switches only.
  useEffect(() => {
    if (projectIdRef.current === projectId) return;
    projectIdRef.current = projectId;
    setProject();
  }, [projectId, setProject]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      generationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const setTransport = useCallback(
    (transport: AgentTransport | null) => {
      invalidateStream();
      transportRef.current = transport;
      if (orchestrator) {
        orchestrator.setTransport(transport as any);
      }
      setIsConnected(transport !== null);
    },
    [invalidateStream, orchestrator],
  );

  /** Mutates one message by id, leaving the rest of the transcript intact. */
  const patchMessage = useCallback(
    (messageId: string, patch: (message: AgentMessage) => AgentMessage) => {
      setMessages((prev) =>
        prev.map((message) => (message.id === messageId ? patch(message) : message)),
      );
    },
    [],
  );

  const handleExecutionEvent = useCallback(
    (event: AgentExecutionEvent) => {
      dispatcherRef.current.ingestExecutionEvent(event);
      const blocks = dispatcherRef.current.getBlocks();
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        if (last.role !== "assistant") return prev;
        return [...prev.slice(0, -1), { ...last, content: blocks }];
      });
    },
    [],
  );

  const handleProcessEvent = useCallback(
    (event: ProcessStreamEvent) => {
      dispatcherRef.current.ingestProcessEvent(event);
      const blocks = dispatcherRef.current.getBlocks();
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        if (last.role !== "assistant") return prev;
        return [...prev.slice(0, -1), { ...last, content: blocks }];
      });
    },
    [],
  );

  const handleOrchestratorEvent = useCallback(
    (event: OrchestratorLifecycleEvent) => {
      switch (event.type) {
        case "orchestrator:run-started": {
          setIsStreaming(true);
          break;
        }
        case "orchestrator:text-delta": {
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== "assistant") return prev;
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                status: "streaming",
                content: appendTextDelta(last.content, event.text),
              },
            ];
          });
          break;
        }
        case "orchestrator:tool-call-started": {
          const block: AgentBlock = {
            id: `call-${event.toolCallId}`,
            kind: "tool-call",
            toolCallId: event.toolCallId,
            name: event.toolName,
            input: "",
          };
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== "assistant") return prev;
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                status: "streaming",
                content: upsertBlock(last.content, block),
              },
            ];
          });
          break;
        }
        case "orchestrator:tool-call-delta": {
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== "assistant") return prev;
            const existingBlock = last.content.find((b) => b.id === `call-${event.toolCallId}`);
            const input = existingBlock && existingBlock.kind === "tool-call" ? existingBlock.input + event.chunk : event.chunk;
            const block: AgentBlock = {
              id: `call-${event.toolCallId}`,
              kind: "tool-call",
              toolCallId: event.toolCallId,
              name: existingBlock && existingBlock.kind === "tool-call" ? existingBlock.name : "tool",
              input,
            };
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                content: upsertBlock(last.content, block),
              },
            ];
          });
          break;
        }
        case "orchestrator:run-completed": {
          setIsStreaming(false);
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== "assistant") return prev;
            if (last.content.length === 0) {
              return [
                ...prev.slice(0, -1),
                {
                  ...last,
                  status: "error",
                  content: [
                    {
                      id: `err-${Date.now()}`,
                      kind: "error",
                      message: "Message failed to send — upstream returned no content. Please retry.",
                    },
                  ],
                },
              ];
            }
            return [
              ...prev.slice(0, -1),
              { ...last, status: "complete" },
            ];
          });
          break;
        }
        case "orchestrator:run-cancelled": {
          setIsStreaming(false);
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== "assistant") return prev;
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                status: "cancelled",
                content: [
                  ...last.content,
                  {
                    id: `cancel-${Date.now()}`,
                    kind: "cancellation",
                    reason: event.reason,
                  },
                ],
              },
            ];
          });
          break;
        }
        case "orchestrator:run-failed": {
          setIsStreaming(false);
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== "assistant") return prev;
            const isTimeout =
              event.error.code === "TIMEOUT" ||
              event.error.message.includes("timeout limit");
            const messageText = isTimeout
              ? "The running command or process reached its execution time limit. The process was active in the workspace and output collected so far has been captured.\n\nOptions: Choose Stop Process or Keep Waiting."
              : event.error.message;

            return [
              ...prev.slice(0, -1),
              {
                ...last,
                status: "error",
                content: [
                  ...last.content,
                  {
                    id: `err-${Date.now()}`,
                    kind: "error",
                    message: messageText,
                  },
                ],
              },
            ];
          });
          break;
        }
      }
    },
    [],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      invalidateStream();
      const generation = generationRef.current;
      const ownerProjectId = activeProjectRef.current;

      const userMessage: AgentMessage = {
        id: nextId("msg"),
        role: "user",
        content: [{ id: "b-0", kind: "text", text: trimmed }],
        createdAt: Date.now(),
        status: "complete",
      };

      const assistantId = nextId("msg");
      const assistantMessage: AgentMessage = {
        id: assistantId,
        role: "assistant",
        content: [],
        createdAt: Date.now(),
        status: "pending",
      };

      // If an orchestrator is configured, submit through the orchestrator
      if (orchestrator) {
        setMessages((prev) => [...prev, userMessage, assistantMessage]);
        setIsStreaming(true);
        try {
          orchestrator.submitRun(trimmed);
        } catch (err: any) {
          setIsStreaming(false);
          setMessages((prev) => [
            ...prev.slice(0, -1),
            {
              ...assistantMessage,
              status: "error",
              content: [
                {
                  id: "b-0",
                  kind: "error",
                  message: err instanceof Error ? err.message : String(err),
                },
              ],
            },
          ]);
        }
        return;
      }

      // Standalone mode when no orchestrator is provided
      const transport = transportRef.current;

      if (!transport) {
        const notice: AgentMessage = {
          id: nextId("msg"),
          role: "system",
          content: [
            { id: "b-0", kind: "error", message: AGENT_NOT_CONNECTED_MESSAGE },
          ],
          createdAt: Date.now(),
          status: "error",
        };
        setMessages((prev) => [...prev, userMessage, notice]);
        return;
      }

      let transcript: AgentMessage[] = [];
      setMessages((prev) => {
        transcript = [...prev, userMessage];
        return [...transcript, assistantMessage];
      });

      const controller = new AbortController();
      abortRef.current = controller;
      setIsStreaming(true);

      const owns = () =>
        generationRef.current === generation &&
        activeProjectRef.current === ownerProjectId;

      void (async () => {
        try {
          const stream = transport.send(
            { projectId: ownerProjectId, messages: transcript },
            controller.signal,
          );

          for await (const event of stream) {
            if (!owns()) return;

            if (event.type === "text-delta") {
              patchMessage(assistantId, (message) => ({
                ...message,
                status: "streaming",
                content: appendTextDelta(message.content, event.text),
              }));
              continue;
            }

            if (event.type === "block") {
              patchMessage(assistantId, (message) => ({
                ...message,
                status: "streaming",
                content: upsertBlock(message.content, event.block),
              }));
              continue;
            }

            if (event.type === "error") {
              patchMessage(assistantId, (message) => ({
                ...message,
                status: "error",
                content: [
                  ...message.content,
                  { id: `b-${message.content.length}`, kind: "error", message: event.message },
                ],
              }));
              return;
            }

            if (event.type === "done") break;
          }

          if (!owns()) return;
          patchMessage(assistantId, (message) => ({ ...message, status: "complete" }));
        } catch (err) {
          if (!owns()) return;
          const cancelled = controller.signal.aborted;
          patchMessage(assistantId, (message) => ({
            ...message,
            status: cancelled ? "cancelled" : "error",
            content: [
              ...message.content,
              cancelled
                ? {
                    id: `b-${message.content.length}`,
                    kind: "cancellation",
                    reason: "Cancelled",
                  }
                : {
                    id: `b-${message.content.length}`,
                    kind: "error",
                    message: err instanceof Error ? err.message : "Agent stream failed.",
                  },
            ],
          }));
        } finally {
          if (owns()) {
            abortRef.current = null;
            setIsStreaming(false);
          }
        }
      })();
    },
    [invalidateStream, nextId, orchestrator, patchMessage],
  );

  const cancel = useCallback(() => {
    if (orchestrator) {
      orchestrator.cancel();
      return;
    }
    if (!abortRef.current) return;
    invalidateStream();
    setMessages((prev) =>
      prev.map((message) =>
        message.status === "streaming" || message.status === "pending"
          ? {
              ...message,
              status: "cancelled",
              content: [
                ...message.content,
                {
                  id: `b-${message.content.length}`,
                  kind: "cancellation",
                  reason: "Cancelled",
                },
              ],
            }
          : message,
      ),
    );
  }, [invalidateStream, orchestrator]);

  const clear = useCallback(() => {
    invalidateStream();
    idRef.current = 0;
    dispatcherRef.current.clear();
    setMessages([]);
  }, [invalidateStream]);

  // Derived connection state
  const computedIsConnected = useMemo(() => {
    if (orchestrator) {
      return orchestrator.orchestrator.getTransport() !== null;
    }
    return isConnected;
  }, [orchestrator, isConnected]);

  // Derived streaming state
  const computedIsStreaming = useMemo(() => {
    if (orchestrator) {
      const st = orchestrator.state;
      return (
        st === "starting" ||
        st === "streaming" ||
        st === "assembling-tool-calls" ||
        st === "waiting-for-tools" ||
        st === "waiting-for-approval" ||
        st === "continuing"
      );
    }
    return isStreaming;
  }, [orchestrator, isStreaming]);

  return {
    messages,
    isStreaming: computedIsStreaming,
    isConnected: computedIsConnected,
    send,
    cancel,
    clear,
    setTransport,
    handleExecutionEvent,
    handleProcessEvent,
    handleOrchestratorEvent,
  };
}
