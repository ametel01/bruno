import "server-only";

import {
  DIGITALOCEAN_PROVIDER,
  type DigitalOceanProviderName,
} from "@/src/server/runners/digitalocean-provider";
import {
  findDigitalOceanRunnerResourceProfile,
  isSupportedDigitalOceanRunnerSizeSlug,
  listDigitalOceanRunnerResourceProfiles,
  type SupportedDigitalOceanRunnerSizeSlug,
} from "@/src/server/runners/runner-resource-profiles";

const ESTIMATE_DAYS_PER_MONTH = 30;
const ESTIMATE_HOURS_PER_MONTH = ESTIMATE_DAYS_PER_MONTH * 24;
const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});

export type AvailableRunnerPriceMetadata = {
  available: true;
  provider: DigitalOceanProviderName;
  sizeSlug: SupportedDigitalOceanRunnerSizeSlug;
  vcpus: number;
  memoryMiB: number;
  diskGiB: number;
  monthlyCents: number;
  dailyEstimateCents: number;
  hourlyEstimateCents: number;
  display: {
    monthly: string;
    dailyEstimate: string;
    hourlyEstimate: string;
  };
};

export type UnavailableRunnerPriceMetadata = {
  available: false;
  provider: DigitalOceanProviderName;
  sizeSlug: string | null;
  reason: "unsupported_size";
  display: {
    monthly: "Unavailable";
    dailyEstimate: "Unavailable";
    hourlyEstimate: "Unavailable";
  };
};

export type RunnerPriceMetadata = AvailableRunnerPriceMetadata | UnavailableRunnerPriceMetadata;

export function getDigitalOceanRunnerPriceMetadata(
  sizeSlug: string | null | undefined,
): RunnerPriceMetadata {
  const normalizedSizeSlug = normalizeSizeSlug(sizeSlug);

  if (!isSupportedDigitalOceanRunnerSizeSlug(normalizedSizeSlug)) {
    return {
      available: false,
      provider: DIGITALOCEAN_PROVIDER,
      sizeSlug: normalizedSizeSlug,
      reason: "unsupported_size",
      display: unavailableDisplay(),
    };
  }

  const profile = findDigitalOceanRunnerResourceProfile(normalizedSizeSlug);

  if (!profile) {
    return {
      available: false,
      provider: DIGITALOCEAN_PROVIDER,
      sizeSlug: normalizedSizeSlug,
      reason: "unsupported_size",
      display: unavailableDisplay(),
    };
  }

  const { monthlyCents } = profile;
  const dailyEstimateCents = Math.round(monthlyCents / ESTIMATE_DAYS_PER_MONTH);
  const hourlyEstimateCents = Math.round(monthlyCents / ESTIMATE_HOURS_PER_MONTH);

  return {
    available: true,
    provider: DIGITALOCEAN_PROVIDER,
    sizeSlug: normalizedSizeSlug,
    vcpus: profile.vcpus,
    memoryMiB: profile.memoryMiB,
    diskGiB: profile.diskGiB,
    monthlyCents,
    dailyEstimateCents,
    hourlyEstimateCents,
    display: {
      monthly: formatUsdCents(monthlyCents, "/month"),
      dailyEstimate: formatUsdCents(dailyEstimateCents, "/day est."),
      hourlyEstimate: formatUsdCents(hourlyEstimateCents, "/hour est."),
    },
  };
}

export function listSupportedDigitalOceanRunnerPriceMetadata(): AvailableRunnerPriceMetadata[] {
  return listDigitalOceanRunnerResourceProfiles().map(({ sizeSlug }) => {
    const metadata = getDigitalOceanRunnerPriceMetadata(sizeSlug);

    if (!metadata.available) {
      throw new Error(`Supported DigitalOcean size ${sizeSlug} did not resolve to metadata.`);
    }

    return metadata;
  });
}

function normalizeSizeSlug(sizeSlug: string | null | undefined): string | null {
  const normalizedSizeSlug = sizeSlug?.trim();

  if (!normalizedSizeSlug) {
    return null;
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(normalizedSizeSlug)) {
    return null;
  }

  return normalizedSizeSlug;
}

function formatUsdCents(cents: number, suffix: string): string {
  return `${USD_FORMATTER.format(cents / 100)}${suffix}`;
}

function unavailableDisplay(): UnavailableRunnerPriceMetadata["display"] {
  return {
    monthly: "Unavailable",
    dailyEstimate: "Unavailable",
    hourlyEstimate: "Unavailable",
  };
}
