# Agent terminal slice — evidence (2026-09-11)

## Identity / recovery

| Item | Value |
|---|---|
| Base (this slice starts here) | `4f8463953fb01a3e9eb7e4694e35f071b1f05725` |
| Implementation commit | `2e39b88b3844fac9444a403a291dd6ccc0fc1f06` |
| Branch | `arena/01a091cd-coderxp` |
| Iteration runtime | node v22.22.3 (**iteration evidence only**) |

**PR #1 authentication-only candidate — unchanged and correctly scoped:**

| Item | Value |
|---|---|
| Base | `5640a8475bded2dd785d5839b0f9a4773668435c` (`main`) |
| Head | `0d851e96718593732d5c2cd06e72657a09220211` (`feature/auth-hardening`) |
| PR | #1, state OPEN, `mergeable: MERGEABLE` |
| Changed files | **9** |

```
M app/api/auth/change-password/route.ts
A docs/auth-local-setup.md
M lib/server/auth.ts
M lib/server/devbox-token.ts
M package.json
M scripts/test-app-auth-session.ts
A scripts/test-auth-config-fail-closed.ts
M scripts/test-auth-password.ts
M scripts/test-devbox-broker-auth.ts
```

Recovery confirmation: **no reset, clean, blanket staging, discard, or
force-push.** The prior session's work lived on a different session branch
(`origin/arena/01a09099-coderxp`, tip `4f84639`); this branch had zero unique
commits, so it was advanced with `git merge --ff-only` — a fast-forward that
preserves every prior commit and adds none. `git reflog` on this branch shows
only the clone, the checkout, the fast-forward, and the two new commits. Staging
was file-by-file. Nothing was added to PR #1; its 9-file list is unchanged.

Reviewable patch set for a separate owner-authorized checkout (this session
cannot create branches other than its own):

```
review/pr-1/pr-1-auth-hardening-5640a84...-to-0d851e9....patch
  sha256 be0d842bed91b2468f3073a45c505613421c6c0ad5181a82375a27abe9284c4f
```

Regenerated independently from `git diff 5640a84..0d851e9` this session:
**identical sha256**. Verified to apply cleanly onto base `5640a84` in an
isolated worktree (`git apply --check`, exit 0).

