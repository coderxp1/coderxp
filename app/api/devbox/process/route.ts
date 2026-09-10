import { NextResponse } from "next/server";
import { devboxBroker } from "@/lib/server/devbox-broker";
import { validateRequestAuth } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
      command?: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    };

    const projectId = body.projectId || "default-project";
    const command = body.command || "";
    const args = body.args || [];
    const cwd = body.cwd || "/workspace";
    const env = body.env || {};

    if (!command) {
      return NextResponse.json(
        { ok: false, error: "Command is required." },
        { status: 400 },
      );
    }

    const result = await devboxBroker.startBackgroundProcess(
      projectId,
      command,
      args,
      cwd,
      env,
    );

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error || "Failed to start process." },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      pid: result.pid,
      processId: result.processId,
      port: result.port,
      output: result.output,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Internal server error." },
      { status: 500 },
    );
  }
}
