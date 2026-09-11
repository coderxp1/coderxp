/**
 * Sanitizer byte-cap and honesty regression tests.
 *
 * Covers: strict UTF-8 byte bounds (never UTF-16 code units) with the
 * truncation notice inside the budget; surrogate-pair-safe cuts that always
 * yield valid UTF-8; chunk-split secret redaction (synthetic exact secrets
 * and base patterns spanning chunk boundaries never leak); and honest
 * success reporting (no exit-code-0, running, port-3000, or unconditional
 * stopped fabrications). Deterministic: fixed fixtures, no I/O.
 */
import assert from "node:assert/strict";
import {
  ExactSecretStreamRedactor,
  createStreamRedactor,
} from "../lib/server/agent-runtime/stream-buffer";
import {
  formatUserFacingResultSummary,
  projectModelFacingResult,
  truncateAndSanitize,
  truncateUtf8Bytes,
  utf8ByteLength,
} from "../lib/workspace/agent-sanitizer";

const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

function assertValidUtf8(text: string, label: string): void {
  const bytes = new TextEncoder().encode(text);
  assert.equal(fatalDecoder.decode(bytes), text, `${label} must be valid UTF-8`);
}

function main(): void {
  console.log("=== SANITIZER BYTE-CAP AND HONESTY TESTS ===");

  console.log("--- 1. truncateUtf8Bytes enforces a strict byte bound ---");
  {
    const cases: Array<[string, number, string]> = [
      ["hello world", 5, "ascii cut"],
      ["héllo wörld héllo", 10, "latin multibyte"],
      ["日本語テスト日本語テスト", 12, "cjk multibyte"],
      ["😀😃😄😁😆", 8, "emoji surrogate pairs"],
      ["a😀b😃c", 4, "mixed split inside pair"],
      ["e\u0301".repeat(20), 7, "combining marks"],
      ["x".repeat(1000), 32 * 1024, "under budget passthrough"],
      ["", 10, "empty"],
    ];
    for (const [text, max, label] of cases) {
      const out = truncateUtf8Bytes(text, max);
      assert.ok(utf8ByteLength(out) <= max, `${label}: byte bound holds (${utf8ByteLength(out)} <= ${max})`);
      assertValidUtf8(out, label);
      if (text) {
        const last = out.charCodeAt(out.length - 1);
        assert.ok(!(last >= 0xd800 && last <= 0xdbff), `${label}: no trailing split high surrogate`);
      }
      if (utf8ByteLength(text) <= max) assert.equal(out, text, `${label}: under-budget input unchanged`);
    }
    assert.equal(truncateUtf8Bytes("hello", 0), "");
    assert.equal(truncateUtf8Bytes("hello", -3), "");
    console.log("[PASS] Strict UTF-8 byte bounds with surrogate-safe cuts.");
  }

  console.log("--- 2. truncateAndSanitize keeps the notice inside the budget ---");
  {
    const short = "Build ok héllo 😀";
    assert.equal(truncateAndSanitize(short, 1024), short, "short multibyte text passes through");
    for (const max of [64, 128, 1024, 32 * 1024]) {
      const over = "日本語".repeat(Math.ceil(max / 6) + 100) + "😀".repeat(Math.ceil(max / 2) + 50);
      const out = truncateAndSanitize(over, max);
      assert.ok(utf8ByteLength(out) <= max, `byte bound holds at max=${max}`);
      assertValidUtf8(out, `max=${max}`);
      assert.ok(out.endsWith("[... truncated by security policy ...]"), `truncation notice present at max=${max}`);
    }
    const tiny = truncateAndSanitize("x".repeat(100), 10);
    assert.ok(utf8ByteLength(tiny) <= 10, "degenerate budget still bounded");
    console.log("[PASS] Notice-inside-budget truncation at every size.");
  }

  console.log("--- 3. Exact secrets split across chunks never leak ---");
  {
    const secret = "SYNTH-7f3a9c2e-SMOKE-TOKEN";
    const splits: string[][] = [
      [secret.slice(0, 8), secret.slice(8)],
      [secret.slice(0, 5), secret.slice(5, 12), secret.slice(12)],
      ["prefix ", secret.slice(0, 1), secret.slice(1)],
      [secret.slice(0, secret.length - 1), secret.slice(secret.length - 1), " suffix"],
      ["aaa", "bbb", secret, "ccc"],
    ];
    for (const chunks of splits) {
      const redactor = new ExactSecretStreamRedactor([secret]);
      let emitted = "";
      for (const chunk of chunks) {
        const out = redactor.push(chunk);
        assert.ok(!out.includes(secret), `emitted chunk must not contain the secret (split ${JSON.stringify(chunks)})`);
        for (let len = 1; len < secret.length; len++) {
          assert.ok(!out.endsWith(secret.slice(0, len)), `emitted chunk must not end with a secret prefix (split ${JSON.stringify(chunks)})`);
        }
        emitted += out;
      }
      emitted += redactor.flush();
      assert.ok(!emitted.includes(secret), "flushed output must not contain the secret");
      assert.ok(emitted.includes("[REDACTED]"), "secret replaced by a marker");
    }
    const passthrough = new ExactSecretStreamRedactor([]);
    assert.equal(passthrough.push("clean text") + passthrough.flush(), "clean text");
    console.log("[PASS] Split synthetic secrets withheld then redacted.");
  }

  console.log("--- 4. Composed stream redactor covers split base patterns too ---");
  {
    const token = "ghp_abcDEF1234567890abcdef1234567890ab";
    const redactor = createStreamRedactor(["SESSION-SYNTH-9999"]);
    const chunks = ["token=", token.slice(0, 8), token.slice(8) + " done ", "SESSION-SYNTH-", "9999 tail"];
    let emitted = "";
    for (const chunk of chunks) {
      const out = redactor.push(chunk);
      assert.ok(!out.includes(token), "split base-pattern token must not leak");
      assert.ok(!out.includes("SESSION-SYNTH-9999"), "split synthetic must not leak");
      emitted += out;
    }
    emitted += redactor.flush();
    assert.ok(!emitted.includes(token) && !emitted.includes("SESSION-SYNTH-9999"), "nothing leaks after flush");
    assert.ok(emitted.includes("[REDACTED]"), "redaction markers present");
    assert.ok(emitted.includes("done"), "non-secret content preserved");
    const bearer = createStreamRedactor([]);
    const b1 = bearer.push("Authorization: Bearer abcdef");
    assert.ok(!b1.includes("Bearer abcdef"), "partial bearer prefix withheld");
    const b2 = bearer.push("1234567890 finished") + bearer.flush();
    assert.ok(!b2.includes("abcdef1234567890"), "completed bearer value redacted");
    console.log("[PASS] Base patterns, prefix withholding, and synthetics compose.");
  }

  console.log("--- 5. User summaries never fabricate success ---");
  {
    const unknownExit = formatUserFacingResultSummary("run_command", { ok: true, data: {} });
    assert.ok(unknownExit.includes("unknown"), "unknown exit code is reported unknown");
    assert.ok(!unknownExit.includes("exit code 0"), "no exit-code-0 fabrication");
    const knownExit = formatUserFacingResultSummary("run_command", { ok: true, data: { exitCode: 3 } });
    assert.ok(knownExit.includes("exit code 3"), "observed exit codes still reported");

    const startUnknown = formatUserFacingResultSummary("start_process", { ok: true, data: {} });
    assert.ok(!startUnknown.includes("running on port 3000"), "no running/port-3000 fabrication");
    assert.ok(startUnknown.includes("unknown"), "missing start fields reported unknown");
    assert.ok(startUnknown.length > 0, "summary stays non-empty");

    const stopUnconfirmed = formatUserFacingResultSummary("stop_command", { ok: true, data: { commandId: "c1" } });
    assert.ok(stopUnconfirmed.includes("unconfirmed"), "unconfirmed stop is labeled");
    const stopConfirmed = formatUserFacingResultSummary("stop_command", { ok: true, data: { commandId: "c1", stopped: true } });
    assert.ok(stopConfirmed.startsWith("Stopped process"), "confirmed stop still reports stopped");

    const buildUnknown = formatUserFacingResultSummary("run_build", { ok: true, data: {} });
    assert.ok(buildUnknown.includes("unknown"), "unknown build outcome labeled");
    assert.ok(!buildUnknown.includes("succeeded"), "no success fabrication");
    const testsFailed = formatUserFacingResultSummary("run_tests", { ok: true, data: { success: false, exitCode: 1 } });
    assert.ok(testsFailed.includes("failed") && testsFailed.includes("exit code 1"), "observed failure still reported");
    console.log("[PASS] Summaries report unknown instead of inventing success.");
  }

  console.log("--- 6. Model projections carry no success defaults ---");
  {
    const start = projectModelFacingResult("start_process", { ok: true, data: {} });
    assert.ok(start.ok === true);
    const startData = (start as { data: Record<string, unknown> }).data;
    assert.ok(!("port" in startData) || startData.port === undefined, "no default port");
    assert.equal(startData.status, "unknown", "no default running status");
    assert.ok(!("output" in startData) || startData.output === undefined, "no default output");

    const build = projectModelFacingResult("run_build", { ok: true, data: {} });
    const buildData = (build as { data: Record<string, unknown> }).data;
    assert.equal(buildData.success, false, "success defaults to false, never true");
    assert.equal(buildData.exitCode, null, "unknown exit code is null, never 0");
    console.log("[PASS] Projections stay honest under missing fields.");
  }

  console.log("=== ALL SANITIZER BYTE TESTS PASSED ===");
}

main();
