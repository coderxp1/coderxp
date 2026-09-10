import { NextRequest, NextResponse } from "next/server";
import { safeWebFetch, validateUrlForFetch } from "@/lib/workspace/ssrf-guard";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const url = body?.url;

    if (!url || typeof url !== "string") {
      return NextResponse.json(
        { ok: false, error: "A valid 'url' string parameter is required." },
        { status: 400 },
      );
    }

    const validation = validateUrlForFetch(url);
    if (!validation.valid) {
      return NextResponse.json(
        { ok: false, error: `SSRF_BLOCKED: ${validation.reason}` },
        { status: 403 },
      );
    }

    const result = await safeWebFetch(url);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, status: result.status, error: result.error },
        { status: result.status >= 400 && result.status < 600 ? result.status : 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      status: result.status,
      content: result.text,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Internal Server Error" },
      { status: 500 },
    );
  }
}
