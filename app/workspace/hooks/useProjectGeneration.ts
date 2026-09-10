"use client";

/**
 * The project ownership generation, shared by the agent subsystems.
 *
 * M3.5 kept this counter privately inside useAgentTools. M3.6 needs the same
 * value in two places — a tool call captures it, and an approval is bound to
 * it — so it moves here rather than being duplicated. Two counters that could
 * disagree would be worse than one shared one: an approval could outlive the
 * tool generation it was meant to authorize.
 *
 * The counter is a ref, not state. Bumping it must invalidate in-flight work
 * immediately, not after a render.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface ProjectGenerationApi {
  /** Current generation. Re-rendered consumers see the new value. */
  generation: number;
  /** Reads the live value from inside an async closure. */
  getGeneration: () => number;
  /** Invalidate everything bound to the current generation. */
  invalidate: () => void;
}

export function useProjectGeneration(projectId: string): ProjectGenerationApi {
  const generationRef = useRef(0);
  const [generation, setGeneration] = useState(0);
  const projectIdRef = useRef(projectId);

  const invalidate = useCallback(() => {
    generationRef.current += 1;
    setGeneration(generationRef.current);
  }, []);

  const getGeneration = useCallback(() => generationRef.current, []);

  // Real project switches only. A rerender must not invalidate active work.
  useEffect(() => {
    if (projectIdRef.current === projectId) return;
    projectIdRef.current = projectId;
    invalidate();
  }, [projectId, invalidate]);

  return { generation, getGeneration, invalidate };
}
