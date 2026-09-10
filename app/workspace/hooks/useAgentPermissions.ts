"use client";

/**
 * React binding for the M3.6 permission controller.
 *
 * The controller itself is plain TypeScript in `lib/workspace/agent-permissions`
 * so the M3.7 execution loop can drive it from an async loop and the tests can
 * drive it without a DOM. This hook only does three things: keep one controller
 * instance alive, re-render when its pending set or mode changes, and load and
 * save the mode preference.
 *
 * No tool is executed here. A component may approve or deny; it may not run
 * anything, which is why nothing in this file imports the tool handlers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPreference, setPreference } from "@/lib/workspace/persistence";
import {
  AgentPermissionController,
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  permissionModePreferenceKey,
  type AgentApprovalRequest,
  type AgentPermissionMode,
} from "@/lib/workspace/agent-permissions";

export interface AgentPermissionsApi {
  /** The controller. Passed to useAgentTools; not for direct UI mutation. */
  controller: AgentPermissionController;
  mode: AgentPermissionMode;
  setMode: (mode: AgentPermissionMode) => void;
  /** Pending approvals for the open project, oldest first. */
  pending: AgentApprovalRequest[];
  /** Resolve one exact pending approval. False when it no longer applies. */
  approve: (approvalId: string) => boolean;
  deny: (approvalId: string) => boolean;
  cancel: (approvalId: string) => boolean;
}

export interface UseAgentPermissionsOptions {
  projectId: string;
  /**
   * The live project generation from useAgentTools. Approvals are bound to it,
   * so resolving one requires the generation to still match.
   */
  generation: number;
}

export function useAgentPermissions(
  options: UseAgentPermissionsOptions,
): AgentPermissionsApi {
  const { projectId, generation } = options;

  const [revision, setRevision] = useState(0);

  const generationRef = useRef(generation);
  useEffect(() => {
    generationRef.current = generation;
  });

  const controller = useMemo(
    () => new AgentPermissionController({ onChange: () => setRevision((n) => n + 1) }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let stored: unknown;
      try {
        stored = (await getPreference(permissionModePreferenceKey(projectId)))?.value;
      } catch {
        stored = undefined;
      }
      if (cancelled) return;
      controller.setMode(isPermissionMode(stored) ? stored : DEFAULT_PERMISSION_MODE);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, controller]);

  const projectIdRef = useRef(projectId);
  useEffect(() => {
    if (projectIdRef.current === projectId) return;
    projectIdRef.current = projectId;
    controller.cancelAll("expired");
  }, [projectId, controller]);

  useEffect(() => {
    return () => {
      controller.cancelAll("expired");
    };
  }, [controller]);

  const setMode = useCallback(
    (mode: AgentPermissionMode) => {
      controller.setMode(mode);
      void setPreference(permissionModePreferenceKey(projectId), mode).catch(() => {});
    },
    [controller, projectId],
  );

  const approve = useCallback(
    (approvalId: string) => controller.approve(approvalId, generationRef.current),
    [controller],
  );

  const deny = useCallback(
    (approvalId: string) => controller.deny(approvalId, generationRef.current),
    [controller],
  );

  const cancel = useCallback(
    (approvalId: string) => controller.cancel(approvalId),
    [controller],
  );

  // revision is the dependency that makes a controller mutation re-render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mode = useMemo(() => controller.getMode(), [controller, revision]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pending = useMemo(() => controller.getPending(), [controller, revision]);

  return { controller, mode, setMode, pending, approve, deny, cancel };
}
