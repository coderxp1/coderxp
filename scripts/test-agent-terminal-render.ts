/**
 * Agent terminal — React render verification.
 *
 * The browser build is blocked in-sandbox by the `next/font/google` fetches in
 * the unmodified `app/layout.tsx`, so the panel cannot be rendered through
 * Next.js here. This test closes that gap as far as it honestly can WITHOUT
 * touching `layout.tsx`: it bundles the real component tree with esbuild and
 * renders it to static markup with react-dom/server.
 *
 * What this proves: the React tree of RuntimePanel (including the new
 * AgentTerminalPanel) renders without throwing, emits the AGENT tab as a
 * distinct surface from the user's TERMINAL tab, and starts in an honest
 * "no session" state rather than a fabricated running one.
 *
 * What this does NOT prove: real browser layout, xterm canvas behaviour, or
 * live network streaming. Those remain unverified until the build completes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as esbuild from "esbuild";

const ENTRY = `
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { RuntimePanel } from "__RUNTIME_PANEL__";

export function render() {
  return renderToStaticMarkup(
    React.createElement(RuntimePanel, {
      output: [],
      previewUrl: null,
      activePort: 3000,
      projectId: "demo",
      useDevbox: false,
    }),
  );
}
`;

async function main(): Promise<void> {
  console.log("=== AGENT TERMINAL RENDER TESTS ===");

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-render-"));
  const entryPath = path.join(workDir, "entry.tsx");
  const root = process.cwd();
  // The bundle must live inside the repo tree so Node's upward node_modules
  // lookup resolves the externalized react/react-dom at runtime. node_modules
  // is gitignored and excluded from snapshots.
  const cacheDir = path.join(root, "node_modules", ".cache", "agent-render");
  fs.mkdirSync(cacheDir, { recursive: true });
  const bundlePath = path.join(cacheDir, `bundle-${process.pid}.cjs`);
  const panelAbs = path.join(root, "app", "workspace", "components", "RuntimePanel.tsx");
  fs.writeFileSync(entryPath, ENTRY.replace("__RUNTIME_PANEL__", panelAbs));

  try {
    await esbuild.build({
      entryPoints: [entryPath],
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "cjs",
      jsx: "automatic",
      // CSS is a no-op in SSR; xterm's stylesheet carries no render semantics.
      loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl", ".woff2": "dataurl" },
      // One React instance: keep the host copies authoritative.
      external: ["react", "react-dom", "react/jsx-runtime"],
      // Components import via the "@/..." tsconfig alias.
      alias: { "@": root },
      absWorkingDir: root,
      logLevel: "silent",
    });

    // xterm's addons read the `self` global at module scope. Provide it before
    // the bundle is required; renderToStaticMarkup still runs no effects, so no
    // DOM is touched and xterm is never constructed.
    const g = globalThis as Record<string, unknown>;
    if (g.self === undefined) g.self = globalThis;

    const mod = require(bundlePath) as { render(): string };
    const html = mod.render();
    if (process.env.DUMP_HTML === "1") {
      console.log(html);
      return;
    }

    assert.ok(html.length > 500, `rendered markup should be substantial, got ${html.length} bytes`);

    // Scope assertions to the agent pane so unrelated panes (the PORTS pane
    // legitimately renders a "RUNNING" pill) cannot satisfy or break a check.
    const agentStart = html.indexOf('data-pane="agent"');
    const portsStart = html.indexOf('data-pane="ports"');
    assert.ok(agentStart !== -1, "agent pane must render");
    assert.ok(portsStart > agentStart, "agent pane must precede the ports pane");
    const agent = html.slice(agentStart, portsStart);

    console.log("--- 1. AGENT surface renders as its own tab ---");
    assert.ok(html.includes('data-pane="terminal"'), "user TERMINAL pane must still render");
    assert.ok(/>\s*AGENT\s*</.test(html), "AGENT tab must be present");
    assert.ok(/>\s*TERMINAL\s*</.test(html), "user TERMINAL tab must still be present");
    assert.ok(/<strong[^>]*>AGENT<\/strong>/.test(agent), "agent pane must carry an AGENT label");
    console.log("[PASS] AGENT renders as its own pane and tab alongside the user TERMINAL.");

    console.log("--- 2. Initial state is honest, not fabricated ---");
    assert.ok(agent.includes("NO SESSION"), "initial session badge must read NO SESSION");
    assert.ok(agent.includes("no session"), "identity field must read no session");
    assert.ok(agent.includes("conn: idle"), "connection state must start idle");
    for (const bogus of ["RUNNING", "DEAD", ">UNKNOWN<"]) {
      assert.ok(!agent.includes(bogus), `must not claim ${bogus} before a session exists`);
    }
    console.log("[PASS] Renders NO SESSION / conn: idle — no fabricated running state.");

    console.log("--- 3. Observation is separated from input authority ---");
    assert.ok(agent.includes("observe-only"), "must show observe-only without a control lease");
    assert.ok(
      agent.includes("keystrokes are refused until you hold the user control lease"),
      "must state that keystrokes are refused without a lease",
    );
    assert.ok(agent.includes("Take input"), "must expose taking the input lease");
    assert.ok(agent.includes("Release input"), "must expose releasing the input lease");
    console.log("[PASS] Observe-only by default; input authority requires an explicit lease.");

    console.log("--- 4. Control surface is present ---");
    for (const label of ["Allocate", "Reconnect", "Resize", "Interrupt", "Stop", "Probe"]) {
      assert.ok(agent.includes(`>${label}</button>`), `control button missing: ${label}`);
    }
    assert.ok(
      agent.includes('aria-label="Agent session terminal"'),
      "terminal container must be labelled for assistive tech",
    );
    console.log("[PASS] Allocate/Reconnect/Resize/Interrupt/Stop/Probe all render.");

    console.log("--- 5. Controls that need a session are disabled ---");
    // Without a session every session-scoped control must be disabled; only
    // Allocate may be live.
    const disabled = (agent.match(/<button[^>]*disabled=""/g) ?? []).length;
    assert.equal(disabled, 7, `expected exactly 7 disabled controls, found ${disabled}`);
    assert.ok(
      /<button type="button">Allocate<\/button>/.test(agent),
      "Allocate must be the one enabled control",
    );
    console.log(`[PASS] ${disabled} session-scoped controls disabled; Allocate enabled.`);

    console.log("=== ALL AGENT TERMINAL RENDER TESTS PASSED ===");
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(bundlePath, { force: true });
  }
}

main().catch((err) => {
  console.error("Agent terminal render test failed:", err);
  process.exit(1);
});
