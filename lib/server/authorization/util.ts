/**
 * Authorization slice (DRAFT) — small deterministic helpers.
 */

import crypto from "node:crypto";
import { AuthorizationError } from "./types";

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function validateId(value: unknown, field: string, operationId?: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new AuthorizationError(
      "MALFORMED_REQUEST",
      `${field} must match [A-Za-z0-9._-]{1,128}.`,
      400,
      operationId,
    );
  }
  return value;
}

/**
 * Deterministic JSON encoding (sorted keys, recursive) for approval arg binding.
 * `undefined`, functions, and symbols are rejected: bindings must be explicit.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number") {
    if (!Number.isFinite(value as number)) throw new Error("Non-finite number in bound args.");
    return JSON.stringify(value);
  }
  if (t === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (t === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  throw new Error("Unserializable value in bound args.");
}

export function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

export function argsHashFor(args: unknown): string {
  return sha256Hex(stableStringify(args ?? null));
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b)) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Lexical project-relative path validation. Rejects absolute paths, drive
 * prefixes, separators outside "/", ".", and ".." segments. This is the
 * authorization-layer check; symlink-race-resistant confinement during the
 * actual filesystem operation belongs to the workspace slice.
 */
export function normalizeResourcePath(value: unknown, operationId?: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new AuthorizationError("MALFORMED_REQUEST", "resource must be 1..1024 chars.", 400, operationId);
  }
  if (value.includes("\0") || value.includes("\\")) {
    throw new AuthorizationError("MALFORMED_REQUEST", "resource contains illegal characters.", 400, operationId);
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new AuthorizationError("MALFORMED_REQUEST", "resource must be project-relative.", 400, operationId);
  }
  const segments = value.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new AuthorizationError(
        "MALFORMED_REQUEST",
        "resource must not contain empty, '.', or '..' segments.",
        400,
        operationId,
      );
    }
  }
  return segments.join("/");
}

/**
 * Transport allowlist for external destinations. Permits https (no userinfo,
 * so no embedded credentials) and ssh/scp-style destinations with an optional
 * username but no password. Exact destinations are additionally gated by the
 * per-project allowlist in the server registry (default deny).
 */
export function validateDestinationTransport(value: unknown, operationId?: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\s\0]/.test(value)) {
    throw new AuthorizationError("MALFORMED_REQUEST", "destination is malformed.", 400, operationId);
  }
  if (value.startsWith("https://")) {
    const authority = value.slice("https://".length).split("/", 1)[0] ?? "";
    if (authority === "" || authority.includes("@")) {
      throw new AuthorizationError(
        "MALFORMED_REQUEST",
        "https destinations must not embed userinfo/credentials.",
        400,
        operationId,
      );
    }
    return value;
  }
  if (value.startsWith("ssh://")) {
    const authority = value.slice("ssh://".length).split("/", 1)[0] ?? "";
    const userinfo = authority.includes("@") ? (authority.split("@")[0] ?? "") : "";
    if (authority === "" || userinfo.includes(":")) {
      throw new AuthorizationError("MALFORMED_REQUEST", "ssh destinations must not embed passwords.", 400, operationId);
    }
    return value;
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.+$/.test(value)) {
    return value;
  }
  throw new AuthorizationError(
    "MALFORMED_REQUEST",
    "destination transport not allowed (https without userinfo, or ssh/scp-style without password).",
    400,
    operationId,
  );
}
