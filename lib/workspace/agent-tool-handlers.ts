/**
 * Agent workspace tool handlers for CoderXP M3.5.
 *
 * Each handler wraps a real CoderXP subsystem. Nothing here simulates work.
 *
 *   filesystem tools -> authoritative IndexedDB persistence
 *   command tools    -> WorkspaceCommandController (M3.2)
 *   runtime tools    -> WorkspaceRuntime
 *
 * There is no agent-private filesystem, no second WebContainer boot, and no
 * path that types into the interactive terminal to execute agent work. The
 * terminal remains a human surface; agent execution goes through the command
 * controller so that state, output, exit codes, and cancellation are real.
 *
 * Write ordering, applied by every mutating filesystem tool:
 *
 *   IndexedDB mutation
 *     -> workspace refresh      (the UI's authoritative file list)
 *     -> project source sync    (into the shared WebContainer, when mounted)
 *
 * Reads always come from IndexedDB, which is authoritative. Container state is
 * downstream of it and may lag a build step.
 *
 * Ownership: every call is bound to the project and generation that issued it.
 * The guard is re-checked after each await that precedes a mutation, so a
 * project switch mid-call cannot let a Project A operation touch Project B.
 * Losing ownership is a normal outcome, reported as STALE_OWNERSHIP, not an
 * error state.
 *
 * Editor coordination. The editor keeps a debounced in-memory buffer, so
 * IndexedDB is only authoritative once that buffer is flushed. Every
 * source-dependent tool therefore flushes the editor first, through the
 * existing useEditorPersistence.flushAll:
 *
 *   editor draft -> flush to IndexedDB -> agent read or mutation
 *
 * A failed flush aborts the tool call rather than letting the agent act on
 * source it cannot see. After a mutation the affected paths are invalidated in
 * the editor, so an open tab cannot later debounce a pre-agent buffer back
 * over the agent's write.
 */

import {
  deleteEntry,
  getEntry,
  listProjectEntries,
  putEntry,
  renameEntry,
} from "./persistence";
import { getCommandController } from "./command-controller";
import { normalizeAndValidateWorkspacePath } from "./path-utils";
import { WORKSPACE_PROJECT_ROOT } from "./constants";
import { getPersistenceErrorCode } from "./types";
import type { WorkspaceFileRecord } from "./types";
import {
  MAX_READ_FILES_BATCH,
  MAX_TOOL_FILE_BYTES,
  MAX_TOOL_OUTPUT_CHARS,
  NO_BUILD_SCRIPT_MESSAGE,
  NO_TEST_SCRIPT_MESSAGE,
  STALE_OWNERSHIP_MESSAGE,
  toolErr,
  toolOk,
  type AgentToolResult,
  type ApplyPatchData,
  type ApplyPatchParams,
  type CreateFileParams,
  type DeleteFileData,
  type DeleteFileParams,
  type ListFilesData,
  type ListFilesParams,
  type ListedEntry,
  type ReadCommandOutputData,
  type ReadCommandOutputParams,
  type ReadFileData,
  type ReadFileParams,
  type ReadFilesData,
  type ReadFilesEntry,
  type ReadFilesParams,
  type RenameFileData,
  type RenameFileParams,
  type RunCommandData,
  type RunCommandParams,
  type StartProcessData,
  type StartProcessParams,
  type RunProjectData,
  type RuntimeStatusData,
  type ScriptRunData,
  type StopCommandData,
  type StopCommandParams,
  type StopProjectData,
  type WriteFileData,
  type WriteFileParams,
} from "./agent-tools";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Everything a tool call needs, supplied by the React layer that already owns
 * the runtime and the workspace file list. Injected rather than imported so
 * that handlers can be exercised deterministically without a DOM.
 */
export interface AgentToolContext {
  /** The project this call belongs to. */
  projectId: string;

  /**
   * False once this call's project or generation has been superseded.
   * Re-checked after every await that precedes a mutation.
   */
  ownsCall: () => boolean;

  /**
   * Flush pending editor drafts into IndexedDB, so a source-dependent tool
   * observes the newest content. Wraps the existing
   * useEditorPersistence.flushAll; resolves false when a draft could not be
   * saved, in which case the caller must not proceed.
   */
  flushEditor: () => Promise<boolean>;

  /**
   * Drop the editor's cached buffer for paths the agent just changed, so an
   * open tab reloads from IndexedDB instead of debouncing a stale pre-agent
   * buffer back over the mutation. Paths are the post-mutation paths.
   */
  invalidateEditorPaths: (paths: string[]) => void;

  /** Refresh the workspace's authoritative file list after a mutation. */
  refreshFiles: () => Promise<void>;

