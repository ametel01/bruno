import {
  readDeploymentDispatchConfig,
  readDigitalOceanProviderConfig,
  type DigitalOceanProviderConfig,
  type DigitalOceanReleaseAttestedBootConfig,
  type DigitalOceanSnapshotModeConfig,
} from "@/src/server/env";
/*
 * Deployment choices deliberately exclude provider and runner credentials. Recovery combines
 * this immutable operational snapshot with the currently authorized credentials only.
 */

export const AGENT_DEPLOYMENT_CHOICES_SCHEMA_VERSION = "bruno.agent-deployment.choices.v1" as const;

export type AgentDeploymentChoices = {
  schemaVersion: typeof AGENT_DEPLOYMENT_CHOICES_SCHEMA_VERSION;
  dispatchMode: "cron" | "qstash";
  rolloutConfigurationGeneration: number;
  provider: {
    mode: "digitalocean" | "local_docker" | "unavailable";
    region: string;
    sizeSlug: string;
    image: string;
    tags: string[];
    runnerImage: string;
    hermesWorkloadImage: string | null;
    hermesStateRoot: string | null;
    hermesPrivateNetwork: string | null;
    hermesReadinessTimeoutMs: number | null;
    hermesDockerCpus: string | null;
    hermesDockerMemory: string | null;
    hermesDockerPidsLimit: string | null;
    runnerMaxAgents: number | null;
    snapshotMode: DigitalOceanSnapshotModeConfig;
  };
  validation:
    | { mode: "full"; releaseBundleDigest: null; snapshotBundleDigest: string | null }
    | ({
        mode: "release_attested";
        releaseBundleDigest: string;
        snapshotBundleDigest: string;
      } & Omit<DigitalOceanReleaseAttestedBootConfig, "mode">);
};

export function captureAgentDeploymentChoices(input: {
  config: DigitalOceanProviderConfig;
  dispatchMode: "cron" | "qstash";
  rolloutConfigurationGeneration: number;
}): AgentDeploymentChoices {
  if (
    !Number.isInteger(input.rolloutConfigurationGeneration) ||
    input.rolloutConfigurationGeneration < 1
  ) {
    throw new Error("Rollout Configuration generation is invalid.");
  }
  const snapshotMode: DigitalOceanSnapshotModeConfig = input.config.snapshotMode
    ? structuredClone(input.config.snapshotMode)
    : { mode: "stock" };
  const validation: AgentDeploymentChoices["validation"] = input.config.bootValidation
    ? {
        ...structuredClone(input.config.bootValidation),
        mode: "release_attested",
        releaseBundleDigest: input.config.bootValidation.approvedReleaseDigest,
        snapshotBundleDigest: input.config.bootValidation.snapshotBundleDigest,
      }
    : {
        mode: "full",
        releaseBundleDigest: null,
        snapshotBundleDigest: snapshotMode.mode === "snapshot" ? snapshotMode.approvedDigest : null,
      };

  return {
    schemaVersion: AGENT_DEPLOYMENT_CHOICES_SCHEMA_VERSION,
    dispatchMode: input.dispatchMode,
    rolloutConfigurationGeneration: input.rolloutConfigurationGeneration,
    provider: {
      mode: input.config.providerMode ?? "digitalocean",
      region: input.config.region,
      sizeSlug: input.config.sizeSlug,
      image: input.config.image,
      tags: [...input.config.tags],
      runnerImage: input.config.runnerImage,
      hermesWorkloadImage: input.config.hermesWorkloadImage ?? null,
      hermesStateRoot: input.config.hermesStateRoot ?? null,
      hermesPrivateNetwork: input.config.hermesPrivateNetwork ?? null,
      hermesReadinessTimeoutMs: input.config.hermesReadinessTimeoutMs ?? null,
      hermesDockerCpus: input.config.hermesDockerCpus ?? null,
      hermesDockerMemory: input.config.hermesDockerMemory ?? null,
      hermesDockerPidsLimit: input.config.hermesDockerPidsLimit ?? null,
      runnerMaxAgents: input.config.runnerMaxAgents ?? null,
      snapshotMode,
    },
    validation,
  };
}

