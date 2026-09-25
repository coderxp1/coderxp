# Puter Builder (`HeyPuter/builder`) — Architectural & UX Review Notes

**Document Version:** 1.0.0-draft  
**Status:** Draft for review  
**Target Release:** CoderXP 1.0  
**Author:** Hartmann <jp@coderxp.pro>  
**Reviewers:** Core Team  
**Subject Repository:** `https://github.com/HeyPuter/builder`  
**Reviewed Commit:** `0f80e08a30f30e7631e9c10015b6a11c9f438aca` (HEAD)  

---

## 1. Executive Summary & Review Scope

This document provides a technical and UX review of the open-source **Puter Builder** codebase (`HeyPuter/builder`), reviewed directly against Git commit `0f80e08a30f30e7631e9c10015b6a11c9f438aca`. `HeyPuter/builder` is an in-browser AI website and web application builder that leverages LLM streaming, client-side tool execution, and an iframe preview bridge to create and iterate on web applications.

The purpose of this review is to evaluate the real source code structure, tool loop, progress indicators, preview bridges, versioning, and publishing mechanisms in `HeyPuter/builder`, establishing concrete **Adopt**, **Adapt**, or **Reject** recommendations for CoderXP.

---

## 2. Source Code Architecture & Real Repository Layout

The actual codebase structure of `HeyPuter/builder` at commit `0f80e08` consists of:

* **`README.md` & `package.json`:** Defines dependencies (`marked`, `jquery`, `jszip`, `highlight.js`) and build scripts (`scripts/build-sw.mjs`, `scripts/build-seo.mjs`).
* **`src/index.html` & `src/sw.js`:** Single-page application shell and service-worker asset cache.
* **`src/runtime.js`:** Injected runtime script serving two functions: (1) the "Built with Puter" badge, and (2) the cross-origin element-picker bridge for click-to-edit preview inspection.
* **`src/tools/`:** Concrete tool definitions pushed to `window.tools`:
  - `src/tools/apps_and_sites/publish_site.js`: Hosts project draft to preview subdomain via `puter.hosting.create()`.
  - `src/tools/apps_and_sites/update_preview.js`: Signals preview iframe reload.
  - `src/tools/chat_ui/todo.js`: Defines `TodoWrite` for tracking user-visible progress checklists.
  - `src/tools/chat_ui/clarify.js`: Defines `AskClarifyingQuestions` tool with interactive UI card.
  - `src/tools/chat_ui/suggest.js`: Defines `SuggestNextSteps` for post-build follow-up chips.
  - `src/tools/fs/`: Direct filesystem tools (`write.js`, `edit.js`, `multi_edit.js`, `read.js`, `delete.js`, `mkdir.js`).
* **`src/js/`:** Core application logic:
  - `src/js/handleMessageStream.js`: Stream processing loop handling `reasoning`, `text`, `usage`, and `tool_use`.
  - `src/js/tools.js`: Tool dispatch engine (`handleToolCalls`, `executeFunction`, `window.tools`).
  - `src/js/versions.js`: Project snapshotting and checkpoint restore manager (`markProjectModified`, `restoreVersion`).
  - `src/js/publish-state.js`: Single source of truth for publish button states (`unpublished`, `clean`, `dirty`).
  - `src/js/ui.js`: DOM event wiring, toolbar toggles, and click-to-edit intake.
  - `src/js/prompt.js`: System prompt configuration and prompt assembly.

---

## 3. Analysis of Core UX & Architectural Patterns

### 3.1 Tool-Call Loop & Checkpointing