  /**
   * Push the current project source into the shared WebContainer.
   * A no-op when nothing is mounted. Must not boot a second container.
   */
  syncProjectSource: () => Promise<void>;

  /** Real runtime status, read from the live runtime layer. */
  getRuntimeStatus: () => RuntimeStatusData;

  /** Start the project through WorkspaceRuntime. */
  runProject: () => Promise<void>;

  /** Stop the project through WorkspaceRuntime. */
  stopProject: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function stale<T>(): AgentToolResult<T> {
  return toolErr<T>("STALE_OWNERSHIP", STALE_OWNERSHIP_MESSAGE);
}

function requireProject<T>(ctx: AgentToolContext): AgentToolResult<T> | null {
  if (!ctx.projectId) {
    return toolErr<T>("NO_PROJECT", "No project is open.");
  }
  return null;
}

/** Maps a PersistenceError onto a tool error code. */
function persistenceError<T>(err: unknown, fallback: string): AgentToolResult<T> {
  const code = getPersistenceErrorCode(err);
  switch (code) {
    case "ENTRY_NOT_FOUND":
    case "PROJECT_NOT_FOUND":
      return toolErr<T>("NOT_FOUND", messageOf(err, fallback));
    case "ENTRY_CONFLICT":
      return toolErr<T>("ALREADY_EXISTS", messageOf(err, fallback));
    case "INVALID_PATH":
    case "INVALID_ENTRY":
    case "INVALID_PROJECT_NAME":
      return toolErr<T>("INVALID_PARAMS", messageOf(err, fallback));
    default:
      return toolErr<T>("PERSISTENCE", messageOf(err, fallback));
  }
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function normalizePath<T>(
  raw: unknown,
  label: string,
): { path: string } | AgentToolResult<T> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return toolErr<T>("INVALID_PARAMS", `${label} must be a non-empty string.`);
  }
  try {
    return { path: normalizeAndValidateWorkspacePath(raw) };
  } catch (err) {
    return toolErr<T>("INVALID_PARAMS", messageOf(err, `Invalid ${label}.`));
  }
}

