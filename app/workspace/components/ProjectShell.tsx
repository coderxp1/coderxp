"use client";

/**
 * Open-project shell for CoderXP Workspace v2 (v2.2).
 *
 * Implements the approved VS Code-class IDE layout from coderxp-workspace-v2.html:
 * - 48px Activity Rail on the left (Explorer, Search, Source Control, Agent, Run/Debug, Account, Settings)
 * - 360px Resizable Agent Sidebar (280–560px) with keyboard accessibility (ArrowLeft/Right)
 * - 1fr Main area with Editor tabs (35px), breadcrumbs (24px), CodeMirror on --bg-editor
 * - 42vh Resizable Bottom Panel (140px–65vh) with PROBLEMS, OUTPUT, TERMINAL (xterm.js), PORTS
 * - 22px Full-width Status Bar (--status-bg)
 * - Mobile responsive overlay below 900px
 * - Zero marketing navigation inside /workspace
 */

import React, { useMemo, useState, useCallback, useRef, useEffect } from "react";
import {
  Folder,
  Search,
  GitBranch,
  Play,
  User,
  Settings,
  X,
  FilePlus,
  FolderPlus,
  Download,
  Trash2,
  AlertCircle,
} from "lucide-react";
import type { WorkspaceProject, WorkspaceFileRecord } from "@/lib/workspace/types";
import { buildFileTree } from "@/lib/workspace/project-tree";
import { FileTree } from "./FileTree";
import { EditorPanel } from "./EditorPanel";
import { RuntimePanel } from "./RuntimePanel";
import { AgentChatPanel, type AttachedFile } from "./AgentChatPanel";
import { StatusBar } from "./StatusBar";
import { useRuntime } from "../hooks/useRuntime";
import { useCommands } from "../hooks/useCommands";
import { useAgentChat } from "../hooks/useAgentChat";
import { useFileSync } from "../hooks/useFileSync";
import { useAgentTools } from "../hooks/useAgentTools";
import { useAgentPermissions } from "../hooks/useAgentPermissions";
import { useProjectGeneration } from "../hooks/useProjectGeneration";
import { useAgentExecutionRuntime } from "../hooks/useAgentExecutionRuntime";
import { useAgentOrchestrator } from "../hooks/useAgentOrchestrator";
import { useByokCredentials } from "../hooks/useByokCredentials";
import { HttpAgentTransport } from "@/lib/workspace/agent-http-transport";
import { AgentProcessStreamBridge } from "@/lib/workspace/agent-process-stream";
import { getCommandController } from "@/lib/workspace/command-controller";
import {
  putEntry,
  renameEntry,
  deleteEntry,
} from "@/lib/workspace/persistence";
import { isPersistenceError, type PersistenceErrorCode } from "@/lib/workspace/types";
import { getEntryName } from "@/lib/workspace/path-utils";
import { exportProjectZip } from "@/lib/workspace/export";
import type { FileOpenRequest } from "@/app/workspace/hooks/useEditorPersistence";
import { DevboxTimeline } from "./DevboxTimeline";

interface ProjectShellProps {
  project: WorkspaceProject;
  files: WorkspaceFileRecord[];
  renaming: boolean;
  deleting: boolean;
  projectOperationPending: boolean;
  renameSuccessVersion: number;
  fileOperationVersion: number;
  onBack: () => void;
  onRename: (newName: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onProjectUpdate: (updated: WorkspaceProject) => void;
  onRefreshFiles: () => Promise<void>;
}

type RailView = "explorer" | "search" | "git" | "agent" | "run" | "timeline";

export function ProjectShell({
  project,
  files,
  renaming,
  deleting,
  projectOperationPending,
  renameSuccessVersion,
  fileOperationVersion,
  onBack,
  onRename,
  onDelete,
  onProjectUpdate,
  onRefreshFiles,
}: ProjectShellProps) {
  // Activity rail & sidebar active view
  const [activeRail, setActiveRail] = useState<RailView>("agent");
  const [sidebarWidth, setSidebarWidth] = useState<number>(360);
  const [panelHeight, setPanelHeight] = useState<number>(() => {
    if (typeof window !== "undefined") {
      return Math.round(window.innerHeight * 0.42);
    }
    return 320;
  });
  const [isPanelMaximized, setIsPanelMaximized] = useState(false);
  const [selectedModel, setSelectedModel] = useState("azure/gpt-4o");

  // Selected file and open requests
  const [selectedPath, setSelectedPath] = useState<string | null>(project.activeFile);
  const [fileOpenRequest, setFileOpenRequest] = useState<FileOpenRequest | null>(null);
  const fileOpenCounterRef = useRef(0);

  // File operations (new file / folder / delete)
  const [newFileMode, setNewFileMode] = useState(false);
  const [newFileValue, setNewFileValue] = useState("");
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderValue, setNewFolderValue] = useState("");
  const [fileOpError, setFileOpError] = useState<string | null>(null);
  const [fileOpInProgress, setFileOpInProgress] = useState(false);
  const [entryToDelete, setEntryToDelete] = useState<string | null>(null);
  const [entryDeleteInProgress, setEntryDeleteInProgress] = useState(false);

