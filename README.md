# CoderXP

Premium AI coding platform. Next.js App Router workspace with an in-browser runtime, agent orchestration, and self-hosted provider modes.

## Requirements

| Item | Value |
|------|--------|
| Node.js | **24.x** (`package.json` `engines.node`) |
| Package manager | npm (committed `package-lock.json`) |
| Deploy target | Self-hosted Node.js — **not** Vercel |

See [`docs/self-host.md`](docs/self-host.md) for run path, provider modes, and Logicc internal-mode constraints.

## Tech stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 16 (App Router) |
| UI | React 19, Tailwind CSS, Radix/shadcn patterns, Lucide |
| Editor | CodeMirror 6 |
| Runtime | WebContainer API |
| Agent | Server-side provider registry (Anthropic BYOK default; Logicc optional, private/internal only) |
| Language | TypeScript (strict) |
| Linting | ESLint 9 (flat config) |

## Commands

```bash
npm ci
npm run lint
npx tsc --noEmit
npm test
npm run build
npm run dev
npm run start
```

`npm test` runs the deterministic `tsx` harnesses under `scripts/` (permissions, execution runtime, runtime adapter, orchestrator, Anthropic adapter, stream route, production E2E, plus Logicc provider/adapter/E2E). Live Logicc smoke helpers are **not** part of `npm test`.

## Product surfaces

- `/` — marketing landing
- `/workspace` — project workspace (editor, runtime, agent chat)
- `/api/agent/health` — provider health (server-controlled)
- `/api/agent/models` — model discovery / allowlist view
- `/api/agent/stream` — agent stream (same-origin validated; not public auth)
- `/robots.txt` — dynamic via `app/robots.ts` (no static `public/robots.txt`)
- `/sitemap.xml` — dynamic via `app/sitemap.ts`

## Agent provider modes (summary)

- **Default:** `AGENT_PROVIDER=anthropic-byok` — session BYOK key from the workspace UI; not a server env secret.
- **Logicc:** opt-in via server env; requires `LOGICC_INTERNAL_MODE=true` and fails closed otherwise. Internal mode is **not** authentication — suitable only for localhost or a network protected outside CoderXP. Do not expose Logicc mode on the public internet without real application authentication or trusted reverse-proxy access control.

Never commit `.env`, `.env.local`, or provider API keys. Never put secrets in `NEXT_PUBLIC_*` variables.

## Documentation

| Doc | Purpose |
|-----|---------|
| [`docs/self-host.md`](docs/self-host.md) | Self-host run path and provider configuration |
| [`docs/m3.9-manual-smoke.md`](docs/m3.9-manual-smoke.md) | Manual smoke notes |
| [`docs/m3.9-logicc-manual-smoke.md`](docs/m3.9-logicc-manual-smoke.md) | Logicc live smoke procedure |

## Authoritative product line

The verified internal product tip is the `recover/m3.3-m3.4` line (Logicc vertical slice included). Obsolete Vitest-only lockfile/test setups from superseded main-side experiments must not be imported.
