/**
 * T3 Approval Decision Endpoint for CoderXP Phase A.
 * Gated by application-level session authentication.
 */

import { NextResponse } from "next/server";
import { devboxCredentialGate } from "@/lib/server/devbox-credential-gate";
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
      branch?: string;
      scope?: "single" | "session";
      decision?: "approved" | "rejected";
    };

    const projectId = body.projectId || "default-project";
    const branch = body.branch || "main";
    const scope = body.scope || "single";

    if (body.decision === "approved") {
      devboxCredentialGate.grantApproval(projectId, branch, scope);
      return NextResponse.json({ ok: true, approved: true, projectId, branch, scope });
    }

    return NextResponse.json({ ok: true, approved: false, reason: "Rejected by user" });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message || "Internal server error." },
      { status: 500 },
    );
  }
}
