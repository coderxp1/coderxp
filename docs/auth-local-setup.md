# Local authentication setup (no production secrets)

Authentication and Devbox token signing **require explicit configuration**.
There are no built-in signing secrets and no bootstrap password fallback.

## Required environment variables

| Variable | Purpose | Rules |
|----------|---------|-------|
| `AUTH_SESSION_SECRET` | HMAC key for app session cookies/tokens | Required, ≥ 32 characters. **Do not** reuse `DEVBOX_TOKEN_SECRET`. |
| `DEVBOX_TOKEN_SECRET` | HMAC key for short-lived Devbox WSS tokens | Required, ≥ 32 characters. Separate from session secret. |
| `AUTH_ADMIN_PASSWORD` **or** `AUTH_PASSWORD_FILE` | Admin credential | At least one required. See precedence below. |

Optional:

| Variable | Purpose |
|----------|---------|
| `AUTH_ADMIN_EMAIL` | Admin email claim (default: `paul@coderxp.pro`) |
| `AUTH_PASSWORD_FILE` | Path to password hash file (default: `/opt/coderxp/data/auth-admin-hash.txt` on non-Windows) |

## Credential source precedence (fail closed)

1. If `AUTH_PASSWORD_FILE` **exists** on disk:
   - Valid `pbkdf2$100000$...` hash (optional second line = generation) → use it.
   - Exists but unreadable or malformed → **configuration failure**. Do **not** fall back to `AUTH_ADMIN_PASSWORD`.
2. Else if `AUTH_ADMIN_PASSWORD` is set:
   - If it already starts with `pbkdf2$100000$`, use as hash.
   - Otherwise treat as plaintext, hash with PBKDF2, and attempt to persist to `AUTH_PASSWORD_FILE`.
3. Else: **configuration error** — login and session minting fail closed. No default password.

## Disposable local example

```bash
export AUTH_SESSION_SECRET="$(openssl rand -hex 32)"
export DEVBOX_TOKEN_SECRET="$(openssl rand -hex 32)"
export AUTH_ADMIN_PASSWORD="local-only-change-me"
export AUTH_PASSWORD_FILE="$PWD/.data/auth-admin-hash.txt"
mkdir -p .data

npx tsx scripts/test-auth-config-fail-closed.ts
npx tsx scripts/test-auth-password.ts
npx tsx scripts/test-app-auth-session.ts
npx tsx scripts/test-devbox-broker-auth.ts
```

## Password change behavior

- New password is written to `AUTH_PASSWORD_FILE` **before** it is activated in memory.
- Credential generation is incremented; existing sessions are rejected.
- The change-password API clears the session cookie; the client must sign in again.

## Environment-only provisioning and password changes

When credentials are first loaded from `AUTH_ADMIN_PASSWORD` (no password file yet),
`updateAdminPassword` still **requires a successful write** to `AUTH_PASSWORD_FILE`
before activating the new hash. If the file cannot be written, the change fails and
the previous in-memory credential remains active.

After a successful change, the hash and credential generation are stored in
`AUTH_PASSWORD_FILE`. On process restart:

- If the file exists and is valid, it is authoritative (generation is preserved;
  prior sessions with a lower generation stay invalid).
- If the file is missing but `AUTH_ADMIN_PASSWORD` is still set, the env value is
  used again at generation 1 — sessions from a previous process that had bumped
  generation would not match unless the file is retained. **Keep the password file
  durable across restarts** in any multi-instance or restart-heavy deployment.

Multi-process note: generation and password state are file-backed, not a shared
in-memory store. Concurrent password changes from multiple processes are not
coordinated beyond atomic rename of the hash file; prefer a single writer.

## Migration from the previous baseline

The initial import allowed a hardcoded session secret and a known bootstrap password hash.
Those fallbacks are removed. Before starting the app or any auth-dependent service:

1. Set `AUTH_SESSION_SECRET` and `DEVBOX_TOKEN_SECRET` to independent strong values.
2. Provision `AUTH_ADMIN_PASSWORD` or an existing hash file.
3. Do not rely on any previous default password string.
