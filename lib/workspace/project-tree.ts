/**
 * Hierarchical file-tree builder for CoderXP M2 Workspace Alpha.
 *
 * Final correction (fix(workspace): close final lifecycle races):
 * Rebuilt around precomputed canonical node kinds.
 *
 * The tree is derived from stored WorkspaceFileRecord paths, not from
 * template constants. Implicit visual parent folders may be derived
 * when necessary, but are distinguishable internally from persisted
 * entries (isPersisted = false for implicit directories).
 *
 * Rules:
 * - Directories before files within each parent.
 * - Stable alphabetical ordering using direct string comparison (not locale).
 * - Correct segment-boundary nesting.
 * - No path mutation.
 * - No invented implicit records stored in IndexedDB.
 * - Deterministic regardless of input record order.
 * - Exactly one node per path in a Map<string, FileTreeNode>.
 * - A path required as a parent by any descendant must be a directory node.
 * - A persisted directory record also makes the path a directory.
 * - Otherwise, a persisted file may occupy the path.
 * - A conflicting file at a path that must be a directory is defensively
 *   omitted from the visual tree.
 * - A file node must never have children.
 * - Duplicate records must not depend on original array order.
 * - Identical serialized output for every permutation of the same records.
 */

import type { WorkspaceFileRecord } from "./types";

/** A node in the hierarchical file tree. */
export interface FileTreeNode {
  /** Display name (last path segment). */
  name: string;
  /** Full path relative to project root. */
  path: string;
  /** Whether this node is a file or directory. */
  kind: "file" | "directory";
  /** Whether this entry was persisted in IndexedDB (true) or derived as an implicit visual parent (false). */
  isPersisted: boolean;
  /** Child nodes (directories first, then files, alphabetically sorted). */
  children: FileTreeNode[];
}

/**
 * Fixed path comparator using direct string comparison (not locale-dependent).
 * Produces a deterministic ordering regardless of the runtime locale.
 */
function comparePaths(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Comparator for deterministic depth-then-string ordering of paths.
 * Shorter paths (shallower) come first so parents are processed before
 * children. Ties broken by direct string comparison.
 */
function compareDepthThenPath(a: string, b: string): number {
  const depthA = a.split("/").length;
  const depthB = b.split("/").length;
  if (depthA !== depthB) return depthA - depthB;
  return comparePaths(a, b);
}

/**
 * Build a hierarchical file tree from persisted file records.
 *
 * Precomputes one canonical node kind per path before building the
 * hierarchy. This guarantees deterministic output regardless of input
 * record order.
 *
 * Canonical kind policy:
 * 1. A path required as a parent by any descendant must be a directory.
 * 2. A persisted directory record also makes the path a directory.
 * 3. Otherwise, a persisted file may occupy the path.
 * 4. A conflicting file at a path that must be a directory is defensively
 *    omitted from the visual tree.
 * 5. A file node must never have children.
 * 6. Duplicate records (same path, same kind) produce identical output.
 *
 * Build paths are processed in deterministic depth-then-string order.
 */
export function buildFileTree(entries: WorkspaceFileRecord[]): FileTreeNode[] {
  // --- Phase 1: Precompute canonical node kind per path ---

  // Collect all paths that are required as parent directories.
  const parentPaths = new Set<string>();
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let i = 1; i < segments.length; i++) {
      parentPaths.add(segments.slice(0, i).join("/"));
    }
  }

  // Collect persisted directory paths.
  const persistedDirPaths = new Set<string>();
  // Collect persisted file paths (first one wins for duplicates).
  const persistedFilePaths = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "directory") {
      persistedDirPaths.add(entry.path);
    } else {
      persistedFilePaths.add(entry.path);
    }
  }

  // Compute canonical kind for every path.
  // A path is a directory if:
  //   - it is required as a parent by any descendant, OR
  //   - it is a persisted directory.
  // A path is a file if:
  //   - it is a persisted file AND not required as a parent AND not a persisted directory.
  // A conflicting file at a path that must be a directory is omitted.
  const canonicalKind = new Map<string, "file" | "directory">();
  const allPaths = new Set<string>([...parentPaths, ...persistedDirPaths, ...persistedFilePaths]);

  for (const path of allPaths) {
    if (parentPaths.has(path) || persistedDirPaths.has(path)) {
      canonicalKind.set(path, "directory");
    } else {
      canonicalKind.set(path, "file");
    }
  }

  // --- Phase 2: Build the tree from canonical kinds ---

  // Process paths in deterministic depth-then-string order.
  const sortedPaths = [...allPaths].sort(compareDepthThenPath);

  // Single map: exactly one node per path.
  const nodeMap = new Map<string, FileTreeNode>();

  // Root node (not in the map; its children are the top-level nodes).
  const root: FileTreeNode = {
    name: "",
    path: "",
    kind: "directory",
    isPersisted: true,
    children: [],
  };

  for (const path of sortedPaths) {
    const kind = canonicalKind.get(path)!;
    const segments = path.split("/");
    const name = segments[segments.length - 1];

    // Determine if this node is persisted.
    const isPersisted =
      kind === "directory"
        ? persistedDirPaths.has(path)
        : persistedFilePaths.has(path);

    const node: FileTreeNode = {
      name,
      path,
      kind,
      isPersisted,
      children: [],
    };
    nodeMap.set(path, node);

    // Attach to parent.
    if (segments.length === 1) {
      root.children.push(node);
    } else {
      const parentPath = segments.slice(0, -1).join("/");
      const parent = nodeMap.get(parentPath);
      if (parent) {
        parent.children.push(node);
      } else {
        // Parent should exist because we process in depth order.
        // Defensive: attach to root if parent is somehow missing.
        root.children.push(node);
      }
    }
  }

  // Sort the tree recursively: directories first, then files, alphabetical.
  sortTree(root);

  return root.children;
}

/**
 * Recursively sort tree nodes: directories before files, alphabetical
 * within each group using direct string comparison (not locale-dependent).
 * Mutates the children arrays in place.
 */
function sortTree(node: FileTreeNode): void {
  node.children.sort((a, b) => {
    // Directories before files.
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    // Alphabetical by name using direct string comparison.
    return comparePaths(a.name, b.name);
  });

  for (const child of node.children) {
    sortTree(child);
  }
}
