"use client";

/**
 * Client-only loading boundary for the CoderXP workspace.
 *
 * This component dynamically imports the workspace shell with ssr: false
 * to ensure browser-only APIs (WebContainer, CodeMirror, IndexedDB) are
 * never accessed during server-side rendering.
 *
 * Commit 1 scope: loading boundary only. The actual workspace shell
 * is not yet implemented. This component renders a placeholder
 * that confirms the client-only boundary is functional.
 */

import dynamic from "next/dynamic";
import { Suspense } from "react";

const WorkspaceShell = dynamic(() => import("./WorkspaceShell"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center min-h-[60vh] text-gray-400 text-sm font-mono">
      Loading workspace...
    </div>
  ),
});

export default function WorkspaceClient() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-[60vh] text-gray-400 text-sm font-mono">
          Loading workspace...
        </div>
      }
    >
      <WorkspaceShell />
    </Suspense>
  );
}
