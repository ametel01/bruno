import "server-only";

import { after } from "next/server";
import { publishLatestDeploymentWakeupAfterCommit } from "@/src/server/agents/agent-deployment-dispatch";
import {
  reconcileTargetAgentDeployment,
  reconcileTargetRunnerDeployment,
} from "@/src/server/agents/agent-deployment-reconciler";

export type AgentDeploymentAfterScheduler = (callback: () => void | Promise<void>) => void;

export type AgentDeploymentTriggerDependencies = {
  afterScheduler?: AgentDeploymentAfterScheduler;
  publishWakeup?: typeof publishLatestDeploymentWakeupAfterCommit;
  reconcile?: typeof reconcileTargetAgentDeployment;
  reconcileRunner?: typeof reconcileTargetRunnerDeployment;
};

export function scheduleAgentDeploymentReconcileAfterResponse(
  deploymentId: string,
  dependencies: AgentDeploymentTriggerDependencies = {},
): void {
  const schedule = dependencies.afterScheduler ?? after;
  const reconcile = dependencies.reconcile ?? reconcileTargetAgentDeployment;

  try {
    schedule(async () => {
      await reconcileDeploymentAfterResponse(
        deploymentId,
        reconcile,
        dependencies.publishWakeup,
      ).catch(() => {
        // The deployment row remains due for the protected cron reconciler.
      });
    });
  } catch {
    // Synchronous registration failure is equivalent to a dropped callback.
  }
}

async function reconcileDeploymentAfterResponse(
  deploymentId: string,
  reconcile: typeof reconcileTargetAgentDeployment,
  publishWakeup: typeof publishLatestDeploymentWakeupAfterCommit = publishLatestDeploymentWakeupAfterCommit,
): Promise<void> {
  const publish = await publishWakeup(deploymentId);
  if (publish === "published") {
    return;
  }

  const initialized = await reconcile(deploymentId);
  if (initialized.processed === 1 && initialized.outcome === "advanced") {
    await reconcile(deploymentId);
  }
}

export function scheduleRunnerDeploymentReconcileAfterResponse(
  runnerId: string,
  dependencies: AgentDeploymentTriggerDependencies = {},
): void {
  const schedule = dependencies.afterScheduler ?? after;
  const reconcile = dependencies.reconcileRunner ?? reconcileTargetRunnerDeployment;

  try {
    schedule(async () => {
      await reconcile(runnerId).catch(() => {
        // The deployment row remains due for the protected cron reconciler.
      });
    });
  } catch {
    // Synchronous registration failure is equivalent to a dropped callback.
  }
}
