import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB limit

const ALLOWED_MIME_PREFIXES = [
  "image/",
  "video/",
  "text/",
  "application/pdf",
  "application/json",
  "application/zip",
  "application/x-zip-compressed",
];

const ALLOWED_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg",
  "mp4", "webm", "mov",
  "pdf", "fig", "zip",
  "txt", "md", "json", "js", "ts", "tsx", "jsx", "html", "css", "scss",
]);

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const projectId = (formData.get("projectId") as string | null) || "default";

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json(
        { ok: false, error: "A valid 'file' form-data field is required." },
        { status: 400 },
      );
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        {
          ok: false,
          error: `File size exceeds the 25 MB limit (file is ${(file.size / 1048576).toFixed(1)} MB).`,
        },
        { status: 413 },
      );
    }

    const name = file.name || "attachment";
    const ext = name.split(".").pop()?.toLowerCase() || "";
    const type = file.type || "application/octet-stream";

    const isAllowedMime = ALLOWED_MIME_PREFIXES.some((p) => type.startsWith(p));
    const isAllowedExt = ALLOWED_EXTENSIONS.has(ext);

    if (!isAllowedMime && !isAllowedExt) {
      return NextResponse.json(
        {
          ok: false,
          error: `Unsupported file type "${type}". Allowed: images, videos, PDFs, Figma, ZIP, and code/text files.`,
        },
        { status: 415 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let textContent: string | undefined;
    let dataUrl: string | undefined;

    if (type.startsWith("text/") || ["json", "js", "ts", "tsx", "jsx", "html", "css", "md", "txt"].includes(ext)) {
      textContent = buffer.toString("utf-8");
    } else if (file.size <= 5 * 1024 * 1024 && (type.startsWith("image/") || type === "application/pdf")) {
      dataUrl = `data:${type};base64,${buffer.toString("base64")}`;
    }

    return NextResponse.json({
      ok: true,
      attachment: {
        id,
        name,
        size: file.size,
        mimeType: type,
        projectId,
        textContent,
        dataUrl,
        uploadedAt: Date.now(),
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to process attachment." },
      { status: 500 },
    );
  }
}
