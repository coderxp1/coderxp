/**
 * Agent runtime slice — HTTP handlers (framework-agnostic Request/Response).
 *
 * Thin translation over authorize() + AuthorizedRuntime: parse, build the
 * descriptor from server-trusted bindings (session id from the route, owner
 * from the verified session, project from the registry), authorize the
 * exact descriptor, then dispatch with dispatch-equality enforcement.
 * Route files re-export these; tests drive them with real Request objects.
 */

import { authorize, type AuthorizeDeps } from "../authorization/enforce";
import { validateDescriptor } from "../authorization/policy";
import { AuthorizationError } from "../authorization/types";
import { SESSION_COOKIE_NAME } from "../auth";
import type { AuthorizedRuntime } from "./authorized-provider";
import { projectExecOutcome, projectSessionStatus, projectStreamFrame } from "./projection";
import type { SessionRuntime } from "./provider";
import type { RuntimeSessionRegistry } from "./sessions";
import { RuntimeError, type AuthorizedCall, type LeaseHolder } from "./types";

const LEGACY_SESSION_COOKIE_NAME = "coderxp_session";

export interface RuntimeContext {
  authz: AuthorizeDeps;
  authorized: AuthorizedRuntime;
  runtime: SessionRuntime;
  registry: RuntimeSessionRegistry;
}

export interface RequestCreds {
  grantId?: string;
  approval?: string;
}

