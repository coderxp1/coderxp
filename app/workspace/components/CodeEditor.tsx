"use client";

/**
 * CodeMirror editor for CoderXP M2 Workspace Alpha.
 *
 * Correction (fix(workspace): make editor persistence lossless):
 * - Removed component-local debounce saving. Save scheduling is now owned
 *   by the useEditorPersistence hook / EditorPanel.
 * - CodeEditor is a pure presentational component: it renders the editor
 *   and calls onChange on every content change. Persistence is handled
 *   by the parent.
 * - Dark theme matching the workspace obsidian/graphite palette.
 * - Language extensions resolved from file path.
 * - Read-only mode for directories and unsupported entries.
 */

import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { getLanguageExtension, getLanguageLabel } from "@/lib/workspace/lang";

interface CodeEditorProps {
  /** Path of the file being edited. */
  filePath: string;
  /** Current file contents. */
  value: string;
  /** Whether the editor is read-only. */
  readOnly?: boolean;
  /** Immediate callback on every content change. */
  onChange?: (value: string) => void;
}

/** Custom dark theme extension matching the workspace palette. */
const darkTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "#0d0e10",
      color: "#d4d4d4",
      height: "100%",
      fontSize: "13px",
    },
    ".cm-content": {
      caretColor: "#22d3ee",
      fontFamily:
        "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Monaco, 'Courier New', monospace",
      padding: "8px 0",
    },
    ".cm-gutters": {
      backgroundColor: "#0d0e10",
      color: "#4a4a4a",
      border: "none",
      borderRight: "1px solid #1e1e1e",
    },
    ".cm-activeLine": {
      backgroundColor: "#161719",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "#161719",
    },
    ".cm-selectionBackground, ::selection": {
      backgroundColor: "#264f78",
    },
    ".cm-cursor": {
      borderLeftColor: "#22d3ee",
    },
    ".cm-matchingBracket": {
      backgroundColor: "#1e3a5f",
      outline: "1px solid #3b82f6",
    },
    "&.cm-focused": {
      outline: "none",
    },
  },
  { dark: true },
);

export function CodeEditor({ filePath, value, readOnly = false, onChange }: CodeEditorProps) {
  const extensions = useMemo(() => getLanguageExtension(filePath), [filePath]);
  const languageLabel = useMemo(() => getLanguageLabel(filePath), [filePath]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-800 bg-[#0d0e10]">
        <span className="text-xs text-gray-500 font-mono">{filePath}</span>
        <span className="text-xs text-gray-600">{languageLabel}</span>
      </div>
      <div className="flex-1 overflow-hidden">
        <CodeMirror
          value={value}
          height="100%"
          theme={darkTheme}
          extensions={extensions}
          readOnly={readOnly}
          onChange={onChange}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            indentOnInput: true,
            tabSize: 2,
          }}
        />
      </div>
    </div>
  );
}
