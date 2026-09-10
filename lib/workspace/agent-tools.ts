/**
 * Agent workspace tool contracts for CoderXP M3.5 + M3.6.
 *
 * This module is the provider-independent description layer for the tools an
 * agent may invoke against a CoderXP project. It contains declarations only:
 * names, categories, risk metadata, parameter and result shapes, and the
 * registry. All behaviour lives in `agent-tool-handlers.ts`, which wraps the
 * real workspace subsystems.
 *
 * Deliberately absent, and not to be added here:
 * - vendor SDKs, model provider calls, API keys, network access
 * - a second WebContainer or any agent-private filesystem
 * - fabricated command output or invented build/test results
 *
 * Risk metadata is carried now so that M3.6 can permission-gate destructive
 * tools without changing these contracts.
 */

// ---------------------------------------------------------------------------
// Tool identity
// ---------------------------------------------------------------------------

/** Every tool the agent may invoke in M3.5. */
export type AgentToolName =
  // filesystem — authoritative IndexedDB project source
  | "list_files"
  | "read_file"
  | "read_files"
  | "create_file"
  | "write_file"
  | "apply_patch"
  | "rename_file"
  | "delete_file"
  // commands — WorkspaceCommandController
  | "run_command"
  | "start_process"
  | "stop_command"
  | "read_command_output"
  // runtime — WorkspaceRuntime
  | "run_project"
  | "stop_project"
  | "get_runtime_status"
  | "run_build"
  | "run_tests";

/** Which workspace subsystem a tool wraps. */
export type AgentToolCategory = "filesystem" | "command" | "runtime";

/**
 * Effect classification, consumed by the M3.6 permission layer.
 *
 * - "read"        observes state, mutates nothing
 * - "write"       creates or updates project source
 * - "destructive" removes or relocates existing project source
 * - "execute"     starts or stops a real process
 */
export type AgentToolRisk = "read" | "write" | "destructive" | "execute";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable failure codes. Callers may branch on these; messages are for humans. */
export type AgentToolErrorCode =
  /** Parameters were missing, malformed, or failed path validation. */
  | "INVALID_PARAMS"
  /** The addressed file, directory, or process does not exist. */
  | "NOT_FOUND"
  /** The target already exists and the tool refuses to overwrite it. */
  | "ALREADY_EXISTS"
  /** The call no longer owns its project or generation. Nothing was mutated. */
  | "STALE_OWNERSHIP"
  /** No project is open. */
  | "NO_PROJECT"
  /** The project source is not present in the shared WebContainer. */
  | "NOT_MOUNTED"
  /** IndexedDB rejected the operation. */
  | "PERSISTENCE"
  /** The runtime or command subsystem failed. */
  | "RUNTIME"
  /** A patch edit did not match, or matched more than once. */
  | "PATCH_CONFLICT"
  /** The content exceeded a tool limit. */
  | "TOO_LARGE"
  /** The project does not define what the tool needs, e.g. a test script. */
  | "NOT_CONFIGURED"
  /**
   * Pending editor drafts could not be saved, so IndexedDB is not current.
   * The tool did not run; the user's unsaved work is untouched.
   */
  | "EDITOR_FLUSH_FAILED"
  /** The requested tool is not in the registry. */
  | "UNKNOWN_TOOL"
  /** The permission gate denied the call. */
  | "PERMISSION_DENIED";

export interface AgentToolError {
  code: AgentToolErrorCode;
  message: string;
}

/** Uniform result envelope. Handlers never throw for expected failures. */
export type AgentToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AgentToolError };

export function toolOk<T>(data: T): AgentToolResult<T> {
  return { ok: true, data };
}