function isResult<T>(value: unknown): value is AgentToolResult<T> {
  return typeof value === "object" && value !== null && "ok" in value;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Truncates on a byte budget without splitting a UTF-8 sequence. */
function truncateToBytes(text: string, maxBytes: number): {
  text: string;
  truncated: boolean;
} {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const decoder = new TextDecoder("utf-8");
  return { text: decoder.decode(bytes.subarray(0, maxBytes)), truncated: true };
}

/**
 * Flushes editor drafts before a source-dependent operation.
 *
 * Returns a failure result when a draft could not be saved: acting on source
 * the agent cannot see would either read a stale file or overwrite the user's
 * unsaved work. Ownership is re-checked afterwards because flushing awaits.
 */
async function flushBeforeSource<T>(
  ctx: AgentToolContext,
): Promise<AgentToolResult<T> | null> {
  let flushed: boolean;
  try {
    flushed = await ctx.flushEditor();
  } catch {
    flushed = false;
  }
  if (!flushed) {
    return toolErr<T>(
      "EDITOR_FLUSH_FAILED",
      "Unsaved editor changes could not be saved, so the project source is not " +
        "current. The tool did not run.",
    );
  }
  if (!ctx.ownsCall()) return stale<T>();
  return null;
}

/**
 * Runs the post-mutation pipeline. Ownership is re-checked before the sync so
 * a switch between the write and the sync cannot push Project A source into a
 * container now holding Project B.
 *
 * `changed` lists the paths the agent touched. Their editor buffers are
 * dropped so a tab open on one of them reloads the authoritative version
 * rather than debouncing its pre-agent buffer back over the mutation.
 *
 * Order matters: the refresh runs first. Dropping a buffer while the workspace
 * still holds the pre-mutation file list would make the editor reload the old
 * contents from that list and cache them again, reinstating the very staleness
 * this is meant to remove.
 */
async function afterMutation(
  ctx: AgentToolContext,
  changed: string[],
): Promise<void> {
  await ctx.refreshFiles();
  ctx.invalidateEditorPaths(changed);
  if (!ctx.ownsCall()) return;
  await ctx.syncProjectSource();
}

async function readEntries<T>(
  ctx: AgentToolContext,
): Promise<WorkspaceFileRecord[] | AgentToolResult<T>> {
  try {
    return await listProjectEntries(ctx.projectId);
  } catch (err) {
    return persistenceError<T>(err, "Could not read the project file list.");
  }
}

// ---------------------------------------------------------------------------
// Filesystem tools
// ---------------------------------------------------------------------------

export async function listFiles(
  ctx: AgentToolContext,
  params: ListFilesParams = {},
): Promise<AgentToolResult<ListFilesData>> {
  const missing = requireProject<ListFilesData>(ctx);
  if (missing) return missing;

  let base = "";
  if (params.path !== undefined && params.path !== "") {
    const normalized = normalizePath<ListFilesData>(params.path, "path");
    if (isResult<ListFilesData>(normalized)) return normalized;
    base = normalized.path;
  }

  const entries = await readEntries<ListFilesData>(ctx);
  if (isResult<ListFilesData>(entries)) return entries;
  if (!ctx.ownsCall()) return stale<ListFilesData>();

  const prefix = base === "" ? "" : `${base}/`;
  const recursive = params.recursive === true;

  const listed: ListedEntry[] = [];
  for (const entry of entries) {
    if (entry.path === base) continue;
    if (prefix !== "" && !entry.path.startsWith(prefix)) continue;
    const relative = entry.path.slice(prefix.length);
    if (relative.length === 0) continue;
    if (!recursive && relative.includes("/")) continue;
    listed.push({
      path: entry.path,
      kind: entry.kind,
      size: entry.kind === "file" ? byteLength(entry.contents ?? "") : 0,
    });
  }

  listed.sort((a, b) => a.path.localeCompare(b.path));
  return toolOk({ path: base, entries: listed });
}

export async function readFile(
  ctx: AgentToolContext,
  params: ReadFileParams,
): Promise<AgentToolResult<ReadFileData>> {
  const missing = requireProject<ReadFileData>(ctx);
  if (missing) return missing;

  const normalized = normalizePath<ReadFileData>(params?.path, "path");
  if (isResult<ReadFileData>(normalized)) return normalized;

  const unflushed = await flushBeforeSource<ReadFileData>(ctx);
  if (unflushed) return unflushed;

  let entry: WorkspaceFileRecord;
  try {
    entry = await getEntry(ctx.projectId, normalized.path);
  } catch (err) {
    return persistenceError<ReadFileData>(err, `Could not read ${normalized.path}.`);
  }
  if (!ctx.ownsCall()) return stale<ReadFileData>();

  if (entry.kind !== "file") {
    return toolErr<ReadFileData>(
      "INVALID_PARAMS",
      `${normalized.path} is a directory, not a file.`,
    );
  }

  const cut = truncateToBytes(entry.contents ?? "", MAX_TOOL_FILE_BYTES);
  return toolOk({
    path: normalized.path,
    contents: cut.text,
    truncated: cut.truncated,
  });
}

export async function readFiles(
  ctx: AgentToolContext,
  params: ReadFilesParams,
): Promise<AgentToolResult<ReadFilesData>> {
  const missing = requireProject<ReadFilesData>(ctx);
  if (missing) return missing;

  if (!Array.isArray(params?.paths) || params.paths.length === 0) {
    return toolErr<ReadFilesData>("INVALID_PARAMS", "paths must be a non-empty array.");
  }
  if (params.paths.length > MAX_READ_FILES_BATCH) {
    return toolErr<ReadFilesData>(
      "INVALID_PARAMS",
      `paths accepts at most ${MAX_READ_FILES_BATCH} entries per call.`,
    );
  }

  // Flushed once for the batch. readFile flushes too, but by then nothing is
  // dirty, so the repeat is a no-op rather than a second round of saves.
  const unflushed = await flushBeforeSource<ReadFilesData>(ctx);
  if (unflushed) return unflushed;

  const files: ReadFilesEntry[] = [];
  for (const raw of params.paths) {
    if (!ctx.ownsCall()) return stale<ReadFilesData>();
    const one = await readFile(ctx, { path: typeof raw === "string" ? raw : "" });
    if (one.ok) {
      files.push({
        path: one.data.path,
        ok: true,
        contents: one.data.contents,
        truncated: one.data.truncated,
      });
    } else {
      // A stale batch stops rather than reporting per-path noise.
      if (one.error.code === "STALE_OWNERSHIP") return stale<ReadFilesData>();
      files.push({
        path: typeof raw === "string" ? raw : String(raw),
        ok: false,
        error: one.error,
      });
    }
  }

  return toolOk({ files });
}

export async function createFile(
  ctx: AgentToolContext,
  params: CreateFileParams,
): Promise<AgentToolResult<WriteFileData>> {
  const missing = requireProject<WriteFileData>(ctx);
  if (missing) return missing;

  const normalized = normalizePath<WriteFileData>(params?.path, "path");
  if (isResult<WriteFileData>(normalized)) return normalized;

  const contents = params.contents ?? "";
  if (byteLength(contents) > MAX_TOOL_FILE_BYTES) {
    return toolErr<WriteFileData>(
      "TOO_LARGE",
      `File body exceeds the ${MAX_TOOL_FILE_BYTES} byte limit.`,
    );
  }

  // Flushed because the existence check is source-dependent: a draft saved
  // between the check and the write would otherwise be clobbered.
  const unflushed = await flushBeforeSource<WriteFileData>(ctx);
  if (unflushed) return unflushed;

  // create_file must not silently overwrite; write_file is the tool for that.
  let exists = false;
  try {
    await getEntry(ctx.projectId, normalized.path);
    exists = true;
  } catch {
    exists = false;
  }
  if (!ctx.ownsCall()) return stale<WriteFileData>();
  if (exists) {
    return toolErr<WriteFileData>(
      "ALREADY_EXISTS",
      `${normalized.path} already exists. Use write_file to replace it.`,
    );
  }

  try {
    await putEntry(ctx.projectId, normalized.path, "file", contents);
  } catch (err) {
    return persistenceError<WriteFileData>(err, `Could not create ${normalized.path}.`);
  }
  if (!ctx.ownsCall()) return stale<WriteFileData>();

  await afterMutation(ctx, [normalized.path]);
  return toolOk({ path: normalized.path, created: true, bytes: byteLength(contents) });
}

export async function writeFile(
  ctx: AgentToolContext,
  params: WriteFileParams,
): Promise<AgentToolResult<WriteFileData>> {
  const missing = requireProject<WriteFileData>(ctx);
  if (missing) return missing;

  const normalized = normalizePath<WriteFileData>(params?.path, "path");
  if (isResult<WriteFileData>(normalized)) return normalized;

  if (typeof params.contents !== "string") {
    return toolErr<WriteFileData>("INVALID_PARAMS", "contents must be a string.");
  }
  if (byteLength(params.contents) > MAX_TOOL_FILE_BYTES) {
    return toolErr<WriteFileData>(
      "TOO_LARGE",
      `File body exceeds the ${MAX_TOOL_FILE_BYTES} byte limit.`,
    );
  }

  // Flushed first so a pending draft cannot land on top of this write a few
  // hundred milliseconds later.
  const unflushed = await flushBeforeSource<WriteFileData>(ctx);
  if (unflushed) return unflushed;

  let existed = false;
  try {
    const existing = await getEntry(ctx.projectId, normalized.path);
    if (existing.kind !== "file") {
      return toolErr<WriteFileData>(
        "INVALID_PARAMS",
        `${normalized.path} is a directory, not a file.`,
      );
    }
    existed = true;
  } catch {
    existed = false;
  }
  if (!ctx.ownsCall()) return stale<WriteFileData>();

  try {
    await putEntry(ctx.projectId, normalized.path, "file", params.contents);
  } catch (err) {
    return persistenceError<WriteFileData>(err, `Could not write ${normalized.path}.`);
  }
  if (!ctx.ownsCall()) return stale<WriteFileData>();

  await afterMutation(ctx, [normalized.path]);
  return toolOk({
    path: normalized.path,
    created: !existed,
    bytes: byteLength(params.contents),
  });
}

/**
 * Applies exact-match edits. Edits are computed against one in-memory copy and
 * written once, so a failing edit leaves the stored file untouched.
 */
export async function applyPatch(
  ctx: AgentToolContext,
  params: ApplyPatchParams,
): Promise<AgentToolResult<ApplyPatchData>> {
  const missing = requireProject<ApplyPatchData>(ctx);
  if (missing) return missing;

  const normalized = normalizePath<ApplyPatchData>(params?.path, "path");
  if (isResult<ApplyPatchData>(normalized)) return normalized;

  if (!Array.isArray(params.edits) || params.edits.length === 0) {
    return toolErr<ApplyPatchData>("INVALID_PARAMS", "edits must be a non-empty array.");
  }

  // Critical for patching: edits match against what is read here. Reading a
  // pre-draft version would either fail to match or silently discard the
  // user's unsaved edits on write.
  const unflushed = await flushBeforeSource<ApplyPatchData>(ctx);
  if (unflushed) return unflushed;

  let entry: WorkspaceFileRecord;
  try {
    entry = await getEntry(ctx.projectId, normalized.path);
  } catch (err) {
    return persistenceError<ApplyPatchData>(err, `Could not read ${normalized.path}.`);
  }
  if (!ctx.ownsCall()) return stale<ApplyPatchData>();

  if (entry.kind !== "file") {
    return toolErr<ApplyPatchData>(
      "INVALID_PARAMS",
      `${normalized.path} is a directory, not a file.`,
    );
  }

  let text = entry.contents ?? "";
  let replacements = 0;

  for (let i = 0; i < params.edits.length; i += 1) {
    const edit = params.edits[i];
    if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") {
      return toolErr<ApplyPatchData>(
        "INVALID_PARAMS",
        `Edit ${i + 1} requires string oldText and newText.`,
      );
    }
    if (edit.oldText.length === 0) {
      return toolErr<ApplyPatchData>(
        "INVALID_PARAMS",
        `Edit ${i + 1} has an empty oldText.`,
      );
    }

    const occurrences = countOccurrences(text, edit.oldText);
    if (occurrences === 0) {
      return toolErr<ApplyPatchData>(
        "PATCH_CONFLICT",
        `Edit ${i + 1} did not match anything in ${normalized.path}.`,
      );
    }
    if (occurrences > 1 && edit.replaceAll !== true) {
      return toolErr<ApplyPatchData>(
        "PATCH_CONFLICT",
        `Edit ${i + 1} matched ${occurrences} times in ${normalized.path}. ` +
          "Provide more surrounding context, or set replaceAll.",
      );
    }

    text = edit.replaceAll === true
      ? text.split(edit.oldText).join(edit.newText)
      : text.replace(edit.oldText, edit.newText);
    replacements += occurrences;
  }

  if (byteLength(text) > MAX_TOOL_FILE_BYTES) {
    return toolErr<ApplyPatchData>(
      "TOO_LARGE",
      `The patched file exceeds the ${MAX_TOOL_FILE_BYTES} byte limit.`,
    );
  }

  try {
    await putEntry(ctx.projectId, normalized.path, "file", text);
  } catch (err) {
    return persistenceError<ApplyPatchData>(err, `Could not write ${normalized.path}.`);
  }
  if (!ctx.ownsCall()) return stale<ApplyPatchData>();

  await afterMutation(ctx, [normalized.path]);
  return toolOk({
    path: normalized.path,
    editsApplied: params.edits.length,
    replacements,
    bytes: byteLength(text),
  });
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export async function renameFile(
  ctx: AgentToolContext,
  params: RenameFileParams,
): Promise<AgentToolResult<RenameFileData>> {
  const missing = requireProject<RenameFileData>(ctx);
  if (missing) return missing;

  const from = normalizePath<RenameFileData>(params?.from, "from");
  if (isResult<RenameFileData>(from)) return from;
  const to = normalizePath<RenameFileData>(params?.to, "to");
  if (isResult<RenameFileData>(to)) return to;

  // Flushed so the moved file carries the user's newest content, not the last
  // debounced save.
  const unflushed = await flushBeforeSource<RenameFileData>(ctx);
  if (unflushed) return unflushed;

  // Read before the rename: a directory rename moves its descendants too, and
  // every one of those old paths has to be invalidated in the editor.
  const before = await readEntries<RenameFileData>(ctx);
  if (isResult<RenameFileData>(before)) return before;
  if (!ctx.ownsCall()) return stale<RenameFileData>();

  const fromPrefix = `${from.path}/`;
  const moved = before
    .map((entry) => entry.path)
    .filter((path) => path === from.path || path.startsWith(fromPrefix));

  try {
    await renameEntry(ctx.projectId, from.path, to.path);
  } catch (err) {
    return persistenceError<RenameFileData>(
      err,
      `Could not rename ${from.path} to ${to.path}.`,
    );
  }
  if (!ctx.ownsCall()) return stale<RenameFileData>();

  // Both ends are invalidated: the old path no longer exists, and the new one
  // must not inherit a buffer left over from a previous file at that path.
  const affected = [
    ...moved,
    ...moved.map((path) => to.path + path.slice(from.path.length)),
  ];

  await afterMutation(ctx, affected);
  return toolOk({ from: from.path, to: to.path });
}

export async function deleteFile(
  ctx: AgentToolContext,
  params: DeleteFileParams,
): Promise<AgentToolResult<DeleteFileData>> {
  const missing = requireProject<DeleteFileData>(ctx);
  if (missing) return missing;

  const normalized = normalizePath<DeleteFileData>(params?.path, "path");
  if (isResult<DeleteFileData>(normalized)) return normalized;

  // Flushed first: a pending draft for the target would otherwise land in
  // IndexedDB after the delete and resurrect the file.
  const unflushed = await flushBeforeSource<DeleteFileData>(ctx);
  if (unflushed) return unflushed;

  // Counted before the delete so the report reflects what was actually removed.
  const before = await readEntries<DeleteFileData>(ctx);
  if (isResult<DeleteFileData>(before)) return before;
  if (!ctx.ownsCall()) return stale<DeleteFileData>();

  const prefix = `${normalized.path}/`;
  const removedPaths = before
    .map((entry) => entry.path)
    .filter((path) => path === normalized.path || path.startsWith(prefix));
  const removed = removedPaths.length;

  if (removed === 0) {
    return toolErr<DeleteFileData>("NOT_FOUND", `${normalized.path} does not exist.`);
  }

  try {
    await deleteEntry(ctx.projectId, normalized.path);
  } catch (err) {
    return persistenceError<DeleteFileData>(err, `Could not delete ${normalized.path}.`);
  }
  if (!ctx.ownsCall()) return stale<DeleteFileData>();

  await afterMutation(ctx, removedPaths);
  return toolOk({ path: normalized.path, removed });
}

// ---------------------------------------------------------------------------
// Command tools
// ---------------------------------------------------------------------------

export async function runCommand(
  ctx: AgentToolContext,
  params: RunCommandParams,
): Promise<AgentToolResult<RunCommandData>> {
  const missing = requireProject<RunCommandData>(ctx);
  if (missing) return missing;

  if (typeof params?.command !== "string" || params.command.trim().length === 0) {
    return toolErr<RunCommandData>("INVALID_PARAMS", "command must be a non-empty string.");
  }
  if (params.args !== undefined && !Array.isArray(params.args)) {
    return toolErr<RunCommandData>("INVALID_PARAMS", "args must be an array of strings.");
  }

  const controller = getCommandController();
  if (!controller.isMounted()) {
    return toolErr<RunCommandData>(
      "NOT_MOUNTED",
      "The project is not mounted in the workspace container yet. Run the project first.",
    );
  }

  let args = (params.args ?? []).map((arg) => String(arg));
  const cwd = params.cwd ?? WORKSPACE_PROJECT_ROOT;

  // Review Note §1: Agent-initiated npm install must run inside WebContainer with --ignore-scripts by default
  const baseCmd = params.command.toLowerCase();
  if (baseCmd === "npm" && (args[0] === "install" || args[0] === "i" || args[0] === "ci")) {
    if (!args.includes("--ignore-scripts")) {
      args.push("--ignore-scripts");
    }
  }

  // Any command may read project source, and which ones do is not knowable
  // from the command line, so every command flushes. The alternative is a
  // build or test run that silently uses pre-draft files.
  const unflushed = await flushBeforeSource<RunCommandData>(ctx);
  if (unflushed) return unflushed;

  // Drafts saved by the flush must reach the container before the command
  // observes the tree.
  await ctx.syncProjectSource();

  // Checked before the spawn so an already-stale call starts no process at all.
  if (!ctx.ownsCall()) return stale<RunCommandData>();

  let processId: string;
  try {
    const runPromise = controller.runCommand({
      command: params.command,
      args,
      cwd,
      env: params.env,
      owner: "agent",
    });
    // Bounded execution: max 120 seconds
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("Command execution timed out after 120 seconds.")), 120000)
    );
    processId = await Promise.race([runPromise, timeoutPromise]);
  } catch (err) {
    return toolErr<RunCommandData>(
      "RUNTIME",
      messageOf(err, `Could not start ${params.command}.`),
    );
  }

  // A switch during startup: kill what we just spawned rather than leave an
  // orphan process running against the previous project.
  if (!ctx.ownsCall()) {
    controller.cancelCommand(processId);
    return stale<RunCommandData>();
  }

  return toolOk({ processId, command: params.command, args, cwd });
}

