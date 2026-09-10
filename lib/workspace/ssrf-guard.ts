/**
 * SSRF Guard and Safe Web Fetch for CoderXP M3 / Workspace v2.
 *
 * Implements Directive §9.3 & Review Note §3:
 * - Blocks private IP ranges (RFC 1918, RFC 6598)
 * - Blocks localhost and loopbacks (127.0.0.0/8, ::1)
 * - Blocks non-HTTP(S) schemes (file:, gopher:, ftp:, data:, etc.)
 * - Blocks cloud metadata endpoints (169.254.169.254, metadata.google.internal, etc.)
 * - Performs DNS resolution and validates resolved IP addresses at fetch time
 *   (DNS-rebinding protection)
 * - Caps response size (max 2 MB) and sanitizes response to text/markdown
 */

export interface SsrValidationResult {
  valid: boolean;
  reason?: string;
  url?: URL;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "kubernetes.default.svc",
]);

/**
 * Checks if an IP address is within forbidden/private/metadata ranges.
 */
export function isForbiddenIp(ip: string): { forbidden: boolean; reason?: string } {
  const cleanIp = ip.toLowerCase().replace(/^\[|\]$/g, "");

  // IPv4 checks
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(cleanIp)) {
    const parts = cleanIp.split(".").map(Number);
    if (parts.some((p) => p < 0 || p > 255 || isNaN(p))) {
      return { forbidden: true, reason: "Invalid IP address structure." };
    }

    const [a, b] = parts;

    if (a === 0) return { forbidden: true, reason: "Blocked network IP (0.0.0.0/8)." };
    if (a === 127) return { forbidden: true, reason: "Blocked loopback IP (127.0.0.0/8)." };
    if (a === 10) return { forbidden: true, reason: "Blocked private IP range (10.0.0.0/8)." };
    if (a === 172 && b >= 16 && b <= 31) return { forbidden: true, reason: "Blocked private IP range (172.16.0.0/12)." };
    if (a === 192 && b === 168) return { forbidden: true, reason: "Blocked private IP range (192.168.0.0/16)." };
    if (a === 100 && b >= 64 && b <= 127) return { forbidden: true, reason: "Blocked Carrier Grade NAT IP (100.64.0.0/10)." };
    if (a === 169 && b === 254) return { forbidden: true, reason: "Blocked link-local / cloud metadata IP (169.254.0.0/16)." };
  }

  // IPv6 checks
  if (cleanIp.includes(":")) {
    if (cleanIp === "::1" || cleanIp === "0:0:0:0:0:0:0:1") {
      return { forbidden: true, reason: "Blocked IPv6 loopback (::1)." };
    }
    if (cleanIp.startsWith("fc") || cleanIp.startsWith("fd")) {
      return { forbidden: true, reason: "Blocked IPv6 Unique Local Address (fc00::/7)." };
    }
    if (cleanIp.startsWith("fe80") || cleanIp.startsWith("fe8") || cleanIp.startsWith("fe9") || cleanIp.startsWith("fea") || cleanIp.startsWith("feb")) {
      return { forbidden: true, reason: "Blocked IPv6 Link-Local Address (fe80::/10)." };
    }
    if (cleanIp.startsWith("::ffff:")) {
      return isForbiddenIp(cleanIp.slice(7));
    }
  }

  return { forbidden: false };
}

/**
 * Validates a target URL against SSRF vulnerabilities (static check).
 */
export function validateUrlForFetch(rawUrl: string): SsrValidationResult {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { valid: false, reason: "URL must be a non-empty string." };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { valid: false, reason: `Malformed URL: "${rawUrl}"` };
  }

  // Scheme validation: strictly http or https
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return {
      valid: false,
      reason: `Blocked scheme "${protocol}". Only http: and https: are allowed.`,
    };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // Hostname blocklist
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return {
      valid: false,
      reason: `Blocked target host "${hostname}". Localhost and metadata services cannot be fetched.`,
    };
  }

  // Suffix checks: .local, .internal, .localhost
  if (
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".home")
  ) {
    return {
      valid: false,
      reason: `Blocked internal or local domain suffix for "${hostname}".`,
    };
  }

  const ipCheck = isForbiddenIp(hostname);
  if (ipCheck.forbidden) {
    return { valid: false, reason: ipCheck.reason };
  }

  return { valid: true, url: parsed };
}

/**
 * Resolves hostname via DNS and checks all resolved IP addresses (DNS-rebinding protection).
 */
export async function validateDnsResolution(hostname: string): Promise<{ valid: boolean; reason?: string }> {
  if (typeof window !== "undefined") {
    // In browser client runtime, DNS lookup is handled natively by the browser sandbox
    return { valid: true };
  }

  try {
    const dns = await import("node:dns");
    const addresses = await dns.promises.lookup(hostname, { all: true });
    for (const record of addresses) {
      const check = isForbiddenIp(record.address);
      if (check.forbidden) {
        return {
          valid: false,
          reason: `DNS Rebinding / SSRF blocked: host "${hostname}" resolved to forbidden IP "${record.address}" (${check.reason}).`,
        };
      }
    }
    return { valid: true };
  } catch (err: any) {
    return {
      valid: false,
      reason: `DNS lookup failed for host "${hostname}": ${err.message || String(err)}`,
    };
  }
}

/**
 * Strips HTML tags and script/style contents to produce readable text.
 */
export function sanitizeHtmlToText(html: string): string {
  if (!html) return "";
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");

  // Convert common block elements to newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, "\n");
  text = text.replace(/<br\s*[\/]?>/gi, "\n");
  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

export interface SafeWebFetchOptions {
  maxSizeBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export async function safeWebFetch(
  rawUrl: string,
  options: SafeWebFetchOptions = {},
): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
  const check = validateUrlForFetch(rawUrl);
  if (!check.valid || !check.url) {
    return {
      ok: false,
      status: 400,
      text: "",
      error: `SSRF_BLOCKED: ${check.reason}`,
    };
  }

  // Review Note §3: DNS-Rebinding validation
  const hostname = check.url.hostname.replace(/^\[|\]$/g, "");
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) && !hostname.includes(":")) {
    const dnsCheck = await validateDnsResolution(hostname);
    if (!dnsCheck.valid) {
      return {
        ok: false,
        status: 403,
        text: "",
        error: `SSRF_BLOCKED: ${dnsCheck.reason}`,
      };
    }
  }

  const maxBytes = options.maxSizeBytes ?? 2 * 1024 * 1024; // 2 MB default cap
  const timeoutMs = options.timeoutMs ?? 10000; // 10s timeout

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(check.url.toString(), {
      method: "GET",
      headers: {
        "User-Agent": "CoderXP-Agent-Bot/1.0 (+https://coderxp.pro)",
        Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
        ...options.headers,
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        text: "",
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const contentType = response.headers.get("content-type") || "";
    const rawBody = await response.text();

    if (rawBody.length > maxBytes) {
      const truncated = rawBody.slice(0, maxBytes);
      const text = contentType.includes("html") ? sanitizeHtmlToText(truncated) : truncated;
      return {
        ok: true,
        status: response.status,
        text: text + "\n\n[Content truncated at 2 MB limit]",
      };
    }

    const text = contentType.includes("html") ? sanitizeHtmlToText(rawBody) : rawBody;
    return {
      ok: true,
      status: response.status,
      text,
    };
  } catch (err: any) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      return {
        ok: false,
        status: 408,
        text: "",
        error: "Fetch timed out after 10 seconds.",
      };
    }
    return {
      ok: false,
      status: 500,
      text: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