export function toolErr<T = never>(
  code: AgentToolErrorCode,
  message: string,
): AgentToolResult<T> {
  return { ok: false, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Largest file body a single filesystem tool will read or write. */
export const MAX_TOOL_FILE_BYTES = 1 * 1024 * 1024;

/** Largest command output slice returned by one read_command_output call. */
export const MAX_TOOL_OUTPUT_CHARS = 64 * 1024;

/** Largest number of paths accepted by read_files in one call. */
export const MAX_READ_FILES_BATCH = 32;

// ---------------------------------------------------------------------------
// Fixed messages
// ---------------------------------------------------------------------------

/** Returned verbatim when the project defines no build script. */
export const NO_BUILD_SCRIPT_MESSAGE =
  "No build script is defined for this project.";

/** Returned verbatim when the project defines no test script. */
export const NO_TEST_SCRIPT_MESSAGE =
  "No test script is defined for this project.";

/**
 * Returned when a call is discarded because the project changed underneath it.
 * Ownership loss is a normal outcome of a project switch, not a defect.
 */
export const STALE_OWNERSHIP_MESSAGE =
  "The project changed while this tool call was in progress. Nothing was modified.";

// ---------------------------------------------------------------------------
// Filesystem parameter / result shapes
// ---------------------------------------------------------------------------

export interface ListFilesParams {
  /** Directory to list, relative to project root. Omit or "" for the root. */
  path?: string;
  /** List the whole subtree rather than one level. Defaults to false. */
  recursive?: boolean;
}

export interface ListedEntry {
  path: string;
  kind: "file" | "directory";
  /** Byte length of the file body. Always 0 for directories. */
  size: number;
}

export interface ListFilesData {
  path: string;
  entries: ListedEntry[];
}

export interface ReadFileParams {
  path: string;
}

export interface ReadFileData {
  path: string;
  contents: string;
  /** True when the body was cut at MAX_TOOL_FILE_BYTES. */
  truncated: boolean;
}

export interface ReadFilesParams {
  paths: string[];
}

/** Per-path outcome. One unreadable path does not fail the batch. */
export type ReadFilesEntry =
  | { path: string; ok: true; contents: string; truncated: boolean }
  | { path: string; ok: false; error: AgentToolError };

export interface ReadFilesData {
  files: ReadFilesEntry[];
}

export interface CreateFileParams {
  path: string;
  /** Initial body. Defaults to the empty string. */
  contents?: string;
}

export interface WriteFileParams {
  path: string;
  contents: string;
}

export interface WriteFileData {
  path: string;
  /** True when the file did not previously exist. */
  created: boolean;
  bytes: number;
}

/**
 * A single exact-match edit.
 *
 * Unified-diff parsing is deliberately not used: it is ambiguous under
 * whitespace drift and cannot be validated deterministically. An edit must
 * match its file exactly once unless `replaceAll` is set.
 */
export interface PatchEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface ApplyPatchParams {
  path: string;
  edits: PatchEdit[];
}

export interface ApplyPatchData {
  path: string;
  /** Number of edits applied. Equal to edits.length on success. */
  editsApplied: number;
  /** Total substitutions made across all edits. */
  replacements: number;
  bytes: number;
}

export interface RenameFileParams {
  from: string;
  to: string;
}

export interface RenameFileData {
  from: string;
  to: string;
}

export interface DeleteFileParams {
  path: string;
}

export interface DeleteFileData {
  path: string;
  /** Directory deletes remove descendants; this is the total removed. */
  removed: number;
}

// ---------------------------------------------------------------------------
// Command parameter / result shapes
// ---------------------------------------------------------------------------

export interface RunCommandParams {
  command: string;
  args?: string[];
  /** Working directory inside the container. Defaults to the project root. */
  cwd?: string;
  env?: Record<string, string>;
}

export interface RunCommandData {
  /** The real WorkspaceCommandController process ID. */
  processId: string;
  command: string;
  args: string[];
  cwd: string;
}

export interface StartProcessParams {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface StartProcessData {
  pid: number | string;
  processId: string;
  port: number;
  status: "running";
  output: string;
}

export interface ReadCommandOutputParams {
  processId: string;
  /** Character offset to resume from, for incremental reads. Defaults to 0. */
  sinceOffset?: number;
}

export interface ReadCommandOutputData {
  processId: string;
  /** Real lifecycle state from the controller. */
  state: "starting" | "running" | "exited" | "failed" | "cancelled";
  /** Output slice starting at sinceOffset, capped at MAX_TOOL_OUTPUT_CHARS. */
  output: string;
  /** Offset to pass as sinceOffset on the next call. */
  nextOffset: number;
  /** Total retained output length. */
  totalLength: number;
  /** Real exit code, or null while the process has not exited. */
  exitCode: number | null;
  /** True when the controller dropped output at its retention cap. */
  truncated: boolean;
  /** True when this response itself was cut at MAX_TOOL_OUTPUT_CHARS. */
  sliceTruncated: boolean;
}

export interface StopCommandParams {
  processId: string;
}

export interface StopCommandData {
  processId: string;
  /** True when a live process was killed; false when it had already ended. */
  stopped: boolean;
}

// ---------------------------------------------------------------------------
// Runtime parameter / result shapes
// ---------------------------------------------------------------------------

export type RuntimeStatusState =
  | "idle"
  | "booting"
  | "mounting"
  | "installing"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export interface RuntimeStatusData {
  state: RuntimeStatusState;
  /** Real preview URL from the server-ready event, or null. */
  previewUrl: string | null;
  /** Whether the active project source is present in the shared container. */
  mounted: boolean;
  error: string | null;
}

export interface RunProjectData {
  started: boolean;
  state: RuntimeStatusState;
}

export interface StopProjectData {
  stopped: boolean;
  state: RuntimeStatusState;
}

/**
 * Build and test tools resolve a real script from the project's package.json
 * and then run it through the command controller. When the script is absent
 * the tool reports that fact; it never fabricates a result.
 */
export interface ScriptRunData {
  /** The package.json script name that was executed. */
  script: string;
  /** The command controller process ID of the run. */
  processId: string;
  command: string;
  args: string[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface AgentToolParameterSpec {
  name: string;
  type: "string" | "string[]" | "boolean" | "number" | "object" | "object[]";
  required: boolean;
  description: string;
}

export interface AgentToolDefinition {
  name: AgentToolName;
  category: AgentToolCategory;
  risk: AgentToolRisk;
  /** One-line description, suitable for a provider tool manifest in M3.9. */
  summary: string;
  parameters: readonly AgentToolParameterSpec[];
  /** True when the tool writes to the authoritative project source. */
  mutatesFiles: boolean;
  /**
   * True when M3.6 must obtain user approval before the call runs.
   * Set for every destructive and execute tool.
   */
  requiresApproval: boolean;
}

const FS_PATH: AgentToolParameterSpec = {
  name: "path",
  type: "string",
  required: true,
  description: "Path relative to the project root.",
};

export const AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: "list_files",
    category: "filesystem",
    risk: "read",
    summary: "List files and directories in the project.",
    parameters: [
      { ...FS_PATH, required: false, description: "Directory to list. Root when omitted." },
      {
        name: "recursive",
        type: "boolean",
        required: false,
        description: "List the whole subtree instead of one level.",
      },
    ],
    mutatesFiles: false,
    requiresApproval: false,
  },
  {
    name: "read_file",
    category: "filesystem",
    risk: "read",
    summary: "Read one file from the project source.",
    parameters: [FS_PATH],
    mutatesFiles: false,
    requiresApproval: false,
  },
  {
    name: "read_files",
    category: "filesystem",
    risk: "read",
    summary: "Read several files in one call.",
    parameters: [
      {
        name: "paths",
        type: "string[]",
        required: true,
        description: `Up to ${MAX_READ_FILES_BATCH} paths relative to the project root.`,
      },
    ],
    mutatesFiles: false,
    requiresApproval: false,
  },
  {
    name: "create_file",
    category: "filesystem",
    risk: "write",
    summary: "Create a new file. Fails if the path already exists.",
    parameters: [
      FS_PATH,
      {
        name: "contents",
        type: "string",
        required: false,
        description: "Initial file body. Empty when omitted.",
      },
    ],
    mutatesFiles: true,
    requiresApproval: false,
  },
  {
    name: "write_file",
    category: "filesystem",
    risk: "write",
    summary: "Write a file, replacing its contents if it exists.",
    parameters: [
      FS_PATH,
      { name: "contents", type: "string", required: true, description: "Full file body." },
    ],
    mutatesFiles: true,
    requiresApproval: false,
  },
  {
    name: "apply_patch",
    category: "filesystem",
    risk: "write",
    summary: "Apply exact-match edits to a file. All edits apply or none do.",
    parameters: [
      FS_PATH,
      {
        name: "edits",
        type: "object[]",
        required: true,
        description: "Edits of the form { oldText, newText, replaceAll? }.",
      },
    ],
    mutatesFiles: true,
    requiresApproval: false,
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
    mutatesFiles: true,
    requiresApproval: true,
  },
  {
    name: "delete_file",
    category: "filesystem",
    risk: "destructive",
    summary: "Delete a file, or a directory and all of its descendants.",
    parameters: [FS_PATH],
    mutatesFiles: true,
    requiresApproval: true,
  },
  {
    name: "run_command",
    category: "command",
    risk: "execute",
    summary: "Start a real bounded process in the workspace container (timeout <= 120s).",
    parameters: [
      { name: "command", type: "string", required: true, description: "Executable, e.g. \"npm\"." },
      { name: "args", type: "string[]", required: false, description: "Argument list." },
      { name: "cwd", type: "string", required: false, description: "Working directory." },
      { name: "env", type: "object", required: false, description: "Environment variables." },
    ],
    mutatesFiles: false,
    requiresApproval: true,
  },
  {
    name: "start_process",
    category: "command",
    risk: "execute",
    summary: "Start a long-running web server or background process in the devbox and detect its listening port (e.g. 3000). Always use this for servers rather than run_command.",
    parameters: [
      { name: "command", type: "string", required: true, description: "Server command, e.g. \"node server.mjs\" or \"npm start\"." },
      { name: "args", type: "string[]", required: false, description: "Argument list." },
      { name: "cwd", type: "string", required: false, description: "Working directory." },
      { name: "env", type: "object", required: false, description: "Environment variables." },
    ],
    mutatesFiles: false,
    requiresApproval: true,
  },
  {
    name: "stop_command",
    category: "command",
    risk: "execute",
    summary: "Terminate a running process by its process ID.",
    parameters: [
      { name: "processId", type: "string", required: true, description: "Process ID to stop." },
    ],
    mutatesFiles: false,
    requiresApproval: true,
  },
  {
    name: "read_command_output",
    category: "command",
    risk: "read",
    summary: "Read the real state, output, and exit code of a process.",
    parameters: [
      { name: "processId", type: "string", required: true, description: "Process ID to inspect." },
      {
        name: "sinceOffset",
        type: "number",
        required: false,
        description: "Resume offset from a previous call.",
      },
    ],
    mutatesFiles: false,
    requiresApproval: false,
  },
  {
    name: "run_project",
    category: "runtime",
    risk: "execute",
    summary: "Start the project through the workspace runtime.",
    parameters: [],
    mutatesFiles: false,
    requiresApproval: true,
  },
  {
    name: "stop_project",
    category: "runtime",
    risk: "execute",
    summary: "Stop the running project process.",
    parameters: [],
    mutatesFiles: false,
    requiresApproval: true,
  },
  {
    name: "get_runtime_status",
    category: "runtime",
    risk: "read",
    summary: "Report the real runtime state and preview URL.",
    parameters: [],
    mutatesFiles: false,
    requiresApproval: false,
  },
  {
    name: "run_build",
    category: "runtime",
    risk: "execute",
    summary: "Run the project's build script, if one is defined.",
    parameters: [],
    mutatesFiles: false,
    requiresApproval: true,
  },
  {
    name: "run_tests",
    category: "runtime",
    risk: "execute",
    summary: "Run the project's test script, if one is defined.",
    parameters: [],
    mutatesFiles: false,
    requiresApproval: true,
  },
] as const;

const TOOLS_BY_NAME: ReadonlyMap<string, AgentToolDefinition> = new Map(
  AGENT_TOOLS.map((tool) => [tool.name as string, tool]),
);

/** Returns the definition for a tool name, or null when the name is unknown. */
export function getAgentTool(name: string): AgentToolDefinition | null {
  return TOOLS_BY_NAME.get(name) ?? null;
}

/** True when the name is a tool this build implements. */
export function isAgentToolName(name: string): name is AgentToolName {
  return TOOLS_BY_NAME.has(name);
}

/** Tools that M3.6 must gate before execution. */
export function toolsRequiringApproval(): AgentToolDefinition[] {
  return AGENT_TOOLS.filter((tool) => tool.requiresApproval);
}