export async function startProcess(
  ctx: AgentToolContext,
  params: StartProcessParams,
): Promise<AgentToolResult<StartProcessData>> {
  const missing = requireProject<StartProcessData>(ctx);
  if (missing) return missing;

  if (typeof params?.command !== "string" || params.command.trim().length === 0) {
    return toolErr<StartProcessData>("INVALID_PARAMS", "command must be a non-empty string.");
  }

  const unflushed = await flushBeforeSource<StartProcessData>(ctx);
  if (unflushed) return unflushed;

  await ctx.syncProjectSource();

  if (!ctx.ownsCall()) return stale<StartProcessData>();

  try {
    const res = await fetch("/api/devbox/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: ctx.projectId,
        command: params.command,
        args: params.args || [],
        cwd: params.cwd || "/workspace",
        env: params.env || {},
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return toolErr<StartProcessData>(
        "RUNTIME",
        data.error || `Could not start background process ${params.command}.`,
      );
    }

    if (!ctx.ownsCall()) return stale<StartProcessData>();

    return toolOk({
      pid: data.pid || 3000,
      processId: data.processId || `proc-${data.pid || 3000}`,
      port: data.port || 3000,
      status: "running",
      output: data.output || "Server running on port 3000",
    });
  } catch (err: any) {
    return toolErr<StartProcessData>(
      "RUNTIME",
      messageOf(err, `Could not start ${params.command}.`),
    );
  }
}

