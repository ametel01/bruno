import "server-only";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { reconcileNextRunnerReplacement } from "@/src/server/runners/runner-replacement-reconciler";

export type RunnerReplacementAfterScheduler = (callback: () => void | Promise<void>) => void;

export type RunnerReplacementTriggerDependencies = {
  afterScheduler?: RunnerReplacementAfterScheduler;
  reconcile?: typeof reconcileNextRunnerReplacement;
  randomUUID?: () => string;
};

export function scheduleRunnerReplacementReconcileAfterResponse(
  replacementId: string,
  dependencies: RunnerReplacementTriggerDependencies = {},
): void {
  const schedule = dependencies.afterScheduler ?? after;
  const reconcile = dependencies.reconcile ?? reconcileNextRunnerReplacement;
  const leaseOwner = `runner-replacement:${(dependencies.randomUUID ?? randomUUID)()}`;

  try {
    schedule(async () => {
      await reconcile({ leaseOwner, replacementId }).catch(() => {
        // The durable replacement remains due for the protected cron reconciler.
      });
    });
  } catch {
    // Synchronous request-scope registration failure is a dropped callback.
  }
}
