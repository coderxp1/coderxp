"use client";

/**
 * Editor panel for CoderXP Workspace v2.
 *
 * Renders the tabs bar, breadcrumb row, and CodeMirror editor on --bg-editor.
 * Preserves lossless editor persistence, dirty-file protection, and
 * buffer invalidation for agent tools.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { FileText, AlertCircle, RotateCw, ExternalLink } from "lucide-react";
import { EditorTabs } from "./EditorTabs";
import { CodeEditor } from "./CodeEditor";
import { getEntry } from "@/lib/workspace/persistence";
import { useEditorPersistence, type FileOpenRequest } from "@/app/workspace/hooks/useEditorPersistence";
import type { WorkspaceProject, WorkspaceFileRecord } from "@/lib/workspace/types";

interface EditorPanelProps {
  project: WorkspaceProject;
  files: WorkspaceFileRecord[];
  fileOpenRequest: FileOpenRequest | null;
  onProjectUpdate: (updated: WorkspaceProject) => void;
  onBack: () => void;
  projectOperationPending: boolean;
  flushAllRef: RefObject<(() => Promise<boolean>) | null>;
  invalidatePathsRef: RefObject<((paths: string[]) => void) | null>;
}

type ContentCache = Map<string, string>;
type LoadErrorMap = Map<string, string>;

export function EditorPanel({
  project,
  files,
  fileOpenRequest,
  onProjectUpdate,
  onBack,
  projectOperationPending,
  flushAllRef,
  invalidatePathsRef,
}: EditorPanelProps) {
  const persistence = useEditorPersistence(project.id, onProjectUpdate);

  const sanitizeTabs = useCallback(
    (tabs: string[], active: string | null): { tabs: string[]; active: string | null } => {
      const validFilePaths = new Set<string>();
      for (const f of files) {
        if (f.kind === "file") {
          validFilePaths.add(f.path);
        }
      }

      const sanitized: string[] = [];
      const seen = new Set<string>();
      for (const tab of tabs) {
        if (validFilePaths.has(tab) && !seen.has(tab)) {
          sanitized.push(tab);
          seen.add(tab);
        }
      }

      let sanitizedActive: string | null = null;
      if (active && validFilePaths.has(active)) {
        sanitizedActive = active;
      } else if (sanitized.length > 0) {
        sanitizedActive = sanitized[0];
      }

      return { tabs: sanitized, active: sanitizedActive };
    },
    [files],
  );

  const [openTabs, setOpenTabs] = useState<string[]>(() => {
    const { tabs } = sanitizeTabs(project.openTabs, project.activeFile);
    return tabs;
  });

  const [activeFile, setActiveFile] = useState<string | null>(() => {
    const { active } = sanitizeTabs(project.openTabs, project.activeFile);
    return active;
  });

  const [fileContents, setFileContents] = useState<Map<string, string>>(new Map());
  const [loadErrors, setLoadErrors] = useState<LoadErrorMap>(new Map());
  const [backError, setBackError] = useState<string | null>(null);

  const contentCacheRef = useRef<ContentCache>(new Map());
  const forcedReloadRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (flushAllRef) {
      flushAllRef.current = persistence.flushAll;
    }
    return () => {
      if (flushAllRef) {
        flushAllRef.current = null;
      }
    };
  }, [flushAllRef, persistence.flushAll]);

  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    if (!invalidatePathsRef) return;
    invalidatePathsRef.current = (paths: string[]) => {
      for (const p of paths) {
        persistence.clearFile(p);
        contentCacheRef.current.delete(p);
        forcedReloadRef.current.add(p);
      }
      setFileContents((prev) => {
        const next = new Map(prev);
        for (const p of paths) {
          next.delete(p);
        }
        return next;
      });
      setReloadVersion((v) => v + 1);
    };
    return () => {
      invalidatePathsRef.current = null;
    };
  }, [invalidatePathsRef, persistence]);

  useEffect(() => {
    const validPaths = new Set(files.filter((f) => f.kind === "file").map((f) => f.path));

    setOpenTabs((prevTabs) => {
      const filtered = prevTabs.filter((p) => validPaths.has(p));
      if (filtered.length !== prevTabs.length) {
        persistence.persistEditorState(filtered, activeFile && validPaths.has(activeFile) ? activeFile : filtered[0] ?? null);
      }
      return filtered;
    });

    setActiveFile((prevActive) => {
      if (prevActive && !validPaths.has(prevActive)) {
        const next = openTabs.filter((p) => validPaths.has(p))[0] ?? null;
        return next;
      }
      return prevActive;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  useEffect(() => {
    if (!fileOpenRequest) return;
    const { path } = fileOpenRequest;

    const fileExists = files.some((f) => f.path === path && f.kind === "file");
    if (!fileExists) return;

    setOpenTabs((prev) => {
      if (!prev.includes(path)) {
        const next = [...prev, path];
        persistence.persistEditorState(next, path);
        return next;
      }
      persistence.persistEditorState(prev, path);
      return prev;
    });
    setActiveFile(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileOpenRequest]);

  useEffect(() => {
    if (!activeFile) return;

    const needsForced = forcedReloadRef.current.has(activeFile);
    if (needsForced) {
      forcedReloadRef.current.delete(activeFile);
    }

    if (!needsForced && contentCacheRef.current.has(activeFile)) {
      const cached = contentCacheRef.current.get(activeFile)!;
      setFileContents((prev) => new Map(prev).set(activeFile, cached));
      persistence.seedBuffer(activeFile, cached);
      return;
    }

    let isMounted = true;
    getEntry(project.id, activeFile)
      .then((record) => {
        if (!isMounted) return;
        if (record && record.kind === "file" && record.contents !== undefined) {
          contentCacheRef.current.set(activeFile, record.contents);
          setFileContents((prev) => new Map(prev).set(activeFile, record.contents!));
          setLoadErrors((prev) => {
            const next = new Map(prev);
            next.delete(activeFile);
            return next;
          });
          persistence.seedBuffer(activeFile, record.contents);
        } else {
          setLoadErrors((prev) => new Map(prev).set(activeFile, `File not found in storage: ${activeFile}`));
        }
      })
      .catch((err) => {
        if (!isMounted) return;
        setLoadErrors((prev) => new Map(prev).set(activeFile, `Failed to load file: ${err instanceof Error ? err.message : "Unknown error"}`));
      });

    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile, project.id, reloadVersion]);

  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (persistence.dirtyPaths.size > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [persistence.dirtyPaths]);

  const handleCloseTab = useCallback(
    async (path: string) => {
      const tabIndex = openTabs.indexOf(path);
      if (tabIndex === -1) return;

      const ok = await persistence.flushPath(path);
      if (!ok) return;

      const nextTabs = openTabs.filter((t) => t !== path);
      let nextActive = activeFile;

      if (activeFile === path) {
        if (nextTabs.length === 0) {
          nextActive = null;
        } else if (tabIndex < nextTabs.length) {
          nextActive = nextTabs[tabIndex];
        } else {
          nextActive = nextTabs[nextTabs.length - 1];
        }
      }

      persistence.clearFile(path);
      contentCacheRef.current.delete(path);
      forcedReloadRef.current.delete(path);
      setFileContents((prev) => {
        const next = new Map(prev);
        next.delete(path);
        return next;
      });
      setLoadErrors((prev) => {
        const next = new Map(prev);
        next.delete(path);
        return next;
      });

      setOpenTabs(nextTabs);
      setActiveFile(nextActive);
      persistence.persistEditorState(nextTabs, nextActive);
    },
    [openTabs, activeFile, persistence],
  );

  const handleSelectTab = useCallback(
    (path: string) => {
      setActiveFile(path);
      persistence.persistEditorState(openTabs, path);
    },
    [openTabs, persistence],
  );

  const handleEditorChange = useCallback(
    (val: string) => {
      if (!activeFile) return;
      contentCacheRef.current.set(activeFile, val);
      setFileContents((prev) => new Map(prev).set(activeFile, val));
      persistence.onContentChange(activeFile, val);
    },
    [activeFile, persistence],
  );

  const handleRetrySave = useCallback(
    (path: string) => {
      persistence.retrySave(path);
    },
    [persistence],
  );

  const [previewLoading, setPreviewLoading] = useState(false);

  const handleOpenLivePreview = useCallback(async () => {
    setPreviewLoading(true);
    try {
      const res = await fetch("/api/preview/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        window.open(data.url, "_blank");
      } else {
        alert(data.error || "Could not generate live preview link.");
      }
    } catch (e: any) {
      alert("Failed to reach preview service: " + (e?.message || String(e)));
    } finally {
      setPreviewLoading(false);
    }
  }, [project.id]);

  const currentContent = activeFile ? fileContents.get(activeFile) ?? persistence.getBuffer(activeFile) ?? "" : "";
  const activeLoadError = activeFile ? loadErrors.get(activeFile) ?? null : null;
  const activeSaveError = activeFile ? persistence.saveErrors.get(activeFile) ?? null : null;

  if (!activeFile) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-editor)" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-faint)" }}>
          <FileText style={{ width: 32, height: 32, marginBottom: 12, opacity: 0.4 }} />
          <p style={{ fontSize: 13 }}>Select a file to start editing</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-editor)", overflow: "hidden" }}>
      {/* 35px Tab Bar with Live Preview button */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--bg-app)", borderBottom: "1px solid var(--border-soft)", height: 35, flex: "none" }}>
        <div style={{ flex: 1, minWidth: 0, overflowX: "auto", display: "flex", height: "100%" }}>
          <EditorTabs
            openTabs={openTabs}
            activeFile={activeFile}
            dirtyPaths={persistence.dirtyPaths}
            onSelect={handleSelectTab}
            onClose={handleCloseTab}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", padding: "0 10px", gap: 8, flex: "none" }}>
          <button
            type="button"
            className="btn live-preview-btn"
            title="Live Preview is temporarily disabled on shared infrastructure pending dedicated host migration."
            onClick={handleOpenLivePreview}
            disabled={true}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 25,
              padding: "0 10px",
              fontSize: 11.5,
              fontWeight: 600,
              color: "#94a3b8",
              backgroundColor: "rgba(148, 163, 184, 0.08)",
              border: "1px solid rgba(148, 163, 184, 0.25)",
              borderRadius: 4,
              cursor: "not-allowed",
              opacity: 0.7,
            }}
          >
            <ExternalLink style={{ width: 12, height: 12 }} />
            <span>Live Preview (Disabled)</span>
          </button>
        </div>
      </div>

      {/* 24px Breadcrumb Row */}
      <div className="breadcrumb">
        <span>{project.name}</span>
        <span className="sep">›</span>
        <span>{activeFile}</span>
      </div>

      {/* Editor Body */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative" }}>
        <CodeEditor
          filePath={activeFile}
          value={currentContent}
          onChange={handleEditorChange}
        />
      </div>

      {/* Load error banner */}
      {activeLoadError && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "rgba(229,83,75,0.1)", borderTop: "1px solid var(--err)", color: "var(--err)", fontSize: 11.5 }}>
          <AlertCircle style={{ width: 14, height: 14, flex: "none" }} />
          <span>{activeLoadError}</span>
        </div>
      )}

      {/* Save error banner */}
      {activeSaveError && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "rgba(229,83,75,0.1)", borderTop: "1px solid var(--err)", color: "var(--err)", fontSize: 11.5 }}>
          <AlertCircle style={{ width: 14, height: 14, flex: "none" }} />
          <span style={{ flex: 1 }}>{activeSaveError}</span>
          <button
            onClick={() => handleRetrySave(activeFile)}
            className="btn"
            style={{ display: "flex", alignItems: "center", gap: 4 }}
          >
            <RotateCw style={{ width: 12, height: 12 }} />
            Retry Save
          </button>
        </div>
      )}
    </div>
  );
}
