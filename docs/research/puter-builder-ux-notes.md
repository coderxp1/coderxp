# Puter Builder (`HeyPuter/builder`) — Architectural & UX Review Notes

**Document Version:** 1.0.0-draft  
**Status:** Draft for review  
**Target Release:** CoderXP 1.0  
**Author:** Hartmann <jp@coderxp.pro>  
**Reviewers:** Core Team  
**Subject Repository:** `https://github.com/HeyPuter/builder`  

---

## 1. Executive Summary & Review Scope

This document provides a technical and UX review of the open-source **Puter Builder** application codebase (`HeyPuter/builder`). Unlike Puter's broad desktop OS environment, `HeyPuter/builder` is a focused, web-based AI website and web application builder that leverages LLM tool-calling loops, a client-side execution sandbox, and conversational refinement workflows to construct web applications in real time.

The objective of this review is to analyze the source code, interaction patterns, prompt engineering, and state machines in `HeyPuter/builder` to identify which design paradigms CoderXP should **adopt**, **adapt**, or **reject**.

---

## 2. Source Code Architecture & Key Files

The `HeyPuter/builder` repository structure centers around a single-page application integrating LLM chat interactions with live web previews. Key files analyzed:

* **`README.md`:** Documents the core product philosophy: conversational website building, zero-setup instant preview, and instant deployment onto Puter's cloud infrastructure.
* **`package.json`:** Highlights minimal external dependencies; utilizes standard DOM manipulation and client-side libraries without heavy framework lock-in.
* **`src/tools.js`:** Defines the LLM tool-calling schema, including filesystem mutations (`write_file`, `read_file`, `list_files`), command executions, and preview state controls.
* **`src/prompt.js`:** Contains the system prompt, behavior rules, structured output instructions, and task decomposition guidelines provided to the generative model.

---

## 3. Analysis of Core UX & Architectural Patterns

### 3.1 Tool-Call Loop + Checkpointing
* **Implementation in `HeyPuter/builder`:**
  - The agent interacts with the workspace via a standard tool-calling loop (`call_tool`).
  - As files are modified, in-memory state snapshots or local storage records track versions before mutations.
  - When an error occurs or the user requests an undo, the builder reverts the workspace state to the prior checkpoint.
* **Assessment for CoderXP:** **ADAPT**
  - *Rationale:* In-memory client-side checkpointing is insufficient for full-stack Linux devboxes. CoderXP adapts this by executing an append-only, deterministic event store on the server. File mutations are recorded as git commits or copy-on-write snapshot points, allowing precise multi-file rollbacks without client state corruption.

### 3.2 TodoWrite Checklist
* **Implementation in `HeyPuter/builder`:**
  - The model outputs an explicit task checklist (often rendered as markdown checkboxes or structured JSON) representing the plan.
  - As the model executes tool calls (creating files, configuring scripts), it updates the checklist status from `pending` -> `in-progress` -> `completed`.
* **Assessment for CoderXP:** **ADOPT**
  - *Rationale:* Highly beneficial for human-in-the-loop (HITL) visibility. Displaying a real-time reactive task checklist in the CoderXP workspace sidebar allows users to follow multi-turn agent execution and understand exactly where the agent is in its overall plan.

### 3.3 One-Round Clarifying Questions
* **Implementation in `HeyPuter/builder`:**
  - Before writing complex code or embarking on multi-step generation, if the user prompt is underspecified (e.g., "Build me an online store"), the prompt instructs the model to pause and ask 2–3 targeted clarifying questions rather than guessing.
* **Assessment for CoderXP:** **ADOPT**
  - *Rationale:* Reduces token waste, prevents hallucinated architectures, and aligns agent design with developer intent. CoderXP adopts this through an interactive prompt triage turn before initializing devbox containers.

### 3.4 Click-to-Edit Preview Inspection
* **Implementation in `HeyPuter/builder`:**
  - The live preview iframe includes an inspector overlay. The user can click an element in the rendered UI (e.g., a header or button).
  - The inspector captures the element's selector and source location, automatically injecting a targeted prompt into the chat (e.g., "Change the color of this button to navy blue").
* **Assessment for CoderXP:** **ADAPT**
  - *Rationale:* Puter's preview is purely client-side static HTML/JS, making DOM-to-source mapping trivial. In CoderXP, applications are full-stack (Next.js, Python FastAPI, Go). CoderXP adapts this via a browser preview extension that maps React fiber components or HTML source tags back to workspace files, passing file paths to the agent.

### 3.5 Version History & Rollback
* **Implementation in `HeyPuter/builder`:**
  - Visual timeline allowing users to step backward and forward through prior generation turns.
  - Restoring a version resets both the file tree and the chat context to that point in time.
* **Assessment for CoderXP:** **ADOPT**
  - *Rationale:* Standard software development best practice. CoderXP integrates this directly with git commits generated per agent turn, giving users complete confidence that an erroneous turn can be undone cleanly with `git reset --hard`.

