import "server-only";

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
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
import {
  reconcileFounderCommerceReceipt,
  recordFounderCommerceWebhook,
} from "@/src/server/commerce/founder-commerce";
import type { LemonSqueezyCommerceProvider } from "@/src/server/commerce/lemon-squeezy-provider";
import { createDatabaseConnection } from "@/src/server/db/client";
import { founderCommerceEvents, founderProductEntitlements } from "@/src/server/db/schema";
import { founderProductContractDigest } from "./digest";
import { digitalOceanRunnerFirewallName } from "@/src/server/runners/runner-provisioning";
import { EncryptedFounderRecoveryArchiveProvider } from "./encrypted-recovery-archive-provider";
import type { FounderCommerceStatus, FounderLifecycleProviderBoundary } from "./lifecycle";

export type FounderLifecycleFailureOperation =
  | "clerk.authenticate"
  | "openAI.verify_connection"
  | "anthropic.verify_connection"
  | "google.verify_connection"
  | "google.verify_calendar_reading"
  | "google.verify_gmail_reading"
  | "google.verify_gmail_sending"
  | "lemonSqueezy.read_subscription"
  | "archive.create"
  | "archive.corrupt"
  | "archive.delete"
  | "archive.delete_credentials"
  | "digitalOcean.observe_owned_resources"
  | "digitalOcean.delete_firewall"
  | "digitalOcean.delete_droplet"
  | "digitalOcean.observe_owned_resources_absent"
  | "digitalOcean.create_restoration_droplet"
  | "digitalOcean.configure_restoration_firewall"
  | "openAI.reauthorize"
  | "anthropic.reauthorize"
  | "google.reauthorize_company"
  | "lemonSqueezy.refund_restoration";

type ProviderState = {
  digitalOcean: FakeDigitalOceanProvider;
  archiveStorage: FakeBackupObjectStorage;
  seededResourceIds: Set<string>;
  restorationCounter: number;
  subscriptionId: string;
  subscriptionOrderId: string;
  subscriptionStatus: FounderCommerceStatus;
  subscriptionUpdatedAt: Date;
  subscriptionEndsAt: Date | null;
  revokedConnections: Set<DeterministicFounderContractConnectionKind>;
  calls: string[];
};

export type DeterministicFounderContractConnectionKind = "ai:openai" | "calendar" | "mail";

const globalProviders = globalThis as typeof globalThis & {
  __brunoFounderLifecycleProviders?: Map<string, ProviderState>;
};

