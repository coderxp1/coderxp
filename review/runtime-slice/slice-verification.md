# Runtime slice — verification note (2026-09-11)

## Identity

- Auth base: `5640a8475bded2dd785d5839b0f9a4773668435c`
- Auth head (PR #1, OPEN, unmerged): `0d851e96718593732d5c2cd06e72657a09220211`
- Authorization draft: `6ba588e1096ed6696276894c91fd79a323e52ffb`
- Runtime implementation: `e0df60b6bedfba33fd0677b5b75d7486d8adaa46`
- Review branch (mixed tip, NOT an auth candidate): `c3639b1dda5608305a083d16dcdfd4c03f306311`
- Auth-only candidate for PR #1 remains exactly: base `5640a84`, head
  `0d851e9`, 9 files (change-password route, auth-local-setup doc,
  lib/server/auth.ts, lib/server/devbox-token.ts, package.json, and 4
  auth test scripts). Nothing in this slice was added to PR #1.

## What the slice delivers

Real per-agent shell/session vertical slice behind enforced
authorization: persistent PTY per agent, structured argv dispatch,
approval-gated shell-script capability, live labelled streaming, control
leases, reconnect-by-cursor with bounded retention and gap notices, op-ID
reconciliation, timeout/cancel with verified descendant cleanup,
fail-closed health (`unknown` never fabricated), and workspace
persistence across runtime replacement. Isolation: unprivileged host
uid, no-egress netns, prlimit caps, scrubbed env, structural per-owner
confinement. No general egress.

## Changed files (implementation commit e0df60b)

New: `lib/server/agent-runtime/` (8 files), `app/api/runtime/` (10
routes), `scripts/test-agent-runtime-authz.ts`,
`scripts/test-sanitizer-bytes.ts`, `scripts/smoke-agent-runtime-live.ts`.
Modified: 6 `lib/server/authorization/*` files, `lib/workspace/agent-sanitizer.ts`,
`lib/workspace/agent-process-stream.ts`, `scripts/test-action-authorization.ts`,
`package.json` (aggregate suite wiring), `next.config.mjs`
(node-pty external), `.gitignore` (`.data/`).

## Checks (iteration runtime: Node v22.22.3, node-pty rebuilt locally)

| Check | Command | Exit |
|---|---|---|
| authz boundary | `npx tsx scripts/test-action-authorization.ts` | 0 (17/17) |
| sanitizer bytes | `npx tsx scripts/test-sanitizer-bytes.ts` | 0 (6/6) |
| runtime authz integration | `npx tsx scripts/test-agent-runtime-authz.ts` | 0 (12/12) |
| live smoke | `npx tsx scripts/smoke-agent-runtime-live.ts` | 0 (32/32) |
| types | `npx tsc --noEmit` | 0 |
| lint (slice files) | `npx eslint lib/server/agent-runtime scripts/test-agent-runtime-authz.ts scripts/test-sanitizer-bytes.ts scripts/test-action-authorization.ts lib/server/authorization "app/api/runtime/**/*.ts" lib/workspace/agent-sanitizer.ts lib/workspace/agent-process-stream.ts` | 0 |
| regression: execution-runtime | `npx tsx scripts/test-agent-execution-runtime.ts` | 0 (189/189) |
| regression: secret-redaction | `npx tsx scripts/test-secret-redaction.ts` | 0 |
| regression: orchestrator | `npx tsx scripts/test-agent-orchestrator.ts` | 0 |
| regression: devbox-pty-redaction | `npx tsx scripts/test-devbox-pty-secret-redaction.ts` | 0 |
| route bundling | esbuild `--bundle --external:node-pty` on 4 representative routes | 0 |
| owner checkout | patches 01+02 apply onto `0d851e9`; `npm ci`, `tsc`, 3 suites in that tree | 0, zero conflicts |

Live transcript: `smoke-transcript-20260911T1745Z.log` (32/32, sanitized;
no credential substrings — verified by grep).

## Explicitly unrun / blocked

- `npm run build`: blocked in-sandbox by Google Fonts fetch
  (`Failed to fetch Inter / JetBrains Mono`). Proven pre-existing and
  unrelated: pristine base `5640a84` fails identically (exit 1, same 2
  errors, 0 slice files implicated). Route-graph coverage substitutes:
  `tsc` + esbuild bundle probe (above). Full production-build evidence
  still required on a supported runtime with font access.
- Supported-runtime (Node 24) build + smoke: not run. No Node 24
  artifact was downloaded (no network-policy exception granted or used).
  Recommended pin for the owner acquisition decision: **Node v24.21.0
  linux-x64** (`https://nodejs.org/download/release/v24.21.0/node-v24.21.0-linux-x64.tar.xz`),
  verified via the release `SHASUMS256.txt` + signed
  `SHASUMS256.txt.asc` (GPG release keys) with `sha256sum -c`.
  All results above are iteration evidence on Node v22.22.3 only.
- Aggregate `npm test` end-to-end: not run as one chain (long); every
  suite touched or affected by shared-file edits was run individually
  (table above), plus the 3 new suites are wired into the chain.

## Recovery

No reset, clean, discard, blanket staging, or force-push was used. All
prior commits preserved; implementation is additive commit `e0df60b` on
the session branch, evidence follows in a separate commit. PR #1
remains OPEN and unmerged pending supported-runtime/build evidence and
explicit merge approval.

## Transcript integrity

`SHA256SUMS` in this directory covers the transcript, patches, and
notes. The transcript contains only synthetic test values; lease tokens
and approval serializations are never printed.
