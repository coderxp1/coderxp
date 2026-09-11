# PR #1 verification summary (private)

Repository: `coderxp1/coderxp` (private)  
PR: https://github.com/coderxp1/coderxp/pull/1  
**PR remains open and unmerged.** No force-push, Actions enablement, deployment, production contact, production configuration changes, or live secret rotation were performed.

## Range

| | SHA |
|--|--|
| **Base** (`main`) | `5640a8475bded2dd785d5839b0f9a4773668435c` |
| **Previous head (superseded)** | `495dca5463cc928e70eb97b3ef1ba632263d1009` |
| **Head (this verification)** | `0d851e96718593732d5c2cd06e72657a09220211` (`feature/auth-hardening`) |

Patch file: `pr-1-auth-hardening-5640a8475bded2dd785d5839b0f9a4773668435c-to-0d851e96718593732d5c2cd06e72657a09220211.patch`  
Patch command: `git diff --binary 5640a8475bded2dd785d5839b0f9a4773668435c..0d851e96718593732d5c2cd06e72657a09220211`

## Source review (process model)

Supported model is now documented and enforced as **one authentication process handling credential changes and session verification**.

The “single writer of `AUTH_PASSWORD_FILE`” alternative was removed as a supported option because additional authentication readers can keep a stale in-memory generation. Multi-process authentication remains **explicitly unsupported**; this PR does not implement cross-process refresh.

Overlapping asynchronous password changes are enforced in code, not by documentation:

| Item | Location |
|--|--|
| Shared guard (mutex) | `lib/server/auth.ts` `withPasswordChangeLock` |
| Transaction | `applyAdminPasswordChange` (revalidate `expectedGeneration` + current password → persist → verify file → activate) |
| Sole writer | `updateAdminPassword` |
| HTTP entry point | `app/api/auth/change-password/route.ts` — calls `updateAdminPassword` only |
| Stale queued caller | `StaleCredentialChangeError` (HTTP 409) |
| Regression | `scripts/test-auth-password.ts` section 8 |

The overlapping test shows:

1. After concurrent `updateAdminPassword` calls with the same claimed generation, persisted hash/generation match the active credential.
2. The queued stale request is rejected and its password does not authenticate.
3. An injected persistence failure after that success does not activate its proposal and does not roll back the successful change (file and memory unchanged).

## Toolchain (this isolated non-production environment)

- Node **v22.23.2** / npm **10.9.8**
- Package `engines.node` is `24.x`. Node 24 is **not installed** here. Results are for Node 22.
- Install: `npm ci --ignore-scripts` (exit 0) then lifecycle inspection, then `npm rebuild` (exit 0).
- Disposable auth env only. No production credentials.

## Dependency lifecycle scripts actually executed by `npm rebuild`

Root `package.json` has no `prepare` / `postinstall`. That does **not** imply dependency rebuild scripts were absent.

`npm rebuild` runs `preinstall` / `install` / `postinstall` (and `node-gyp rebuild` when `binding.gyp` exists without a custom install script). `prepare` / `prepublish` / `prepublishOnly` are **not** run by `npm rebuild`.

Inspected **before** execution. Packages that would run rebuild lifecycle scripts:

| Package | Version | Scripts run by `npm rebuild` | Inspected command / behavior |
|--|--|--|--|
| `esbuild` | 0.25.12 | `postinstall` | `node install.js` — selects the packaged platform binary from `@esbuild/*`; does not execute arbitrary remote code beyond that installer |
| `node-pty` | 1.1.0 | `install`, `postinstall` | `node scripts/prebuild.js \|\| node-gyp rebuild` (checks `prebuilds/$platform-$arch`; rebuilds native addon if missing); `node scripts/post-install.js` cleans extra files under `build/Release` and moves Windows conpty DLLs |
| `unrs-resolver` | 1.12.2 | `postinstall` | `node postinstall.js` → `napi-postinstall.checkAndPreparePackage(packageJson, true)` for the N-API native binary |

Inspection occurred, then `npm rebuild` was executed (exit 0). Many other packages declare `prepare` / `prepublishOnly` only; those were **not** executed by `npm rebuild`.

## Commands (head `0d851e9`)

| Command | Exit | Notes |
|---------|------|--------|
| `npm test` | **0** | Full aggregate suite including Devbox + auth fail-closed + overlapping password-change regression |
| `npx tsc --noEmit` | **0** | Final-head type-check on `0d851e96718593732d5c2cd06e72657a09220211` |
| `npm run build` | **0** | Retry on this isolated non-production runner; see build classification below |
| `eslint . --max-warnings 0` (head) | **1** | 44 errors, 3 warnings (baseline; none on PR-changed files) |
| `eslint . --max-warnings 0` (base `5640a84`, same toolchain) | **1** | 44 errors, 3 warnings |

## ESLint base vs head (file, rule, severity, diagnostic)

Same ESLint 9.x / `eslint-config-next` 16.3.0 toolchain. Comparison key: file + line + column + rule + severity + diagnostic text with worktree prefixes stripped.

**Result: identical.** 0 diagnostics only-in-base, 0 only-in-head, 0 per-file count changes. Equal counts are **not** the only check; the diagnostic lists match.

PR-changed files have **no** ESLint diagnostics on either SHA. Unrelated baseline findings were **not** fixed in this PR.