export function deterministicFounderLifecycleProviders(input: {
  runId: string;
  userId: string;
  now: Date;
  failures: readonly FounderLifecycleFailureOperation[];
  subscriptionStatus: FounderCommerceStatus;
  partialRestorationUserId?: string;
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
    restorationCounter: 0,
    subscriptionId: `${input.runId}:subscription`,
    subscriptionOrderId: `order-${input.runId}:subscription`,
    subscriptionStatus: input.subscriptionStatus,
    subscriptionUpdatedAt: input.now,
    subscriptionEndsAt: null,
    revokedConnections: new Set(),
    calls: [],
  };
  state.subscriptionStatus = input.subscriptionStatus;
  state.subscriptionUpdatedAt = input.now;
  state.subscriptionEndsAt = null;
  state.calls = [];
  registry.set(key, state);
  const calls = state.calls;
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
        "google.verify_calendar_reading",
        "google.verify_gmail_reading",
        "google.verify_gmail_sending",
      ] as const) {
        calls.push(operation);
        if (operation.startsWith("google.") && failures.has("google.verify_connection")) {
          throw new Error("google.verify_connection failed deterministically.");
        }
        failIfConfigured(failures, operation);
      }
      return {
        openAI: true,
        anthropic: true,
        calendarReading: true,
        gmailReading: true,
        gmailSending: true,
      };
    },
    async readSubscription({ subscriptionId }) {
      calls.push("lemonSqueezy.read_subscription");
      failIfConfigured(failures, "lemonSqueezy.read_subscription");
      assertExpectedSubscription(state, subscriptionId);
      return { status: state.subscriptionStatus };
    },
    async cancelSubscription({ subscriptionId }) {
      calls.push("lemonSqueezy.cancel_subscription");
      assertExpectedSubscription(state, subscriptionId);
      state.subscriptionStatus = "cancelled";
    },
    async createCustomerPortal({ subscriptionId, now }) {
      calls.push("lemonSqueezy.create_customer_portal");
      assertExpectedSubscription(state, subscriptionId);
      const expiresAt = new Date(now.valueOf() + 24 * 60 * 60 * 1_000);
      return {
        url: `https://app.lemonsqueezy.com/billing?expires=${Math.floor(expiresAt.valueOf() / 1_000)}&user=founder-contract&signature=${"a".repeat(64)}`,
        expiresAt,
        actions: {
          paymentMethods: true,
          billingHistory: true,
          cancellation: true,
          eligibleResumption: true,
          planSwitching: false,
          customerPause: false,
        },
      };
    },
    async deleteExternalBetaRecording({ artifactReferenceDigest }) {
      calls.push("recording.delete_and_verify_absent");
      if (!/^sha256:[a-f0-9]{64}$/.test(artifactReferenceDigest)) {
        throw new Error("External Beta recording reference is invalid.");
      }
      return { absent: true };
    },
    async createRecoveryArchive(archiveInput) {
      calls.push("archive.create");
      failIfConfigured(failures, "archive.create");
      return archiveProvider.createRecoveryArchive(archiveInput);
    },
    async deleteRecoveryArchive(deletion) {
      return archiveProvider.deleteRecoveryArchive(deletion);
    },
    async verifyRecoveryArchive(archive) {
      return archiveProvider.verifyRecoveryArchive(archive);
    },
    async provisionNewInfrastructure(provisioning) {
      state.restorationCounter += 1;
      calls.push("digitalOcean.create_restoration_droplet");
      failIfConfigured(failures, "digitalOcean.create_restoration_droplet");
      const suffix = createHash("sha256")
        .update(`${input.runId}:${provisioning.userId}:${state.restorationCounter}`)
        .digest("hex");
      const value = {
        runnerId: provisioning.runnerId,
        persistedRunner: false,
        providerResourceId: `restored-droplet-${suffix.slice(0, 16)}`,
        providerFirewallId: `restored-firewall-${suffix.slice(16, 32)}`,
        endpointUrl: `https://198.51.100.${20 + state.restorationCounter}`,
        runtimeIdentity: `restored-runtime-${suffix.slice(32, 48)}`,
        operationTag: `bruno-deploy-${provisioning.runnerId.replaceAll("-", "")}`,
        name: `restored-${provisioning.runnerId}`,
        region: "sfo3",
        sizeSlug: "s-1vcpu-1gb",
        image: "ubuntu-24-04-x64",
        createdAt: input.now,
      };
      calls.push("digitalOcean.configure_restoration_firewall");
      if (
        provisioning.userId === input.partialRestorationUserId ||
        failures.has("digitalOcean.configure_restoration_firewall")
      ) {
        return { state: "failed" as const, code: "restoration_firewall_failed", partial: value };
      }
      return { state: "ready" as const, value };
    },
    async observeNewInfrastructure() {
      throw new Error("Deterministic restoration Infrastructure is immediately observable.");
    },
    async reauthorizeAiProviders() {
      calls.push("openAI.reauthorize");
      failIfConfigured(failures, "openAI.reauthorize");
      calls.push("anthropic.reauthorize");
      failIfConfigured(failures, "anthropic.reauthorize");
      return { openAI: true, anthropic: true };
    },
    async reauthorizeCompanyProviders() {
      calls.push("google.reauthorize_company");
      failIfConfigured(failures, "google.reauthorize_company");
      return { calendar: true, mail: true };
    },
    async retireRestorationInfrastructure() {
      calls.push("digitalOcean.delete_firewall");
      failIfConfigured(failures, "digitalOcean.delete_firewall");
      calls.push("digitalOcean.delete_droplet");
      failIfConfigured(failures, "digitalOcean.delete_droplet");
      calls.push("digitalOcean.observe_owned_resources_absent");
      failIfConfigured(failures, "digitalOcean.observe_owned_resources_absent");
      return { dropletAbsent: true, firewallAbsent: true };
    },
    async refundRestorationPayment() {
      calls.push("lemonSqueezy.refund_restoration");
      failIfConfigured(failures, "lemonSqueezy.refund_restoration");
      return { fullRefundConfirmed: true };
    },
    digitalOcean: ownedSetProvider(state, calls, failures, input.now),
    calls: () => [...calls],
  };
}

