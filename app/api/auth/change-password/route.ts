import { NextRequest, NextResponse } from "next/server";
import {
  validateRequestAuth,
  verifyPassword,
  updateAdminPassword,
  ADMIN_CONFIG,
} from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authenticated password update endpoint.
 * Requires:
 * 1. Valid session cookie or Authorization header.
 * 2. Current password verification.
 * 3. New password of at least 8 characters.
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

    // Verify current password against stored password or hash
    const isValidCurrent = verifyPassword(currentPassword, ADMIN_CONFIG.password);
    if (!isValidCurrent) {
      return NextResponse.json(
        { ok: false, error: "Current password does not match." },
        { status: 403 },
      );
    }

    // Update in-memory password with PBKDF2 hash
    const newHash = updateAdminPassword(newPassword);

    return NextResponse.json({
      ok: true,
      message: "Password updated successfully with PBKDF2 hashing.",
      algorithm: "pbkdf2-sha512",
      iterations: 100000,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message || "Failed to change password." },
      { status: 500 },
    );
  }
}