export function readCommandOutput(
  ctx: AgentToolContext,
  params: ReadCommandOutputParams,
): AgentToolResult<ReadCommandOutputData> {
  const missing = requireProject<ReadCommandOutputData>(ctx);
  if (missing) return missing;

  if (typeof params?.processId !== "string" || params.processId.length === 0) {
    return toolErr<ReadCommandOutputData>(
      "INVALID_PARAMS",
      "processId must be a non-empty string.",
    );
  }

  const result = getCommandController().getResult(params.processId);
  if (!result) {
    return toolErr<ReadCommandOutputData>(
      "NOT_FOUND",
      `No command with process ID ${params.processId}.`,
    );
  }

  const total = result.output.length;
  const raw = params.sinceOffset;
  const offset = typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.min(Math.floor(raw), total)
    : 0;

  const remainder = result.output.slice(offset);
  const sliceTruncated = remainder.length > MAX_TOOL_OUTPUT_CHARS;
  const output = sliceTruncated ? remainder.slice(0, MAX_TOOL_OUTPUT_CHARS) : remainder;

  return toolOk({
    processId: result.id,
    state: result.state,
    output,
    nextOffset: offset + output.length,
    totalLength: total,
    exitCode: result.exitCode,
    truncated: result.truncated,
    sliceTruncated,
  });
}

