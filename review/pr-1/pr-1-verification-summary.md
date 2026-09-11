# PR #1 verification summary (private)

Repository: `coderxp1/coderxp` (private)
PR: https://github.com/coderxp1/coderxp/pull/1
**PR remains open and unmerged.** No merge, force-push, Actions enablement,
deployment, production contact, production configuration changes, or live
secret rotation were performed. No `.env` files exist or were created; no
production credentials were involved.

Artifacts in this directory are hosted on branch `arena/01a09099-coderxp`
(same private repository) under `review/pr-1/`.

## Range

| | SHA |
|--|--|
| **Base** (`main`) | `5640a8475bded2dd785d5839b0f9a4773668435c` |
| **Reviewed head (superseded)** | `495dca5463cc928e70eb97b3ef1ba632263d1009` |
| **Current head (this verification)** | `0d851e96718593732d5c2cd06e72657a09220211` |

Patch files:

| File | Range | Command |
|---|---|---|
| `pr-1-auth-hardening-5640a8475bded2dd785d5839b0f9a4773668435c-to-0d851e96718593732d5c2cd06e72657a09220211.patch` | base → current head | `git diff --binary 5640a8475bded2dd785d5839b0f9a4773668435c..0d851e96718593732d5c2cd06e72657a09220211` |
| `pr-1-auth-hardening-5640a8475bded2dd785d5839b0f9a4773668435c-to-495dca5463cc928e70eb97b3ef1ba632263d1009-SUPERSEDED.patch` | base → reviewed head (record only) | `git diff --binary 5640a8475bded2dd785d5839b0f9a4773668435c..495dca5463cc928e70eb97b3ef1ba632263d1009` |

Both patches were verified with `git apply --check` against a base tree: each
applies cleanly.

### What changed since the reviewed head (`495dca5..0d851e9`, one commit)

Commit `0d851e9` “Serialize overlapping password changes in one auth process”
(5 files: `lib/server/auth.ts`, `app/api/auth/change-password/route.ts`,
`docs/auth-local-setup.md`, `scripts/test-auth-password.ts`,
`scripts/test-app-auth-session.ts`):

- `updateAdminPassword` is now the async sole credential-change entry point
  requiring `{ currentPassword, expectedGeneration }`, serialized by an
  in-process mutex with generation + password revalidation before
  persist → file-verify → activation.
- Stale queued changes are rejected (`StaleCredentialChangeError`, HTTP 409).
- The supported process model is documented as one authentication process
  handling both credential changes and session verification; a “single
  writer” with additional stale readers is explicitly **not** supported.
- Committed overlapping-request regression coverage
  (`scripts/test-auth-password.ts` section 8).

At the reviewed head `495dca5`, `updateAdminPassword` was synchronous with no
claim, no lock, and no overlap test, and the doc said “a single Node process
(or a single writer of `AUTH_PASSWORD_FILE`)” — the ambiguity this change
removes.

## Process model (review point 2)

Supported model, enforced in code and documented in
`docs/auth-local-setup.md` (“Supported process model”, line 73):

> **Supported:** one authentication process handling both credential changes
> and session verification. … **Not supported:** more than one authentication
> process. A “single writer” of `AUTH_PASSWORD_FILE` with additional
> processes that verify sessions is **not** a supported model.

The single-writer alternative was removed as a supported option.
Multi-process authentication remains explicitly unsupported; this PR does not
implement cross-process refresh.

Overlapping asynchronous password changes are enforced by a shared
server-side guard, not by documentation or by “one process / one admin /
one route”:

| Item | Location (head `0d851e9`) |
|--|--|
| Shared guard (mutex) | `lib/server/auth.ts:95` `withPasswordChangeLock` |
| Transaction | `lib/server/auth.ts:361` `applyAdminPasswordChange`: revalidate `expectedGeneration` + current password against the active credential → `persistCredentialsStrict` → read back and verify file → activate (`_credentialState = next`) |
| Sole writer | `lib/server/auth.ts:332` `updateAdminPassword` (all callers funnel through the lock at line 351) |
| HTTP entry point | `app/api/auth/change-password/route.ts:59` — calls `updateAdminPassword` only; not a second writer. Reads `expectedGeneration` at line 50, maps stale rejections to HTTP 409 at line 84 |
| Stale rejection | `lib/server/auth.ts:72` `StaleCredentialChangeError` |
| Session binding | `lib/server/auth.ts:294-295` — tokens whose `credentialGeneration` ≠ active generation are rejected |

Entry-point audit at head (exact `git grep` on `0d851e9`):

- `updateAdminPassword` product callers: only
  `app/api/auth/change-password/route.ts` (plus `scripts/` tests). There is
  exactly one HTTP password-update route.
