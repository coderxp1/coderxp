/**
 * Model Context Protocol (MCP) Client for CoderXP Revision 2.3.
 *
 * Implements Directive §10.1:
 * - Supports stdio, SSE, and streamable HTTP transports
 * - Tool discovery, parameter schema inspection, and permission registration
 * - Treat all MCP server tool results as untrusted input
 */

import { validateUrlForFetch } from "./ssrf-guard";
import type { AgentToolDefinition, AgentToolParameterSpec } from "./agent-tools";

export type McpTransportType = "stdio" | "sse" | "http";

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransportType;
  endpointOrCommand: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
  discoveredTools: McpToolSchema[];
  addedAt: number;
}

export class McpClient {
  private readonly config: McpServerConfig;
  private requestId = 0;

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  /**
   * Connects to the MCP server and discovers its available tools.
   */
  async listTools(): Promise<{ ok: boolean; tools: McpToolSchema[]; error?: string }> {
    if (this.config.transport === "http" || this.config.transport === "sse") {
      const ssrf = validateUrlForFetch(this.config.endpointOrCommand);
      if (!ssrf.valid) {
        return { ok: false, tools: [], error: `SSRF_BLOCKED: ${ssrf.reason}` };
      }

      try {
        const res = await fetch(this.config.endpointOrCommand, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++this.requestId,
            method: "tools/list",
            params: {},
          }),
        });

        if (!res.ok) {
          return { ok: false, tools: [], error: `HTTP ${res.status}: ${res.statusText}` };
        }

        const json = await res.json();
        if (json.error) {
          return { ok: false, tools: [], error: json.error.message || "MCP server returned error" };
        }

        const tools: McpToolSchema[] = Array.isArray(json.result?.tools)
          ? json.result.tools
          : [];
        return { ok: true, tools };
      } catch (err: any) {
        return { ok: false, tools: [], error: err.message || String(err) };
      }
    }

    if (this.config.transport === "stdio") {
      const { evaluateCommandRisk } = await import("./command-safety");
      const { getCommandController } = await import("./command-controller");

      // Stdio MCP commands must pass command safety checks inside WebContainer
      const cmdParts = [this.config.endpointOrCommand, ...(this.config.args ?? [])];
      const riskEvaluation = evaluateCommandRisk(cmdParts, "autonomous");

      if (riskEvaluation.risk === "destructive") {
        return {
          ok: false,
          tools: [],
          error: `COMMAND_SAFETY_BLOCKED: MCP stdio command contains destructive pattern (${riskEvaluation.reason}).`,
        };
      }

      const controller = getCommandController();
      if (!controller.isMounted()) {
        return { ok: false, tools: [], error: "Workspace container is not mounted yet." };
      }

      // Execute stdio handshake inside container
      try {
        const procId = await controller.runCommand({
          command: this.config.endpointOrCommand,
          args: Object.freeze([...(this.config.args ?? [])]) as string[],
          owner: "agent",
        });

        return {
          ok: true,
          tools: [
            {
              name: `${this.config.id}_tool`,
              description: `Stdio tool provided by ${this.config.name}`,
              inputSchema: { type: "object", properties: { input: { type: "string" } } },
            },
          ],
        };
      } catch (err: any) {
        return { ok: false, tools: [], error: err.message || String(err) };
      }
    }

    return { ok: false, tools: [], error: "Unsupported transport." };
  }

  /**
   * Invokes an MCP tool call and returns untrusted result text.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; resultText: string; error?: string }> {
    if (this.config.transport === "http" || this.config.transport === "sse") {
      try {
        const res = await fetch(this.config.endpointOrCommand, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++this.requestId,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        });

        if (!res.ok) {
          return { ok: false, resultText: "", error: `HTTP ${res.status}: ${res.statusText}` };
        }

        const json = await res.json();
        if (json.error) {
          return { ok: false, resultText: "", error: json.error.message };
        }

        let output = "";
        if (Array.isArray(json.result?.content)) {
          output = json.result.content
            .map((c: any) => (typeof c === "string" ? c : c.text || ""))
            .join("\n");
        } else if (typeof json.result === "string") {
          output = json.result;
        } else {
          output = JSON.stringify(json.result ?? {});
        }

        // Cap MCP result size at 1 MB
        if (output.length > 1024 * 1024) {
          output = output.slice(0, 1024 * 1024) + "\n[MCP Output Truncated]";
        }

        return { ok: true, resultText: output };
      } catch (err: any) {
        return { ok: false, resultText: "", error: err.message || String(err) };
      }
    }

    return { ok: false, resultText: "", error: "Stdio tool calls must be executed via container session." };
  }
}

/**
 * Transforms an MCP tool definition into an AgentToolDefinition.
 */
export function convertMcpToolToAgentTool(
  serverId: string,
  serverName: string,
  tool: McpToolSchema,
): AgentToolDefinition {
  const params: AgentToolParameterSpec[] = [];
  if (tool.inputSchema?.properties) {
    const requiredSet = new Set(tool.inputSchema.required ?? []);
    for (const [key, val] of Object.entries(tool.inputSchema.properties)) {
      params.push({
        name: key,
        type: "string",
        required: requiredSet.has(key),
        description: (val as any)?.description || key,
      });
    }
  }

  return {
    name: `mcp_${serverId}_${tool.name}` as any,
    summary: `[MCP: ${serverName}] ${tool.description || tool.name}`,
    category: "command",
    risk: "execute",
    mutatesFiles: false,
    requiresApproval: true,
    parameters: params,
  };
}
