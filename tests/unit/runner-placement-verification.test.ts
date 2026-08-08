import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { runnerProvisioningEvents, runners, users } from "@/src/server/db/schema";
import { FakeDigitalOceanProvider } from "@/src/server/runners/digitalocean-provider";
import {
  reconcileExternallyDeletedDigitalOceanRunners,
  verifyRunnerPlacementCandidate,
} from "@/src/server/runners/runner-placement-verification";
import { RUNNER_BOOT_CONTRACT_VERSION } from "@/src/runner-service/constants";
import { readyRunnerBootSnapshot } from "@/tests/helpers/runner-boot";

const RUNNER_IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const HOSTED_COMPATIBILITY_REQUIREMENT = {
  mode: "hosted",
  release: {
    version: "sha-current",
    imageDigest: RUNNER_IMAGE_DIGEST,
    bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
  },
} as const;

describe.sequential("runner placement live verification", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("tombstones a ready runner whose DigitalOcean Droplet was destroyed", async () => {
    const userId = await seedUser(connection);
    const runner = await seedCloudRunner(connection, userId, "destroyed-droplet");
    const now = new Date("2026-07-14T00:00:00.000Z");

    const result = await verifyRunnerPlacementCandidate(
      connection,
      { runnerId: runner.id, userId },
      {
        compatibilityRequirement: HOSTED_COMPATIBILITY_REQUIREMENT,
        now: () => now,
        provider: new FakeDigitalOceanProvider(),
        readConfig,
      },
    );
    const [persisted] = await connection.db
      .select({
        status: runners.status,
        provisioningStatus: runners.provisioningStatus,
        deletedAt: runners.deletedAt,
      })
      .from(runners)
      .where(eq(runners.id, runner.id));
    const events = await connection.db
      .select()
      .from(runnerProvisioningEvents)
      .where(eq(runnerProvisioningEvents.runnerId, runner.id));

    expect(result).toEqual({
      ok: false,
      action: "reject_candidate",
      reason: "provider_resource_missing",
      transitioned: true,
    });
    expect(persisted).toEqual({
      status: "deleted",
      provisioningStatus: "deleted",
      deletedAt: now,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: "deleted",
        status: "completed",
        metadata: expect.objectContaining({ deletionSource: "provider_reconciliation" }),
      }),
    );
  });

  it("fails closed without mutating the runner when the provider check fails", async () => {
    const userId = await seedUser(connection);
    const runner = await seedCloudRunner(connection, userId, "provider-error-droplet");
    const provider = new FakeDigitalOceanProvider();
    provider.readResource = vi.fn(async () => {
      throw new Error("DigitalOcean API unavailable");
    });

    const result = await verifyRunnerPlacementCandidate(
      connection,
      { runnerId: runner.id, userId },
      {
        compatibilityRequirement: HOSTED_COMPATIBILITY_REQUIREMENT,
        provider,
        readConfig,
      },
    );
    const [persisted] = await connection.db
      .select({ status: runners.status, deletedAt: runners.deletedAt })
      .from(runners)
      .where(eq(runners.id, runner.id));

    expect(result).toEqual({
      ok: false,
      action: "fail_closed",
      reason: "provider_check_failed",
      transitioned: false,
    });
    expect(persisted).toEqual({ status: "online", deletedAt: null });
  });

  it("marks an unreachable ready endpoint offline", async () => {
    const provider = new FakeDigitalOceanProvider({ idPrefix: "reachable" });
    const resource = await createProviderResource(provider);
    const userId = await seedUser(connection);
    const runner = await seedCloudRunner(connection, userId, resource.providerResourceId);
    const now = new Date("2026-07-14T00:01:00.000Z");

    const result = await verifyRunnerPlacementCandidate(
      connection,
      { runnerId: runner.id, userId },
      {
        compatibilityRequirement: HOSTED_COMPATIBILITY_REQUIREMENT,
        fetch: async () => {
          throw new Error("connection refused");
        },
        now: () => now,
        provider,
        readConfig,
      },
    );
    const [persisted] = await connection.db
      .select({ status: runners.status, updatedAt: runners.updatedAt })
      .from(runners)
      .where(eq(runners.id, runner.id));

    expect(result).toEqual({
      ok: false,
      action: "reject_candidate",
      reason: "network_error",
      transitioned: true,
    });
    expect(persisted).toEqual({ status: "offline", updatedAt: now });
  });

  it("does not overwrite a concurrent heartbeat while rejecting an endpoint", async () => {
    const provider = new FakeDigitalOceanProvider({ idPrefix: "concurrent" });
    const resource = await createProviderResource(provider);
    const userId = await seedUser(connection);
    const runner = await seedCloudRunner(connection, userId, resource.providerResourceId);
    const heartbeatAt = new Date("2026-07-14T00:02:00.000Z");

    const result = await verifyRunnerPlacementCandidate(
      connection,
      { runnerId: runner.id, userId },
      {
        compatibilityRequirement: HOSTED_COMPATIBILITY_REQUIREMENT,
        fetch: async () => {
          await connection.db
            .update(runners)
            .set({ updatedAt: heartbeatAt })
            .where(eq(runners.id, runner.id));
          throw new Error("stale probe failed");
        },
        provider,
        readConfig,
      },
    );
    const [persisted] = await connection.db
      .select({ status: runners.status, updatedAt: runners.updatedAt })
      .from(runners)
      .where(eq(runners.id, runner.id));

    expect(result).toMatchObject({
      ok: false,
      reason: "network_error",
      transitioned: false,
    });
    expect(persisted).toEqual({ status: "online", updatedAt: heartbeatAt });
  });

  it("rejects a candidate whose compatibility changes during live verification", async () => {
    const provider = new FakeDigitalOceanProvider({ idPrefix: "compatibility-race" });
    const resource = await createProviderResource(provider);
    const userId = await seedUser(connection);
    const runner = await seedCloudRunner(connection, userId, resource.providerResourceId);

    const result = await verifyRunnerPlacementCandidate(
      connection,
      { runnerId: runner.id, userId },
      {
        compatibilityRequirement: HOSTED_COMPATIBILITY_REQUIREMENT,
        fetch: async () => {
          await connection.db
            .update(runners)
            .set({ compatibilityState: "outdated" })
            .where(eq(runners.id, runner.id));
          return Response.json(readyRunnerBootSnapshot());
        },
        provider,
        readConfig,
      },
    );

    expect(result).toEqual({
      ok: false,
      action: "reject_candidate",
      reason: "release_incompatible",
      transitioned: false,
    });
  });

  it("bulk reconciliation removes missing provider resources and reports provider failures", async () => {
    const userId = await seedUser(connection);
    const deletedRunner = await seedCloudRunner(connection, userId, "missing-droplet");
    const failedRunner = await seedCloudRunner(connection, userId, "failed-check-droplet");
    const provider = new FakeDigitalOceanProvider();
    provider.readResource = vi.fn(async ({ providerResourceId }) => {
      if (providerResourceId === "failed-check-droplet") {
        return { ok: false as const, reason: "cleanup_failed" as const, message: "unavailable" };
      }
      return {
        ok: false as const,
        reason: "resource_not_found" as const,
        message: "not found",
      };
    });

    const result = await reconcileExternallyDeletedDigitalOceanRunners({
      createConnection: () => connection,
      provider,
      readConfig,
    });

    expect(result).toEqual({
      checkedCount: 2,
      deletedCount: 1,
      deletedRunnerIds: [deletedRunner.id],
      providerCheckFailedRunnerIds: [failedRunner.id],
    });
  });
});

