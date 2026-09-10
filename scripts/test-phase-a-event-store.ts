import assert from "node:assert/strict";
import { hostEventStore } from "../lib/server/devbox-event-store";

async function main() {
  console.log("=== RUNNING PHASE A: HOST EVENT STORE & AUTHORITY TESTS ===");

  const projectId = "test-phase-a-events-proj";

  // 1. Monotonic Sequence Numbering & Persistence
  console.log("--- 1. Monotonic Sequence Numbering ---");
  const evt1 = hostEventStore.recordEvent({
    projectId,
    tier: "T0",
    type: "step.started",
    data: { title: "Clone repository" },
  });
  assert.equal(evt1.seq, 1, "First event has seq 1");

  const evt2 = hostEventStore.recordEvent({
    projectId,
    tier: "T1",
    type: "pkg.installed",
    data: { title: "npm install express", package: "express" },
  });
  assert.equal(evt2.seq, 2, "Second event has seq 2");

  assert.equal(hostEventStore.getCurrentSeq(projectId), 2, "Current seq is 2");
  console.log("[PASS] Events assigned strictly monotonic sequence numbers.");

  // 2. Secret Redaction on Persisted Payloads
  console.log("--- 2. Secret Redaction on Event Payloads ---");
  const secretKey = "sk-ant-api03-abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
  const evt3 = hostEventStore.recordEvent({
    projectId,
    tier: "T1",
    type: "cmd.executed",
    data: {
      title: "Set environment variable",
      command: `export ANTHROPIC_API_KEY=${secretKey}`,
      output: `Using key ${secretKey}`,
    },
  });

  assert.equal(evt3.data.command.includes(secretKey), false, "Raw API key is NOT stored in event command");
  assert.equal(evt3.data.output.includes(secretKey), false, "Raw API key is NOT stored in event output");
  assert.ok(evt3.data.command.includes("[REDACTED"), "Redaction placeholder present");
  console.log("[PASS] Secrets in event payloads are automatically redacted before storage.");

  // 3. Retrieval with fromSeq filter
  console.log("--- 3. Event Querying with fromSeq ---");
  const allEvents = hostEventStore.getEvents(projectId);
  assert.equal(allEvents.length, 3, "All 3 events retrieved");

  const partial = hostEventStore.getEvents(projectId, 2);
  assert.equal(partial.length, 2, "Events starting from seq 2 retrieved");
  assert.equal(partial[0].seq, 2);
  assert.equal(partial[1].seq, 3);
  console.log("[PASS] Querying from specific sequence offsets verified.");

  console.log("=== ALL HOST EVENT STORE TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
