import "server-only";

import { after } from "next/server";
import {
  reconcileTargetAgentRuntime,
  reconcileTargetRunnerRuntime,
} from "@/src/server/agents/agent-runtime-reconciler";

export type AgentRuntimeAfterScheduler = (callback: () => void | Promise<void>) => void;

export type AgentRuntimeTriggerDependencies = {
  afterScheduler?: AgentRuntimeAfterScheduler;
  reconcileAgentRuntime?: typeof reconcileTargetAgentRuntime;
  reconcileRunnerDeployment?: (runnerId: string) => Promise<unknown>;
  reconcileRunnerRuntime?: typeof reconcileTargetRunnerRuntime;
};

export function scheduleAgentRuntimeReconcileAfterResponse(
  agentId: string,
  dependencies: AgentRuntimeTriggerDependencies = {},
): void {
  const schedule = dependencies.afterScheduler ?? after;
  const reconcile = dependencies.reconcileAgentRuntime ?? reconcileTargetAgentRuntime;

  registerLossyCallback(schedule, async () => {
    await reconcile(agentId);
  });
}

/**
 * Runner ingress must preserve this order: let an active Step 7 deployment use
 * the fresh runner first, then offer one due managed-ready runtime row a kick.
 * Both calls retain their own one-row budgets and cron remains the durability
 * boundary when this callback is dropped.
 */
export function scheduleRunnerReconciliationsAfterResponse(
  runnerId: string,
  dependencies: AgentRuntimeTriggerDependencies = {},
): void {
  const schedule = dependencies.afterScheduler ?? after;
  const reconcileDeployment =
    dependencies.reconcileRunnerDeployment ??
    (async (targetRunnerId: string) => {
      const { reconcileTargetRunnerDeployment } = await import(
        "@/src/server/agents/agent-deployment-reconciler"
      );
      return reconcileTargetRunnerDeployment(targetRunnerId);
    });
  const reconcileRuntime = dependencies.reconcileRunnerRuntime ?? reconcileTargetRunnerRuntime;

  registerLossyCallback(schedule, async () => {
    await reconcileDeployment(runnerId).catch(() => undefined);
    await reconcileRuntime(runnerId);
  });
}

function registerLossyCallback(
  schedule: AgentRuntimeAfterScheduler,
  callback: () => Promise<void>,
): void {
  try {
    schedule(async () => {
      await callback().catch(() => {
        // The durable deployment/runtime rows remain eligible for their crons.
      });
    });
  } catch {
    // Synchronous request-scope registration failure is a dropped callback.
  }
}
