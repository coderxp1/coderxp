/**
 * BYOK Key Masking and Web Crypto Utilities for CoderXP Revision 2.3.
 *
 * Implements Directive §10.2 & §10.3:
 * - Keys stored encrypted at rest via Web Crypto AES-GCM
 * - Keys masked as …last4 in UI display
 */

/**
 * Masks an API key for safe user-facing display (shows only last 4 characters).
 */
export function maskApiKey(key: string | null | undefined): string {
  if (!key || typeof key !== "string" || key.trim().length === 0) {
    return "";
  }
  const trimmed = key.trim();
  if (trimmed.length <= 4) {
    return "••••";
  }
  return `…${trimmed.slice(-4)}`;
}

/**
 * Generates or derives an AES-GCM 256-bit key from a salt.
 */
async function getEncryptionKey(salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode("CoderXP-BYOK-DeviceKey-v2.3"),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypts plaintext string using AES-GCM-256.
 * Output format: base64(salt + iv + ciphertext).
 */
export async function encryptSecret(plaintext: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    // Node.js or fallback environment
    const nodeCrypto = await import("node:crypto");
    const iv = nodeCrypto.randomBytes(12);
    const key = nodeCrypto.scryptSync("CoderXP-BYOK-DeviceKey-v2.3", "salt", 32);
    const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("base64");
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getEncryptionKey(salt);

  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext),
  );

  const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(ciphertext), salt.length + iv.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypts base64 ciphertext using AES-GCM-256.
 */
export async function decryptSecret(ciphertextBase64: string): Promise<string> {
  if (!ciphertextBase64) return "";

  if (typeof crypto === "undefined" || !crypto.subtle) {
    const nodeCrypto = await import("node:crypto");
    const buf = Buffer.from(ciphertextBase64, "base64");
    if (buf.length < 28) return "";
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const key = nodeCrypto.scryptSync("CoderXP-BYOK-DeviceKey-v2.3", "salt", 32);
    const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data) + decipher.final("utf8");
  }

  const raw = atob(ciphertextBase64);
  const combined = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    combined[i] = raw.charCodeAt(i);
  }

  if (combined.length < 28) return "";

  const salt = combined.slice(0, 16);
  const iv = combined.slice(16, 28);
  const data = combined.slice(28);

  const key = await getEncryptionKey(salt);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    data,
  );

  return new TextDecoder().decode(decrypted);
}
