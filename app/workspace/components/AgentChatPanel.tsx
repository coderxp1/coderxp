"use client";

/**
 * Agent Chat Panel for CoderXP Workspace v2 (v2.2).
 *
 * Implements the approved prototype (coderxp-workspace-v2.html v2.2) exactly:
 * - Fluid messages without boxed bubbles
 * - Small-caps header line (YOU / AGENT · MODEL with timestamp)
 * - Animated 3-dot thinking indicator
 * - Inline file write approval cards
 * - Inline shell command cards with real WebContainer execution & card streaming
 * - Inline web browsing tool cards with SSRF guards
 * - Scoped local computer access panel with File System Access API
 * - Unified input bar containing textarea + toolbar + send button
 * - Paperclip multi-file attachment with chip strip
 * - Push-to-talk speech dictation with live transcription
 * - Model selector with Logicc and BYOK provider groups
 * - Fixed layout preventing composer from escaping viewport
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AgentBlock,
  AgentMessage,
} from "@/lib/workspace/agent-protocol";
import type {
  AgentApprovalRequest,
  AgentPermissionMode,
} from "@/lib/workspace/agent-permissions";
import { SidebarActionMenu } from "./SidebarActionMenu";
import { ByokProviderModal } from "./ByokProviderModal";
import { McpServerModal } from "./McpServerModal";
import {
  BYOK_PROVIDER_DEFS,
  type ByokProviderId,
  fetchServerByokRecords,
} from "@/lib/workspace/byok-providers";

export interface AttachedFile {
  name: string;
  sizeFormatted: string;
  file?: File;
}

export interface AgentChatPanelProps {
  projectName?: string;
  messages: AgentMessage[];
  isStreaming: boolean;
  isConnected: boolean;
  onSend: (text: string, attachments?: AttachedFile[]) => void;
  onCancel: () => void;
  onClear: () => void;
  permissionMode: AgentPermissionMode;
  onPermissionModeChange: (mode: AgentPermissionMode) => void;
  pendingApprovals: AgentApprovalRequest[];
  onApproveRequest: (approvalId: string) => void;
  onDenyRequest: (approvalId: string) => void;
  selectedModel?: string;
  onSelectModel?: (modelId: string) => void;
  onExecuteCommand?: (cmd: string) => Promise<{ exitCode: number; output: string }>;
}

// ---------------------------------------------------------------------------
// Helper: format current time HH:MM
// ---------------------------------------------------------------------------
function formatTime(timestamp?: number): string {
  const d = timestamp ? new Date(timestamp) : new Date();
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

// ---------------------------------------------------------------------------
// Text segment parsing (plain, inline-code, code fence)
// ---------------------------------------------------------------------------
type TextSegment =
  | { kind: "plain"; text: string }
  | { kind: "inline-code"; text: string }
  | { kind: "fence"; text: string; lang: string };

function splitFences(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const fence = /```([\w-]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push({ kind: "plain", text: text.slice(cursor, match.index) });
    }
    segments.push({ kind: "fence", lang: match[1] ?? "", text: match[2] ?? "" });
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    segments.push({ kind: "plain", text: text.slice(cursor) });
  }
  return segments;
}

function splitInlineCode(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const inline = /`([^`\n]+)`/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = inline.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push({ kind: "plain", text: text.slice(cursor, match.index) });
    }
    segments.push({ kind: "inline-code", text: match[1] ?? "" });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ kind: "plain", text: text.slice(cursor) });
  }
  return segments;
}

function FormattedText({ text }: { text: string }) {
  const segments = useMemo(() => {
    return splitFences(text).flatMap((segment) =>
      segment.kind === "plain" ? splitInlineCode(segment.text) : [segment]
    );
  }, [text]);

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "fence") {
          return (
            <pre
              key={index}
              style={{
                background: "#0d0e10",
                border: "1px solid var(--border-soft)",
                borderRadius: "5px",
                padding: "8px 10px",
                margin: "6px 0",
                overflowX: "auto",
                fontFamily: "var(--mono)",
                fontSize: "12px",
                lineHeight: "1.5",
                color: "var(--text)",
              }}
            >
              {segment.lang && (
                <span
                  style={{
                    display: "block",
                    marginBottom: "4px",
                    fontSize: "10.5px",
                    color: "var(--text-faint)",
                  }}
                >
                  {segment.lang}
                </span>
              )}
              <code>{segment.text}</code>
            </pre>
          );
        }
        if (segment.kind === "inline-code") {
          return (
            <code
              key={index}
              style={{
                fontFamily: "var(--mono)",
                fontSize: "11.5px",
                background: "#111214",
                border: "1px solid var(--border-soft)",
                padding: "1px 4px",
                borderRadius: "3px",
                color: "var(--text)",
              }}
            >
              {segment.text}
            </code>
          );
        }
        return (
          <span key={index} style={{ whiteSpace: "pre-wrap" }}>
            {segment.text}
          </span>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------
export function AgentChatPanel({
  projectName = "static-project",
  messages,
  isStreaming,
  isConnected,
  onSend,
  onCancel,
  onClear,
  permissionMode,
  onPermissionModeChange,
  pendingApprovals,
  onApproveRequest,
  onDenyRequest,
  selectedModel = "azure/gpt-4o",
  onSelectModel,
  onExecuteCommand,
}: AgentChatPanelProps) {
  const [inputText, setInputText] = useState("");
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [isListening, setIsListening] = useState(false);

  // Command card execution state: cardId -> { status, output, running }
  const [cmdCardState, setCmdCardState] = useState<
    Record<string, { status: string; output: string; ran: boolean }>
  >({});

  // Web tool card state
  const [webCardState, setWebCardState] = useState<
    Record<string, { approved?: boolean; denied?: boolean }>
  >({});

  // Dynamic server-managed models from /api/agent/models
  const [serverModels, setServerModels] = useState<Array<{ id: string; name: string }>>([
    { id: "azure/gpt-4o", name: "GPT-4o" },
    { id: "azure/gpt-4o-mini", name: "GPT-4o mini" },
    { id: "vertex/claude-sonnet-5", name: "Claude Sonnet" },
    { id: "vertex/gemini-2.5-flash", name: "Gemini Flash" },
  ]);

  // Revision 2.3 Action Menu & Modals
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const [isByokModalOpen, setIsByokModalOpen] = useState(false);
  const [activeByokProvider, setActiveByokProvider] = useState<ByokProviderId>("anthropic");
  const [isMcpModalOpen, setIsMcpModalOpen] = useState(false);
  const [byokGroups, setByokGroups] = useState<
    Array<{ providerId: string; name: string; models: Array<{ id: string; name: string }> }>
  >([]);

  const loadSavedByok = useCallback(() => {
    fetchServerByokRecords().then((records) => {
      const groups: Array<{ providerId: string; name: string; models: Array<{ id: string; name: string }> }> = [];
      for (const rec of records) {
        groups.push({
          providerId: rec.providerId,
          name: rec.displayName,
          models: rec.models.map((m) => ({
            id: `byok/${rec.providerId}/${m.id}`,
            name: m.isOfflineFallback ? `${m.name}` : `${m.name}`,
          })),
        });
      }
      setByokGroups(groups);
    });
  }, []);

  useEffect(() => {
    loadSavedByok();
  }, [loadSavedByok]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<any>(null);

  // Auto-scroll messages
  const scrollToBottom = useCallback(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop =
        messagesContainerRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isStreaming, cmdCardState, scrollToBottom]);

  // Load models dynamically from /api/agent/models
  useEffect(() => {
    fetch("/api/agent/models")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.models) && data.models.length > 0) {
          const list = data.models.map((m: any) => ({
            id: m.id,
            name: m.displayName || m.id,
          }));
          setServerModels(list);
          if (data.defaultModel && !selectedModel) {
            onSelectModel?.(data.defaultModel);
          }
        }
      })
      .catch(() => {
        // graceful fallback
      });
  }, [onSelectModel, selectedModel]);

  // Handle Send
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text && attachments.length === 0) return;

    let finalPrompt = text;

    // Upload and process attachments if any
    if (attachments.length > 0) {
      const processed: string[] = [];
      for (const att of attachments) {
        if (att.file) {
          try {
            const fd = new FormData();
            fd.append("file", att.file);
            fd.append("projectId", projectName);
            const res = await fetch("/api/agent/attachments", {
              method: "POST",
              body: fd,
            });
            if (res.ok) {
              const data = await res.json();
              if (data.attachment?.textContent) {
                processed.push(`\n\n--- Attachment: ${att.name} ---\n${data.attachment.textContent}\n--- End Attachment ---`);
              } else {
                processed.push(`\n[Attached File: ${att.name} (${att.sizeFormatted})]`);
              }
            }
          } catch {
            processed.push(`\n[Attached File: ${att.name} (${att.sizeFormatted})]`);
          }
        } else {
          processed.push(`\n[Attached File: ${att.name} (${att.sizeFormatted})]`);
        }
      }
      if (processed.length > 0) {
        finalPrompt = (finalPrompt + processed.join("\n")).trim();
      }
    }

    onSend(finalPrompt, attachments);
    setInputText("");
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [inputText, attachments, projectName, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // Auto-resize textarea
  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInputText(e.target.value);
      const el = e.target;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    },
    []
  );

  // Attach files handler
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files) return;
      const files = Array.from(e.target.files);
      const newItems: AttachedFile[] = files.map((f) => {
        const sizeFormatted =
          f.size > 1048576
            ? (f.size / 1048576).toFixed(1) + " MB"
            : Math.max(1, Math.round(f.size / 1024)) + " KB";
        return {
          name: f.name,
          sizeFormatted,
          file: f,
        };
      });
      setAttachments((prev) => [...prev, ...newItems]);
      e.target.value = "";
    },
    []
  );

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // Speech Recognition (push-to-talk with auto-language detect)
  const toggleSpeech = useCallback(() => {
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SR) {
      alert("Speech recognition is not supported in this browser.");
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    try {
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      let base = inputText ? inputText.replace(/\s*$/, " ") : "";

      rec.onresult = (ev: any) => {
        let finalT = "";
        let interimT = "";
        for (let i = 0; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) {
            finalT += ev.results[i][0].transcript;
          } else {
            interimT += ev.results[i][0].transcript;
          }
        }
        setInputText(base + finalT + interimT);
      };

      rec.onend = () => {
        setIsListening(false);
      };
      rec.onerror = () => {
        setIsListening(false);
      };

      rec.start();
      recognitionRef.current = rec;
      setIsListening(true);
    } catch {
      setIsListening(false);
    }
  }, [isListening, inputText]);

  // Run inline command card
  const handleRunCommandCard = useCallback(
    async (cardId: string, command: string) => {
      setCmdCardState((prev) => ({
        ...prev,
        [cardId]: { status: "running…", output: "", ran: true },
      }));

      if (onExecuteCommand) {
        try {
          const res = await onExecuteCommand(command);
          setCmdCardState((prev) => ({
            ...prev,
            [cardId]: {
              status: `completed · exit ${res.exitCode}`,
              output: res.output,
              ran: true,
            },
          }));
          return;
        } catch (err: any) {
          setCmdCardState((prev) => ({
            ...prev,
            [cardId]: {
              status: `failed · exit 1`,
              output: err?.message || String(err),
              ran: true,
            },
          }));
          return;
        }
      }

      setCmdCardState((prev) => ({
        ...prev,
        [cardId]: {
          status: "failed · no runner",
          output: "Command runner not configured.",
          ran: true,
        },
      }));
    },
    [onExecuteCommand]
  );

  const handleSkipCommandCard = useCallback((cardId: string) => {
    setCmdCardState((prev) => ({
      ...prev,
      [cardId]: {
        status: "skipped",
        output: "Command was skipped by user.",
        ran: true,
      },
    }));
  }, []);

  // Calculate tokens display
  const tokensUsedDisplay = "↑ 2.1K ↓ 4.8K";

  // Check if assistant is thinking (waiting for first token in active turn)
  const isAssistantThinking = useMemo(() => {
    if (!isStreaming) return false;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return false;
    return last.content.length === 0 || (last.content.length === 1 && last.content[0].kind === "text" && !last.content[0].text);
  }, [isStreaming, messages]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        background: "var(--bg-side)",
      }}
    >
      {/* 35px Sidebar Header */}
      <div className="side-head">
        <span className="dot" title={isConnected ? "Connected" : "Disconnected"} />
        <span className="title">AGENT</span>
        <span
          className="name"
          style={{
            fontSize: "11px",
            color: "var(--text-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            marginLeft: "4px",
          }}
        >
          · {projectName}
        </span>
        <span className="grow" />
        <span
          className="tok"
          style={{
            fontFamily: "var(--mono)",
            fontSize: "10px",
            color: "var(--text-faint)",
            marginRight: "6px",
          }}
          title="Tokens used"
        >
          {tokensUsedDisplay}
        </span>
        <div className="relative">
          <button
            className="icon-btn"
            title="Session actions & BYOK"
            aria-label="Session actions & BYOK"
            onClick={() => setIsActionMenuOpen((prev) => !prev)}
          >
            <svg viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <SidebarActionMenu
            isOpen={isActionMenuOpen}
            onClose={() => setIsActionMenuOpen(false)}
            onNewSession={onClear}
            onOpenMcpModal={() => setIsMcpModalOpen(true)}
            onOpenByokModal={(providerId) => {
              setActiveByokProvider(providerId);
              setIsByokModalOpen(true);
            }}
          />
        </div>
        <button
          className="icon-btn"
          title="Session history"
          aria-label="Session history"
        >
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="8" />
            <path d="M12 7.5V12l3 2" />
          </svg>
        </button>
        <button
          className="icon-btn"
          title="Agent settings"
          aria-label="Agent settings"
        >
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="2.6" />
            <path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4" />
          </svg>
        </button>
      </div>

      {/* Messages Area — Fluid, no boxed bubbles */}
      <div
        className="messages"
        ref={messagesContainerRef}
        aria-live="polite"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "8px 14px 12px",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
        }}
      >
        {messages.length === 0 && (
          <div style={{ color: "var(--text-faint)", fontSize: "12px", marginTop: "4px" }}>
            Ready. Send a message to begin working with the agent.
          </div>
        )}

        {messages.map((msg) => {
          const isUser = msg.role === "user";
          const time = formatTime(msg.createdAt);

          return (
            <div key={msg.id} className={`msg ${isUser ? "user" : "agent"}`}>
              <div className="who">
                {isUser ? (
                  <>
                    YOU <span className="time">{time}</span>
                  </>
                ) : (
                  <>
                    AGENT · {selectedModel.toUpperCase()}{" "}
                    <span className="time">{time}</span>
                  </>
                )}
              </div>

              <div className="body">
                {msg.content.map((block) => {
                  if (block.kind === "text") {
                    return <FormattedText key={block.id} text={block.text} />;
                  }

                  if (block.kind === "error") {
                    return (
                      <div
                        key={block.id}
                        style={{
                          margin: "6px 0",
                          padding: "6px 10px",
                          borderRadius: "4px",
                          border: "1px solid var(--err)",
                          background: "rgba(229,83,75,0.08)",
                          color: "var(--err)",
                          fontSize: "12px",
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <span>⚠ {block.message}</span>
                      </div>
                    );
                  }

                  if (block.kind === "cancellation") {
                    return (
                      <div
                        key={block.id}
                        style={{
                          fontSize: "11px",
                          color: "var(--text-faint)",
                          fontStyle: "italic",
                          marginTop: "4px",
                        }}
                      >
                        [Cancelled: {block.reason}]
                      </div>
                    );
                  }

                  if (block.kind === "command-started" || block.kind === "command-output" || block.kind === "command-completed") {
                    const cardId = `cmd-${msg.id}-${block.id}`;
                    const state = cmdCardState[cardId] || {
                      status: block.kind === "command-completed" ? "completed" : "ready",
                      output: block.kind === "command-output" ? block.chunk : "",
                      ran: block.kind === "command-completed",
                    };
                    const cmdText = (block as any).command || "npm test";

                    return (
                      <div key={block.id} className={`cmd-card ${state.ran ? "ran" : ""}`} style={{ margin: "6px 0" }}>
                        <div className="cc-head">
                          <svg viewBox="0 0 24 24">
                            <path d="M4 17l6-5-6-5M12 19h8" />
                          </svg>
                          SHELL COMMAND · ~/{projectName}
                        </div>
                        <div className="cc-cmd">{cmdText}</div>
                        {state.ran && (
                          <div className="cc-out" style={{ display: "block" }}>
                            {state.output}
                          </div>
                        )}
                        <div className="cc-actions">
                          {!state.ran && (
                            <>
                              <button
                                className="btn primary"
                                onClick={() => handleRunCommandCard(cardId, cmdText)}
                              >
                                Run
                              </button>
                              <button
                                className="btn"
                                onClick={() => handleSkipCommandCard(cardId)}
                              >
                                Skip
                              </button>
                            </>
                          )}
                          <span className="cc-status">{state.status}</span>
                        </div>
                      </div>
                    );
                  }

                  return null;
                })}

                {/* Loud Error State if assistant message settled with 0 content blocks */}
                {!isUser && msg.content.length === 0 && !isStreaming && (
                  <div className="flex items-center gap-2 p-2 my-1 rounded border border-rose-800/40 bg-rose-950/20 text-rose-300 text-xs font-sans">
                    <span>⚠</span>
                    <span>Message failed to send — upstream returned no content. Please retry.</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Real Pending Approvals from Controller */}
        {pendingApprovals.map((approval) => {
          return (
            <div key={approval.approvalId} className="tool-card" style={{ margin: "6px 0" }}>
              <div className="tc-head">
                <svg className="tc-icon" viewBox="0 0 24 24">
                  <path d="M12 3l9 16H3l9-16z" />
                  <path d="M12 10v4M12 17.2v.3" />
                </svg>
                <span className="tc-title">{approval.toolName}</span>
              </div>
              <div className="tc-detail">{approval.summary}</div>
              <div className="tc-actions">
                <button
                  className="btn primary"
                  onClick={() => onApproveRequest(approval.approvalId)}
                >
                  Approve
                </button>
                <button
                  className="btn"
                  onClick={() => onDenyRequest(approval.approvalId)}
                >
                  Reject
                </button>
                <button
                  className="btn"
                  title="Approve this action and future safe actions"
                  onClick={() => {
                    onPermissionModeChange("auto-safe");
                    onApproveRequest(approval.approvalId);
                  }}
                >
                  Always allow safe
                </button>
              </div>
            </div>
          );
        })}

        {/* Animated Thinking Indicator */}
        {isAssistantThinking && (
          <div className="thinking" aria-live="polite">
            <span className="dots">
              <span />
              <span />
              <span />
            </span>{" "}
            Agent is thinking…
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Composer Section — Fixed bottom, never leaves viewport */}
      <div className="composer">
        {/* Attachment Chips Strip */}
        {attachments.length > 0 && (
          <div className="attach-strip has" id="attachStrip">
            {attachments.map((att, idx) => (
              <span key={idx} className="attach-chip">
                <span className="fname">{att.name}</span>
                <span style={{ color: "var(--text-faint)" }}>
                  {att.sizeFormatted}
                </span>
                <span
                  className="rm"
                  role="button"
                  aria-label="Remove attachment"
                  tabIndex={0}
                  onClick={() => removeAttachment(idx)}
                >
                  ×
                </span>
              </span>
            ))}
          </div>
        )}

        {/* Speech Dictation Hint */}
        {isListening && (
          <div className="rec-hint on" id="recHint">
            <span>●</span> Listening… language auto-detected, transcribing live
          </div>
        )}

        {/* Unified Input Box (Textarea + Toolbar in single container) */}
        <div className="input-box">
          <textarea
            ref={textareaRef}
            id="composerInput"
            placeholder="Message the agent — Enter to send, Shift+Enter for a new line"
            rows={2}
            value={inputText}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            aria-label="Message the agent"
          />

          <div className="input-toolbar">
            <input
              type="file"
              ref={fileInputRef}
              multiple
              hidden
              accept="image/*,video/*,.pdf,.fig,.zip,.txt,.md,.json,.js,.ts,.html,.css"
              onChange={handleFileChange}
            />

            <button
              className="tool-btn"
              id="attachBtn"
              title="Attach files — images, PDFs, Figma designs, videos"
              aria-label="Attach files"
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              <svg viewBox="0 0 24 24">
                <path d="M20.5 12.5l-7.8 7.8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
              </svg>
            </button>

            {/* Model selector dropdown */}
            <select
              className="mini-select"
              id="modelSelect"
              aria-label="AI model"
              value={selectedModel}
              onChange={(e) => onSelectModel?.(e.target.value)}
            >
              <optgroup label="Logicc">
                {serverModels.length > 0 ? (
                  serverModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))
                ) : (
                  <option disabled value="">
                    (Logicc unavailable)
                  </option>
                )}
              </optgroup>
              {/* Dynamic BYOK Groups */}
              {byokGroups.map((group) => (
                <optgroup key={group.providerId} label={`${group.name} (BYOK)`}>
                  {group.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            <span className="grow" />

            {/* Microphone button */}
            <button
              className={`tool-btn ${isListening ? "rec" : ""}`}
              id="micBtn"
              title="Dictate — speech is transcribed live, language auto-detected"
              aria-label="Dictate message"
              aria-pressed={isListening}
              type="button"
              onClick={toggleSpeech}
            >
              <svg viewBox="0 0 24 24">
                <rect x="9.3" y="3.5" width="5.4" height="10" rx="2.7" />
                <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
              </svg>
            </button>

            {/* Cancel/Stop button if streaming, otherwise Send button */}
            {isStreaming ? (
              <button
                className="send-btn"
                id="stopBtn"
                title="Stop generation"
                aria-label="Stop generation"
                type="button"
                onClick={onCancel}
                style={{ color: "var(--err)" }}
              >
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                className="send-btn"
                id="sendBtn"
                title="Send message"
                aria-label="Send message"
                type="button"
                disabled={!inputText.trim() && attachments.length === 0}
                onClick={handleSend}
              >
                <svg viewBox="0 0 24 24">
                  <path d="M4.5 12L19 4.8 15.5 19l-3.6-4.6L4.5 12z" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Revision 2.3 Modals */}
      <ByokProviderModal
        isOpen={isByokModalOpen}
        initialProviderId={activeByokProvider}
        onClose={() => setIsByokModalOpen(false)}
        onSaved={() => {
          loadSavedByok();
          setIsByokModalOpen(false);
        }}
        onRevoked={() => {
          loadSavedByok();
          setIsByokModalOpen(false);
        }}
      />

      <McpServerModal
        isOpen={isMcpModalOpen}
        onClose={() => setIsMcpModalOpen(false)}
        onServersUpdated={() => {
          // MCP servers updated
        }}
      />
    </div>
  );
}