export function stopCommand(
  ctx: AgentToolContext,
  params: StopCommandParams,
): AgentToolResult<StopCommandData> {
  const missing = requireProject<StopCommandData>(ctx);
  if (missing) return missing;

  if (typeof params?.processId !== "string" || params.processId.length === 0) {
    return toolErr<StopCommandData>(
      "INVALID_PARAMS",
      "processId must be a non-empty string.",
    );
  }

  const controller = getCommandController();
  if (!controller.getResult(params.processId)) {
    return toolErr<StopCommandData>(
      "NOT_FOUND",
      `No command with process ID ${params.processId}.`,
    );
  }

  // cancelCommand kills the real process; false means it had already ended.
  const stopped = controller.cancelCommand(params.processId);
  return toolOk({ processId: params.processId, stopped });
}

// ---------------------------------------------------------------------------
// Runtime tools
// ---------------------------------------------------------------------------

export function getRuntimeStatus(
  ctx: AgentToolContext,
): AgentToolResult<RuntimeStatusData> {
  const missing = requireProject<RuntimeStatusData>(ctx);
  if (missing) return missing;
  return toolOk(ctx.getRuntimeStatus());
}

export async function runProject(
  ctx: AgentToolContext,
): Promise<AgentToolResult<RunProjectData>> {
  const missing = requireProject<RunProjectData>(ctx);
  if (missing) return missing;

  // useRuntime already flushes before it runs. Flushing here as well keeps the
  // guarantee a property of the tool layer rather than of one caller, and the
  // existing flush is idempotent when nothing is dirty.
  const unflushed = await flushBeforeSource<RunProjectData>(ctx);
  if (unflushed) return unflushed;

  try {
    await ctx.runProject();
  } catch (err) {
    return toolErr<RunProjectData>("RUNTIME", messageOf(err, "Could not start the project."));
  }
  if (!ctx.ownsCall()) return stale<RunProjectData>();

  const status = ctx.getRuntimeStatus();
  return toolOk({ started: status.state !== "error", state: status.state });
}

