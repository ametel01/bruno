import { createHash, createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeBackupObjectStorage } from "@/src/server/backups/backup-storage";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderCheckoutCorrelations,
  founderCommerceEvents,
  founderInfrastructureRetirements,
  founderProductEntitlements,
  founderRecoveryArchiveDeletionReceipts,
  founderRecoveryArchives,
  operatorPreparations,
  operatorRuntimes,
  operators,
  runnerCredentials,
  runners,
  users,
} from "@/src/server/db/schema";
import { EncryptedFounderRecoveryArchiveProvider } from "@/src/server/founder-product-contract/encrypted-recovery-archive-provider";
import {
  executeFounderProductContractLifecycleAction,
  type FounderCommerceEvent,
  type FounderLifecycleProviderBoundary,
} from "@/src/server/founder-product-contract/lifecycle";
import { getFounderInfrastructureRetirementStatusForUser } from "@/src/server/founder-product-contract/infrastructure-retirement";

const USER_ID = "00000000-0000-4000-8000-000000003740";
const OPERATOR_ID = "00000000-0000-4000-8000-000000003741";
const RUNNER_ID = "00000000-0000-4000-8000-000000003742";
const NOW = new Date("2026-08-22T00:00:00.000Z");
const COMMERCE_SECRET = "retirement-contract-secret";