export function captureAgentDeploymentChoicesFromEnvironment(
  env: Record<string, string | undefined> = process.env,
  rolloutConfigurationGeneration: number,
): AgentDeploymentChoices {
  const dispatch = readDeploymentDispatchConfig(env);
  if (!dispatch.ok) throw new Error("Deployment dispatch configuration is invalid.");
  const config = readDigitalOceanProviderConfig(env);
  if (config) {
    return captureAgentDeploymentChoices({
      config,
      dispatchMode: dispatch.mode,
      rolloutConfigurationGeneration,
    });
  }
  return {
    schemaVersion: AGENT_DEPLOYMENT_CHOICES_SCHEMA_VERSION,
    dispatchMode: dispatch.mode,
    rolloutConfigurationGeneration,
    provider: {
      mode: "unavailable",
      region: "unknown",
      sizeSlug: "unknown",
      image: "unknown",
      tags: [],
      runnerImage: "unknown",
      hermesWorkloadImage: null,
      hermesStateRoot: null,
      hermesPrivateNetwork: null,
      hermesReadinessTimeoutMs: null,
      hermesDockerCpus: null,
      hermesDockerMemory: null,
      hermesDockerPidsLimit: null,
      runnerMaxAgents: null,
      snapshotMode: { mode: "stock" },
    },
    validation: { mode: "full", releaseBundleDigest: null, snapshotBundleDigest: null },
  };
}

export function applyAgentDeploymentChoices(
  current: DigitalOceanProviderConfig,
  choices: AgentDeploymentChoices,
): DigitalOceanProviderConfig {
  const parsed = parseAgentDeploymentChoices(choices);
  if (!parsed) throw new Error("Agent Deployment choices are invalid.");
  if (parsed.provider.mode === "unavailable") {
    throw new Error("Agent Deployment provider choices are unavailable.");
  }
  const { bootValidation: _currentBootValidation, ...currentWithoutBootValidation } = current;
  const result: DigitalOceanProviderConfig = {
    ...currentWithoutBootValidation,
    providerMode: parsed.provider.mode,
    region: parsed.provider.region,
    sizeSlug: parsed.provider.sizeSlug,
    image: parsed.provider.image,
    tags: [...parsed.provider.tags],
    runnerImage: parsed.provider.runnerImage,
    snapshotMode: structuredClone(parsed.provider.snapshotMode),
    ...(parsed.validation.mode === "release_attested"
      ? {
          bootValidation: {
            mode: "release_attested",
            bundleBytes: parsed.validation.bundleBytes,
            approvedReleaseDigest: parsed.validation.approvedReleaseDigest,
            releaseTrustSetBytes: parsed.validation.releaseTrustSetBytes,
            trustedPublicKeys: structuredClone(parsed.validation.trustedPublicKeys),
            snapshotOciReference: parsed.validation.snapshotOciReference,
            snapshotBundleDigest: parsed.validation.snapshotBundleDigest,
            snapshotImageId: parsed.validation.snapshotImageId,
          },
        }
      : {}),
  };
  for (const [key, value] of [
    ["hermesWorkloadImage", parsed.provider.hermesWorkloadImage],
    ["hermesStateRoot", parsed.provider.hermesStateRoot],
    ["hermesPrivateNetwork", parsed.provider.hermesPrivateNetwork],
    ["hermesReadinessTimeoutMs", parsed.provider.hermesReadinessTimeoutMs],
    ["hermesDockerCpus", parsed.provider.hermesDockerCpus],
    ["hermesDockerMemory", parsed.provider.hermesDockerMemory],
    ["hermesDockerPidsLimit", parsed.provider.hermesDockerPidsLimit],
    ["runnerMaxAgents", parsed.provider.runnerMaxAgents],
  ] as const) {
    if (value === null) delete result[key];
    else Object.assign(result, { [key]: value });
  }
  return result;
}

