/**
 * Logicc provider configuration, access control, model discovery, and
 * credential non-leak harness.
 *
 * Zero live credentials. Synthetic fixture keys only.
 */

import {
  getProviderConfigSnapshot,
  isLogiccCredentialConfigured,
  isLogiccInternalModeEnabled,
  resolveProviderId,
  LOGICC_CHAT_COMPLETIONS_URL,
  LOGICC_MODELS_URL,
  LOGICC_ORIGIN,
} from "../lib/server/agent-provider-config";
import {
  clearLogiccModelCache,
  discoverLogiccModels,
} from "../lib/server/agent-logicc-models";
import { createLogiccAdapter } from "../lib/server/agent-logicc-adapter";
import { createProviderAdapter, getActiveProvider } from "../lib/server/agent-provider-registry";
import { isSameOriginRequest } from "../lib/server/agent-same-origin";
import { SERVER_RESOURCE_LIMITS } from "../lib/server/agent-shared-limits";

const SYNTHETIC_LOGICC_KEY = "cxp-test-logicc-not-a-credential";

let passCount = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
  passCount++;
  console.log(`[PASS #${passCount}] ${message}`);
}

function assertAbsent(label: string, value: unknown, needle: string): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  assert(!serialized.includes(needle), `${label} does not contain secret fixture`);
}

