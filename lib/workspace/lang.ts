/**
 * Language extension resolver for CodeMirror in CoderXP M2 Workspace Alpha.
 *
 * Commit 4 scope: maps file extensions to CodeMirror language extensions.
 * Returns an empty array for unsupported extensions so the editor still
 * works as a plain text editor.
 */

import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import type { Extension } from "@codemirror/state";

/**
 * Returns CodeMirror language extensions for the given file path.
 * Falls back to no language extension for unknown file types.
 */
export function getLanguageExtension(path: string): Extension[] {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();

  switch (ext) {
    case "js":
    case "mjs":
    case "jsx":
      return [javascript({ jsx: true })];
    case "ts":
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "html":
    case "htm":
      return [html()];
    case "css":
      return [css()];
    case "json":
      return [json()];
    default:
      return [];
  }
}

/**
 * Returns a human-readable language label for the given file path.
 */
export function getLanguageLabel(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();

  switch (ext) {
    case "js":
      return "JavaScript";
    case "mjs":
      return "ES Module";
    case "jsx":
      return "JSX";
    case "ts":
      return "TypeScript";
    case "tsx":
      return "TSX";
    case "html":
    case "htm":
      return "HTML";
    case "css":
      return "CSS";
    case "json":
      return "JSON";
    case "md":
      return "Markdown";
    default:
      return "Plain Text";
  }
}