* **Source File:** `src/js/handleMessageStream.js` (lines 289–300) and `src/js/tools.js` (lines 60–100)
* **Code Excerpt:**
```javascript
// src/js/handleMessageStream.js:289-300
if (completion.type === "tool_use") {
    clearThinking();
    startSpinnerStub();

    // Save before and after a tool call incase the user quits
    saveCurrentMessage(context);
    const result = await handleToolCalls(completion, true, context);
    saveCurrentMessage(context);
    if (result.error || shouldStop) {
        break;
    }
}
```
* **Source File (Checkpointing trigger):** `src/js/versions.js` (lines 26, 34–43)
* **Code Excerpt:**
```javascript
// src/js/versions.js:26, 34-43
const MUTATING_TOOLS = new Set(['write', 'edit', 'multi_edit', 'delete', 'copy', 'move', 'rename', 'mkdir', 'create_worker']);

window.markProjectModified = function (toolName, chatId) {
    if (toolName && !MUTATING_TOOLS.has(toolName)) return;
    window._filesChangedThisTurn = (window._filesChangedThisTurn || 0) + 1;
    markDirty(chatId || openChatId());
};
```
* **Analysis & Verdict:** **ADAPT**
  - In `HeyPuter/builder`, tool calls are parsed from the SSE stream and dispatched in client-side JavaScript (`handleToolCalls`). When mutating tools run, `markProjectModified` flags the project as dirty, and an end-of-turn snapshot copies files into `AppData/<appID>/.versions/<chatId>/`.
  - *CoderXP Adaptation:* CoderXP runs full-stack Linux containers on the server rather than client-side Puter virtual files. We adapt this pattern by intercepting tool calls in server-side orchestrator middleware, routing commands through `AuthzGate`, and creating atomic git commits in the container workspace volume at the end of each turn.

---

### 3.2 TodoWrite Checklist

* **Source File:** `src/tools/chat_ui/todo.js` (lines 199–226, 236–244)
* **Code Excerpt:**
```javascript
// src/tools/chat_ui/todo.js:199-244
window.tools.push({
    type: "function",
    function: {
        name: "TodoWrite",
        description: "Tracks task progress by creating and updating a todo list that's visible to users. Every call must send the complete todos array. IMPORTANT: before writing your end-of-turn summary, always make one final call marking every finished item "completed" — never end a turn with an item still "in_progress".",
        parameters: {
            type: "object",
            properties: {
                todos: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            content: { type: "string", description: "A short, plain-language description..." },
                            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                            id: { type: "string", description: "Unique identifier for the todo" }
                        },
                        required: ["content", "status", "id"]
                    }
                }
            },
            required: ["todos"]
        }
    },
    exec: async function(args) {
        window.currentTodos = args.todos;
        updateTodoDisplay(args.todos);
        return { success: true };
    }
});
```
* **Analysis & Verdict:** **ADOPT**
  - The `TodoWrite` tool gives users instant visibility into the model's multi-step plan. An active item receives a `.todo-in_progress` shimmer animation (`src/tools/chat_ui/todo.js:49`), while narration text is suppressed from cluttering the UI until the checklist finishes (`src/js/handleMessageStream.js:253`).
  - *CoderXP Adoption:* Directly adopt this tool schema into the CoderXP agent toolset. Render the checklist in the workspace UI sidebar, driven by monotonic turn events.

---

### 3.3 One-Round Clarifying Questions

* **Source File:** `src/tools/chat_ui/clarify.js` (lines 3–9, 383–410)
* **Code Excerpt:**
```javascript
// src/tools/chat_ui/clarify.js:3-9, 406-410
// When the user's request is too vague to build confidently, the model can call
// AskClarifyingQuestions with up to TWO short questions, each with a few concrete
// options. We render an interactive card in the chat, BLOCK the agentic loop
// inside exec() until the user answers...
exec: async function (args, context) {
    ...
    // Block here until the user resolves the card. The result is returned
    // as the tool_result, so the agentic loop continues and the model
    // builds with these answers in the same turn.
    return await runClarification(questions, context || {});
}
```
* **Analysis & Verdict:** **ADOPT**
  - When a prompt is ambiguous, `AskClarifyingQuestions` renders an interactive multi-choice card and suspends the agent loop via `runClarification` Promise resolution until the user selects options or clicks skip.
  - *CoderXP Adoption:* Adopt the single-round clarifying question pattern to reduce token waste and prevent incorrect architectural assumptions during initial workspace scaffolding.

---

### 3.4 Click-to-Edit Preview Inspection

* **Source File:** `src/runtime.js` (lines 218–224, 255–260) and `src/js/ui.js` (lines 1259–1280)
* **Code Excerpt:**
```javascript
// src/runtime.js:218-224
// Click-to-edit: the builder's preview pane is cross-origin (apps are served
// from *.puter.site), so the builder cannot reach into the app's DOM. This
// bridge is the other end of that gap — it stays completely dormant until the
// builder posts {type:'puter-select-mode', enabled:true}, then outlines the
// hovered element and, on the next click, posts a locator for it back.
```
```javascript
// src/js/ui.js:1270-1280
window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'puter-element-selected') return;
    // e.data carries: { tag, text, selector, outerHTML }
    armClickToEditTarget(e.data);
});
```
* **Analysis & Verdict:** **ADAPT**
  - Puter bridges cross-origin iframe security via `postMessage`. Clicking an element sends selector and snippet data back to the builder, creating an armed target chip in the chat composer.
  - *CoderXP Adaptation:* In static HTML, selectors map easily to source lines. For full-stack React/Next.js and FastAPI apps in CoderXP, we adapt this by injecting a React component tree / DOM inspector into preview containers that resolves DOM elements to specific workspace source files and line numbers.

