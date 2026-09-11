/**
 * Application-Level Authentication & Session Management for CoderXP.
 *
 * Hardened:
 * - No hardcoded signing secrets or bootstrap password fallbacks.
 * - Explicit configuration required; missing/invalid credentials fail closed.
 * - Separately configured session signing secret (AUTH_SESSION_SECRET only).
 * - Admin credential source precedence is defined and fails closed.
 * - Sessions carry a credential generation; password change invalidates prior sessions.
 * - Password changes are serialized in-process and revalidate generation before commit.
 * - Constant-time password verification (PBKDF2-SHA512).
 * - Multi-transport session verification (cookie, Bearer, x-coderxp-session).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

const SESSION_COOKIE_NAME = "__Host-coderxp_session";
const LEGACY_SESSION_COOKIE_NAME = "coderxp_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

function resolveSessionSecret(): string {
  const secret = (process.env.AUTH_SESSION_SECRET || "").trim();
  if (!secret) {
    throw new Error(
      "AUTH_SESSION_SECRET is required and must be set to a strong random value (min 32 characters). No default secret is allowed.",
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `AUTH_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters. No default secret is allowed.`,
    );
  }
  return secret;
}

let _sessionSecret: string | null = null;
function getSessionSecret(): string {
  if (_sessionSecret === null) {
    _sessionSecret = resolveSessionSecret();
  }
  return _sessionSecret;
}

export function __resetAuthSecretCacheForTests(): void {
  _sessionSecret = null;
  _credentialState = null;
  _passwordChangeTail = Promise.resolve();
  _failNextPasswordPersist = false;
}

export const AUTH_PASSWORD_FILE =
  process.env.AUTH_PASSWORD_FILE ||
  (process.platform === "win32"
    ? path.join(process.cwd(), ".data", "auth-admin-hash.txt")
    : "/opt/coderxp/data/auth-admin-hash.txt");

interface CredentialState {
  passwordHash: string;
  generation: number;
}

let _credentialState: CredentialState | null = null;

/** Serializes overlapping password-change transactions in this process. */
let _passwordChangeTail: Promise<void> = Promise.resolve();
let _failNextPasswordPersist = false;

export class StaleCredentialChangeError extends Error {
  readonly code = "STALE_CREDENTIAL_CHANGE" as const;
  constructor(
    message = "Stale password change rejected: credential generation has changed.",
  ) {
    super(message);
    this.name = "StaleCredentialChangeError";
  }
}

export interface PasswordChangeClaim {
  currentPassword: string;
  expectedGeneration: number;
}

/**
 * Test-only: next persist attempt inside the password-change transaction fails
 * before writing. Does not modify an already-successful password file.
 */
export function __failNextPasswordPersistForTests(): void {
  _failNextPasswordPersist = true;
}

function withPasswordChangeLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = _passwordChangeTail.then(
    () => fn(),
    () => fn(),
  );
  _passwordChangeTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function parsePasswordFileContent(content: string): CredentialState | null {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const hash = lines[0];
  if (!hash.startsWith("pbkdf2$100000$")) return null;
  let generation = 1;
  if (lines[1] && /^\d+$/.test(lines[1])) {
    generation = parseInt(lines[1], 10);
  }
  return { passwordHash: hash, generation };
}

/**
 * Credential source precedence (fail closed):
 * 1. If AUTH_PASSWORD_FILE exists on disk:
 *    - Valid pbkdf2 hash (+ optional generation) -> use it.
 *    - Exists but unreadable or malformed -> configuration failure.
 *      Do NOT fall through to AUTH_ADMIN_PASSWORD (avoids silent downgrade).
 * 2. Else if AUTH_ADMIN_PASSWORD is set (plaintext or pbkdf2 hash) -> use it
 *    (and attempt to persist a hash file for durable generation tracking).
 * 3. Else -> configuration failure. No built-in defaults.
 */
