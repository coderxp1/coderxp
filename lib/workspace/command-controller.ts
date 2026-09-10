/**
 * Command & Process Execution Controller for CoderXP M3.2.
 *
 * Provides a structured command API for running real commands inside the
 * shared WebContainer without directly manipulating the terminal UI.
 *
 * Architecture:
 *
 *   User / future Agent
 *          ↓
 *   Command Controller
 *          ↓
 *   Shared WebContainer (singleton from runtime-client)
 *          ↓
 *   /project
 *          ↓
 *   real process
 *
 * Key design:
 * - Uses the same WebContainer singleton as WorkspaceRuntime and WorkspaceTerminal.
 * - Never boots a second WebContainer.
 * - Each command gets a real process handle with authentic exit codes.
 * - Output is never synthesized; exit state comes from the actual process.
 * - Genuine process cancellation via process.kill().
 * - Generation-based project ownership prevents stale command events.
 * - Output cap with truthful truncation flag.
 * - Separate from WorkspaceRuntime (preview/dev-server) and WorkspaceTerminal (jsh shell).
 * - No AI integration — infrastructure only.
 */

import { bootWebContainer, isBooted } from "./runtime-client";
import { WORKSPACE_PROJECT_ROOT } from "./constants";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";

// ---------------------------------------------------------------------------
// Types & Contracts
// ---------------------------------------------------------------------------

/** Who initiated a command. */
export type CommandOwner = "user" | "system" | "agent";

/** Lifecycle states of a command process. */
export type CommandState = "starting" | "running" | "exited" | "failed" | "cancelled";

/** Parameters for running a structured command. */
export interface RunCommandParams {
  /** Executable name, e.g. "node", "npm". */
  command: string;
  /** Arguments array, e.g. ["--version"] or ["run", "build"]. */
  args?: string[];
  /** Working directory inside the WebContainer. Defaults to /project. */
  cwd?: string;
  /** Environment variables for the process. */
  env?: Record<string, string>;
  /** Who initiated the command. Metadata only — no AI integration yet. */
  owner?: CommandOwner;
}

/**
 * A running or completed command process handle.
 * This is the internal mutable record; the immutable snapshot is CommandResult.
 */
export interface CommandHandle {
  /** Unique process identifier. */
  processId: string;
  /** Executable name. */
  command: string;
  /** Arguments array. */
  args: string[];
  /** Working directory. */
  cwd: string;
  /** Owner type. */
  owner: CommandOwner;
  /** Current lifecycle state. */
  state: CommandState;
  /** Timestamp (ms) when the process started. */
  startedAt: number;
  /** Timestamp (ms) when the process finished, or null. */
  finishedAt: number | null;
  /** Exit code from the actual process, or null if not yet exited. */
  exitCode: number | null;
  /** Accumulated output (stdout + stderr combined). */
  output: string;
  /** Whether output was truncated due to the cap. */
  truncated: boolean;
  /** Generation token for project ownership. */
  generation: number;
  /** The underlying WebContainer process (null after exit). */
  process: WebContainerProcess | null;
}

/**
 * Immutable result snapshot of a command.
 * This is the clean contract that future agent tools will consume.
 */
export interface CommandResult {
  /** Unique process identifier. */
  id: string;
  /** Executable name. */
  command: string;
  /** Arguments array. */
  args: string[];
  /** Working directory. */
  cwd: string;
  /** Owner type. */
  owner: CommandOwner;
  /** Exit code from the actual process, or null if not yet exited. */
  exitCode: number | null;
  /** Accumulated output (stdout + stderr combined). */
  output: string;
  /** Whether output was truncated due to the cap. */
  truncated: boolean;
  /** Final lifecycle state. */
  state: CommandState;
  /** Timestamp (ms) when the process started. */
  startedAt: number;
  /** Timestamp (ms) when the process finished, or null. */
  finishedAt: number | null;
}

/** Callback for command state changes. */
export type CommandStateCallback = (handle: CommandHandle) => void;

/** Callback for output chunks from a command. */
export type CommandOutputCallback = (processId: string, chunk: string) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum output bytes retained per command in memory. */
const MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB

/** Prefix for process IDs. */
const PROCESS_ID_PREFIX = "cmd-";

// ---------------------------------------------------------------------------
// WorkspaceCommandController
// ---------------------------------------------------------------------------

/**
 * Manages structured command execution inside the shared WebContainer.
 *
 * One instance per workspace page session. Reused across project switches.
 * Shares the same WebContainer singleton as WorkspaceRuntime and WorkspaceTerminal.
 *
 * Process ownership separation:
 * - WorkspaceRuntime: app preview/dev-server process
 * - WorkspaceTerminal: interactive jsh shell
 * - WorkspaceCommandController: structured one-off/background commands
 *
 * They may share the same WebContainer but must not accidentally kill each other.
 */
export class WorkspaceCommandController {
  /** Map of active and recently completed command handles. */
  private commands: Map<string, CommandHandle> = new Map();

  /** Monotonic counter for process IDs. */
  private idCounter = 0;