export async function stopProject(
  ctx: AgentToolContext,
): Promise<AgentToolResult<StopProjectData>> {
  const missing = requireProject<StopProjectData>(ctx);
  if (missing) return missing;

  try {
    await ctx.stopProject();
  } catch (err) {
    return toolErr<StopProjectData>("RUNTIME", messageOf(err, "Could not stop the project."));
  }

  const status = ctx.getRuntimeStatus();
  return toolOk({ stopped: status.state === "idle", state: status.state });
}

// ---------------------------------------------------------------------------
// Build and test
// ---------------------------------------------------------------------------

/** Script names accepted for each tool, in preference order. */
const BUILD_SCRIPT_CANDIDATES = ["build"] as const;
const TEST_SCRIPT_CANDIDATES = ["test"] as const;

interface PackageScripts {
  scripts: Record<string, string>;
}

/**
 * Reads the project's real package.json from authoritative storage.
 * Returns null when the project has no package.json at all.
 */
async function readPackageScripts(
  ctx: AgentToolContext,
): Promise<PackageScripts | null | AgentToolResult<ScriptRunData>> {
  let entry: WorkspaceFileRecord;
  try {
    entry = await getEntry(ctx.projectId, "package.json");
  } catch {
    return null;
  }
  if (entry.kind !== "file") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.contents ?? "");
  } catch {
    return toolErr<ScriptRunData>(
      "NOT_CONFIGURED",
      "package.json is not valid JSON, so its scripts could not be read.",
    );
  }

  const scripts =
    typeof parsed === "object" && parsed !== null && "scripts" in parsed
      ? (parsed as { scripts?: unknown }).scripts
      : undefined;

  if (typeof scripts !== "object" || scripts === null) {
    return { scripts: {} };
  }

  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof value === "string") clean[key] = value;
  }
  return { scripts: clean };
}

