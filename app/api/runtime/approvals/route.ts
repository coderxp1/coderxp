import { getHandlerContext } from "@/lib/server/agent-runtime/shared";
import { handleIssueApproval } from "@/lib/server/agent-runtime/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    return await handleIssueApproval(getHandlerContext(), req);
  } catch {
    return Response.json(
      { ok: false, error: "AUTHORIZATION_UNAVAILABLE", message: "Runtime authorization is unavailable." },
      { status: 503 },
    );
  }
}
