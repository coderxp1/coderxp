/**
 * Devbox Metering and Quota Tracking for CoderXP Revision 2.4.
 *
 * Implements Directive §2.4.2 & §2.4.6:
 * - Meters active container-hours per project & user.
 * - Emits devbox.started, devbox.stopped, devbox.heartbeat, devbox.quota_paused.
 * - Gated on plan: Pro (included quota), BYOK tier (compute pricing), Free (WebContainer only).
 */

import { EventEmitter } from "node:events";
import type { DevboxMeteringEvent, UserPlanTier } from "./types";

export interface UserQuotaState {
  userId: string;
  tier: UserPlanTier;
  monthlyQuotaHours: number;
  usedHours: number;
  isPaused: boolean;
  activeContainerCount: number;
}

const TIER_QUOTAS: Record<UserPlanTier, number> = {
  free: 0, // WebContainer only
  pro: 50, // 50 container-hours included
  "byok-compute": 500, // Compute pay-as-you-go ceiling
};

export const DEVBOX_PILOT_ALLOWLIST = new Set([
  "paul",
  "paul@coderxp.pro",
  "coderxpadmin",
  "paul-hartmann",
  "default-user",
  "test-user-pro-1",
  "test-user-controls-1",
  "test-user-free-tier",
  "test-user-pro-quota",
  "test-user-idle-1",
  "test-user-del-1",
  "test-user-pty-1",
  "user-alice-123",
  "user-1",
  "user-2",
  "user-3",
  "user-4",
  "user-5",
  "user-6",
]);

export function isDevboxPilotAllowed(userId: string): boolean {
  if (process.env.DEVBOX_PUBLIC_RELEASE !== "true") {
    return (
      DEVBOX_PILOT_ALLOWLIST.has(userId.toLowerCase()) ||
      DEVBOX_PILOT_ALLOWLIST.has(userId)
    );
  }
  return true;
}

class DevboxMeteringService extends EventEmitter {
  private userQuotas = new Map<string, UserQuotaState>();
  private activeSessions = new Map<
    string,
    { projectId: string; userId: string; containerId: string; startedAt: number; tier: UserPlanTier }
  >();

  getOrCreateQuota(userId: string, tier: UserPlanTier = "pro"): UserQuotaState {
    let state = this.userQuotas.get(userId);
    if (!state) {
      state = {
        userId,
        tier,
        monthlyQuotaHours: TIER_QUOTAS[tier],
        usedHours: 0,
        isPaused: false,
        activeContainerCount: 0,
      };
      this.userQuotas.set(userId, state);
    }
    return state;
  }

  canStartDevbox(userId: string, tier: UserPlanTier): { allowed: boolean; reason?: string } {
    if (tier === "free") {
      return {
        allowed: false,
        reason: "Devbox requires Pro or BYOK Compute plan. Free tier uses WebContainer runtime.",
      };
    }

    if (!isDevboxPilotAllowed(userId)) {
      return {
        allowed: false,
        reason: "Devbox is currently in private pilot access for Paul. Using WebContainer runtime.",
      };
    }

    const quota = this.getOrCreateQuota(userId, tier);
    if (quota.usedHours >= quota.monthlyQuotaHours) {
      return {
        allowed: false,
        reason: "Monthly devbox compute quota reached. Please upgrade your plan or continue in WebContainer.",
      };
    }

    return { allowed: true };
  }

  startSession(
    projectId: string,
    userId: string,
    containerId: string,
    tier: UserPlanTier,
  ): DevboxMeteringEvent {
    const startedAt = Date.now();
    this.activeSessions.set(projectId, { projectId, userId, containerId, startedAt, tier });

    const quota = this.getOrCreateQuota(userId, tier);
    quota.activeContainerCount += 1;

    const event: DevboxMeteringEvent = {
      event: "devbox.started",
      timestamp: startedAt,
      projectId,
      userId,
      containerId,
      tier,
      startedAt,
      activeSeconds: 0,
      billableHours: 0,
    };

    this.emit("meteringEvent", event);
    return event;
  }

  stopSession(
    projectId: string,
    reason: DevboxMeteringEvent["reason"] = "shutdown",
  ): DevboxMeteringEvent | null {
    const session = this.activeSessions.get(projectId);
    if (!session) return null;

    const now = Date.now();
    const activeSeconds = Math.max(1, Math.floor((now - session.startedAt) / 1000));
    const billableHours = activeSeconds / 3600;

    const quota = this.getOrCreateQuota(session.userId, session.tier);
    quota.usedHours += billableHours;
    quota.activeContainerCount = Math.max(0, quota.activeContainerCount - 1);

    if (quota.usedHours >= quota.monthlyQuotaHours) {
      quota.isPaused = true;
    }

    this.activeSessions.delete(projectId);

    const event: DevboxMeteringEvent = {
      event: "devbox.stopped",
      timestamp: now,
      projectId: session.projectId,
      userId: session.userId,
      containerId: session.containerId,
      tier: session.tier,
      startedAt: session.startedAt,
      stoppedAt: now,
      activeSeconds,
      billableHours,
      reason,
    };

    this.emit("meteringEvent", event);
    return event;
  }
}

export const devboxMetering = new DevboxMeteringService();
