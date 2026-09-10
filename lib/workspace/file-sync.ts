/**
 * WebContainer -> IndexedDB filesystem sync for CoderXP M3.4.
 *
 * Additive persistence of project source files from the shared
 * WebContainer into IndexedDB:
 *
 *   container -> IndexedDB additions YES
 *   container -> IndexedDB updates YES
 *   missing container file -> IndexedDB deletion NO
 *
 * Generated/runtime directories are ignored (node_modules, .next, dist,
 * .git, etc.). Only project source files that belong in persistence.
 *
 * Each candidate file is read as raw bytes first so its size is known
 * before anything is decoded:
 *
 *   read Uint8Array -> over MAX_SYNC_TEXT_FILE_BYTES? skip
 *                   -> null byte present? skip (binary)
 *                   -> UTF-8 decode -> IndexedDB
 *
 * A skipped artifact is reported in FileSyncResult.skipped. It is not an
 * error and never aborts the sync pass.
 *
 * Uses existing persistence helpers (putEntry / listProjectEntries).
 * Uses the shared WebContainer singleton from runtime-client.
 * Does not boot a second container.
 */

import type { WebContainer } from "@webcontainer/api";
import { getBootedWebContainer } from "./runtime-client";
import { getRuntime } from "./runtime";
import { MAX_SYNC_TEXT_FILE_BYTES, WORKSPACE_PROJECT_ROOT } from "./constants";
import { listProjectEntries, putEntry } from "./persistence";
import { normalizeAndValidateWorkspacePath } from "./path-utils";

/** Directory names excluded from persistence (generated/runtime/VCS). */
export const FILE_SYNC_IGNORE_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".next",
  "dist",
  ".git",
  ".turbo",
  ".cache",
  ".vite",
  "coverage",
  "out",
  "build",
  ".vercel",
]);

/** A source file read from the WebContainer project tree. */
export interface ContainerSourceFile {
  /** Path relative to the project root. */
  path: string;
  /** UTF-8 file contents. */
  contents: string;
}

/** Result of a container -> IndexedDB sync pass. */
export interface FileSyncResult {
  /** New files written to IndexedDB. */
  added: number;
  /** Existing files whose contents changed. */
  updated: number;
  /** Existing files whose contents matched. */
  unchanged: number;
  /** Files skipped as oversized or binary. Not an error. */
  skipped: number;
}

/** Files skipped during a container walk, with the reason. */
export interface SkippedContainerFile {
  path: string;
  reason: "oversize" | "binary" | "unreadable";
}

/** A container walk: readable text files plus what was skipped. */
export interface ContainerScan {
  files: ContainerSourceFile[];
  skipped: SkippedContainerFile[];
}

interface DirEntLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

function isIgnoredDir(name: string): boolean {
  return FILE_SYNC_IGNORE_DIRS.has(name);
}

/**
 * Recursively scan source files under /project in the shared container.
 * Returns an empty scan when the runtime has no mounted project or the
 * singleton is not booted.
 */
export async function scanContainerSourceFiles(): Promise<ContainerScan> {
  const scan: ContainerScan = { files: [], skipped: [] };

  if (!getRuntime().isMounted()) {
    return scan;
  }

  const container = getBootedWebContainer();
  if (!container) {
    return scan;
  }

  await walkDir(container, WORKSPACE_PROJECT_ROOT, "", scan);
  return scan;
}

/** Text files only. Retained for callers that do not need skip details. */
export async function listContainerSourceFiles(): Promise<ContainerSourceFile[]> {
  const scan = await scanContainerSourceFiles();
  return scan.files;
}

/**
 * Reads one container file as bytes and decodes it only if it is within
 * the size limit and contains no null byte.
 */
async function readTextFileGuarded(
  container: WebContainer,
  absPath: string,
): Promise<{ contents: string } | { reason: SkippedContainerFile["reason"] }> {
  let bytes: Uint8Array;
  try {
    // No encoding argument: WebContainer returns raw bytes, so the size
    // is known before the artifact is decoded as text.
    bytes = await container.fs.readFile(absPath);
  } catch {
    return { reason: "unreadable" };
  }

  if (!(bytes instanceof Uint8Array)) {
    return { reason: "unreadable" };
  }

  if (bytes.byteLength > MAX_SYNC_TEXT_FILE_BYTES) {
    return { reason: "oversize" };
  }

  if (bytes.includes(0)) {
    return { reason: "binary" };
  }

  try {
    // fatal: invalid UTF-8 is treated as binary rather than persisted
    // with replacement characters.
    const contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { contents };
  } catch {
    return { reason: "binary" };
  }
}

