import "server-only";

import { after } from "next/server";
import {
  reconcileTargetAgentDeployment,
  reconcileTargetRunnerDeployment,
} from "@/src/server/agents/agent-deployment-reconciler";

export type AgentDeploymentAfterScheduler = (callback: () => void | Promise<void>) => void;

export type AgentDeploymentTriggerDependencies = {
  afterScheduler?: AgentDeploymentAfterScheduler;
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
      await reconcile(deploymentId).catch(() => {
        // The deployment row remains due for the protected cron reconciler.
      });
    });
  } catch {
    // Synchronous registration failure is equivalent to a dropped callback.
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