### 3.6 Publish State Machine
* **Implementation in `HeyPuter/builder`:**
  - Linear state progression: `DRAFT -> GENERATING -> PREVIEW_READY -> PUBLISHING -> LIVE`.
  - Tight coupling to Puter's hosting service (`puter.site.create()`).
* **Assessment for CoderXP:** **ADAPT**
  - *Rationale:* Puter locks publishing to its own ecosystem. CoderXP requires an open, multi-target publish pipeline supporting 4 distinct adapters: CoderXP Local Deploy, GitHub Push, Vercel Deploy, and Sanitized ZIP export. The state machine must handle asynchronous build verification and credential management per target.

### 3.7 Next-Step Suggestions
* **Implementation in `HeyPuter/builder`:**
  - Upon completing a generation turn, the model generates 3 contextual chips suggesting logical next steps (e.g., "Add authentication", "Connect a PostgreSQL database", "Improve responsive layout").
* **Assessment for CoderXP:** **ADOPT**
  - *Rationale:* Low implementation cost, high UX delight. Keeps the momentum going for semi-technical users and accelerates rapid prototyping.

---

## 4. Feature Categorization Matrix

| Pattern / Feature | Evaluation | Implementation Strategy for CoderXP |
| :--- | :--- | :--- |
| **TodoWrite Checklist** | **ADOPT** | Render reactive task progress widget in the workspace sidebar driven by orchestrator turn events. |
| **One-Round Clarifying Questions** | **ADOPT** | Enforce requirement triage prompt before agent turn loop initiates large code refactors. |
| **Next-Step Suggestions** | **ADOPT** | Parse trailing structured JSON chips from agent turn completions to render clickable prompt buttons. |
| **Version History & Rollback** | **ADOPT** | Link generation turns directly to git commit SHAs in the devbox repository. |
| **Tool-Call Loop + Checkpointing**| **ADAPT** | Replace client-side memory snapshots with server-side append-only event log and filesystem snapshots. |
| **Click-to-Edit Preview** | **ADAPT** | Build preview inspector mapping DOM elements to full-stack source files via AST/source maps. |
| **Publish State Machine** | **ADAPT** | Expand state machine to support 4 independent adapters (Local, GitHub, Vercel, ZIP). |
| **Client-Side Iframe Execution** | **REJECT** | Incompatible with full-stack development. CoderXP uses isolated Linux Docker devboxes. |
| **Unrestricted DOM Injection** | **REJECT** | Security hazard. CoderXP preview router enforces strict SSRF filters, Content Security Policies, and port binding rules. |
| **Proprietary Cloud Lock-In** | **REJECT** | Puter ties storage and hosting to `puter.js`. CoderXP relies on standard open-source tools (Docker, Git, POSIX APIs). |

---

## 5. Existing CoderXP Capabilities vs. Planned Puter-Inspired Features

### 5.1 Existing Capabilities in CoderXP (Baseline)
- Hardened server-side authentication (PBKDF2, session generation invalidation, multi-transport cookies/headers).
- Isolated container devbox broker with PTY terminal streaming over WebSocket.
- Live preview router with 128-bit slug resolution and SSRF protection (loopback/private IP blocking).
- Decoupled provider layer (`ITextModelProvider`, `IMediaJobService`) with strict fail-closed data policy gating (`ALLOW_EXTERNAL_TEXT_PROVIDERS`).
- Dedicated high-performance GPU server connectivity (ComfyUI 0.36.0 on 2x RTX PRO 6000 Blackwell).

### 5.2 Planned Features Inspired by Puter Builder
- Visual `TodoWrite` interactive task tracker widget in IDE sidebar.
- Click-to-edit preview inspector injecting file path contexts into agent prompt.
- Contextual next-step suggestion pills following successful agent turns.
- Visual commit-linked version timeline with one-click restore.

---

## 6. Sources Consulted

1. **Repository:** `github.com/HeyPuter/builder` (Commit `main` / release tags 2025–2026).
2. **Key Source Files Inspected:**
   - `https://github.com/HeyPuter/builder/blob/main/README.md` — Builder workflow and overview.
   - `https://github.com/HeyPuter/builder/blob/main/package.json` — Dependency topology and script definitions.
   - `https://github.com/HeyPuter/builder/blob/main/src/tools.js` — Agent tool definitions and execution handlers.
   - `https://github.com/HeyPuter/builder/blob/main/src/prompt.js` — System prompts and operational guidelines.
3. **Puter Platform API Documentation:** `docs.puter.com` — Primitives for `puter.js` storage and hosting.
4. **CoderXP Internal Specifications:**
   - `docs/design/autonomous-workspace-v1.md` — Core container isolation and security architecture.
   - `lib/server/providers/types.ts` — Invariant provider interface definitions.
