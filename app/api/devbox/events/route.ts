/**
 * Host Event Bus API Endpoint for CoderXP Phase A.
 * Gated by application-level session authentication.
 */

import { NextResponse } from "next/server";
import { hostEventStore } from "@/lib/server/devbox-event-store";
import { validateRequestAuth } from "@/lib/server/auth";

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
    const fromSeq = parseInt(url.searchParams.get("fromSeq") || "0", 10);

    const events = hostEventStore.getEvents(projectId, fromSeq);
    const currentSeq = hostEventStore.getCurrentSeq(projectId);

    return NextResponse.json({
      ok: true,
      projectId,
      currentSeq,
      events,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message || "Internal server error." },
      { status: 500 },
    );
  }
}

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
      sessionId?: string;
      tier?: any;
      type?: any;
      data?: any;
    };

    const projectId = body.projectId || "default-project";
    if (!body.type || !body.tier) {
      return NextResponse.json(
        { ok: false, error: "Missing event type or tier." },
        { status: 400 },
      );
    }

    const event = hostEventStore.recordEvent({
      projectId,
      sessionId: body.sessionId || "default-session",
      tier: body.tier,
      type: body.type,
      data: body.data || {},
    });

    return NextResponse.json({ ok: true, event });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message || "Internal server error." },
      { status: 500 },
    );
  }
}
