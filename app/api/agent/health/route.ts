import { NextResponse } from "next/server";
import { getActiveProvider } from "@/lib/server/agent-provider-registry";
import { isSameOriginRequest } from "@/lib/server/agent-same-origin";
import { validateRequestAuth } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Safe agent health. Gated by application-level session authentication.
 */
export async function GET(req: Request): Promise<Response> {
  const auth = validateRequestAuth(req);
  if (!auth.authenticated) {
    return NextResponse.json(
      { errorCode: "UNAUTHORIZED", error: "Authentication required to view agent health." },
      { status: 401 },
    );
  }

  if (!isSameOriginRequest(req)) {
    return NextResponse.json(
      { errorCode: "ACCESS_RESTRICTED", message: "Cross-origin agent requests are not allowed." },
      { status: 403 },
    );
  }

  const provider = getActiveProvider();
  const health = provider.getSafeHealth();

  return NextResponse.json({
    ok: health.ok,
    provider: health.provider === "anthropic-byok" ? "anthropic" : health.provider,
    providerId: health.provider,
    model: health.defaultModelDisplayName || "azure/gpt-4o-mini",
    defaultModel: health.defaultModelDisplayName || "azure/gpt-4o-mini",
    ready: health.ready,
    access: health.access,
    status: health.status,
    byokRequired: health.byokRequired,
    displayName: health.displayName,
    defaultModelDisplayName: health.defaultModelDisplayName,
  });
}