The mixed tips `c3639b1` (auth + PR #1 review artifacts) and `4f84639`
(auth + artifacts + runtime) are **not** authentication-only candidates and
were not treated as such.

## What this slice actually changed

Three things, all on the real path:

1. **Complete operation binding.** `handleExec` now binds the timeout inside
   the authorized `args` alongside argv/script, so the approval hash covers
   argv/script + cwd (resource) + network scope + exec mode + timeout. It then
   dispatches via `boundExecRequest(call, sessionId)`, which rebuilds the
   `ExecRequest` from the *authorized descriptor only* — the request body is no
   longer re-read after authorization. `AuthorizedRuntime.exec` re-asserts
   equality on every bound field including the timeout.
2. **One canonical encoding.** Dispatch equality previously used
   key-order-sensitive `JSON.stringify` while the authorization layer hashed
   with sorted-key `stableStringify`. The two could disagree about what "the
   same operation" means. They now share `stableStringify`.
3. **The missing UI.** The runtime had 10 API routes and **zero** UI references
   (`grep -rln "api/runtime" app components lib` returned nothing before this
   slice). Added `lib/workspace/agent-runtime-client.ts` and
   `app/workspace/components/AgentTerminalPanel.tsx`, surfaced as a separate
   **AGENT** tab distinct from the user's own **TERMINAL** tab.

Changed files (11):

```
A app/workspace/components/AgentTerminalPanel.tsx      529
M app/workspace/components/RuntimePanel.tsx             26
A docs/node24-acquisition.md                           106
M lib/server/agent-runtime/authorized-provider.ts       75
M lib/server/agent-runtime/handlers.ts                  28
A lib/workspace/agent-runtime-client.ts                350
M package.json                                           2
M scripts/smoke-agent-runtime-live.ts                    4
M scripts/test-agent-runtime-authz.ts                    6
A scripts/test-agent-runtime-binding.ts                462
A scripts/test-agent-terminal-client.ts                220
```

## Commands and exit codes

| Check | Command | Exit |
|---|---|---|
| types | `npx tsc --noEmit` | **0** |
| full aggregate suite | `npm test` | **0** |
| live PTY smoke | `npx tsx scripts/smoke-agent-runtime-live.ts` | **0** — `pass=32 fail=0` |
| lint (slice files) | `npx eslint <9 slice files>` | **0** |
| unmodified production build | `npm run build` | **1** — see Unrun/blocked |

Suite sections, each run individually after the changes:

| Suite | Sections |
|---|---|
| `test-agent-runtime-binding.ts` (new) | 5 PASS lines / 4 sections |
| `test-agent-terminal-client.ts` (new) | 5 PASS lines / 4 sections |
| `test-agent-runtime-authz.ts` | 12 PASS |
| `test-action-authorization.ts` | 17 PASS |
| `test-sanitizer-bytes.ts` | 6 PASS |

Both new suites are wired into `npm test` (its own line in the chain), and the
full chain was run end-to-end, not just the touched suites.

### Regressions this slice caused, and how they were resolved

Binding the timeout **broke two existing checks** that issued exec approvals
without it. Both were real and both were fixed by binding the timeout in the
approval, not by weakening the check:

- `test-agent-runtime-authz.ts` section 5 — timed out waiting for the
  shell-script child spawn (approval hash mismatch meant the provider was
  correctly never called). After the fix: 12/12, exit 0.
- `smoke-agent-runtime-live.ts` — `pass=31 fail=1`,
  `[CHECK FAIL] shell-script via exact approval runs`. After the fix:
  `pass=32 fail=0`, exit 0.

## Live smoke evidence (transcript in this directory)

`smoke-transcript-20260911T1939Z.log`, 32 checks, 0 failures, produced with the
tracked tree clean at `2e39b88` (verified: `git status --porcelain
--untracked-files=no` empty). Real `node-pty` factory only — no stubs on the
smoke path. Isolation prerequisites verified directly in this sandbox, not
assumed:

```
platform=linux uid=1001 userns/netns/prlimit required by config
sessA isolation={"user":"user","netns":"no-egress","prlimit":true} shellPid=10330
[CHECK pass] userns root-mapped inside (unprivileged outside)
[CHECK pass] files owned by unprivileged host uid — uid=1001
[CHECK pass] no egress route inside netns — default route absent
```

Requested disposable-smoke items, mapped to checks that passed:

| Required evidence | Checks in transcript |
|---|---|
| Live PTY output before completion + controlled input | `live stream carries exec output`, `leased input accepted`, `typed command output streams`, `wrong lease rejected` |
| Two-agent fs/process/control isolation | `allocate sessB`, `sessA cannot see sessB files`, `workspace escape refused`, `userB denied on userA session` |
| Reconnect by cursor, no rerun, non-duplicated side effect | `replay reconciled without rerun — lines=1` |
| Timeout / cancel / descendant termination | `timeout kills with confirmation`, `no descendant sleep survives — pgrep=""`, `cancelled outcome` |
| Lost-supervisor reconciliation | `killed session reports dead (not running)`, `exec on dead session refused — RUNTIME_UNAVAILABLE`, `replacement runtime reports old session unknown` |
| Workspace persistence across runtime replacement | `persisted workspaces listed after replacement — ["sessA:2","sessB:1"]`, `sessA file content survives replacement`, `project ownership survives replacement` |
| Secret redaction + authorization denial | `live token redacted from stream — marker present`, `shell-script via grant refused`, `session env carries identity, no host secrets — scrubbed` |

## Corrections to two claims in the review

Both defects were **present at `c3639b1`** (the SHA the review links) and were
already fixed by `e0df60b`, before this slice. Verified by reading both trees:

- **Byte cap.** At `c3639b1` the cap was not a strict UTF-8 bound. At the
  current tip `truncateUtf8Bytes` binary-searches on
  `TextEncoder.encode(text).length` with surrogate-safe cuts, and the
  truncation notice is counted inside the budget
  (`truncateAndSanitize` subtracts `noticeBytes` before truncating). Covered by
  `test-sanitizer-bytes.ts` (6 PASS), including multibyte cases.
- **Success-looking fallbacks.** `c3639b1` had `exit code ${rec.exitCode ?? 0}`
  at three call sites. At the tip, `run_command` returns
  `"Command result recorded (exit code unknown)"` when `exitCode` is absent,
  `stop_command` is conditional on `rec.stopped === true` with an
  `(outcome unconfirmed)` fallback, and `run_build`/`run_tests` render
  `outcome unknown`. `grep "exitCode ?? 0"` over the file returns nothing.

So those two items needed no new work; the request-binding item did, and is
done above. The item that was genuinely unbuilt was the terminal UI.

## Unrun / blocked

- **`npm run build` — exit 1, blocked.** Exactly two errors, both
  `next/font/google`: `Failed to fetch Inter` and `Failed to fetch JetBrains
  Mono`, imported at `app/layout.tsx:2`. `app/layout.tsx` is **unmodified from
  base** (`git diff --name-only 5640a84 HEAD -- app/layout.tsx` is empty), so
  this is environmental, not caused by this slice. Root cause confirmed in
  sandbox: `fonts.googleapis.com` resolves but TLS fails (`curl` exit 35,
  HTTP 000). Not worked around — switching to `next/font/local` would change
  the artifact under test. Full build evidence still owed on a supported
  runtime with font egress.
- **Node 24 checks — not run.** No Node 24 artifact was acquired; no
  network-policy exception was granted or assumed. `nodejs.org` is unreachable
  here (`curl` exit 35, HTTP 000). Proposal, pin, source URL and authenticated
  verification method are in `docs/node24-acquisition.md`. All results above
  are Node v22.22.3 iteration evidence only.
- **Browser rendering of the agent terminal — not run.** The dev server cannot
  compile `app/layout.tsx` for the same font reason, so the panel was never
  rendered in a browser here. What *is* verified: `tsc --noEmit` and `eslint`
  pass on both new UI files, and `test-agent-terminal-client.ts` exercises the
  client logic the panel depends on — SSE frame/gap/state parsing, heartbeat
  and malformed-record tolerance, live subscription over a real
  `ReadableStream` with cursor advance and single-shot dispose, honest outcome
  rendering, and typed error mapping. The React render tree itself is
  **unverified**.
- **PR #1 remains OPEN and unmerged.** No merge, no Actions enablement, no
  production credentials, deployment, contact, paid infrastructure, or secret
  rotation was performed or attempted.