/** Session-token extraction mirroring lib/server/auth validateRequestAuth transports. */
export function extractSessionToken(req: Request): string {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookieMatch =
    cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`)) ||
    cookieHeader.match(new RegExp(`(?:^|;\\s*)${LEGACY_SESSION_COOKIE_NAME}=([^;]+)`));
  if (cookieMatch) return cookieMatch[1];
  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) return authHeader.slice("Bearer ".length);
  return req.headers.get("x-coderxp-session") ?? "";
}

export function extractCreds(req: Request, body?: Record<string, unknown>): RequestCreds {
  const url = new URL(req.url, "http://localhost");
  const grantId =
    (typeof body?.grantId === "string" ? body.grantId : undefined) ??
    req.headers.get("x-coderxp-grant") ??
    url.searchParams.get("grantId") ??
    undefined;
  const approval =
    (typeof body?.approval === "string" ? body.approval : undefined) ??
    req.headers.get("x-coderxp-approval") ??
    url.searchParams.get("approval") ??
    undefined;
  return { ...(grantId ? { grantId } : {}), ...(approval ? { approval } : {}) };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null) throw new Error("body must be an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new AuthorizationError("MALFORMED_REQUEST", "Request body must be a JSON object.", 400);
  }
}

function toErrorResponse(err: unknown): Response {
  if (err instanceof AuthorizationError) {
    return json({ ok: false, error: err.code, message: err.message }, err.status);
  }
  if (err instanceof RuntimeError) {
    return json({ ok: false, error: err.code, message: err.message }, err.status);
  }
  return json({ ok: false, error: "INTERNAL_ERROR", message: "Internal runtime error." }, 500);
}

async function validatedCaller(ctx: RuntimeContext, req: Request): Promise<string> {
  const token = extractSessionToken(req);
  if (!token) {
    throw new AuthorizationError("NOT_AUTHENTICATED", "Authentication required.", 401);
  }
  const session = ctx.authz.validateSession(token);
  if (!session) {
    throw new AuthorizationError("NOT_AUTHENTICATED", "Invalid or expired session.", 401);
  }
  return session.userId;
}

async function authorizeCall(
  ctx: RuntimeContext,
  req: Request,
  rawDescriptor: unknown,
  body?: Record<string, unknown>,
): Promise<AuthorizedCall> {
  const token = extractSessionToken(req);
  const descriptor = validateDescriptor(rawDescriptor);
  const creds = extractCreds(req, body);
  const authz = authorize(ctx.authz, {
    token,
    descriptor,
    ...(creds.grantId !== undefined ? { grantId: creds.grantId } : {}),
    ...(creds.approval !== undefined ? { approval: creds.approval } : {}),
  });
  return {
    authz,
    descriptor: {
      operationId: descriptor.operationId,
      projectId: descriptor.projectId,
      ...(descriptor.agentSessionId !== undefined ? { agentSessionId: descriptor.agentSessionId } : {}),
      action: descriptor.action,
      ...(descriptor.resource !== undefined ? { resource: descriptor.resource } : {}),
      ...(descriptor.args !== undefined ? { args: descriptor.args } : {}),
      ...(descriptor.networkNeed !== undefined ? { networkNeed: descriptor.networkNeed } : {}),
      ...(descriptor.execMode !== undefined ? { execMode: descriptor.execMode } : {}),
    },
  };
}

/** Server-trusted project binding for a session route parameter. */
function projectForSession(ctx: RuntimeContext, sessionId: string): string {
  const projectId = ctx.registry.getSessionProject(sessionId);
  if (!projectId) {
    throw new RuntimeError("SESSION_UNKNOWN", "Session is unknown to this runtime.", 404);
  }
  return projectId;
}

function sessionResource(sessionId: string): string {
  return `sessions/${sessionId}`;
}

/* ------------------------------------------------------------------ */
/* Credential issuance (the explicit consent ceremony)                  */
/* ------------------------------------------------------------------ */

export async function handleIssueApproval(ctx: RuntimeContext, req: Request): Promise<Response> {
  try {
    const userId = await validatedCaller(ctx, req);
    const body = await readBody(req);
    const descriptor = validateDescriptor(body.descriptor);
    const owner = ctx.registry.findProjectOwner(descriptor.projectId);
    if (owner !== null && owner !== userId) {
      throw new AuthorizationError("NO_PROJECT_ACCESS", "No access to this project.", 403, descriptor.operationId);
    }
    if (descriptor.agentSessionId !== undefined) {
      const home = ctx.registry.getSessionProject(descriptor.agentSessionId);
      const sessionOwner = ctx.registry.getSessionOwner(descriptor.agentSessionId);
      if (home !== null && (home !== descriptor.projectId || sessionOwner !== userId)) {
        throw new AuthorizationError("NO_PROJECT_ACCESS", "Agent session does not belong to this project.", 403, descriptor.operationId);
      }
      if (home === null && descriptor.action !== "runtime.allocate") {
        throw new AuthorizationError("NO_PROJECT_ACCESS", "Agent session is unknown to this runtime.", 403, descriptor.operationId);
      }
    }
    const issued = ctx.authz.approvals.issue(
      {
        actorUserId: userId,
        projectId: descriptor.projectId,
        agentSessionId: descriptor.agentSessionId ?? "",
        action: descriptor.action,
        args: descriptor.args ?? null,
        resource: descriptor.resource ?? "",
        networkNeed: descriptor.networkNeed ?? "",
        execMode: descriptor.execMode ?? "",
        destination: descriptor.destination ?? "",
        revision: descriptor.revision ?? "",
        operationId: descriptor.operationId,
        protectedTarget: descriptor.protectedTarget ?? false,
        ...(typeof body.ttlMs === "number" ? { ttlMs: body.ttlMs } : {}),
      },
      ctx.authz.sink,
    );
    return json({ ok: true, approval: issued.serialized, id: issued.token.id, expiresAt: issued.token.expiresAt }, 201);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleRevokeApproval(ctx: RuntimeContext, req: Request): Promise<Response> {
  try {
    await validatedCaller(ctx, req);
    const body = await readBody(req);
    if (typeof body.id !== "string" || typeof body.operationId !== "string") {
      throw new AuthorizationError("MALFORMED_REQUEST", "Revocation requires id and operationId.", 400);
    }
    ctx.authz.approvals.revoke(body.id, body.operationId, ctx.authz.sink);
    return json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleIssueGrant(ctx: RuntimeContext, req: Request): Promise<Response> {
  try {
    const userId = await validatedCaller(ctx, req);
    const body = await readBody(req);
    if (typeof body.projectId !== "string" || typeof body.operationId !== "string") {
      throw new AuthorizationError("MALFORMED_REQUEST", "Grant issuance requires projectId and operationId.", 400);
    }
    const owner = ctx.registry.findProjectOwner(body.projectId);
    if (owner !== null && owner !== userId) {
      throw new AuthorizationError("NO_PROJECT_ACCESS", "No access to this project.", 403);
    }
    let grant;
    try {
      grant = ctx.authz.grants.issue(
        {
          actorUserId: userId,
          projectId: body.projectId,
          agentSessionIds: body.agentSessionIds as string[] | "*",
          categories: body.categories as ("read" | "write" | "execute" | "preview")[],
          resourcePrefixes: body.resourcePrefixes as string[],
          egress: body.egress as "none" | "loopback",
          ttlMs: body.ttlMs as number,
          createdByOperationId: body.operationId,
        },
        ctx.authz.sink,
      );
    } catch (err) {
      if (err instanceof AuthorizationError) throw err;
      throw new AuthorizationError("MALFORMED_REQUEST", `Grant parameters rejected: ${err instanceof Error ? err.message : "invalid"}.`, 400);
    }
    return json({ ok: true, grant }, 201);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleRevokeGrant(ctx: RuntimeContext, req: Request): Promise<Response> {
  try {
    const userId = await validatedCaller(ctx, req);
    const body = await readBody(req);
    if (typeof body.id !== "string" || typeof body.operationId !== "string") {
      throw new AuthorizationError("MALFORMED_REQUEST", "Revocation requires id and operationId.", 400);
    }
    const grant = ctx.authz.grants.get(body.id);
    if (!grant || grant.actorUserId !== userId) {
      throw new AuthorizationError("GRANT_NOT_FOUND", "Grant does not exist.", 403, body.operationId);
    }
    ctx.authz.grants.revoke(body.id, body.operationId, ctx.authz.sink);
    return json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/* ------------------------------------------------------------------ */
/* Session lifecycle                                                   */
/* ------------------------------------------------------------------ */

export async function handleAllocate(ctx: RuntimeContext, req: Request): Promise<Response> {
  try {
    await ctx.runtime.init();
    const body = await readBody(req);
    const agentSessionId = typeof body.agentSessionId === "string" && body.agentSessionId !== "" ? body.agentSessionId : undefined;
    const call = await authorizeCall(ctx, req, {
      operationId: body.operationId,
      projectId: body.projectId,
      ...(agentSessionId !== undefined ? { agentSessionId } : {}),
      action: "runtime.allocate",
      resource: agentSessionId !== undefined ? sessionResource(agentSessionId) : "sessions",
      args: { cols: body.cols ?? 80, rows: body.rows ?? 24 },
    }, body);
    const result = await ctx.authorized.allocate(call, {
      operationId: call.descriptor.operationId,
      projectId: call.descriptor.projectId,
      ownerUserId: call.authz.principal.userId,
      ...(agentSessionId !== undefined ? { agentSessionId } : {}),
      cols: typeof body.cols === "number" ? body.cols : 80,
      rows: typeof body.rows === "number" ? body.rows : 24,
    });
    return json({ ok: true, session: result.info, lease: result.lease }, 201);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleStatus(ctx: RuntimeContext, req: Request, sessionId: string): Promise<Response> {
  try {
    await ctx.runtime.init();
    const url = new URL(req.url, "http://localhost");
    const call = await authorizeCall(ctx, req, {
      operationId: url.searchParams.get("operationId") ?? `status-${Date.now()}`,
      projectId: projectForSession(ctx, sessionId),
      agentSessionId: sessionId,
      action: "session.status",
      resource: sessionResource(sessionId),
    });
    return json({ ok: true, status: projectSessionStatus(ctx.authorized.status(call, sessionId)) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleExec(ctx: RuntimeContext, req: Request, sessionId: string): Promise<Response> {
  try {
    await ctx.runtime.init();
    const body = await readBody(req);
    const resource = typeof body.resource === "string" && body.resource !== "" ? body.resource : ".";
    const call = await authorizeCall(ctx, req, {
      operationId: body.operationId,
      projectId: projectForSession(ctx, sessionId),
      agentSessionId: sessionId,
      action: "exec",
      resource,
      args: body.args,
      networkNeed: body.networkNeed,
      execMode: body.execMode,
    }, body);
    const outcome = await ctx.authorized.exec(call, {
      operationId: call.descriptor.operationId,
      projectId: call.descriptor.projectId,
      agentSessionId: sessionId,
      resource: call.descriptor.resource ?? "",
      args: (body.args ?? {}) as { argv?: string[]; script?: string },
      execMode: body.execMode as "argv" | "shell-script",
      networkNeed: body.networkNeed as "none" | "loopback" | "external",
      timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : 60_000,
    });
    return json({ ok: true, outcome: projectExecOutcome(outcome) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/* ------------------------------------------------------------------ */
/* Streaming attach (poll + live SSE)                                  */
/* ------------------------------------------------------------------ */

export async function handleStream(ctx: RuntimeContext, req: Request, sessionId: string): Promise<Response> {
  try {
    await ctx.runtime.init();
    const url = new URL(req.url, "http://localhost");
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new AuthorizationError("MALFORMED_REQUEST", "cursor must be a non-negative integer.", 400);
    }
    if (url.searchParams.get("live") === "1") {
      return handleStreamLive(ctx, req, sessionId, cursor);
    }
    const call = await authorizeCall(ctx, req, {
      operationId: url.searchParams.get("operationId") ?? `attach-${Date.now()}`,
      projectId: projectForSession(ctx, sessionId),
      agentSessionId: sessionId,
      action: "terminal.attach",
      resource: sessionResource(sessionId),
      args: { cursor },
    });
    const attached = ctx.authorized.attach(call, sessionId, cursor);
    return json({
      ok: true,
      frames: attached.frames.map((f) => projectStreamFrame(f)),
      nextCursor: attached.nextCursor,
      gap: attached.gap,
      state: attached.state,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function handleStreamLive(ctx: RuntimeContext, req: Request, sessionId: string, cursor: number): Promise<Response> {
  const url = new URL(req.url, "http://localhost");
  const call = await authorizeCall(ctx, req, {
    operationId: url.searchParams.get("operationId") ?? `attach-live-${Date.now()}`,
    projectId: projectForSession(ctx, sessionId),
    agentSessionId: sessionId,
    action: "terminal.attach",
    resource: sessionResource(sessionId),
    args: { cursor, live: true },
  });
  const initial = ctx.authorized.attach(call, sessionId, cursor);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      if (initial.gap) send("gap", initial.gap);
      for (const frame of initial.frames) send("frame", projectStreamFrame(frame));
      send("state", { state: initial.state, cursor: initial.nextCursor });
      const unsubscribe = ctx.runtime.subscribe(sessionId, (frame) => {
        try {
          send("frame", projectStreamFrame(frame));
        } catch {
          // Client gone; cleanup runs on abort below.
        }
      });
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": heartbeat\n\n"));
        } catch {
          // Client gone; cleanup runs on abort below.
        }
      }, 15_000);
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      req.signal.addEventListener("abort", cleanup, { once: true });
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

/* ------------------------------------------------------------------ */
/* Input + control                                                     */
/* ------------------------------------------------------------------ */

export async function handleInput(ctx: RuntimeContext, req: Request, sessionId: string): Promise<Response> {
  try {
    await ctx.runtime.init();
    const body = await readBody(req);
    const lease = body.lease as { holder?: unknown; token?: unknown } | undefined;
    if (typeof body.data !== "string" || (lease?.holder !== "agent" && lease?.holder !== "user") || typeof lease?.token !== "string") {
      throw new AuthorizationError("MALFORMED_REQUEST", "Input requires data and a lease { holder, token }.", 400);
    }
    const call = await authorizeCall(ctx, req, {
      operationId: body.operationId,
      projectId: projectForSession(ctx, sessionId),
      agentSessionId: sessionId,
      action: "terminal.input",
      resource: sessionResource(sessionId),
      args: { data: body.data },
    }, body);
    const result = ctx.authorized.input(call, sessionId, body.data, {
      holder: lease.holder as LeaseHolder,
      token: lease.token as string,
    });
    return json({ ok: true, acceptedBytes: result.acceptedBytes });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleControl(ctx: RuntimeContext, req: Request, sessionId: string): Promise<Response> {
  try {
    await ctx.runtime.init();
    const body = await readBody(req);
    const op = body.op;
    const projectId = projectForSession(ctx, sessionId);
    switch (op) {
      case "resize": {
        const call = await authorizeCall(ctx, req, {
          operationId: body.operationId,
          projectId,
          agentSessionId: sessionId,
          action: "terminal.resize",
          resource: sessionResource(sessionId),
          args: { cols: body.cols, rows: body.rows },
        }, body);
        if (typeof body.cols !== "number" || typeof body.rows !== "number") {
          throw new AuthorizationError("MALFORMED_REQUEST", "resize requires numeric cols and rows.", 400);
        }
        ctx.authorized.resize(call, sessionId, body.cols, body.rows);
        return json({ ok: true });
      }
      case "interrupt": {
        const call = await authorizeCall(ctx, req, {
          operationId: body.operationId,
          projectId,
          agentSessionId: sessionId,
          action: "terminal.interrupt",
          resource: sessionResource(sessionId),
          args: {},
        }, body);
        ctx.authorized.interrupt(call, sessionId);
        return json({ ok: true });
      }
      case "lease-acquire": {
        if (body.holder !== "agent" && body.holder !== "user") {
          throw new AuthorizationError("MALFORMED_REQUEST", "lease-acquire requires holder agent|user.", 400);
        }
        const takeover = body.takeover === true;
        const call = await authorizeCall(ctx, req, {
          operationId: body.operationId,
          projectId,
          agentSessionId: sessionId,
          action: "terminal.lease",
          resource: sessionResource(sessionId),
          args: { holder: body.holder, takeover },
        }, body);
        const lease = ctx.authorized.acquireLease(call, sessionId, body.holder as LeaseHolder, takeover);
        return json({ ok: true, lease });
      }
      case "lease-release": {
        const lease = body.lease as { holder?: unknown; token?: unknown } | undefined;
        if ((lease?.holder !== "agent" && lease?.holder !== "user") || typeof lease?.token !== "string") {
          throw new AuthorizationError("MALFORMED_REQUEST", "lease-release requires lease { holder, token }.", 400);
        }
        const call = await authorizeCall(ctx, req, {
          operationId: body.operationId,
          projectId,
          agentSessionId: sessionId,
          action: "terminal.lease",
          resource: sessionResource(sessionId),
          args: { holder: lease.holder },
        }, body);
        ctx.authorized.releaseLease(call, sessionId, lease.holder as LeaseHolder, lease.token as string);
        return json({ ok: true });
      }
      case "cancel": {
        if (typeof body.targetOperationId !== "string") {
          throw new AuthorizationError("MALFORMED_REQUEST", "cancel requires targetOperationId.", 400);
        }
        const call = await authorizeCall(ctx, req, {
          operationId: body.operationId,
          projectId,
          agentSessionId: sessionId,
          action: "agent.stop",
          resource: sessionResource(sessionId),
          args: { targetOperationId: body.targetOperationId },
        }, body);
        const result = ctx.authorized.cancelOp(call, sessionId, body.targetOperationId);
        return json({
          ok: true,
          cancelled: result.cancelled,
          outcome: result.outcome ? projectExecOutcome(result.outcome) : null,
        });
      }
      case "stop": {
        const call = await authorizeCall(ctx, req, {
          operationId: body.operationId,
          projectId,
          agentSessionId: sessionId,
          action: "agent.stop",
          resource: sessionResource(sessionId),
          args: { scope: "session" },
        }, body);
        const result = await ctx.authorized.stopSession(call, sessionId);
        return json({ ok: true, state: result.state, detail: result.detail });
      }
      default:
        throw new AuthorizationError("MALFORMED_REQUEST", "Unknown control op.", 400);
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
