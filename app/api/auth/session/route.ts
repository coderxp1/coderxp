import { NextRequest, NextResponse } from "next/server";
import { validateRequestAuth } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const auth = validateRequestAuth(req);

  if (!auth.authenticated) {
    return NextResponse.json(
      { authenticated: false, error: auth.error || "Unauthenticated." },
      { status: 401 },
    );
  }

  return NextResponse.json({
    authenticated: true,
    user: {
      userId: auth.userId,
      email: auth.email,
      role: "admin",
    },
  });
}
