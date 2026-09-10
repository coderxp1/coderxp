import { NextRequest, NextResponse } from "next/server";
import {
  createAgentStreamHandler,
  createConcurrencyGate,
  defaultStreamLimits,
  MAX_GLOBAL_CONCURRENT_STREAMS,
} from "@/lib/server/agent-stream-handler";
import { getActiveProvider } from "@/lib/server/agent-provider-registry";
import { validateRequestAuth } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const globalConcurrencyGate = createConcurrencyGate(MAX_GLOBAL_CONCURRENT_STREAMS);

export async function POST(req: NextRequest): Promise<Response> {
  // Application-level authentication gate
  const auth = validateRequestAuth(req);
  if (!auth.authenticated) {
    return NextResponse.json(
      {
        error: "Unauthorized. Valid session required to access streaming agent.",
        errorCode: "UNAUTHORIZED",
      },
      { status: 401 },
    );
  }

  const handler = createAgentStreamHandler({
    fetchUpstream: fetch,
    clock: () => Date.now(),
    scheduleTimeout: (fn, ms) => setTimeout(fn, ms),
    cancelTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    limits: defaultStreamLimits,
    concurrency: globalConcurrencyGate,
    provider: getActiveProvider(),
  });

  return handler(req);
}
