# Self-host run path

CoderXP is a self-hosted Node.js application. Do not deploy it to Vercel or any Vercel service.

## Node.js

Required: Node.js `24.x` (`package.json` `engines.node`).

## Commands

```bash
npm ci
npm run build
npm run start
```

Optional port:

```bash
# Windows PowerShell
$env:PORT=3000
npm run start
```

```bash
# POSIX
PORT=3000 npm run start
```

`PORT` selects the HTTP listener. Provider credentials are never browser-exposed environment variables.

## Agent provider modes

Provider selection is **server-controlled** via `AGENT_PROVIDER`. The browser cannot choose an upstream URL or send provider credentials for Logicc mode.

### Default: Anthropic BYOK (`AGENT_PROVIDER=anthropic-byok`)

Users supply a session BYOK key through the workspace UI. The server forwards it only as `x-coderxp-byok-key` on `/api/agent/stream`. Anthropic credentials are not server environment variables in this mode.

### Logicc (OpenAI-compatible gateway) — internal / private only

Logicc is **disabled by default**. Missing `LOGICC_INTERNAL_MODE=true` fails closed (`ACCESS_RESTRICTED`).

`LOGICC_INTERNAL_MODE=true` is **not authentication** and does **not** provide per-user isolation, entitlements, or quota enforcement. It is an explicit operator acknowledgement that this deployment is restricted to localhost or a private network protected **outside** CoderXP (for example a trusted reverse-proxy access-control layer or network policy).

Interpretation:

```text
LOGICC_INTERNAL_MODE=true
→ suitable only for localhost or a private network protected outside CoderXP
→ not suitable for public internet exposure
```

`/api/agent/stream` is **not** safe for a public deployment merely because internal mode is enabled. Anyone who can open the CoderXP web application in that deployment may potentially spend the server-owned Logicc account. **Server-owned model usage incurs project costs.** Global concurrency/size/timeout limits are not per-user quotas.

Same-origin checks on agent routes are **request-origin validation** (cross-site request mitigation). They are **not** user authentication.

During local testing, bind the HTTP listener to localhost/private interfaces only. Do **not** expose Logicc mode on the public internet without real application authentication or trusted reverse-proxy access control. Keep the application server port unreachable from the public internet behind any reverse proxy.

Credential source for private testing may be either a gitignored `.env.local` or a process/environment secret injection. Both are acceptable only if the value remains server-only and untracked. For self-hosted production, supply the key through the selected server secret mechanism — never commit it.

#### Local `.env.local` template (names and non-secret examples only)

Never commit `.env.local`. Never put secrets in `NEXT_PUBLIC_*` variables. The API key alone is insufficient — all of the following are required:

```dotenv
AGENT_PROVIDER=logicc
LOGICC_INTERNAL_MODE=true
LOGICC_ALLOWED_MODELS=<comma-separated enabled model IDs>
LOGICC_DEFAULT_MODEL=<one ID from the allowlist>
LOGICC_API_KEY=<set locally; never commit>
```

Example non-secret shape (replace IDs with values enabled for your Logicc account):

```dotenv
AGENT_PROVIDER=logicc
LOGICC_INTERNAL_MODE=true
LOGICC_ALLOWED_MODELS=gpt-4o,gpt-4o-mini
LOGICC_DEFAULT_MODEL=gpt-4o
LOGICC_API_KEY=<set locally; never commit>
```

`LOGICC_DEFAULT_MODEL` must be both:

1. Enabled for the Logicc key (returned by Logicc `GET /v1/models`), and
2. Included in `LOGICC_ALLOWED_MODELS`.

#### How to learn enabled model IDs (without exposing the key)

Preferred local/private options:

1. **Logicc organization dashboard** — admins enable models in the Logicc account UI, then copy the API model identifiers into `LOGICC_ALLOWED_MODELS`.
2. **Local sanitized discovery helper** (private only):

```bash
# Requires LOGICC_INTERNAL_MODE=true and LOGICC_API_KEY in the environment
# (load from gitignored .env.local in your shell; do not paste the key).
# Prints sanitized model IDs only — never the key or raw upstream JSON.
npx tsx scripts/discover-logicc-models.ts
```

If `LOGICC_ALLOWED_MODELS` is unset, the helper lists enabled IDs so you can build the allowlist. If the allowlist and default are already set, it prints the allowlist ∩ enabled intersection and confirms the default.

Administrator allowlisting remains mandatory. The helper does not weaken allowlist enforcement for `/api/agent/stream` or `/api/agent/models`.

Fixed upstream origin (not browser-selectable): `https://api.logicc.cloud`.

Never log `LOGICC_API_KEY`, `Authorization` headers, or raw Logicc response bodies.

## Health and agent endpoints

- `GET /api/agent/health` — safe status only (`ok`, `provider`/`providerId`, `ready`, `access`, `status`, `byokRequired`, display fields). No secrets, env names, upstream URLs, quota, entitlements, or per-user isolation claims.
- `GET /api/agent/models` — sanitized administrator-approved model list only.
- `POST /api/agent/stream` — canonical SSE agent transport. JSON body, maximum 1 MB. Connect timeout 15 s until upstream response headers. Stream timeout 180 s after headers. Concurrent stream cap is 50. Not publicly safe with internal mode alone.

## TLS and reverse proxy

Terminate TLS at the reverse proxy. The Node process may listen on loopback HTTP.

Required proxy behavior for agent streams:

- Disable response buffering (`proxy_buffering off` or equivalent).
- Preserve `X-Accel-Buffering: no` from the application.
- Use request and read timeouts longer than the 180 s stream timeout for `/api/agent/stream`.
- Do not log `x-coderxp-byok-key` or `Authorization` request headers in access or error logs.
- Do not treat TLS termination or same-origin checks as user authentication for Logicc spend control.

## Isolation headers

`/workspace` and `/workspace/*` must keep:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

The Next.js config already sets these. Do not strip them at the proxy.

## Graceful shutdown

Send `SIGTERM` to the Node process and allow in-flight SSE responses to finish or abort cleanly. Do not SIGKILL first. After exit, BYOK material does not remain on disk (session-scoped in the browser only). Server-owned Logicc keys live only in process environment / secret stores — never in project files.

## Future authentication integration point

Broad end-user authentication, entitlements, and per-user quota enforcement for Logicc are **not** implemented in this slice. When added, they should gate Logicc access at the application and/or trusted reverse-proxy layer before `/api/agent/stream` spends the server-owned key.

## Not in this document

Docker, systemd, PM2, Nginx, and Caddy snippets are withheld until the production process model is selected.
