/**
 * Canonical Tool Manifest for CoderXP Agent System.
 *
 * Single source of truth for all 16 agent workspace tools.
 * Pure provider-neutral declarations with zero DOM/server/browser dependencies.
 * Shared between client validation, M3.8 transport, and server-side provider adapters.
 */

import type { AgentToolName } from "./agent-tools";
import type { CanonicalToolDefinition } from "./agent-transport-types";

export interface ToolJsonSchemaProperty {
  type: string;
  description?: string;
  items?: { type: string } | ToolJsonSchema;
  properties?: Record<string, ToolJsonSchemaProperty>;
  required?: readonly string[];
  enum?: readonly string[];
}

export interface ToolJsonSchema {
  type: "object";
  properties: Record<string, ToolJsonSchemaProperty>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

export interface CanonicalManifestTool extends CanonicalToolDefinition {
  readonly name: AgentToolName;
  readonly jsonSchema: ToolJsonSchema;
}

const FS_PATH_PARAM = {
  name: "path",
  type: "string",
  required: true,
  description: "File or directory path relative to the project root.",
} as const;

export const CANONICAL_TOOL_MANIFEST: readonly CanonicalManifestTool[] = [
  {
    name: "list_files",
    category: "filesystem",
    risk: "read",
    summary: "List all files and directories in the project.",
    parameters: [],
    requiresApproval: false,
    jsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    category: "filesystem",
    risk: "read",
    summary: "Read the UTF-8 contents of a single file in the project.",
    parameters: [FS_PATH_PARAM],
    requiresApproval: false,
    jsonSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to the project root.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "read_files",
    category: "filesystem",
    risk: "read",
    summary: "Read multiple files in one batch call.",
    parameters: [
      {
        name: "paths",
        type: "string[]",
        required: true,
        description: "Up to 50 paths relative to the project root.",
      },
    ],
    requiresApproval: false,
    jsonSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Array of paths relative to the project root.",
        },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    name: "create_file",
    category: "filesystem",
    risk: "write",
    summary: "Create a new file. Fails if the path already exists.",
    parameters: [
      FS_PATH_PARAM,
      {
        name: "contents",
        type: "string",
        required: false,
        description: "Initial file body. Empty when omitted.",
      },
    ],
    requiresApproval: false,
    jsonSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to the project root.",
        },
        contents: {
          type: "string",
          description: "Initial file body.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    category: "filesystem",
    risk: "write",
    summary: "Write a file, replacing its contents if it exists.",
    parameters: [
      FS_PATH_PARAM,
      {
        name: "contents",
        type: "string",
        required: true,
        description: "Full file body.",
      },
    ],
    requiresApproval: false,
    jsonSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to the project root.",
        },
        contents: {
          type: "string",
          description: "Full file body.",
        },
      },
      required: ["path", "contents"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_patch",
    category: "filesystem",
    risk: "write",
    summary: "Apply exact-match edits to a file. All edits apply or none do.",
    parameters: [
      FS_PATH_PARAM,
      {
        name: "edits",
        type: "object[]",
        required: true,
        description: "Edits of the form { oldText, newText, replaceAll? }.",
      },
    ],
    requiresApproval: false,
    jsonSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to the project root.",
        },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string" },
              newText: { type: "string" },
              replaceAll: { type: "boolean" },
            },
            required: ["oldText", "newText"],
          },
          description: "Array of text replacements to apply atomically.",
        },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
  },
  {
    name: "rename_file",
    category: "filesystem",
    risk: "destructive",
    summary: "Rename or move a file or directory.",
    parameters: [
      { name: "from", type: "string", required: true, description: "Existing path." },
      { name: "to", type: "string", required: true, description: "Destination path." },
    ],
    requiresApproval: true,
    jsonSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Existing path relative to project root." },
        to: { type: "string", description: "Destination path relative to project root." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    category: "filesystem",
    risk: "destructive",
    summary: "Delete a file, or a directory and all of its descendants.",
    parameters: [FS_PATH_PARAM],
    requiresApproval: true,
    jsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory path to delete." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    category: "command",
    risk: "execute",
    summary: "Start a real bounded process in the workspace container (timeout <= 120s).",
    parameters: [
      { name: "command", type: "string", required: true, description: "Executable name or command." },
      { name: "args", type: "string[]", required: false, description: "List of command arguments." },
      { name: "cwd", type: "string", required: false, description: "Working directory relative to project root." },
      { name: "env", type: "object", required: false, description: "Environment variables map." },
    ],
    requiresApproval: true,
    jsonSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Executable or command name." },
        args: { type: "array", items: { type: "string" }, description: "Argument list." },
        cwd: { type: "string", description: "Working directory." },
        env: { type: "object", description: "Environment variables." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "start_process",
    category: "command",
    risk: "execute",
    summary: "Start a long-running web server or background process in the devbox and detect its listening port (e.g. 3000). Always use this for servers rather than run_command.",
    parameters: [
      { name: "command", type: "string", required: true, description: "Executable or server command, e.g. \"node server.mjs\" or \"npm start\"." },
      { name: "args", type: "string[]", required: false, description: "List of command arguments." },
      { name: "cwd", type: "string", required: false, description: "Working directory relative to project root." },
      { name: "env", type: "object", required: false, description: "Environment variables map." },
    ],
    requiresApproval: true,
    jsonSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Server executable or command name." },
        args: { type: "array", items: { type: "string" }, description: "Argument list." },
        cwd: { type: "string", description: "Working directory." },
        env: { type: "object", description: "Environment variables." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_command",
    category: "command",
    risk: "execute",
    summary: "Terminate a running process by its process ID.",
    parameters: [
      { name: "processId", type: "string", required: true, description: "Process ID to stop." },
    ],
    requiresApproval: true,
    jsonSchema: {
      type: "object",
      properties: {
        processId: { type: "string", description: "Process identifier." },
      },
      required: ["processId"],
      additionalProperties: false,
    },
  },
  {
    name: "read_command_output",
    category: "command",
    risk: "read",
    summary: "Read the real state, output, and exit code of a process.",
    parameters: [
      { name: "processId", type: "string", required: true, description: "Process ID to inspect." },
      { name: "sinceOffset", type: "number", required: false, description: "Resume offset from previous call." },
    ],
    requiresApproval: false,
    jsonSchema: {
      type: "object",
      properties: {
        processId: { type: "string", description: "Process identifier." },
        sinceOffset: { type: "number", description: "Character offset." },
      },
      required: ["processId"],
      additionalProperties: false,
    },
  },
  {
    name: "run_project",
    category: "runtime",
    risk: "execute",
    summary: "Start the project through the workspace runtime.",
    parameters: [],
    requiresApproval: true,
    jsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "stop_project",
    category: "runtime",
    risk: "execute",
    summary: "Stop the running project process.",
    parameters: [],
    requiresApproval: true,
    jsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_runtime_status",
    category: "runtime",
    risk: "read",
    summary: "Report the real runtime state and preview URL.",
    parameters: [],
    requiresApproval: false,
    jsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "run_build",
    category: "runtime",
    risk: "execute",
    summary: "Execute the build command for the project template.",
    parameters: [],
    requiresApproval: true,
    jsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "run_tests",
    category: "runtime",
    risk: "execute",
    summary: "Execute the test runner for the project template.",
    parameters: [],
    requiresApproval: true,
    jsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

export const TOOL_MANIFEST_BY_NAME: ReadonlyMap<string, CanonicalManifestTool> = new Map(
  CANONICAL_TOOL_MANIFEST.map((t) => [t.name, t]),
);

export function getManifestTool(name: string): CanonicalManifestTool | undefined {
  return TOOL_MANIFEST_BY_NAME.get(name);
}

export function isValidManifestTool(name: string): name is AgentToolName {
  return TOOL_MANIFEST_BY_NAME.has(name);
}