  // Export state
  const [exportState, setExportState] = useState<"idle" | "exporting" | "error">("idle");
  const [exportError, setExportError] = useState<string | null>(null);

  // Editor refs
  const flushAllRef = useRef<(() => Promise<boolean>) | null>(null);
  const invalidatePathsRef = useRef<((paths: string[]) => void) | null>(null);

  // WebContainer runtime and commands
  const runtime = useRuntime(
    project.id,
    files,
    async () => (flushAllRef.current ? flushAllRef.current() : Promise.resolve(true)),
    project.templateId
  );
  const commands = useCommands();

  // Auto-sync
  useFileSync(project.id, commands.commands, runtime.state, onRefreshFiles);

  // Agent generation, permissions, and tool bridge
  const projectGeneration = useProjectGeneration(project.id);
  const permissions = useAgentPermissions({
    projectId: project.id,
    generation: projectGeneration.generation,
  });

  const tools = useAgentTools({
    projectId: project.id,
    templateId: project.templateId,
    controller: permissions.controller,
    getGeneration: projectGeneration.getGeneration,
    invalidateGeneration: projectGeneration.invalidate,
    runtimeState: runtime.state,
    previewUrl: runtime.previewUrl,
    runtimeError: runtime.error,
    onRefreshFiles,
    onRunProject: runtime.run,
    onStopProject: runtime.stop,
    onFlushEditor: async () => (flushAllRef.current ? flushAllRef.current() : true),
    onInvalidateEditorPaths: (paths) => invalidatePathsRef.current?.(paths),
  });

  const execution = useAgentExecutionRuntime({
    projectId: project.id,
    generation: projectGeneration.generation,
    controller: permissions.controller,
    executeTool: tools.executeTool,
    onEvent: (event) => chat.handleExecutionEvent(event),
  });

  const byok = useByokCredentials();
  const transport = useMemo(
    () => new HttpAgentTransport({ getApiKey: byok.getApiKey }),
    [byok.getApiKey]
  );

  const orchestrator = useAgentOrchestrator({
    projectId: project.id,
    generation: projectGeneration.generation,
    runtime: execution.runtime,
    transport,
    onEvent: (event) => chat.handleOrchestratorEvent(event),
  });

  const chat = useAgentChat(project.id, {
    generation: projectGeneration.generation,
    orchestrator,
  });

  useEffect(() => {
    const cmdController = getCommandController();
    const bridge = new AgentProcessStreamBridge(cmdController);
    const unsub = bridge.onEvent((event) => chat.handleProcessEvent(event));
    return () => {
      unsub();
      bridge.dispose();
    };
  }, [chat]);

  const handleApprove = useCallback(
    (approvalId: string) => permissions.approve(approvalId),
    [permissions]
  );

  const handleDeny = useCallback(
    (approvalId: string) => permissions.deny(approvalId),
    [permissions]
  );

  // File tree operations
  const fileTree = useMemo(() => buildFileTree(files), [files]);

  const handleFileSelect = useCallback((path: string) => {
    setSelectedPath(path);
    fileOpenCounterRef.current += 1;
    setFileOpenRequest({ path, requestId: fileOpenCounterRef.current });
  }, []);

  const handleCreateNewFile = useCallback(async () => {
    const name = newFileValue.trim();
    if (!name) {
      setNewFileMode(false);
      return;
    }
    setFileOpInProgress(true);
    setFileOpError(null);
    try {
      await putEntry(project.id, name, "file", "");
      await onRefreshFiles();
      setNewFileValue("");
      setNewFileMode(false);
      handleFileSelect(name);
    } catch (err: any) {
      setFileOpError(err?.message || "Failed to create file");
    } finally {
      setFileOpInProgress(false);
    }
  }, [newFileValue, project.id, onRefreshFiles, handleFileSelect]);

