/**
 * Command Execution Safety Layer for CoderXP M3 / Workspace v2.
 *
 * Implements Directive §9.1:
 * - Destructive commands (rm -rf, git push -f, git reset --hard, curl | sh, etc.)
 *   MUST require explicit human approval in ALL permission modes, including Autonomous.
 * - Commands execute via argv arrays (never interpolated strings).
 * - Safe commands (install/build/lint/test/status/diff) are defined in an explicit allowlist.
 */

import type { AgentPermissionMode } from "./agent-permissions";

export type CommandRiskLevel = "safe" | "action" | "destructive";

export interface CommandRiskEvaluation {
  risk: CommandRiskLevel;
  requiresApproval: boolean;
  reason?: string;
}

/**
 * Explicit allowlist of safe, non-destructive commands.
 * These can run automatically in "auto-safe" and "autonomous" modes.
 */
export const SAFE_COMMAND_ALLOWLIST: Array<{ cmd: string; subcommands?: string[] }> = [
  { cmd: "npm", subcommands: ["test", "run", "install", "ci", "list", "outdated", "audit"] },
  { cmd: "npx", subcommands: ["tsc", "eslint", "prettier", "jest", "vitest", "tsx"] },
  { cmd: "pnpm", subcommands: ["test", "run", "install", "list", "audit"] },
  { cmd: "yarn", subcommands: ["test", "build", "lint", "install", "list", "audit"] },
  { cmd: "git", subcommands: ["status", "diff", "log", "branch", "show", "tag", "remote"] },
  { cmd: "ls" },
  { cmd: "dir" },
  { cmd: "pwd" },
  { cmd: "cat" },
  { cmd: "echo" },
  { cmd: "node", subcommands: ["--version", "-v"] },
];

/**
 * Destructive command patterns that ALWAYS require explicit approval,
 * regardless of permission mode (including autonomous mode).
 */
export const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  // Deletion and removal
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive\s+--force|--force\s+--recursive)/i,
  /\brm\s+(-r|-rf|-fr|--recursive)/i,
  /\brmdir\s+\/s/i,
  // Git history rewriting and force pushes
  /\bgit\s+push\s+.*(-f|--force|--force-with-lease)/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+(-[a-zA-Z]*f|--force)/i,
  /\bgit\s+rebase\b/i,
  /\bgit\s+branch\s+(-D|--delete\s+--force)/i,
  // Piping remote content directly into shell
  /\b(curl|wget|fetch)\b.*\|\s*(sh|bash|zsh|powershell|pwsh|cmd)/i,
  // System-level destruction
  /\bchmod\s+(-R\s+777|777)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(drop|truncate)\s+(table|database|schema)\b/i,
];

/**
 * Checks if a command line or argv represents a destructive action.
 */
export function isDestructiveCommand(argv: string[]): boolean {
  if (!argv || argv.length === 0) return false;
  const fullCommand = argv.join(" ");

  for (const pattern of DESTRUCTIVE_COMMAND_PATTERNS) {
    if (pattern.test(fullCommand)) {
      return true;
    }
  }

  // Check specific argument combinations
  const base = argv[0]?.toLowerCase();
  if (base === "rm") {
    const hasR = argv.some((a) => a === "-r" || a === "-rf" || a === "-fr" || a === "--recursive");
    if (hasR) return true;
  }
  if (base === "git") {
    const sub = argv[1]?.toLowerCase();
    if (sub === "push" && argv.some((a) => a === "-f" || a === "--force" || a === "--force-with-lease")) {
      return true;
    }
    if (sub === "reset" && argv.includes("--hard")) {
      return true;
    }
    if (sub === "clean" && argv.some((a) => a === "-f" || a === "-fd" || a === "--force")) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a command is in the auto-safe allowlist.
 */
export function isSafeCommand(argv: string[]): boolean {
  if (!argv || argv.length === 0) return false;
  if (isDestructiveCommand(argv)) return false;

  const base = argv[0]?.toLowerCase();
  const sub = argv[1]?.toLowerCase();

  for (const entry of SAFE_COMMAND_ALLOWLIST) {
    if (entry.cmd === base) {
      if (!entry.subcommands || entry.subcommands.length === 0) {
        return true;
      }
      if (sub && entry.subcommands.includes(sub)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Evaluates the risk level and approval requirement for a given command.
 *
 * Enforcement rules:
 * - Destructive: requiresApproval is ALWAYS true (even in autonomous mode).
 * - Safe: requiresApproval is false in "auto-safe" and "autonomous", true in "ask".
 * - Action (normal): requiresApproval is false in "autonomous", true in "ask" and "auto-safe".
 */
export function evaluateCommandRisk(
  argv: string[],
  mode: AgentPermissionMode = "ask",
): CommandRiskEvaluation {
  if (isDestructiveCommand(argv)) {
    return {
      risk: "destructive",
      requiresApproval: true,
      reason: "Destructive command requires mandatory human approval in all permission modes.",
    };
  }

  if (isSafeCommand(argv)) {
    return {
      risk: "safe",
      requiresApproval: mode === "ask",
      reason: mode === "ask" ? "Permission mode is set to Ask before actions." : undefined,
    };
  }

  return {
    risk: "action",
    requiresApproval: mode !== "autonomous",
    reason: mode !== "autonomous" ? `Permission mode "${mode}" requires approval for general commands.` : undefined,
  };
}
