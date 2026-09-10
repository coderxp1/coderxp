import { useRef, useState, useCallback, useEffect } from "react";

export type ByokValidationStatus = "unverified" | "active" | "error";

export interface ByokCredentialActions {
  hasKey: boolean;
  status: ByokValidationStatus;
  provider: "anthropic";
  setKey: (rawKey: string) => boolean;
  clearKey: () => void;
  getApiKey: () => string | null;
}

/**
 * Advisory check for key safety: non-empty, string, <= 256 chars, no control chars.
 */
function isAdvisoryValidKey(key: string): boolean {
  if (typeof key !== "string") return false;
  const trimmed = key.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 33 || code > 126) return false;
  }
  return true;
}

export function useByokCredentials(): ByokCredentialActions {
  // Private ref holding the raw key strictly in memory
  const rawKeyRef = useRef<string | null>(null);
  const [hasKey, setHasKey] = useState<boolean>(false);
  const [status, setStatus] = useState<ByokValidationStatus>("unverified");

  const setKey = useCallback((rawKey: string): boolean => {
    const trimmed = rawKey.trim();
    if (!isAdvisoryValidKey(trimmed)) {
      return false;
    }
    rawKeyRef.current = trimmed;
    setHasKey(true);
    setStatus("active");
    return true;
  }, []);

  const clearKey = useCallback(() => {
    rawKeyRef.current = null;
    setHasKey(false);
    setStatus("unverified");
  }, []);

  const getApiKey = useCallback((): string | null => {
    return rawKeyRef.current;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      rawKeyRef.current = null;
    };
  }, []);

  return {
    hasKey,
    status,
    provider: "anthropic",
    setKey,
    clearKey,
    getApiKey,
  };
}
