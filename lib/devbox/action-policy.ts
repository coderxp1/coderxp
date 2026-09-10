/**
 * 5-Tier Unified Action Policy Engine for CoderXP Phase A.
 *
 * Implements Roadmap §0 & Amendments 2, 4:
 * - Maps every agent/system action to a strict tier T0-T4.
 * - Handles untrustedContext tier elevation (+1).
 * - Enforces hard gates on T3 (approval card) & T4 (typed confirmation).
 */

import type { ActionPolicyRequest, ActionPolicyDecision, EventTier } from "./event-types";

export class ActionPolicyEngine {
  private elevateTier(tier: EventTier): EventTier {
    switch (tier) {
      case "T0":
        return "T1";
      case "T1":
        return "T2";
      case "T2":
        return "T3";
      case "T3":
      case "T4":
        return "T4";
    }
  }

  evaluateAction(req: ActionPolicyRequest): ActionPolicyDecision {
    let baseTier: EventTier = "T0";
    let requiresApproval = false;
    let requiresTypedConfirmation = false;
    let undoable = false;
    let rollbackCommand: string | undefined;
    let reason: string | undefined;

    switch (req.type) {
      case "fs_read":
        baseTier = "T0";
        break;

      case "fs_write":
      case "git_commit":
        baseTier = "T1";
        break;

      case "exec_cmd": {
        const cmd = (req.command || "").toLowerCase();
        const argsStr = (req.args || []).join(" ").toLowerCase();

        // Testing, building, linting -> T0
        if (
          cmd.includes("test") ||
          argsStr.includes("test") ||
          cmd.includes("lint") ||
          argsStr.includes("lint") ||
          cmd.includes("build") ||
          argsStr.includes("build")
        ) {
          baseTier = "T0";
        }
        // Package installs and dev servers -> T1
        else if (
          cmd.includes("npm") ||
          cmd.includes("pip") ||
          cmd.includes("pnpm") ||
          cmd.includes("yarn") ||
          cmd.includes("apt")
        ) {
          baseTier = "T1";
        } else {
          baseTier = "T1";
        }
        break;
      }

      case "git_push": {
        const branch = req.branch || "main";
        const isDefault =
          req.isDefaultBranch ??
          (branch === "main" || branch === "master" || branch.endsWith("/main") || branch.endsWith("/master"));
        const isForce = req.isForce ?? false;
        const isDelete = req.isDelete ?? false;

        // Pushing to default branch, force-pushing, or deleting remote refs is ALWAYS T3 (Amendment 4)
        if (isDefault || isForce || isDelete) {
          baseTier = "T3";
          requiresApproval = true;
          undoable = true;
          reason = isForce
            ? `Force-pushing to branch "${branch}" requires explicit approval.`
            : isDefault
            ? `Pushing to default branch "${branch}" requires approval.`
            : `Deleting remote branch "${branch}" requires approval.`;
        } else {
          // Push to feature branch is T2 (Notify with 1-click rollback)
          baseTier = "T2";
          undoable = true;
          reason = `Pushing to feature branch "${branch}".`;
        }
        break;
      }

      case "pr_merge":
      case "deploy":
        baseTier = "T3";
        requiresApproval = true;
        reason = `Deploying or merging PR requires explicit approval.`;
        break;

      case "billing":
        baseTier = "T4";
        requiresApproval = true;
        requiresTypedConfirmation = true;
        reason = `Financial transactions or user account deletion require typed confirmation.`;
        break;
    }

    // Apply untrustedContext tier elevation (+1)
    let effectiveTier = baseTier;
    if (req.untrustedContext) {
      effectiveTier = this.elevateTier(baseTier);
      if (effectiveTier === "T3" || effectiveTier === "T4") {
        requiresApproval = true;
      }
      if (effectiveTier === "T4") {
        requiresTypedConfirmation = true;
      }
    }

    return {
      tier: effectiveTier,
      allowed: !requiresApproval && !requiresTypedConfirmation,
      requiresApproval,
      requiresTypedConfirmation,
      undoable,
      rollbackCommand,
      reason,
    };
  }
}

export const actionPolicyEngine = new ActionPolicyEngine();
