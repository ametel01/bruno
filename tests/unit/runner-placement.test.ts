import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agents, appMetadata, runnerHeartbeats, runners, users } from "@/src/server/db/schema";
import { RUNNER_HEARTBEAT_STALE_THRESHOLD_MS } from "@/src/server/runners/runner-heartbeat";
import {
  lockRunnerPlacementCapacityInTransaction,
  normalizeRunnerCapacitySnapshot,
  selectRunnerPlacementForDevelopmentUser,
  selectRunnerPlacementForUser,
} from "@/src/server/runners/runner-placement";
import { DEVELOPMENT_USER_METADATA_KEY } from "@/src/server/users/development-user";
import { FakeDigitalOceanProvider } from "@/src/server/runners/digitalocean-provider";
import { verifyRunnerPlacementCandidate } from "@/src/server/runners/runner-placement-verification";
import { RUNNER_BOOT_CONTRACT_VERSION } from "@/src/runner-service/constants";

const RUNNER_IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const HOSTED_COMPATIBILITY_REQUIREMENT = {
  mode: "hosted",
  release: {
    version: "sha-current",
    imageDigest: RUNNER_IMAGE_DIGEST,
    bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
  },
} as const;
const LOCAL_TWO_AGENT_CAPACITY = {
  configuredMaxAgents: 2,
  measuredMaxAgents: 2,
  perHermesDiskGiB: 10,
  hostDiskReserveGiB: 10,
  profile: { vcpus: 2, memoryMiB: 4096, diskGiB: 80 },
} as const;

