import "server-only";

import { readDigitalOceanProviderConfig } from "@/src/server/env";
import { createEncryptedFounderRecoveryArchiveProvider } from "@/src/server/founder-product-contract/encrypted-recovery-archive-provider";
import type { FounderInfrastructureRetirementProvider } from "@/src/server/founder-product-contract/infrastructure-retirement";
import type { DigitalOceanOwnedSetProvider } from "@/src/server/runners/digitalocean-provider";
import { createConfiguredDigitalOceanProvider } from "@/src/server/runners/runner-provisioning";

export function createConfiguredFounderInfrastructureRetirementProvider(): FounderInfrastructureRetirementProvider | null {
  const archive = createEncryptedFounderRecoveryArchiveProvider();
  const config = readDigitalOceanProviderConfig();
  if (!archive && !config) return null;
  if (!archive || !config) {
    throw new Error("Infrastructure Retirement providers must be configured together.");
  }
  const digitalOcean = createConfiguredDigitalOceanProvider(config);
  if (!isOwnedSetProvider(digitalOcean)) {
    throw new Error("Configured DigitalOcean provider cannot verify exact owned resources.");
  }
  const calls: string[] = [];
  return {
    createRecoveryArchive: (input) => archive.createRecoveryArchive(input),
    deleteRecoveryArchive: (input) => archive.deleteRecoveryArchive(input),
    digitalOcean: tracingOwnedSetProvider(digitalOcean, calls),
    calls: () => [...calls],
  };
}

function isOwnedSetProvider(value: unknown): value is DigitalOceanOwnedSetProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    "observeOwnedSet" in value &&
    typeof value.observeOwnedSet === "function" &&
    "deleteFirewall" in value &&
    typeof value.deleteFirewall === "function" &&
    "deleteDroplet" in value &&
    typeof value.deleteDroplet === "function"
  );
}

function tracingOwnedSetProvider(
  provider: DigitalOceanOwnedSetProvider,
  calls: string[],
): DigitalOceanOwnedSetProvider {
  return {
    observeOwnedSet(expectation, context) {
      calls.push("digitalOcean.observe_owned_resources");
      return provider.observeOwnedSet(expectation, context);
    },
    deleteFirewall(expectation, context) {
      calls.push("digitalOcean.delete_firewall");
      return provider.deleteFirewall(expectation, context);
    },
    deleteDroplet(expectation, context) {
      calls.push("digitalOcean.delete_droplet");
      return provider.deleteDroplet(expectation, context);
    },
  };
}
