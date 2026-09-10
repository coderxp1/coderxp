#!/usr/bin/env tsx
/**
 * CoderXP Preview Router (port 3400)
 *
 * Receives requests from Nginx for *.preview.coderxp.pro.
 * Strictly resolves preview slug -> dedicated container IP & active port.
 *
 * ZERO-TOLERANCE ISOLATION POLICY:
 * - NEVER falls back to 127.0.0.1 or host network under any circumstances.
 * - Rejects loopback (127.0.0.0/8), 0.0.0.0, link-local (169.254.0.0/16), IPv6 loopback (::1).
 * - Fails closed with HTTP 502 if container is missing, stopped, or IP cannot be resolved.
 * - Preserves upstream application cookies (does NOT hide Set-Cookie).
 */

import http from "node:http";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROUTER_PORT = parseInt(process.env.PREVIEW_ROUTER_PORT ?? "3400", 10);
const PREVIEW_API_BASE = process.env.PREVIEW_API_BASE ?? "http://127.0.0.1:3100";

interface SlugResult {
  ok: boolean;
  slug?: string;
  projectId?: string;
  containerPort?: number;
  error?: string;
}

const containerIpCache = new Map<string, { ip: string; expires: number }>();

export function isValidContainerIp(ip: string): boolean {
  if (!ip || typeof ip !== "string") return false;
  const trimmed = ip.trim();

  // Explicitly reject all host, loopback, link-local, and unspecified addresses
  if (
    trimmed.startsWith("127.") ||
    trimmed === "0.0.0.0" ||
    trimmed === "::1" ||
    trimmed.startsWith("169.254.") ||
    trimmed.startsWith("fe80:") ||
    trimmed === "localhost"
  ) {
    return false;
  }

  // Must match valid IPv4 format
  const match = trimmed.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;

  const octets = match.slice(1, 5).map(Number);
  if (octets.some((o) => o < 0 || o > 255)) return false;

  return true;
}

const DOCKER_CONTROL_SOCKET = process.env.CODERXP_DOCKER_CONTROL_SOCKET ?? "/run/coderxp/docker-control.sock";

async function queryDockerControlInspect(projectId: string): Promise<{ running: boolean; ip: string } | null> {
  try {
    // Check if unix socket exists
    const fs = await import("node:fs");
    if (!fs.existsSync(DOCKER_CONTROL_SOCKET)) return null;

    return await new Promise<{ running: boolean; ip: string } | null>((resolve) => {
      const req = http.request(
        {
          socketPath: DOCKER_CONTROL_SOCKET,
          path: `/inspect?projectId=${encodeURIComponent(projectId)}`,
          method: "GET",
          timeout: 3000,
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(body);
              if (parsed && parsed.ok) {
                resolve({ running: Boolean(parsed.running), ip: String(parsed.ip || "") });
              } else {
                resolve(null);
              }
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on("error", () => resolve(null));
      req.end();
    });
  } catch {
    return null;
  }
}

export async function resolveContainerDestination(
  projectId: string | undefined,
  recordedPort: number | undefined,
): Promise<
  | { ok: true; host: string; port: number }
  | { ok: false; status: 404 | 502; error: string }
> {
  if (!projectId || typeof projectId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    return { ok: false, status: 502, error: "Invalid or missing project identifier." };
  }

  if (!recordedPort || typeof recordedPort !== "number" || recordedPort < 1 || recordedPort > 65535) {
    return { ok: false, status: 502, error: "Invalid or unrecorded destination port." };
  }

  const cached = containerIpCache.get(projectId);
  if (cached && Date.now() < cached.expires && isValidContainerIp(cached.ip)) {
    return { ok: true, host: cached.ip, port: recordedPort };
  }

  const containerName = `coderxp-devbox-${projectId}`;
  try {
    let running = false;
    let ip = "";

    const controlRes = await queryDockerControlInspect(projectId);
    if (controlRes) {
      running = controlRes.running;
      ip = controlRes.ip;
    } else {
      const { stdout } = await execFileAsync("docker", [
        "inspect",
        containerName,
        "-f",
        "{{.State.Running}}|{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      ], { timeout: 3000 });

      const parts = stdout.trim().split("|");
      running = parts[0] === "true";
      ip = parts[1] || "";
    }

    if (!running) {
      return { ok: false, status: 502, error: "Devbox container is not running." };
    }

    if (!ip || !isValidContainerIp(ip)) {
      return { ok: false, status: 502, error: "Devbox container IP is missing, loopback, or invalid." };
    }

    containerIpCache.set(projectId, { ip: ip.trim(), expires: Date.now() + 10000 });
    return { ok: true, host: ip.trim(), port: recordedPort };
  } catch {
    return { ok: false, status: 502, error: `Devbox container ${containerName} not found on Docker network.` };
  }
}

async function resolveSlug(slug: string): Promise<SlugResult> {
  try {
    const res = await fetch(
      `${PREVIEW_API_BASE}/api/preview/resolve?slug=${encodeURIComponent(slug)}`,
    );
    const json = (await res.json()) as SlugResult;
    return json;
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? "resolve failed") };
  }
}

function extractSlug(req: http.IncomingMessage): string {
  const fromHeader = req.headers["x-preview-slug"];
  if (typeof fromHeader === "string" && fromHeader.length > 0) {
    return fromHeader;
  }
  const host = req.headers["host"] ?? "";
  const match = host.match(/^([^.]+)\.preview\.coderxp\.pro/);
  return match ? match[1] : "";
}

export const server = http.createServer(async (req, res) => {
  const slug = extractSlug(req);

  if (!slug) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing preview slug");
    return;
  }

  const result = await resolveSlug(slug);
  if (!result.ok) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`Preview not found or link revoked: ${result.error ?? "unknown slug"}\n`);
    return;
  }

  const dest = await resolveContainerDestination(result.projectId, result.containerPort);
  if (!dest.ok) {
    res.writeHead(dest.status, { "Content-Type": "text/plain" });
    res.end(`[CoderXP Preview Isolation Error] ${dest.error}\nRefusing to proxy to unspecified or host loopback destination.\n`);
    return;
  }

  const proxyReq = http.request(
    {
      hostname: dest.host,
      port: dest.port,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `localhost:${dest.port}`,
      },
    },
    (proxyRes) => {
      // Upstream app cookies preserved (RFC 6265bis __Host- on main app prevents collision)
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    },
  );

  proxyReq.on("error", (err: any) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(
        `[CoderXP Live Preview] Container server not reachable on ${dest.host}:${dest.port} (${err.code || err.message}).\n`,
      );
    }
  });

  req.pipe(proxyReq, { end: true });
});

// WebSocket / HMR upgrade handling
server.on("upgrade", async (req, socket, head) => {
  const slug = extractSlug(req);
  if (!slug) {
    socket.destroy();
    return;
  }

  const result = await resolveSlug(slug);
  if (!result.ok) {
    socket.destroy();
    return;
  }

  const dest = await resolveContainerDestination(result.projectId, result.containerPort);
  if (!dest.ok) {
    socket.destroy();
    return;
  }

  const upstream = net.connect(dest.port, dest.host, () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

export function startPreviewRouter(port = ROUTER_PORT, host = "127.0.0.1") {
  return server.listen(port, host, () => {
    console.log(
      `[preview-router] Listening on ${host}:${port} (PREVIEW_API_BASE=${PREVIEW_API_BASE})`,
    );
  });
}

const isDirectRun =
  (typeof require !== "undefined" && require.main === module) ||
  (typeof process !== "undefined" && process.argv[1]?.includes("preview-router-server"));

if (isDirectRun) {
  startPreviewRouter();
}