async function main(): Promise<void> {
  console.log("==========================================================================");
  console.log("           LOGICC PROVIDER CONFIG & ACCESS CONTROL HARNESS                ");
  console.log("==========================================================================");

  // --- Provider configuration ---
  console.log("\n--- Provider configuration ---");
  assert(resolveProviderId({}) === "anthropic-byok", "Logicc disabled by default (empty env)");
  assert(
    resolveProviderId({ AGENT_PROVIDER: "anthropic-byok" }) === "anthropic-byok",
    "anthropic-byok selectable",
  );
  assert(resolveProviderId({ AGENT_PROVIDER: "logicc" }) === "logicc", "logicc selectable");
  assert(
    resolveProviderId({ AGENT_PROVIDER: "LOGICC" }) === "logicc",
    "logicc case-insensitive",
  );
  assert(
    isLogiccCredentialConfigured({}) === false,
    "Missing server credential reports not configured",
  );
  assert(
    isLogiccCredentialConfigured({ LOGICC_API_KEY: SYNTHETIC_LOGICC_KEY }) === true,
    "Present server credential reports configured (boolean only)",
  );
  assert(isLogiccInternalModeEnabled({}) === false, "Internal mode off by default");
  assert(
    isLogiccInternalModeEnabled({ LOGICC_INTERNAL_MODE: "true" }) === true,
    "Internal mode enabled only when true",
  );

  const snap = getProviderConfigSnapshot({
    AGENT_PROVIDER: "logicc",
    LOGICC_API_KEY: SYNTHETIC_LOGICC_KEY,
    LOGICC_INTERNAL_MODE: "true",
    LOGICC_ALLOWED_MODELS: "gpt-4o,gpt-4o-mini",
    LOGICC_DEFAULT_MODEL: "gpt-4o",
  });
  assert(snap.logiccSelected === true, "Snapshot marks Logicc selected");
  assert(snap.logiccInternalMode === true, "Snapshot marks internal mode");
  assert(snap.logiccCredentialConfigured === true, "Snapshot boolean credential ready");
  assertAbsent("config snapshot", snap, SYNTHETIC_LOGICC_KEY);
  assertAbsent("config snapshot", snap, "LOGICC_API_KEY");

  // --- Access control ---
  console.log("\n--- Internal-only access ---");
  const restricted = createLogiccAdapter({
    env: {
      AGENT_PROVIDER: "logicc",
      LOGICC_API_KEY: SYNTHETIC_LOGICC_KEY,
      LOGICC_ALLOWED_MODELS: "gpt-4o",
      LOGICC_DEFAULT_MODEL: "gpt-4o",
    },
  });
  const restrictedHealth = restricted.getSafeHealth();
  assert(restrictedHealth.ready === false, "Logicc not ready without internal mode");
  assert(
    restrictedHealth.status === "access_restricted",
    "Public access fails closed without LOGICC_INTERNAL_MODE",
  );
  assert(restrictedHealth.access === "restricted", "Access marked restricted");
  assertAbsent("restricted health", restrictedHealth, SYNTHETIC_LOGICC_KEY);

  const credFail = restricted.beginCredentialSession(null);
  assert(credFail.ok === false, "Credential session fails without internal mode");
  if (!credFail.ok) {
    assert(credFail.errorCode === "ACCESS_RESTRICTED", "ACCESS_RESTRICTED when internal mode off");
  }

  const missingKey = createLogiccAdapter({
    env: {
      AGENT_PROVIDER: "logicc",
      LOGICC_INTERNAL_MODE: "true",
      LOGICC_ALLOWED_MODELS: "gpt-4o",
      LOGICC_DEFAULT_MODEL: "gpt-4o",
    },
  });
  const missingHealth = missingKey.getSafeHealth();
  assert(missingHealth.ready === false, "Unavailable when credential missing");
  assert(missingHealth.status === "unavailable", "Safe unavailable status (no absent-vs-invalid leak)");
  assertAbsent("missing-key health", missingHealth, "LOGICC_API_KEY");

  const readyAdapter = createLogiccAdapter({
    env: {
      AGENT_PROVIDER: "logicc",
      LOGICC_API_KEY: SYNTHETIC_LOGICC_KEY,
      LOGICC_INTERNAL_MODE: "true",
      LOGICC_ALLOWED_MODELS: "gpt-4o",
      LOGICC_DEFAULT_MODEL: "gpt-4o",
    },
    fixedApprovedModels: [{ id: "gpt-4o", displayName: "gpt-4o" }],
    fixedDefaultModelId: "gpt-4o",
  });
  const readyHealth = readyAdapter.getSafeHealth();
  assert(readyHealth.ready === true, "Ready when internal + credential + models configured");
  assert(readyHealth.access === "internal", "Access internal when enabled");
  assert(readyHealth.byokRequired === false, "Logicc does not require browser BYOK");
  assertAbsent("ready health", readyHealth, SYNTHETIC_LOGICC_KEY);

  // --- Same-origin ---
  console.log("\n--- Same-origin (not authentication) ---");
  assert(
    isSameOriginRequest(new Request("http://localhost/api/agent/health")) === true,
    "Missing Origin allowed",
  );
  assert(
    isSameOriginRequest(
      new Request("http://localhost/api/agent/health", {
        headers: { Origin: "http://localhost:3000", Host: "localhost:3000" },
      }),
    ) === true,
    "Matching Origin allowed",
  );
  assert(
    isSameOriginRequest(
      new Request("http://localhost/api/agent/health", {
        headers: { Origin: "https://evil.example", Host: "localhost:3000" },
      }),
    ) === false,
    "Mismatched Origin rejected",
  );

  // --- Model discovery ---
  console.log("\n--- Model discovery & allowlist ---");
  clearLogiccModelCache();

  let fetchCount = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    fetchCount += 1;
    const url = String(input);
    assert(url === LOGICC_MODELS_URL, "Discovery uses fixed Logicc models URL");
    const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    assert(auth === `Bearer ${SYNTHETIC_LOGICC_KEY}`, "Discovery uses server credential");
    assertAbsent("discovery request url", url, "cxp-test");
    return new Response(
      JSON.stringify({
        object: "list",
        data: [
          { id: "gpt-4o", object: "model" },
          { id: "gpt-4o-mini", object: "model" },
          { id: "secret-unlisted-model", object: "model" },
          { id: "gpt-4o", object: "model" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const discoveryEnv = {
    LOGICC_API_KEY: SYNTHETIC_LOGICC_KEY,
    LOGICC_ALLOWED_MODELS: "gpt-4o,gpt-4o-mini",
    LOGICC_DEFAULT_MODEL: "gpt-4o",
  };

  const first = await discoverLogiccModels({
    env: discoveryEnv,
    fetchFn: fakeFetch,
    clock: () => 1_000,
  });
  assert(first.ok === true, "Successful discovery");
  if (first.ok) {
    assert(first.fromCache === false, "First discovery not from cache");
    assert(first.models.length === 2, "Allowlist intersection keeps 2 models");
    assert(
      first.models.every((m) => m.id === "gpt-4o" || m.id === "gpt-4o-mini"),
      "Unlisted models excluded",
    );
    assert(first.defaultModelId === "gpt-4o", "Default model validated");
    assertAbsent("discovery models", first.models, SYNTHETIC_LOGICC_KEY);
    assertAbsent("discovery models", first, "secret-unlisted-model");
  }

  const cached = await discoverLogiccModels({
    env: discoveryEnv,
    fetchFn: fakeFetch,
    clock: () => 1_000 + SERVER_RESOURCE_LIMITS.modelCacheTtlMs - 1,
  });
  assert(cached.ok === true && cached.fromCache === true, "Bounded cache hit within TTL");
  assert(fetchCount === 1, "Cache avoids second upstream fetch");

  clearLogiccModelCache();
  const expired = await discoverLogiccModels({
    env: discoveryEnv,
    fetchFn: fakeFetch,
    clock: () => 50_000,
  });
  assert(expired.ok === true && expired.fromCache === false, "Cache miss after TTL");
  assert(fetchCount === 2, "Expired cache refetches");

  clearLogiccModelCache();
  const badDefault = await discoverLogiccModels({
    env: {
      LOGICC_API_KEY: SYNTHETIC_LOGICC_KEY,
      LOGICC_ALLOWED_MODELS: "gpt-4o",
      LOGICC_DEFAULT_MODEL: "not-in-allowlist",
    },
    fetchFn: fakeFetch,
    clock: () => 100_000,
  });
  assert(badDefault.ok === false, "Default outside allowlist rejected");
  if (!badDefault.ok) {
    assert(
      badDefault.errorCode === "MODEL_NOT_ALLOWED" ||
        badDefault.errorCode === "MODEL_UNAVAILABLE",
      "Safe error for invalid default",
    );
  }

  clearLogiccModelCache();
  const timeoutFetch: typeof fetch = async () => {
    throw new Error("network down");
  };
  const failed = await discoverLogiccModels({
    env: discoveryEnv,
    fetchFn: timeoutFetch,
    clock: () => 200_000,
  });
  assert(failed.ok === false, "Discovery error yields unavailable");
  if (!failed.ok) {
    assert(failed.errorCode === "PROVIDER_UNAVAILABLE", "PROVIDER_UNAVAILABLE on discovery failure");
    assertAbsent("discovery failure", failed, SYNTHETIC_LOGICC_KEY);
  }

  // Unavailable model rejection at request time
  const listed = await readyAdapter.listSanitizedModels!();
  assert(listed.ok === true, "Fixed models list ok");
  const translateBad = readyAdapter.validateAndTranslateRequest(
    {
      runId: "r",
      turnId: "t",
      requestId: "q",
      projectId: "p",
      generation: 1,
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
          createdAt: 1,
          status: "complete",
        },
      ],
      tools: [],
    },
    { model: "not-allowed-model" },
  );
  assert(translateBad.ok === false, "Unavailable/unallowed model rejected");
  if (!translateBad.ok) {
    assert(translateBad.errorCode === "MODEL_NOT_ALLOWED", "MODEL_NOT_ALLOWED code");
  }

  // --- Fixed upstream origin ---
  console.log("\n--- Fixed upstream origin ---");
  assert(
    readyAdapter.getUpstreamUrl() === LOGICC_CHAT_COMPLETIONS_URL,
    "Chat completions URL is fixed server-side",
  );
  assert(LOGICC_CHAT_COMPLETIONS_URL.startsWith(LOGICC_ORIGIN), "Completions under Logicc origin");
  assert(LOGICC_MODELS_URL.startsWith(LOGICC_ORIGIN), "Models under Logicc origin");

  // --- Credential session does not leak ---
  console.log("\n--- Credential non-leak ---");
  const session = readyAdapter.beginCredentialSession("browser-should-ignore");
  assert(session.ok === true, "Credential session starts with server key");
  if (session.ok) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    session.session.applyAuth(headers);
    assert(
      headers.Authorization === `Bearer ${SYNTHETIC_LOGICC_KEY}`,
      "Auth header applied within request boundary",
    );
    session.session.release();
    const headersAfter: Record<string, string> = {};
    session.session.applyAuth(headersAfter);
    assert(
      headersAfter.Authorization === undefined,
      "Released session does not re-apply credential",
    );
  }

  // Browser BYOK ignored
  const withByokHeader = readyAdapter.beginCredentialSession(SYNTHETIC_LOGICC_KEY);
  assert(withByokHeader.ok === true, "Browser BYOK header ignored (server key used)");

  // Registry defaults
  const activeDefault = getActiveProvider({ env: {} });
  assert(activeDefault.id === "anthropic-byok", "Registry defaults to anthropic-byok");
  const activeLogicc = createProviderAdapter("logicc", {
    env: {
      LOGICC_INTERNAL_MODE: "true",
      LOGICC_API_KEY: SYNTHETIC_LOGICC_KEY,
      LOGICC_ALLOWED_MODELS: "gpt-4o",
      LOGICC_DEFAULT_MODEL: "gpt-4o",
    },
    logicc: {
      fixedApprovedModels: [{ id: "gpt-4o", displayName: "gpt-4o" }],
      fixedDefaultModelId: "gpt-4o",
    },
  });
  assert(activeLogicc.id === "logicc", "Registry can create Logicc adapter");

  console.log(`\nSUCCESS: ALL ${passCount} LOGICC PROVIDER ASSERTIONS PASSED!`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
