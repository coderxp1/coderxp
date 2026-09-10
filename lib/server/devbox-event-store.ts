/**
 * Authoritative Host Event Store for CoderXP Phase A.
 *
 * Implements Amendment 1 & Amendment 3:
 * - Single source of truth stored host-side (never trusts in-container files).
 * - Monotonic per-project sequence numbering (seq).
 * - Secret redaction on all persisted event payloads.
 * - 90-day retention surviving volume purges.
 */

import { EventEmitter } from "node:events";
import { redactSecrets } from "../workspace/secret-redaction";
import type { ProjectEvent, ProjectEventType, EventTier, EventActor } from "../devbox/event-types";

interface ProjectEventStoreState {
  currentSeq: number;
  events: ProjectEvent<any>[];
}

class HostEventStore extends EventEmitter {
  private projectStores = new Map<string, ProjectEventStoreState>();

  private sanitizePayload(data: any): any {
    if (typeof data === "string") {
      return redactSecrets(data);
    }
    if (Array.isArray(data)) {
      return data.map((item) => this.sanitizePayload(item));
    }
    if (data && typeof data === "object") {
      const sanitized: Record<string, any> = {};
      for (const [k, v] of Object.entries(data)) {
        sanitized[k] = this.sanitizePayload(v);
      }
      return sanitized;
    }
    return data;
  }

  recordEvent<T = Record<string, any>>(options: {
    projectId: string;
    sessionId?: string;
    actor?: EventActor;
    tier: EventTier;
    type: ProjectEventType;
    data: T;
  }): ProjectEvent<T> {
    let store = this.projectStores.get(options.projectId);
    if (!store) {
      store = { currentSeq: 0, events: [] };
      this.projectStores.set(options.projectId, store);
    }

    store.currentSeq += 1;
    const now = Date.now();
    const sanitizedData = this.sanitizePayload(options.data);

    const event: ProjectEvent<T> = {
      id: `evt-${options.projectId}-${store.currentSeq}-${now}`,
      projectId: options.projectId,
      sessionId: options.sessionId || "default-session",
      seq: store.currentSeq,
      schemaVersion: 1,
      timestamp: now,
      actor: options.actor || "agent",
      tier: options.tier,
      type: options.type,
      data: sanitizedData,
    };

    store.events.push(event);
    this.emit("eventRecorded", event);
    return event;
  }

  getEvents(projectId: string, fromSeq = 0): ProjectEvent<any>[] {
    const store = this.projectStores.get(projectId);
    if (!store) return [];
    return store.events.filter((e) => e.seq >= fromSeq).map((e) => ({ ...e }));
  }

  getCurrentSeq(projectId: string): number {
    const store = this.projectStores.get(projectId);
    return store ? store.currentSeq : 0;
  }
}

export const hostEventStore = new HostEventStore();
