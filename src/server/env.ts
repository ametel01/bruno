import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import {
  EnvValidationError,
  validateManualRunnerEndpointUrl,
  validateRequiredEnv,
} from "@/src/env/validation";
import {
  DEFAULT_HERMES_DOCKER_CPUS,
  DEFAULT_HERMES_DOCKER_MEMORY,
  DEFAULT_HERMES_DOCKER_PIDS_LIMIT,
  DEFAULT_HERMES_PRIVATE_NETWORK,
  DEFAULT_HERMES_READINESS_TIMEOUT_MS,
  DEFAULT_HERMES_RUNNER_MAX_AGENTS,
  DEFAULT_HERMES_STATE_ROOT,
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  DEFAULT_MANUAL_RUNNER_IMAGE,
} from "@/src/runner-service/constants";
import { parseImmutableRunnerImageReference } from "@/src/runner-service/release-identity";
import {
  parseRunnerReleaseBundle,
  verifyRunnerReleaseBundle,
  type RunnerReleaseTrustedPublicKeys,
} from "@/src/runner-service/release-attestation";
import {
  findDigitalOceanRunnerResourceProfile,
  MAX_HERMES_DOCKER_PIDS_LIMIT,
  PROVISIONAL_DIGITALOCEAN_RUNNER_SIZE_SLUG,
  parseHermesDockerCpus,
  parseHermesDockerMemoryMiB,
  parseHermesDockerPidsLimit,
  validateDigitalOceanRunnerResourceCompatibility,
} from "@/src/server/runners/runner-resource-profiles";
import {
  isRunnerSnapshotSigningKeyId,
  type RunnerSnapshotExpectedIdentities,
  type RunnerSnapshotTrustedPublicKeys,
  verifyRunnerSnapshotBundle,
} from "@/src/server/runners/runner-snapshot-manifest";

export const DEFAULT_BRUNO_RUNNER_IMAGE = "ghcr.io/ametel01/bruno-runner:main";
export const DEFAULT_DEPLOYMENT_WAKEUP_MAX_PUBLISH_ATTEMPTS = 12;

export type ReadyAgentCreationFlag =
  | {
      ok: true;
      enabled: boolean;
    }
  | {
      ok: false;
      reason: "invalid_ready_agent_creation_flag";
    };

export type DigitalOceanProviderConfig = {
  token: string;
  providerMode?: "digitalocean" | "local_docker";
  runnerBearerToken: string;
  runnerImage: string;
  runnerBootContractVersion?: string;
  hermesWorkloadImage?: string;
  hermesStateRoot?: string;
  hermesPrivateNetwork?: string;
  hermesReadinessTimeoutMs?: number;
  hermesDockerCpus?: string;
  hermesDockerMemory?: string;
  hermesDockerPidsLimit?: string;
  runnerMaxAgents?: number;
  region: string;
  sizeSlug: string;
  image: string;
  tags: string[];
  sshKeyIds?: string[];
  sshSourceAddresses?: string[];
  localRunnerEndpointUrl?: string;
  localRunnerContainerName?: string;
  localRunnerStartDelayMs?: number;
  localAgentSmokeMode?: boolean;
  snapshotMode?: DigitalOceanSnapshotModeConfig;
  bootValidation?: DigitalOceanReleaseAttestedBootConfig;
};

export type DigitalOceanProviderCredentials = Pick<
  DigitalOceanProviderConfig,
  "token" | "runnerBearerToken"
>;

export type DigitalOceanReleaseAttestedBootConfig = {
  mode: "release_attested";
  bundleBytes: string;
  approvedReleaseDigest: string;
  releaseTrustSetBytes: string;
  trustedPublicKeys: RunnerReleaseTrustedPublicKeys;
  snapshotOciReference: string;
  snapshotBundleDigest: string;
  snapshotImageId: string;
};

export type DigitalOceanSnapshotModeConfig =
  | { mode: "stock" }
  | {
      mode: "snapshot";
      bundleBytes: string;
      approvedDigest: string;
      trustedPublicKeys: RunnerSnapshotTrustedPublicKeys;
      expected: RunnerSnapshotExpectedIdentities;
    };

export type CronSecretConfig =
  | {
      ok: true;
      secret: string;
    }
  | {
      ok: false;
      reason: "cron_configuration_invalid";
    };

export type DeploymentDispatchConfig =
  | {
      ok: true;
      mode: "cron";
    }
  | {
      ok: true;
      mode: "qstash";
      token: string;
      currentSigningKey: string;
      nextSigningKey: string;
      callbackBaseUrl: string;
      maxPublishAttempts: number;
    }
  | {
      ok: false;
      reason: "deployment_dispatch_configuration_invalid";
    };

export type HermesStagingAcceptanceConfig =
  | {
      ok: true;
      enabled: false;
    }
  | {
      ok: true;
      enabled: true;
      baseUrl: string;
      bearerSecret: string;
    }
  | {
      ok: false;
      reason: "hermes_staging_acceptance_configuration_invalid";
    };