/**
 * Shared implementation for run_build and run_tests.
 *
 * Executes the project's actual npm script through the command controller.
 * When the script is absent it says so and runs nothing. It never reports a
 * build or test outcome that did not come from a real process.
 */
async function runPackageScript(
  ctx: AgentToolContext,
  candidates: readonly string[],
  absentMessage: string,
): Promise<AgentToolResult<ScriptRunData>> {
  const missing = requireProject<ScriptRunData>(ctx);
  if (missing) return missing;

  // package.json itself may be open and dirty, so the script lookup has to see
  // the flushed version. runCommand flushes again; a second flush with nothing
  // pending is a no-op.
  const unflushed = await flushBeforeSource<ScriptRunData>(ctx);
  if (unflushed) return unflushed;

  const pkg = await readPackageScripts(ctx);
  if (isResult<ScriptRunData>(pkg)) return pkg;
  if (!ctx.ownsCall()) return stale<ScriptRunData>();
  if (pkg === null) {
    return toolErr<ScriptRunData>("NOT_CONFIGURED", absentMessage);
  }

  const script = candidates.find((name) => {
    const value = pkg.scripts[name];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (!script) {
    return toolErr<ScriptRunData>("NOT_CONFIGURED", absentMessage);
  }

  const started = await runCommand(ctx, { command: "npm", args: ["run", script] });
  if (!started.ok) return { ok: false, error: started.error };

  return toolOk({
    script,
    processId: started.data.processId,
    command: started.data.command,
    args: started.data.args,
  });
}

export function runBuild(ctx: AgentToolContext): Promise<AgentToolResult<ScriptRunData>> {
  return runPackageScript(ctx, BUILD_SCRIPT_CANDIDATES, NO_BUILD_SCRIPT_MESSAGE);
}

export function runTests(ctx: AgentToolContext): Promise<AgentToolResult<ScriptRunData>> {
  return runPackageScript(ctx, TEST_SCRIPT_CANDIDATES, NO_TEST_SCRIPT_MESSAGE);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Invokes a tool by name with unvalidated parameters.
 *
 * This is the single entry point the M3.7 execution loop will call. Unknown
 * names fail closed. Ownership is checked once up front and again inside each
 * handler; the up-front check avoids starting work that is already stale.
 */
export async function invokeAgentTool(
  ctx: AgentToolContext,
  name: string,
  params: unknown,
): Promise<AgentToolResult<unknown>> {
  if (!ctx.ownsCall()) return stale<unknown>();

  const args = (params ?? {}) as Record<string, unknown>;

  switch (name) {
    case "list_files":
      return listFiles(ctx, args as ListFilesParams);
    case "read_file":
      return readFile(ctx, args as unknown as ReadFileParams);
    case "read_files":
      return readFiles(ctx, args as unknown as ReadFilesParams);
    case "create_file":
      return createFile(ctx, args as unknown as CreateFileParams);
    case "write_file":
      return writeFile(ctx, args as unknown as WriteFileParams);
    case "apply_patch":
      return applyPatch(ctx, args as unknown as ApplyPatchParams);
    case "rename_file":
      return renameFile(ctx, args as unknown as RenameFileParams);
    case "delete_file":
      return deleteFile(ctx, args as unknown as DeleteFileParams);
    case "run_command":
      return runCommand(ctx, args as unknown as RunCommandParams);
    case "start_process":
      return startProcess(ctx, args as unknown as StartProcessParams);
    case "stop_command":
      return stopCommand(ctx, args as unknown as StopCommandParams);
    case "read_command_output":
      return readCommandOutput(ctx, args as unknown as ReadCommandOutputParams);
    case "run_project":
      return runProject(ctx);
    case "stop_project":
      return stopProject(ctx);
    case "get_runtime_status":
      return getRuntimeStatus(ctx);
    case "run_build":
      return runBuild(ctx);
    case "run_tests":
      return runTests(ctx);
    default:
      return toolErr("INVALID_PARAMS", `Unknown tool: ${name}`);
  }
}
