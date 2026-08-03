import { describe, expect, it, vi } from "vitest";
import {
  scheduleAgentRuntimeReconcileAfterResponse,
  scheduleRunnerReconciliationsAfterResponse,
} from "@/src/server/agents/agent-runtime-triggers";

const AGENT_ID = "00000000-0000-4000-8000-000000000901";
const RUNNER_ID = "00000000-0000-4000-8000-000000000902";

describe("agent runtime post-response triggers", () => {
  it("registers one trusted agent-targeted kick and contains failures", async () => {
    let callback: (() => void | Promise<void>) | undefined;
    const reconcileAgentRuntime = vi.fn(async () => {
      throw new Error("private runtime detail");
    });

    scheduleAgentRuntimeReconcileAfterResponse(AGENT_ID, {
      afterScheduler: (registered) => {
        callback = registered;
      },
      reconcileAgentRuntime,
    });

    expect(reconcileAgentRuntime).not.toHaveBeenCalled();
    await expect(callback?.()).resolves.toBeUndefined();
    expect(reconcileAgentRuntime).toHaveBeenCalledWith(AGENT_ID);
  });

  it("orders the deployment kick before the runtime kick for runner ingress", async () => {
    const order: string[] = [];
    let callback: (() => void | Promise<void>) | undefined;
    const reconcileRunnerDeployment = vi.fn(async () => {
      order.push("deployment");
      return { processed: 0 as const, outcome: "idle" as const };
    });
    const reconcileRunnerRuntime = vi.fn(async () => {
      order.push("runtime");
      return { processed: 0 as const, outcome: "idle" as const };
    });

    scheduleRunnerReconciliationsAfterResponse(RUNNER_ID, {
      afterScheduler: (registered) => {
        callback = registered;
      },
      reconcileRunnerDeployment,
      reconcileRunnerRuntime,
    });

    await callback?.();
    expect(order).toEqual(["deployment", "runtime"]);
    expect(reconcileRunnerDeployment).toHaveBeenCalledWith(RUNNER_ID);
    expect(reconcileRunnerRuntime).toHaveBeenCalledWith(RUNNER_ID);
  });

  it("still offers runtime work after a deployment kick failure", async () => {
    let callback: (() => void | Promise<void>) | undefined;
    const reconcileRunnerRuntime = vi.fn(async () => ({
      processed: 0 as const,
      outcome: "idle" as const,
    }));

    scheduleRunnerReconciliationsAfterResponse(RUNNER_ID, {
      afterScheduler: (registered) => {
        callback = registered;
      },
      reconcileRunnerDeployment: vi.fn(async () => {
        throw new Error("deployment callback dropped");
      }),
      reconcileRunnerRuntime,
    });

    await expect(callback?.()).resolves.toBeUndefined();
    expect(reconcileRunnerRuntime).toHaveBeenCalledOnce();
  });

  it("contains synchronous scheduler registration failures", () => {
    const reconcileAgentRuntime = vi.fn();

    expect(() =>
      scheduleAgentRuntimeReconcileAfterResponse(AGENT_ID, {
        afterScheduler: () => {
          throw new Error("request scope unavailable");
        },
        reconcileAgentRuntime,
      }),
    ).not.toThrow();
    expect(reconcileAgentRuntime).not.toHaveBeenCalled();
  });
});
