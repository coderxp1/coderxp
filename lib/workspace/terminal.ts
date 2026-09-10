/**
 * Interactive terminal manager for CoderXP M3.1.
 *
 * Owns a real interactive shell process inside the shared WebContainer.
 * The terminal operates on the same /project filesystem used by the
 * editor, runtime, and preview.
 *
 * - Real shell process (jsh) with real stdin/stdout/stderr
 * - Command history (in-memory, per session)
 * - Ctrl+C / process interruption
 * - Terminal resize (cols/rows forwarded to the shell)
 * - Scrollback (handled by xterm.js in the UI layer)
 * - Copy/paste (handled by xterm.js in the UI layer)
 * - Clear terminal (handled by xterm.js in the UI layer)
 *
 * The terminal does NOT boot a second WebContainer. It reuses the
 * singleton from runtime-client.ts. If the WebContainer is not yet
 * booted, the terminal boots it first.
 *
 * Security: all commands execute only inside the WebContainer sandbox.
 * The host OS shell is never exposed.
 */

import { bootWebContainer, isBooted } from "./runtime-client";
import { WORKSPACE_PROJECT_ROOT } from "./constants";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Terminal lifecycle states. */
export type TerminalState = "idle" | "booting" | "ready" | "error";

/** Callback for terminal state changes. */
export type TerminalStateCallback = (state: TerminalState) => void;

/** Callback for terminal output (raw bytes). */
export type TerminalOutputCallback = (data: string) => void;

/** Callback for terminal errors. */
export type TerminalErrorCallback = (message: string) => void;

/** Callback for terminal exit. */
export type TerminalExitCallback = (exitCode: number) => void;

// ---------------------------------------------------------------------------
// Boot timeout configuration
// ---------------------------------------------------------------------------

/** Default boot timeout in milliseconds. Centralized and configurable. */
export const DEFAULT_BOOT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Terminal manager
// ---------------------------------------------------------------------------

/**
 * Manages an interactive shell process inside the shared WebContainer.
 *
 * One instance per workspace page session. Reuses the same WebContainer
 * singleton as the runtime manager.
 */
export class WorkspaceTerminal {
  private container: WebContainer | null = null;
  private shellProcess: WebContainerProcess | null = null;
  private state: TerminalState = "idle";
  private booted = false;
  private booting = false;

  private stateCallback: TerminalStateCallback | null = null;
  private outputCallback: TerminalOutputCallback | null = null;
  private errorCallback: TerminalErrorCallback | null = null;
  private exitCallback: TerminalExitCallback | null = null;

  /** Command history (in-memory, per session). */
  private history: string[] = [];
  private historyIndex = -1;

  /** Boot timeout in ms. */
  private bootTimeoutMs: number = DEFAULT_BOOT_TIMEOUT_MS;

  /** Pending boot timeout timer. */
  private bootTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether the shell is currently running a foreground command. */
  private shellRunning = false;

  // -------------------------------------------------------------------------
  // Event registration
  // -------------------------------------------------------------------------

  onStateChange(cb: TerminalStateCallback): void {
    this.stateCallback = cb;
  }

  onOutput(cb: TerminalOutputCallback): void {
    this.outputCallback = cb;
  }

  onError(cb: TerminalErrorCallback): void {
    this.errorCallback = cb;
  }