  /** Generation token for project ownership. */
  private generation = 0;

  /** Whether a project is currently mounted. */
  private mounted = false;

  /** Callbacks. */
  private stateCallback: CommandStateCallback | null = null;
  private outputCallback: CommandOutputCallback | null = null;

  // -------------------------------------------------------------------------
  // Callback registration
  // -------------------------------------------------------------------------

  /**
   * Register a callback for command state changes.
   * Called whenever a command transitions states.
   */
  onStateChange(cb: CommandStateCallback): void {
    this.stateCallback = cb;
  }

  /**
   * Register a callback for command output chunks.
   * Called with (processId, chunk) for each stdout/stderr chunk.
   */
  onOutput(cb: CommandOutputCallback): void {
    this.outputCallback = cb;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private emitState(handle: CommandHandle): void {
    this.stateCallback?.(handle);
  }

  private emitOutput(processId: string, chunk: string): void {
    this.outputCallback?.(processId, chunk);
  }

  private nextId(): string {
    this.idCounter++;
    return `${PROCESS_ID_PREFIX}${this.idCounter}`;
  }

  /**
   * Appends output to a command handle, respecting the output cap.
   * Sets truncated=true if the cap is exceeded.
   */
  private appendOutput(handle: CommandHandle, chunk: string): void {
    const currentLen = handle.output.length;
    const remaining = MAX_OUTPUT_BYTES - currentLen;

    if (remaining <= 0) {
      // Already at cap — mark truncated, don't append.
      handle.truncated = true;
      return;
    }

    if (chunk.length <= remaining) {
      handle.output += chunk;
    } else {
      // Append only what fits, mark truncated.
      handle.output += chunk.slice(0, remaining);
      handle.truncated = true;
    }

    this.emitOutput(handle.processId, chunk);
  }

  /**
   * Creates an immutable snapshot of a command handle.
   */
  toResult(handle: CommandHandle): CommandResult {
    return {
      id: handle.processId,
      command: handle.command,
      args: [...handle.args],
      cwd: handle.cwd,
      owner: handle.owner,
      exitCode: handle.exitCode,
      output: handle.output,
      truncated: handle.truncated,
      state: handle.state,
      startedAt: handle.startedAt,
      finishedAt: handle.finishedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Core API: runCommand
  // -------------------------------------------------------------------------

  /**
   * Runs a structured command inside the shared WebContainer.
   *
   * Spawns a real process with the given executable and arguments.
   * Returns a CommandHandle immediately (state: "starting" then "running").
   * The handle is updated as output arrives and when the process exits.
   *
   * The caller can await the result via getResult(processId) or
   * listen to onStateChange.
   *
   * @param params Command parameters.
   * @returns The process ID of the started command.
   */
  async runCommand(params: RunCommandParams): Promise<string> {
    const {
      command,
      args = [],
      cwd = WORKSPACE_PROJECT_ROOT,
      env,
      owner = "user",
    } = params;

    // Boot the shared WebContainer if not already booted.
    // This uses the same singleton as runtime and terminal.
    const container = await bootWebContainer();

    const processId = this.nextId();
    const gen = this.generation;

    // Create the handle in "starting" state.
    const handle: CommandHandle = {
      processId,
      command,
      args: [...args],
      cwd,
      owner,
      state: "starting",
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      output: "",
      truncated: false,
      generation: gen,
      process: null,
    };

    this.commands.set(processId, handle);
    this.emitState(handle);

    try {
      // Spawn the real process.
      const spawnOptions: { cwd: string; env?: Record<string, string> } = { cwd };
      if (env) {
        spawnOptions.env = env;
      }

      const process = await container.spawn(command, args, spawnOptions);

      // Check if we're still on the same project generation.
      if (gen !== this.generation) {
        // Project switched while we were spawning — kill and cancel.
        try {
          process.kill();
        } catch {
          // Process may not have started.
        }
        handle.state = "cancelled";
        handle.finishedAt = Date.now();
        handle.process = null;
        this.emitState(handle);
        return processId;
      }

      handle.process = process;
      handle.state = "running";
      this.emitState(handle);

      // Capture output stream.
      this.captureOutput(process, handle);

      // Wait for the real exit code.
      const exitCode = await process.exit;

      // Only update if still the current generation.
      if (gen === this.generation) {
        handle.exitCode = exitCode;
        handle.finishedAt = Date.now();
        handle.process = null;

        if (exitCode === 0) {
          handle.state = "exited";
        } else {
          handle.state = "failed";
        }

        this.emitState(handle);
      } else {
        // Project switched — mark as cancelled, don't emit stale state.
        handle.state = "cancelled";
        handle.finishedAt = Date.now();
        handle.process = null;
      }
    } catch (err) {
      if (gen === this.generation) {
        const msg = err instanceof Error ? err.message : "Command failed to start";
        handle.output += `\n${msg}`;
        handle.state = "failed";
        handle.finishedAt = Date.now();
        handle.process = null;
        this.emitState(handle);
      }
    }

    return processId;
  }

  // -------------------------------------------------------------------------
  // Output capture
  // -------------------------------------------------------------------------

  /**
   * Captures stdout/stderr from a WebContainer process and appends to the handle.
   */
  private captureOutput(process: WebContainerProcess, handle: CommandHandle): void {
    if (!process.output) return;

    const reader = process.output.getReader();
    const gen = handle.generation;

    const readLoop = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Only append if still the current generation.
          if (gen === this.generation && value) {
            this.appendOutput(handle, value);
          }
        }
      } catch {
        // Stream closed or process killed — normal on exit/cancel.
      }
    };

    readLoop();
  }

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  /**
   * Cancels a running command by killing the underlying process.
   *
   * This calls process.kill() on the real WebContainer process.
   * Hiding output or changing UI state is not cancellation.
   *
   * @param processId The process ID to cancel.
   * @returns true if the process was killed, false if not found or already exited.
   */
  cancelCommand(processId: string): boolean {
    const handle = this.commands.get(processId);
    if (!handle) return false;

    // Can only cancel running or starting commands.
    if (handle.state !== "running" && handle.state !== "starting") {
      return false;
    }

    // Kill the real process.
    if (handle.process) {
      try {
        handle.process.kill();
      } catch {
        // Process may already be dead.
      }
      handle.process = null;
    }

    handle.state = "cancelled";
    handle.finishedAt = Date.now();
    this.emitState(handle);

    return true;
  }

