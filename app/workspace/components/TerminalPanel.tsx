"use client";

/**
 * Terminal panel for CoderXP M3.1.
 *
 * Renders a real interactive terminal using xterm.js, connected to
 * the shared WebContainer shell via WorkspaceTerminal.
 *
 * - Real shell process (jsh inside WebContainer)
 * - Real stdin/stdout/stderr
 * - Command history (up/down arrows)
 * - Ctrl+C interrupt
 * - Terminal resize (FitAddon + ResizeObserver)
 * - Scrollback (xterm.js built-in)
 * - Copy/paste (xterm.js built-in)
 * - Clear terminal
 * - Boot timeout / error / retry
 *
 * The terminal shares the same WebContainer as the runtime/preview.
 * It does NOT boot a second WebContainer.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { getTerminal, type TerminalState } from "@/lib/workspace/terminal";
import "@xterm/xterm/css/xterm.css";

interface TerminalPanelProps {
  /** Whether the terminal panel is visible (active tab). */
  active: boolean;
}

export function TerminalPanel({ active }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalRef = useRef<ReturnType<typeof getTerminal> | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const inputBufferRef = useRef<string>("");

  const [state, setState] = useState<TerminalState>("idle");
  const [error, setError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Initialize terminal on mount
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;

    // Create xterm.js terminal instance.
    const term = new Terminal({
      cols: 80,
      rows: 24,
      cursorBlink: true,
      fontSize: 14,
      lineHeight: 1.2,
      fontWeight: "400" as any,
      fontWeightBold: "700" as any,
      fontFamily: '"Cascadia Mono", "Cascadia Code", monospace',
      theme: {
        background: "#0a0b0d",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#264f78",
        black: "#0a0b0d",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#e5e7eb",
        brightBlack: "#6b7280",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#f9fafb",
      },
      allowProposedApi: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    // Ensure metrics align after custom font loads
    if (typeof document !== "undefined" && document.fonts) {
      document.fonts.ready.then(() => {
        try {
          fitAddon.fit();
          term.refresh(0, term.rows - 1);
        } catch {
          // ignore
        }
      });
    }

    // Get the terminal manager singleton.
    const terminal = getTerminal();
    terminalRef.current = terminal;

    // Wire state changes.
    terminal.onStateChange((s) => {
      setState(s);
      if (s === "error") {
        // Error message is set via the error callback.
      }
    });

    // Wire output from the shell to xterm.js.
    terminal.onOutput((data) => {
      term.write(data);
    });

    // Wire errors.
    terminal.onError((msg) => {
      setError(msg);
      term.write(`\r\n\x1b[31m${msg}\x1b[0m\r\n`);
    });

    // Wire exit.
    terminal.onExit((code) => {
      term.write(`\r\n\x1b[33m[shell exited with code ${code}]\x1b[0m\r\n`);
    });

    // Wire input from xterm.js to the shell.
    term.onData((data) => {
      // Handle special keys.
      if (data === "\x03") {
        // Ctrl+C
        terminal.sendInterrupt();
        return;
      }

      if (data === "\x04") {
        // Ctrl+D
        terminal.sendEof();
        return;
      }

      // Handle Enter — add to history.
      if (data === "\r" || data === "\n") {
        const cmd = inputBufferRef.current;
        if (cmd.trim().length > 0) {
          terminal.addHistory(cmd);
        }
        inputBufferRef.current = "";
        terminal.write(data);
        return;
      }

      // Handle Up arrow — history previous.
      if (data === "\x1b[A") {
        const prev = terminal.historyPrev();
        if (prev !== null) {
          // Clear current input.
          const currentLen = inputBufferRef.current.length;
          if (currentLen > 0) {
            term.write("\b \b".repeat(currentLen));
          }
          inputBufferRef.current = prev;
          term.write(prev);
        }
        return;
      }

      // Handle Down arrow — history next.
      if (data === "\x1b[B") {
        const next = terminal.historyNext();
        // Clear current input.
        const currentLen = inputBufferRef.current.length;
        if (currentLen > 0) {
          term.write("\b \b".repeat(currentLen));
        }
        if (next !== null) {
          inputBufferRef.current = next;
          term.write(next);
        } else {
          inputBufferRef.current = "";
        }
        return;
      }

      // Regular input — buffer it and forward.
      inputBufferRef.current += data;
      terminal.write(data);
    });

    // Auto-start the terminal when it becomes visible for the first time.
    if (active) {
      terminal.start();
    }

    // ResizeObserver to handle panel resizing.
    const resizeObserver = new ResizeObserver(() => {
      if (fitRef.current && containerRef.current) {
        try {
          fitRef.current.fit();
          const term = termRef.current;
          if (term) {
            terminal.resize(term.cols, term.rows);
          }
        } catch {
          // Fit may fail if the container is not visible.
        }
      }
    });

    resizeObserver.observe(containerRef.current);
    resizeObserverRef.current = resizeObserver;

    // Cleanup on unmount.
    return () => {
      resizeObserver.disconnect();
      resizeObserverRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount.

  // -------------------------------------------------------------------------
  // Start terminal when it becomes visible
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (active && terminalRef.current && state === "idle") {
      terminalRef.current.start();
    }

    // Refit when becoming visible.
    if (active && fitRef.current && containerRef.current) {
      setTimeout(() => {
        try {
          fitRef.current?.fit();
          const term = termRef.current;
          if (term && terminalRef.current) {
            terminalRef.current.resize(term.cols, term.rows);
          }
        } catch {
          // ignore
        }
      }, 50);
    }
  }, [active, state]);

  // -------------------------------------------------------------------------
  // Clear terminal
  // -------------------------------------------------------------------------
  const handleClear = useCallback(() => {
    if (termRef.current) {
      termRef.current.clear();
    }
  }, []);

  // -------------------------------------------------------------------------
  // Retry after error
  // -------------------------------------------------------------------------
  const handleRetry = useCallback(() => {
    setError(null);
    if (terminalRef.current) {
      terminalRef.current.retry();
    }
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col h-full bg-[#0a0b0d]">
      {/* Terminal header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-800 bg-gray-900/50">
        <span className="text-xs text-gray-500 uppercase tracking-wide">Terminal</span>
        <div className="flex items-center gap-2">
          {/* Status indicator */}
          <TerminalStatusIndicator state={state} />
          {/* Clear button */}
          <button
            onClick={handleClear}
            disabled={state !== "ready"}
            className="text-xs text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Clear terminal"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Terminal container */}
      <div className="flex-1 overflow-hidden relative">
        <div
          ref={containerRef}
          className="h-full w-full"
          style={{ padding: "4px 8px" }}
        />

        {/* Error overlay */}
        {state === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0a0b0d]/95 z-10">
            <div className="flex flex-col items-center gap-3 max-w-sm text-center px-4">
              <div className="flex items-center gap-2 text-red-400">
                <span className="text-sm font-medium">Terminal Error</span>
              </div>
              <p className="text-xs text-gray-400">
                {error ?? "The terminal failed to start."}
              </p>
              <button
                onClick={handleRetry}
                className="px-3 py-1.5 text-xs text-cyan-400 border border-cyan-700/50 rounded hover:bg-cyan-900/20 transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Booting overlay */}
        {state === "booting" && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0a0b0d]/80 z-10">
            <div className="flex items-center gap-2 text-gray-400">
              <span className="text-xs">Booting WebContainer...</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status indicator
// ---------------------------------------------------------------------------

function TerminalStatusIndicator({ state }: { state: TerminalState }) {
  const colors: Record<TerminalState, string> = {
    idle: "text-gray-500",
    booting: "text-amber-400",
    ready: "text-green-400",
    error: "text-red-400",
  };

  return (
    <span className={`text-xs ${colors[state]}`}>
      {state}
    </span>
  );
}
