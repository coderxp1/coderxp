import { NextRequest, NextResponse } from "next/server";
import {
  validateRequestAuth,
  verifyPassword,
  updateAdminPassword,
  ADMIN_CONFIG,
  SESSION_COOKIE_NAME,
  getCredentialGeneration,
  StaleCredentialChangeError,
} from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authenticated password update endpoint.
 * Requires valid session, current password, and new password >= 8 chars.
 * Delegates to updateAdminPassword (the sole credential-change entry point),
 * which serializes overlapping updates, revalidates generation and the current
 * password, persists, then activates. Existing sessions are invalidated.
 */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    const auth = validateRequestAuth(req);
    if (!auth.authenticated) {
      return NextResponse.json(
        { ok: false, error: "Authentication required to change password." },
        { status: 401 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const currentPassword = body.currentPassword || "";
    const newPassword = body.newPassword || "";

    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { ok: false, error: "Current password and new password are required." },
        { status: 400 },
      );
    }

    if (newPassword.length < 8) {
      return NextResponse.json(
        { ok: false, error: "New password must be at least 8 characters long." },
        { status: 400 },
      );
    }

    const expectedGeneration = getCredentialGeneration();
    const isValidCurrent = verifyPassword(currentPassword, ADMIN_CONFIG.password);
    if (!isValidCurrent) {
      return NextResponse.json(
        { ok: false, error: "Current password does not match." },
        { status: 403 },
      );
    }

    await updateAdminPassword(newPassword, {
      currentPassword,
      expectedGeneration,
    });

    const response = NextResponse.json({
      ok: true,
      message: "Password updated successfully. Please sign in again.",
      algorithm: "pbkdf2-sha512",
      iterations: 100000,
      sessionsInvalidated: true,
    });

    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: "",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });

    return response;
  } catch (err: unknown) {
    if (err instanceof StaleCredentialChangeError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 409 });
    }
    const message =
      err instanceof Error ? err.message : "Failed to change password.";
    if (message === "Current password does not match.") {
      return NextResponse.json({ ok: false, error: message }, { status: 403 });
    }
    const safe =
      message.includes("persist") || message.includes("verify persisted")
        ? message
        : "Failed to change password.";
    return NextResponse.json({ ok: false, error: safe }, { status: 500 });
  }
}