export function getServerEnv(input = process.env) {
  return validateRequiredEnv(input);
}

export function readReadyAgentCreationFlag(
  input: Record<string, string | undefined> = process.env,
): ReadyAgentCreationFlag {
  const rawValue = input.BRUNO_READY_AGENT_CREATION_ENABLED;

  if (rawValue === undefined) {
    return { ok: true, enabled: false };
  }

  const normalizedValue = rawValue.trim();

  if (normalizedValue === "" || normalizedValue === "false") {
    return { ok: true, enabled: false };
  }

  if (normalizedValue === "true") {
    return { ok: true, enabled: true };
  }

  return { ok: false, reason: "invalid_ready_agent_creation_flag" };
}

export function readRunnerRolloutBatchSize(
  input: Record<string, string | undefined> = process.env,
): 0 | 1 {
  const value = input.BRUNO_RUNNER_ROLLOUT_BATCH_SIZE?.trim();

  if (value === undefined || value === "1") {
    return 1;
  }

  if (value === "0") {
    return 0;
  }

  throw new EnvValidationError([
    "BRUNO_RUNNER_ROLLOUT_BATCH_SIZE must be 0 (halted) or 1 (gradual) when set.",
  ]);
}

export function readCronSecretConfig(
  input: Record<string, string | undefined> = process.env,
): CronSecretConfig {
  const secret = input.CRON_SECRET;

  if (
    secret === undefined ||
    !/^[A-Za-z0-9._~+/=-]{32,256}$/.test(secret) ||
    secret.trim() !== secret
  ) {
    return { ok: false, reason: "cron_configuration_invalid" };
  }

  return { ok: true, secret };
}

export function readDeploymentDispatchConfig(
  input: Record<string, string | undefined> = process.env,
): DeploymentDispatchConfig {
  const rawMode = input.BRUNO_DEPLOYMENT_DISPATCH_MODE?.trim();
  const mode = rawMode === undefined || rawMode === "" ? "cron" : rawMode;

  if (mode === "cron") {
    return { ok: true, mode };
  }

  if (mode !== "qstash") {
    return { ok: false, reason: "deployment_dispatch_configuration_invalid" };
  }

  const token = input.QSTASH_TOKEN;
  const currentSigningKey = input.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = input.QSTASH_NEXT_SIGNING_KEY;
  const callbackBaseUrl = parseDeploymentDispatchCallbackBaseUrl(input.NEXT_PUBLIC_APP_URL);
  const maxPublishAttempts = parseDeploymentWakeupMaxPublishAttempts(
    input.BRUNO_DEPLOYMENT_WAKEUP_MAX_PUBLISH_ATTEMPTS,
  );

  if (
    token === undefined ||
    !isValidDedicatedBearerSecret(token) ||
    currentSigningKey === undefined ||
    !isValidDeploymentDispatchSigningKey(currentSigningKey) ||
    nextSigningKey === undefined ||
    !isValidDeploymentDispatchSigningKey(nextSigningKey) ||
    currentSigningKey === nextSigningKey ||
    callbackBaseUrl === null ||
    maxPublishAttempts === null ||
    [input.CRON_SECRET, input.BRUNO_RUNNER_BEARER_TOKEN, input.BRUNO_OPERATOR_PASSWORD].some(
      (otherSecret) => otherSecret !== undefined && otherSecret === token,
    )
  ) {
    return { ok: false, reason: "deployment_dispatch_configuration_invalid" };
  }

  return {
    ok: true,
    mode,
    token,
    currentSigningKey,
    nextSigningKey,
    callbackBaseUrl,
    maxPublishAttempts,
  };
}

function parseDeploymentWakeupMaxPublishAttempts(value: string | undefined): number | null {
  if (value === undefined) {
    return DEFAULT_DEPLOYMENT_WAKEUP_MAX_PUBLISH_ATTEMPTS;
  }

  const normalized = value.trim();
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(normalized)) {
    return null;
  }

  return Number(normalized);
}

export function isAuthorizedCronRequest(input: {
  authorizationHeader: string | null;
  secret: string;
}): boolean {
  const header = input.authorizationHeader;

  if (!header?.startsWith("Bearer ")) {
    return false;
  }

  const credential = header.slice("Bearer ".length);

  if (
    credential.length === 0 ||
    credential.includes(" ") ||
    !/^[A-Za-z0-9._~+/=-]{32,256}$/.test(credential)
  ) {
    return false;
  }

  const expected = createHash("sha256").update(input.secret).digest();
  const actual = createHash("sha256").update(credential).digest();

  return timingSafeEqual(expected, actual);
}