describe("Founder Infrastructure Retirement deadline", () => {
  let connection: DatabaseConnection;
  let archiveProvider: EncryptedFounderRecoveryArchiveProvider;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    archiveProvider = new EncryptedFounderRecoveryArchiveProvider({
      storage: new FakeBackupObjectStorage("retirement-archive"),
      masterKey: new Uint8Array(32).fill(47),
    });
    await reset();
    await seedRetirementCandidate();
  });

  afterEach(async () => {
    await reset();
    await connection.close();
  });

  it("deletes billable infrastructure before waiting for archive I/O", async () => {
    let markArchiveStarted: (() => void) | undefined;
    let releaseArchive: (() => void) | undefined;
    let markDropletDeleted: (() => void) | undefined;
    const archiveStarted = new Promise<void>((resolve) => {
      markArchiveStarted = resolve;
    });
    const archiveReleased = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const dropletDeleted = new Promise<void>((resolve) => {
      markDropletDeleted = resolve;
    });
    const providers = retirementProviders({
      async createRecoveryArchive(input) {
        markArchiveStarted?.();
        await archiveReleased;
        return archiveProvider.createRecoveryArchive(input);
      },
      onDropletDeleted: () => markDropletDeleted?.(),
    });

    const execution = executeFounderProductContractLifecycleAction(await retirementInput("slow"), {
      providers,
      commerceWebhookSecret: COMMERCE_SECRET,
      applicationRevision: "a".repeat(40),
      createConnection: () => connection,
    });
    await archiveStarted;
    await expect(
      Promise.race([
        dropletDeleted.then(() => "deleted" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
      ]),
    ).resolves.toBe("deleted");
    await expect(
      connection.db
        .select()
        .from(founderInfrastructureRetirements)
        .where(eq(founderInfrastructureRetirements.runnerId, RUNNER_ID)),
    ).resolves.toEqual([expect.objectContaining({ status: "in_progress" })]);
    releaseArchive?.();

    await expect(execution).resolves.toMatchObject({ cleanup: { resourcesAfter: 0 } });
    await expect(
      connection.db
        .select()
        .from(operatorRuntimes)
        .where(eq(operatorRuntimes.operatorId, OPERATOR_ID)),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "needs_attention",
        transportState: "failed",
        safetyState: "unknown",
        runtimeIdentity: null,
        readyAt: null,
        failureCode: "infrastructure_retired",
      }),
    ]);
  });

  it("retires an exact Droplet even when its Operator runtime is unhealthy", async () => {
    await connection.db
      .update(operatorRuntimes)
      .set({ status: "needs_attention", transportState: "failed", safetyState: "failed" })
      .where(eq(operatorRuntimes.operatorId, OPERATOR_ID));

    const providers = retirementProviders();
    await expect(
      executeFounderProductContractLifecycleAction(await retirementInput("unhealthy"), {
        providers,
        commerceWebhookSecret: COMMERCE_SECRET,
        applicationRevision: "a".repeat(40),
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({ cleanup: { resourcesAfter: 0, verified: true } });
    await expect(
      connection.db
        .select()
        .from(founderInfrastructureRetirements)
        .where(eq(founderInfrastructureRetirements.runnerId, RUNNER_ID)),
    ).resolves.toEqual([expect.objectContaining({ status: "completed" })]);
    expect(providers.calls()).toEqual([
      "digitalOcean.observe_owned_resources",
      "digitalOcean.delete_firewall",
      "digitalOcean.delete_droplet",
      "digitalOcean.observe_owned_resources",
    ]);
    const [receipt] = await connection.db
      .select()
      .from(founderInfrastructureRetirements)
      .where(eq(founderInfrastructureRetirements.runnerId, RUNNER_ID));
    expect(receipt).toMatchObject({
      providerResourceId: "droplet-retirement-373",
      providerFirewallId: "firewall-retirement-373",
      providerOperationTag: `bruno-deploy-${RUNNER_ID.replaceAll("-", "")}`,
      providerResourceName: "retirement-runner",
      providerRegion: "sfo3",
      providerSizeSlug: "s-1vcpu-1gb",
      providerFirewallName: "bruno-runners-droplet-retirement-373",
      providerDropletState: "absent",
      providerFirewallState: "absent",
      archiveOutcome: "failed",
      billableRuntimeSeconds: 172_800,
      resourcesBefore: 2,
      resourcesAfter: 0,
    });
    await expect(
      getFounderInfrastructureRetirementStatusForUser(USER_ID, {
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({
      state: "completed",
      archive: { outcome: "failed", criticalFailure: true },
      provider: { droplet: "absent", firewall: "absent" },
      billableRuntime: { seconds: 172_800 },
      needsAttention: false,
    });
  });

  it("records a critical archive failure without extending the destruction deadline", async () => {
    const providers = retirementProviders({
      async createRecoveryArchive() {
        throw new Error("archive provider unavailable");
      },
    });

    await expect(
      executeFounderProductContractLifecycleAction(await retirementInput("archive-failure"), {
        providers,
        commerceWebhookSecret: COMMERCE_SECRET,
        applicationRevision: "a".repeat(40),
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({ cleanup: { resourcesAfter: 0, verified: true } });

    await expect(
      getFounderInfrastructureRetirementStatusForUser(USER_ID, {
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({
      state: "completed",
      archive: { outcome: "failed", criticalFailure: true },
      provider: { droplet: "absent", firewall: "absent" },
    });
  });

  it("returns the completed receipt idempotently for duplicate scheduling", async () => {
    const providers = retirementProviders();
    const input = await retirementInput("duplicate");
    const dependencies = {
      providers,
      commerceWebhookSecret: COMMERCE_SECRET,
      applicationRevision: "a".repeat(40),
      createConnection: () => connection,
    };

    const first = await executeFounderProductContractLifecycleAction(input, dependencies);
    const callCount = providers.calls().length;
    const duplicate = await executeFounderProductContractLifecycleAction(input, dependencies);

    expect(duplicate.cleanup).toEqual(first.cleanup);
    expect(providers.calls()).toHaveLength(callCount);
    await expect(
      connection.db
        .select({ attempts: founderInfrastructureRetirements.attemptCount })
        .from(founderInfrastructureRetirements)
        .where(eq(founderInfrastructureRetirements.runnerId, RUNNER_ID)),
    ).resolves.toEqual([{ attempts: 1 }]);
  });

  it("records ambiguous ownership without issuing any delete request", async () => {
    const calls: string[] = [];
    const providers = retirementProviders();
    providers.digitalOcean.observeOwnedSet = async () => ({
      ok: false,
      reason: "ownership_ambiguous",
      retryable: true,
      message: "ambiguous exact identity",
    });
    providers.digitalOcean.deleteFirewall = async () => {
      calls.push("firewall");
      return { ok: true, value: { state: "absent" } };
    };
    providers.digitalOcean.deleteDroplet = async () => {
      calls.push("droplet");
      return { ok: true, value: { state: "absent" } };
    };

    await expect(
      executeFounderProductContractLifecycleAction(await retirementInput("ambiguous"), {
        providers,
        commerceWebhookSecret: COMMERCE_SECRET,
        applicationRevision: "a".repeat(40),
        createConnection: () => connection,
      }),
    ).rejects.toThrow("ambiguous exact identity");
    expect(calls).toEqual([]);
    await expect(
      connection.db
        .select()
        .from(founderInfrastructureRetirements)
        .where(eq(founderInfrastructureRetirements.runnerId, RUNNER_ID)),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "in_progress",
        providerResourceId: "droplet-retirement-373",
        providerFirewallId: "firewall-retirement-373",
        providerDropletState: "unknown",
        providerFirewallState: "unknown",
        failureCode: "digitalocean_ownership_ambiguous",
      }),
    ]);
    await expect(
      connection.db
        .select({ status: runnerCredentials.status })
        .from(runnerCredentials)
        .where(eq(runnerCredentials.runnerId, RUNNER_ID)),
    ).resolves.toEqual([{ status: "revoked" }]);
  });

  it("times out an uncertain provider read and leaves the exact receipt retryable", async () => {
    const providers = retirementProviders();
    providers.digitalOcean.observeOwnedSet = () => new Promise(() => undefined);

    await expect(
      executeFounderProductContractLifecycleAction(await retirementInput("timeout"), {
        providers,
        commerceWebhookSecret: COMMERCE_SECRET,
        applicationRevision: "a".repeat(40),
        providerRequestTimeoutMilliseconds: 5,
        createConnection: () => connection,
      }),
    ).rejects.toThrow("timed out");
    await expect(
      connection.db
        .select()
        .from(founderInfrastructureRetirements)
        .where(eq(founderInfrastructureRetirements.runnerId, RUNNER_ID)),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "in_progress",
        failureCode: "provider_request_timeout",
        attemptCount: 1,
      }),
    ]);
  });

  it("retries partial cleanup against the frozen receipt after mutable runner data changes", async () => {
    const first = retirementProviders();
    first.digitalOcean.deleteFirewall = async () => ({
      ok: false,
      reason: "delete_outcome_unknown",
      retryable: true,
      message: "firewall response unknown",
    });
    const originalInput = await retirementInput("partial-retry");
    await expect(
      executeFounderProductContractLifecycleAction(originalInput, {
        providers: first,
        commerceWebhookSecret: COMMERCE_SECRET,
        applicationRevision: "a".repeat(40),
        createConnection: () => connection,
      }),
    ).rejects.toThrow("firewall response unknown");
    await connection.db
      .update(runners)
      .set({ name: "mutated-runner-name", providerResourceId: "mutated-droplet" })
      .where(eq(runners.id, RUNNER_ID));

    const expectations: string[] = [];
    let dropletPresent = true;
    const second = retirementProviders();
    second.digitalOcean = {
      async observeOwnedSet(expectation) {
        expectations.push(expectation.providerResourceId);
        return {
          ok: true,
          value: {
            state: dropletPresent ? "owned" : "absent",
            droplet: dropletPresent ? "present" : "absent",
            firewall: "absent",
            dropletCreatedAt: dropletPresent
              ? new Date(NOW.valueOf() - 48 * 60 * 60 * 1_000).toISOString()
              : null,
          },
        };
      },
      async deleteFirewall() {
        throw new Error("already absent firewall must not be deleted again");
      },
      async deleteDroplet(expectation) {
        expectations.push(expectation.providerResourceId);
        dropletPresent = false;
        return { ok: true, value: { state: "absent" } };
      },
    };
    await expect(
      executeFounderProductContractLifecycleAction(originalInput, {
        providers: second,
        commerceWebhookSecret: COMMERCE_SECRET,
        applicationRevision: "a".repeat(40),
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({ cleanup: { verified: true, resourcesAfter: 0 } });
    expect(expectations).toEqual([
      "droplet-retirement-373",
      "droplet-retirement-373",
      "droplet-retirement-373",
    ]);
  });

  it.each([
    "active",
    "online",
    "offline",
    "degraded",
  ] as const)("counts a provider-present %s Droplet as billable until verified absence", async (status) => {
    await connection.db.update(runners).set({ status }).where(eq(runners.id, RUNNER_ID));
    await expect(
      executeFounderProductContractLifecycleAction(await retirementInput(`cost-${status}`), {
        providers: retirementProviders(),
        commerceWebhookSecret: COMMERCE_SECRET,
        applicationRevision: "a".repeat(40),
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({ cleanup: { resourcesBefore: 2, resourcesAfter: 0 } });
    const [receipt] = await connection.db
      .select({
        seconds: founderInfrastructureRetirements.billableRuntimeSeconds,
        archiveOutcome: founderInfrastructureRetirements.archiveOutcome,
      })
      .from(founderInfrastructureRetirements)
      .where(eq(founderInfrastructureRetirements.runnerId, RUNNER_ID));
    expect(receipt?.seconds).toBe(172_800);
    expect(receipt?.archiveOutcome).toBe("verified");
  });

  it("fences a retirement retry to the persisted archive runtime revision", async () => {
    const input = await retirementInput("revision-fence");
    const archiveId = "00000000-0000-4000-8000-000000003743";
    const [archive] = await connection.db
      .insert(founderRecoveryArchives)
      .values({
        id: archiveId,
        userId: USER_ID,
        operatorId: OPERATOR_ID,
        applicationRevision: "a".repeat(40),
        runtimeRevision: "runtime-retirement-v1",
        status: "pending",
        storageObjectKey: `founder-recovery/${USER_ID}/${archiveId}.age`,
        recoveryCredentialObjectKey: `founder-recovery/${USER_ID}/${archiveId}.key`,
        restorableVerified: false,
        observedAt: NOW,
        expiresAt: new Date(NOW.valueOf() + 30 * 24 * 60 * 60 * 1_000),
        createdAt: NOW,
      })
      .returning();
    if (!archive) throw new Error("Expected Recovery Archive intent.");
    await connection.db.insert(founderInfrastructureRetirements).values({
      userId: USER_ID,
      runnerId: RUNNER_ID,
      recoveryArchiveId: archiveId,
      idempotencyKey: `sha256:${"1".repeat(64)}`,
      providerResourceId: "droplet-retirement-373",
      providerFirewallId: "firewall-retirement-373",
      ...persistedRetirementIdentity(),
      status: "in_progress",
      resourcesBefore: 2,
      resourcesAfter: null,
      workStoppedAt: NOW,
      credentialsDisabledAt: NOW,
      attemptCount: 1,
      leaseToken: "expired-retry-lease",
      leaseExpiresAt: new Date(NOW.valueOf() - 1),
      createdAt: NOW,
      updatedAt: NOW,
    });
    await connection.db
      .update(operatorRuntimes)
      .set({ configRevision: "runtime-retirement-v2" })
      .where(eq(operatorRuntimes.operatorId, OPERATOR_ID));
    let archiveCalls = 0;
    const providers = retirementProviders({
      async createRecoveryArchive(archiveInput) {
        archiveCalls += 1;
        return archiveProvider.createRecoveryArchive(archiveInput);
      },
    });

    await expect(
      executeFounderProductContractLifecycleAction(input, {
        providers,
        commerceWebhookSecret: COMMERCE_SECRET,
        applicationRevision: "a".repeat(40),
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({ cleanup: { resourcesAfter: 0 } });
    expect(archiveCalls).toBe(0);
    await expect(
      connection.db
        .select({
          status: founderRecoveryArchives.status,
          failureCode: founderRecoveryArchives.failureCode,
        })
        .from(founderRecoveryArchives)
        .where(eq(founderRecoveryArchives.id, archiveId)),
    ).resolves.toEqual([{ status: "failed", failureCode: "archive_create_failed" }]);
  });

  it.each([
    { label: "prior-revision", applicationRevision: "a".repeat(40) },
    { label: "legacy-null-revision", applicationRevision: null },
  ])("fences a retirement retry from a $label Recovery Archive intent", async ({
    applicationRevision,
  }) => {
    const input = await retirementInput(`application-fence-${applicationRevision ?? "legacy"}`);
    const archiveId = "00000000-0000-4000-8000-000000003744";
    await connection.db.insert(founderRecoveryArchives).values({
      id: archiveId,
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      applicationRevision,
      runtimeRevision: "runtime-retirement-v1",
      status: "pending",
      storageObjectKey: `founder-recovery/${USER_ID}/${archiveId}.age`,
      recoveryCredentialObjectKey: `founder-recovery/${USER_ID}/${archiveId}.key`,
      restorableVerified: false,
      observedAt: NOW,
      expiresAt: new Date(NOW.valueOf() + 30 * 24 * 60 * 60 * 1_000),
      createdAt: NOW,
    });
    await connection.db.insert(founderInfrastructureRetirements).values({
      userId: USER_ID,
      runnerId: RUNNER_ID,
      recoveryArchiveId: archiveId,
      idempotencyKey: `sha256:${"2".repeat(64)}`,
      providerResourceId: "droplet-retirement-373",
      providerFirewallId: "firewall-retirement-373",
      ...persistedRetirementIdentity(),
      status: "in_progress",
      resourcesBefore: 2,
      resourcesAfter: null,
      workStoppedAt: NOW,
      credentialsDisabledAt: NOW,
      attemptCount: 1,
      leaseToken: "expired-application-retry-lease",
      leaseExpiresAt: new Date(NOW.valueOf() - 1),
      createdAt: NOW,
      updatedAt: NOW,
    });
    let archiveCalls = 0;
    const providers = retirementProviders({
      async createRecoveryArchive(archiveInput) {
        archiveCalls += 1;
        return archiveProvider.createRecoveryArchive(archiveInput);
      },
    });

    await expect(
      executeFounderProductContractLifecycleAction(input, {
        providers,
        commerceWebhookSecret: COMMERCE_SECRET,
        applicationRevision: "b".repeat(40),
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({ cleanup: { resourcesAfter: 0 } });
    expect(archiveCalls).toBe(0);
    await expect(
      connection.db
        .select({
          status: founderRecoveryArchives.status,
          failureCode: founderRecoveryArchives.failureCode,
        })
        .from(founderRecoveryArchives)
        .where(eq(founderRecoveryArchives.id, archiveId)),
    ).resolves.toEqual([
      { status: "failed", failureCode: "archive_application_revision_mismatch" },
    ]);
  });

  function retirementProviders(
    input: {
      createRecoveryArchive?: FounderLifecycleProviderBoundary["createRecoveryArchive"];
      onDropletDeleted?: () => void;
    } = {},
  ): FounderLifecycleProviderBoundary {
    let dropletPresent = true;
    let firewallPresent = true;
    const calls: string[] = [];
    return {
      authenticateIdentity: async () => ({ subject: "unused" }),
      verifyCapabilityProviders: async () => ({ openAI: true, anthropic: true, google: true }),
      readSubscription: async () => ({ status: "unpaid" }),
      createRecoveryArchive:
        input.createRecoveryArchive ??
        ((archiveInput) => archiveProvider.createRecoveryArchive(archiveInput)),
      deleteRecoveryArchive: (deletion) => archiveProvider.deleteRecoveryArchive(deletion),
      digitalOcean: {
        async observeOwnedSet() {
          calls.push("digitalOcean.observe_owned_resources");
          return {
            ok: true,
            value: {
              state: dropletPresent || firewallPresent ? "owned" : "absent",
              droplet: dropletPresent ? "present" : "absent",
              firewall: firewallPresent ? "present" : "absent",
              dropletCreatedAt: dropletPresent
                ? new Date(NOW.valueOf() - 48 * 60 * 60 * 1_000).toISOString()
                : null,
            },
          };
        },
        async deleteFirewall() {
          calls.push("digitalOcean.delete_firewall");
          firewallPresent = false;
          return { ok: true, value: { state: "absent" } };
        },
        async deleteDroplet() {
          calls.push("digitalOcean.delete_droplet");
          dropletPresent = false;
          input.onDropletDeleted?.();
          return { ok: true, value: { state: "absent" } };
        },
      },
      calls: () => [...calls],
    };
  }

  async function retirementInput(suffix: string) {
    const checkoutCorrelation = `retirement-${suffix}`;
    const unsigned = {
      eventId: `retirement-${suffix}-event`,
      checkoutCorrelation,
      subscriptionId: `retirement-${suffix}-subscription`,
      status: "unpaid" as const,
      endsAt: null,
      occurredAt: new Date(NOW.valueOf() - 24 * 60 * 60 * 1_000).toISOString(),
    };
    const commerceEvent: FounderCommerceEvent = {
      ...unsigned,
      signature: `hmac-sha256:${createHmac("sha256", COMMERCE_SECRET)
        .update(JSON.stringify(unsigned))
        .digest("hex")}`,
    };
    const [correlation] = await connection.db
      .insert(founderCheckoutCorrelations)
      .values({
        userId: USER_ID,
        correlationDigest: `sha256:${createHash("sha256")
          .update(checkoutCorrelation)
          .digest("hex")}`,
        status: "consumed",
        createdAt: new Date(NOW.valueOf() - 24 * 60 * 60 * 1_000),
        expiresAt: new Date(NOW.valueOf() + 60 * 60 * 1_000),
        consumedAt: NOW,
      })
      .returning({ id: founderCheckoutCorrelations.id });
    if (!correlation) throw new Error("Expected retirement checkout correlation.");
    const [event] = await connection.db
      .insert(founderCommerceEvents)
      .values({
        providerEventId: unsigned.eventId,
        userId: USER_ID,
        checkoutCorrelationId: correlation.id,
        providerSubscriptionId: unsigned.subscriptionId,
        eventType: "subscription_unpaid",
        payloadDigest: `sha256:${createHash("sha256")
          .update(JSON.stringify(unsigned))
          .digest("hex")}`,
        signatureVerified: true,
        occurredAt: new Date(unsigned.occurredAt),
        recordedAt: NOW,
      })
      .returning({ id: founderCommerceEvents.id });
    if (!event) throw new Error("Expected retirement commerce event.");
    await connection.db.insert(founderProductEntitlements).values({
      userId: USER_ID,
      sourceEventId: event.id,
      providerSubscriptionId: unsigned.subscriptionId,
      status: "unpaid",
      reconciledProviderStatus: "unpaid",
      reconciledAt: NOW,
      retirementDueAt: NOW,
      updatedAt: NOW,
    });
    return {
      action: "infrastructure_retirement" as const,
      runId: `retirement-${suffix}`,
      userId: USER_ID,
      now: NOW,
      commerceEvent,
    };
  }

  function persistedRetirementIdentity() {
    return {
      providerOperationTag: `bruno-deploy-${RUNNER_ID.replaceAll("-", "")}`,
      providerResourceName: "retirement-runner",
      providerRegion: "sfo3",
      providerSizeSlug: "s-1vcpu-1gb",
      providerFirewallName: "bruno-runners-droplet-retirement-373",
      hardDestructionDueAt: NOW,
    };
  }

  async function seedRetirementCandidate(): Promise<void> {
    await connection.db.insert(users).values({ id: USER_ID, createdAt: NOW, updatedAt: NOW });
    await connection.db.insert(operators).values({
      id: OPERATOR_ID,
      userId: USER_ID,
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await connection.db.insert(operatorPreparations).values({
      operatorId: OPERATOR_ID,
      status: "ready",
      timezone: "Asia/Manila",
      timezoneConfirmedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await connection.db.insert(operatorRuntimes).values({
      operatorId: OPERATOR_ID,
      status: "ready",
      transportState: "connected",
      safetyState: "verified",
      configRevision: "runtime-retirement-v1",
      attemptCount: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await connection.db.insert(runners).values({
      id: RUNNER_ID,
      userId: USER_ID,
      name: "retirement-runner",
      kind: "digitalocean",
      status: "offline",
      provider: "digitalocean",
      providerResourceId: "droplet-retirement-373",
      providerFirewallId: "firewall-retirement-373",
      region: "sfo3",
      sizeSlug: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      provisioningStatus: "ready",
      provisioningOperationKey: `bruno-deploy-${RUNNER_ID.replaceAll("-", "")}`,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await connection.db.insert(runnerCredentials).values({
      runnerId: RUNNER_ID,
      credentialHash: `sha256:${createHash("sha256").update(RUNNER_ID).digest("hex")}`,
      credentialPrefix: "retirement",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  async function reset(): Promise<void> {
    await connection.db.transaction(async (tx) => {
      await tx
        .delete(founderRecoveryArchiveDeletionReceipts)
        .where(eq(founderRecoveryArchiveDeletionReceipts.userId, USER_ID));
      await tx
        .delete(founderInfrastructureRetirements)
        .where(eq(founderInfrastructureRetirements.userId, USER_ID));
      await tx.delete(founderRecoveryArchives).where(eq(founderRecoveryArchives.userId, USER_ID));
      await tx
        .delete(founderProductEntitlements)
        .where(eq(founderProductEntitlements.userId, USER_ID));
      await tx.delete(founderCommerceEvents).where(eq(founderCommerceEvents.userId, USER_ID));
      await tx
        .delete(founderCheckoutCorrelations)
        .where(eq(founderCheckoutCorrelations.userId, USER_ID));
      await tx.delete(runnerCredentials).where(eq(runnerCredentials.runnerId, RUNNER_ID));
      await tx.delete(runners).where(eq(runners.id, RUNNER_ID));
      await tx.delete(operatorRuntimes).where(eq(operatorRuntimes.operatorId, OPERATOR_ID));
      await tx.delete(operatorPreparations).where(eq(operatorPreparations.operatorId, OPERATOR_ID));
      await tx.delete(operators).where(eq(operators.id, OPERATOR_ID));
      await tx.delete(users).where(eq(users.id, USER_ID));
    });
  }
});
