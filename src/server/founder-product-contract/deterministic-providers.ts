import "server-only";

import { createHash } from "node:crypto";
import {
  DIGITALOCEAN_PROVIDER,
  FakeDigitalOceanProvider,
  type DigitalOceanOwnedSetExpectation,
  type DigitalOceanOwnedSetProvider,
  type DigitalOceanOwnedSetResult,
  type DigitalOceanOwnedSetObservation,
  type DigitalOceanOwnedSetDeleteResult,
} from "@/src/server/runners/digitalocean-provider";
import { digitalOceanRunnerFirewallName } from "@/src/server/runners/runner-provisioning";
import type { FounderCommerceStatus, FounderLifecycleProviderBoundary } from "./lifecycle";

export type FounderLifecycleFailureOperation =
  | "clerk.authenticate"
  | "openAI.verify_connection"
  | "anthropic.verify_connection"
  | "google.verify_connection"
  | "lemonSqueezy.read_subscription"
  | "archive.create"
  | "archive.delete"
  | "digitalOcean.observe_owned_resources"
  | "digitalOcean.delete_firewall"
  | "digitalOcean.delete_droplet"
  | "digitalOcean.observe_owned_resources_absent";

type ProviderState = {
  digitalOcean: FakeDigitalOceanProvider;
  seededResourceIds: Set<string>;
};

const globalProviders = globalThis as typeof globalThis & {
  __brunoFounderLifecycleProviders?: Map<string, ProviderState>;
};

export function deterministicFounderLifecycleProviders(input: {
  runId: string;
  userId: string;
  now: Date;
  failures: readonly FounderLifecycleFailureOperation[];
  subscriptionStatus: FounderCommerceStatus;
}): FounderLifecycleProviderBoundary {
  if (!globalProviders.__brunoFounderLifecycleProviders) {
    globalProviders.__brunoFounderLifecycleProviders = new Map();
  }
  const registry = globalProviders.__brunoFounderLifecycleProviders;
  const key = `${input.runId}:${input.userId}`;
  const state = registry.get(key) ?? {
    digitalOcean: new FakeDigitalOceanProvider({ now: () => input.now }),
    seededResourceIds: new Set(),
  };
  registry.set(key, state);
  const calls: string[] = [];
  const failures = new Set(input.failures);

  return {
    async authenticateIdentity({ userId }) {
      calls.push("clerk.authenticate");
      failIfConfigured(failures, "clerk.authenticate");
      return { subject: `clerk:${userId}` };
    },
    async verifyCapabilityProviders() {
      for (const operation of [
        "openAI.verify_connection",
        "anthropic.verify_connection",
        "google.verify_connection",
      ] as const) {
        calls.push(operation);
        failIfConfigured(failures, operation);
      }
      return { openAI: true, anthropic: true, google: true };
    },
    async readSubscription({ subscriptionId }) {
      calls.push("lemonSqueezy.read_subscription");
      failIfConfigured(failures, "lemonSqueezy.read_subscription");
      if (!subscriptionId) throw new Error("Subscription identity is required.");
      return { status: input.subscriptionStatus };
    },
    async createRecoveryArchive({ archiveIntentId, userId, operatorId, observedAt }) {
      calls.push("archive.create");
      failIfConfigured(failures, "archive.create");
      const identity = `${archiveIntentId}:${input.runId}:${userId}:${operatorId}:${observedAt.toISOString()}`;
      return {
        storageObjectKey: `founder-recovery/${input.runId}/${archiveIntentId}.age`,
        ciphertextDigest: `sha256:${createHash("sha256").update(identity).digest("hex")}`,
        restorableVerified: true as const,
      };
    },
    async deleteRecoveryArchive() {
      calls.push("archive.delete");
      failIfConfigured(failures, "archive.delete");
      return { absent: true };
    },
    digitalOcean: ownedSetProvider(state, calls, failures, input.now),
    calls: () => [...calls],
  };
}

function ownedSetProvider(
  state: ProviderState,
  calls: string[],
  failures: ReadonlySet<FounderLifecycleFailureOperation>,
  now: Date,
): DigitalOceanOwnedSetProvider {
  return {
    async observeOwnedSet(expectation) {
      seedOwnedSet(state, expectation, now);
      const result = await state.digitalOcean.observeOwnedSet(expectation);
      const operation =
        result.ok && result.value.state === "absent"
          ? "digitalOcean.observe_owned_resources_absent"
          : "digitalOcean.observe_owned_resources";
      calls.push(operation);
      return failures.has(operation) ? failedObservation() : result;
    },
    async deleteFirewall(expectation) {
      calls.push("digitalOcean.delete_firewall");
      return failures.has("digitalOcean.delete_firewall")
        ? failedDelete()
        : state.digitalOcean.deleteFirewall(expectation);
    },
    async deleteDroplet(expectation) {
      calls.push("digitalOcean.delete_droplet");
      return failures.has("digitalOcean.delete_droplet")
        ? failedDelete()
        : state.digitalOcean.deleteDroplet(expectation);
    },
  };
}

function seedOwnedSet(
  state: ProviderState,
  expectation: DigitalOceanOwnedSetExpectation,
  now: Date,
): void {
  if (state.seededResourceIds.has(expectation.providerResourceId)) return;
  state.seededResourceIds.add(expectation.providerResourceId);
  state.digitalOcean.resources.set(expectation.providerResourceId, {
    provider: DIGITALOCEAN_PROVIDER,
    providerResourceId: expectation.providerResourceId,
    providerFirewallId: expectation.providerFirewallId,
    providerFirewallName: digitalOceanRunnerFirewallName(expectation.providerResourceId),
    publicIpv4: "203.0.113.72",
    name: expectation.expectedName,
    region: expectation.expectedRegion,
    sizeSlug: expectation.expectedSizeSlug,
    image: "ubuntu-24-04-x64",
    tags: [expectation.operationTag],
    firewallApplied: true,
    createdAt: now.toISOString(),
    deletedAt: null,
  });
  state.digitalOcean.firewalls.set(expectation.providerFirewallId, {
    name: expectation.expectedFirewallName,
    providerResourceId: expectation.providerResourceId,
  });
}

function failIfConfigured(
  failures: ReadonlySet<FounderLifecycleFailureOperation>,
  operation: FounderLifecycleFailureOperation,
): void {
  if (failures.has(operation)) throw new Error(`${operation} failed deterministically.`);
}

function failedObservation(): DigitalOceanOwnedSetResult<DigitalOceanOwnedSetObservation> {
  return {
    ok: false,
    reason: "observation_unknown",
    retryable: true,
    message: "DigitalOcean owned-resource observation failed deterministically.",
  };
}

function failedDelete(): DigitalOceanOwnedSetResult<DigitalOceanOwnedSetDeleteResult> {
  return {
    ok: false,
    reason: "delete_outcome_unknown",
    retryable: true,
    message: "DigitalOcean deletion failed deterministically.",
  };
}