export async function cancelDeterministicFounderContractSubscription(input: {
  runId: string;
  userId: string;
  subscriptionId: string;
  reconcileEvidence?: boolean;
}): Promise<void> {
  assertDeterministicCommerceBoundary(input);
  if (!globalProviders.__brunoFounderLifecycleProviders) {
    globalProviders.__brunoFounderLifecycleProviders = new Map();
  }
  const registry = globalProviders.__brunoFounderLifecycleProviders;
  const key = `${input.runId}:${input.userId}`;
  let state = registry.get(key);
  if (!state) {
    if (!input.reconcileEvidence) {
      throw new Error("Deterministic Founder commerce state is unavailable.");
    }
    const authority = await readDeterministicFounderContractCommerceAuthority(input);
    state = {
      digitalOcean: new FakeDigitalOceanProvider(),
      archiveStorage: new FakeBackupObjectStorage("founder-product-contract-recovery"),
      seededResourceIds: new Set<string>(),
      restorationCounter: 0,
      subscriptionId: authority.providerSubscriptionId,
      subscriptionOrderId: authority.providerOrderId,
      subscriptionStatus: "active" as const,
      subscriptionUpdatedAt: authority.providerStateUpdatedAt,
      subscriptionEndsAt: null,
      revokedConnections: new Set(),
      calls: [],
    };
  }
  registry.set(key, state);
  assertExpectedSubscription(state, input.subscriptionId);
  state.calls.push("lemonSqueezy.cancel_subscription");
  state.subscriptionStatus = "cancelled";
  state.subscriptionUpdatedAt = new Date(state.subscriptionUpdatedAt.valueOf() + 1);
  state.subscriptionEndsAt = new Date(
    state.subscriptionUpdatedAt.valueOf() + 7 * 24 * 60 * 60 * 1_000,
  );
  if (input.reconcileEvidence) {
    await reconcileDeterministicFounderContractCancellationEvidence(input, state);
  }
}

async function reconcileDeterministicFounderContractCancellationEvidence(
  input: { runId: string; userId: string; subscriptionId: string },
  state: ProviderState,
): Promise<void> {
  const authority = await readDeterministicFounderContractCommerceAuthority(input);
  const connection = createDatabaseConnection();
  try {
    state.subscriptionOrderId = authority.providerOrderId;
    const payloadDigest = founderProductContractDigest(
      JSON.stringify({
        kind: "deterministic_account_closure_cancellation",
        runId: input.runId,
        userId: input.userId,
        subscriptionId: input.subscriptionId,
        updatedAt: state.subscriptionUpdatedAt.toISOString(),
      }),
    );
    const recorded = await recordFounderCommerceWebhook({
      webhook: {
        derivedDeliveryKey: `lemon-squeezy:${payloadDigest}`,
        payloadDigest,
        eventName: "subscription_updated",
        resourceType: "subscriptions",
        resourceId: input.subscriptionId,
        checkoutCorrelation: null,
        subscriptionId: input.subscriptionId,
        orderId: authority.providerOrderId,
        occurredAt: state.subscriptionUpdatedAt.toISOString(),
      },
      recordedAt: state.subscriptionUpdatedAt,
      createConnection: () => connection,
    });
    const provider: LemonSqueezyCommerceProvider = {
      createCheckout: async () => {
        throw new Error("Deterministic cancellation evidence cannot create checkout.");
      },
      createCustomerPortal: async () => {
        throw new Error("Deterministic cancellation evidence cannot create a portal.");
      },
      readSubscription: async () => ({
        subscriptionId: input.subscriptionId,
        orderId: authority.providerOrderId,
        status: "cancelled" as const,
        updatedAt: state.subscriptionUpdatedAt.toISOString(),
        endsAt: state.subscriptionEndsAt?.toISOString() ?? null,
      }),
      readOrder: async () => ({
        orderId: authority.providerOrderId,
        status: "paid" as const,
        total: 1,
        refundedAmount: 0,
        updatedAt: state.subscriptionUpdatedAt.toISOString(),
      }),
      cancelSubscription: async () => undefined,
      refundOrder: async () => {
        throw new Error("Deterministic cancellation evidence cannot refund an order.");
      },
    };
    const result = await reconcileFounderCommerceReceipt({
      receiptId: recorded.receiptId,
      now: state.subscriptionUpdatedAt,
      provider,
      createConnection: () => connection,
    });
    if (result !== "applied" && result !== "ignored") {
      throw new Error("Deterministic Founder cancellation evidence was not reconciled.");
    }
  } finally {
    await connection.close();
  }
}

async function readDeterministicFounderContractCommerceAuthority(input: {
  runId: string;
  userId: string;
  subscriptionId: string;
}): Promise<{
  sourceEventId: string;
  providerSubscriptionId: string;
  providerOrderId: string;
  providerStateUpdatedAt: Date;
}> {
  const connection = createDatabaseConnection();
  try {
    const [authority] = await connection.db
      .select({
        sourceEventId: founderProductEntitlements.sourceEventId,
        providerSubscriptionId: founderProductEntitlements.providerSubscriptionId,
        providerOrderId: founderCommerceEvents.providerOrderId,
        providerStateUpdatedAt: founderProductEntitlements.providerStateUpdatedAt,
      })
      .from(founderProductEntitlements)
      .innerJoin(
        founderCommerceEvents,
        eq(founderCommerceEvents.id, founderProductEntitlements.sourceEventId),
      )
      .where(eq(founderProductEntitlements.userId, input.userId))
      .limit(1);
    if (
      !authority ||
      authority.providerSubscriptionId !== input.subscriptionId ||
      authority.providerOrderId !== `order-${input.subscriptionId}`
    ) {
      throw new Error("Deterministic Founder cancellation authority is unavailable.");
    }
    return authority;
  } finally {
    await connection.close();
  }
}

