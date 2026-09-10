"use client";

/**
 * File tree for CoderXP M2 Workspace Alpha.
 *
 * Commit 6 scope: adds inline rename and per-node delete controls.
 * - Chevron control toggles expansion for directories.
 * - Persisted directory name/row selects that directory.
 * - onSelect(node.path) is called for persisted directories.
 * - Implicit directories may expand but must not masquerade as stored records.
 * - Selected persisted directories display: Kind: directory.
 * - Keyboard-accessible buttons and visible selected styling.
 * - Inline rename input for files and persisted directories.
 * - Per-node delete button with compact confirmation handled by parent.
 *
 * The tree is generated from persisted entries via buildFileTree().
 * Directories before files, stable alphabetical ordering.
 */

import { useState, useEffect, useRef } from "react";
import { ChevronRight, ChevronDown, File as FileIcon, Folder, Pencil, Trash2 } from "lucide-react";
import type { FileTreeNode } from "@/lib/workspace/project-tree";

interface FileTreeProps {
  nodes: FileTreeNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Called when inline rename is submitted. Parent handles flush + persistence. */
  onRename: (oldPath: string, newPath: string) => Promise<boolean>;
  /** Called when a node's delete button is clicked. Parent handles flush + confirmation. */
  onDelete: (path: string) => void;
}

export function FileTree({ nodes, selectedPath, onSelect, onRename, onDelete }: FileTreeProps) {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => (
        <FileTreeNodeView
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

interface FileTreeNodeViewProps {
  node: FileTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onRename: (oldPath: string, newPath: string) => Promise<boolean>;
  onDelete: (path: string) => void;
}

function FileTreeNodeView({ node, depth, selectedPath, onSelect, onRename, onDelete }: FileTreeNodeViewProps) {
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [renamingInProgress, setRenamingInProgress] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isSelected = selectedPath === node.path;

  // Focus and select the rename input when it appears.
  useEffect(() => {
    if (renaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renaming]);

  // Reset rename value when node name changes (non-effect pattern to avoid lint).
  const [lastNodeName, setLastNodeName] = useState(node.name);
  if (lastNodeName !== node.name) {
    setLastNodeName(node.name);
    setRenameValue(node.name);
  }

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (renameValue.trim().length === 0 || renamingInProgress) return;

    // Compute the new full path.
    const parentPath = node.path.includes("/")
      ? node.path.slice(0, node.path.lastIndexOf("/"))
      : "";
    const newPath = parentPath ? `${parentPath}/${renameValue.trim()}` : renameValue.trim();

    if (newPath === node.path) {
      setRenaming(false);
      return;
    }

    setRenamingInProgress(true);
    const success = await onRename(node.path, newPath);
    setRenamingInProgress(false);
    if (success) {
      setRenaming(false);
    }
    // On failure, keep the rename input open with the value preserved.
  };

  const handleRenameCancel = () => {
    setRenaming(false);
    setRenameValue(node.name);
  };

  if (node.kind === "directory") {
    return (
      <div>
        <div
          className="group flex items-center w-full text-left text-sm rounded transition-colors"
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          {/* Chevron control: toggles expansion only */}
          <button
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? "Collapse" : "Expand"}
            className="flex items-center p-1 text-gray-500 hover:text-gray-300 transition-colors"
          >
            {expanded ? (
              <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />
            )}
          </button>
          {/* Directory name/row: selects if persisted, expands if implicit */}
          {renaming && node.isPersisted ? (
            <form onSubmit={handleRenameSubmit} className="flex items-center gap-1 flex-1">
              <input
                ref={renameInputRef}
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                maxLength={255}
                disabled={renamingInProgress}
                className="flex-1 px-1.5 py-0.5 text-xs text-gray-100 bg-gray-800 border border-gray-600 rounded focus:outline-none focus:border-cyan-600 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={renamingInProgress || renameValue.trim().length === 0}
                className="text-xs text-cyan-500 hover:text-cyan-400 disabled:opacity-50"
              >
                {renamingInProgress ? "..." : "OK"}
              </button>
              <button
                type="button"
                onClick={handleRenameCancel}
                disabled={renamingInProgress}
                className="text-xs text-gray-500 hover:text-gray-400 disabled:opacity-50"
              >
                Cancel
              </button>
            </form>
          ) : (
            <>
              <button
                onClick={() => {
                  if (node.isPersisted) {
                    onSelect(node.path);
                  } else {
                    setExpanded(!expanded);
                  }
                }}
                disabled={!node.isPersisted}
                className={`flex items-center gap-1.5 flex-1 py-1 pr-2 text-left rounded transition-colors ${
                  isSelected && node.isPersisted
                    ? "bg-cyan-950/40 text-cyan-300"
                    : node.isPersisted
                      ? "text-gray-300 hover:bg-gray-800/50"
                      : "text-gray-300 cursor-default"
                }`}
              >
                <Folder className="w-3.5 h-3.5 flex-shrink-0 text-gray-500" />
                <span className="truncate">{node.name}</span>
              </button>
              {node.isPersisted && (
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenaming(true);
                      setRenameValue(node.name);
                    }}
                    className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
                    aria-label="Rename"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(node.path);
                    }}
                    className="p-1 text-gray-500 hover:text-red-400 transition-colors"
                    aria-label="Delete"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        {expanded && node.children.length > 0 && (
          <div>
            {node.children.map((child) => (
              <FileTreeNodeView
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`group flex items-center w-full text-left text-sm rounded transition-colors ${
        isSelected
          ? "bg-cyan-950/40 text-cyan-300"
          : "text-gray-300 hover:bg-gray-800/50"
      }`}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      {renaming ? (
        <form onSubmit={handleRenameSubmit} className="flex items-center gap-1 flex-1 py-1">
          <input
            ref={renameInputRef}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            maxLength={255}
            disabled={renamingInProgress}
            className="flex-1 px-1.5 py-0.5 text-xs text-gray-100 bg-gray-800 border border-gray-600 rounded focus:outline-none focus:border-cyan-600 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={renamingInProgress || renameValue.trim().length === 0}
            className="text-xs text-cyan-500 hover:text-cyan-400 disabled:opacity-50"
          >
            {renamingInProgress ? "..." : "OK"}
          </button>
          <button
            type="button"
            onClick={handleRenameCancel}
            disabled={renamingInProgress}
            className="text-xs text-gray-500 hover:text-gray-400 disabled:opacity-50"
          >
            Cancel
          </button>
        </form>
      ) : (
        <>
          <button
            onClick={() => onSelect(node.path)}
            className={`flex items-center gap-1.5 flex-1 py-1 pr-2 text-left rounded transition-colors ${
              isSelected
                ? "text-cyan-300"
                : "text-gray-300 hover:bg-gray-800/50"
            }`}
          >
            <FileIcon className="w-3.5 h-3.5 flex-shrink-0 text-gray-500" />
            <span className="truncate">{node.name}</span>
          </button>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(true);
                setRenameValue(node.name);
              }}
              className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
              aria-label="Rename"
            >
              <Pencil className="w-3 h-3" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(node.path);
              }}
              className="p-1 text-gray-500 hover:text-red-400 transition-colors"
              aria-label="Delete"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