function readConfig() {
  return {
    token: "digitalocean-test-token",
    runnerBearerToken: "runner-command-token",
    runnerImage: `ghcr.io/ametel01/bruno-runner:sha-current@${RUNNER_IMAGE_DIGEST}`,
    region: "sfo3",
    sizeSlug: "s-1vcpu-512mb-10gb",
    image: "ubuntu-24-04-x64",
    tags: ["bruno"],
  };
}

async function seedUser(connection: DatabaseConnection): Promise<string> {
  const [user] = await connection.db.insert(users).values({}).returning({ id: users.id });
  if (!user) throw new Error("User insert returned no rows.");
  return user.id;
}

async function seedCloudRunner(
  connection: DatabaseConnection,
  userId: string,
  providerResourceId: string,
): Promise<{ id: string }> {
  const now = new Date("2026-07-13T23:59:00.000Z");
  const [runner] = await connection.db
    .insert(runners)
    .values({
      userId,
      name: `Runner ${providerResourceId}`,
      kind: "digitalocean",
      endpointUrl: `https://${providerResourceId}.example.com`,
      status: "online",
      provider: "digitalocean",
      providerResourceId,
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      provisioningStatus: "ready",
      provisioningStartedAt: now,
      provisioningCompletedAt: now,
      requiredRunnerImageDigest: RUNNER_IMAGE_DIGEST,
      observedRunnerImageDigest: RUNNER_IMAGE_DIGEST,
      observedRunnerReleaseVersion: "sha-current",
      observedRunnerBootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      compatibilityState: "compatible",
      compatibilityVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: runners.id });
  if (!runner) throw new Error("Runner insert returned no rows.");
  return runner;
}

async function createProviderResource(provider: FakeDigitalOceanProvider) {
  const result = await provider.createRunner({
    name: "Cloud Runner",
    region: "sfo3",
    sizeSlug: "s-1vcpu-512mb-10gb",
    image: "ubuntu-24-04-x64",
    tags: ["bruno"],
  });
  if (!result.ok) throw new Error("Provider resource creation failed.");
  return result.value;
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table runner_provisioning_events, runner_heartbeats, runner_credentials, runner_registration_tokens, agent_approvals, agent_configs, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runners, app_metadata, users restart identity cascade`;
}
