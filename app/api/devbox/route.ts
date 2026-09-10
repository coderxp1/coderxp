/**
 * Devbox Lifecycle & Control API Route for CoderXP Revision 2.4.
 * Gated by application-level session authentication.
 */

import { NextResponse } from "next/server";
import { devboxBroker } from "@/lib/server/devbox-broker";
import { getDevboxAuditLogs } from "@/lib/devbox/audit-logger";
import { getProjectGitSnapshots, getLatestSnapshot } from "@/lib/devbox/git-snapshot";
import type { UserPlanTier } from "@/lib/devbox/types";
import { validateRequestAuth } from "@/lib/server/auth";

export async function POST(req: Request) {
  const auth = validateRequestAuth(req);
  if (!auth.authenticated) {
    return NextResponse.json(
      { ok: false, error: "Authentication required." },
      { status: 401 },
    );
  }

  try {
    const body = (await req.json().catch(() => ({}))) as {
      projectId?: string;
      userId?: string;
      tier?: UserPlanTier;
    };

    const projectId = body.projectId || "default-project";
    const userId = auth.userId || body.userId || "coderxpadmin";
    const tier = body.tier || "pro";

    const result = await devboxBroker.getOrCreateDevbox(projectId, userId, tier);
    if (!result.ok) {
      const status = result.errorCode === "HOST_CAPACITY_REACHED" ? 429 : 403;
      return NextResponse.json(
        { ok: false, errorCode: result.errorCode, error: result.error || "Failed to start devbox." },
        { status },
      );
    }

    return NextResponse.json({ ok: true, status: result.status });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message || "Internal server error." },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  const auth = validateRequestAuth(req);
  if (!auth.authenticated) {
    return NextResponse.json(
      { ok: false, error: "Authentication required." },
      { status: 401 },
    );
  }

  try {
    const url = new URL(req.url);
    const projectId = url.searchParams.get("projectId") || "default-project";

    const status = devboxBroker.getStatus(projectId);
    const auditLogs = getDevboxAuditLogs(projectId);
    const gitSnapshots = getProjectGitSnapshots(projectId);

    return NextResponse.json({
      ok: true,
      status,
      auditLogs,
      gitSnapshots,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message || "Internal server error." },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request) {
  const auth = validateRequestAuth(req);
  if (!auth.authenticated) {
    return NextResponse.json(
      { ok: false, error: "Authentication required." },
      { status: 401 },
    );
  }

  try {
    const url = new URL(req.url);
    let projectId: string | null | undefined = url.searchParams.get("projectId");
    let isPermanent = url.searchParams.get("permanent") === "true";

    if (!projectId) {
      const body = (await req.json().catch(() => ({}))) as {
        projectId?: string;
        permanent?: boolean;
      };
      projectId = body.projectId;
      if (body.permanent !== undefined) {
        isPermanent = Boolean(body.permanent);
      }
    }

    const effectiveProjectId = projectId || "default-project";

    if (isPermanent) {
      // Step 2: Permanent Purge
      const res = await devboxBroker.permanentDeleteDevbox(effectiveProjectId);
      return NextResponse.json({ ok: true, permanent: true, purged: res.purged });
    }

    // Step 1: Soft Delete with 7-Day Grace Period
    const res = await devboxBroker.softDeleteDevbox(effectiveProjectId);
    return NextResponse.json({ ok: true, permanent: false, purgeAt: res.purgeAt });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message || "Internal server error." },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  const auth = validateRequestAuth(req);
  if (!auth.authenticated) {
    return NextResponse.json(
      { ok: false, error: "Authentication required." },
      { status: 401 },
    );
  }

  try {
    const body = (await req.json().catch(() => ({}))) as {
      projectId?: string;
      action?: "stop-agent" | "freeze" | "restore" | "rollback";
    };

    const projectId = body.projectId || "default-project";

    if (body.action === "stop-agent") {
      const res = await devboxBroker.stopAgent(projectId);
      return NextResponse.json({ ok: true, terminatedCount: res.terminatedCount });
    }

    if (body.action === "freeze") {
      const res = await devboxBroker.freezeDevbox(projectId);
      return NextResponse.json({ ok: true, frozen: res.ok });
    }

    if (body.action === "restore") {
      const res = await devboxBroker.restoreDevbox(projectId);
      return NextResponse.json({ ok: res.ok, status: res.status });
    }

    if (body.action === "rollback") {
      const latest = getLatestSnapshot(projectId);
      if (!latest) {
        return NextResponse.json(
          { ok: false, error: "No pre-push snapshots found to roll back." },
          { status: 404 },
        );
      }
      return NextResponse.json({
        ok: true,
        rollbackCommand: latest.rollbackCommand,
        snapshot: latest,
      });
    }

    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message || "Internal server error." },
      { status: 500 },
    );
  }
}