function loadCredentialState(): CredentialState {
  const fileExists = fs.existsSync(AUTH_PASSWORD_FILE);

  if (fileExists) {
    let content: string;
    try {
      content = fs.readFileSync(AUTH_PASSWORD_FILE, "utf8");
    } catch {
      throw new Error(
        `AUTH_PASSWORD_FILE exists but is unreadable (${AUTH_PASSWORD_FILE}). Refusing to fall back to environment credentials.`,
      );
    }
    const parsed = parsePasswordFileContent(content);
    if (!parsed) {
      throw new Error(
        `AUTH_PASSWORD_FILE exists but does not contain a valid pbkdf2$100000$... hash (${AUTH_PASSWORD_FILE}). Refusing to fall back to environment credentials.`,
      );
    }
    return parsed;
  }

  const envPass = (process.env.AUTH_ADMIN_PASSWORD || "").trim();
  if (envPass.startsWith("pbkdf2$100000$")) {
    return { passwordHash: envPass, generation: 1 };
  }
  if (envPass.length > 0) {
    const hashed = hashPassword(envPass);
    const state: CredentialState = { passwordHash: hashed, generation: 1 };
    tryPersistCredentials(state);
    return state;
  }

  throw new Error(
    "Admin credentials are not configured. Set AUTH_ADMIN_PASSWORD (plaintext or pbkdf2 hash) or provision AUTH_PASSWORD_FILE with a valid pbkdf2$100000$... hash. No default credentials are allowed.",
  );
}

function getCredentialState(): CredentialState {
  if (_credentialState === null) {
    _credentialState = loadCredentialState();
  }
  return _credentialState;
}

function tryPersistCredentials(state: CredentialState): void {
  try {
    const dir = path.dirname(AUTH_PASSWORD_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const body = `${state.passwordHash}\n${state.generation}\n`;
    const tmp = `${AUTH_PASSWORD_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, AUTH_PASSWORD_FILE);
  } catch {
    // callers requiring durability handle failure
  }
}

export function loadPersistedAdminPassword(): string {
  return getCredentialState().passwordHash;
}

export function getCredentialGeneration(): number {
  return getCredentialState().generation;
}

export const ADMIN_CONFIG = {
  userId: "coderxpadmin",
  email: process.env.AUTH_ADMIN_EMAIL || "paul@coderxp.pro",
  username: "coderxpadmin",
  get password(): string {
    return getCredentialState().passwordHash;
  },
  set password(val: string) {
    const state = getCredentialState();
    state.passwordHash = val;
  },
};

export interface SessionPayload {
  userId: string;
  email: string;
  role: "admin" | "user";
  createdAt: number;
  expiresAt: number;
  nonce: string;
  credentialGeneration: number;
}

export function createSessionToken(userId: string, email: string): string {
  const secret = getSessionSecret();
  const now = Date.now();
  const generation = getCredentialGeneration();
  const payload: SessionPayload = {
    userId,
    email,
    role: "admin",
    createdAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
    nonce: crypto.randomBytes(16).toString("hex"),
    credentialGeneration: generation,
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");

  return `${payloadB64}.${signature}`;
}

export function verifySessionToken(token: string): {
  valid: boolean;
  payload?: SessionPayload;
  error?: string;
} {
  if (!token || typeof token !== "string") {
    return { valid: false, error: "Missing session token." };
  }

  let secret: string;
  try {
    secret = getSessionSecret();
  } catch (err: unknown) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Session secret not configured.",
    };
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false, error: "Malformed session token." };
  }

  const [payloadB64, signature] = parts;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSig);

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    return { valid: false, error: "Invalid session signature." };
  }

  try {
    const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf8");
    const payload: SessionPayload = JSON.parse(payloadJson);

    if (typeof payload.expiresAt !== "number" || Date.now() > payload.expiresAt) {
      return { valid: false, error: "Session token expired." };
    }

    if (
      typeof payload.credentialGeneration !== "number" ||
      payload.credentialGeneration !== getCredentialGeneration()
    ) {
      return { valid: false, error: "Session invalidated by credential change." };
    }

    if (!payload.userId || !payload.email) {
      return { valid: false, error: "Invalid session claims." };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false, error: "Invalid session payload JSON." };
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const iterations = 100000;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 64, "sha512").toString("hex");
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}

export function verifyPassword(passwordAttempt: string, storedHash: string): boolean {
  if (!passwordAttempt || !storedHash) return false;
  if (!storedHash.startsWith("pbkdf2$100000$")) return false;
  const parts = storedHash.split("$");
  if (parts.length !== 4) return false;
  const iterations = parseInt(parts[1], 10);
  const salt = parts[2];
  const expectedHash = parts[3];
  const derived = crypto.pbkdf2Sync(passwordAttempt, salt, iterations, 64, "sha512").toString("hex");
  const derivedBuf = Buffer.from(derived, "hex");
  const expectedBuf = Buffer.from(expectedHash, "hex");
  if (derivedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(derivedBuf, expectedBuf);
}

export async function updateAdminPassword(
  newPasswordPlaintext: string,
  claim: PasswordChangeClaim,
): Promise<string> {
  if (!newPasswordPlaintext || newPasswordPlaintext.length < 8) {
    throw new Error("New password must be at least 8 characters.");
  }
  if (
    !claim ||
    typeof claim.expectedGeneration !== "number" ||
    !Number.isInteger(claim.expectedGeneration) ||
    typeof claim.currentPassword !== "string" ||
    claim.currentPassword.length === 0
  ) {
    throw new Error(
      "Password change requires currentPassword and expectedGeneration.",
    );
  }

  return withPasswordChangeLock(() =>
    applyAdminPasswordChange(newPasswordPlaintext, claim),
  );
}

/**
 * Sole credential-change transaction. Must run under withPasswordChangeLock.
 * Revalidates generation and current password against the active credential
 * before hashing, persisting, verifying the file, and activating.
 */
function applyAdminPasswordChange(
  newPasswordPlaintext: string,
  claim: PasswordChangeClaim,
): string {
  const current = getCredentialState();
  if (current.generation !== claim.expectedGeneration) {
    throw new StaleCredentialChangeError();
  }
  if (!verifyPassword(claim.currentPassword, current.passwordHash)) {
    throw new Error("Current password does not match.");
  }

  const next: CredentialState = {
    passwordHash: hashPassword(newPasswordPlaintext),
    generation: current.generation + 1,
  };

  persistCredentialsStrict(next);

  try {
    const readBack = fs.readFileSync(AUTH_PASSWORD_FILE, "utf8");
    const parsed = parsePasswordFileContent(readBack);
    if (
      !parsed ||
      parsed.passwordHash !== next.passwordHash ||
      parsed.generation !== next.generation
    ) {
      throw new Error(
        "Failed to verify persisted password hash. Password was not activated.",
      );
    }
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("Failed to verify persisted password hash")
    ) {
      throw err;
    }
    throw new Error(
      "Failed to verify persisted password hash. Password was not activated.",
    );
  }

  _credentialState = next;
  return next.passwordHash;
}

function persistCredentialsStrict(state: CredentialState): void {
  if (_failNextPasswordPersist) {
    _failNextPasswordPersist = false;
    throw new Error(
      "Failed to persist new password hash. Password was not changed.",
    );
  }

  const dir = path.dirname(AUTH_PASSWORD_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const body = `${state.passwordHash}\n${state.generation}\n`;
  const tmp = `${AUTH_PASSWORD_FILE}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, AUTH_PASSWORD_FILE);
  } catch {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw new Error(
      "Failed to persist new password hash. Password was not changed.",
    );
  }
}

