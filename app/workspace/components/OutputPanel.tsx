"use client";

/**
 * Output panel for CoderXP M2 Workspace Alpha.
 *
 * Commit 5 scope: displays real stdout/stderr from the spawned process.
 *
 * - Clears output on new run
 * - Appends process output in order
 * - Preserves meaningful line breaks
 * - Auto-scrolls to bottom
 * - Stops receiving output after process ownership ends
 * - No fake commands, fake prompt input, or sample lines
 */

import { useEffect, useRef } from "react";
import type { OutputLine } from "@/lib/workspace/runtime";

interface OutputPanelProps {
  /** Output lines from the runtime process. */
  output: OutputLine[];
}

export function OutputPanel({ output }: OutputPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new output arrives.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [output]);

  return (
    <div className="flex flex-col h-full bg-[#0a0b0d]">
      <div className="flex items-center px-3 py-1.5 border-b border-gray-800 bg-gray-900/50">
        <span className="text-xs text-gray-500 uppercase tracking-wide">Output</span>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed"
      >
        {output.length === 0 ? (
          <p className="text-gray-600 italic">Run a project to see process output.</p>
        ) : (
          output.map((line) => (
            <div key={line.id} className="text-gray-300 whitespace-pre-wrap break-all">
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
