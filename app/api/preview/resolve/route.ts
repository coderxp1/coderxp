import { NextResponse } from "next/server";
import { previewLinkStore } from "@/lib/server/preview-link-store";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") ?? "";

  if (!slug) {
    return NextResponse.json({ ok: false, error: "slug required" }, { status: 400 });
  }

  const link = previewLinkStore.get(slug);
  if (!link) {
    return NextResponse.json({ ok: false, error: "not found or revoked" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    slug: link.slug,
    projectId: link.projectId,
    containerPort: link.containerPort || 3000,
  });
}