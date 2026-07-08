import "server-only";

import { isIP } from "node:net";
import {
  EnvValidationError,
  validateManualRunnerEndpointUrl,
  validateRequiredEnv,
} from "@/src/env/validation";

export const DEFAULT_AGENTBAY_RUNNER_IMAGE = "ghcr.io/ametel01/agentbay-runner:main";

export type DigitalOceanProviderConfig = {
  token: string;
  providerMode?: "digitalocean" | "local_docker";
  runnerBearerToken: string;
  runnerImage: string;
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

export function getServerEnv(input = process.env) {
  return validateRequiredEnv(input);
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

  return {
    token,
    providerMode,
    runnerBearerToken,
    runnerImage: readRunnerImage(input.AGENTBAY_RUNNER_IMAGE, {
      envName: "AGENTBAY_RUNNER_IMAGE",
      defaultValue: DEFAULT_AGENTBAY_RUNNER_IMAGE,
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
