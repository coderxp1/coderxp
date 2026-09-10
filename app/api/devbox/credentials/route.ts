/**
 * Git Credential Gate API Endpoint for CoderXP Phase A.
 *
 * Implements Amendment 2:
 * - Server-side enforcement point for git credentials.
 * - Called by the container's git-credential-helper.
 */

import { NextResponse } from "next/server";
import { devboxCredentialGate } from "@/lib/server/devbox-credential-gate";
import type { ActionPolicyRequest } from "@/lib/devbox/event-types";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      projectId?: string;
      actionRequest?: ActionPolicyRequest;
      serverPat?: string;
    };

    const projectId = body.projectId || "default-project";
    const actionReq = body.actionRequest || {
      type: "git_push",
      branch: "main",
      isDefaultBranch: true,
    };
    const serverPat = body.serverPat || process.env.GITHUB_TOKEN || "ghp_default_pat";

    const result = devboxCredentialGate.requestGitCredentials(projectId, actionReq, serverPat);
    return NextResponse.json({
      ok: result.allowed,
      allowed: result.allowed,
      pat: result.pat,
      error: result.error,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message || "Internal server error." },
      { status: 500 },
    );
  }
}
