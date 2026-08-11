import {
  readDeploymentDispatchConfig,
  readDigitalOceanProviderConfig,
  type DigitalOceanProviderConfig,
  type DigitalOceanProviderCredentials,
  type DigitalOceanReleaseAttestedBootConfig,
  type DigitalOceanSnapshotModeConfig,
} from "@/src/server/env";
import { RUNNER_BOOT_CONTRACT_VERSION } from "@/src/runner-service/constants";
import { parseImmutableRunnerImageReference } from "@/src/runner-service/release-identity";
import type { RunnerCompatibilityRequirement } from "@/src/server/runners/runner-compatibility";
/*
 * Deployment choices deliberately exclude provider and runner credentials. Recovery combines
 * this immutable operational snapshot with the currently authorized credentials only.
 */

export const AGENT_DEPLOYMENT_CHOICES_SCHEMA_VERSION = "bruno.agent-deployment.choices.v1" as const;
const LEGACY_V1_RUNNER_BOOT_CONTRACT_VERSION = "bruno.runner.boot.v1";

export type DeploymentRunnerBootValidationRequirement =
  | { mode: "full" }
  | { mode: "unavailable" }
  | {
      mode: "release_attested";
      releaseBundleDigest: string;
      snapshotBundleDigest: string;
      snapshotImageId: string;
    };

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
    runnerBootContractVersion: string;
    hermesWorkloadImage: string | null;
    hermesStateRoot: string | null;
    hermesPrivateNetwork: string | null;
    hermesReadinessTimeoutMs: number | null;
    hermesDockerCpus: string | null;
    hermesDockerMemory: string | null;
    hermesDockerPidsLimit: string | null;
    runnerMaxAgents: number | null;
    sshKeyIds: string[];
    sshSourceAddresses: string[];
    localRunnerEndpointUrl: string | null;
    localRunnerContainerName: string | null;
    localRunnerStartDelayMs: number | null;
    localAgentSmokeMode: boolean;
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
      runnerBootContractVersion:
        input.config.runnerBootContractVersion ?? RUNNER_BOOT_CONTRACT_VERSION,
      hermesWorkloadImage: input.config.hermesWorkloadImage ?? null,
      hermesStateRoot: input.config.hermesStateRoot ?? null,
      hermesPrivateNetwork: input.config.hermesPrivateNetwork ?? null,
      hermesReadinessTimeoutMs: input.config.hermesReadinessTimeoutMs ?? null,
      hermesDockerCpus: input.config.hermesDockerCpus ?? null,
      hermesDockerMemory: input.config.hermesDockerMemory ?? null,
      hermesDockerPidsLimit: input.config.hermesDockerPidsLimit ?? null,
      runnerMaxAgents: input.config.runnerMaxAgents ?? null,
      sshKeyIds: [...(input.config.sshKeyIds ?? [])],
      sshSourceAddresses:
        input.config.sshKeyIds && input.config.sshKeyIds.length > 0
          ? [...(input.config.sshSourceAddresses ?? ["0.0.0.0/0", "::/0"])]
          : [],
      localRunnerEndpointUrl: input.config.localRunnerEndpointUrl ?? null,
      localRunnerContainerName: input.config.localRunnerContainerName ?? null,
      localRunnerStartDelayMs: input.config.localRunnerStartDelayMs ?? null,
      localAgentSmokeMode: input.config.localAgentSmokeMode ?? false,
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
      runnerBootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      hermesWorkloadImage: null,
      hermesStateRoot: null,
      hermesPrivateNetwork: null,
      hermesReadinessTimeoutMs: null,
      hermesDockerCpus: null,
      hermesDockerMemory: null,
      hermesDockerPidsLimit: null,
      runnerMaxAgents: null,
      sshKeyIds: [],
      sshSourceAddresses: [],
      localRunnerEndpointUrl: null,
      localRunnerContainerName: null,
      localRunnerStartDelayMs: null,
      localAgentSmokeMode: false,
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
    runnerBootContractVersion: parsed.provider.runnerBootContractVersion,
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
  result.sshKeyIds = [...parsed.provider.sshKeyIds];
  result.sshSourceAddresses = [...parsed.provider.sshSourceAddresses];
  for (const [key, value] of [
    ["localRunnerEndpointUrl", parsed.provider.localRunnerEndpointUrl],
    ["localRunnerContainerName", parsed.provider.localRunnerContainerName],
    ["localRunnerStartDelayMs", parsed.provider.localRunnerStartDelayMs],
    ["localAgentSmokeMode", parsed.provider.localAgentSmokeMode],
  ] as const) {
    if (value === null || value === false) delete result[key];
    else Object.assign(result, { [key]: value });
  }
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

export function recoverAgentDeploymentProviderConfig(
  credentials: DigitalOceanProviderCredentials,
  choices: AgentDeploymentChoices,
): DigitalOceanProviderConfig {
  return applyAgentDeploymentChoices(
    {
      ...credentials,
      runnerImage: choices.provider.runnerImage,
      region: choices.provider.region,
      sizeSlug: choices.provider.sizeSlug,
      image: choices.provider.image,
      tags: [...choices.provider.tags],
    },
    choices,
  );
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
  const parsed = normalizeProviderChoices(value as AgentDeploymentChoices);
  if (
    parsed.validation.mode === "release_attested" &&
    (parsed.provider.snapshotMode.mode !== "snapshot" ||
      parsed.provider.snapshotMode.approvedDigest !== parsed.validation.snapshotBundleDigest)
  ) {
    return null;
  }
  return structuredClone(parsed);
}

