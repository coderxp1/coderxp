/**
 * BYOK Management API Route for CoderXP Revision 2.3.
 * Gated by application-level session authentication.
 */

import { NextResponse } from "next/server";
import {
  saveServerByok,
  listServerByok,
  revokeServerByok,
} from "@/lib/workspace/byok-server-store";
import type { ByokProviderId } from "@/lib/workspace/byok-providers";
import { validateRequestAuth } from "@/lib/server/auth";

export async function POST(req: Request) {
  const auth = validateRequestAuth(req);
  if (!auth.authenticated) {
    return NextResponse.json(
      { ok: false, error: "Authentication required." },
      { status: 401 },
    );
  }

  try {
    const body = (await req.json()) as {
      providerId: ByokProviderId;
      apiKey: string;
      baseUrl?: string;
      mode?: "local" | "cloud";
    };

    if (!body || !body.providerId || !body.apiKey) {
      return NextResponse.json(
        { ok: false, error: "providerId and apiKey are required." },
        { status: 400 },
      );
    }

    const userId = auth.userId || "coderxpadmin";
    const result = await saveServerByok(userId, body.providerId, body.apiKey, {
      baseUrl: body.baseUrl,
      mode: body.mode,
    });

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error || "Validation failed." },
        { status: 400 },
      );
    }

    return NextResponse.json({
      ok: true,
      providerId: body.providerId,
      maskedKey: result.record?.maskedKey,
      models: result.record?.models,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Internal server error during BYOK validation." },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  const auth = validateRequestAuth(req);
  if (!auth.authenticated) {
    return NextResponse.json(
      { ok: false, error: "Authentication required." },
      { status: 401 },
    );
  }

  const userId = auth.userId || "coderxpadmin";
  const records = listServerByok(userId);
  return NextResponse.json({ ok: true, keys: records });
}

export async function DELETE(req: Request) {
  const auth = validateRequestAuth(req);
  if (!auth.authenticated) {
    return NextResponse.json(
      { ok: false, error: "Authentication required." },
      { status: 401 },
    );
  }

  try {
    const url = new URL(req.url);
    const providerId = url.searchParams.get("providerId") as ByokProviderId;
    if (!providerId) {
      return NextResponse.json(
        { ok: false, error: "providerId query parameter is required." },
        { status: 400 },
      );
    }

    const userId = auth.userId || "coderxpadmin";
    const ok = revokeServerByok(userId, providerId);
    return NextResponse.json({ ok, revoked: providerId });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Failed to revoke key." },
      { status: 500 },
    );
  }
}
