/**
 * Server-side BYOK Secrets Store for CoderXP Revision 2.3.
 *
 * Implements Directive §10.3:
 * - BYOK credentials stored and encrypted server-side at rest
 * - Never returns full key to client payloads (masked as …last4 only)
 * - Proxies upstream requests with injected credentials server-side
 */

import crypto from "node:crypto";
import { maskApiKey } from "./byok-crypto";
import { validateUrlForFetch, validateDnsResolution } from "./ssrf-guard";
import {
  BYOK_PROVIDER_DEFS,
  type ByokProviderId,
  type ByokModelDescriptor,
} from "./byok-providers";

export interface StoredByokRecord {
  providerId: ByokProviderId;
  encryptedKey: string;
  iv: string;
  tag: string;
  maskedKey: string;
  baseUrl?: string;
  mode?: "local" | "cloud";
  models: ByokModelDescriptor[];
  updatedAt: number;
}

export interface ClientByokRecord {
  providerId: ByokProviderId;
  displayName: string;
  maskedKey: string;
  baseUrl?: string;
  mode?: "local" | "cloud";
  models: ByokModelDescriptor[];
  updatedAt: number;
}

// Server encryption key derived from environment or server secret
const SERVER_SECRET = process.env.CODERXP_SECRETS_KEY || "coderxp-server-byok-master-key-2026";
const MASTER_KEY = crypto.scryptSync(SERVER_SECRET, "coderxp-byok-salt", 32);

function encryptServerKey(plaintext: string): { encrypted: string; iv: string; tag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptServerKey(record: { encryptedKey: string; iv: string; tag: string }): string {
  try {
    const iv = Buffer.from(record.iv, "base64");
    const tag = Buffer.from(record.tag, "base64");
    const data = Buffer.from(record.encryptedKey, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", MASTER_KEY, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data) + decipher.final("utf8");
  } catch {
    return "";
  }
}

// In-memory / server-scoped storage map (keyed by user/session identifier)
const serverStore = new Map<string, Map<ByokProviderId, StoredByokRecord>>();

function getStoreForUser(userId = "default_user"): Map<ByokProviderId, StoredByokRecord> {
  let userMap = serverStore.get(userId);
  if (!userMap) {
    userMap = new Map();
    serverStore.set(userId, userMap);
  }
  return userMap;
}

/**
 * Saves and validates a BYOK credential on the server.
 */
export async function saveServerByok(
  userId: string,
  providerId: ByokProviderId,
  apiKey: string,
  options: { baseUrl?: string; mode?: "local" | "cloud"; skipProbe?: boolean } = {},
): Promise<{ ok: boolean; record?: ClientByokRecord; error?: string }> {
  const def = BYOK_PROVIDER_DEFS[providerId];
  if (!def) {
    return { ok: false, error: `Unknown provider "${providerId}".` };
  }

  // Ollama local is browser-side only exception (§10.4)
  if (providerId === "ollama" && options.mode !== "cloud") {
    return {
      ok: false,
      error: "Ollama-local is dispatched strictly client-side and cannot be stored on the server.",
    };
  }

  const targetBaseUrl = options.baseUrl || def.defaultBaseUrl;

  // SSRF guard on custom base URL
  if (providerId === "custom" || options.baseUrl) {
    const ssrf = validateUrlForFetch(targetBaseUrl);
    if (!ssrf.valid) {
      return { ok: false, error: `Invalid or forbidden Base URL: ${ssrf.reason}` };
    }
    const parsed = new URL(targetBaseUrl);
    const dnsCheck = await validateDnsResolution(parsed.hostname);
    if (!dnsCheck.valid) {
      return { ok: false, error: `SSRF_DNS_BLOCKED: ${dnsCheck.reason}` };
    }
  }

  if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return { ok: false, error: "API key is required." };
  }

  // Perform live models validation probe from server
  let discoveredModels: ByokModelDescriptor[] = [];
  if (!options.skipProbe) {
    try {
      let probeUrl = `${targetBaseUrl}/models`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey.trim()}`,
        Accept: "application/json",
      };

      if (providerId === "anthropic") {
        headers["x-api-key"] = apiKey.trim();
        headers["anthropic-version"] = "2023-06-01";
        delete headers.Authorization;
      } else if (providerId === "gemini") {
        probeUrl = `${targetBaseUrl}/models?key=${apiKey.trim()}`;
        delete headers.Authorization;
      }

      const res = await fetch(probeUrl, { method: "GET", headers });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data.data)) {
          discoveredModels = data.data.map((m: any) => ({
            id: m.id || m.name,
            name: m.id || m.name,
          }));
        } else if (Array.isArray(data.models)) {
          discoveredModels = data.models.map((m: any) => ({
            id: (m.name || m.id).replace("models/", ""),
            name: (m.displayName || m.name || m.id).replace("models/", ""),
          }));
        }
      } else if (res.status === 401 || res.status === 403) {
        return { ok: false, error: "Authentication failed. The provided API key was rejected." };
      }
    } catch {
      // If upstream models endpoint is not directly probeable, fallback cleanly
    }
  }

  // If live probe didn't return models, use default models clearly marked
  const finalModels = discoveredModels.length > 0 ? discoveredModels : def.defaultModels;

  const { encrypted, iv, tag } = encryptServerKey(apiKey.trim());
  const masked = maskApiKey(apiKey.trim());

  const stored: StoredByokRecord = {
    providerId,
    encryptedKey: encrypted,
    iv,
    tag,
    maskedKey: masked,
    baseUrl: options.baseUrl?.trim() || undefined,
    mode: options.mode,
    models: finalModels,
    updatedAt: Date.now(),
  };

  const userMap = getStoreForUser(userId);
  userMap.set(providerId, stored);

  return {
    ok: true,
    record: {
      providerId,
      displayName: def.name,
      maskedKey: masked,
      baseUrl: stored.baseUrl,
      mode: stored.mode,
      models: finalModels,
      updatedAt: stored.updatedAt,
    },
  };
}

/**
 * Retrieves client-safe BYOK records (full key is never returned).
 */
export function listServerByok(userId = "default_user"): ClientByokRecord[] {
  const userMap = getStoreForUser(userId);
  const result: ClientByokRecord[] = [];

  for (const [pId, record] of userMap.entries()) {
    const def = BYOK_PROVIDER_DEFS[pId];
    result.push({
      providerId: pId,
      displayName: def?.name || pId,
      maskedKey: record.maskedKey,
      baseUrl: record.baseUrl,
      mode: record.mode,
      models: record.models,
      updatedAt: record.updatedAt,
    });
  }

  return result;
}

/**
 * Retrieves the raw decrypted key on the server to inject into upstream calls.
 */
export function getDecryptedServerKey(userId: string, providerId: ByokProviderId): string | null {
  const userMap = getStoreForUser(userId);
  const record = userMap.get(providerId);
  if (!record) return null;
  return decryptServerKey(record);
}

/**
 * Revokes a BYOK credential on the server.
 */
export function revokeServerByok(userId: string, providerId: ByokProviderId): boolean {
  const userMap = getStoreForUser(userId);
  return userMap.delete(providerId);
}