export function readHermesStagingAcceptanceConfig(
  input: Record<string, string | undefined> = process.env,
): HermesStagingAcceptanceConfig {
  const enabled = input.BRUNO_HERMES_STAGING_ACCEPTANCE_ENABLED;

  if (enabled === undefined || enabled === "false") {
    return { ok: true, enabled: false };
  }

  if (enabled !== "true") {
    return { ok: false, reason: "hermes_staging_acceptance_configuration_invalid" };
  }

  const bearerSecret = input.BRUNO_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET;
  const baseUrl = parseHermesStagingAcceptanceBaseUrl(
    input.BRUNO_HERMES_STAGING_ACCEPTANCE_BASE_URL,
  );

  if (
    bearerSecret === undefined ||
    !isValidDedicatedBearerSecret(bearerSecret) ||
    !baseUrl ||
    [input.CRON_SECRET, input.BRUNO_RUNNER_BEARER_TOKEN, input.BRUNO_OPERATOR_PASSWORD].some(
      (otherSecret) => otherSecret !== undefined && otherSecret === bearerSecret,
    )
  ) {
    return { ok: false, reason: "hermes_staging_acceptance_configuration_invalid" };
  }

  return { ok: true, enabled: true, baseUrl, bearerSecret };
}

export function isAuthorizedHermesStagingAcceptanceRequest(input: {
  authorizationHeader: string | null;
  bearerSecret: string;
}): boolean {
  const header = input.authorizationHeader;

  if (!header?.startsWith("Bearer ")) {
    return false;
  }

  const credential = header.slice("Bearer ".length);

  if (!isValidDedicatedBearerSecret(credential)) {
    return false;
  }

  const expected = createHash("sha256").update(input.bearerSecret).digest();
  const actual = createHash("sha256").update(credential).digest();

  return timingSafeEqual(expected, actual);
}

function isValidDedicatedBearerSecret(value: string): boolean {
  return /^[A-Za-z0-9._~+/=-]{32,256}$/.test(value);
}

function isValidDeploymentDispatchSigningKey(value: string): boolean {
  return /^[A-Za-z0-9._~+/=-]{32,512}$/.test(value) && value.trim() === value;
}

