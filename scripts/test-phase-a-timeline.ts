import assert from "node:assert/strict";
import { hostEventStore } from "../lib/server/devbox-event-store";

async function main() {
  console.log("=== RUNNING PHASE A: TIMELINE & USAGE AGGREGATION TESTS ===");

  const projectId = "test-phase-a-timeline-proj";

  // Record a sequence of lifecycle events
  hostEventStore.recordEvent({
    projectId,
    tier: "T0",
    type: "step.started",
    data: { title: "Clone repository" },
  });

  hostEventStore.recordEvent({
    projectId,
    tier: "T0",
    type: "step.completed",
    data: { title: "Cloned repository (2.1s)", tokensUsed: { input: 120, output: 45 } },
  });

  hostEventStore.recordEvent({
    projectId,
    tier: "T1",
    type: "pkg.installed",
    data: { title: "Installed lodash", tokensUsed: { input: 200, output: 80 } },
  });

  hostEventStore.recordEvent({
    projectId,
    tier: "T3",
    type: "approval.requested",
    data: { title: "Push to main branch requires approval", branch: "main" },
  });

  const events = hostEventStore.getEvents(projectId);
  assert.equal(events.length, 4);

  // Compute aggregated token usage
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const evt of events) {
    if (evt.data?.tokensUsed) {
      totalInputTokens += evt.data.tokensUsed.input || 0;
      totalOutputTokens += evt.data.tokensUsed.output || 0;
    }
  }

  assert.equal(totalInputTokens, 320);
  assert.equal(totalOutputTokens, 125);
  console.log("[PASS] Timeline events aggregate input and output tokens accurately.");

  // Check approval card presence
  const approvalEvent = events.find((e) => e.type === "approval.requested");
  assert.ok(approvalEvent, "Approval requested event present in timeline stream");
  assert.equal(approvalEvent.tier, "T3");
  console.log("[PASS] T3 approval card represented as first-class timeline event.");

  console.log("=== ALL TIMELINE & USAGE TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