export function verifyAdminCredentials(
  identifier: string,
  passwordAttempt: string,
): boolean {
  if (!identifier || !passwordAttempt) return false;

  let state: CredentialState;
  try {
    state = getCredentialState();
  } catch {
    return false;
  }

  const cleanId = identifier.trim().toLowerCase();
  const validId =
    cleanId === ADMIN_CONFIG.email.toLowerCase() ||
    cleanId === ADMIN_CONFIG.username.toLowerCase() ||
    cleanId === ADMIN_CONFIG.userId.toLowerCase();

  if (!validId) return false;

  return verifyPassword(passwordAttempt, state.passwordHash);
}

export function validateRequestAuth(req: Request | NextRequest): {
  authenticated: boolean;
  userId?: string;
  email?: string;
  error?: string;
} {
  let token = "";

  if ("cookies" in req && typeof (req as NextRequest).cookies?.get === "function") {
    const cookie =
      (req as NextRequest).cookies.get(SESSION_COOKIE_NAME) ||
      (req as NextRequest).cookies.get(LEGACY_SESSION_COOKIE_NAME);
    if (cookie?.value) {
      token = cookie.value;
    }
  }

  if (!token) {
    const cookieHeader = req.headers.get("cookie") || "";
    const match =
      cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`)) ||
      cookieHeader.match(new RegExp(`(?:^|;\\s*)${LEGACY_SESSION_COOKIE_NAME}=([^;]+)`));
    if (match) {
      token = decodeURIComponent(match[1]);
    }
  }

  if (!token) {
    const authHeader = req.headers.get("authorization") || "";
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    }
  }

  if (!token) {
    token = req.headers.get("x-coderxp-session") || "";
  }

  if (!token) {
    return { authenticated: false, error: "Authentication required." };
  }

  const result = verifySessionToken(token);
  if (!result.valid || !result.payload) {
    return { authenticated: false, error: result.error || "Invalid session." };
  }

  return {
    authenticated: true,
    userId: result.payload.userId,
    email: result.payload.email,
  };
}

export { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS };
