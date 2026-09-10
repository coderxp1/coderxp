import { NextRequest, NextResponse } from "next/server";
import {
  verifyAdminCredentials,
  createSessionToken,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  ADMIN_CONFIG,
} from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const identifier = body.identifier || body.email || body.username || "";
    const password = body.password || "";

    if (!identifier || !password) {
      return NextResponse.json(
        { ok: false, error: "Email/username and password are required." },
        { status: 400 },
      );
    }

    const isValid = verifyAdminCredentials(identifier, password);
    if (!isValid) {
      return NextResponse.json(
        { ok: false, error: "Invalid email/username or password." },
        { status: 401 },
      );
    }

    const sessionToken = createSessionToken(ADMIN_CONFIG.userId, ADMIN_CONFIG.email);

    const response = NextResponse.json({
      ok: true,
      user: {
        userId: ADMIN_CONFIG.userId,
        email: ADMIN_CONFIG.email,
        role: "admin",
      },
      token: sessionToken,
    });

    // Set secure HTTP-Only Cookie
    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: sessionToken,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });

    return response;
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message || "Internal server error." },
      { status: 500 },
    );
  }
}
