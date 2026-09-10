/**
 * Project ZIP export for CoderXP M2 Workspace Alpha.
 *
 * Commit 7 scope: exports the authoritative IndexedDB project filesystem
 * as a real ZIP archive and triggers a local download.
 *
 * - Flushes all dirty editor buffers before reading files.
 * - Reads authoritative file entries from IndexedDB (not React snapshots).
 * - Generates a real ZIP using the pure-TS zip-writer (no JSZip).
 * - Preserves full directory structure and file paths.
 * - Excludes CoderXP internal metadata, IndexedDB records, runtime state.
 * - Sanitizes the download filename based on the project name.
 * - Truthful states only: Export, Exporting..., error.
 */

import { listProjectEntries } from "./persistence";
import { createZip, type ZipEntry } from "./zip-writer";
import type { WorkspaceProject, WorkspaceFileRecord } from "./types";

// ---------------------------------------------------------------------------
// Filename sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a project name into a safe download filename.
 *
 * Replaces characters that are invalid in filenames on Windows, macOS,
 * and Linux with underscores. Appends ".zip" if not already present.
 * Does NOT rename anything inside the project.
 */
export function sanitizeZipFilename(projectName: string): string {
  // Replace invalid filename characters: \ / : * ? " < > |
  const sanitized = projectName.replace(/[\\/:*?"<>|]/g, "_").trim();

  // Collapse multiple underscores.
  const collapsed = sanitized.replace(/_+/g, "_");

  // Fallback if the name was entirely invalid.
  const base = collapsed.length > 0 ? collapsed : "project";

  // Ensure .zip extension.
  return base.endsWith(".zip") ? base : `${base}.zip`;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Export the current project as a ZIP archive and trigger a download.
 *
 * Steps:
 * 1. await flushAll() — if it fails, export stops and dirty buffers remain.
 * 2. Read authoritative file entries from IndexedDB via listProjectEntries.
 * 3. Filter to file entries only (skip directory records).
 * 4. Build ZipEntry[] with UTF-8 encoded contents.
 * 5. Generate the ZIP via createZip().
 * 6. Create a Blob and trigger a download with the sanitized filename.
 *
 * @param projectId — The project to export.
 * @param flushAll — Function that flushes all dirty editor buffers. Must return
 *                   true on success, false on failure.
 * @returns A result object indicating success or failure with a message.
 */
export async function exportProjectZip(
  projectId: string,
  projectName: string,
  flushAll: () => Promise<boolean>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Step 1: Flush all dirty editor buffers.
  const flushOk = await flushAll();
  if (!flushOk) {
    return {
      ok: false,
      error: "Some files could not be saved. Export stopped. Your changes are preserved.",
    };
  }

  // Step 2: Read authoritative file entries from IndexedDB.
  let entries: WorkspaceFileRecord[];
  try {
    entries = await listProjectEntries(projectId);
  } catch {
    return {
      ok: false,
      error: "Failed to read project files from storage.",
    };
  }

  // Step 3: Filter to file entries only. Directory records are structural
  // metadata and do not need to appear in the ZIP (directories are implied
  // by file paths).
  const fileEntries = entries.filter((e) => e.kind === "file");

  if (fileEntries.length === 0) {
    return {
      ok: false,
      error: "Project has no files to export.",
    };
  }

  // Step 4: Build ZipEntry[] with UTF-8 encoded contents.
  const zipEntries: ZipEntry[] = fileEntries.map((entry) => ({
    path: entry.path,
    data: new TextEncoder().encode(entry.contents ?? ""),
    modTime: new Date(entry.updatedAt),
  }));

  // Step 5: Generate the ZIP.
  const zipData = createZip(zipEntries);

  // Step 6: Create a Blob and trigger a download.
  // Copy into a fresh ArrayBuffer to satisfy BlobPart typing.
  const ab = new ArrayBuffer(zipData.byteLength);
  new Uint8Array(ab).set(zipData);
  const blob = new Blob([ab], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const filename = sanitizeZipFilename(projectName);

  // Use a temporary anchor element to trigger the download.
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // Revoke the object URL after a short delay to ensure the download starts.
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return { ok: true };
}
