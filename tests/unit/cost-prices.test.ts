import { describe, expect, it } from "vitest";
import {
  getDigitalOceanRunnerPriceMetadata,
  listSupportedDigitalOceanRunnerPriceMetadata,
} from "@/src/server/costs/provider-prices";

describe("DigitalOcean runner price metadata", () => {
  it("returns deterministic integer-cent prices for supported runner sizes", () => {
    expect(getDigitalOceanRunnerPriceMetadata("s-1vcpu-512mb-10gb")).toMatchObject({
      available: true,
      provider: "digitalocean",
      sizeSlug: "s-1vcpu-512mb-10gb",
      monthlyCents: 400,
      dailyEstimateCents: 13,
      hourlyEstimateCents: 1,
      display: {
        monthly: "$4.00/month",
        dailyEstimate: "$0.13/day est.",
        hourlyEstimate: "$0.01/hour est.",
      },
    });
    expect(getDigitalOceanRunnerPriceMetadata("s-1vcpu-1gb")).toMatchObject({
      available: true,
      provider: "digitalocean",
      sizeSlug: "s-1vcpu-1gb",
      monthlyCents: 600,
      dailyEstimateCents: 20,
      hourlyEstimateCents: 1,
      display: {
        monthly: "$6.00/month",
        dailyEstimate: "$0.20/day est.",
        hourlyEstimate: "$0.01/hour est.",
      },
    });
    expect(getDigitalOceanRunnerPriceMetadata("s-2vcpu-2gb")).toMatchObject({
      available: true,
      provider: "digitalocean",
      sizeSlug: "s-2vcpu-2gb",
      monthlyCents: 1800,
      dailyEstimateCents: 60,
      hourlyEstimateCents: 3,
      display: {
        monthly: "$18.00/month",
        dailyEstimate: "$0.60/day est.",
        hourlyEstimate: "$0.03/hour est.",
      },
    });
    expect(getDigitalOceanRunnerPriceMetadata("s-1vcpu-2gb")).toMatchObject({
      available: true,
      provider: "digitalocean",
      sizeSlug: "s-1vcpu-2gb",
      monthlyCents: 1200,
      dailyEstimateCents: 40,
      hourlyEstimateCents: 2,
      display: {
        monthly: "$12.00/month",
        dailyEstimate: "$0.40/day est.",
        hourlyEstimate: "$0.02/hour est.",
      },
    });
  });

  it("lists only the supported DigitalOcean runner prices", () => {
    expect(listSupportedDigitalOceanRunnerPriceMetadata()).toEqual([
      expect.objectContaining({
        available: true,
        provider: "digitalocean",
        sizeSlug: "s-1vcpu-512mb-10gb",
        monthlyCents: 400,
      }),
      expect.objectContaining({
        available: true,
        provider: "digitalocean",
        sizeSlug: "s-1vcpu-1gb",
        monthlyCents: 600,
      }),
      expect.objectContaining({
        available: true,
        provider: "digitalocean",
        sizeSlug: "s-1vcpu-2gb",
        monthlyCents: 1200,
      }),
      expect.objectContaining({
        available: true,
        provider: "digitalocean",
        sizeSlug: "s-2vcpu-2gb",
        monthlyCents: 1800,
      }),
    ]);
  });

  it("returns explicit unavailable metadata for unknown or manual runner sizes", () => {
    for (const sizeSlug of [null, undefined, "", "   ", "manual-runner", "s-4vcpu-8gb"]) {
      expect(getDigitalOceanRunnerPriceMetadata(sizeSlug)).toEqual({
        available: false,
        provider: "digitalocean",
        sizeSlug: typeof sizeSlug === "string" && sizeSlug.trim() ? sizeSlug.trim() : null,
        reason: "unsupported_size",
        display: {
          monthly: "Unavailable",
          dailyEstimate: "Unavailable",
          hourlyEstimate: "Unavailable",
        },
      });
    }
  });

  it("keeps DTO output display-safe and free of provider secrets", () => {
    const serializedKnownPrice = JSON.stringify(
      getDigitalOceanRunnerPriceMetadata("s-1vcpu-512mb-10gb"),
    );
    const serializedUnknownPrice = JSON.stringify(
      getDigitalOceanRunnerPriceMetadata("dop_v1_super_secret"),
    );

    expect(serializedKnownPrice).not.toContain("token");
    expect(serializedKnownPrice).not.toContain("AGENTBAY_DIGITALOCEAN_TOKEN");
    expect(serializedKnownPrice).not.toContain("dop_v1");
    expect(serializedKnownPrice).not.toContain("endpoint");
    expect(serializedUnknownPrice).not.toContain("dop_v1");
    expect(serializedUnknownPrice).not.toContain("token");
    expect(serializedUnknownPrice).not.toContain("AGENTBAY_DIGITALOCEAN_TOKEN");
    expect(serializedUnknownPrice).not.toContain("endpoint");
    expect(getDigitalOceanRunnerPriceMetadata("dop_v1_super_secret")).toMatchObject({
      available: false,
      sizeSlug: null,
    });
    expect(getDigitalOceanRunnerPriceMetadata("unknown-size")).not.toMatchObject({
      monthlyCents: 0,
    });
  });
});