- Zero assignments to `ADMIN_CONFIG.password` anywhere (the setter has no
  callers; activation happens only via `_credentialState = next` inside the
  locked transaction).
- `hashPassword` product callers: one-time synchronous env provisioning in
  `loadCredentialState` (`lib/server/auth.ts:158`, atomic in the event loop
  before any transaction can interleave) and the locked transaction
  (`lib/server/auth.ts:374`).
- File writes to `AUTH_PASSWORD_FILE`: `tryPersistCredentials` (one-time
  provisioning path) and `persistCredentialsStrict` (locked transaction
  only, `lib/server/auth.ts:408`).

Committed deterministic regression (`scripts/test-auth-password.ts:128`,
section 8 “Overlapping password changes: serialize, reject stale,
persist-fail isolation”), using disposable fixtures only:

1. Two concurrent `updateAdminPassword` calls with the same claimed
   generation: first commits, queued second is rejected with
   `StaleCredentialChangeError`; persisted hash/generation match the active
   credential; the stale password does not authenticate
   (`[PASS] Overlap: active and persisted agree; stale queued change cannot
   overwrite.`).
2. An injected persistence failure after that success
   (`__failNextPasswordPersistForTests`, `lib/server/auth.ts:91`) throws,
   leaves memory, file, and generation at the successful change, keeps the
   post-success session valid, and does not activate its proposal
   (`[PASS] Persist failure after success neither activates proposal nor
   rolls back.`).

## Toolchain (this isolated non-production environment)

- Node **v22.22.3** / npm **10.9.8** (this sandbox).
- Package `engines.node` is `24.x`. Node 24 is **not installed** here.
  All results below are for Node 22 and are labeled as such.
- Install: `npm ci --ignore-scripts` (exit 0), lifecycle inspection, then
  `npm rebuild` (exit 0; see below).
- Disposable auth env only. No production credentials.

## Dependency lifecycle scripts actually executed by `npm rebuild`

Root `package.json` has no `preinstall` / `install` / `postinstall` /
`prepare` / `postpublish` scripts (verified: empty). That does **not** imply
dependency rebuild scripts were absent — the installed tree was enumerated
(top level plus one nested level; 438 packages) **before** execution.

`npm rebuild` executes `preinstall` / `install` / `postinstall` per package
(plus a synthesized `node-gyp rebuild` only when `binding.gyp` exists
without a custom `install` script). `prepare` / `prepublish` /
`prepublishOnly` are **not** run by `npm rebuild`.

Exactly **3** packages carry rebuild lifecycle scripts. Each script was read
**before** execution:

| Package | Version | Scripts run by `npm rebuild` | Inspected behavior |
|--|--|--|--|
| `esbuild` | 0.25.12 | `postinstall`: `node install.js` | Selects the packaged platform binary from local `@esbuild/*` optional deps. Contains a registry-download fallback, but local `@esbuild/linux-x64` binary is present, so the fallback path was not expected — and the rebuild log confirms no `Trying to download` occurred. |
| `node-pty` | 1.1.0 | `install`: `node scripts/prebuild.js \|\| node-gyp rebuild`; `postinstall`: `node scripts/post-install.js` | `prebuild.js` checks `prebuilds/<platform>-<arch>`; only darwin/win prebuilds ship, so `node-gyp rebuild` compiled the Linux binding. `post-install.js` prunes `build/Release` extras (conpty move is Windows-only, skipped). |
| `unrs-resolver` | 1.12.2 | `postinstall`: `node postinstall.js` | `napi-postinstall.checkAndPreparePackage(packageJson, true)` — wires the local `@unrs/resolver-binding-linux-x64-gnu` N-API binary. No network. |

No nested `node_modules` packages carry rebuild scripts. No package has a
`binding.gyp` without a custom `install` script (`node-pty` has one).
Many other packages declare `prepare` / `prepublishOnly` only; those were
**not** executed by `npm rebuild`.

Execution record (truthful, both attempts):

1. Plain `npm rebuild` → **exit 1**: `node-gyp` tried to download Node
   headers from `nodejs.org`, which this sandbox's network policy blocks
   (TLS `SSL_ERROR_SYSCALL`; `registry.npmjs.org` works as a control).
   Environmental failure, before any product code ran.
2. `npm rebuild --nodedir=/usr/local` → **exit 0**: same inspected scripts;
   only the header source changed to the sandbox's locally installed,
   version-matched Node headers (`/usr/local/include/node`, v22.22.3 =
   runtime). No new infrastructure, no proxy changes. Verified artifacts:
   `node_modules/node-pty/build/Release/pty.node` built (71,576 bytes),
   `Release/` pruned to the binding only, esbuild binary present,
   `rebuilt dependencies successfully`.

