"use client";

/**
 * Live Interactive Devbox Terminal Panel for CoderXP Revision 2.4.
 *
 * Full Duplex Integrity & Liveness (Binding Conditions 2a-2c):
 * - Authoritative server-side handshake ack before rendering Connected banner.
 * - 15-second heartbeat with 30s watchdog detecting silent drops and triggering automatic reconnection.
 * - Non-silent input guard: warns visibly if keystrokes occur during disconnects.
 * - Real terminal prompt (`developer@coderxp-devbox:/workspace$`) and interactive stdin dispatch.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface DevboxTerminalPanelProps {
  projectId: string;
  active: boolean;
}

type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

export function DevboxTerminalPanel({ projectId }: DevboxTerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const livenessTimerRef = useRef<NodeJS.Timeout | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const [connState, setConnState] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);

  const connectDevbox = useCallback(async (isReconnect = false) => {
    if (isReconnect) {
      setConnState("reconnecting");
    } else {
      setConnState("connecting");
    }
    setError(null);

    try {
      // 1. Request single-use Devbox WSS Token
      const res = await fetch("/api/devbox/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || `Token generation failed (${res.status})`);
      }

      const data = await res.json();
      const token = data.token;

      // 2. Build WebSocket URL
      const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
      const host = window.location.host;
      const wsUrl = isHttps
        ? `wss://${host}/ws/devbox/?token=${encodeURIComponent(token)}&projectId=${encodeURIComponent(projectId)}`
        : `ws://${window.location.hostname}:3200/?token=${encodeURIComponent(token)}&projectId=${encodeURIComponent(projectId)}`;

      if (wsRef.current) {
        wsRef.current.close();
      }

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        lastActivityRef.current = Date.now();
      };

      ws.onmessage = (event) => {
        lastActivityRef.current = Date.now();
        const term = termRef.current;
        if (!term) return;

        try {
          const parsed = JSON.parse(event.data);

          // Authoritative Handshake Ack (Condition 2a)
          if (parsed.type === "handshake_ack") {
            setConnState("connected");
            // Clean terminal: no banner text. Only bash prompt is rendered.
            // Send initial dimensions to PTY
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
            return;
          }

          if (parsed.type === "output" && typeof parsed.data === "string") {
            term.write(parsed.data);
          } else if (parsed.type === "error" && typeof parsed.error === "string") {
            term.writeln(`\r\n\x1b[1;31m[Devbox Error: ${parsed.error}]\x1b[0m\r\n`);
          } else if (parsed.type === "pong") {
            // Heartbeat acknowledged
          } else if (typeof parsed === "string") {
            term.write(parsed);
          }
        } catch {
          term.write(event.data);
        }
      };

      ws.onerror = () => {
        setConnState("disconnected");
        setError("WebSocket connection failed.");
      };

      ws.onclose = () => {
        setConnState("disconnected");
      };
    } catch (err: any) {
      setConnState("disconnected");
      setError(err?.message || "Failed to initialize Devbox terminal.");
    }
  }, [projectId]);

  // Setup Liveness Watchdog (Condition 2a)
  useEffect(() => {
    livenessTimerRef.current = setInterval(() => {
      const now = Date.now();
      const ws = wsRef.current;

      // If connected, send client ping
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "ping", timestamp: now }));
        } catch {
          // ignore
        }
      }

      // If no activity for 30s (2 heartbeat intervals) and was connected, auto-reconnect
      if (connState === "connected" && now - lastActivityRef.current > 30000) {
        connectDevbox(true);
      }
    }, 15000);

    return () => {
      if (livenessTimerRef.current) {
        clearInterval(livenessTimerRef.current);
      }
    };
  }, [connState, connectDevbox]);

  useEffect(() => {
    let isDisposed = false;
    const container = containerRef.current;
    if (!container) return;

    const initTerminal = async () => {
      // Explicitly preload Cascadia Mono font before term.open()
      if (typeof document !== "undefined" && document.fonts) {
        try {
          await Promise.all([
            document.fonts.load('400 14px "Cascadia Mono"'),
            document.fonts.load('700 14px "Cascadia Mono"'),
          ]);
        } catch (fontErr) {
          console.warn("Cascadia Mono preloading failed, falling back to monospace:", fontErr);
        }
      }

      if (isDisposed || !containerRef.current) return;

      const term = new Terminal({
        cols: 120,
        rows: 24,
        cursorBlink: true,
        fontSize: 14,
        lineHeight: 1.2,
        fontWeight: "400" as any,
        fontWeightBold: "700" as any,
        fontFamily: '"Cascadia Mono", monospace',
        theme: {
          background: "#0a0b0d",
          foreground: "#d4d4d4",
          cursor: "#38bdf8",
          selectionBackground: "#264f78",
          black: "#0a0b0d",
          red: "#ef4444",
          green: "#22c55e",
          yellow: "#eab308",
          blue: "#38bdf8",
          magenta: "#a855f7",
          cyan: "#06b6d4",
          white: "#e5e7eb",
        },
        allowProposedApi: true,
        scrollback: 5000,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());

      term.open(containerRef.current);
      fitAddon.fit();

      termRef.current = term;
      fitRef.current = fitAddon;

      // Real PTY onData stream: forward all raw bytes/keystrokes to Docker bash
      term.onData((data) => {
        const ws = wsRef.current;
        const isConnected = ws && ws.readyState === WebSocket.OPEN;

        if (!isConnected) {
          connectDevbox(true);
          return;
        }

        ws.send(data);
      });

      // Wire terminal resize events to PTY broker
      term.onResize(({ cols, rows }) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: "resize", cols, rows }));
          } catch {
            // ignore
          }
        }
      });

      // Connect devbox session
      connectDevbox();

      // ResizeObserver on the host container: fit and propagate resize to PTY
      const observer = new ResizeObserver(() => {
        try {
          if (!containerRef.current) return;
          fitAddon.fit();
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          }
        } catch {
          // ignore
        }
      });

      observer.observe(containerRef.current);
      resizeObserverRef.current = observer;
    };

    void initTerminal();

    return () => {
      isDisposed = true;
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (termRef.current) {
        termRef.current.dispose();
      }
    };
  }, [projectId, connectDevbox]);

  return (
    <div className="relative w-full h-full flex flex-col bg-[#0a0b0d] overflow-hidden">
      {/* Fixed-height Header (28px) */}
      <div className="h-7 shrink-0 flex items-center justify-between px-3 bg-[#111214] border-b border-[#27272a] text-[11px] font-mono text-[#a1a1aa] select-none">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              connState === "connected"
                ? "bg-emerald-500"
                : connState === "reconnecting"
                ? "bg-amber-500 animate-pulse"
                : "bg-rose-500"
            }`}
          />
          <span>
            {connState === "connected"
              ? "Devbox PTY · Ubuntu 24.04 (Live)"
              : connState === "reconnecting"
              ? "Reconnecting to PTY Broker…"
              : "Devbox Disconnected"}
          </span>
        </div>
        {connState === "disconnected" && (
          <button
            type="button"
            className="px-2 py-0.5 bg-[#27272a] hover:bg-[#3f3f46] text-white rounded text-[10px] cursor-pointer"
            onClick={() => connectDevbox(true)}
          >
            Retry Connection
          </button>
        )}
      </div>

      {/* Terminal Host Container */}
      <div
        ref={containerRef}
        className="flex-1 w-full min-h-0 overflow-hidden relative"
        style={{ padding: "4px 6px" }}
      />
    </div>
  );
}
