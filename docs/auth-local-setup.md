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
- Overlapping password changes are serialized by a shared in-process guard on
  `updateAdminPassword` (the only credential-change entry point). Callers supply
  the generation they observed; that generation and the current password are
  revalidated against the active credential before persist/activation.

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
  durable across restarts.** This does not make multi-process authentication safe.

## Supported process model (credential generation)

**Supported:** one authentication process handling both credential changes and
session verification. That process is the only reader and writer of the active
credential generation. After a successful change, in-memory state and
`AUTH_PASSWORD_FILE` are updated in the same transaction; subsequent session
verification in that process uses the new generation.

**Not supported:** more than one authentication process. A “single writer” of
`AUTH_PASSWORD_FILE` with additional processes that verify sessions is **not**
a supported model: those readers can keep a stale in-memory generation and
continue accepting sessions after a password change. There is no cross-process
refresh or cache-invalidation signal. Do not run multiple authentication
processes against this implementation.

Overlapping asynchronous password changes in the supported process are enforced
in code, not by operator convention:

- Guard: `withPasswordChangeLock` + `applyAdminPasswordChange` in
  `lib/server/auth.ts` (`updateAdminPassword`). The HTTP route
  `app/api/auth/change-password/route.ts` is not a second writer; it only
  calls that function.
- The transaction revalidates `expectedGeneration` and the current password
  against the active credential, then persists, verifies the file, and only
  then activates the new hash and generation.
- A queued caller that still holds a prior generation is rejected
  (`StaleCredentialChangeError`) and cannot overwrite a newer successful change.
- A persistence failure does not activate its proposed credential and does not
  roll back a previously successful change.

Committed coverage (`scripts/test-auth-password.ts`):
- Persistence failure leaves prior credential active
- Generation reload after simulated restart
- Env-only provisioning requires a successful file write before activation
- Overlapping updates: persisted and active generation/hash agree after
  completion; a stale queued request cannot overwrite a newer successful
  change; a failed persistence attempt after that success neither activates
  its proposal nor rolls back the successful change


## Migration from the previous baseline

The initial import allowed a hardcoded session secret and a known bootstrap password hash.
Those fallbacks are removed. Before starting the app or any auth-dependent service:

1. Set `AUTH_SESSION_SECRET` and `DEVBOX_TOKEN_SECRET` to independent strong values.
2. Provision `AUTH_ADMIN_PASSWORD` or an existing hash file.
3. Do not rely on any previous default password string.