## Commands (head `0d851e9`)

| Command | Exit | Notes |
|---------|------|--------|
| `npm test` | **0** | Full 36-harness aggregate suite incl. Devbox auth, auth fail-closed, and the overlapping password-change regression |
| `npx --no-install tsc --noEmit --pretty false` | **0** | Final-head type-check on `0d851e96718593732d5c2cd06e72657a09220211`; no diagnostics |
| `npm run build` | **1** | **Blocked by sandbox network policy** (Google Fonts fetch); identical at base; **not** OOM; build gate left **open** — see classification below |
| `npx --no-install eslint . --max-warnings 0` (head) | **1** | 44 errors, 3 warnings — baseline; none on PR-changed files |
| `npx --no-install eslint . --max-warnings 0` (base `5640a84`, same toolchain) | **1** | 44 errors, 3 warnings — identical diagnostics |

## ESLint base vs head (file, rule, severity, diagnostic)

Same ESLint 9 / `eslint-config-next` 16.3.0 toolchain for both runs
(`package-lock.json` and `eslint.config.mjs` are byte-identical between base
and head; base was linted in a detached worktree sharing that install).
Comparison key: file + line + column + severity + rule + full diagnostic
text, with worktree prefixes stripped to `<root>` (required because
`react-hooks/*` messages embed absolute paths and code frames).

**Result: identical.** 47 diagnostics on each side (44 errors + 3 warnings),
0 only-in-base, 0 only-in-head, 0 per-file count differences. Equal counts
are **not** the only check; the normalized diagnostic multisets match
exactly (machine-readable proof in `eslint-compare.json`, including
`onlyInBase: []` and `onlyInHead: []`).

PR-changed files have **zero** ESLint diagnostics on either SHA. The
unrelated baseline findings below were **retained as baseline issues and not
fixed in this PR**. (Head lints one additional file,
`scripts/test-auth-config-fail-closed.ts`, with zero findings — hence 192
vs 191 files with results and no diagnostic delta.)

| File | Line | Col | Severity | Rule | Diagnostic |
|---|---:|---:|---|---|---|
| `app/workspace/components/ByokProviderModal.tsx` | 52 | 7 | error | `react-hooks/set-state-in-effect` | Error: Calling setState synchronously within an effect can trigger cascading renders |
| `app/workspace/components/ByokProviderModal.tsx` | 60 | 5 | error | `react-hooks/set-state-in-effect` | Error: Calling setState synchronously within an effect can trigger cascading renders |
| `app/workspace/components/DevboxTerminalPanel.tsx` | 31 | 42 | error | `react-hooks/purity` | Error: Cannot call impure function during render |
| `app/workspace/components/EditorPanel.tsx` | 130 | 5 | error | `react-hooks/set-state-in-effect` | Error: Calling setState synchronously within an effect can trigger cascading renders |
| `app/workspace/components/EditorPanel.tsx` | 155 | 5 | error | `react-hooks/set-state-in-effect` | Error: Calling setState synchronously within an effect can trigger cascading renders |
| `app/workspace/components/McpServerModal.tsx` | 45 | 9 | error | `react-hooks/set-state-in-effect` | Error: Calling setState synchronously within an effect can trigger cascading renders |
| `app/workspace/components/SidebarActionMenu.tsx` | 41 | 7 | error | `react-hooks/set-state-in-effect` | Error: Calling setState synchronously within an effect can trigger cascading renders |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 62 | 3 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 64 | 3 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 66 | 3 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 68 | 3 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 70 | 3 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 77 | 5 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 77 | 5 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 77 | 5 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 77 | 5 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 77 | 5 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 77 | 5 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 77 | 6 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 78 | 5 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 78 | 5 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 79 | 5 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 79 | 5 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 81 | 9 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 82 | 7 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 82 | 7 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 84 | 5 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 85 | 53 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 88 | 16 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 89 | 18 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 90 | 22 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 91 | 16 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 99 | 24 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 99 | 24 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 137 | 31 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 137 | 31 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 139 | 34 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 139 | 34 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 141 | 38 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 141 | 38 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 143 | 10 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 144 | 5 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `scripts/cdp-snap.mjs` | 3 | 28 | error | `(parse)` | Parsing error: Unexpected token, expected "," (3:28) |
| `scripts/record-production-walkthrough.ts` | 6 | 14 | error | `(parse)` | Parsing error: Expression expected. |
| `server/devbox-broker-server.ts` | 109 | 3 | warning | `(parse)` | Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-require-imports'). |
| `server/docker-control-server.ts` | 119 | 3 | warning | `(parse)` | Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-require-imports'). |
| `server/docker-control-server.ts` | 334 | 11 | warning | `(parse)` | Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-require-imports'). |