export async function readDeterministicFounderContractSubscription(input: {
  runId: string;
  userId: string;
  subscriptionId: string;
}): Promise<{
  subscriptionId: string;
  orderId: string;
  status: FounderCommerceStatus;
  updatedAt: string;
  endsAt: string | null;
}> {
  assertDeterministicCommerceBoundary(input);
  const state = globalProviders.__brunoFounderLifecycleProviders?.get(
    `${input.runId}:${input.userId}`,
  );
  if (!state) throw new Error("Deterministic Founder commerce state is unavailable.");
  assertExpectedSubscription(state, input.subscriptionId);
  state.calls.push("lemonSqueezy.read_subscription");
  return {
    subscriptionId: state.subscriptionId,
    orderId: state.subscriptionOrderId,
    status: state.subscriptionStatus,
    updatedAt: state.subscriptionUpdatedAt.toISOString(),
    endsAt: state.subscriptionEndsAt?.toISOString() ?? null,
  };
}

export async function revokeDeterministicFounderContractGoogleConnection(input: {
  runId: string;
  userId: string;
  connectionKind: "calendar";
  token: string;
}): Promise<{ providerRevoked: true }> {
  return revokeDeterministicFounderContractConnection(input);
}

export async function revokeDeterministicFounderContractConnection(input: {
  runId: string;
  userId: string;
  connectionKind: DeterministicFounderContractConnectionKind;
  providerIdentity?: string | null;
  token?: string;
}): Promise<{ providerRevoked: true }> {
  assertDeterministicConnectionBoundary(input);
  const key = `${input.runId}:${input.userId}`;
  const state = globalProviders.__brunoFounderLifecycleProviders?.get(key);
  if (!state) throw new Error("Deterministic Founder connection state is unavailable.");
  state.revokedConnections.add(input.connectionKind);
  state.calls.push(
    input.connectionKind === "ai:openai"
      ? "openAI.revoke_authorization"
      : `google.revoke_${input.connectionKind}`,
  );
  return { providerRevoked: true };
}

export function deterministicFounderContractConnectionRevoked(input: {
  runId: string;
  userId: string;
  connectionKind: DeterministicFounderContractConnectionKind;
}): boolean {
  return (
    globalProviders.__brunoFounderLifecycleProviders
      ?.get(`${input.runId}:${input.userId}`)
      ?.revokedConnections.has(input.connectionKind) ?? false
  );
}

export function deterministicFounderContractGoogleConnectionRevoked(input: {
  runId: string;
  userId: string;
  connectionKind: "calendar";
}): boolean {
  return deterministicFounderContractConnectionRevoked(input);
}

function assertExpectedSubscription(state: ProviderState, subscriptionId: string): void {
  if (subscriptionId !== state.subscriptionId) {
    throw new Error("Deterministic Founder subscription identity does not match.");
  }
}

function assertDeterministicCommerceBoundary(input: {
  runId: string;
  subscriptionId: string;
}): void {
  const appUrl = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "invalid:");
  if (
    process.env.BRUNO_AUTH_MODE !== "development" ||
    process.env.BRUNO_FOUNDER_CONTRACT_PROVIDER_MODE !== "deterministic" ||
    process.env.VERCEL_ENV ||
    process.env.BRUNO_FOUNDER_CONTRACT_RUN_ID !== input.runId ||
    !["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname) ||
    input.subscriptionId !== `${input.runId}:subscription`
  ) {
    throw new Error("Deterministic Founder commerce cancellation is unavailable.");
  }
}

function assertDeterministicConnectionBoundary(input: {
  runId: string;
  userId: string;
  connectionKind: DeterministicFounderContractConnectionKind;
  providerIdentity?: string | null;
  token?: string;
}): void {
  const appUrl = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "invalid:");
  const expectedToken =
    input.connectionKind === "calendar" || input.connectionKind === "mail"
      ? `founder-contract-google:${input.runId}:${input.userId}:${input.connectionKind}:refresh`
      : null;
  if (
    process.env.BRUNO_AUTH_MODE !== "development" ||
    process.env.BRUNO_FOUNDER_CONTRACT_PROVIDER_MODE !== "deterministic" ||
    process.env.VERCEL_ENV ||
    process.env.BRUNO_FOUNDER_CONTRACT_RUN_ID !== input.runId ||
    !["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname) ||
    (input.connectionKind === "ai:openai" && input.providerIdentity !== `openai-${input.userId}`) ||
    (expectedToken !== null && input.token !== expectedToken)
  ) {
    throw new Error("Deterministic Founder connection revocation is unavailable.");
  }
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
