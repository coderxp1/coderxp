/**
 * Devbox WSS Single-Use Token Minter & Validator for CoderXP.
 *
 * Hardened:
 * - Requires explicit DEVBOX_TOKEN_SECRET (no hardcoded fallback).
 * - Does not reuse AUTH_SESSION_SECRET.
 * - Issues short-lived (60s), HMAC-SHA256 signed single-use session tokens.
 * - Invalidates token on first use; rejects expired, invalid, or cross-project handshakes.
 */

import crypto from "node:crypto";

const MIN_SECRET_LENGTH = 32;
const TOKEN_TTL_MS = 60 * 1000;

function resolveDevboxTokenSecret(): string {
  const secret = (process.env.DEVBOX_TOKEN_SECRET || "").trim();
  if (!secret) {
    throw new Error(
      "DEVBOX_TOKEN_SECRET is required and must be set to a strong random value (min 32 characters). No default secret is allowed.",
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `DEVBOX_TOKEN_SECRET must be at least ${MIN_SECRET_LENGTH} characters. No default secret is allowed.`,
    );
  }
  return secret;
}

let _devboxSecret: string | null = null;
function getDevboxTokenSecret(): string {
  if (_devboxSecret === null) {
    _devboxSecret = resolveDevboxTokenSecret();
  }
  return _devboxSecret;
}

export function __resetDevboxTokenSecretCacheForTests(): void {
  _devboxSecret = null;
}

const consumedNonces = new Set<string>();

export interface DevboxTokenPayload {
  userId: string;
  projectId: string;
  exp: number;
  nonce: string;
}

export function mintDevboxWssToken(userId: string, projectId: string): string {
  const secret = getDevboxTokenSecret();
  const payload: DevboxTokenPayload = {
    userId,
    projectId,
    exp: Date.now() + TOKEN_TTL_MS,
    nonce: crypto.randomBytes(16).toString("hex"),
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");

  return `${payloadB64}.${signature}`;
}

export function verifyDevboxWssToken(
  token: string,
  expectedProjectId: string,
): { valid: boolean; userId?: string; error?: string } {
  if (!token || typeof token !== "string") {
    return { valid: false, error: "Missing token." };
  }

  let secret: string;
  try {
    secret = getDevboxTokenSecret();
  } catch (err: unknown) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Devbox token secret not configured.",
    };
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false, error: "Malformed token format." };
  }

  const [payloadB64, signature] = parts;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSig);
  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return { valid: false, error: "Invalid token signature." };
  }

  let payload: DevboxTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { valid: false, error: "Invalid token JSON payload." };
  }

  if (Date.now() > payload.exp) {
    return { valid: false, error: "Token has expired." };
  }

  if (payload.projectId !== expectedProjectId) {
    return {
      valid: false,
      error: "Token project mismatch (unauthorized cross-project access).",
    };
  }

  if (consumedNonces.has(payload.nonce)) {
    return { valid: false, error: "Token has already been consumed (replay prevention)." };
  }

  consumedNonces.add(payload.nonce);

  return { valid: true, userId: payload.userId };
}