function parseDeploymentDispatchCallbackBaseUrl(value: string | undefined): string | null {
  if (value === undefined || value.trim() !== value || value.length === 0) {
    return null;
  }

  try {
    const url = new URL(value);

    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

function parseHermesStagingAcceptanceBaseUrl(value: string | undefined): string | null {
  if (value === undefined || value.trim() !== value || value.length === 0) {
    return null;
  }

  try {
    const url = new URL(value);

    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

export function readDigitalOceanProviderConfig(
  input: Record<string, string | undefined> = process.env,
): DigitalOceanProviderConfig | null {
  const credentials = readDigitalOceanProviderCredentials(input);

  if (!credentials) return null;

  const { token, runnerBearerToken } = credentials;

  const sshKeyIds = readDigitalOceanSshKeyIds(input.BRUNO_DIGITALOCEAN_SSH_KEY_IDS);
  const providerMode = readDigitalOceanProviderMode(input.BRUNO_DIGITALOCEAN_PROVIDER_MODE);
  const runnerImage = readRunnerImage(input.BRUNO_RUNNER_IMAGE, {
    envName: "BRUNO_RUNNER_IMAGE",
    defaultValue: DEFAULT_BRUNO_RUNNER_IMAGE,
  });

  const localRunnerEndpointUrl =
    providerMode === "local_docker"
      ? validateManualRunnerEndpointUrl(
          readNonEmptyProviderSetting(input.BRUNO_LOCAL_CLOUD_RUNNER_ENDPOINT_URL, {
            envName: "BRUNO_LOCAL_CLOUD_RUNNER_ENDPOINT_URL",
            defaultValue: "http://127.0.0.1:3045",
          }),
        )
      : undefined;
  const localRunnerContainerName =
    providerMode === "local_docker"
      ? readNonEmptyProviderSetting(input.BRUNO_LOCAL_CLOUD_RUNNER_CONTAINER_NAME, {
          envName: "BRUNO_LOCAL_CLOUD_RUNNER_CONTAINER_NAME",
          defaultValue: "bruno-local-cloud-runner",
        })
      : undefined;
  const localRunnerStartDelayMs =
    providerMode === "local_docker"
      ? readNonNegativeInteger(input.BRUNO_LOCAL_CLOUD_RUNNER_START_DELAY_MS, {
          envName: "BRUNO_LOCAL_CLOUD_RUNNER_START_DELAY_MS",
          defaultValue: 1_000,
        })
      : undefined;
  const localAgentSmokeMode = input.BRUNO_LOCAL_AGENT_SMOKE_MODE;

  if (
    localAgentSmokeMode !== undefined &&
    (providerMode !== "local_docker" ||
      token !== "local-docker" ||
      localAgentSmokeMode !== "synthetic-external-boundaries")
  ) {
    throw new EnvValidationError([
      "BRUNO_LOCAL_AGENT_SMOKE_MODE requires the local_docker provider, the exact local-docker token, and the synthetic-external-boundaries value.",
    ]);
  }

  const config: DigitalOceanProviderConfig = {
    token,
    providerMode,
    runnerBearerToken,
    runnerImage,
    hermesWorkloadImage: readHermesWorkloadImage(input),
    hermesStateRoot: readAbsoluteRuntimePath(input.BRUNO_HERMES_STATE_ROOT, {
      envName: "BRUNO_HERMES_STATE_ROOT",
      defaultValue: DEFAULT_HERMES_STATE_ROOT,
    }),
    hermesPrivateNetwork: readDockerNetworkName(input.BRUNO_HERMES_PRIVATE_NETWORK, {
      envName: "BRUNO_HERMES_PRIVATE_NETWORK",
      defaultValue: DEFAULT_HERMES_PRIVATE_NETWORK,
    }),
    hermesReadinessTimeoutMs: readPositiveInteger(input.BRUNO_HERMES_READINESS_TIMEOUT_MS, {
      envName: "BRUNO_HERMES_READINESS_TIMEOUT_MS",
      defaultValue: DEFAULT_HERMES_READINESS_TIMEOUT_MS,
    }),
    hermesDockerCpus: readDockerCpuLimit(input.BRUNO_HERMES_DOCKER_CPUS, {
      envName: "BRUNO_HERMES_DOCKER_CPUS",
      defaultValue: DEFAULT_HERMES_DOCKER_CPUS,
    }),
    hermesDockerMemory: readDockerMemoryLimit(input.BRUNO_HERMES_DOCKER_MEMORY, {
      envName: "BRUNO_HERMES_DOCKER_MEMORY",
      defaultValue: DEFAULT_HERMES_DOCKER_MEMORY,
    }),
    hermesDockerPidsLimit: readDockerPidsLimit(input.BRUNO_HERMES_DOCKER_PIDS_LIMIT, {
      envName: "BRUNO_HERMES_DOCKER_PIDS_LIMIT",
      defaultValue: DEFAULT_HERMES_DOCKER_PIDS_LIMIT,
    }),
    runnerMaxAgents: readPositiveInteger(input.BRUNO_RUNNER_MAX_AGENTS, {
      envName: "BRUNO_RUNNER_MAX_AGENTS",
      defaultValue: DEFAULT_HERMES_RUNNER_MAX_AGENTS,
    }),
    region: readDigitalOceanSlug(input.BRUNO_DIGITALOCEAN_REGION, {
      envName: "BRUNO_DIGITALOCEAN_REGION",
      defaultValue: "sfo3",
    }),
    sizeSlug: readDigitalOceanSlug(input.BRUNO_DIGITALOCEAN_SIZE_SLUG, {
      envName: "BRUNO_DIGITALOCEAN_SIZE_SLUG",
      defaultValue: PROVISIONAL_DIGITALOCEAN_RUNNER_SIZE_SLUG,
    }),
    image: readDigitalOceanSlug(input.BRUNO_DIGITALOCEAN_IMAGE, {
      envName: "BRUNO_DIGITALOCEAN_IMAGE",
      defaultValue: "ubuntu-24-04-x64",
    }),
    tags: readDigitalOceanTags(input.BRUNO_DIGITALOCEAN_TAGS),
    sshSourceAddresses: readDigitalOceanSshSourceAddresses(
      input.BRUNO_DIGITALOCEAN_SSH_SOURCE_CIDRS,
      input.BRUNO_DIGITALOCEAN_ALLOW_PUBLIC_SSH,
    ),
    ...(sshKeyIds === null ? {} : { sshKeyIds }),
    ...(localRunnerEndpointUrl ? { localRunnerEndpointUrl } : {}),
    ...(localRunnerContainerName ? { localRunnerContainerName } : {}),
    ...(localRunnerStartDelayMs === undefined ? {} : { localRunnerStartDelayMs }),
    ...(localAgentSmokeMode === undefined ? {} : { localAgentSmokeMode: true }),
  };

  const snapshotMode = readDigitalOceanSnapshotMode(input, {
    region: config.region,
    sizeSlug: config.sizeSlug,
    baseImageSlug: config.image,
    runnerImage: config.runnerImage,
    hermesImage: config.hermesWorkloadImage ?? DEFAULT_HERMES_WORKLOAD_IMAGE,
  });
  config.snapshotMode = snapshotMode;
  const bootValidation = readDigitalOceanRunnerBootValidation(input, config, snapshotMode);
  if (bootValidation) config.bootValidation = bootValidation;

  if (providerMode === "digitalocean" && !parseImmutableRunnerImageReference(runnerImage)) {
    throw new EnvValidationError([
      "BRUNO_RUNNER_IMAGE must be an immutable registry image reference with a sha256 digest for hosted DigitalOcean provisioning.",
    ]);
  }

  if (providerMode === "digitalocean" || config.localAgentSmokeMode) {
    const resourceCompatibility = validateDigitalOceanRunnerResourceCompatibility(config);

    if (!resourceCompatibility.ok) {
      throw new EnvValidationError(resourceCompatibility.issues.map((issue) => issue.message));
    }
  }

  return config;
}

export function readDigitalOceanProviderCredentials(
  input: Record<string, string | undefined> = process.env,
): DigitalOceanProviderCredentials | null {
  const token = input.BRUNO_DIGITALOCEAN_TOKEN?.trim();

  if (token === undefined) return null;
  if (!token) {
    throw new EnvValidationError(["BRUNO_DIGITALOCEAN_TOKEN cannot be blank."]);
  }

  const runnerBearerToken = input.BRUNO_RUNNER_BEARER_TOKEN?.trim();
  if (!runnerBearerToken) {
    throw new EnvValidationError([
      "BRUNO_RUNNER_BEARER_TOKEN is required when DigitalOcean provisioning is set.",
    ]);
  }

  return { token, runnerBearerToken };
}

function readDigitalOceanRunnerBootValidation(
  input: Record<string, string | undefined>,
  config: DigitalOceanProviderConfig,
  snapshotMode: DigitalOceanSnapshotModeConfig,
): DigitalOceanReleaseAttestedBootConfig | undefined {
  const mode = input.BRUNO_RUNNER_BOOT_VALIDATION_MODE?.trim() || "full";
  if (mode === "full") return undefined;
  if (mode !== "release_attested") {
    throw new EnvValidationError([
      "BRUNO_RUNNER_BOOT_VALIDATION_MODE must be full or release_attested when set.",
    ]);
  }
  if (snapshotMode.mode !== "snapshot") {
    throw new EnvValidationError([
      "BRUNO_RUNNER_BOOT_VALIDATION_MODE=release_attested requires an Approved Snapshot.",
    ]);
  }

  const bundleBytes = readRequiredSnapshotSetting(
    input.BRUNO_RUNNER_RELEASE_BUNDLE,
    "BRUNO_RUNNER_RELEASE_BUNDLE",
  );
  const approvedReleaseDigest = readRequiredSnapshotSetting(
    input.BRUNO_RUNNER_APPROVED_RELEASE_DIGEST,
    "BRUNO_RUNNER_APPROVED_RELEASE_DIGEST",
  );
  const releaseTrustSetBytes = readRequiredSnapshotSetting(
    input.BRUNO_RUNNER_RELEASE_TRUST_SET,
    "BRUNO_RUNNER_RELEASE_TRUST_SET",
  );
  const snapshotOciReference = readRequiredSnapshotSetting(
    input.BRUNO_RUNNER_APPROVED_SNAPSHOT_OCI,
    "BRUNO_RUNNER_APPROVED_SNAPSHOT_OCI",
  );
  if (
    !/^sha256:[a-f0-9]{64}$/.test(approvedReleaseDigest) ||
    !/^ghcr\.io\/.+@sha256:[a-f0-9]{64}$/.test(snapshotOciReference)
  ) {
    throw new EnvValidationError([
      "Release-attested boot validation requires exact release and Snapshot OCI digests.",
    ]);
  }

  const snapshot = verifyRunnerSnapshotBundle({
    bundleBytes: snapshotMode.bundleBytes,
    approvedDigest: snapshotMode.approvedDigest,
    trustedPublicKeys: snapshotMode.trustedPublicKeys,
    expected: snapshotMode.expected,
  });
  const parsedRelease = parseRunnerReleaseBundle(bundleBytes);
  const trustedPublicKeys = readReleaseTrustSet(releaseTrustSetBytes);
  if (!snapshot.ok || !parsedRelease.ok) {
    throw new EnvValidationError([
      "Release-attested boot validation requires valid Approved Snapshot and Verified Release bundles.",
    ]);
  }
  const release = verifyRunnerReleaseBundle({
    bundleBytes,
    approvedDigest: approvedReleaseDigest,
    trustedPublicKeys,
    expected: {
      sourceRevision: parsedRelease.bundle.manifest.controlPlane.source.revision,
      runnerImage: config.runnerImage,
      defaultAgentImage: snapshotMode.expected.defaultAgentImage,
      hermesImage: snapshotMode.expected.hermesImage,
      snapshotOciReference,
      snapshotBundleDigest: snapshot.digest,
    },
  });
  if (!release.ok) {
    throw new EnvValidationError([
      `Release-attested boot validation evidence failed closed: ${release.reason}.`,
    ]);
  }

  return {
    mode,
    bundleBytes,
    approvedReleaseDigest,
    releaseTrustSetBytes,
    trustedPublicKeys,
    snapshotOciReference,
    snapshotBundleDigest: snapshot.digest,
    snapshotImageId: snapshot.manifest.snapshot.id,
  };
}

function readReleaseTrustSet(value: string): RunnerReleaseTrustedPublicKeys {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new EnvValidationError([
      "BRUNO_RUNNER_RELEASE_TRUST_SET must be a JSON object of signing key IDs to Ed25519 public keys.",
    ]);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new EnvValidationError([
      "BRUNO_RUNNER_RELEASE_TRUST_SET must be a JSON object of signing key IDs to Ed25519 public keys.",
    ]);
  }
  const entries = Object.entries(raw);
  if (
    entries.length === 0 ||
    entries.length > 16 ||
    entries.some(
      ([keyId, publicKey]) =>
        !isRunnerSnapshotSigningKeyId(keyId) ||
        typeof publicKey !== "string" ||
        publicKey.trim().length === 0 ||
        publicKey.length > 8192,
    )
  ) {
    throw new EnvValidationError([
      "BRUNO_RUNNER_RELEASE_TRUST_SET must contain 1 to 16 valid signing key IDs mapped to public keys.",
    ]);
  }
  return Object.fromEntries(
    entries.map(([keyId, publicKey]) => [keyId, (publicKey as string).trim()]),
  );
}

function readDigitalOceanSnapshotMode(
  input: Record<string, string | undefined>,
  expectedInput: {
    region: string;
    sizeSlug: string;
    baseImageSlug: string;
    runnerImage: string;
    hermesImage: string;
  },
): DigitalOceanSnapshotModeConfig {
  const mode = input.BRUNO_DIGITALOCEAN_IMAGE_MODE?.trim() ?? "stock";

  if (mode === "stock") {
    return { mode: "stock" };
  }

  if (mode !== "snapshot") {
    throw new EnvValidationError([
      "BRUNO_DIGITALOCEAN_IMAGE_MODE must be stock or snapshot when set.",
    ]);
  }

  const bundleBytes = readRequiredSnapshotSetting(
    input.BRUNO_DIGITALOCEAN_SNAPSHOT_BUNDLE,
    "BRUNO_DIGITALOCEAN_SNAPSHOT_BUNDLE",
  );
  const approvedDigest = readRequiredSnapshotSetting(
    input.BRUNO_DIGITALOCEAN_APPROVED_SNAPSHOT_DIGEST,
    "BRUNO_DIGITALOCEAN_APPROVED_SNAPSHOT_DIGEST",
  );
  const trustSetBytes = readRequiredSnapshotSetting(
    input.BRUNO_DIGITALOCEAN_SNAPSHOT_TRUST_SET,
    "BRUNO_DIGITALOCEAN_SNAPSHOT_TRUST_SET",
  );
  const baseImageId = readRequiredSnapshotSetting(
    input.BRUNO_DIGITALOCEAN_SNAPSHOT_BASE_IMAGE_ID,
    "BRUNO_DIGITALOCEAN_SNAPSHOT_BASE_IMAGE_ID",
  );
  if (!/^sha256:[a-f0-9]{64}$/.test(approvedDigest)) {
    throw new EnvValidationError([
      "BRUNO_DIGITALOCEAN_APPROVED_SNAPSHOT_DIGEST must be an exact sha256 digest for snapshot mode.",
    ]);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(baseImageId)) {
    throw new EnvValidationError([
      "BRUNO_DIGITALOCEAN_SNAPSHOT_BASE_IMAGE_ID must be an exact provider base image ID for snapshot mode.",
    ]);
  }
  const trustedPublicKeys = readSnapshotTrustSet(trustSetBytes);

  return {
    mode: "snapshot",
    bundleBytes,
    approvedDigest,
    trustedPublicKeys,
    expected: {
      region: expectedInput.region,
      sizeSlug: expectedInput.sizeSlug,
      sizeDiskGb: diskGbForDigitalOceanSizeSlug(expectedInput.sizeSlug),
      baseImageId,
      baseImageSlug: expectedInput.baseImageSlug,
      architecture: "amd64",
      runnerImage: expectedInput.runnerImage,
      defaultAgentImage: readRunnerImage(input.BRUNO_DOCKER_RUNNER_IMAGE, {
        envName: "BRUNO_DOCKER_RUNNER_IMAGE",
        defaultValue: DEFAULT_MANUAL_RUNNER_IMAGE,
      }),
      hermesImage: expectedInput.hermesImage,
    },
  };
}

function readSnapshotTrustSet(value: string): RunnerSnapshotTrustedPublicKeys {
  let raw: unknown;

  try {
    raw = JSON.parse(value);
  } catch {
    throw new EnvValidationError([
      "BRUNO_DIGITALOCEAN_SNAPSHOT_TRUST_SET must be a JSON object of signing key IDs to Ed25519 public keys.",
    ]);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new EnvValidationError([
      "BRUNO_DIGITALOCEAN_SNAPSHOT_TRUST_SET must be a JSON object of signing key IDs to Ed25519 public keys.",
    ]);
  }

  const entries = Object.entries(raw);
  if (
    entries.length === 0 ||
    entries.length > 16 ||
    entries.some(
      ([keyId, publicKey]) =>
        !isRunnerSnapshotSigningKeyId(keyId) ||
        typeof publicKey !== "string" ||
        publicKey.trim().length === 0 ||
        publicKey.length > 8192,
    )
  ) {
    throw new EnvValidationError([
      "BRUNO_DIGITALOCEAN_SNAPSHOT_TRUST_SET must contain 1 to 16 valid signing key IDs mapped to public keys.",
    ]);
  }

  return Object.fromEntries(
    entries.map(([keyId, publicKey]) => [keyId, (publicKey as string).trim()]),
  );
}

function readRequiredSnapshotSetting(value: string | undefined, envName: string): string {
  const normalized = value?.trim();

  if (!normalized) {
    throw new EnvValidationError([`${envName} is required when snapshot image mode is enabled.`]);
  }

  return normalized;
}

function diskGbForDigitalOceanSizeSlug(sizeSlug: string): number {
  return findDigitalOceanRunnerResourceProfile(sizeSlug)?.diskGiB ?? 25;
}

export function readHermesWorkloadImage(
  input: Record<string, string | undefined> = process.env,
): string {
  return readRunnerImage(input.BRUNO_HERMES_WORKLOAD_IMAGE, {
    envName: "BRUNO_HERMES_WORKLOAD_IMAGE",
    defaultValue: DEFAULT_HERMES_WORKLOAD_IMAGE,
  });
}

function readDigitalOceanProviderMode(value: string | undefined): "digitalocean" | "local_docker" {
  if (value === undefined) {
    return "digitalocean";
  }

  const normalizedValue = value.trim();

  if (normalizedValue === "digitalocean" || normalizedValue === "local_docker") {
    return normalizedValue;
  }

  throw new EnvValidationError([
    "BRUNO_DIGITALOCEAN_PROVIDER_MODE must be digitalocean or local_docker when set.",
  ]);
}

function readNonEmptyProviderSetting(
  value: string | undefined,
  options: { envName: string; defaultValue: string },
): string {
  if (value === undefined) {
    return options.defaultValue;
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    throw new EnvValidationError([`${options.envName} cannot be blank when DigitalOcean is set.`]);
  }

  return normalizedValue;
}

function readRunnerImage(
  value: string | undefined,
  options: { envName: string; defaultValue: string },
): string {
  const normalizedValue = readNonEmptyProviderSetting(value, options);

  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(normalizedValue)) {
    throw new EnvValidationError([
      `${options.envName} must be a valid container image reference without whitespace or shell-control characters.`,
    ]);
  }

  return normalizedValue;
}

function readAbsoluteRuntimePath(
  value: string | undefined,
  options: { envName: string; defaultValue: string },
): string {
  const normalizedValue = readNonEmptyProviderSetting(value, options);

  if (
    !normalizedValue.startsWith("/") ||
    normalizedValue.includes("..") ||
    /[\s"'`$;&|<>\\]/.test(normalizedValue)
  ) {
    throw new EnvValidationError([
      `${options.envName} must be an absolute runtime path without traversal, whitespace, or shell-control characters.`,
    ]);
  }

  return normalizedValue.replace(/\/+$/, "") || "/";
}

function readDockerNetworkName(
  value: string | undefined,
  options: { envName: string; defaultValue: string },
): string {
  const normalizedValue = readNonEmptyProviderSetting(value, options);

  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(normalizedValue)) {
    throw new EnvValidationError([
      `${options.envName} must be a Docker network name without whitespace or shell-control characters.`,
    ]);
  }

  return normalizedValue;
}

function readDockerCpuLimit(
  value: string | undefined,
  options: { envName: string; defaultValue: string },
): string {
  const normalizedValue = readNonEmptyProviderSetting(value, options);

  if (parseHermesDockerCpus(normalizedValue) === null) {
    throw new EnvValidationError([
      `${options.envName} must be a positive Docker CPU value representable to Docker NanoCPUs.`,
    ]);
  }

  return normalizedValue;
}

function readDockerMemoryLimit(
  value: string | undefined,
  options: { envName: string; defaultValue: string },
): string {
  const normalizedValue = readNonEmptyProviderSetting(value, options);

  if (parseHermesDockerMemoryMiB(normalizedValue) === null) {
    throw new EnvValidationError([
      `${options.envName} must be a positive whole-MiB Docker memory value such as 1536m or 2g.`,
    ]);
  }

  return normalizedValue;
}

function readDockerPidsLimit(
  value: string | undefined,
  options: { envName: string; defaultValue: string },
): string {
  const normalizedValue = readNonEmptyProviderSetting(value, options);

  if (parseHermesDockerPidsLimit(normalizedValue) === null) {
    throw new EnvValidationError([
      `${options.envName} must be a positive integer no greater than ${MAX_HERMES_DOCKER_PIDS_LIMIT}.`,
    ]);
  }

  return normalizedValue;
}

function readDigitalOceanSlug(
  value: string | undefined,
  options: { envName: string; defaultValue: string },
): string {
  const normalizedValue = readNonEmptyProviderSetting(value, options);

  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(normalizedValue)) {
    throw new EnvValidationError([
      `${options.envName} must be a DigitalOcean slug using only letters, numbers, and hyphens.`,
    ]);
  }

  return normalizedValue;
}

function readDigitalOceanTags(value: string | undefined): string[] {
  if (value === undefined) {
    return ["bruno", "bruno-runner"];
  }

  const tags = [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];

  if (tags.length === 0) {
    throw new EnvValidationError([
      "BRUNO_DIGITALOCEAN_TAGS must include at least one non-empty tag when set.",
    ]);
  }

  const invalidTag = tags.some((tag) => !/^[A-Za-z0-9_.:-]{1,255}$/.test(tag));

  if (invalidTag) {
    throw new EnvValidationError([
      "BRUNO_DIGITALOCEAN_TAGS entries must not contain whitespace, slash, comma, quote, or shell-control characters.",
    ]);
  }

  return tags.sort();
}

function readDigitalOceanSshKeyIds(value: string | undefined): string[] | null {
  if (value === undefined) {
    return null;
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    throw new EnvValidationError([
      "BRUNO_DIGITALOCEAN_SSH_KEY_IDS cannot be blank when set. Use auto or omit it to discover account keys.",
    ]);
  }

  if (normalizedValue.toLowerCase() === "auto") {
    return null;
  }

  if (["none", "disabled", "false"].includes(normalizedValue.toLowerCase())) {
    return [];
  }

  const sshKeyIds = readNonEmptyCsvSetting(normalizedValue, "BRUNO_DIGITALOCEAN_SSH_KEY_IDS");

  if (sshKeyIds.some((sshKeyId) => !/^[A-Za-z0-9_.:-]{1,255}$/.test(sshKeyId))) {
    throw new EnvValidationError([
      "BRUNO_DIGITALOCEAN_SSH_KEY_IDS entries must not contain whitespace, slash, quote, or shell-control characters.",
    ]);
  }

  return sshKeyIds;
}

function readDigitalOceanSshSourceAddresses(
  value: string | undefined,
  allowPublicSshValue: string | undefined,
): string[] {
  const allowPublicSsh = readExplicitPublicSshFlag(allowPublicSshValue);

  if (value === undefined) {
    return allowPublicSsh ? ["0.0.0.0/0", "::/0"] : [];
  }

  return readNonEmptyCsvSetting(value, "BRUNO_DIGITALOCEAN_SSH_SOURCE_CIDRS")
    .map((address) => normalizeSshSourceCidr(address))
    .sort();
}

function readExplicitPublicSshFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === "true") {
    return true;
  }

  if (["false", "0", "no"].includes(normalizedValue)) {
    return false;
  }

  throw new EnvValidationError([
    "BRUNO_DIGITALOCEAN_ALLOW_PUBLIC_SSH must be true, false, 0, or no when set.",
  ]);
}

