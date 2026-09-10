/**
 * Production Devbox PTY Broker Daemon for CoderXP Revision 2.4.
 *
 * Backed by high-performance WebSocketServer (ws) and real Docker Devbox containers.
 * Binds strictly to 127.0.0.1:3200. Proxied over TLS via Nginx /ws/devbox/.
 *
 * Full Duplex Integrity & Real Container Attachment:
 * - Authoritative server-side handshake ack (`type: "handshake_ack"`).
 * - Real Docker container attachment via interactive `/bin/bash -l` process.
 * - 15-second server-side ping/pong heartbeat keepalive loop.
 * - Bidirectional streaming stdin/stdout with streaming secret redaction.
 * - Fail-closed: true Docker errors surfaced directly to the terminal, zero synthetic output.
 */

import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { verifyDevboxWssToken } from "../lib/server/devbox-token";
import { devboxBroker, ensureDockerDevbox } from "../lib/server/devbox-broker";
import { StreamingRedactor } from "../lib/workspace/agent-process-stream";

const PORT = 3200;
const HOST = "127.0.0.1";

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "devbox-pty-broker",
        host: HOST,
        port: PORT,
        uptime: process.uptime(),
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url || "", `http://${HOST}:${PORT}`);
    const token = url.searchParams.get("token") || "";
    const projectId = url.searchParams.get("projectId") || "";

    // 1. Authenticate Handshake with Single-Use HMAC Token
    const authResult = verifyDevboxWssToken(token, projectId);
    if (!authResult.valid) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // 2. Perform WebSocket Upgrade Handshake
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, projectId);
    });
  } catch {
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    socket.destroy();
  }
});

const DOCKER_CONTROL_SOCKET = process.env.CODERXP_DOCKER_CONTROL_SOCKET ?? "/run/coderxp/docker-control.sock";

