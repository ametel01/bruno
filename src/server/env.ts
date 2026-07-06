import "server-only";

import { EnvValidationError, validateRequiredEnv } from "@/src/env/validation";

export const DEFAULT_AGENTBAY_RUNNER_IMAGE = "ghcr.io/ametel01/agentbay-runner:main";

export type DigitalOceanProviderConfig = {
  token: string;
  runnerBearerToken: string;
  runnerImage: string;
  region: string;
  sizeSlug: string;
  image: string;
  tags: string[];
  sshKeyIds?: string[];
  sshSourceAddresses?: string[];
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

  return {
    token,
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
  };
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
