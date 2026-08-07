import { describe, expect, it, vi } from "vitest";
import {
  scheduleAgentDeploymentReconcileAfterResponse,
  scheduleRunnerDeploymentReconcileAfterResponse,
} from "@/src/server/agents/agent-deployment-triggers";

const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000771";
const RUNNER_ID = "00000000-0000-4000-8000-000000000772";

describe("agent deployment post-response triggers", () => {
  it("registers targeted work without running it before the callback", async () => {
    let callback: (() => void | Promise<void>) | undefined;
    const reconcile = vi.fn(async () => ({ processed: 0 as const, outcome: "idle" as const }));

    scheduleAgentDeploymentReconcileAfterResponse(DEPLOYMENT_ID, {
      afterScheduler: (registered) => {
        callback = registered;
      },
      reconcile,
    });

    expect(reconcile).not.toHaveBeenCalled();
    await callback?.();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(DEPLOYMENT_ID);
  });

  it("delegates the whole post-create fallback to one bounded targeted drain", async () => {
    let callback: (() => void | Promise<void>) | undefined;
    const reconcile = vi.fn(async () => ({
      processed: 1 as const,
      outcome: "retry_scheduled" as const,
    }));

    scheduleAgentDeploymentReconcileAfterResponse(DEPLOYMENT_ID, {
      afterScheduler: (registered) => {
        callback = registered;
      },
      reconcile,
    });

    await callback?.();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(DEPLOYMENT_ID);
  });

  it("publishes a persisted delayed wakeup instead of reconciling inline when dispatch accepts it", async () => {
    let callback: (() => void | Promise<void>) | undefined;
    const publishWakeup = vi.fn(async () => "published" as const);
    const reconcile = vi.fn(async () => ({ processed: 1 as const, outcome: "advanced" as const }));

    scheduleAgentDeploymentReconcileAfterResponse(DEPLOYMENT_ID, {
      afterScheduler: (registered) => {
        callback = registered;
      },
      publishWakeup,
      reconcile,
    });

    await callback?.();
    expect(publishWakeup).toHaveBeenCalledWith(DEPLOYMENT_ID);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("falls back to targeted reconciliation when dispatch is cron-mode or unavailable", async () => {
    let callback: (() => void | Promise<void>) | undefined;
    const publishWakeup = vi.fn(async () => "cron_mode" as const);
    const reconcile = vi.fn(async () => ({ processed: 0 as const, outcome: "idle" as const }));

    scheduleAgentDeploymentReconcileAfterResponse(DEPLOYMENT_ID, {
      afterScheduler: (registered) => {
        callback = registered;
      },
      publishWakeup,
      reconcile,
    });

    await callback?.();
    expect(reconcile).toHaveBeenCalledWith(DEPLOYMENT_ID);
  });

  it("leaves dropped callbacks harmless and contains callback failures", async () => {
    const reconcile = vi.fn(async () => {
      throw new Error("private dependency detail");
    });
    const callbacks: Array<() => void | Promise<void>> = [];

    scheduleAgentDeploymentReconcileAfterResponse(DEPLOYMENT_ID, {
      afterScheduler: (callback) => callbacks.push(callback),
      reconcile,
    });
    scheduleAgentDeploymentReconcileAfterResponse(DEPLOYMENT_ID, {
      afterScheduler: (callback) => callbacks.push(callback),
      reconcile,
    });

    expect(reconcile).not.toHaveBeenCalled();
    await expect(callbacks[0]?.()).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("targets only the trusted runner ID returned by heartbeat persistence", async () => {
    let callback: (() => void | Promise<void>) | undefined;
    const reconcileRunner = vi.fn(async () => ({
      processed: 0 as const,
      outcome: "idle" as const,
    }));

    scheduleRunnerDeploymentReconcileAfterResponse(RUNNER_ID, {
      afterScheduler: (registered) => {
        callback = registered;
      },
      reconcileRunner,
    });

    expect(reconcileRunner).not.toHaveBeenCalled();
    await callback?.();
    expect(reconcileRunner).toHaveBeenCalledWith(RUNNER_ID);
  });

  it("contains synchronous scheduler registration failures without starting reconciliation", () => {
    const reconcile = vi.fn();
    const reconcileRunner = vi.fn();
    const afterScheduler = vi.fn(() => {
      throw new Error("request scope unavailable");
    });

    expect(() =>
      scheduleAgentDeploymentReconcileAfterResponse(DEPLOYMENT_ID, {
        afterScheduler,
        reconcile,
      }),
    ).not.toThrow();
    expect(() =>
      scheduleRunnerDeploymentReconcileAfterResponse(RUNNER_ID, {
        afterScheduler,
        reconcileRunner,
      }),
    ).not.toThrow();

    expect(afterScheduler).toHaveBeenCalledTimes(2);
    expect(reconcile).not.toHaveBeenCalled();
    expect(reconcileRunner).not.toHaveBeenCalled();
  });
});