export function parseAgentDeploymentChoices(value: unknown): AgentDeploymentChoices | null {
  if (
    !isExactRecord(value, [
      "dispatchMode",
      "provider",
      "rolloutConfigurationGeneration",
      "schemaVersion",
      "validation",
    ]) ||
    value.schemaVersion !== AGENT_DEPLOYMENT_CHOICES_SCHEMA_VERSION ||
    !["cron", "qstash"].includes(value.dispatchMode as never) ||
    !Number.isInteger(value.rolloutConfigurationGeneration) ||
    Number(value.rolloutConfigurationGeneration) < 1 ||
    !isProviderChoices(value.provider) ||
    !isValidationChoices(value.validation)
  ) {
    return null;
  }
  const parsed = value as AgentDeploymentChoices;
  if (
    parsed.validation.mode === "release_attested" &&
    (parsed.provider.snapshotMode.mode !== "snapshot" ||
      parsed.provider.snapshotMode.approvedDigest !== parsed.validation.snapshotBundleDigest)
  ) {
    return null;
  }
  return structuredClone(parsed);
}

function isProviderChoices(value: unknown): boolean {
  if (
    !isExactRecord(value, [
      "hermesDockerCpus",
      "hermesDockerMemory",
      "hermesDockerPidsLimit",
      "hermesPrivateNetwork",
      "hermesReadinessTimeoutMs",
      "hermesStateRoot",
      "hermesWorkloadImage",
      "image",
      "mode",
      "region",
      "runnerImage",
      "runnerMaxAgents",
      "sizeSlug",
      "snapshotMode",
      "tags",
    ]) ||
    !["digitalocean", "local_docker", "unavailable"].includes(value.mode as never) ||
    ![value.region, value.sizeSlug, value.image, value.runnerImage].every(isNonEmptyString) ||
    !Array.isArray(value.tags) ||
    !value.tags.every(isNonEmptyString) ||
    !isSnapshotMode(value.snapshotMode)
  ) {
    return false;
  }
  return (
    [
      value.hermesWorkloadImage,
      value.hermesStateRoot,
      value.hermesPrivateNetwork,
      value.hermesDockerCpus,
      value.hermesDockerMemory,
      value.hermesDockerPidsLimit,
    ].every(isNullableString) &&
    [value.hermesReadinessTimeoutMs, value.runnerMaxAgents].every(isNullablePositiveInteger)
  );
}

function isSnapshotMode(value: unknown): value is DigitalOceanSnapshotModeConfig {
  if (!isRecord(value) || (value.mode !== "stock" && value.mode !== "snapshot")) return false;
  if (value.mode === "stock") return isExactRecord(value, ["mode"]);
  return (
    isExactRecord(value, [
      "approvedDigest",
      "bundleBytes",
      "expected",
      "mode",
      "trustedPublicKeys",
    ]) &&
    isNonEmptyString(value.bundleBytes) &&
    isSha256(value.approvedDigest) &&
    isStringRecord(value.trustedPublicKeys) &&
    isRecord(value.expected)
  );
}

function isValidationChoices(value: unknown): value is AgentDeploymentChoices["validation"] {
  if (!isRecord(value)) return false;
  if (value.mode === "full") {
    return (
      isExactRecord(value, ["mode", "releaseBundleDigest", "snapshotBundleDigest"]) &&
      value.releaseBundleDigest === null &&
      (value.snapshotBundleDigest === null || isSha256(value.snapshotBundleDigest))
    );
  }
  return (
    value.mode === "release_attested" &&
    isExactRecord(value, [
      "approvedReleaseDigest",
      "bundleBytes",
      "mode",
      "releaseBundleDigest",
      "releaseTrustSetBytes",
      "snapshotBundleDigest",
      "snapshotImageId",
      "snapshotOciReference",
      "trustedPublicKeys",
    ]) &&
    isNonEmptyString(value.bundleBytes) &&
    isSha256(value.approvedReleaseDigest) &&
    value.releaseBundleDigest === value.approvedReleaseDigest &&
    isNonEmptyString(value.releaseTrustSetBytes) &&
    isStringRecord(value.trustedPublicKeys) &&
    isSha256(value.snapshotBundleDigest) &&
    isNonEmptyString(value.snapshotImageId) &&
    isNonEmptyString(value.snapshotOciReference)
  );
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function isNullableString(value: unknown): boolean {
  return value === null || isNonEmptyString(value);
}

function isNullablePositiveInteger(value: unknown): boolean {
  return value === null || (Number.isInteger(value) && Number(value) > 0);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isNonEmptyString);
}
