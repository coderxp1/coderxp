"use client";

/**
 * Commands hook for CoderXP M3.2.
 *
 * Wires the WorkspaceCommandController to React state.
 * Provides a clean API for running structured commands,
 * tracking their state, and displaying output.
 *
 * - Uses the singleton WorkspaceCommandController
 * - Tracks all command results in state
 * - Provides runCommand and cancelCommand
 * - Handles project switch (invalidate + clear)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCommandController,
  type CommandResult,
  type CommandOwner,
  type CommandState,
} from "@/lib/workspace/command-controller";

export interface CommandApi {
  /** All command results (active and completed). */
  commands: CommandResult[];
  /** Currently active command IDs (starting/running). */
  activeIds: string[];
  /** Whether any command is currently running. */
  isRunning: boolean;

  /**
   * Run a structured command. Returns the process ID.
   */
  runCommand: (params: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    owner?: CommandOwner;
  }) => Promise<string>;

  /**
   * Cancel a running command by process ID.
   */
  cancelCommand: (processId: string) => boolean;

  /**
   * Get a specific command result.
   */
  getResult: (processId: string) => CommandResult | null;

  /**
   * Clear all completed commands from the list.
   */
  clearCompleted: () => void;

  /**
   * Invalidate all commands for the current project (project switch).
   */
  invalidateProject: () => void;
}

export function useCommands(): CommandApi {
  const [commands, setCommands] = useState<CommandResult[]>(() => {
    // Lazy initializer — read initial state from the controller.
    try {
      return getCommandController().getAllResults();
    } catch {
      return [];
    }
  });
  const controllerRef = useRef<ReturnType<typeof getCommandController> | null>(null);

  useEffect(() => {
    const controller = getCommandController();
    controllerRef.current = controller;

    // Sync state changes to React.
    controller.onStateChange(() => {
      setCommands(controller.getAllResults());
    });

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const runCommand = useCallback(async (params: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    owner?: CommandOwner;
  }): Promise<string> => {
    if (!controllerRef.current) {
      throw new Error("Command controller not initialized");
    }
    const id = await controllerRef.current.runCommand(params);
    setCommands(controllerRef.current.getAllResults());
    return id;
  }, []);

  const cancelCommand = useCallback((processId: string): boolean => {
    if (!controllerRef.current) return false;
    const result = controllerRef.current.cancelCommand(processId);
    setCommands(controllerRef.current.getAllResults());
    return result;
  }, []);

  const getResult = useCallback((processId: string): CommandResult | null => {
    if (!controllerRef.current) return null;
    return controllerRef.current.getResult(processId);
  }, []);

  const clearCompleted = useCallback(() => {
    if (!controllerRef.current) return;
    controllerRef.current.clearHistory();
    setCommands([]);
  }, []);

  const invalidateProject = useCallback(() => {
    if (!controllerRef.current) return;
    controllerRef.current.invalidateProject();
    controllerRef.current.clearHistory();
    setCommands([]);
  }, []);

  const activeIds = commands
    .filter((c) => c.state === "starting" || c.state === "running")
    .map((c) => c.id);

  return {
    commands,
    activeIds,
    isRunning: activeIds.length > 0,
    runCommand,
    cancelCommand,
    getResult,
    clearCompleted,
    invalidateProject,
  };
}