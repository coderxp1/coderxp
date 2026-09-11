import { getHandlerContext } from "@/lib/server/agent-runtime/shared";
import { handleControl } from "@/lib/server/agent-runtime/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await context.params;
    return await handleControl(getHandlerContext(), req, sessionId);
  } catch {
    return Response.json(
      { ok: false, error: "AUTHORIZATION_UNAVAILABLE", message: "Runtime authorization is unavailable." },
      { status: 503 },
    );
  }
}