describe.sequential("runner placement contract", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("returns one eligible online runner when capacity is available", async () => {
    const userId = await seedDevelopmentUser(connection);
    const runner = await seedOnlineRunner(connection, userId, {
      name: "Available Runner",
      updatedAt: new Date("2026-07-06T04:00:00.000Z"),
    });
    await seedHeartbeat(connection, runner.id, {
      observedAt: new Date("2026-07-06T04:01:00.000Z"),
      metrics: {
        maxAgents: 2,
        runningAgents: 1,
        cpuPercent: 37,
        memoryUsedMb: 512,
        memoryTotalMb: 2048,
        diskUsedMb: 4096,
        diskTotalMb: 20_480,
      },
    });

    const result = await selectRunnerPlacementForDevelopmentUser(
      {},
      {
        createConnection: () => connection,
        now: () => new Date("2026-07-06T04:02:00.000Z"),
        capacityOptions: LOCAL_TWO_AGENT_CAPACITY,
      },
    );

    expect(result).toEqual({
      ok: true,
      runner: {
        id: runner.id,
        kind: "manual_vps",
        status: "online",
        capacity: {
          max_agents: 2,
          running_agents: 1,
          cpu_used_percent: 37,
          memory_used_mb: 512,
          memory_total_mb: 2048,
          disk_used_mb: 4096,
          disk_total_mb: 20_480,
        },
        latestHeartbeatAt: "2026-07-06T04:01:00.000Z",
      },
    });
  });

  it("does not let heartbeat capacity exceed missing measured/profile evidence", async () => {
    const userId = await seedDevelopmentUser(connection);
    const runner = await seedOnlineRunner(connection, userId, {
      name: "Fail Closed Runner",
      updatedAt: new Date("2026-07-06T04:10:00.000Z"),
    });
    await seedHeartbeat(connection, runner.id, {
      observedAt: new Date("2026-07-06T04:11:00.000Z"),
      metrics: { maxAgents: 99, runningAgents: 0 },
    });

    const result = await selectRunnerPlacementForDevelopmentUser(
      {},
      {
        createConnection: () => connection,
        now: () => new Date("2026-07-06T04:12:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      runner: {
        id: runner.id,
        capacity: { max_agents: 1, running_agents: 0 },
      },
    });
  });

  it("counts stopped desired-running ready agents as durable runner reservations", async () => {
    const userId = await seedDevelopmentUser(connection);
    const runner = await seedOnlineRunner(connection, userId, {
      name: "Reserved Runner",
      updatedAt: new Date("2026-07-06T04:20:00.000Z"),
    });
    await seedHeartbeat(connection, runner.id, {
      observedAt: new Date("2026-07-06T04:21:00.000Z"),
      metrics: { maxAgents: 2, runningAgents: 0 },
    });
    await connection.db.insert(agents).values([
      {
        userId,
        runnerId: runner.id,
        name: "Ready Reservation One",
        templateKey: "research_agent",
        status: "stopped",
        desiredStatus: "running",
      },
      {
        userId,
        runnerId: runner.id,
        name: "Ready Reservation Two",
        templateKey: "research_agent",
        status: "stopped",
        desiredStatus: "running",
      },
    ]);

    const result = await selectRunnerPlacementForDevelopmentUser(
      {},
      {
        createConnection: () => connection,
        now: () => new Date("2026-07-06T04:22:00.000Z"),
        capacityOptions: LOCAL_TWO_AGENT_CAPACITY,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "runner_capacity_reached",
      runner: { id: runner.id, capacity: { max_agents: 2, running_agents: 2 } },
    });
  });

  it("refuses to take an owner-aware capacity lock for a foreign runner", async () => {
    const [owner, foreignUser] = await connection.db.insert(users).values([{}, {}]).returning();
    if (!owner || !foreignUser) throw new Error("Expected users.");
    const foreignRunner = await seedOnlineRunner(connection, foreignUser.id, {
      name: "Foreign Runner",
    });

    const locked = await connection.db.transaction((tx) =>
      lockRunnerPlacementCapacityInTransaction(tx, {
        userId: owner.id,
        runnerId: foreignRunner.id,
      }),
    );

    expect(locked).toBe(false);
  });

  it("selects and reconciles runners only for the explicit user", async () => {
    const now = new Date("2026-07-06T04:03:00.000Z");
    const staleObservedAt = new Date(now.getTime() - RUNNER_HEARTBEAT_STALE_THRESHOLD_MS - 1);
    const [owner, foreignUser] = await connection.db
      .insert(users)
      .values([{}, {}])
      .returning({ id: users.id });

    if (!owner || !foreignUser) {
      throw new Error("User inserts returned no rows.");
    }

    const ownedRunner = await seedOnlineRunner(connection, owner.id, {
      name: "Owned Runner",
    });
    const foreignRunner = await seedOnlineRunner(connection, foreignUser.id, {
      name: "Foreign Stale Runner",
    });
    await seedHeartbeat(connection, ownedRunner.id, {
      observedAt: new Date("2026-07-06T04:02:30.000Z"),
      metrics: { maxAgents: 2, runningAgents: 0 },
    });
    await seedHeartbeat(connection, foreignRunner.id, {
      observedAt: staleObservedAt,
      metrics: { maxAgents: 2, runningAgents: 0 },
    });

    const result = await selectRunnerPlacementForUser(
      owner.id,
      {},
      { createConnection: () => connection, now: () => now },
    );
    const [persistedForeignRunner] = await connection.db
      .select({ status: runners.status })
      .from(runners)
      .where(eq(runners.id, foreignRunner.id))
      .limit(1);

    expect(result).toMatchObject({ ok: true, runner: { id: ownedRunner.id } });
    expect(persistedForeignRunner?.status).toBe("online");
  });

  it("does not reconcile owned runners when an explicit foreign runner is requested", async () => {
    const now = new Date("2026-07-06T04:03:00.000Z");
    const staleObservedAt = new Date(now.getTime() - RUNNER_HEARTBEAT_STALE_THRESHOLD_MS - 1);
    const [owner, foreignUser] = await connection.db
      .insert(users)
      .values([{}, {}])
      .returning({ id: users.id });

    if (!owner || !foreignUser) {
      throw new Error("User inserts returned no rows.");
    }

    const ownedRunner = await seedOnlineRunner(connection, owner.id, {
      name: "Owned Stale Runner",
    });
    const foreignRunner = await seedOnlineRunner(connection, foreignUser.id, {
      name: "Foreign Requested Runner",
    });
    await seedHeartbeat(connection, ownedRunner.id, {
      observedAt: staleObservedAt,
      metrics: { maxAgents: 2, runningAgents: 0 },
    });

    const result = await selectRunnerPlacementForUser(
      owner.id,
      { runnerId: foreignRunner.id },
      { createConnection: () => connection, now: () => now },
    );
    const [persistedOwnedRunner] = await connection.db
      .select({ status: runners.status, updatedAt: runners.updatedAt })
      .from(runners)
      .where(eq(runners.id, ownedRunner.id));

    expect(result).toEqual({ ok: false, reason: "no_online_runner" });
    expect(persistedOwnedRunner?.status).toBe("online");
    expect(persistedOwnedRunner?.updatedAt).not.toEqual(now);
  });

  it("rejects online runners when runner capacity is unavailable", async () => {
    const userId = await seedDevelopmentUser(connection);
    const runner = await seedOnlineRunner(connection, userId, {
      name: "Full Runner",
      endpointUrl: "https://full-runner.example.com",
    });
    await seedHeartbeat(connection, runner.id, {
      observedAt: new Date("2026-07-06T04:05:00.000Z"),
      metrics: {
        maxAgents: 2,
        runningAgents: 2,
        cpuPercent: 94,
      },
    });

    const result = await selectRunnerPlacementForDevelopmentUser(
      {},
      {
        createConnection: () => connection,
        now: () => new Date("2026-07-06T04:06:00.000Z"),
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: "runner_capacity_reached",
      runner: expect.objectContaining({
        id: runner.id,
        capacity: expect.objectContaining({
          max_agents: 1,
          running_agents: 2,
          cpu_used_percent: 94,
        }),
      }),
    });
  });

  it("rejects placement when there is no online runner", async () => {
    const userId = await seedDevelopmentUser(connection);
    await connection.db.insert(runners).values({
      userId,
      name: "Offline Runner",
      kind: "manual_vps",
      endpointUrl: "https://offline-runner.example.com",
      status: "offline",
    });

    await expect(
      selectRunnerPlacementForDevelopmentUser({}, { createConnection: () => connection }),
    ).resolves.toEqual({ ok: false, reason: "no_online_runner" });
  });

  it("keeps legacy ready managed runners nonassignable after the additive backfill", async () => {
    const userId = await seedDevelopmentUser(connection);
    const [runner] = await connection.db
      .insert(runners)
      .values({
        userId,
        name: "Legacy Ready Cloud Runner",
        kind: "digitalocean",
        endpointUrl: "https://legacy-ready.example.com",
        status: "online",
        provider: "digitalocean",
        providerResourceId: "legacy-ready",
        region: "sfo3",
        sizeSlug: "s-1vcpu-512mb-10gb",
        image: "ubuntu-24-04-x64",
        provisioningStatus: "ready",
        provisioningStartedAt: new Date("2026-07-06T04:00:00.000Z"),
        provisioningCompletedAt: new Date("2026-07-06T04:01:00.000Z"),
      })
      .returning({ id: runners.id });

    if (!runner) throw new Error("Runner insert returned no rows.");

    await seedHeartbeat(connection, runner.id, {
      observedAt: new Date("2026-07-06T04:01:00.000Z"),
      metrics: { maxAgents: 1, runningAgents: 0 },
    });

    await expect(
      selectRunnerPlacementForUser(
        userId,
        {},
        {
          compatibilityRequirement: HOSTED_COMPATIBILITY_REQUIREMENT,
          createConnection: () => connection,
          now: () => new Date("2026-07-06T04:02:00.000Z"),
        },
      ),
    ).resolves.toEqual({ ok: false, reason: "no_online_runner" });
  });

  it("excludes but does not delete a manual runner with incompatible release evidence", async () => {
    const userId = await seedDevelopmentUser(connection);
    const [runner] = await connection.db
      .insert(runners)
      .values({
        userId,
        name: "Outdated Manual Runner",
        kind: "manual_vps",
        endpointUrl: "https://outdated-manual.example.com",
        status: "online",
        requiredRunnerImageDigest: RUNNER_IMAGE_DIGEST,
        observedRunnerImageDigest: RUNNER_IMAGE_DIGEST,
        observedRunnerReleaseVersion: "sha-old",
        observedRunnerBootContractVersion: "bruno.runner.boot.v0",
        compatibilityState: "outdated",
        compatibilityVerifiedAt: new Date("2026-07-06T04:01:00.000Z"),
      })
      .returning({ id: runners.id });

    if (!runner) throw new Error("Runner insert returned no rows.");

    await seedHeartbeat(connection, runner.id, {
      observedAt: new Date("2026-07-06T04:01:00.000Z"),
      metrics: { maxAgents: 1, runningAgents: 0 },
    });

    await expect(
      selectRunnerPlacementForUser(
        userId,
        {},
        {
          compatibilityRequirement: HOSTED_COMPATIBILITY_REQUIREMENT,
          createConnection: () => connection,
          now: () => new Date("2026-07-06T04:02:00.000Z"),
        },
      ),
    ).resolves.toEqual({ ok: false, reason: "no_online_runner" });

    const [persisted] = await connection.db
      .select({ status: runners.status, deletedAt: runners.deletedAt })
      .from(runners)
      .where(eq(runners.id, runner.id));
    expect(persisted).toEqual({ status: "online", deletedAt: null });
  });

  it("excludes online DigitalOcean runners until authenticated readiness is complete", async () => {
    const now = new Date("2026-07-06T04:02:00.000Z");
    const userId = await seedDevelopmentUser(connection);
    const [runner] = await connection.db
      .insert(runners)
      .values({
        userId,
        name: "Registering Cloud Runner",
        kind: "digitalocean",
        endpointUrl: "https://registering-runner.example.com",
        status: "online",
        provider: "digitalocean",
        providerResourceId: "droplet-registering",
        region: "sfo3",
        sizeSlug: "s-1vcpu-512mb-10gb",
        image: "ubuntu-24-04-x64",
        provisioningStatus: "waiting_for_runner",
        provisioningStartedAt: new Date("2026-07-06T04:00:00.000Z"),
      })
      .returning({ id: runners.id });

    if (!runner) {
      throw new Error("Runner insert returned no rows.");
    }

    await seedHeartbeat(connection, runner.id, {
      observedAt: new Date("2026-07-06T04:01:00.000Z"),
      metrics: { maxAgents: 1, runningAgents: 0 },
    });

    await expect(
      selectRunnerPlacementForUser(
        userId,
        {},
        { createConnection: () => connection, now: () => now },
      ),
    ).resolves.toEqual({ ok: false, reason: "no_online_runner" });
  });

  it("selects an online DigitalOcean runner only after it is ready", async () => {
    const now = new Date("2026-07-06T04:02:00.000Z");
    const userId = await seedDevelopmentUser(connection);
    const [runner] = await connection.db
      .insert(runners)
      .values({
        userId,
        name: "Ready Cloud Runner",
        kind: "digitalocean",
        endpointUrl: "https://ready-runner.example.com",
        status: "online",
        provider: "digitalocean",
        providerResourceId: "droplet-ready",
        region: "sfo3",
        sizeSlug: "s-1vcpu-512mb-10gb",
        image: "ubuntu-24-04-x64",
        provisioningStatus: "ready",
        provisioningStartedAt: new Date("2026-07-06T04:00:00.000Z"),
        provisioningCompletedAt: new Date("2026-07-06T04:01:00.000Z"),
        requiredRunnerImageDigest: RUNNER_IMAGE_DIGEST,
        observedRunnerImageDigest: RUNNER_IMAGE_DIGEST,
        observedRunnerReleaseVersion: "sha-current",
        observedRunnerBootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
        compatibilityState: "compatible",
        compatibilityVerifiedAt: new Date("2026-07-06T04:01:00.000Z"),
      })
      .returning({ id: runners.id });

    if (!runner) {
      throw new Error("Runner insert returned no rows.");
    }

    await seedHeartbeat(connection, runner.id, {
      observedAt: new Date("2026-07-06T04:01:00.000Z"),
      metrics: { maxAgents: 1, runningAgents: 0 },
    });

    await expect(
      selectRunnerPlacementForUser(
        userId,
        {},
        {
          compatibilityRequirement: HOSTED_COMPATIBILITY_REQUIREMENT,
          createConnection: () => connection,
          now: () => now,
        },
      ),
    ).resolves.toMatchObject({ ok: true, runner: { id: runner.id, kind: "digitalocean" } });
  });

  it("characterizes live provider verification as a required post-selection fence", async () => {
    const now = new Date("2026-07-06T04:02:00.000Z");
    const userId = await seedDevelopmentUser(connection);
    const [runner] = await connection.db
      .insert(runners)
      .values({
        userId,
        name: "Missing Provider Runner",
        kind: "digitalocean",
        endpointUrl: "https://missing-provider-runner.example.com",
        status: "online",
        provider: "digitalocean",
        providerResourceId: "missing-provider-resource",
        region: "sfo3",
        sizeSlug: "s-1vcpu-512mb-10gb",
        image: "ubuntu-24-04-x64",
        provisioningStatus: "ready",
        provisioningStartedAt: new Date("2026-07-06T04:00:00.000Z"),
        provisioningCompletedAt: new Date("2026-07-06T04:01:00.000Z"),
        requiredRunnerImageDigest: RUNNER_IMAGE_DIGEST,
        observedRunnerImageDigest: RUNNER_IMAGE_DIGEST,
        observedRunnerReleaseVersion: "sha-current",
        observedRunnerBootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
        compatibilityState: "compatible",
        compatibilityVerifiedAt: new Date("2026-07-06T04:01:00.000Z"),
      })
      .returning({ id: runners.id });

    if (!runner) {
      throw new Error("Runner insert returned no rows.");
    }

    await seedHeartbeat(connection, runner.id, {
      observedAt: new Date("2026-07-06T04:01:00.000Z"),
      metrics: { maxAgents: 1, runningAgents: 0 },
    });

    await expect(
      selectRunnerPlacementForUser(
        userId,
        {},
        {
          compatibilityRequirement: HOSTED_COMPATIBILITY_REQUIREMENT,
          createConnection: () => connection,
          now: () => now,
        },
      ),
    ).resolves.toMatchObject({ ok: true, runner: { id: runner.id } });

    await expect(
      verifyRunnerPlacementCandidate(
        connection,
        { runnerId: runner.id, userId },
        {
          now: () => now,
          compatibilityRequirement: HOSTED_COMPATIBILITY_REQUIREMENT,
          provider: new FakeDigitalOceanProvider(),
          readConfig: () => ({
            token: "fake-provider-token",
            runnerBearerToken: "fake-runner-token",
            runnerImage: "agentbay-runner:test",
            region: "sfo3",
            sizeSlug: "s-1vcpu-512mb-10gb",
            image: "ubuntu-24-04-x64",
            tags: ["agentbay"],
          }),
        },
      ),
    ).resolves.toEqual({
      ok: false,
      action: "reject_candidate",
      reason: "provider_resource_missing",
      transitioned: true,
    });

    const [persistedRunner] = await connection.db
      .select({ status: runners.status, deletedAt: runners.deletedAt })
      .from(runners)
      .where(eq(runners.id, runner.id));
    expect(persistedRunner).toEqual({ status: "deleted", deletedAt: now });
  });

  it("marks stale online runners offline before placement selection", async () => {
    const now = new Date("2026-07-06T04:03:00.000Z");
    const staleObservedAt = new Date(now.getTime() - RUNNER_HEARTBEAT_STALE_THRESHOLD_MS - 1);
    const userId = await seedDevelopmentUser(connection);
    const runner = await seedOnlineRunner(connection, userId, {
      name: "Stale Placement Runner",
      endpointUrl: "https://stale-placement-runner.example.com",
    });
    await seedHeartbeat(connection, runner.id, {
      observedAt: staleObservedAt,
      metrics: { maxAgents: 3, runningAgents: 0 },
    });

    const result = await selectRunnerPlacementForDevelopmentUser(
      {},
      { createConnection: () => connection, now: () => now },
    );
    const [persistedRunner] = await connection.db
      .select({ status: runners.status, updatedAt: runners.updatedAt })
      .from(runners)
      .where(eq(runners.id, runner.id))
      .limit(1);

    expect(result).toEqual({ ok: false, reason: "no_online_runner" });
    expect(persistedRunner).toEqual({
      status: "offline",
      updatedAt: now,
    });
  });

  it("rejects placement when the plan limit is reached before runner selection", async () => {
    const userId = await seedDevelopmentUser(connection);
    await seedOnlineRunner(connection, userId, {
      name: "Ignored Runner",
      endpointUrl: "https://ignored-runner.example.com",
    });
    await connection.db.insert(agents).values({
      userId,
      name: "Existing Plan Agent",
      templateKey: "research_agent",
      status: "stopped",
    });

    const result = await selectRunnerPlacementForDevelopmentUser(
      { planMaxAgents: 1 },
      { createConnection: () => connection },
    );

    expect(result).toEqual({
      ok: false,
      reason: "plan_limit_reached",
      currentAgents: 1,
      maxAgents: 1,
    });
  });

  it("normalizes heartbeat metrics into shared capacity fields for enforcement and UI", () => {
    expect(
      normalizeRunnerCapacitySnapshot(
        {
          metrics: {
            max_agents: 2,
            running_agents: 1,
            cpu_used_percent: 250,
            memory_used_mb: 128.5,
            memory_total_mb: 1024,
            disk_used_mb: -5,
            disk_total_mb: 50_000,
            rawToken: "must-not-copy",
          },
        },
        3,
      ),
    ).toEqual({
      max_agents: 1,
      running_agents: 3,
      cpu_used_percent: 100,
      memory_used_mb: 128.5,
      memory_total_mb: 1024,
      disk_used_mb: 0,
      disk_total_mb: 50_000,
    });
  });
});