## Type-check (final head)

Command: `npx --no-install tsc --noEmit --pretty false`
Working tree: `0d851e96718593732d5c2cd06e72657a09220211`
Exit: **0** (no diagnostics; empty log).

`tsconfig.json` excludes `scripts` and `server` (project default, unchanged
by this PR). No results are carried forward from earlier SHAs.

## Production build classification

The earlier report of exit 137 on `495dca5` did **not** include
runner, kernel, or cgroup OOM confirmation. That historical run is recorded
as **“build terminated, exit 137; OOM suspected”** — for that run only — and
an interrupted build establishes nothing about later compilation stages.

Fresh result in this isolated non-production environment (not production;
Actions not enabled; no new infrastructure provisioned):

- Host: MemTotal 4034452 kB (~3.85 GiB), no swap, MemAvailable ~3.5 GiB
  before and after the build.
- cgroup `/sys/fs/cgroup/user`: `memory.max=3997061120` (~3.73 GiB);
  `memory.events` shows `oom 0 oom_kill 0` before **and** after; `dmesg`
  has zero OOM / killed-process lines. **This build did not OOM.**
- `NODE_OPTIONS=--max-old-space-size=1536`.
- Head `0d851e9`: `npm run build` → **exit 1** with exactly **2 errors**,
  both `next/font` Google-Fonts fetch failures (`Inter`, `JetBrains Mono`
  via `app/layout.tsx`, a file this PR does not touch):
  `Failed to fetch … from Google Fonts.` Direct `curl` to
  `https://fonts.googleapis.com` fails here (TLS `SSL_ERROR_SYSCALL`,
  exit 35) while `https://registry.npmjs.org` succeeds — the sandbox
  network policy blocks the font origin.
- Base `5640a84` (own `npm ci --ignore-scripts` install, same flags):
  `npm run build` → **exit 1 with the identical 2 Google-Fonts errors**.
  The failure is pre-existing and environmental, not a product regression.
- The remaining build warnings are the same class on both SHAs (font
  connection warnings plus pre-existing Turbopack filesystem-tracing
  warnings for the env-derived `AUTH_PASSWORD_FILE` path in
  `lib/server/auth.ts`; only call-site line numbers differ because that
  file was rewritten).

Recorded classification for head `0d851e9` in this environment:
**“build terminated, exit 1; blocked by sandbox network policy (Google
Fonts fetch unreachable); identical failure at base; OOM ruled out
(oom_kill 0, dmesg clean, memory free).”** An interrupted build cannot
establish that later stages would pass, so the **build gate is left open**
as a resource blocker. No production use, Actions enablement, or new
infrastructure was employed to work around it, per the review constraints.

Full output plus post-build diagnostics are in `build.log`.

## Aggregate test log

`npm-test-head-sanitized.log` (exit 0, head
`0d851e96718593732d5c2cd06e72657a09220211`, 36 harnesses). Scanned for
secret patterns (`sk-ant-*`, private keys, `*_SECRET=` / `*_PASSWORD=`
assignments with values): clean — tests print `[PASS]` markers only, and
the disposable fixture passwords live in the committed test sources, not
as live secrets. No log lines were carried forward from earlier SHAs.

## Integrity

- Tracked source during verification matched
  `0d851e96718593732d5c2cd06e72657a09220211` (`git status` clean;
  `package-lock.json` unchanged by this PR).
- These artifacts are additive files under `review/pr-1/` on
  `arena/01a09099-coderxp` only; no product file was modified to produce
  them.

## Out of scope (unchanged)

Project/action authorization, safe file sync, truthful runtime behavior —
separate PRs after explicit review and merge approval. Authentication-PR
merge approval, when given, will not itself authorize deployment.

## SHA-256

| Artifact | SHA-256 | Bytes |
|---|---|---:|
| `pr-1-auth-hardening-5640a8475bded2dd785d5839b0f9a4773668435c-to-0d851e96718593732d5c2cd06e72657a09220211.patch` | see `SHA256SUMS` | 68909 |
| `pr-1-auth-hardening-5640a8475bded2dd785d5839b0f9a4773668435c-to-495dca5463cc928e70eb97b3ef1ba632263d1009-SUPERSEDED.patch` | see `SHA256SUMS` | 60098 |
| `npm-test-head-sanitized.log` | see `SHA256SUMS` | 70899 |
| `build.log` | see `SHA256SUMS` | 7854 |
| `eslint-compare.json` | see `SHA256SUMS` | 53054 |
| `pr-1-verification-summary.md` | see `SHA256SUMS` (this file; hashed after write) | — |

Authoritative hashes live in the sidecar `SHA256SUMS` in this directory.