function normalizeSshSourceCidr(value: string): string {
  if (/[\s"'`$;&|<>\\]/.test(value)) {
    throw new EnvValidationError([
      "BRUNO_DIGITALOCEAN_SSH_SOURCE_CIDRS entries must be IP addresses or CIDRs without whitespace or shell-control characters.",
    ]);
  }

  const plainIpVersion = isIP(value);

  if (plainIpVersion === 4) {
    return `${value}/32`;
  }

  if (plainIpVersion === 6) {
    return `${value}/128`;
  }

  const parts = value.split("/");

  if (parts.length !== 2) {
    throw new EnvValidationError([
      "BRUNO_DIGITALOCEAN_SSH_SOURCE_CIDRS entries must be valid IPv4 or IPv6 CIDRs.",
    ]);
  }

  const address = parts[0];
  const prefixText = parts[1];

  if (address === undefined || prefixText === undefined) {
    throw new EnvValidationError([
      "BRUNO_DIGITALOCEAN_SSH_SOURCE_CIDRS entries must be valid IPv4 or IPv6 CIDRs.",
    ]);
  }

  const ipVersion = isIP(address);

  if (ipVersion === 0 || !/^\d{1,3}$/.test(prefixText)) {
    throw new EnvValidationError([
      "BRUNO_DIGITALOCEAN_SSH_SOURCE_CIDRS entries must be valid IPv4 or IPv6 CIDRs.",
    ]);
  }

  const prefix = Number(prefixText);
  const maxPrefix = ipVersion === 4 ? 32 : 128;

  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new EnvValidationError([
      "BRUNO_DIGITALOCEAN_SSH_SOURCE_CIDRS entries must use a valid IPv4 or IPv6 prefix length.",
    ]);
  }

  return `${address}/${prefix}`;
}

function readNonEmptyCsvSetting(value: string, envName: string): string[] {
  const values = [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];

  if (values.length === 0) {
    throw new EnvValidationError([
      `${envName} must include at least one non-empty value when set.`,
    ]);
  }

  return values.sort();
}

function readNonNegativeInteger(
  value: string | undefined,
  options: { envName: string; defaultValue: number },
): number {
  if (value === undefined) {
    return options.defaultValue;
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    throw new EnvValidationError([`${options.envName} cannot be blank when set.`]);
  }

  const parsed = Number.parseInt(normalizedValue, 10);

  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== normalizedValue) {
    throw new EnvValidationError([`${options.envName} must be a non-negative integer.`]);
  }

  return parsed;
}

function readPositiveInteger(
  value: string | undefined,
  options: { envName: string; defaultValue: number },
): number {
  if (value === undefined) {
    return options.defaultValue;
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    throw new EnvValidationError([`${options.envName} cannot be blank when set.`]);
  }

  const parsed = Number.parseInt(normalizedValue, 10);

  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== normalizedValue) {
    throw new EnvValidationError([`${options.envName} must be a positive integer.`]);
  }

  return parsed;
}
