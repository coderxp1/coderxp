"use client";

/**
 * MCP Server Management Modal for CoderXP Revision 2.3.
 *
 * Implements Directive §10.1:
 * - Add MCP servers via HTTP, SSE, or Stdio transports
 * - Tool discovery & schema preview before enabling
 * - All tool calls treated as untrusted and routed through permission engine
 */

import React, { useState, useEffect } from "react";
import {
  McpClient,
  type McpServerConfig,
  type McpToolSchema,
  type McpTransportType,
} from "@/lib/workspace/mcp-client";

export interface McpServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onServersUpdated: () => void;
}

export function McpServerModal({
  isOpen,
  onClose,
  onServersUpdated,
}: McpServerModalProps) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransportType>("http");
  const [endpoint, setEndpoint] = useState("");
  const [discoveredTools, setDiscoveredTools] = useState<McpToolSchema[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load configured MCP servers
  useEffect(() => {
    if (!isOpen) return;
    try {
      const raw = localStorage.getItem("coderxp_mcp_servers");
      if (raw) {
        setServers(JSON.parse(raw));
      }
    } catch {
      setServers([]);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  async function handleDiscover() {
    if (!name.trim() || !endpoint.trim()) {
      setError("Please provide a server name and endpoint/command.");
      return;
    }

    setDiscovering(true);
    setError(null);

    const tempConfig: McpServerConfig = {
      id: name.toLowerCase().replace(/[^a-z0-9]/g, "_"),
      name: name.trim(),
      transport,
      endpointOrCommand: endpoint.trim(),
      enabled: true,
      discoveredTools: [],
      addedAt: Date.now(),
    };

    const client = new McpClient(tempConfig);
    const res = await client.listTools();

    setDiscovering(false);
    if (!res.ok) {
      setError(res.error || "Failed to discover tools.");
      return;
    }

    setDiscoveredTools(res.tools);
  }

  function handleSaveServer() {
    if (!name.trim() || !endpoint.trim()) return;

    const newServer: McpServerConfig = {
      id: `mcp_${Date.now()}_${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`,
      name: name.trim(),
      transport,
      endpointOrCommand: endpoint.trim(),
      enabled: true,
      discoveredTools,
      addedAt: Date.now(),
    };

    const updated = [...servers.filter((s) => s.name !== name.trim()), newServer];
    setServers(updated);
    localStorage.setItem("coderxp_mcp_servers", JSON.stringify(updated));

    // Reset form
    setName("");
    setEndpoint("");
    setDiscoveredTools([]);
    setError(null);
    onServersUpdated();
  }

  function handleDeleteServer(id: string) {
    const updated = servers.filter((s) => s.id !== id);
    setServers(updated);
    localStorage.setItem("coderxp_mcp_servers", JSON.stringify(updated));
    onServersUpdated();
  }

  function handleToggleServer(id: string) {
    const updated = servers.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s));
    setServers(updated);
    localStorage.setItem("coderxp_mcp_servers", JSON.stringify(updated));
    onServersUpdated();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mcpModalTitle"
    >
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-2xl w-full max-w-[560px] overflow-hidden flex flex-col font-sans text-[var(--text)] animate-in fade-in zoom-in-95 duration-150 max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-soft)] bg-[var(--bg-side)]">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="2" width="20" height="8" rx="2" />
              <rect x="2" y="14" width="20" height="8" rx="2" />
              <line x1="6" y1="6" x2="6.01" y2="6" />
              <line x1="6" y1="18" x2="6.01" y2="18" />
            </svg>
            <h2 id="mcpModalTitle" className="text-sm font-semibold">
              Model Context Protocol (MCP) Servers
            </h2>
          </div>
          <button
            type="button"
            className="text-[var(--text-faint)] hover:text-[var(--text)] p-1 rounded hover:bg-[var(--bg-input)] cursor-pointer"
            aria-label="Close"
            onClick={onClose}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-4 flex flex-col gap-4 text-xs overflow-y-auto">
          {/* Active Servers List */}
          {servers.length > 0 && (
            <div>
              <label className="block text-[var(--text-dim)] mb-1 font-medium">Configured Servers</label>
              <div className="flex flex-col gap-2">
                {servers.map((s) => (
                  <div
                    key={s.id}
                    className="p-2.5 rounded bg-[var(--bg-input)] border border-[var(--border-soft)] flex items-center justify-between"
                  >
                    <div>
                      <div className="font-medium text-[var(--text)] flex items-center gap-2">
                        <span>{s.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-side)] text-[var(--text-dim)] uppercase font-mono">
                          {s.transport}
                        </span>
                      </div>
                      <div className="text-[11px] text-[var(--text-faint)] font-mono mt-0.5">
                        {s.endpointOrCommand} · {s.discoveredTools.length} tools
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className={`text-xs px-2 py-1 rounded cursor-pointer ${
                          s.enabled ? "text-[var(--ok)] bg-emerald-950/30" : "text-[var(--text-faint)] bg-[var(--bg-side)]"
                        }`}
                        onClick={() => handleToggleServer(s.id)}
                      >
                        {s.enabled ? "Active" : "Disabled"}
                      </button>
                      <button
                        type="button"
                        className="text-[var(--text-faint)] hover:text-[var(--err)] p-1 cursor-pointer"
                        title="Delete server"
                        onClick={() => handleDeleteServer(s.id)}
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Add New Server Form */}
          <div className="border-t border-[var(--border-soft)] pt-3 flex flex-col gap-3">
            <h3 className="font-medium text-[var(--text)]">Add New MCP Server</h3>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[var(--text-dim)] mb-1">Server Name</label>
                <input
                  type="text"
                  className="w-full bg-[var(--bg-input)] border border-[var(--border)] rounded px-3 py-1.5 text-xs text-[var(--text)] focus:border-[var(--accent)] outline-none"
                  placeholder="e.g. Postgres Inspector"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-[var(--text-dim)] mb-1">Transport</label>
                <select
                  className="w-full bg-[var(--bg-input)] border border-[var(--border)] rounded px-3 py-1.5 text-xs text-[var(--text)] focus:border-[var(--accent)] outline-none"
                  value={transport}
                  onChange={(e) => setTransport(e.target.value as McpTransportType)}
                >
                  <option value="http">Streamable HTTP (POST)</option>
                  <option value="sse">Server-Sent Events (SSE)</option>
                  <option value="stdio">Stdio Process (Container)</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-[var(--text-dim)] mb-1">
                {transport === "stdio" ? "Command & Arguments" : "Server Endpoint URL"}
              </label>
              <input
                type="text"
                className="w-full bg-[var(--bg-input)] border border-[var(--border)] rounded px-3 py-1.5 text-xs font-mono text-[var(--text)] focus:border-[var(--accent)] outline-none"
                placeholder={transport === "stdio" ? "npx -y @modelcontextprotocol/server-postgres" : "http://localhost:8000/mcp"}
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                disabled={discovering || !name.trim() || !endpoint.trim()}
                className="px-3 py-1.5 text-xs rounded bg-[var(--bg-input)] border border-[var(--border)] hover:border-[var(--accent)] text-[var(--text)] cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                onClick={handleDiscover}
              >
                {discovering && (
                  <div className="w-3 h-3 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                )}
                <span>Discover Tools</span>
              </button>
            </div>

            {/* Discovered Tools List */}
            {discoveredTools.length > 0 && (
              <div className="mt-2 p-3 rounded bg-[var(--bg-input)] border border-[var(--border)] flex flex-col gap-2">
                <div className="font-medium text-[var(--ok)] text-[11px]">
                  Discovered {discoveredTools.length} tool(s):
                </div>
                <div className="flex flex-col gap-1.5 max-h-[140px] overflow-y-auto">
                  {discoveredTools.map((t) => (
                    <div key={t.name} className="p-1.5 rounded bg-[var(--bg-side)] border border-[var(--border-soft)]">
                      <div className="font-mono font-medium text-[var(--text)] text-[11px]">{t.name}</div>
                      {t.description && (
                        <div className="text-[10px] text-[var(--text-dim)]">{t.description}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <div className="p-2 rounded bg-red-950/30 border border-red-800/50 text-[var(--err)] text-[11px]">
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--border-soft)] bg-[var(--bg-side)]">
          <button
            type="button"
            className="px-3 py-1.5 text-xs rounded border border-[var(--border)] hover:bg-[var(--bg-input)] cursor-pointer text-[var(--text-dim)] hover:text-[var(--text)]"
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            disabled={!name.trim() || !endpoint.trim()}
            className="px-3 py-1.5 text-xs rounded bg-[var(--accent)] text-white hover:opacity-90 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleSaveServer}
          >
            Save & Enable Server
          </button>
        </div>
      </div>
    </div>
  );
}
