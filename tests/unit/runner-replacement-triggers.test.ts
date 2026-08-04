import { describe, expect, it, vi } from "vitest";
import { scheduleRunnerReplacementReconcileAfterResponse } from "@/src/server/runners/runner-replacement-triggers";

const REPLACEMENT_ID = "00000000-0000-4000-8000-000000000881";
const LEASE_UUID = "00000000-0000-4000-8000-000000000882";

describe("runner replacement post-response trigger", () => {
  it("registers one targeted reconcile with an isolated lease owner", async () => {
    let callback: (() => void | Promise<void>) | undefined;
    const reconcile = vi.fn(async () => ({
      outcome: "advanced" as const,
      replacementId: REPLACEMENT_ID,
      state: "provisioning_target",
    }));

    scheduleRunnerReplacementReconcileAfterResponse(REPLACEMENT_ID, {
      afterScheduler: (registered) => {
        callback = registered;
      },
      randomUUID: () => LEASE_UUID,
      reconcile,
    });

    expect(reconcile).not.toHaveBeenCalled();
    await callback?.();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith({
      leaseOwner: `runner-replacement:${LEASE_UUID}`,
      replacementId: REPLACEMENT_ID,
    });
  });

  it("contains callback and synchronous scheduler failures", async () => {
    const callbackFailure = vi.fn(async () => {
      throw new Error("private replacement failure");
    });
    let callback: (() => void | Promise<void>) | undefined;
    scheduleRunnerReplacementReconcileAfterResponse(REPLACEMENT_ID, {
      afterScheduler: (registered) => {
        callback = registered;
      },
      reconcile: callbackFailure,
    });
    await expect(callback?.()).resolves.toBeUndefined();
    expect(callbackFailure).toHaveBeenCalledOnce();

    const neverCalled = vi.fn();
    expect(() =>
      scheduleRunnerReplacementReconcileAfterResponse(REPLACEMENT_ID, {
        afterScheduler: () => {
          throw new Error("request scope unavailable");
        },
        reconcile: neverCalled,
      }),
    ).not.toThrow();
    expect(neverCalled).not.toHaveBeenCalled();
  });
});
