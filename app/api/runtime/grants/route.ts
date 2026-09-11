import { getHandlerContext } from "@/lib/server/agent-runtime/shared";
import { handleIssueGrant } from "@/lib/server/agent-runtime/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    return await handleIssueGrant(getHandlerContext(), req);
  } catch {
    return Response.json(
      { ok: false, error: "AUTHORIZATION_UNAVAILABLE", message: "Runtime authorization is unavailable." },
      { status: 503 },
    );
  }
}
