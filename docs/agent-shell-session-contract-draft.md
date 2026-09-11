# Per-agent shell/session contract — proposal (later review gate)

Status: **PROPOSAL**. Implementation belongs to the core feature slice
("each agent's own real shell and live terminal"), a separate review gate
after the authorization slice. This document proposes the contract so the
authorization slice can reserve the right enforcement points now.

## Session contract (proposed)

- **One dedicated shell session per active agent/task**, allocated through
  `runtime.allocate` + `exec` authorization. The session is scoped to
  (owner, project, agentSessionId); working directory and session state
  persist across tool calls while alive. No silent sharing of shell state,
  stdin, credentials, or process control between agents.
- **Identity and lifecycle:** server-assigned session ID; states
  `starting → running → succeeded | failed | cancelled | unknown /
  reconciling`. Loss of contact yields `unknown/reconciling`, never a
  fabricated terminal state. Exit status comes from the runtime
  supervisor/process state — never model text, prompts, or output markers.
  Interactive input without trustworthy per-command completion is labeled
  as such; no exit code is invented.
- **Execution shape:** structured execution preserves executable/argument
  boundaries (no shell-string interpolation of arguments). Intentional
  shell scripts are an explicit `shell-script` capability flag on the
  request, gated by authorization — never an implicit fallback.
- **Timeouts and cancellation** apply to the workload process group
  including descendants; "stopped" is reported only when the supervisor
  confirms termination. Interrupted/uncertain operations reconcile before
  retry; reconnect never silently reruns commands (new session only via
  the defined allocation flow; dead sessions are reported as dead).
- **Runtime honesty:** isolated remote Linux runtime for full shell
  workflows; WebContainer retained behind the runtime interface only for
  supported browser applications, labeled with real capabilities and
  missing prerequisites. Missing runtime fails as unavailable — never as
  success, never via a fake-provider fallback in production.

## Watching and controlling the terminal (proposed UX)

- Each agent gets a clearly labeled, live PTY-backed terminal panel showing
  session identity, connection state, running processes, and command
  activity. Output streams as it happens (server-assigned sequence
  numbers, reconnect cursors, bounded buffers, explicit truncation/gap
  notices, backpressure) — not only after completion.
- The user may observe at any time and explicitly take input control
  through a visible control lease (agent input paused while the user
  holds the lease; lease expiry/return is explicit). No concurrent
  human/agent stdin races. A separate user terminal, where provided,
  stays visually and functionally distinct from agent terminals.
- Input, resize, interrupt (SIGINT), stop, and reconnect are first-class
  controls. Reconnect replays from the cursor without duplicating
  commands.
- Terminal output is untrusted: no HTML execution, no automatic permission
  changes, links not followed blindly. Secrets are redacted (including
  across chunk boundaries) before output reaches logs, storage, the
  model, or the browser. PTY output is labeled combined unless stdout/
  stderr are genuinely captured separately.

## Isolation and stream safety (non-negotiable for the slice)

Non-root execution identity, resource limits, filesystem/process/network
isolation per hosting model. No Docker socket, control-plane filesystem,
host shell, metadata services, sibling-agent volumes, or broad provider
credentials in the agent environment. Raw shell access must not bypass
push/deployment approvals: scoped egress plus brokered credentials and
brokered external operations — never broad Git/cloud/SSH credentials in
the ordinary agent environment and never a promise that the model will
avoid a command.

## Authorization touchpoints (reserved now)

`runtime.allocate`, `exec` (+ `networkNeed`), `terminal.attach/input/
resize/interrupt`, `logs.read`, `preview.*`, `agent.stop/restore`,
`file.*`, `git.*`, `deploy`, `credential.use`, `spend` — all defined in
`lib/server/authorization/types.ts` so this contract maps 1:1 onto
enforcement later.

## Reuse candidates (to be audited against the contract, not blindly reused)

`node-pty` dependency, `lib/server/devbox-broker.ts`,
`lib/server/devbox-token.ts` (PR #1), `lib/workspace/terminal.ts`,
`lib/workspace/agent-process-stream.ts`, `app/workspace/components/
TerminalPanel.tsx` and `DevboxTerminalPanel.tsx`,
`lib/server/devbox-event-store.ts`, `lib/workspace/secret-redaction.ts`.

## Acceptance evidence plan (later gate)

Two agents with provably separate shells; live output during long runs;
working input/resize; descendant-killing cancellation; duplicate-free
reconnect; honest missing-runtime failure; file survival across session
replacement — demonstrated with real integration evidence in an approved
disposable environment. Test-only fakes stay in unit tests.
