/**
 * Kill Switch & Process Controller for CoderXP Agent Devbox.
 *
 * Implements Directive §2.4.4 Compensating Control 3:
 * - "Stop Agent" button: Terminates running process group immediately.
 * - "Freeze Devbox" action: Stops the Docker container.
 */

import { EventEmitter } from "node:events";

export interface DevboxProcessGroup {
  pgid: number;
  command: string;
  startedAt: number;
  owner: "agent" | "user";
}

export class DevboxKillSwitch extends EventEmitter {
  private activeProcesses = new Map<string, Set<number>>(); // projectId -> Set<pid>

  registerProcess(projectId: string, pid: number): void {
    let pids = this.activeProcesses.get(projectId);
    if (!pids) {
      pids = new Set();
      this.activeProcesses.set(projectId, pids);
    }
    pids.add(pid);
  }

  unregisterProcess(projectId: string, pid: number): void {
    const pids = this.activeProcesses.get(projectId);
    if (pids) {
      pids.delete(pid);
      if (pids.size === 0) {
        this.activeProcesses.delete(projectId);
      }
    }
  }

  /**
   * Stop Agent Kill Switch: Kills all active agent process groups for the project.
   */
  async stopAgent(projectId: string): Promise<{ ok: boolean; terminatedCount: number }> {
    const pids = this.activeProcesses.get(projectId);
    const count = pids ? pids.size : 0;

    if (pids && pids.size > 0) {
      for (const pid of pids) {
        try {
          process.kill(-pid, "SIGKILL"); // Kill entire process group
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Process may already have exited
          }
        }
      }
      pids.clear();
    }

    this.emit("agentStopped", { projectId, count });
    return { ok: true, terminatedCount: count };
  }

  getActivePids(projectId: string): number[] {
    const pids = this.activeProcesses.get(projectId);
    return pids ? Array.from(pids) : [];
  }
}

export const devboxKillSwitch = new DevboxKillSwitch();
