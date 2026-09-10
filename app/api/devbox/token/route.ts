/**
 * Devbox WSS Token Generation Endpoint for CoderXP Revision 2.4.
 *
 * Implements Amendment 1:
 * - Issues short-lived (60s) single-use WSS tokens for authenticated workspace sessions.
 * - Gated by application-level session authentication.
 */

import { NextResponse } from "next/server";
import { mintDevboxWssToken } from "@/lib/server/devbox-token";
import { devboxMetering } from "@/lib/devbox/metering";
import type { UserPlanTier } from "@/lib/devbox/types";
import { validateRequestAuth } from "@/lib/server/auth";

export async function POST(req: Request) {
  const auth = validateRequestAuth(req);
  if (!auth.authenticated) {
    return NextResponse.json(
      { ok: false, error: "Authentication required to generate Devbox token." },
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

    // 1. Verify tier entitlement & quota
    const check = devboxMetering.canStartDevbox(userId, tier);
    if (!check.allowed) {
      return NextResponse.json(
        { ok: false, error: check.reason },
        { status: 403 },
      );
    }

    // 2. Mint single-use token
    const token = mintDevboxWssToken(userId, projectId);

    return NextResponse.json({
      ok: true,
      token,
      expiresInSeconds: 60,
      wsUrl: `/ws/devbox/?token=${encodeURIComponent(token)}&projectId=${encodeURIComponent(projectId)}`,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Internal server error." },
      { status: 500 },
    );
  }
}
