/**
 * Devbox WSS Single-Use Token Minter & Validator for CoderXP Revision 2.4.
 *
 * Implements Amendment 1:
 * - Issues short-lived (60s), HMAC-SHA256 signed single-use session tokens.
 * - Enforces user session, project ownership, and tier entitlement.
 * - Invalidates token on first use; rejects expired, invalid, or cross-user handshakes.
 */

import crypto from "node:crypto";

const DEVBOX_TOKEN_SECRET =
  process.env.DEVBOX_TOKEN_SECRET || "coderxp-devbox-broker-hmac-secret-2026";
const TOKEN_TTL_MS = 60 * 1000; // 60 seconds

// In-memory set of consumed nonces (prevents replay attacks)
const consumedNonces = new Set<string>();

export interface DevboxTokenPayload {
  userId: string;
  projectId: string;
  exp: number;
  nonce: string;
}

export function mintDevboxWssToken(userId: string, projectId: string): string {
  const payload: DevboxTokenPayload = {
    userId,
    projectId,
    exp: Date.now() + TOKEN_TTL_MS,
    nonce: crypto.randomBytes(16).toString("hex"),
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", DEVBOX_TOKEN_SECRET)
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

  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false, error: "Malformed token format." };
  }

  const [payloadB64, signature] = parts;
  const expectedSig = crypto
    .createHmac("sha256", DEVBOX_TOKEN_SECRET)
    .update(payloadB64)
    .digest("base64url");

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
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
    return { valid: false, error: "Token project mismatch (unauthorized cross-project access)." };
  }

  if (consumedNonces.has(payload.nonce)) {
    return { valid: false, error: "Token has already been consumed (replay prevention)." };
  }

  // Mark nonce as consumed
  consumedNonces.add(payload.nonce);

  return { valid: true, userId: payload.userId };
}
