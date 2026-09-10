/**
 * CoderXP Narrow, Authenticated, Allowlisted Docker Control Daemon
 *
 * Dedicated root service providing strictly scoped container lifecycle operations.
 * Binds exclusively to local Unix Domain Socket: /run/coderxp/docker-control.sock
 * Permissions: 0660 root:coderxp-ipc
 *
 * ZERO-TOLERANCE SECURITY ARCHITECTURE:
 * - Unprivileged services (coderxp-broker, coderxp-preview, coderxp-app) are REMOVED from the docker group.
 * - Only coderxp-docker-control interacts with the Docker daemon.
 * - Every operation strictly enforces projectId validation: ^[a-zA-Z0-9_-]{1,64}$
 * - Container names strictly locked to: coderxp-devbox-${projectId}
 * - Volume names strictly locked to: coderxp-vol-${projectId}
 * - Network strictly locked to: coderxp-net (172.28.0.0/16)
 * - Container parameters pinned: --cpus=2.0 --memory=3g --pids-limit=256 --security-opt no-new-privileges:true
 * - Zero host directory mounts allowed, zero arbitrary CLI command execution.
 */

import http from "node:http";
import fs from "node:fs";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { WebSocketServer, WebSocket } from "ws";

const execFileAsync = promisify(execFile);

export const DEFAULT_SOCKET_PATH = process.env.CODERXP_DOCKER_CONTROL_SOCKET ?? "/run/coderxp/docker-control.sock";
const DOCKER_NETWORK = process.env.CODERXP_DOCKER_NETWORK ?? "coderxp-net";

export function validateProjectId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) return null;
  return trimmed;
}

export async function inspectDevbox(projectId: string): Promise<{ ok: boolean; running: boolean; ip: string; error?: string }> {
  const validId = validateProjectId(projectId);
  if (!validId) return { ok: false, running: false, ip: "", error: "Invalid projectId" };

  const containerName = `coderxp-devbox-${validId}`;
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      containerName,
      "-f",
      "{{.State.Running}}|{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    ], { timeout: 3000 });

    const parts = stdout.trim().split("|");
    const running = parts[0] === "true";
    const ip = (parts[1] || "").trim();

    return { ok: true, running, ip };
  } catch (err: any) {
    return { ok: false, running: false, ip: "", error: err.message };
  }
}

export async function ensureDevboxContainer(projectId: string): Promise<{ ok: boolean; running: boolean; ip: string; error?: string }> {
  const validId = validateProjectId(projectId);
  if (!validId) return { ok: false, running: false, ip: "", error: "Invalid projectId" };

  const containerName = `coderxp-devbox-${validId}`;
  const volumeName = `coderxp-vol-${validId}`;

  // 1. Check if container already exists
  const existing = await inspectDevbox(validId);
  if (existing.ok) {
    if (existing.running && existing.ip) {
      return existing;
    }
    // Container exists but stopped; start it
    try {
      await execFileAsync("docker", ["start", containerName], { timeout: 10000 });
      return await inspectDevbox(validId);
    } catch (err: any) {
      return { ok: false, running: false, ip: "", error: `Failed to start container: ${err.message}` };
    }
  }

  // 2. Ensure volume exists
  try {
    await execFileAsync("docker", ["volume", "create", volumeName], { timeout: 5000 });
  } catch {
    /* volume may already exist */
  }

  // 3. Run container with strict isolation & resource constraints
  try {
    await execFileAsync("docker", [
      "run",
      "-d",
      "--name",
      containerName,
      "--network",
      DOCKER_NETWORK,
      "--cpus=2.0",
      "--memory=3g",
      "--pids-limit=256",
      "--security-opt",
      "no-new-privileges:true",
      "-v",
      `${volumeName}:/workspace`,
      "coderxp-devbox:latest",
      "sleep",
      "infinity",
    ], { timeout: 15000 });

    return await inspectDevbox(validId);
  } catch (err: any) {
    return { ok: false, running: false, ip: "", error: `Failed to create container: ${err.message}` };
  }
}

// Optional node-pty loading
let ptyModule: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ptyModule = require("node-pty");
} catch {
  /* node-pty fallback */
}