  onExit(cb: TerminalExitCallback): void {
    this.exitCallback = cb;
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  getState(): TerminalState {
    return this.state;
  }

  isReady(): boolean {
    return this.state === "ready" && this.shellProcess !== null;
  }

  isBooted(): boolean {
    return this.booted;
  }

  private setState(state: TerminalState): void {
    this.state = state;
    this.stateCallback?.(state);
  }

  private emitOutput(data: string): void {
    this.outputCallback?.(data);
  }

  private emitError(message: string): void {
    this.errorCallback?.(message);
  }

  private emitExit(code: number): void {
    this.exitCallback?.(code);
  }

  // -------------------------------------------------------------------------
  // Boot lifecycle
  // -------------------------------------------------------------------------

  /**
   * Boots the WebContainer if not already booted, then starts the shell.
   *
   * The boot timeout prevents indefinite "booting" state. On timeout,
   * transitions to error state with a clear message and allows retry.
   *
   * @param bootTimeoutMs Optional override for the boot timeout.
   */
  async start(bootTimeoutMs?: number): Promise<void> {
    if (this.state === "ready" && this.shellProcess) return;
    if (this.booting) return;

    if (bootTimeoutMs) {
      this.bootTimeoutMs = bootTimeoutMs;
    }

    this.booting = true;
    this.setState("booting");

    // Start the boot timeout timer.
    this.bootTimer = setTimeout(() => {
      if (this.booting && this.state === "booting") {
        this.booting = false;
        this.emitError(
          `WebContainer boot timed out after ${this.bootTimeoutMs / 1000}s. The browser environment may not support WebContainers. Click Retry to try again.`
        );
        this.setState("error");
      }
    }, this.bootTimeoutMs);

    try {
      this.container = await bootWebContainer();

      // Clear the boot timeout on success.
      if (this.bootTimer) {
        clearTimeout(this.bootTimer);
        this.bootTimer = null;
      }

      this.booted = true;
      this.booting = false;

      await this.startShell();
    } catch (err) {
      if (this.bootTimer) {
        clearTimeout(this.bootTimer);
        this.bootTimer = null;
      }

      this.booting = false;
      const msg = err instanceof Error ? err.message : "WebContainer boot failed";
      this.emitError(msg);
      this.setState("error");
    }
  }

  /**
   * Starts the interactive shell process inside the WebContainer.
   */
  private async startShell(): Promise<void> {
    if (!this.container) {
      this.emitError("WebContainer not available");
      this.setState("error");
      return;
    }

    try {
      // Spawn jsh (the WebContainer shell) in the project directory.
      const process = await this.container.spawn("jsh", {
        cwd: WORKSPACE_PROJECT_ROOT,
        terminal: {
          cols: 80,
          rows: 24,
        },
      });

      this.shellProcess = process;
      this.shellRunning = true;
      this.setState("ready");

      // Pipe stdout and stderr to the output callback.
      this.captureOutput(process);

      // Wait for the shell to exit.
      const exitCode = await process.exit;

      this.shellRunning = false;
      this.shellProcess = null;

      if (this.state !== "error") {
        this.emitExit(exitCode);
        this.setState("idle");
      }
    } catch (err) {
      this.shellRunning = false;
      this.shellProcess = null;
      const msg = err instanceof Error ? err.message : "Failed to start shell";
      this.emitError(msg);
      this.setState("error");
    }
  }

  /**
   * Captures stdout and stderr from a process and forwards to the output callback.
   */
  private captureOutput(process: WebContainerProcess): void {
    const reader = process.output.getReader();

    const readLoop = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          // The WebContainer output stream yields string chunks directly.
          this.emitOutput(value);
        }
      }
    };

    readLoop().catch(() => {
      // Stream closed — normal on process exit.
    });
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /**
   * Writes data to the shell's stdin.
   * Used for typing commands, Ctrl+C (\\x03), Enter, etc.
   */
  write(data: string): void {
    if (!this.shellProcess) return;

    const writer = this.shellProcess.input.getWriter();
    writer.write(data);
    writer.releaseLock();
  }

  /**
   * Sends Ctrl+C to interrupt the current foreground command.
   */
  sendInterrupt(): void {
    this.write("\x03");
  }

  /**
   * Sends Ctrl+D (EOF).
   */
  sendEof(): void {
    this.write("\x04");
  }

  // -------------------------------------------------------------------------
  // Resize
  // -------------------------------------------------------------------------

  /**
   * Resizes the terminal. Forwards new dimensions to the shell process
   * so applications can react to the new size.
   */
  resize(cols: number, rows: number): void {
    if (!this.shellProcess) return;

    try {
      this.shellProcess.resize({ cols, rows });
    } catch {
      // Process may not support resize or may have exited.
    }
  }

  // -------------------------------------------------------------------------
  // Command history
  // -------------------------------------------------------------------------

  /**
   * Adds a command to the history.
   */
  addHistory(command: string): void {
    const trimmed = command.trim();
    if (trimmed.length === 0) return;

    // Don't add duplicates of the last command.
    if (this.history.length > 0 && this.history[this.history.length - 1] === trimmed) {
      return;
    }

    this.history.push(trimmed);
    this.historyIndex = this.history.length;
  }

  /**
   * Returns the previous command in history (up arrow).
   */
  historyPrev(): string | null {
    if (this.history.length === 0) return null;
    if (this.historyIndex > 0) {
      this.historyIndex--;
      return this.history[this.historyIndex];
    }
    return this.history[0] ?? null;
  }

  /**
   * Returns the next command in history (down arrow).
   */
  historyNext(): string | null {
    if (this.history.length === 0) return null;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      return this.history[this.historyIndex];
    }
    // At the end — return null to clear the input.
    this.historyIndex = this.history.length;
    return null;
  }

  /**
   * Returns the full command history.
   */
  getHistory(): string[] {
    return [...this.history];
  }

  // -------------------------------------------------------------------------
  // Project switching
  // -------------------------------------------------------------------------

  /**
   * Resets the terminal for a project switch.
   * Stops the current shell and resets state so start() can be called again.
   *
   * The WebContainer itself is NOT torn down — it is shared with the runtime.
   * The shell is simply killed and will be restarted on next start().
   */
  async reset(): Promise<void> {
    if (this.shellProcess) {
      try {
        this.shellProcess.kill();
      } catch {
        // Process may already be dead.
      }
      this.shellProcess = null;
    }

    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }

    this.shellRunning = false;
    this.booting = false;
    this.setState("idle");
  }

  /**
   * Retries the boot after a failure.
   * Resets error state and calls start() again.
   */
  async retry(): Promise<void> {
    if (this.shellProcess) {
      try {
        this.shellProcess.kill();
      } catch {
        // ignore
      }
      this.shellProcess = null;
    }

    this.shellRunning = false;
    this.booting = false;
    this.setState("idle");

    await this.start();
  }

  // -------------------------------------------------------------------------
  // Dispose
  // -------------------------------------------------------------------------

  /**
   * Disposes the terminal. Kills the shell process.
   * Does NOT tear down the WebContainer (shared with runtime).
   */
  dispose(): void {
    if (this.shellProcess) {
      try {
        this.shellProcess.kill();
      } catch {
        // ignore
      }
      this.shellProcess = null;
    }

    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }

    this.shellRunning = false;
    this.booting = false;
    this.stateCallback = null;
    this.outputCallback = null;
    this.errorCallback = null;
    this.exitCallback = null;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let terminalInstance: WorkspaceTerminal | null = null;

/**
 * Returns the singleton WorkspaceTerminal instance.
 * Creates it on first call.
 */
export function getTerminal(): WorkspaceTerminal {
  if (!terminalInstance) {
    terminalInstance = new WorkspaceTerminal();
  }
  return terminalInstance;
}