async function seedDevelopmentUser(connection: DatabaseConnection): Promise<string> {
  const [user] = await connection.db.insert(users).values({}).returning({ id: users.id });

  if (!user) {
    throw new Error("User insert returned no rows.");
  }

  await connection.db.insert(appMetadata).values({
    key: DEVELOPMENT_USER_METADATA_KEY,
    value: user.id,
  });

  return user.id;
}

async function seedOnlineRunner(
  connection: DatabaseConnection,
  userId: string,
  input: {
    name: string;
    endpointUrl?: string;
    updatedAt?: Date;
  },
): Promise<{ id: string }> {
  const [runner] = await connection.db
    .insert(runners)
    .values({
      userId,
      name: input.name,
      kind: "manual_vps",
      endpointUrl: input.endpointUrl ?? "https://available-runner.example.com",
      status: "online",
      updatedAt: input.updatedAt,
    })
    .returning({ id: runners.id });

  if (!runner) {
    throw new Error("Runner insert returned no rows.");
  }

  return runner;
}

async function seedHeartbeat(
  connection: DatabaseConnection,
  runnerId: string,
  input: {
    observedAt: Date;
    metrics: Record<string, unknown>;
  },
): Promise<void> {
  await connection.db.insert(runnerHeartbeats).values({
    runnerId,
    status: "online",
    metadata: {
      metrics: input.metrics,
    },
    observedAt: input.observedAt,
    createdAt: input.observedAt,
  });
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table runner_provisioning_events, runner_heartbeats, runner_credentials, runner_registration_tokens, agent_approvals, agent_configs, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runners, app_metadata, users restart identity cascade`;
}