| File | Line | Col | Severity | Rule | Diagnostic |
|---|---:|---:|---|---|---|
| `app/workspace/components/ByokProviderModal.tsx` | 52 | 7 | error | `react-hooks/set-state-in-effect` | Error: Calling setState synchronously within an effect can trigger cascading renders |
| `app/workspace/components/ByokProviderModal.tsx` | 60 | 5 | error | `react-hooks/set-state-in-effect` | Error: Calling setState synchronously within an effect can trigger cascading renders |
| `app/workspace/components/DevboxTerminalPanel.tsx` | 31 | 42 | error | `react-hooks/purity` | Error: Cannot call impure function during render |
| `app/workspace/components/EditorPanel.tsx` | 130 | 5 | error | `react-hooks/set-state-in-effect` | Error: Calling setState synchronously within an effect can trigger cascading renders |
| `app/workspace/components/EditorPanel.tsx` | 155 | 5 | error | `react-hooks/set-state-in-effect` | Error: Calling setState synchronously within an effect can trigger cascading renders |
| `app/workspace/components/McpServerModal.tsx` | 45 | 9 | error | `react-hooks/set-state-in-effect` | Error: Calling setState synchronously within an effect can trigger cascading renders |
| `app/workspace/components/SidebarActionMenu.tsx` | 41 | 7 | error | `react-hooks/set-state-in-effect` | Error: Calling setState synchronously within an effect can trigger cascading renders |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 137 | 31 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 137 | 31 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 139 | 34 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 139 | 34 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 141 | 38 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 141 | 38 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 143 | 10 | error | `react-hooks/refs` | Error: Cannot access refs during render |
| `app/workspace/hooks/useAgentOrchestrator.ts` | 144 | 5 | error | `react-hooks/refs` | Error: Cannot access refs during render |
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
| `scripts/cdp-snap.mjs` | 3 | 28 | error | `(parse)` | Parsing error: Unexpected token, expected "," (3:28) |
| `scripts/record-production-walkthrough.ts` | 6 | 14 | error | `(parse)` | Parsing error: Expression expected. |
| `server/devbox-broker-server.ts` | 109 | 3 | warning | `(parse)` | Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-require-imports'). |
| `server/docker-control-server.ts` | 119 | 3 | warning | `(parse)` | Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-require-imports'). |
| `server/docker-control-server.ts` | 334 | 11 | warning | `(parse)` | Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-require-imports'). |

## Type-check (final head)

Command: `npx --no-install tsc --noEmit --pretty false`  
Working tree: `0d851e96718593732d5c2cd06e72657a09220211`  
Exit: **0** (no diagnostics)

`tsconfig.json` excludes `scripts` and `server` (project default, unchanged).

## Production build classification

Earlier report of exit 137 on `495dca5` did **not** include kernel/cgroup OOM confirmation. That result is recorded as **“build terminated, exit 137; OOM suspected”** for that run only.

Retry on this isolated non-production environment (not production; Actions not enabled; no new infrastructure provisioned):

- Host: MemTotal 4024496 kB, no swap, MemAvailable ~3.6 GiB at start
- cgroup `memory.max=max`; `oom_kill=0` before and after
- `NODE_OPTIONS=--max-old-space-size=1536`
- `npm run build` **exit 0**
- cgroup peak during this session: 3747991552 bytes (~3.49 GiB)
- `dmesg` had no OOM / killed-process lines for this retry
- Build completed (static + dynamic route listing including `/api/auth/change-password`)

Build gate for head `0d851e96718593732d5c2cd06e72657a09220211`: **verified in this isolated environment** (Node 22, not Node 24).

Sanitized build log excerpt is in this artifact set (`build.log`).

## Aggregate test log

See companion file `npm-test-head-sanitized.log` (exit 0, head `0d851e96718593732d5c2cd06e72657a09220211`). Disposable test passwords are committed fixtures, not live secrets.

## Integrity

Tracked source after verification matches `0d851e96718593732d5c2cd06e72657a09220211`. Lockfile unchanged in this commit.

## Out of scope (unchanged)

Project/action authorization, safe file sync, truthful runtime — separate PRs after explicit review and merge approval. Authentication-PR merge approval, when given, will not itself authorize deployment.

## SHA-256

| Artifact | SHA-256 | Bytes |
|---|---|---:|
| `pr-1-auth-hardening-5640a8475bded2dd785d5839b0f9a4773668435c-to-0d851e96718593732d5c2cd06e72657a09220211.patch` | `be0d842bed91b2468f3073a45c505613421c6c0ad5181a82375a27abe9284c4f` | 68909 |
| `pr-1-verification-summary.md` | *(this file; hashed after this section)* | |
| `npm-test-head-sanitized.log` | `9dd742c5117970d127d1ec62b7078473edf4e6e5bdb61599d35c36a7be03a143` | 71068 |
| `build.log` | `4b6623ace154ac421b2a4a39eacb6291ef02acf159e7ccb5cacf2d70462d9a4c` | 5783 |
| `eslint-compare.json` | `713c5dce747df4d8ca055e6749d2f899ab430a7331a9ab67d64c4e28d05b52e6` | 28874 |

A sidecar `SHA256SUMS` lists hashes of the patch and logs. The summary file’s own SHA-256 is computed after write and recorded in `SHA256SUMS`.
