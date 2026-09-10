import { NextResponse } from "next/server";
import { devboxBroker } from "@/lib/server/devbox-broker";
import { validateRequestAuth } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
      files?: Array<{ path: string; contents: string }>;
    };

    const projectId = body.projectId || "default-project";
    const files = body.files || [];

    if (!Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ ok: true, synced: 0 });
    }

    const result = await devboxBroker.syncFilesToDevbox(projectId, files);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error || "Failed to sync files to devbox." },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, synced: result.count });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Internal server error." },
      { status: 500 },
    );
  }
}