async function walkDir(
  container: WebContainer,
  absDir: string,
  relDir: string,
  scan: ContainerScan,
): Promise<void> {
  let entries: unknown;
  try {
    entries = await container.fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  if (!Array.isArray(entries)) {
    return;
  }

  for (const entry of entries) {
    const name = direntName(entry);
    if (!name || name === "." || name === "..") continue;
    if (isIgnoredDir(name)) continue;

    const relPath = relDir ? `${relDir}/${name}` : name;
    const absPath = `${absDir}/${name}`;

    if (direntIsDirectory(entry)) {
      await walkDir(container, absPath, relPath, scan);
      continue;
    }

    const read = await readTextFileGuarded(container, absPath);
    if ("contents" in read) {
      scan.files.push({ path: relPath, contents: read.contents });
      continue;
    }
    // Oversized, binary, or unreadable: recorded, never fatal.
    scan.skipped.push({ path: relPath, reason: read.reason });
  }
}

function direntName(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && "name" in entry) {
    const name = (entry as DirEntLike).name;
    return typeof name === "string" ? name : null;
  }
  return null;
}

function direntIsDirectory(entry: unknown): boolean {
  if (entry && typeof entry === "object" && typeof (entry as DirEntLike).isDirectory === "function") {
    try {
      return (entry as DirEntLike).isDirectory();
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Ownership guard for a sync pass.
 *
 * Returns false once this pass no longer owns the active project — for
 * example after a project switch remounted the shared container. The pass
 * stops writing immediately. Losing ownership is not an error.
 */
export type SyncOwnershipGuard = () => boolean;

/** Default guard for callers that do not track ownership. */
const ALWAYS_OWNS: SyncOwnershipGuard = () => true;

/**
 * Sync source files from the shared WebContainer into IndexedDB.
 *
 * Additions and content updates are written via putEntry.
 * Files present in IndexedDB but missing from the container are left
 * untouched (no deletion).
 *
 * Oversized and binary artifacts are skipped and counted, not imported.
 *
 * Ownership is re-checked after the container scan, after the IndexedDB
 * read, and immediately before every putEntry. The container is a shared
 * singleton, so a project switch can remount /project while a scan is in
 * flight; without the pre-write checks, contents belonging to the newly
 * mounted project could be persisted under the previous projectId. Any
 * write performed before ownership was lost stands; no further write is
 * issued after it.
 */
export async function syncContainerToIndexedDB(
  projectId: string,
  ownsSync: SyncOwnershipGuard = ALWAYS_OWNS,
): Promise<FileSyncResult> {
  const scan = await scanContainerSourceFiles();

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = scan.skipped.length;

  // The scan may have observed a container that was remounted for another
  // project. Nothing has been written yet, so stop before persistence.
  if (!ownsSync()) {
    return { added, updated, unchanged, skipped };
  }

  const containerFiles = scan.files;
  const existing = await listProjectEntries(projectId);

  if (!ownsSync()) {
    return { added, updated, unchanged, skipped };
  }

  const existingFiles = new Map(
    existing.filter((e) => e.kind === "file").map((e) => [e.path, e.contents ?? ""]),
  );

  for (const file of containerFiles) {
    let normalised: string;
    try {
      normalised = normalizeAndValidateWorkspacePath(file.path);
    } catch {
      skipped += 1;
      continue;
    }

    const previous = existingFiles.get(normalised);

    if (previous === file.contents) {
      unchanged += 1;
      continue;
    }

    // Re-checked before every write, not once per pass: ownership can be
    // lost between two writes of the same pass.
    if (!ownsSync()) {
      return { added, updated, unchanged, skipped };
    }

    try {
      await putEntry(projectId, normalised, "file", file.contents);
      if (previous === undefined) {
        added += 1;
      } else {
        updated += 1;
      }
    } catch {
      // Persistence rejected this entry — counted, never fatal.
      skipped += 1;
    }
  }

  return { added, updated, unchanged, skipped };
}

/**
 * True when the active project is present in the shared WebContainer.
 * Preview/runtime may be idle; mounted state is what matters for sync.
 */
export function isProjectPresentInContainer(): boolean {
  return getRuntime().isMounted() && getBootedWebContainer() !== null;
}
