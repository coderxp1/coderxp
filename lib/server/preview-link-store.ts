/**
 * Preview Link Store for CoderXP Live Preview.
 *
 * Implements spec:
 * - 128-bit cryptographically random slugs (crypto.randomBytes(16).toString("hex"))
 * - Revocation (T1 event on revoke, T2 event on create)
 * - PORT=3000 injected into container; router maps slug -> port
 * - Cookie isolation enforced at Nginx layer
 */

import crypto from "node:crypto";
import { hostEventStore } from "@/lib/server/devbox-event-store";

export interface PreviewLink {
  slug: string;          // 32 hex chars = 128 bit
  projectId: string;
  userId: string;
  containerPort: number; // the port on the host that the preview container binds
  createdAt: number;
  expiresAt: number | null; // null = no expiry
  revokedAt: number | null;
}

const PREVIEW_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours default

class PreviewLinkStore {
  private links = new Map<string, PreviewLink>();

  create(options: {
    projectId: string;
    userId: string;
    containerPort?: number;
    ttlMs?: number;
  }): PreviewLink {
    const slug = crypto.randomBytes(16).toString("hex"); // 128-bit
    const now = Date.now();
    const link: PreviewLink = {
      slug,
      projectId: options.projectId,
      userId: options.userId,
      containerPort: options.containerPort ?? 3000,
      createdAt: now,
      expiresAt: now + (options.ttlMs ?? PREVIEW_TTL_MS),
      revokedAt: null,
    };

    this.links.set(slug, link);

    // T2 event + audit on link creation (spec requirement)
    hostEventStore.recordEvent({
      projectId: options.projectId,
      actor: "user",
      tier: "T2",
      type: "preview.created",
      data: {
        slug,
        containerPort: link.containerPort,
        expiresAt: link.expiresAt,
        action: "created",
      },
    });

    return link;
  }

  get(slug: string): PreviewLink | null {
    const link = this.links.get(slug);
    if (!link) return null;
    if (link.revokedAt) return null;
    if (link.expiresAt && Date.now() > link.expiresAt) return null;
    return link;
  }

  revoke(slug: string, projectId: string): boolean {
    const link = this.links.get(slug);
    if (!link) return false;
    link.revokedAt = Date.now();

    // T1 revocation audit event
    hostEventStore.recordEvent({
      projectId,
      actor: "user",
      tier: "T1",
      type: "preview.created",
      data: {
        slug,
        action: "revoked",
        revokedAt: link.revokedAt,
      },
    });

    return true;
  }

  listForProject(projectId: string): PreviewLink[] {
    const now = Date.now();
    return Array.from(this.links.values()).filter(
      (l) =>
        l.projectId === projectId &&
        !l.revokedAt &&
        (l.expiresAt === null || now <= l.expiresAt),
    );
  }
}

export const previewLinkStore = new PreviewLinkStore();