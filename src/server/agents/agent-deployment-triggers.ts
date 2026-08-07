import "server-only";

import { after } from "next/server";
import { publishLatestDeploymentWakeupAfterCommit } from "@/src/server/agents/agent-deployment-dispatch";
import {
  drainTargetAgentDeployment,
  drainTargetRunnerDeployment,
} from "@/src/server/agents/agent-deployment-reconciler";

export type AgentDeploymentAfterScheduler = (callback: () => void | Promise<void>) => void;

export type AgentDeploymentTriggerDependencies = {
  afterScheduler?: AgentDeploymentAfterScheduler;
  publishWakeup?: typeof publishLatestDeploymentWakeupAfterCommit;
  reconcile?: typeof drainTargetAgentDeployment;
  reconcileRunner?: typeof drainTargetRunnerDeployment;
};

export function scheduleAgentDeploymentReconcileAfterResponse(
  deploymentId: string,
  dependencies: AgentDeploymentTriggerDependencies = {},
): void {
  const schedule = dependencies.afterScheduler ?? after;
  const reconcile = dependencies.reconcile ?? drainTargetAgentDeployment;

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
  reconcile: typeof drainTargetAgentDeployment,
  publishWakeup: typeof publishLatestDeploymentWakeupAfterCommit = publishLatestDeploymentWakeupAfterCommit,
): Promise<void> {
  const publish = await publishWakeup(deploymentId);
  if (publish === "published") {
    return;
  }

  await reconcile(deploymentId);
}

export function scheduleRunnerDeploymentReconcileAfterResponse(
  runnerId: string,
  dependencies: AgentDeploymentTriggerDependencies = {},
): void {
  const schedule = dependencies.afterScheduler ?? after;
  const reconcile = dependencies.reconcileRunner ?? drainTargetRunnerDeployment;

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
