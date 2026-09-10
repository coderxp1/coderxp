/**
 * Local-only Logicc model ID discovery helper.
 *
 * Reads the server-owned LOGICC_API_KEY from the process environment,
 * calls Logicc GET /v1/models, and prints only sanitized model IDs.
 *
 * Fail-closed unless LOGICC_INTERNAL_MODE=true.
 * Never prints the API key, Authorization headers, or raw upstream JSON.
 *
 * Usage (localhost / private admin only):
 *   LOGICC_INTERNAL_MODE=true LOGICC_API_KEY=... npx tsx scripts/discover-logicc-models.ts
 *
 * Prefer loading non-secret + secret values from a gitignored .env.local via
 * your shell — do not paste the key into chat, commits, or reports.
 */

import {
  isLogiccCredentialConfigured,
  isLogiccInternalModeEnabled,
} from "../lib/server/agent-provider-config";
import {
  clearLogiccModelCache,
  discoverLogiccModels,
} from "../lib/server/agent-logicc-models";

async function main(): Promise<void> {
  if (!isLogiccInternalModeEnabled()) {
    console.error(
      "ACCESS_RESTRICTED: Set LOGICC_INTERNAL_MODE=true for local/private discovery only.",
    );
    console.error(
      "This helper is not authentication. Do not use it on a publicly reachable deployment.",
    );
    process.exit(2);
  }

  if (!isLogiccCredentialConfigured()) {
    console.error("PROVIDER_NOT_CONFIGURED: LOGICC_API_KEY is missing.");
    process.exit(3);
  }

  clearLogiccModelCache();

  // Discover without applying allowlist first: temporarily pass a wildcard
  // by reading upstream through a dedicated fetch that we sanitize ourselves.
  // The shared discoverLogiccModels intersects allowlist; for admin discovery
  // of *enabled* IDs we call the models endpoint with a passthrough allowlist
  // equal to whatever the upstream returns — implemented by using env allowlist
  // if set, otherwise reporting that allowlist is empty and still showing that
  // discovery itself requires allowlist config for the shared helper.
  //
  // For operator usability: if LOGICC_ALLOWED_MODELS is unset, perform a
  // sanitized discovery of enabled IDs only (not the full raw payload).
  const allowlist = (process.env.LOGICC_ALLOWED_MODELS ?? "").trim();

  if (!allowlist) {
    // Temporary local discovery path: fetch and sanitize IDs only.
    const key = (process.env.LOGICC_API_KEY ?? "").trim();
    let released = false;
    const release = () => {
      // Minimize retained references; JS cannot guarantee erasure.
      released = true;
      void released;
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let response: Response;
      try {
        response = await fetch("https://api.logicc.cloud/v1/models", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      // Drop key reference after dispatch.
      release();

      if (!response.ok) {
        try {
          await response.arrayBuffer();
        } catch {
          // discard
        }
        console.error("PROVIDER_UNAVAILABLE: Model discovery failed.");
        process.exit(4);
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        console.error("PROVIDER_UNAVAILABLE: Invalid discovery response.");
        process.exit(4);
      }

      const data = (raw as { data?: unknown }).data;
      raw = null;
      const ids: string[] = [];
      const seen = new Set<string>();
      if (Array.isArray(data)) {
        for (const item of data) {
          if (!item || typeof item !== "object") continue;
          const id = (item as { id?: unknown }).id;
          if (typeof id !== "string" || id.trim().length === 0) continue;
          const trimmed = id.trim();
          if (seen.has(trimmed)) continue;
          seen.add(trimmed);
          ids.push(trimmed);
        }
      }

      console.log("Logicc enabled model IDs (sanitized; local/private only):");
      if (ids.length === 0) {
        console.log("(none)");
      } else {
        for (const id of ids) {
          console.log(`- ${id}`);
        }
      }
      console.log("");
      console.log(
        "Copy chosen IDs into LOGICC_ALLOWED_MODELS and pick LOGICC_DEFAULT_MODEL from that list.",
      );
      console.log(
        "This output is not an allowlist. Administrator allowlisting remains mandatory.",
      );
      process.exit(0);
    } catch {
      release();
      console.error("PROVIDER_UNAVAILABLE: Model discovery failed.");
      process.exit(4);
    }
  }

  const result = await discoverLogiccModels();
  if (!result.ok) {
    console.error(`${result.errorCode}: ${result.message}`);
    process.exit(5);
  }

  console.log("Allowlist ∩ enabled models (sanitized):");
  for (const m of result.models) {
    const marker = m.id === result.defaultModelId ? " (default)" : "";
    console.log(`- ${m.id}${marker}`);
  }
  if (!result.defaultModelId) {
    console.error(
      "MODEL_NOT_ALLOWED: Default model is missing or not in the allowlist intersection.",
    );
    process.exit(6);
  }
  console.log(`defaultModelId=${result.defaultModelId}`);
}

main().catch(() => {
  console.error("PROVIDER_UNAVAILABLE: Unexpected discovery failure.");
  process.exit(1);
});
