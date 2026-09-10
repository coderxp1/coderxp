/**
 * Same-origin request check for agent API routes.
 *
 * This is a CSRF / cross-site request mitigation, not authentication.
 * Browser fetch/XHR sends Origin; mismatched Origin is rejected.
 * Missing Origin is allowed (non-browser clients, same-document navigations,
 * and deterministic test harnesses).
 */

export function isSameOriginRequest(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;

  const host = req.headers.get("host");
  if (!host) return false;

  try {
    const parsed = new URL(origin);
    return parsed.host === host;
  } catch {
    return false;
  }
}
