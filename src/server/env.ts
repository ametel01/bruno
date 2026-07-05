import "server-only";

import { EnvValidationError, validateRequiredEnv } from "@/src/env/validation";

export type DigitalOceanProviderConfig = {
  token: string;
  region: string;
  sizeSlug: string;
  image: string;
  tags: string[];
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

  return {
    token,
    region: readNonEmptyProviderSetting(input.AGENTBAY_DIGITALOCEAN_REGION, {
      envName: "AGENTBAY_DIGITALOCEAN_REGION",
      defaultValue: "sfo3",
    }),
    sizeSlug: readNonEmptyProviderSetting(input.AGENTBAY_DIGITALOCEAN_SIZE_SLUG, {
      envName: "AGENTBAY_DIGITALOCEAN_SIZE_SLUG",
      defaultValue: "s-1vcpu-1gb",
    }),
    image: readNonEmptyProviderSetting(input.AGENTBAY_DIGITALOCEAN_IMAGE, {
      envName: "AGENTBAY_DIGITALOCEAN_IMAGE",
      defaultValue: "ubuntu-24-04-x64",
    }),
    tags: readDigitalOceanTags(input.AGENTBAY_DIGITALOCEAN_TAGS),
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