export function runnerCompatibilityRequirementForAgentDeploymentChoices(
  choices: AgentDeploymentChoices,
): RunnerCompatibilityRequirement {
  if (choices.provider.mode === "unavailable") return { mode: "unavailable", release: null };
  if (choices.provider.mode === "local_docker") return { mode: "local_docker", release: null };
  const release = parseImmutableRunnerImageReference(choices.provider.runnerImage);
  return release
    ? {
        mode: "hosted",
        release: {
          version: release.version,
          imageDigest: release.imageDigest,
          bootContractVersion: choices.provider.runnerBootContractVersion,
        },
      }
    : { mode: "unavailable", release: null };
}

export function runnerBootValidationRequirementForAgentDeploymentChoices(
  choices: AgentDeploymentChoices,
): DeploymentRunnerBootValidationRequirement {
  if (choices.provider.mode === "unavailable") return { mode: "unavailable" };
  if (choices.validation.mode === "full") return { mode: "full" };
  return {
    mode: "release_attested",
    releaseBundleDigest: choices.validation.releaseBundleDigest,
    snapshotBundleDigest: choices.validation.snapshotBundleDigest,
    snapshotImageId: choices.validation.snapshotImageId,
  };
}

export function runnerBootValidationRequirementForProviderConfig(
  config: DigitalOceanProviderConfig,
): DeploymentRunnerBootValidationRequirement {
  return config.bootValidation
    ? {
        mode: "release_attested",
        releaseBundleDigest: config.bootValidation.approvedReleaseDigest,
        snapshotBundleDigest: config.bootValidation.snapshotBundleDigest,
        snapshotImageId: config.bootValidation.snapshotImageId,
      }
    : { mode: "full" };
}

function normalizeProviderChoices(choices: AgentDeploymentChoices): AgentDeploymentChoices {
  const provider = choices.provider as AgentDeploymentChoices["provider"] & {
    runnerBootContractVersion?: string;
    sshKeyIds?: string[] | null;
    sshSourceAddresses?: string[];
    localRunnerEndpointUrl?: string | null;
    localRunnerContainerName?: string | null;
    localRunnerStartDelayMs?: number | null;
    localAgentSmokeMode?: boolean;
  };
  return {
    ...choices,
    provider: {
      ...provider,
      // Missing v1 extension fields have fixed historical semantics. They never inherit
      // mutable environment or provider-account defaults during recovery.
      runnerBootContractVersion:
        provider.runnerBootContractVersion ?? LEGACY_V1_RUNNER_BOOT_CONTRACT_VERSION,
      sshKeyIds: [...(provider.sshKeyIds ?? [])],
      sshSourceAddresses: [...(provider.sshSourceAddresses ?? [])],
      localRunnerEndpointUrl:
        provider.localRunnerEndpointUrl ??
        (provider.mode === "local_docker" ? "http://127.0.0.1:3045" : null),
      localRunnerContainerName:
        provider.localRunnerContainerName ??
        (provider.mode === "local_docker" ? "bruno-local-cloud-runner" : null),
      localRunnerStartDelayMs:
        provider.localRunnerStartDelayMs ?? (provider.mode === "local_docker" ? 1_000 : null),
      localAgentSmokeMode: provider.localAgentSmokeMode ?? false,
    },
  };
}

function isProviderChoices(value: unknown): boolean {
  const legacyKeys = [
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
  ] as const;
  const completeKeys = [
    ...legacyKeys,
    "localAgentSmokeMode",
    "localRunnerContainerName",
    "localRunnerEndpointUrl",
    "localRunnerStartDelayMs",
    "sshKeyIds",
    "sshSourceAddresses",
  ] as const;
  const bootContractKeys = [...completeKeys, "runnerBootContractVersion"] as const;
  if (
    (!isExactRecord(value, legacyKeys) &&
      !isExactRecord(value, completeKeys) &&
      !isExactRecord(value, bootContractKeys)) ||
    !["digitalocean", "local_docker", "unavailable"].includes(value.mode as never) ||
    ![value.region, value.sizeSlug, value.image, value.runnerImage].every(isNonEmptyString) ||
    !Array.isArray(value.tags) ||
    !value.tags.every(isNonEmptyString) ||
    !isSnapshotMode(value.snapshotMode)
  ) {
    return false;
  }
  const baseValid =
    [
      value.hermesWorkloadImage,
      value.hermesStateRoot,
      value.hermesPrivateNetwork,
      value.hermesDockerCpus,
      value.hermesDockerMemory,
      value.hermesDockerPidsLimit,
    ].every(isNullableString) &&
    [value.hermesReadinessTimeoutMs, value.runnerMaxAgents].every(isNullablePositiveInteger);
  if (!baseValid || !("sshKeyIds" in value)) return baseValid;
  return (
    (value.sshKeyIds === null ||
      (Array.isArray(value.sshKeyIds) && value.sshKeyIds.every(isNonEmptyString))) &&
    Array.isArray(value.sshSourceAddresses) &&
    value.sshSourceAddresses.every(isNonEmptyString) &&
    isNullableString(value.localRunnerEndpointUrl) &&
    isNullableString(value.localRunnerContainerName) &&
    isNullableNonNegativeInteger(value.localRunnerStartDelayMs) &&
    typeof value.localAgentSmokeMode === "boolean" &&
    (!("runnerBootContractVersion" in value) || isNonEmptyString(value.runnerBootContractVersion))
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

function isNullableNonNegativeInteger(value: unknown): boolean {
  return value === null || (Number.isInteger(value) && Number(value) >= 0);
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