  const handleCreateNewFolder = useCallback(async () => {
    const name = newFolderValue.trim();
    if (!name) {
      setNewFolderMode(false);
      return;
    }
    setFileOpInProgress(true);
    setFileOpError(null);
    try {
      await putEntry(project.id, name, "directory");
      await onRefreshFiles();
      setNewFolderValue("");
      setNewFolderMode(false);
    } catch (err: any) {
      setFileOpError(err?.message || "Failed to create folder");
    } finally {
      setFileOpInProgress(false);
    }
  }, [newFolderValue, project.id, onRefreshFiles]);

  const handleExportZip = useCallback(async () => {
    setExportState("exporting");
    setExportError(null);
    try {
      const res = await exportProjectZip(
        project.id,
        project.name,
        async () => (flushAllRef.current ? flushAllRef.current() : true)
      );
      if (!res.ok) {
        setExportState("error");
        setExportError(res.error);
      } else {
        setExportState("idle");
      }
    } catch (err: any) {
      setExportState("error");
      setExportError(err?.message || "Export failed");
    }
  }, [project.id, project.name]);

  // Sidebar resize handlers
  const handleSidebarResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const newWidth = Math.min(560, Math.max(280, startW + delta));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [sidebarWidth]);

  const handleSidebarKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      setSidebarWidth((w) => Math.max(280, w - 16));
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      setSidebarWidth((w) => Math.min(560, w + 16));
      e.preventDefault();
    }
  }, []);

  // Panel resize handlers
  const handlePanelResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panelHeight;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = startY - moveEvent.clientY;
      const maxH = window.innerHeight * 0.65;
      const newHeight = Math.min(maxH, Math.max(140, startH + delta));
      setPanelHeight(newHeight);
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [panelHeight]);

  const handlePanelKeyDown = useCallback((e: React.KeyboardEvent) => {
    const maxH = window.innerHeight * 0.65;
    if (e.key === "ArrowUp") {
      setPanelHeight((h) => Math.min(maxH, h + 16));
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      setPanelHeight((h) => Math.max(140, h - 16));
      e.preventDefault();
    }
  }, []);

  // Execute command from agent card
  const handleExecuteCommand = useCallback(
    async (cmd: string) => {
      try {
        await commands.runCommand({ command: cmd, cwd: "/project" });
        return { exitCode: 0, output: `✓ command completed` };
      } catch (err: any) {
        return { exitCode: 1, output: err?.message || String(err) };
      }
    },
    [commands]
  );

  return (
    <div className="app">
      {/* 48px Activity Rail */}
      <nav className="rail" aria-label="Activity Rail">
        <button
          title="Explorer"
          aria-label="Explorer"
          className={activeRail === "explorer" ? "active" : ""}
          onClick={() => setActiveRail("explorer")}
        >
          <svg viewBox="0 0 24 24">
            <path d="M4 5a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5z" />
          </svg>
        </button>
        <button
          title="Search"
          aria-label="Search"
          className={activeRail === "search" ? "active" : ""}
          onClick={() => setActiveRail("search")}
        >
          <svg viewBox="0 0 24 24">
            <circle cx="10.5" cy="10.5" r="6" />
            <path d="M15.5 15.5 20 20" />
          </svg>
        </button>
        <button
          title="Source control"
          aria-label="Source control"
          className={activeRail === "git" ? "active" : ""}
          onClick={() => setActiveRail("git")}
        >
          <svg viewBox="0 0 24 24">
            <circle cx="7" cy="6" r="2.2" />
            <circle cx="7" cy="18" r="2.2" />
            <circle cx="17" cy="9" r="2.2" />
            <path d="M7 8.2v7.6M17 11.2c0 3-3 4-7 4.3" />
          </svg>
          <span className="badge">1</span>
        </button>
        <button
          title="Agent"
          aria-label="Agent"
          id="railAgent"
          className={activeRail === "agent" ? "active" : ""}
          onClick={() => setActiveRail("agent")}
        >
          <svg viewBox="0 0 24 24">
            <rect x="5" y="7" width="14" height="11" rx="2.5" />
            <circle cx="9.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
            <circle cx="14.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
            <path d="M12 7V4M9 18v2M15 18v2" />
          </svg>
        </button>
        <button
          title="Run and debug"
          aria-label="Run and debug"
          className={activeRail === "run" ? "active" : ""}
          onClick={() => setActiveRail("run")}
        >
          <svg viewBox="0 0 24 24">
            <path d="M8 5.5v13l11-6.5-11-6.5z" />
          </svg>
        </button>
        <button
          title="Activity Timeline"
          aria-label="Activity Timeline"
          id="railTimeline"
          className={activeRail === "timeline" ? "active" : ""}
          onClick={() => setActiveRail("timeline")}
        >
          <svg viewBox="0 0 24 24">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
        </button>

        <div className="spacer" />

        <button title="Back to Projects" aria-label="Back to Projects" onClick={onBack}>
          <svg viewBox="0 0 24 24">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <button title="Account" aria-label="Account">
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="9" r="3.5" />
            <path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5" />
          </svg>
        </button>
        <button title="Settings" aria-label="Settings">
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" />
          </svg>
        </button>
      </nav>

      {/* Persistent Left Sidebar */}
      <aside
        className="sidebar"
        id="sidebar"
        aria-label="Sidebar"
        style={{ width: `${sidebarWidth}px` }}
      >
        <div
          className="side-resize"
          id="sideResize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          tabIndex={0}
          onMouseDown={handleSidebarResizeMouseDown}
          onKeyDown={handleSidebarKeyDown}
        />

        {activeRail === "agent" && (
          <AgentChatPanel
            projectName={project.name}
            messages={chat.messages}
            isStreaming={chat.isStreaming}
            isConnected={chat.isConnected}
            onSend={chat.send}
            onCancel={chat.cancel}
            onClear={chat.clear}
            permissionMode={permissions.mode}
            onPermissionModeChange={permissions.setMode}
            pendingApprovals={permissions.pending}
            onApproveRequest={handleApprove}
            onDenyRequest={handleDeny}
            selectedModel={selectedModel}
            onSelectModel={setSelectedModel}
            onExecuteCommand={handleExecuteCommand}
          />
        )}

        {activeRail === "explorer" && (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
            <div className="side-head">
              <span className="title">EXPLORER</span>
              <span className="name" style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 4 }}>
                · {project.name}
              </span>
              <span className="grow" />
              <button
                className="icon-btn"
                title="New File"
                aria-label="New File"
                onClick={() => setNewFileMode(true)}
              >
                <FilePlus style={{ width: 14, height: 14 }} />
              </button>
              <button
                className="icon-btn"
                title="New Folder"
                aria-label="New Folder"
                onClick={() => setNewFolderMode(true)}
              >
                <FolderPlus style={{ width: 14, height: 14 }} />
              </button>
              <button
                className="icon-btn"
                title="Export Zip"
                aria-label="Export Zip"
                onClick={handleExportZip}
              >
                <Download style={{ width: 14, height: 14 }} />
              </button>
            </div>

            {newFileMode && (
              <div style={{ padding: "6px 10px", background: "var(--bg-input)", borderBottom: "1px solid var(--border)" }}>
                <input
                  type="text"
                  placeholder="New file name…"
                  value={newFileValue}
                  onChange={(e) => setNewFileValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateNewFile();
                    if (e.key === "Escape") setNewFileMode(false);
                  }}
                  autoFocus
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "1px solid var(--accent)",
                    borderRadius: 4,
                    padding: "3px 6px",
                    color: "var(--text)",
                    fontSize: 12,
                    fontFamily: "var(--mono)",
                    outline: "none",
                  }}
                />
              </div>
            )}

            {newFolderMode && (
              <div style={{ padding: "6px 10px", background: "var(--bg-input)", borderBottom: "1px solid var(--border)" }}>
                <input
                  type="text"
                  placeholder="New folder name…"
                  value={newFolderValue}
                  onChange={(e) => setNewFolderValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateNewFolder();
                    if (e.key === "Escape") setNewFolderMode(false);
                  }}
                  autoFocus
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "1px solid var(--accent)",
                    borderRadius: 4,
                    padding: "3px 6px",
                    color: "var(--text)",
                    fontSize: 12,
                    fontFamily: "var(--mono)",
                    outline: "none",
                  }}
                />
              </div>
            )}

            <div style={{ flex: 1, overflowY: "auto", padding: "6px 8px" }}>
              <FileTree
                nodes={fileTree}
                selectedPath={selectedPath}
                onSelect={handleFileSelect}
                onRename={async (oldPath, newPath) => {
                  try {
                    await renameEntry(project.id, oldPath, newPath);
                    await onRefreshFiles();
                    return true;
                  } catch {
                    return false;
                  }
                }}
                onDelete={(path) => setEntryToDelete(path)}
              />
            </div>
          </div>
        )}

        {(activeRail === "search" || activeRail === "git" || activeRail === "run") && (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: "12px" }}>
            <div className="side-head" style={{ padding: 0, marginBottom: 8 }}>
              <span className="title">{activeRail.toUpperCase()}</span>
            </div>
            <div style={{ color: "var(--text-faint)", fontSize: 12 }}>
              {activeRail === "search" && "Search files, symbols, and agent memory."}
              {activeRail === "git" && "Source control: 1 modified file. Ready to stage or commit via agent command cards."}
              {activeRail === "run" && "Run and debug configurations."}
            </div>
          </div>
        )}

        {activeRail === "timeline" && (
          <DevboxTimeline projectId={project.id} />
        )}
      </aside>

      {/* Main 1fr Area: Editor (top) + Panel (bottom) */}
      <main className="main">
        {/* Editor Area */}
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          <EditorPanel
            project={project}
            files={files}
            fileOpenRequest={fileOpenRequest}
            onProjectUpdate={onProjectUpdate}
            onBack={onBack}
            projectOperationPending={projectOperationPending}
            flushAllRef={flushAllRef}
            invalidatePathsRef={invalidatePathsRef}
          />
        </div>

        {/* Panel Drag Handle */}
        <div
          className="panel-resize"
          id="panelResize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize bottom panel"
          tabIndex={0}
          onMouseDown={handlePanelResizeMouseDown}
          onKeyDown={handlePanelKeyDown}
        />

        {/* Resizable Bottom Panel */}
        <div style={{ height: isPanelMaximized ? "65vh" : `${panelHeight}px`, flex: "none" }}>
          <RuntimePanel
            output={runtime.output}
            previewUrl={runtime.previewUrl}
            activePort={runtime.isRunning ? 3000 : null}
            onOpenPreview={() => runtime.previewUrl && window.open(runtime.previewUrl, "_blank")}
            onKillTerminal={() => {
              // kill active process
            }}
            onNewTerminal={() => {
              // restart shell
            }}
            isMaximized={isPanelMaximized}
            onToggleMaximize={() => setIsPanelMaximized((m) => !m)}
          />
        </div>
      </main>

      {/* Full-width 22px Status Bar */}
      <StatusBar
        branch="main"
        problemCount={0}
        warningCount={0}
        runtimeStatus={runtime.isRunning ? "Running" : "Ready"}
        syncStatus="Saved"
        modelName={selectedModel}
        activePort={runtime.isRunning ? 3000 : 3000}
        cursorLine={1}
        cursorCol={1}
        language={selectedPath?.endsWith(".html") ? "HTML" : selectedPath?.endsWith(".css") ? "CSS" : "TypeScript"}
      />

      {/* Delete confirmation modal */}
      {entryToDelete && (
        <div style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.6)" }}>
          <div style={{ maxWidth: 360, width: "100%", margin: "0 16px", padding: 16, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--err)", marginBottom: 8 }}>
              <Trash2 style={{ width: 18, height: 18 }} />
              <h3 style={{ fontSize: 13, fontWeight: 600 }}>Delete {getEntryName(entryToDelete)}</h3>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5, marginBottom: 16 }}>
              Are you sure you want to delete <span style={{ color: "var(--text)", fontFamily: "var(--mono)" }}>{entryToDelete}</span>? This action cannot be undone.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                className="btn"
                onClick={() => setEntryToDelete(null)}
                disabled={entryDeleteInProgress}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                style={{ background: "var(--err)", borderColor: "var(--err)" }}
                disabled={entryDeleteInProgress}
                onClick={async () => {
                  setEntryDeleteInProgress(true);
                  try {
                    await deleteEntry(project.id, entryToDelete);
                    await onRefreshFiles();
                    setEntryToDelete(null);
                  } catch (err: any) {
                    alert(err?.message || "Failed to delete");
                  } finally {
                    setEntryDeleteInProgress(false);
                  }
                }}
              >
                {entryDeleteInProgress ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