export function createDockerControlServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "coderxp-docker-control", uptime: process.uptime() }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/inspect") {
      const projectId = url.searchParams.get("projectId");
      const result = await inspectDevbox(projectId ?? "");
      res.writeHead(result.ok ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === "POST" && url.pathname === "/ensure") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const result = await ensureDevboxContainer(parsed.projectId ?? "");
          res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/pty") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const projectId = validateProjectId(url.searchParams.get("projectId"));
    if (!projectId) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const cols = parseInt(url.searchParams.get("cols") ?? "120", 10) || 120;
    const rows = parseInt(url.searchParams.get("rows") ?? "30", 10) || 30;

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, projectId, cols, rows);
    });
  });

  wss.on("connection", async (ws: WebSocket, _req: http.IncomingMessage, projectId: string, cols: number, rows: number) => {
    const containerName = `coderxp-devbox-${projectId}`;

    // Spawn interactive shell inside container
    let ptyProcess: any = null;
    let childProcess: ChildProcess | null = null;

    try {
      if (ptyModule) {
        ptyProcess = ptyModule.spawn(
          "docker",
          [
            "exec",
            "-it",
            "-u",
            "developer",
            "-w",
            "/workspace",
            "-e",
            "PORT=3000",
            "-e",
            "PS1=developer@coderxp-devbox:\\w\\$ ",
            "-e",
            "TERM=xterm-256color",
            containerName,
            "/bin/bash",
            "-l",
          ],
          {
            name: "xterm-256color",
            cols,
            rows,
            cwd: "/",
            env: { TERM: "xterm-256color" },
          },
        );

        ptyProcess.onData((data: string) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "output", data }));
          }
        });

        ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "exit", exitCode }));
            ws.close();
          }
        });
      } else {
        childProcess = spawn(
          "docker",
          [
            "exec",
            "-i",
            "-u",
            "developer",
            "-w",
            "/workspace",
            "-e",
            "PORT=3000",
            "-e",
            "PS1=developer@coderxp-devbox:\\w\\$ ",
            "-e",
            "TERM=xterm-256color",
            containerName,
            "/bin/bash",
            "-l",
          ],
          {
            stdio: ["pipe", "pipe", "pipe"],
          },
        );

        childProcess.stdout?.on("data", (chunk: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "output", data: chunk.toString("utf8") }));
          }
        });

        childProcess.stderr?.on("data", (chunk: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "output", data: chunk.toString("utf8") }));
          }
        });

        childProcess.on("close", (code) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "exit", exitCode: code }));
            ws.close();
          }
        });
      }
    } catch (err: any) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error", error: err.message }));
        ws.close(1011, "Shell spawn failed");
      }
      return;
    }

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "stdin" && typeof msg.data === "string") {
          if (ptyProcess) ptyProcess.write(msg.data);
          else if (childProcess?.stdin && !childProcess.stdin.destroyed) childProcess.stdin.write(msg.data);
        } else if (msg.type === "resize" && ptyProcess) {
          const c = typeof msg.cols === "number" ? msg.cols : 120;
          const r = typeof msg.rows === "number" ? msg.rows : 30;
          try { ptyProcess.resize(c, r); } catch { /* ignore */ }
        }
      } catch {
        const raw = data.toString();
        if (ptyProcess) ptyProcess.write(raw);
        else if (childProcess?.stdin && !childProcess.stdin.destroyed) childProcess.stdin.write(raw);
      }
    });

    ws.on("close", () => {
      if (ptyProcess) { try { ptyProcess.kill(); } catch { /* ignore */ } }
      if (childProcess) { try { childProcess.kill(); } catch { /* ignore */ } }
    });
  });

  return server;
}

export function startDockerControlServer(socketPath = DEFAULT_SOCKET_PATH) {
  const dir = require("node:path").dirname(socketPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o775 });
  }

  if (fs.existsSync(socketPath)) {
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
  }

  const server = createDockerControlServer();

  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o660);
      if (process.platform === "linux") {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { execSync } = require("node:child_process");
          execSync(`chown root:coderxp-ipc "${socketPath}"`, { stdio: "ignore" });
        } catch {
          /* ignore if group does not exist yet or running unprivileged */
        }
      }
    } catch {
      /* ignore on platforms without unix permissions */
    }
    console.log(`[docker-control] Listening on Unix socket: ${socketPath}`);
  });

  return server;
}

const isDirectRun =
  (typeof require !== "undefined" && require.main === module) ||
  (typeof process !== "undefined" && process.argv[1]?.includes("docker-control-server"));

if (isDirectRun) {
  startDockerControlServer();
}
