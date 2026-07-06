import type { DigitalOceanSdkClient } from "@/src/server/runners/digitalocean-provider";

export function createDigitalOceanSdkClient(
  token: string,
  apiBaseUrl?: string,
): DigitalOceanSdkClient;