async function queryDockerControlEnsure(projectId: string): Promise<{ ok: boolean; running: boolean; ip: string; error?: string } | null> {
  try {
    const fs = await import("node:fs");
    if (!fs.existsSync(DOCKER_CONTROL_SOCKET)) return null;

    return await new Promise<{ ok: boolean; running: boolean; ip: string; error?: string } | null>((resolve) => {
      const req = http.request(
        {
          socketPath: DOCKER_CONTROL_SOCKET,
          path: "/ensure",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          timeout: 15000,
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on("error", () => resolve(null));
      req.write(JSON.stringify({ projectId }));
      req.end();
    });
  } catch {
    return null;
  }
}

// Optional node-pty loading with graceful fallback
let ptyModule: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ptyModule = require("node-pty");
} catch {
  // node-pty fallback for environments without C++ build tools
}

wss.on("connection", async (ws: WebSocket, _req: http.IncomingMessage, projectId: string) => {
  const redactor = new StreamingRedactor();
  const containerName = `coderxp-devbox-${projectId}`;
  const volumeName = `coderxp-vol-${projectId}`;

  // 1. Ensure devbox container is created and running on the host
  await devboxBroker.getOrCreateDevbox(projectId, "coderxpadmin");

  const controlEnsure = await queryDockerControlEnsure(projectId);
  if (controlEnsure) {
    if (!controlEnsure.ok) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: `Could not attach to devbox container: ${controlEnsure.error}`,
        }),
      );
      ws.close(1011, "Container attachment failed");
      return;
    }
  } else {
    // Local / direct fallback for tests
    const dockerCheck = await ensureDockerDevbox(containerName, volumeName);
    if (!dockerCheck.ok) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: `Could not attach to devbox container: ${dockerCheck.error}`,
        }),
      );
      ws.close(1011, "Container attachment failed");
      return;
    }
  }

  // 2. Spawn real interactive shell inside the Docker Devbox container
  let ptyProcess: any = null;
  let childProcess: ChildProcess | null = null;
  let controlWs: WebSocket | null = null;

  try {
    const fs = await import("node:fs");
    if (fs.existsSync(DOCKER_CONTROL_SOCKET)) {
      controlWs = new WebSocket(
        `ws://localhost/pty?projectId=${encodeURIComponent(projectId)}&cols=120&rows=30`,
        { socketPath: DOCKER_CONTROL_SOCKET } as any,
      );

      controlWs.on("message", (rawMsg) => {
        try {
          const parsed = JSON.parse(rawMsg.toString());
          if (parsed.type === "output" && typeof parsed.data === "string") {
            const sanitized = redactor.processChunk(parsed.data);
            if (ws.readyState === WebSocket.OPEN && sanitized) {
              ws.send(JSON.stringify({ type: "output", data: sanitized }));
            }
          } else if (parsed.type === "exit") {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "output",
                  data: `\r\n[Devbox session disconnected (exit code ${parsed.exitCode})]\r\n`,
                }),
              );
            }
          }
        } catch {
          const sanitized = redactor.processChunk(rawMsg.toString());
          if (ws.readyState === WebSocket.OPEN && sanitized) {
            ws.send(JSON.stringify({ type: "output", data: sanitized }));
          }
        }
      });

      controlWs.on("close", () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      });
    } else if (ptyModule) {
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
          cols: 120,
          rows: 30,
          cwd: process.cwd(),
          env: {
            ...process.env,
            TERM: "xterm-256color",
          },
        },
      );

      ptyProcess.onData((data: string) => {
        const sanitized = redactor.processChunk(data);
        if (ws.readyState === WebSocket.OPEN && sanitized) {
          ws.send(JSON.stringify({ type: "output", data: sanitized }));
        }
      });

      ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "output",
              data: `\r\n[Devbox session disconnected (exit code ${exitCode})]\r\n`,
            }),
          );
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
          cwd: process.cwd(),
          env: {
            ...process.env,
            TERM: "xterm-256color",
          },
        },
      );

      childProcess.stdout?.on("data", (chunk: Buffer) => {
        const raw = chunk.toString("utf8");
        const sanitized = redactor.processChunk(raw);
        if (ws.readyState === WebSocket.OPEN && sanitized) {
          ws.send(JSON.stringify({ type: "output", data: sanitized }));
        }
      });

      childProcess.stderr?.on("data", (chunk: Buffer) => {
        const raw = chunk.toString("utf8");
        const sanitized = redactor.processChunk(raw);
        if (ws.readyState === WebSocket.OPEN && sanitized) {
          ws.send(JSON.stringify({ type: "output", data: sanitized }));
        }
      });

      childProcess.on("close", (code) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "output",
              data: `\r\n[Devbox session disconnected (exit code ${code})]\r\n`,
            }),
          );
        }
      });
    }
  } catch (err: any) {
    ws.send(
      JSON.stringify({
        type: "error",
        error: `Failed to spawn shell process in devbox: ${err.message}`,
      }),
    );
    ws.close(1011, "Shell spawn failed");
    return;
  }

  // 3. Send Authoritative Handshake Ack
  const ackPayload = JSON.stringify({
    type: "handshake_ack",
    sessionId: projectId,
    ptyReady: true,
    timestamp: Date.now(),
  });
  ws.send(ackPayload);

  // 4. Stdin Writer Helper
  const writeToStdin = (content: string) => {
    if (controlWs && controlWs.readyState === WebSocket.OPEN) {
      controlWs.send(JSON.stringify({ type: "stdin", data: content }));
    } else if (ptyProcess && typeof ptyProcess.write === "function") {
      ptyProcess.write(content);
    } else if (childProcess?.stdin && !childProcess.stdin.destroyed) {
      childProcess.stdin.write(content);
    }
  };

  // 5. 15-Second Server-Side Heartbeat Keepalive Loop
  let isAlive = true;
  ws.on("pong", () => {
    isAlive = true;
  });

  const pingInterval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(pingInterval);
      return;
    }
    if (!isAlive) {
      clearInterval(pingInterval);
      ws.terminate();
      return;
    }
    isAlive = false;
    ws.ping();
  }, 15000);

  // 6. Handle Incoming Stdin / Commands from xterm.js or Agent
  ws.on("message", (data) => {
    const str = data.toString();
    try {
      if (str.startsWith("{") && str.endsWith("}")) {
        const parsed = JSON.parse(str);
        if (parsed.type === "command") {
          const cmd = `${parsed.command} ${(parsed.args || []).join(" ")}\n`;
          writeToStdin(cmd);
          return;
        }
        if (parsed.type === "stdin" && typeof parsed.data === "string") {
          writeToStdin(parsed.data);
          return;
        }
        if (parsed.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
          return;
        }
        if (parsed.type === "resize") {
          const cols = typeof parsed.cols === "number" ? Math.max(1, parsed.cols) : 120;
          const rows = typeof parsed.rows === "number" ? Math.max(1, parsed.rows) : 30;
          if (controlWs && controlWs.readyState === WebSocket.OPEN) {
            controlWs.send(JSON.stringify({ type: "resize", cols, rows }));
          } else if (ptyProcess && typeof ptyProcess.resize === "function") {
            try {
              ptyProcess.resize(cols, rows);
            } catch {
              // ignore
            }
          }
          return;
        }
      }
      // Raw terminal keystroke data from xterm.js onData
      writeToStdin(str);
    } catch {
      writeToStdin(str);
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    if (controlWs) {
      try {
        controlWs.close();
      } catch {
        /* ignore */
      }
    }
    if (ptyProcess) {
      try {
        ptyProcess.kill();
      } catch {
        /* ignore */
      }
    }
    if (childProcess) {
      try {
        childProcess.kill();
      } catch {
        /* ignore */
      }
    }
  });

  ws.on("error", () => {
    clearInterval(pingInterval);
    if (controlWs) {
      try {
        controlWs.close();
      } catch {
        /* ignore */
      }
    }
    if (ptyProcess) {
      try {
        ptyProcess.kill();
      } catch {
        /* ignore */
      }
    }
    if (childProcess) {
      try {
        childProcess.kill();
      } catch {
        /* ignore */
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[DevboxBroker] Listening exclusively on http://${HOST}:${PORT}`);
});
