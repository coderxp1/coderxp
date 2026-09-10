"use client";

/**
 * Provider-neutral agent status for the workspace UI.
 * Fetches only sanitized health/models payloads — never credentials.
 */

import { useCallback, useEffect, useState } from "react";

export type AgentProviderUiStatus = "ready" | "unavailable" | "access_restricted" | "loading";

export interface AgentProviderModelOption {
  id: string;
  displayName: string;
}

export interface AgentProviderStatusState {
  loading: boolean;
  providerId: "logicc" | "anthropic-byok" | "anthropic" | null;
  displayName: string;
  byokRequired: boolean;
  ready: boolean;
  access: "internal" | "byok" | "restricted" | null;
  status: AgentProviderUiStatus;
  models: AgentProviderModelOption[];
  selectedModelId: string | null;
  selectedModelDisplayName: string | null;
  setSelectedModelId: (id: string) => void;
  refresh: () => void;
}

type HealthResponse = {
  ok?: boolean;
  provider?: string;
  providerId?: string;
  ready?: boolean;
  access?: "internal" | "byok" | "restricted";
  status?: string;
  byokRequired?: boolean;
  displayName?: string;
  defaultModelDisplayName?: string | null;
};

type ModelsResponse = {
  ok?: boolean;
  models?: AgentProviderModelOption[];
  defaultModelId?: string | null;
};

function mapStatus(raw: string | undefined, ready: boolean, access: string | null): AgentProviderUiStatus {
  if (raw === "access_restricted" || access === "restricted") return "access_restricted";
  if (raw === "ready" && ready) return "ready";
  if (ready) return "ready";
  return "unavailable";
}

export function useAgentProviderStatus(): AgentProviderStatusState {
  const [loading, setLoading] = useState(true);
  const [providerId, setProviderId] = useState<AgentProviderStatusState["providerId"]>(null);
  const [displayName, setDisplayName] = useState("Provider");
  const [byokRequired, setByokRequired] = useState(true);
  const [ready, setReady] = useState(false);
  const [access, setAccess] = useState<AgentProviderStatusState["access"]>(null);
  const [status, setStatus] = useState<AgentProviderUiStatus>("loading");
  const [models, setModels] = useState<AgentProviderModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [selectedModelDisplayName, setSelectedModelDisplayName] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const healthRes = await fetch("/api/agent/health", { method: "GET" });
        const health = (await healthRes.json()) as HealthResponse;
        if (cancelled) return;

        const pidRaw = health.providerId ?? health.provider ?? null;
        const pid =
          pidRaw === "logicc"
            ? "logicc"
            : pidRaw === "anthropic-byok" || pidRaw === "anthropic"
              ? (pidRaw as "anthropic-byok" | "anthropic")
              : null;

        setProviderId(pid);
        setDisplayName(health.displayName ?? (pid === "logicc" ? "Logicc" : "Anthropic"));
        setByokRequired(health.byokRequired !== false && pid !== "logicc");
        setReady(Boolean(health.ready));
        setAccess(health.access ?? null);
        setStatus(
          mapStatus(health.status, Boolean(health.ready), health.access ?? null),
        );

        if (health.access === "restricted" || health.status === "access_restricted") {
          setModels([]);
          setSelectedModelId(null);
          setSelectedModelDisplayName(null);
          return;
        }

        const modelsRes = await fetch("/api/agent/models", { method: "GET" });
        if (cancelled) return;
        if (!modelsRes.ok) {
          setModels([]);
          if (health.defaultModelDisplayName) {
            setSelectedModelDisplayName(health.defaultModelDisplayName);
          }
          return;
        }

        const modelsJson = (await modelsRes.json()) as ModelsResponse;
        const list = Array.isArray(modelsJson.models) ? modelsJson.models : [];
        setModels(list);

        const defaultId = modelsJson.defaultModelId ?? list[0]?.id ?? null;
        const initialSelected =
          defaultId && list.some((m) => m.id === defaultId) ? defaultId : list[0]?.id ?? null;
        setSelectedModelId(initialSelected);
        const selected = list.find((m) => m.id === initialSelected) ?? list[0];
        setSelectedModelDisplayName(
          selected?.displayName ?? health.defaultModelDisplayName ?? null,
        );
      } catch {
        if (!cancelled) {
          setStatus("unavailable");
          setReady(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const setSelectedModelIdSafe = useCallback(
    (id: string) => {
      setSelectedModelId(id);
      const match = models.find((m) => m.id === id);
      if (match) setSelectedModelDisplayName(match.displayName);
    },
    [models],
  );

  return {
    loading,
    providerId,
    displayName,
    byokRequired,
    ready,
    access,
    status,
    models,
    selectedModelId,
    selectedModelDisplayName,
    setSelectedModelId: setSelectedModelIdSafe,
    refresh,
  };
}
