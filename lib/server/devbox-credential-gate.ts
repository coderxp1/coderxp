/**
 * Server-Side Git Credential Gate for CoderXP Phase A.
 *
 * Implements Amendment 2:
 * - Physical enforcement point for T3/T4 Git operations.
 * - Credentials are NEVER released until the user approves T3 operations.
 * - Supports session-scoped grants for feature branches.
 */

import { actionPolicyEngine } from "../devbox/action-policy";
import { hostEventStore } from "./devbox-event-store";
import type { ActionPolicyRequest } from "../devbox/event-types";

interface ApprovalGrant {
  projectId: string;
  branch: string;
  approvedAt: number;
  scope: "single" | "session";
}

class DevboxCredentialGate {
  private activeApprovals = new Map<string, ApprovalGrant[]>(); // projectId -> grants

  grantApproval(projectId: string, branch: string, scope: "single" | "session" = "single"): void {
    let grants = this.activeApprovals.get(projectId);
    if (!grants) {
      grants = [];
      this.activeApprovals.set(projectId, grants);
    }
    grants.push({ projectId, branch, approvedAt: Date.now(), scope });

    hostEventStore.recordEvent({
      projectId,
      tier: "T3",
      type: "approval.decided",
      data: {
        title: `Approval granted for branch ${branch}`,
        branch,
        scope,
        decision: "approved",
      },
    });
  }

  hasValidApproval(projectId: string, branch: string): boolean {
    const grants = this.activeApprovals.get(projectId);
    if (!grants || grants.length === 0) return false;

    const grantIndex = grants.findIndex((g) => g.branch === branch);
    if (grantIndex === -1) return false;

    const grant = grants[grantIndex];
    if (grant.scope === "single") {
      // Consume single-use grant
      grants.splice(grantIndex, 1);
    }
    return true;
  }

  /**
   * Evaluates policy before releasing git PAT credentials to the container.
   */
  requestGitCredentials(
    projectId: string,
    req: ActionPolicyRequest,
    serverPat: string,
  ): { allowed: boolean; pat?: string; error?: string } {
    const decision = actionPolicyEngine.evaluateAction(req);

    if (decision.requiresApproval) {
      const branch = req.branch || "main";
      if (!this.hasValidApproval(projectId, branch)) {
        hostEventStore.recordEvent({
          projectId,
          tier: decision.tier,
          type: "approval.requested",
          data: {
            title: `Action requires approval: ${decision.reason}`,
            branch,
            command: req.command,
          },
        });
        return {
          allowed: false,
          error: `APPROVAL_REQUIRED: ${decision.reason}`,
        };
      }
    }

    // Allowed (T0/T1/T2 or approved T3) -> Release credential
    return { allowed: true, pat: serverPat };
  }
}

export const devboxCredentialGate = new DevboxCredentialGate();
