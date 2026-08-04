import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import {
  EnvValidationError,
  validateManualRunnerEndpointUrl,
  validateRequiredEnv,
} from "@/src/env/validation";
import {
  DEFAULT_HERMES_PRIVATE_NETWORK,
  DEFAULT_HERMES_READINESS_TIMEOUT_MS,
  DEFAULT_HERMES_RUNNER_MAX_AGENTS,
  DEFAULT_HERMES_STATE_ROOT,
  DEFAULT_HERMES_WORKLOAD_IMAGE,
} from "@/src/runner-service/constants";
import { parseImmutableRunnerImageReference } from "@/src/runner-service/release-identity";

export const DEFAULT_AGENTBAY_RUNNER_IMAGE = "ghcr.io/ametel01/agentbay-runner:main";

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
  hermesWorkloadImage?: string;
  hermesStateRoot?: string;
  hermesPrivateNetwork?: string;
  hermesReadinessTimeoutMs?: number;
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
  const rawValue = input.AGENTBAY_READY_AGENT_CREATION_ENABLED;

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
  const value = input.AGENTBAY_RUNNER_ROLLOUT_BATCH_SIZE?.trim();

  if (value === undefined || value === "1") {
    return 1;
  }

  if (value === "0") {
    return 0;
  }

  throw new EnvValidationError([
    "AGENTBAY_RUNNER_ROLLOUT_BATCH_SIZE must be 0 (halted) or 1 (gradual) when set.",
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
  const enabled = input.AGENTBAY_HERMES_STAGING_ACCEPTANCE_ENABLED;

  if (enabled === undefined || enabled === "false") {
    return { ok: true, enabled: false };
  }

  if (enabled !== "true") {
    return { ok: false, reason: "hermes_staging_acceptance_configuration_invalid" };
  }

  const bearerSecret = input.AGENTBAY_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET;
  const baseUrl = parseHermesStagingAcceptanceBaseUrl(
    input.AGENTBAY_HERMES_STAGING_ACCEPTANCE_BASE_URL,
  );

  if (
    bearerSecret === undefined ||
    !isValidDedicatedBearerSecret(bearerSecret) ||
    !baseUrl ||
    [input.CRON_SECRET, input.AGENTBAY_RUNNER_BEARER_TOKEN, input.AGENTBAY_OPERATOR_PASSWORD].some(
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
  const token = input.AGENTBAY_DIGITALOCEAN_TOKEN?.trim();

  if (token === undefined) {
    return null;
  }

  if (!token) {
    throw new EnvValidationError(["AGENTBAY_DIGITALOCEAN_TOKEN cannot be blank."]);
  }

  const runnerBearerToken = input.AGENTBAY_RUNNER_BEARER_TOKEN?.trim();

  if (!runnerBearerToken) {
    throw new EnvValidationError([
      "AGENTBAY_RUNNER_BEARER_TOKEN is required when DigitalOcean provisioning is set.",
    ]);
  }

  const sshKeyIds = readDigitalOceanSshKeyIds(input.AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS);
  const providerMode = readDigitalOceanProviderMode(input.AGENTBAY_DIGITALOCEAN_PROVIDER_MODE);
  const runnerImage = readRunnerImage(input.AGENTBAY_RUNNER_IMAGE, {
    envName: "AGENTBAY_RUNNER_IMAGE",
    defaultValue: DEFAULT_AGENTBAY_RUNNER_IMAGE,
  });

  const localRunnerEndpointUrl =
    providerMode === "local_docker"
      ? validateManualRunnerEndpointUrl(
          readNonEmptyProviderSetting(input.AGENTBAY_LOCAL_CLOUD_RUNNER_ENDPOINT_URL, {
            envName: "AGENTBAY_LOCAL_CLOUD_RUNNER_ENDPOINT_URL",
            defaultValue: "http://127.0.0.1:3045",
          }),
        )
      : undefined;
  const localRunnerContainerName =
    providerMode === "local_docker"
      ? readNonEmptyProviderSetting(input.AGENTBAY_LOCAL_CLOUD_RUNNER_CONTAINER_NAME, {
          envName: "AGENTBAY_LOCAL_CLOUD_RUNNER_CONTAINER_NAME",
          defaultValue: "agentbay-local-cloud-runner",
        })
      : undefined;
  const localRunnerStartDelayMs =
    providerMode === "local_docker"
      ? readNonNegativeInteger(input.AGENTBAY_LOCAL_CLOUD_RUNNER_START_DELAY_MS, {
          envName: "AGENTBAY_LOCAL_CLOUD_RUNNER_START_DELAY_MS",
          defaultValue: 1_000,
        })
      : undefined;

  const config: DigitalOceanProviderConfig = {
    token,
    providerMode,
    runnerBearerToken,
    runnerImage,
    hermesWorkloadImage: readHermesWorkloadImage(input),
    hermesStateRoot: readAbsoluteRuntimePath(input.AGENTBAY_HERMES_STATE_ROOT, {
      envName: "AGENTBAY_HERMES_STATE_ROOT",
      defaultValue: DEFAULT_HERMES_STATE_ROOT,
    }),
    hermesPrivateNetwork: readDockerNetworkName(input.AGENTBAY_HERMES_PRIVATE_NETWORK, {
      envName: "AGENTBAY_HERMES_PRIVATE_NETWORK",
      defaultValue: DEFAULT_HERMES_PRIVATE_NETWORK,
    }),
    hermesReadinessTimeoutMs: readPositiveInteger(input.AGENTBAY_HERMES_READINESS_TIMEOUT_MS, {
      envName: "AGENTBAY_HERMES_READINESS_TIMEOUT_MS",
      defaultValue: DEFAULT_HERMES_READINESS_TIMEOUT_MS,
    }),
    runnerMaxAgents: readPositiveInteger(input.AGENTBAY_RUNNER_MAX_AGENTS, {
      envName: "AGENTBAY_RUNNER_MAX_AGENTS",
      defaultValue: DEFAULT_HERMES_RUNNER_MAX_AGENTS,
    }),
    region: readDigitalOceanSlug(input.AGENTBAY_DIGITALOCEAN_REGION, {
      envName: "AGENTBAY_DIGITALOCEAN_REGION",
      defaultValue: "sfo3",
    }),
    sizeSlug: readDigitalOceanSlug(input.AGENTBAY_DIGITALOCEAN_SIZE_SLUG, {
      envName: "AGENTBAY_DIGITALOCEAN_SIZE_SLUG",
      defaultValue: "s-1vcpu-512mb-10gb",
    }),
    image: readDigitalOceanSlug(input.AGENTBAY_DIGITALOCEAN_IMAGE, {
      envName: "AGENTBAY_DIGITALOCEAN_IMAGE",
      defaultValue: "ubuntu-24-04-x64",
    }),
    tags: readDigitalOceanTags(input.AGENTBAY_DIGITALOCEAN_TAGS),
    sshSourceAddresses: readDigitalOceanSshSourceAddresses(
      input.AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS,
      input.AGENTBAY_DIGITALOCEAN_ALLOW_PUBLIC_SSH,
    ),
    ...(sshKeyIds === null ? {} : { sshKeyIds }),
    ...(localRunnerEndpointUrl ? { localRunnerEndpointUrl } : {}),
    ...(localRunnerContainerName ? { localRunnerContainerName } : {}),
    ...(localRunnerStartDelayMs === undefined ? {} : { localRunnerStartDelayMs }),
  };

  if (providerMode === "digitalocean" && !parseImmutableRunnerImageReference(runnerImage)) {
    throw new EnvValidationError([
      "AGENTBAY_RUNNER_IMAGE must be an immutable registry image reference with a sha256 digest for hosted DigitalOcean provisioning.",
    ]);
  }

  return config;
}

export function readHermesWorkloadImage(
  input: Record<string, string | undefined> = process.env,
): string {
  return readRunnerImage(input.AGENTBAY_HERMES_WORKLOAD_IMAGE, {
    envName: "AGENTBAY_HERMES_WORKLOAD_IMAGE",
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
    "AGENTBAY_DIGITALOCEAN_PROVIDER_MODE must be digitalocean or local_docker when set.",
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
    return ["agentbay", "agentbay-runner"];
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
      "AGENTBAY_DIGITALOCEAN_TAGS must include at least one non-empty tag when set.",
    ]);
  }

  const invalidTag = tags.some((tag) => !/^[A-Za-z0-9_.:-]{1,255}$/.test(tag));

  if (invalidTag) {
    throw new EnvValidationError([
      "AGENTBAY_DIGITALOCEAN_TAGS entries must not contain whitespace, slash, comma, quote, or shell-control characters.",
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
      "AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS cannot be blank when set. Use auto or omit it to discover account keys.",
    ]);
  }

  if (normalizedValue.toLowerCase() === "auto") {
    return null;
  }

  if (["none", "disabled", "false"].includes(normalizedValue.toLowerCase())) {
    return [];
  }

  const sshKeyIds = readNonEmptyCsvSetting(normalizedValue, "AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS");

  if (sshKeyIds.some((sshKeyId) => !/^[A-Za-z0-9_.:-]{1,255}$/.test(sshKeyId))) {
    throw new EnvValidationError([
      "AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS entries must not contain whitespace, slash, quote, or shell-control characters.",
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

  return readNonEmptyCsvSetting(value, "AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS")
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
    "AGENTBAY_DIGITALOCEAN_ALLOW_PUBLIC_SSH must be true, false, 0, or no when set.",
  ]);
}

function normalizeSshSourceCidr(value: string): string {
  if (/[\s"'`$;&|<>\\]/.test(value)) {
    throw new EnvValidationError([
      "AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS entries must be IP addresses or CIDRs without whitespace or shell-control characters.",
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
      "AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS entries must be valid IPv4 or IPv6 CIDRs.",
    ]);
  }

  const address = parts[0];
  const prefixText = parts[1];

  if (address === undefined || prefixText === undefined) {
    throw new EnvValidationError([
      "AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS entries must be valid IPv4 or IPv6 CIDRs.",
    ]);
  }

  const ipVersion = isIP(address);

  if (ipVersion === 0 || !/^\d{1,3}$/.test(prefixText)) {
    throw new EnvValidationError([
      "AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS entries must be valid IPv4 or IPv6 CIDRs.",
    ]);
  }

  const prefix = Number(prefixText);
  const maxPrefix = ipVersion === 4 ? 32 : 128;

  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new EnvValidationError([
      "AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS entries must use a valid IPv4 or IPv6 prefix length.",
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
