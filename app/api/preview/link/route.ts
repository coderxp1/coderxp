/**
 * Preview Link API — CoderXP Live Preview
 *
 * POST /api/preview/link — create a new 128-bit preview slug
 * DELETE /api/preview/link — revoke a slug
 * GET /api/preview/link — list active links for project
 */

import { NextResponse } from "next/server";
import { validateRequestAuth } from "@/lib/server/auth";
import { previewLinkStore } from "@/lib/server/preview-link-store";
import { projectActivePorts } from "@/lib/server/devbox-broker";

const PREVIEW_DOMAIN = process.env.PREVIEW_DOMAIN ?? "preview.coderxp.pro";
const LIVE_PREVIEW_ENABLED = process.env.LIVE_PREVIEW_ENABLED === "true";

export async function POST(req: Request) {
  if (!LIVE_PREVIEW_ENABLED) {
    return NextResponse.json(
      {
        ok: false,
        error: "Live preview is disabled on shared infrastructure pending dedicated host migration.",
      },
      { status: 503 },
    );
  }

  const auth = validateRequestAuth(req);
  if (!auth.authenticated) {
    return NextResponse.json({ ok: false, error: "Authentication required." }, { status: 401 });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as {
      projectId?: string;
      containerPort?: number;
    };

    const projectId = body.projectId || "default-project";
    const detected = projectActivePorts.get(projectId);
    const containerPort =
      typeof body.containerPort === "number" && body.containerPort !== 3000
        ? body.containerPort
        : (detected || body.containerPort || 3000);

    const link = previewLinkStore.create({
      projectId,
      userId: auth.userId!,
      containerPort,
    });

    const url = `https://${link.slug}.${PREVIEW_DOMAIN}`;

    return NextResponse.json({
      ok: true,
      slug: link.slug,
      url,
      containerPort: link.containerPort,
      expiresAt: link.expiresAt,
      createdAt: link.createdAt,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const auth = validateRequestAuth(req);
  if (!auth.authenticated) {
    return NextResponse.json({ ok: false, error: "Authentication required." }, { status: 401 });
  }

  try {
    const url = new URL(req.url);
    let slug = url.searchParams.get("slug") || "";
    let projectId = url.searchParams.get("projectId") || "";

    if (!slug) {
      const body = (await req.json().catch(() => ({}))) as {
        slug?: string;
        projectId?: string;
      };
      slug = body.slug || "";
      if (body.projectId) projectId = body.projectId;
    }

    if (!slug) {
      return NextResponse.json({ ok: false, error: "slug is required" }, { status: 400 });
    }

    const effectiveProjectId = projectId || "default-project";
    const revoked = previewLinkStore.revoke(slug, effectiveProjectId);
    return NextResponse.json({ ok: revoked, revoked });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const auth = validateRequestAuth(req);
  if (!auth.authenticated) {
    return NextResponse.json({ ok: false, error: "Authentication required." }, { status: 401 });
  }

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") || "default-project";

  const links = previewLinkStore.listForProject(projectId);
  return NextResponse.json({ ok: true, links });
}