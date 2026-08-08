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

export function isRolloutConfigurationGeneration(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1;
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
