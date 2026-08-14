import { notInArray } from "drizzle-orm";
import {
  captureAgentDeploymentChoicesFromEnvironment,
  parseAgentDeploymentChoices,
} from "@/src/server/agents/agent-deployment-choices";
import { parseAgentSecretKeyring } from "@/src/server/agents/agent-secrets";
import {
  readColdProvisioningPolicy,
  readRolloutConfigurationGeneration,
} from "@/src/server/agents/deployment-slo-identity";
import type { DatabaseConnection } from "@/src/server/db/client";
import { agentDeployments } from "@/src/server/db/schema";
import { DEFAULT_DEPLOYMENT_WAKEUP_MAX_PUBLISH_ATTEMPTS } from "@/src/server/env";

export type ProductionRolloutStatus = {
  schemaVersion: "bruno.production-rollout.status.v1";
  current: {
    generation: number;
    dispatchMode: "cron" | "qstash";
    recoveryMaxPublishAttempts: number;
    imageMode: "stock" | "snapshot";
    validationMode: "full" | "release_attested";
    runnerSizeSlug: string;
    credentialConfigurationValid: true;
    coldProvisioning: { enabled: true } | { enabled: false; reason: string };
  };
  activeDeployments: {
    count: number;
    generationCounts: Array<{ generation: number | null; count: number }>;
    pinnedChoicesValid: boolean;
  };
};

export async function readProductionRolloutStatus(
  connection: DatabaseConnection,
  env: Record<string, string | undefined> = process.env,
): Promise<ProductionRolloutStatus> {
  const generation = readRolloutConfigurationGeneration(env);
  parseAgentSecretKeyring(env);
  const choices = captureAgentDeploymentChoicesFromEnvironment(env, generation);
  if (choices.provider.mode !== "digitalocean") {
    throw new Error("Production rollout provider configuration is invalid.");
  }
  const coldProvisioning = readColdProvisioningPolicy(env);
  if (!coldProvisioning.ok) throw new Error("Cold provisioning configuration is invalid.");

  const rows = await connection.db
    .select({
      generation: agentDeployments.rolloutConfigurationGeneration,
      choices: agentDeployments.deploymentChoices,
    })
    .from(agentDeployments)
    .where(notInArray(agentDeployments.stage, ["ready", "failed"]));
  const generationCounts = new Map<number | null, number>();
  let pinnedChoicesValid = true;
  for (const row of rows) {
    generationCounts.set(row.generation, (generationCounts.get(row.generation) ?? 0) + 1);
    const parsed = parseAgentDeploymentChoices(row.choices);
    if (!parsed || parsed.rolloutConfigurationGeneration !== row.generation) {
      pinnedChoicesValid = false;
    }
  }

  return {
    schemaVersion: "bruno.production-rollout.status.v1",
    current: {
      generation,
      dispatchMode: choices.dispatchMode,
      recoveryMaxPublishAttempts: readRecoveryMaxPublishAttempts(env),
      imageMode: choices.provider.snapshotMode.mode,
      validationMode: choices.validation.mode,
      runnerSizeSlug: choices.provider.sizeSlug,
      credentialConfigurationValid: true,
      coldProvisioning: coldProvisioning.enabled
        ? { enabled: true }
        : { enabled: false, reason: coldProvisioning.reason },
    },
    activeDeployments: {
      count: rows.length,
      generationCounts: [...generationCounts]
        .sort(([left], [right]) => (left ?? 0) - (right ?? 0))
        .map(([activeGeneration, count]) => ({
          generation: activeGeneration,
          count,
        })),
      pinnedChoicesValid,
    },
  };
}

function readRecoveryMaxPublishAttempts(env: Record<string, string | undefined>): number {
  const raw = env.BRUNO_DEPLOYMENT_WAKEUP_MAX_PUBLISH_ATTEMPTS;
  if (raw === undefined) return DEFAULT_DEPLOYMENT_WAKEUP_MAX_PUBLISH_ATTEMPTS;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error("Recovery bound is invalid.");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > 100) throw new Error("Recovery bound is invalid.");
  return parsed;
}