---

### 3.5 Version History & Rollback

* **Source File:** `src/js/versions.js` (lines 1–12, 19)
* **Code Excerpt:**
```javascript
// src/js/versions.js:1-12, 19
// versions.js — Project version history (checkpoints) with one-click rollback.
//
// After every AI turn that modifies the project files, a full snapshot of the
// app directory is taken automatically. Snapshots are stored OUTSIDE the
// published app directory — under /<user>/AppData/<appID>/.versions/<chatId>/ —
// so they are never served by hosting, never included in the project download...
const MAX_VERSIONS = 30;
```
* **Analysis & Verdict:** **ADOPT**
  - Checkpoint history allows users to inspect and restore previous working states if an agent turn introduces defects.
  - *CoderXP Adoption:* Adopt the checkpoint concept directly into CoderXP devboxes, binding versions to immutable Git commit SHAs rather than filesystem directory copies.

---

### 3.6 Publish State Machine

* **Source File:** `src/js/publish-state.js` (lines 28–51)
* **Code Excerpt:**
```javascript
// src/js/publish-state.js:28-51
window.computePublishState = function (opts) {
    opts = opts || {};
    const publishedUrl = opts.publishedUrl || null;

    if (!publishedUrl) {
        return { state: 'unpublished', dirty: false, label: 'Publish' };
    }

    const versionMoved = !!opts.currentVersionId && opts.currentVersionId !== opts.publishedVersionId;
    const dirty = versionMoved || !!opts.dirtySinceSnapshot;

    return dirty
        ? { state: 'dirty', dirty: true, label: 'Publish changes' }
        : { state: 'clean', dirty: false, label: 'Published' };
};
```
* **Analysis & Verdict:** **ADAPT**
  - HeyPuter uses a 3-state pure function (`unpublished`, `clean`, `dirty`) tied exclusively to `puter.hosting.create()`.
  - *CoderXP Adaptation:* CoderXP adapts this into a multi-target state machine supporting 4 independent publish adapters (CoderXP Deploy, GitHub Push, Vercel, ZIP export) with explicit build verification and authentication gates.

---

### 3.7 Next-Step Suggestions

* **Source File:** `src/tools/chat_ui/suggest.js` (lines 23–49, 70–73)
* **Code Excerpt:**
```javascript
// src/tools/chat_ui/suggest.js:23-49
window.tools.push({
    type: "function",
    function: {
        name: "SuggestNextSteps",
        description: "Show the user 4-5 one-click "what next?" suggestion chips above the input. Call this exactly ONCE as the final action of any turn that built or modified the app (after update_preview and your summary)...",
        parameters: {
            type: "object",
            properties: {
                suggestions: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            label: { type: "string" },
                            prompt: { type: "string" }
                        },
                        required: ["label", "prompt"]
                    }
                }
            },
            required: ["suggestions"]
        }
    },
    exec: async function (args) {
        window._pendingTurnSuggestions = args.suggestions;
        return { success: true };
    }
});
```
* **Analysis & Verdict:** **ADOPT**
  - Having the generating model propose context-aware next steps at turn end provides immediate velocity for rapid prototyping.
  - *CoderXP Adoption:* Adopt the `SuggestNextSteps` schema and render suggestions as clickable quick-action buttons above the CoderXP chat input.

---

## 4. Feature Categorization Matrix

