import "server-only";

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
    runnerImage: readNonEmptyProviderSetting(input.AGENTBAY_RUNNER_IMAGE, {
      envName: "AGENTBAY_RUNNER_IMAGE",
      defaultValue: DEFAULT_AGENTBAY_RUNNER_IMAGE,
    }),
    region: readNonEmptyProviderSetting(input.AGENTBAY_DIGITALOCEAN_REGION, {
      envName: "AGENTBAY_DIGITALOCEAN_REGION",
      defaultValue: "sfo3",
    }),
    sizeSlug: readNonEmptyProviderSetting(input.AGENTBAY_DIGITALOCEAN_SIZE_SLUG, {
      envName: "AGENTBAY_DIGITALOCEAN_SIZE_SLUG",
      defaultValue: "s-1vcpu-512mb-10gb",
    }),
    image: readNonEmptyProviderSetting(input.AGENTBAY_DIGITALOCEAN_IMAGE, {
      envName: "AGENTBAY_DIGITALOCEAN_IMAGE",
      defaultValue: "ubuntu-24-04-x64",
    }),
    tags: readDigitalOceanTags(input.AGENTBAY_DIGITALOCEAN_TAGS),
    sshSourceAddresses: readDigitalOceanSshSourceAddresses(
      input.AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS,
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

  return readNonEmptyCsvSetting(normalizedValue, "AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS");
}

function readDigitalOceanSshSourceAddresses(value: string | undefined): string[] {
  if (value === undefined) {
    return ["0.0.0.0/0", "::/0"];
  }

  return readNonEmptyCsvSetting(value, "AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS");
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
