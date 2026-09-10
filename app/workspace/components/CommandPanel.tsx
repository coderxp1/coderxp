"use client";

/**
 * Command panel for CoderXP M3.2.
 *
 * Provides a UI for running structured commands and inspecting their results.
 * Users can type a command, run it, see real output, and cancel long-running processes.
 *
 * - Command input with Run button
 * - List of all commands with state, exit code, and output
 * - Cancel button for running commands
 * - Output viewer with truncation indicator
 * - No AI integration — infrastructure only
 */

import { useCallback, useState, useRef, useEffect } from "react";
import { Play, Square, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import type { CommandResult, CommandState } from "@/lib/workspace/command-controller";

interface CommandPanelProps {
  /** All command results. */
  commands: CommandResult[];
  /** Whether any command is running. */
  isRunning: boolean;
  /** Run a command. */
  onRun: (input: string) => Promise<void>;
  /** Cancel a command by ID. */
  onCancel: (processId: string) => void;
  /** Clear completed commands. */
  onClear: () => void;
}

export function CommandPanel({
  commands,
  isRunning,
  onRun,
  onCancel,
  onClear,
}: CommandPanelProps) {
  const [input, setInput] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastSeenCountRef = useRef(0);

  // Auto-expand the latest command when a new one is added.
  // Using a ref to track the previous count avoids re-renders.
  useEffect(() => {
    if (commands.length > lastSeenCountRef.current && commands.length > 0) {
      setExpandedId(commands[commands.length - 1].id);
    }
    lastSeenCountRef.current = commands.length;
  }, [commands]);

  const handleRun = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    await onRun(trimmed);
    setInput("");
  }, [input, onRun]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleRun();
    }
  }, [handleRun]);

  return (
    <div className="flex flex-col h-full bg-[#0a0b0d]">
      {/* Header with input */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800 bg-gray-900/50">
        <span className="text-xs text-gray-500 uppercase tracking-wide">Commands</span>
        <div className="flex-1 flex items-center gap-1.5">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. node --version"
            className="flex-1 px-2 py-1 text-xs text-gray-100 bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-cyan-600"
          />
          <button
            onClick={handleRun}
            disabled={!input.trim() || isRunning}
            className="flex items-center gap-1 px-2 py-1 text-xs text-cyan-400 border border-cyan-700/50 rounded hover:bg-cyan-900/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Run command"
          >
            <Play className="w-3 h-3" />
            Run
          </button>
        </div>
        {commands.length > 0 && (
          <button
            onClick={onClear}
            className="flex items-center gap-1 px-1.5 py-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
            title="Clear completed"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Command list */}
      <div className="flex-1 overflow-y-auto">
        {commands.length === 0 ? (
          <p className="text-xs text-gray-600 italic px-3 py-2">
            Run a command to see results. Try: node --version, npm --version
          </p>
        ) : (
          commands.map((cmd) => (
            <CommandEntry
              key={cmd.id}
              cmd={cmd}
              expanded={expandedId === cmd.id}
              onToggle={() => setExpandedId(expandedId === cmd.id ? null : cmd.id)}
              onCancel={onCancel}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Command entry
// ---------------------------------------------------------------------------

function CommandEntry({
  cmd,
  expanded,
  onToggle,
  onCancel,
}: {
  cmd: CommandResult;
  expanded: boolean;
  onToggle: () => void;
  onCancel: (processId: string) => void;
}) {
  const isActive = cmd.state === "starting" || cmd.state === "running";
  const fullCommand = `${cmd.command}${cmd.args.length > 0 ? " " + cmd.args.join(" ") : ""}`;

  return (
    <div className="border-b border-gray-800/50">
      {/* Header row */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-gray-900/30 cursor-pointer" onClick={onToggle}>
        <span className="text-gray-500">
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </span>
        <span className="text-xs font-mono text-gray-300 flex-1 truncate">{fullCommand}</span>
        <CommandStateBadge state={cmd.state} exitCode={cmd.exitCode} />
        {isActive && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCancel(cmd.id);
            }}
            className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-red-400 hover:text-red-300 transition-colors"
            title="Cancel command"
          >
            <Square className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Expanded output */}
      {expanded && (
        <div className="px-3 pb-2">
          {/* Metadata */}
          <div className="flex items-center gap-3 text-xs text-gray-600 mb-1">
            <span>owner: {cmd.owner}</span>
            <span>cwd: {cmd.cwd}</span>
            {cmd.exitCode !== null && <span>exit: {cmd.exitCode}</span>}
            {cmd.truncated && <span className="text-amber-500">output truncated</span>}
          </div>

          {/* Output */}
          {cmd.output ? (
            <pre className="text-xs font-mono text-gray-300 whitespace-pre-wrap break-all bg-black/30 rounded p-2 max-h-48 overflow-y-auto">
              {cmd.output}
            </pre>
          ) : (
            <p className="text-xs text-gray-600 italic px-2 py-1">
              {isActive ? "Waiting for output..." : "No output."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// State badge
// ---------------------------------------------------------------------------

function CommandStateBadge({ state, exitCode }: { state: CommandState; exitCode: number | null }) {
  const styles: Record<CommandState, string> = {
    starting: "text-amber-400",
    running: "text-amber-400",
    exited: "text-green-400",
    failed: "text-red-400",
    cancelled: "text-gray-500",
  };

  const label = state === "exited" || state === "failed"
    ? `${state} (${exitCode})`
    : state;

  return (
    <span className={`text-xs ${styles[state]}`}>
      {label}
    </span>
  );
}