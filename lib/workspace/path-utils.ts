/**
 * Pure path utilities for CoderXP M2 Workspace Alpha.
 *
 * All workspace file paths are relative to the project root and use
 * "/" as the sole separator. These functions normalise, validate, and
 * manipulate paths without touching IndexedDB or any browser API.
 *
 * Binding rules:
 * - "/" is the only separator.
 * - Windows-style "\" is converted to "/" before validation.
 * - Absolute paths, drive-letter paths, and URL-like paths are rejected.
 * - "." and ".." segments are rejected.
 * - Null bytes and control characters in entry names are rejected.
 * - Leading and trailing "/" are rejected (paths are relative, not absolute).
 * - Case is preserved; source-code paths are never lowercased.
 */

import { PersistenceError } from "./types";

/** Maximum total path length in characters. */
export const MAX_PATH_LENGTH = 1024;

/** Maximum length of a single path segment. */
export const MAX_SEGMENT_LENGTH = 255;

/** The workspace path separator. */
export const PATH_SEPARATOR = "/";

/** Pattern matching drive-letter prefixes (e.g. C:, D:\). */
const DRIVE_LETTER_RE = /^[a-zA-Z]:/;

/** Pattern matching URI-scheme prefixes (e.g. https:, file:, data:). */
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Pattern matching null bytes. */
const NULL_BYTE_RE = /\0/;

/** Pattern matching control characters (U+0000–U+001F, U+007F). */
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

/**
 * Normalise a workspace path: convert "\" separators to "/" only.
 *
 * Does NOT strip leading/trailing separators, collapse repeated
 * separators, or resolve "."/".." — those are rejected by
 * validateWorkspacePath. Returns the converted string; does not throw.
 */
export function normalizeWorkspacePath(rawPath: string): string {
  return rawPath.replace(/\\/g, PATH_SEPARATOR);
}

/**
 * Validate a normalised workspace path. Throws a PersistenceError
 * with code INVALID_PATH if the path violates any binding rule.
 *
 * Call normalizeWorkspacePath() first, then pass the result here.
 */
export function validateWorkspacePath(path: string): void {
  if (typeof path !== "string") {
    throw new PersistenceError("INVALID_PATH", "Path must be a string.");
  }

  if (path.length === 0) {
    throw new PersistenceError("INVALID_PATH", "Path must not be empty.");
  }

  if (NULL_BYTE_RE.test(path)) {
    throw new PersistenceError("INVALID_PATH", "Path must not contain null bytes.");
  }

  // Reject absolute paths (leading "/").
  if (path.startsWith(PATH_SEPARATOR)) {
    throw new PersistenceError("INVALID_PATH", "Path must not be absolute.");
  }

  // Reject trailing "/".
  if (path.endsWith(PATH_SEPARATOR)) {
    throw new PersistenceError("INVALID_PATH", "Path must not end with a separator.");
  }

  // Reject drive-letter paths.
  if (DRIVE_LETTER_RE.test(path)) {
    throw new PersistenceError("INVALID_PATH", "Path must not contain a drive letter.");
  }

  // Reject URI-scheme paths (after drive-letter check).
  if (URI_SCHEME_RE.test(path)) {
    throw new PersistenceError("INVALID_PATH", "Path must not be a URL.");
  }

  if (path.length > MAX_PATH_LENGTH) {
    throw new PersistenceError(
      "INVALID_PATH",
      `Path exceeds maximum length of ${MAX_PATH_LENGTH} characters.`,
    );
  }

  const segments = path.split(PATH_SEPARATOR);

  for (const segment of segments) {
    if (segment.length === 0) {
      throw new PersistenceError("INVALID_PATH", "Path must not contain empty segments.");
    }

    if (segment === "." || segment === "..") {
      throw new PersistenceError("INVALID_PATH", `Path must not contain "${segment}" segments.`);
    }

    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new PersistenceError(
        "INVALID_PATH",
        `Path segment exceeds maximum length of ${MAX_SEGMENT_LENGTH} characters.`,
      );
    }

    if (CONTROL_CHAR_RE.test(segment)) {
      throw new PersistenceError("INVALID_PATH", "Path segment must not contain control characters.");
    }
  }
}

/**
 * Normalise and validate in one step. Returns the normalised path
 * or throws INVALID_PATH.
 *
 * Confirms the value is a string before calling string methods.
 * Converts "\" to "/". Validates the converted but otherwise
 * unrepaired value. Returns it only when already canonical.
 */
export function normalizeAndValidateWorkspacePath(rawPath: string): string {
  if (typeof rawPath !== "string") {
    throw new PersistenceError("INVALID_PATH", "Path must be a string.");
  }

  const normalised = normalizeWorkspacePath(rawPath);
  validateWorkspacePath(normalised);
  return normalised;
}

/**
 * Returns true when `childPath` is a descendant of `parentPath`.
 * A path is a descendant when it starts with `parentPath + "/"`.
 * A path is NOT a descendant of itself.
 *
 * Both paths must already be normalised.
 */
export function isDescendantPath(parentPath: string, childPath: string): boolean {
  if (parentPath === childPath) return false;
  return childPath.startsWith(parentPath + PATH_SEPARATOR);
}

/**
 * Replace the path prefix `oldPrefix` with `newPrefix` on `path`.
 * If `path` equals `oldPrefix`, it is replaced entirely.
 * If `path` is a descendant of `oldPrefix`, the prefix is swapped.
 * Otherwise the path is returned unchanged.
 *
 * All paths must already be normalised.
 */
export function replacePathPrefix(
  path: string,
  oldPrefix: string,
  newPrefix: string,
): string {
  if (path === oldPrefix) {
    return newPrefix;
  }

  if (isDescendantPath(oldPrefix, path)) {
    return newPrefix + PATH_SEPARATOR + path.slice(oldPrefix.length + 1);
  }

  return path;
}

/**
 * Return the parent path of `path`, or empty string if `path`
 * has no parent (i.e. it is a top-level entry).
 *
 * The path must already be normalised.
 */
export function getParentPath(path: string): string {
  const lastSep = path.lastIndexOf(PATH_SEPARATOR);
  if (lastSep === -1) return "";
  return path.slice(0, lastSep);
}

/**
 * Return the final entry name (last segment) of `path`.
 *
 * The path must already be normalised.
 */
export function getEntryName(path: string): string {
  const lastSep = path.lastIndexOf(PATH_SEPARATOR);
  if (lastSep === -1) return path;
  return path.slice(lastSep + 1);
}