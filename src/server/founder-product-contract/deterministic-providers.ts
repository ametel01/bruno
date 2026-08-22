import "server-only";

import { createHash } from "node:crypto";
import {
  type BackupStorageUploadInput,
  type DeletableBackupObjectStorage,
  FakeBackupObjectStorage,
} from "@/src/server/backups/backup-storage";
import {
  DIGITALOCEAN_PROVIDER,
  type DigitalOceanOwnedSetDeleteResult,
  type DigitalOceanOwnedSetExpectation,
  type DigitalOceanOwnedSetObservation,
  type DigitalOceanOwnedSetProvider,
  type DigitalOceanOwnedSetResult,
  FakeDigitalOceanProvider,
} from "@/src/server/runners/digitalocean-provider";
import { digitalOceanRunnerFirewallName } from "@/src/server/runners/runner-provisioning";
import { EncryptedFounderRecoveryArchiveProvider } from "./encrypted-recovery-archive-provider";
import type { FounderCommerceStatus, FounderLifecycleProviderBoundary } from "./lifecycle";

export type FounderLifecycleFailureOperation =
  | "clerk.authenticate"
  | "openAI.verify_connection"
  | "anthropic.verify_connection"
  | "google.verify_connection"
  | "lemonSqueezy.read_subscription"
  | "archive.create"
  | "archive.corrupt"
  | "archive.delete"
  | "archive.delete_credentials"
  | "digitalOcean.observe_owned_resources"
  | "digitalOcean.delete_firewall"
  | "digitalOcean.delete_droplet"
  | "digitalOcean.observe_owned_resources_absent";

type ProviderState = {
  digitalOcean: FakeDigitalOceanProvider;
  archiveStorage: FakeBackupObjectStorage;
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
    archiveStorage: new FakeBackupObjectStorage("founder-product-contract-recovery"),
    seededResourceIds: new Set(),
  };
  registry.set(key, state);
  const calls: string[] = [];
  const failures = new Set(input.failures);
  const archiveProvider = new EncryptedFounderRecoveryArchiveProvider({
    storage: failures.has("archive.corrupt")
      ? corruptingRecoveryArchiveStorage(state.archiveStorage, calls)
      : state.archiveStorage,
    masterKey: createHash("sha256").update(`founder-contract:${input.runId}`).digest(),
    onOperation(operation) {
      calls.push(operation);
      if (operation === "archive.delete" || operation === "archive.delete_credentials") {
        failIfConfigured(failures, operation);
      }
    },
  });

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
    async createRecoveryArchive(archiveInput) {
      calls.push("archive.create");
      failIfConfigured(failures, "archive.create");
      return archiveProvider.createRecoveryArchive(archiveInput);
    },
    async deleteRecoveryArchive(deletion) {
      return archiveProvider.deleteRecoveryArchive(deletion);
    },
    digitalOcean: ownedSetProvider(state, calls, failures, input.now),
    calls: () => [...calls],
  };
}

function corruptingRecoveryArchiveStorage(
  storage: FakeBackupObjectStorage,
  calls: string[],
): DeletableBackupObjectStorage {
  return {
    async upload(input: BackupStorageUploadInput) {
      const result = await storage.upload(input);
      if (result.ok && input.key.endsWith(".key")) {
        calls.push("archive.corrupt");
        await storage.upload({
          key: input.key.replace(/\.key$/, ".age"),
          body: new TextEncoder().encode("corrupt-recovery-archive"),
        });
      }
      return result;
    },
    download: (input) => storage.download(input),
    delete: (input) => storage.delete(input),
    deleteVersion: (input) => storage.deleteVersion(input),
    exists: (input) => storage.exists(input),
    verifyDeletionSafety: () => storage.verifyDeletionSafety(),
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