  // -------------------------------------------------------------------------
  // Query API
  // -------------------------------------------------------------------------

  /**
   * Returns a snapshot of a command by process ID.
   * Returns null if not found.
   */
  getResult(processId: string): CommandResult | null {
    const handle = this.commands.get(processId);
    if (!handle) return null;
    return this.toResult(handle);
  }

  /**
   * Returns snapshots of all known commands.
   */
  getAllResults(): CommandResult[] {
    return Array.from(this.commands.values()).map((h) => this.toResult(h));
  }

  /**
   * Returns all commands for a specific owner type.
   */
  getResultsByOwner(owner: CommandOwner): CommandResult[] {
    return Array.from(this.commands.values())
      .filter((h) => h.owner === owner)
      .map((h) => this.toResult(h));
  }

  /**
   * Returns all currently active (starting/running) commands.
   */
  getActiveCommands(): CommandResult[] {
    return Array.from(this.commands.values())
      .filter((h) => h.state === "starting" || h.state === "running")
      .map((h) => this.toResult(h));
  }

  // -------------------------------------------------------------------------
  // Project ownership
  // -------------------------------------------------------------------------

  /**
   * Marks a project as mounted. Called when a project is mounted/synced
   * by the runtime layer. The command controller tracks this to know
   * whether commands can be executed.
   */
  setMounted(mounted: boolean): void {
    this.mounted = mounted;
  }

  /**
   * Whether a project is currently mounted.
   */
  isMounted(): boolean {
    return this.mounted;
  }

  /**
   * Invalidates all commands for the current project.
   *
   * Called on project switch. Cancels all running commands owned by
   * the old project and prevents stale events from updating new project state.
   *
   * After this call, any in-flight command that later exits will see
   * a mismatched generation and be marked as cancelled (not exited/failed).
   */
  invalidateProject(): void {
    // Increment generation — all in-flight commands are now stale.
    this.generation++;

    // Cancel all active commands.
    for (const [id, handle] of this.commands) {
      if (handle.state === "running" || handle.state === "starting") {
        if (handle.process) {
          try {
            handle.process.kill();
          } catch {
            // Process may already be dead.
          }
          handle.process = null;
        }
        handle.state = "cancelled";
        handle.finishedAt = Date.now();
        this.emitState(handle);
      }
    }

    this.mounted = false;
  }

  /**
   * Clears all command history. Called on project switch after
   * invalidation, to start fresh for the new project.
   */
  clearHistory(): void {
    this.commands.clear();
  }

  // -------------------------------------------------------------------------
  // Dispose
  // -------------------------------------------------------------------------

  /**
   * Disposes the command controller. Cancels all running commands.
   * Does NOT tear down the WebContainer (shared with runtime and terminal).
   */
  dispose(): void {
    for (const [, handle] of this.commands) {
      if (handle.process) {
        try {
          handle.process.kill();
        } catch {
          // ignore
        }
        handle.process = null;
      }
    }
    this.commands.clear();
    this.stateCallback = null;
    this.outputCallback = null;
    this.mounted = false;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let controllerInstance: WorkspaceCommandController | null = null;

/**
 * Returns the singleton WorkspaceCommandController instance.
 * Creates it on first call.
 */
export function getCommandController(): WorkspaceCommandController {
  if (!controllerInstance) {
    controllerInstance = new WorkspaceCommandController();
  }
  return controllerInstance;
}

/**
 * Returns the maximum output bytes per command.
 * Exported for testing and documentation.
 */
export function getMaxOutputBytes(): number {
  return MAX_OUTPUT_BYTES;
}
