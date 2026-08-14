export const AGENT_DEPLOYMENT_ORIGINS = [
  "owner_request",
  "operator_trial",
  "runner_replacement",
] as const;

export type AgentDeploymentOrigin = (typeof AGENT_DEPLOYMENT_ORIGINS)[number];

export const AGENT_DEPLOYMENT_INITIAL_COHORTS = [
  "cold_deployment",
  "same_owner_reuse",
  "unknown",
] as const;

export type AgentDeploymentInitialCohort = (typeof AGENT_DEPLOYMENT_INITIAL_COHORTS)[number];

export const AGENT_DEPLOYMENT_ENVIRONMENTS = ["production", "non_production"] as const;

export type AgentDeploymentEnvironment = (typeof AGENT_DEPLOYMENT_ENVIRONMENTS)[number];

export const CURRENT_ROLLOUT_CONFIGURATION_GENERATION = 1;

export const COLD_PROVISIONING_HALT_REASONS = [
  "rollout_exercise",
  "ownership_violation",
  "authentication_violation",
  "artifact_identity_violation",
  "duplicate_billable_effect",
  "cleanup_violation",
  "repeated_functional_failure",
] as const;

export type ColdProvisioningHaltReason = (typeof COLD_PROVISIONING_HALT_REASONS)[number];

export type ColdProvisioningPolicy =
  | { ok: true; enabled: true }
  | { ok: true; enabled: false; reason: ColdProvisioningHaltReason }
  | { ok: false; enabled: false; reason: "invalid_configuration" };

export function isRolloutConfigurationGeneration(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1;
}

export function readRolloutConfigurationGeneration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.BRUNO_ROLLOUT_CONFIGURATION_GENERATION;
  if (raw === undefined) return CURRENT_ROLLOUT_CONFIGURATION_GENERATION;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error("Rollout Configuration generation is invalid.");
  }
  const generation = Number(raw);
  if (!Number.isSafeInteger(generation)) {
    throw new Error("Rollout Configuration generation is invalid.");
  }
  return generation;
}

export function readColdProvisioningPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ColdProvisioningPolicy {
  const reason = env.BRUNO_COLD_PROVISIONING_HALT_REASON;
  if (reason === undefined) return { ok: true, enabled: true };
  if (COLD_PROVISIONING_HALT_REASONS.includes(reason as ColdProvisioningHaltReason)) {
    return { ok: true, enabled: false, reason: reason as ColdProvisioningHaltReason };
  }
  return { ok: false, enabled: false, reason: "invalid_configuration" };
}

export function deploymentEnvironmentForRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentDeploymentEnvironment {
  return env.VERCEL_ENV === "production" ? "production" : "non_production";
}

export function initialCohortForAssignedRunner(
  runnerId: string | null,
): AgentDeploymentInitialCohort {
  return runnerId === null ? "cold_deployment" : "same_owner_reuse";
}