| Pattern / Feature | Real File Path in `HeyPuter/builder` | Verdict | Rationale & CoderXP Plan |
| :--- | :--- | :--- | :--- |
| **TodoWrite Checklist** | `src/tools/chat_ui/todo.js` | **ADOPT** | High user visibility during multi-step tasks; suppresses narration during execution. Render reactive checklist in CoderXP sidebar. |
| **One-Round Clarifying Questions** | `src/tools/chat_ui/clarify.js` | **ADOPT** | Blocks loop to resolve ambiguity without token waste. Adopt directly for initial project scaffolding. |
| **Next-Step Suggestions** | `src/tools/chat_ui/suggest.js` | **ADOPT** | High UX value; model provides grounded follow-up prompts. Render as clickable suggestion pills. |
| **Version History & Rollback** | `src/js/versions.js` | **ADOPT** | Crucial safety net. Map version checkpoints directly to git commits in devbox containers. |
| **Tool-Call Loop & Checkpointing**| `src/js/handleMessageStream.js`, `src/js/tools.js` | **ADAPT** | Replace client-side Puter FS mutations with server-side orchestrator middleware and Linux devbox execution. |
| **Click-to-Edit Preview** | `src/runtime.js`, `src/js/ui.js` | **ADAPT** | Adapt cross-origin DOM bridge to full-stack React/FastAPI apps via component tree and source-map resolution. |
| **Publish State Machine** | `src/js/publish-state.js` | **ADAPT** | Generalize from Puter's 3-state hosting model to 4 independent target adapters (Local, GitHub, Vercel, ZIP). |
| **Client-Side Iframe Execution** | `src/index.html`, `src/runtime.js` | **REJECT** | Incompatible with full-stack Linux apps (Next.js, Python, Go). CoderXP uses hardened Docker devboxes. |
| **Proprietary Cloud Lock-In** | `src/tools/apps_and_sites/publish_site.js` | **REJECT** | Puter couples hosting and storage to `puter.js`. CoderXP relies strictly on standard open-source tools and protocols. |

---

## 5. Existing CoderXP Capabilities vs. Planned Puter-Inspired Features

### 5.1 Existing Capabilities in CoderXP (Baseline @ `414f34a`)
- Containerized Linux devboxes with unprivileged execution (`UID 1000:GID 1000`) (`lib/server/devbox-broker.ts:90-91`).
- WebSocket PTY terminal streaming via node-pty (`lib/server/devbox-broker.ts:310-380`).
- Live preview routing via cryptographically random 128-bit hex slug with SSRF protection (`lib/server/preview-link-store.ts`, `lib/server/preview-router.ts`).
- Server-side BYOK and provider gateway with strict fail-closed data policy gating (`lib/server/providers/openrouter-provider.ts`).
- Dedicated high-performance GPU server connectivity (ComfyUI 0.36.0 on RTX PRO 6000 Blackwell).

### 5.2 Planned Features Inspired by Puter Builder
- Interactive `TodoWrite` progress checklist rendered in IDE sidebar.
- Single-round `AskClarifyingQuestions` interactive card before commencing ambiguous builds.
- Contextual `SuggestNextSteps` prompt pills rendered above chat composer.
- Full-stack click-to-edit preview inspector mapping UI elements to source files.
- Visual commit-linked version history panel with one-click restore.

---

## 6. Sources Consulted

1. **Repository:** `github.com/HeyPuter/builder` (commit `0f80e08a30f30e7631e9c10015b6a11c9f438aca`, HEAD as of September 2026).
2. **Source Files Inspected:**
   - `src/js/handleMessageStream.js` — Stream iteration, tool-call execution, and usage accumulation.
   - `src/js/tools.js` — Function dispatch, tool registry, and error envelope formatting.
   - `src/tools/chat_ui/todo.js` — `TodoWrite` tool specification and checklist DOM renderer.
   - `src/tools/chat_ui/clarify.js` — `AskClarifyingQuestions` tool specification and interactive prompt card.
   - `src/tools/chat_ui/suggest.js` — `SuggestNextSteps` tool specification and follow-up chip generator.
   - `src/runtime.js` — Cross-origin click-to-edit element picker bridge and badge injection.
   - `src/js/ui.js` — User interface controller, element selection listener, and event bindings.
   - `src/js/versions.js` — Directory snapshotting, dirty state tracking, and version restore manager.
   - `src/js/publish-state.js` — Tri-state publish state calculator (`unpublished`, `clean`, `dirty`).
   - `src/tools/apps_and_sites/publish_site.js` — Live preview hosting setup via Puter cloud.
3. **CoderXP Codebase (`main` @ `414f34a`):**
   - `lib/server/devbox-broker.ts` — Docker container lifecycle and resource management.
   - `lib/devbox/action-policy.ts` — Action risk classification and gate evaluation.
   - `lib/workspace/agent-execution-runtime.ts` — Agent execution turn and approval state machine.
   - `lib/server/providers/types.ts` — Decoupled provider interface definitions (`ITextModelProvider`, `IMediaJobService`).
