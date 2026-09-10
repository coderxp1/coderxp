import assert from "node:assert";
import { AgentOrchestrator } from "../lib/workspace/agent-orchestrator";
import { AgentExecutionRuntime } from "../lib/workspace/agent-execution-runtime";
import { AgentPermissionController } from "../lib/workspace/agent-permissions";
import type { AgentTransport, AgentTransportEvent, AgentTransportRequest } from "../lib/workspace/agent-transport-types";

console.log("==========================================================================");
console.log("       ORCHESTRATOR STABLE IDENTITY & LIFECYCLE REGRESSION TESTS          ");
console.log("==========================================================================\n");

// 1. Fake Transport
class MockTransport implements AgentTransport {
  dispatchedRequests: AgentTransportRequest[] = [];
  async *send(request: AgentTransportRequest, _signal: AbortSignal): AsyncIterable<AgentTransportEvent> {
    this.dispatchedRequests.push(request);
    yield {
      type: "turn-started",
      eventId: "evt-1",
      sequence: 1,
      requestId: request.requestId,
      turnId: request.turnId,
      timestamp: Date.now(),
    };
    yield {
      type: "text-delta",
      eventId: "evt-2",
      sequence: 2,
      requestId: request.requestId,
      turnId: request.turnId,
      text: "Stable reply",
    };
    yield {
      type: "turn-completed",
      eventId: "evt-3",
      sequence: 3,
      requestId: request.requestId,
      turnId: request.turnId,
      stopReason: "stop",
    };
  }
}

// 2. Simulate hook wrapper with ref-based identity caching
class SimulatedUseAgentOrchestrator {
  private currentInstance: AgentOrchestrator | null = null;
  private currentKey: { projectId: string; generation: number } | null = null;
  public constructionCount = 0;
  public disposalCount = 0;

  render(options: {
    projectId: string;
    generation: number;
    runtime: AgentExecutionRuntime;
    transport: AgentTransport;
    onEvent: (event: any) => void;
  }) {
    const { projectId, generation, runtime, transport, onEvent } = options;

    if (
      !this.currentInstance ||
      this.currentKey?.projectId !== projectId ||
      this.currentKey?.generation !== generation
    ) {
      if (this.currentInstance) {
        this.currentInstance.dispose();
        this.disposalCount++;
      }
      this.currentKey = { projectId, generation };
      this.constructionCount++;
      this.currentInstance = new AgentOrchestrator({
        projectId,
        generation,
        runtime,
        transport,
        onEvent,
      });
    }

    return this.currentInstance;
  }

  unmount() {
    if (this.currentInstance) {
      this.currentInstance.dispose();
      this.disposalCount++;
      this.currentInstance = null;
    }
  }
}

async function runTests() {
  const controller = new AgentPermissionController();
  const runtime = new AgentExecutionRuntime({
    projectId: "proj-1",
    controller,
    executeTool: async () => ({ status: "completed", output: "ok" }),
  });
  const transport = new MockTransport();

  const hook = new SimulatedUseAgentOrchestrator();

  console.log("--- 1. Testing forced multi-render sequence (10 renders with inline callbacks) ---");
  let lastInst: AgentOrchestrator | null = null;
  for (let i = 0; i < 10; i++) {
    const inst = hook.render({
      projectId: "proj-1",
      generation: 1,
      runtime,
      transport,
      onEvent: () => { /* new inline arrow on every render */ },
    });
    if (lastInst) {
      assert.strictEqual(inst, lastInst, "Orchestrator instance identity must remain strictly identical across re-renders");
    }
    lastInst = inst;
  }

  assert.strictEqual(hook.constructionCount, 1, "Orchestrator must only be constructed once for identical projectId+generation");
  assert.strictEqual(hook.disposalCount, 0, "Orchestrator must NEVER be disposed during component re-renders");
  console.log("[PASS] Orchestrator instance was constructed exactly 1 time across 10 renders and disposed 0 times.");

  console.log("\n--- 2. Submitting prompt after forced re-renders ---");
  assert(lastInst !== null);
  const result = lastInst.submitRun("hi");
  assert(result.runId, "Run ID must be generated");

  // Wait for mock transport dispatch and run completion
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.strictEqual(transport.dispatchedRequests.length, 1, "Transport must receive exactly 1 request");
  const firstPart = transport.dispatchedRequests[0].messages[1].parts[0];
  assert.strictEqual((firstPart as any).text, "hi", "User prompt must be present in request");
  console.log("[PASS] Prompt successfully submitted and dispatched upstream.");

  console.log("\n--- 3. Generation bump recreation test ---");
  hook.render({
    projectId: "proj-1",
    generation: 2, // generation bumped!
    runtime,
    transport,
    onEvent: () => {},
  });
  assert.strictEqual(hook.constructionCount, 2, "Generation bump must construct new instance");
  assert.strictEqual(hook.disposalCount, 1, "Previous instance must be cleanly disposed on generation bump");
  console.log("[PASS] Generation bump correctly disposed old instance and constructed new instance.");

  hook.unmount();
  assert.strictEqual(hook.disposalCount, 2, "Unmount disposed final instance cleanly.");
  console.log("[PASS] Unmount disposed cleanly.");

  console.log("\n==========================================================================");
  console.log("   SUCCESS: ALL ORCHESTRATOR STABLE IDENTITY TESTS PASSED (100%)         ");
  console.log("==========================================================================\n");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
