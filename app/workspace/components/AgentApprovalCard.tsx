"use client";

/**
 * Approval card and mode selector for the M3.6 permission layer.
 *
 * This component renders the controller state that useAgentPermissions exposes.
 * It never executes a tool call itself: approving or denying only changes the
 * controller's state, and the execution loop re-evaluates the call and runs it
 * when a decision permits it.
 */

import type { AgentApprovalRequest, AgentPermissionMode } from "@/lib/workspace/agent-permissions";
import {
  PERMISSION_MODE_DESCRIPTIONS,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_SHORT_LABELS,
} from "@/lib/workspace/agent-permissions";

export interface AgentModeSelectorProps {
  mode: AgentPermissionMode;
  setMode: (mode: AgentPermissionMode) => void;
}

export function AgentModeSelector(props: AgentModeSelectorProps) {
  const { mode, setMode } = props;

  return (
    <div className="agent-mode-selector">
      <label className="agent-mode-label">Agent permissions</label>
      <div className="agent-mode-options">
        {Object.entries(PERMISSION_MODE_LABELS).map(([key, label]) => {
          const value = key as AgentPermissionMode;
          const short = PERMISSION_MODE_SHORT_LABELS[value];
          const description = PERMISSION_MODE_DESCRIPTIONS[value];
          const selected = mode === value;
          return (
            <button
              key={value}
              type="button"
              className={selected ? "agent-mode-option agent-mode-option--selected" : "agent-mode-option"}
              onClick={() => setMode(value)}
            >
              <div className="agent-mode-option-main">
                <span className="agent-mode-option-short">{short}</span>
                <span className="agent-mode-option-label">{label}</span>
              </div>
              <div className="agent-mode-option-description">{description}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface AgentApprovalCardProps {
  approval: AgentApprovalRequest;
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
  onCancel: (approvalId: string) => void;
}

export function AgentApprovalCard(props: AgentApprovalCardProps) {
  const { approval, onApprove, onDeny, onCancel } = props;

  return (
    <div className="agent-approval-card">
      <div className="agent-approval-header">
        <span className="agent-approval-title">Agent wants to run {approval.toolName}</span>
        <span className="agent-approval-risk">{approval.risk}</span>
      </div>
      <div className="agent-approval-summary">{approval.summary}</div>
      <div className="agent-approval-actions">
        <button
          type="button"
          className="agent-approval-approve"
          onClick={() => onApprove(approval.approvalId)}
        >
          Approve once
        </button>
        <button
          type="button"
          className="agent-approval-deny"
          onClick={() => onDeny(approval.approvalId)}
        >
          Deny
        </button>
        <button
          type="button"
          className="agent-approval-cancel"
          onClick={() => onCancel(approval.approvalId)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export interface AgentApprovalListProps {
  pending: AgentApprovalRequest[];
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
  onCancel: (approvalId: string) => void;
}

export function AgentApprovalList(props: AgentApprovalListProps) {
  const { pending, onApprove, onDeny, onCancel } = props;

  if (pending.length === 0) {
    return null;
  }

  return (
    <div className="agent-approval-list">
      {pending.map((approval) => (
        <AgentApprovalCard
          key={approval.approvalId}
          approval={approval}
          onApprove={onApprove}
          onDeny={onDeny}
          onCancel={onCancel}
        />
      ))}
    </div>
  );
}
