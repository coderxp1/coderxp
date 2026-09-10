import assert from "node:assert/strict";
import {
  McpClient,
  convertMcpToolToAgentTool,
  type McpServerConfig,
} from "../lib/workspace/mcp-client";

async function main() {
  console.log("=== RUNNING REVISION 2.3 MCP CLIENT TEST ===");

  // 1. Tool Conversion to Agent Tool Definition
  console.log("--- 1. MCP Tool Conversion ---");
  const converted = convertMcpToolToAgentTool("postgres_srv", "PostgreSQL", {
    name: "query_db",
    description: "Execute SQL query on the database",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "The SQL statement to run" },
      },
      required: ["sql"],
    },
  });

  assert.equal(converted.name, "mcp_postgres_srv_query_db");
  assert.equal(converted.category, "command");
  assert.equal(converted.risk, "execute");
  assert.equal(converted.mutatesFiles, false);
  assert.equal(converted.requiresApproval, true);
  assert.ok(converted.summary.includes("PostgreSQL"));
  console.log("[PASS] MCP tool conversion properly sets schema and execution risk.");

  // 2. SSRF Protection on MCP HTTP Endpoint
  console.log("--- 2. SSRF Guard on MCP HTTP Endpoint ---");
  const ssrfConfig: McpServerConfig = {
    id: "internal_bad",
    name: "Bad Internal",
    transport: "http",
    endpointOrCommand: "http://127.0.0.1:9090/mcp",
    enabled: true,
    discoveredTools: [],
    addedAt: Date.now(),
  };

  const client = new McpClient(ssrfConfig);
  const listResult = await client.listTools();
  assert.equal(listResult.ok, false, "Localhost endpoint rejected");
  assert.ok(listResult.error?.includes("SSRF_BLOCKED"), "SSRF blocked error code present");
  console.log("[PASS] Localhost MCP server endpoint blocked by SSRF guard.");

  console.log("=== ALL MCP CLIENT TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
