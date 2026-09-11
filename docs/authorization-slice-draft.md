# Authorization slice — draft record (not a merge candidate)

Status: **DRAFT** on the review branch. This slice gets its own reviewable PR
after PR #1 (authentication) merges. Nothing in this draft modifies
authentication behavior, runtime code, or deployment code.

## Dependency on PR #1

Identity input is the PR #1 verified session (`verifySessionToken` via
`createDefaultSessionValidator` in `lib/server/authorization/enforce.ts`).
Password-change generation invalidation and fail-closed secret configuration
are inherited from PR #1. If PR #1's implementation SHA changes before merge,
this draft's dependency statement and any affected checks must be refreshed.

## What exists in this draft (additive only)

| Path | Purpose |
|---|---|
| `lib/server/authorization/types.ts` | Contract types: actions, descriptors, grants, approvals, denials, audit events |
| `lib/server/authorization/util.ts` | Stable arg hashing, constant-time compare, path/destination validation |
| `lib/server/authorization/policy.ts` | Project access, session home project, destination allowlist, credential need |
| `lib/server/authorization/approvals.ts` | Single-use HMAC-bound approvals with atomic consume + replay rejection |
| `lib/server/authorization/grants.ts` | Bounded, reviewable, revocable session grants (never `external`) |
| `lib/server/authorization/enforce.ts` | `authorize()` — the single server-enforced entry point |
| `scripts/test-action-authorization.ts` | Deterministic boundary regression (14 sections, fixed fixtures, manual clock) |

`package.json` is intentionally untouched: wiring the new test into
`npm test` happens in the slice PR, keeping this draft purely additive.

## Reuse vs supersede inventory

**Reused (imported, not modified):**

- PR #1 `verifySessionToken` — verified identity input.
- `lib/server/devbox-event-store.ts` (`hostEventStore`) — production audit sink.
- `lib/devbox/event-types.ts` — tier vocabulary for audit mapping.
- `lib/workspace/agent-permissions.ts` / `agent-permissions-gate.ts`
  (`gateAndInvoke`) — orchestrator-side seam stays as the UX layer; the
  server boundary is authoritative and never trusts client decisions.
- `lib/workspace/secret-redaction.ts` — still the redaction utility for
  audit-adjacent content (this draft stores arg hashes only).

**Explicitly superseded as a security boundary (modules untouched):**

- `lib/devbox/action-policy.ts` command-substring tiering (e.g. command
  names containing "test" scoring T0) is **not** carried forward. This
  draft treats package scripts, tests, interpreters, and free-form shell
  input as arbitrary code; `exec` always needs a scoped grant or explicit
  approval. Regression section 10 pins this.
- `lib/server/devbox-credential-gate.ts` branch-only grants (no actor,
  expiry, replay, or operation binding) are replaced by the new approvals
  and grants. The old gate stays in place until the slice PR migrates its
  callers — no silent behavior swap here.
- No automatic-push / automatic-preview rule is carried forward. Push,
  remote deletion, disclosure, deployment, credential use, and spending
  each require their own approval decision (regression section 11).

## Contract summary

- Actor comes from the verified session; project access from the server
  registry (pilot: explicitly registered single-account projects —
  multi-user membership is **not** claimed).
- Reads on owned projects: allowed by policy. Write/execute/preview: scoped
  grant or explicit approval. External: explicit approval only.
- Approvals bind actor, project, session, exact action, argument hash,
  destination, revision, protected-target flag, operation ID, and expiry;
  single-use with atomic consume; forged/expired/revoked/replayed/altered
  presentations fail with typed denials.
- Grants are bounded (categories excluding external, resource prefixes,
  loopback-or-less egress, TTL caps with shorter caps for broad scope),
  reviewable via `listActive`, and revocable.
- Denial performs no runtime, storage, credential, or network side effects:
  providers are invoked only with an `AuthorizationSuccess` in hand
  (pinned by call-count assertions in every denial test).

## Integration points (later work inside this slice's gate)

API routes, tool dispatcher, runtime broker, storage adapters, terminal
attachment, preview router/access, and external-provider adapters must call
`authorize()` before acting. Route/request plumbing, durable credential
storage, and cross-process replay protection are follow-ups; the draft uses
in-process registries and documents that horizon honestly.

## Test map

`scripts/test-action-authorization.ts` sections 1–14 cover: unauthenticated
denial; policy reads + project boundary; credential requirement + malformed
input; grant happy path; four grant-scope axes; grant lifecycle +
reviewability; issuance bounds; approval single-use + replay; forged/
altered/expired/revoked approvals; exec-as-arbitrary-code; external-action
gating + destination allowlist; terminal/preview ownership; redacted audit
trail; fail-closed default validator.
