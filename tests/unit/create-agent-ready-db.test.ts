import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSecretKeyringError } from "@/src/server/agents/agent-secrets";
import { listModelConnectionsForUser } from "@/src/server/agents/model-connections";
import {
  AgentPersistenceError,
  AgentCreateBlockedError,
  AgentRunnerAssignmentError,
  AgentRunnerProvisioningError,
  type ReadyCreateInsertBoundary,
  TelegramBotInUseError,
  createAgentForUser,
} from "@/src/server/agents/create-agent";
import { reconcileTargetAgentDeployment } from "@/src/server/agents/agent-deployment-reconciler";
import { retryAgentDeploymentForUser } from "@/src/server/agents/agent-deployment-retry";
import {
  deleteAgentForUser,
  startAgentForUser,
  stopAgentForUser,
} from "@/src/server/agents/lifecycle";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentConfigs,
  agentDeployments,
  agentEvents,
  agentRuntimeReconciliations,
  agentSecrets,
  agentUsagePeriods,
  agents,
  runnerCredentials,
  runnerHeartbeats,
  runnerReplacements,
  runners,
  users,
} from "@/src/server/db/schema";
import type { DigitalOceanProviderConfig } from "@/src/server/env";
import { RUNNER_BOOT_CONTRACT_VERSION } from "@/src/runner-service/constants";
import { FakeDigitalOceanProvider } from "@/src/server/runners/digitalocean-provider";
import { reconcileNextRunnerReplacement } from "@/src/server/runners/runner-replacement-reconciler";
import type { RunnerAdapter } from "@/src/server/runners/local-runner-adapter";
import type { LocalRunnerProcessDto } from "@/src/server/runners/local-runner-state";

const USER_A_ID = "00000000-0000-4000-8000-000000000401";
const USER_B_ID = "00000000-0000-4000-8000-000000000402";
const FOREIGN_RUNNER_ID = "00000000-0000-4000-8000-000000000403";
const NOW = new Date("2026-08-03T06:00:00.000Z");
const TOKEN = "123456:abcdefghijklmnopqrstuvwxyz";
const SECOND_TOKEN = "654321:abcdefghijklmnopqrstuvwxyz";
const THIRD_TOKEN = "777777:abcdefghijklmnopqrstuvwxyz";
const OPENAI_KEY_FIXTURE = ["sk", "fixture", "abcdefghijklmnopqrstuvwxyz1234567890"].join("-");
const RUNNER_IMAGE = `ghcr.io/ametel01/agentbay-runner:${"a".repeat(40)}@sha256:${"b".repeat(64)}`;
const LOCAL_TWO_AGENT_CAPACITY = {
  configuredMaxAgents: 2,
  measuredMaxAgents: 2,
  perHermesDiskGiB: 10,
  hostDiskReserveGiB: 10,
  profile: { vcpus: 2, memoryMiB: 4096, diskGiB: 80 },
} as const;
const KEYRING_ENV = {
  AGENTBAY_READY_AGENT_CREATION_ENABLED: "true",
  AGENTBAY_DIGITALOCEAN_TOKEN: "provider-token-present",
  AGENTBAY_RUNNER_BEARER_TOKEN: "runner-token-present",
  AGENTBAY_RUNNER_IMAGE: RUNNER_IMAGE,
  AGENTBAY_DIGITALOCEAN_SIZE_SLUG: "s-1vcpu-2gb",
  AGENTBAY_AGENT_SECRET_ACTIVE_KEY_VERSION: "v1",
  AGENTBAY_AGENT_SECRET_KEYS_JSON: JSON.stringify({
    v1: Buffer.alloc(32, 41).toString("base64url"),
    old: Buffer.alloc(32, 42).toString("base64url"),
  }),
};

describe("ready agent creation persistence", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetReadyCreateTables(connection);
    await seedReadyCreateUsers(connection);
  });

  afterEach(async () => {
    await resetReadyCreateTables(connection);
    await connection.close();
  });

  it("atomically creates a stopped desired-running agent, config, four secrets, deployment, and safe event", async () => {
    const result = await createAgentForUser(USER_A_ID, readyInput("ready-key-001"), {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: telegramValidator(),
    });

    expect("deployment" in result ? result.deployment.stage : null).toBe("pending");
    expect(result).toMatchObject({
      agent: {
        userId: USER_A_ID,
        status: "stopped",
        desiredStatus: "running",
        assistant: { id: "chatgpt", displayName: "ChatGPT" },
        telegramBot: { id: "123456", username: "Valid_bot" },
      },
    });
    expect(JSON.stringify(result)).not.toContain(OPENAI_KEY_FIXTURE);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("agb_agent_");

    const [agent] = await connection.db.select().from(agents);
    const [config] = await connection.db.select().from(agentConfigs);
    const secrets = await connection.db.select().from(agentSecrets);
    const [deployment] = await connection.db.select().from(agentDeployments);
    const [event] = await connection.db.select().from(agentEvents);

    expect(agent).toMatchObject({
      userId: USER_A_ID,
      status: "stopped",
      desiredStatus: "running",
      runnerId: null,
    });
    expect(config).toMatchObject({
      modelProvider: "openai-api",
      modelName: "gpt-5.4",
      systemPrompt: getAgentTemplateSnapshot("research_agent").defaultSystemPrompt,
    });
    expect(secrets).toHaveLength(4);
    expect(secrets.map((secret) => secret.kind).sort()).toEqual([
      "api_server_key",
      "openai_api_key",
      "telegram_allowed_users",
      "telegram_bot_token",
    ]);
    expect(new Set(secrets.map((secret) => secret.iv)).size).toBe(4);
    expect(secrets.find((secret) => secret.kind === "telegram_bot_token")).toMatchObject({
      uniquenessFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      providerSubjectId: "123456",
      providerUsername: "Valid_bot",
    });
    expect(deployment).toMatchObject({
      userId: USER_A_ID,
      agentId: agent?.id,
      idempotencyKey: "ready-key-001",
      configRevision: `cfg-${NOW.getTime()}`,
      stage: "pending",
      attemptCount: 0,
    });
    expect(event).toMatchObject({
      actorUserId: USER_A_ID,
      type: "agent.created",
      metadata: {
        templateKey: "research_agent",
        templateVersion: "1.0.0",
        status: "stopped",
        desiredStatus: "running",
        launchMode: "ready",
        assistant: "chatgpt",
        runnerAssignment: "none",
        deploymentId: deployment?.id,
      },
    });
    expect(JSON.stringify(event?.metadata)).not.toContain("123456");
    expect(JSON.stringify(event?.metadata)).not.toContain("ready-key-001");
  });

  it("rejects creation before persistence when no runner can be provisioned safely", async () => {
    const validator = telegramValidator();

    await expect(
      createAgentForUser(USER_A_ID, readyInput("ready-key-provider-missing"), {
        createConnection: () => connection,
        env: {
          ...KEYRING_ENV,
          AGENTBAY_DIGITALOCEAN_TOKEN: undefined,
          AGENTBAY_RUNNER_BEARER_TOKEN: undefined,
          AGENTBAY_RUNNER_IMAGE: undefined,
        },
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: validator,
      }),
    ).rejects.toMatchObject({
      name: AgentRunnerProvisioningError.name,
      reason: "provider_not_configured",
    });

    expect(validator).not.toHaveBeenCalled();
    await expect(countRows(connection, "agents")).resolves.toBe(0);
    await expect(countRows(connection, "agent_deployments")).resolves.toBe(0);
  });

  it("uses an available runner without requiring new Droplet provisioning configuration", async () => {
    const runnerId = "00000000-0000-4000-8000-000000000405";
    await seedOnlineRunner(connection, { runnerId, userId: USER_A_ID });

    const result = await createAgentForUser(USER_A_ID, readyInput("ready-key-existing-runner"), {
      createConnection: () => connection,
      env: {
        ...KEYRING_ENV,
        AGENTBAY_DIGITALOCEAN_TOKEN: undefined,
        AGENTBAY_RUNNER_BEARER_TOKEN: undefined,
        AGENTBAY_RUNNER_IMAGE: undefined,
      },
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: telegramValidator(),
    });

    expect(result.agent.runnerId).toBe(runnerId);
  });

  it("falls back to an unassigned cold-path ready deployment when implicit reuse capacity is exhausted", async () => {
    const runnerId = "00000000-0000-4000-8000-000000000406";
    await seedOnlineRunner(connection, { runnerId, userId: USER_A_ID });
    const first = await createAgentForUser(USER_A_ID, readyInput("ready-capacity-first"), {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: telegramValidator(),
    });

    const second = await createAgentForUser(
      USER_A_ID,
      readyInput("ready-capacity-second", { token: SECOND_TOKEN }),
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => new Date(NOW.getTime() + 1_000),
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator("654321"),
      },
    );

    expect(first.agent.runnerId).toBe(runnerId);
    expect(second.agent.runnerId).toBeNull();
    const assignedReservations = await connection.db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.runnerId, runnerId));
    expect(assignedReservations).toHaveLength(1);
  });

  it("serializes concurrent implicit ready creates so one reserves capacity and one stays unassigned", async () => {
    const runnerId = "00000000-0000-4000-8000-000000000408";
    await seedOnlineRunner(connection, { runnerId, userId: USER_A_ID });
    const firstConnection = createDatabaseConnection();
    const secondConnection = createDatabaseConnection();
    const observerConnection = createDatabaseConnection();
    const releaseFirstLock = createDeferred<void>();
    const firstLockAcquired = createDeferred<void>();
    const secondReachedLockBoundary = createDeferred<void>();
    const capacityLockAttempts: Array<{ label: string; runnerId: string; userId: string }> = [];
    const capacityLockAcquired: Array<{ label: string; runnerId: string; userId: string }> = [];
    const pending: Promise<unknown>[] = [];

    try {
      const firstCreate = createAgentForUser(USER_A_ID, readyInput("ready-race-first"), {
        createConnection: () => firstConnection,
        env: KEYRING_ENV,
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator("123456"),
        readyCreateTestHooks: {
          beforeCapacityLock: (input) => {
            capacityLockAttempts.push({ label: "first", ...input });
          },
          afterCapacityLock: async (input) => {
            capacityLockAcquired.push({ label: "first", ...input });
            firstLockAcquired.resolve();
            await releaseFirstLock.promise;
          },
        },
      });
      pending.push(firstCreate);
      await firstLockAcquired.promise;

      const secondCreate = createAgentForUser(
        USER_A_ID,
        readyInput("ready-race-second", { token: SECOND_TOKEN }),
        {
          createConnection: () => secondConnection,
          env: KEYRING_ENV,
          now: () => new Date(NOW.getTime() + 1_000),
          randomBytes: incrementalRandomBytes(),
          telegramBotValidator: telegramValidator("654321"),
          readyCreateTestHooks: {
            beforeCapacityLock: async (input) => {
              capacityLockAttempts.push({ label: "second", ...input });
              secondReachedLockBoundary.resolve();
            },
            afterCapacityLock: (input) => {
              capacityLockAcquired.push({ label: "second", ...input });
            },
          },
        },
      );
      pending.push(secondCreate);
      await secondReachedLockBoundary.promise;
      await waitForBlockedDatabaseSessions(observerConnection, 1, "capacity-one ready create");
      expect(capacityLockAcquired.map((attempt) => attempt.label)).toEqual(["first"]);
      releaseFirstLock.resolve();

      const results = await Promise.all([firstCreate, secondCreate]);
      expect(results.map((result) => result.agent.runnerId).sort()).toEqual(
        [runnerId, null].sort(),
      );
      expect(capacityLockAttempts).toEqual([
        { label: "first", runnerId, userId: USER_A_ID },
        { label: "second", runnerId, userId: USER_A_ID },
      ]);
      expect(capacityLockAcquired).toEqual([
        { label: "first", runnerId, userId: USER_A_ID },
        { label: "second", runnerId, userId: USER_A_ID },
      ]);
      const assignedReservations = await connection.db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.runnerId, runnerId));
      expect(assignedReservations).toHaveLength(1);
    } finally {
      releaseFirstLock.resolve();
      await Promise.allSettled(pending);
      await firstConnection.close();
      await secondConnection.close();
      await observerConnection.close();
    }
  }, 15_000);

  it("allows exactly two concurrent ready creates on an injected local two-agent profile", async () => {
    const runnerId = "00000000-0000-4000-8000-000000000409";
    await seedOnlineRunner(connection, { runnerId, userId: USER_A_ID });
    const firstConnection = createDatabaseConnection();
    const secondConnection = createDatabaseConnection();
    const thirdConnection = createDatabaseConnection();
    const observerConnection = createDatabaseConnection();
    const releaseFirstLock = createDeferred<void>();
    const firstLockAcquired = createDeferred<void>();
    const secondReachedLockBoundary = createDeferred<void>();
    const thirdReachedLockBoundary = createDeferred<void>();
    const capacityLockAttempts: Array<{ label: string; runnerId: string; userId: string }> = [];
    const capacityLockAcquired: Array<{ label: string; runnerId: string; userId: string }> = [];
    const pending: Promise<unknown>[] = [];

    try {
      const firstCreate = createAgentForUser(USER_A_ID, readyInput("ready-capacity-two-a"), {
        createConnection: () => firstConnection,
        env: KEYRING_ENV,
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator("123456"),
        runnerPlacementCapacityOptions: LOCAL_TWO_AGENT_CAPACITY,
        readyCreateTestHooks: {
          beforeCapacityLock: (input) => {
            capacityLockAttempts.push({ label: "first", ...input });
          },
          afterCapacityLock: async (input) => {
            capacityLockAcquired.push({ label: "first", ...input });
            firstLockAcquired.resolve();
            await releaseFirstLock.promise;
          },
        },
      });
      pending.push(firstCreate);
      await firstLockAcquired.promise;
      const secondCreate = createAgentForUser(
        USER_A_ID,
        readyInput("ready-capacity-two-b", { token: SECOND_TOKEN }),
        {
          createConnection: () => secondConnection,
          env: KEYRING_ENV,
          now: () => new Date(NOW.getTime() + 1_000),
          randomBytes: incrementalRandomBytes(),
          telegramBotValidator: telegramValidator("654321"),
          runnerPlacementCapacityOptions: LOCAL_TWO_AGENT_CAPACITY,
          readyCreateTestHooks: {
            beforeCapacityLock: async (input) => {
              capacityLockAttempts.push({ label: "second", ...input });
              secondReachedLockBoundary.resolve();
            },
            afterCapacityLock: (input) => {
              capacityLockAcquired.push({ label: "second", ...input });
            },
          },
        },
      );
      pending.push(secondCreate);
      const thirdCreate = createAgentForUser(
        USER_A_ID,
        readyInput("ready-capacity-two-c", { token: THIRD_TOKEN }),
        {
          createConnection: () => thirdConnection,
          env: KEYRING_ENV,
          now: () => new Date(NOW.getTime() + 2_000),
          randomBytes: incrementalRandomBytes(),
          telegramBotValidator: telegramValidator("777777"),
          runnerPlacementCapacityOptions: LOCAL_TWO_AGENT_CAPACITY,
          readyCreateTestHooks: {
            beforeCapacityLock: async (input) => {
              capacityLockAttempts.push({ label: "third", ...input });
              thirdReachedLockBoundary.resolve();
            },
            afterCapacityLock: (input) => {
              capacityLockAcquired.push({ label: "third", ...input });
            },
          },
        },
      );
      pending.push(thirdCreate);
      await Promise.all([secondReachedLockBoundary.promise, thirdReachedLockBoundary.promise]);
      await waitForBlockedDatabaseSessions(observerConnection, 2, "capacity-two ready creates");
      expect(capacityLockAcquired.map((attempt) => attempt.label)).toEqual(["first"]);
      releaseFirstLock.resolve();

      const results = await Promise.all([firstCreate, secondCreate, thirdCreate]);
      const runnerIds = results.map((result) => result.agent.runnerId);
      const reservations = await connection.db
        .select({ id: agents.id, desiredStatus: agents.desiredStatus })
        .from(agents)
        .where(eq(agents.runnerId, runnerId));

      expect(runnerIds.filter((id) => id === runnerId)).toHaveLength(2);
      expect(runnerIds.filter((id) => id === null)).toHaveLength(1);
      expect(capacityLockAttempts).toHaveLength(3);
      expect(capacityLockAttempts).toEqual(
        expect.arrayContaining([
          { label: "first", runnerId, userId: USER_A_ID },
          { label: "second", runnerId, userId: USER_A_ID },
          { label: "third", runnerId, userId: USER_A_ID },
        ]),
      );
      expect(capacityLockAcquired).toHaveLength(3);
      expect(capacityLockAcquired[0]).toEqual({ label: "first", runnerId, userId: USER_A_ID });
      expect(capacityLockAcquired).toEqual(
        expect.arrayContaining([
          { label: "second", runnerId, userId: USER_A_ID },
          { label: "third", runnerId, userId: USER_A_ID },
        ]),
      );
      expect(reservations).toHaveLength(2);
      expect(reservations.every((reservation) => reservation.desiredStatus === "running")).toBe(
        true,
      );
    } finally {
      releaseFirstLock.resolve();
      await Promise.allSettled(pending);
      await firstConnection.close();
      await secondConnection.close();
      await thirdConnection.close();
      await observerConnection.close();
    }
  }, 15_000);

  it("keeps simultaneous cross-user ready creates isolated to each owner's spare runner", async () => {
    const userARunnerId = "00000000-0000-4000-8000-000000000415";
    const userBRunnerId = "00000000-0000-4000-8000-000000000515";
    await seedOnlineRunner(connection, { runnerId: userARunnerId, userId: USER_A_ID });
    await seedOnlineRunner(connection, { runnerId: userBRunnerId, userId: USER_B_ID });
    const userAConnection = createDatabaseConnection();
    const userBConnection = createDatabaseConnection();
    const observerConnection = createDatabaseConnection();
    const releaseCapacityLocks = createDeferred<void>();
    const userALockAcquired = createDeferred<void>();
    const userBLockAcquired = createDeferred<void>();
    const capacityLockAttempts: Array<{ label: string; runnerId: string; userId: string }> = [];
    const capacityLocksAcquired: Array<{ label: string; runnerId: string; userId: string }> = [];
    const pending: Promise<unknown>[] = [];

    try {
      const userACreate = createAgentForUser(
        USER_A_ID,
        readyInput("ready-cross-user-a", { token: TOKEN }),
        {
          createConnection: () => userAConnection,
          env: KEYRING_ENV,
          now: () => NOW,
          randomBytes: incrementalRandomBytes(),
          telegramBotValidator: telegramValidator("123456"),
          readyCreateTestHooks: {
            beforeCapacityLock: (input) => {
              capacityLockAttempts.push({ label: "user-a", ...input });
            },
            afterCapacityLock: async (input) => {
              capacityLocksAcquired.push({ label: "user-a", ...input });
              userALockAcquired.resolve();
              await releaseCapacityLocks.promise;
            },
          },
        },
      );
      pending.push(userACreate);
      const userBCreate = createAgentForUser(
        USER_B_ID,
        readyInput("ready-cross-user-b", { token: SECOND_TOKEN }),
        {
          createConnection: () => userBConnection,
          env: KEYRING_ENV,
          now: () => new Date(NOW.getTime() + 1_000),
          randomBytes: incrementalRandomBytes(),
          telegramBotValidator: telegramValidator("654321"),
          readyCreateTestHooks: {
            beforeCapacityLock: (input) => {
              capacityLockAttempts.push({ label: "user-b", ...input });
            },
            afterCapacityLock: async (input) => {
              capacityLocksAcquired.push({ label: "user-b", ...input });
              userBLockAcquired.resolve();
              await releaseCapacityLocks.promise;
            },
          },
        },
      );
      pending.push(userBCreate);

      await Promise.all([userALockAcquired.promise, userBLockAcquired.promise]);
      expect(await countBlockedDatabaseSessions(observerConnection)).toBe(0);
      expect(capacityLockAttempts).toHaveLength(2);
      expect(capacityLockAttempts).toEqual(
        expect.arrayContaining([
          { label: "user-a", runnerId: userARunnerId, userId: USER_A_ID },
          { label: "user-b", runnerId: userBRunnerId, userId: USER_B_ID },
        ]),
      );
      expect(capacityLocksAcquired).toHaveLength(2);
      expect(capacityLocksAcquired).toEqual(
        expect.arrayContaining([
          { label: "user-a", runnerId: userARunnerId, userId: USER_A_ID },
          { label: "user-b", runnerId: userBRunnerId, userId: USER_B_ID },
        ]),
      );
      expect(
        [...capacityLockAttempts, ...capacityLocksAcquired].some(
          ({ runnerId, userId }) =>
            (userId === USER_A_ID && runnerId === userBRunnerId) ||
            (userId === USER_B_ID && runnerId === userARunnerId),
        ),
      ).toBe(false);
      releaseCapacityLocks.resolve();

      const [userAResult, userBResult] = await Promise.all([userACreate, userBCreate]);
      const durableAssignments = await connection.db
        .select({
          id: agents.id,
          userId: agents.userId,
          runnerId: agents.runnerId,
          desiredStatus: agents.desiredStatus,
          deletedAt: agents.deletedAt,
        })
        .from(agents);
      const durableRunnerOwners = await connection.db
        .select({ id: runners.id, userId: runners.userId })
        .from(runners);

      expect(userAResult.agent).toMatchObject({ userId: USER_A_ID, runnerId: userARunnerId });
      expect(userBResult.agent).toMatchObject({ userId: USER_B_ID, runnerId: userBRunnerId });
      expect(durableAssignments).toHaveLength(2);
      expect(durableAssignments).toEqual(
        expect.arrayContaining([
          {
            id: userAResult.agent.id,
            userId: USER_A_ID,
            runnerId: userARunnerId,
            desiredStatus: "running",
            deletedAt: null,
          },
          {
            id: userBResult.agent.id,
            userId: USER_B_ID,
            runnerId: userBRunnerId,
            desiredStatus: "running",
            deletedAt: null,
          },
        ]),
      );
      expect(durableAssignments.filter(({ runnerId }) => runnerId === userARunnerId)).toHaveLength(
        1,
      );
      expect(durableAssignments.filter(({ runnerId }) => runnerId === userBRunnerId)).toHaveLength(
        1,
      );
      expect(durableRunnerOwners).toHaveLength(2);
      expect(durableRunnerOwners).toEqual(
        expect.arrayContaining([
          { id: userARunnerId, userId: USER_A_ID },
          { id: userBRunnerId, userId: USER_B_ID },
        ]),
      );
      expect(
        durableAssignments.some(
          ({ runnerId, userId }) =>
            (userId === USER_A_ID && runnerId === userBRunnerId) ||
            (userId === USER_B_ID && runnerId === userARunnerId),
        ),
      ).toBe(false);
    } finally {
      releaseCapacityLocks.resolve();
      await Promise.allSettled(pending);
      await userAConnection.close();
      await userBConnection.close();
      await observerConnection.close();
    }
  }, 15_000);

  it("rolls back a held ready create before a blocked lifecycle Start reserves capacity", async () => {
    const runnerId = "00000000-0000-4000-8000-000000000410";
    await seedOnlineRunner(connection, { runnerId, userId: USER_A_ID });
    const createConnection = createDatabaseConnection();
    const startConnection = createDatabaseConnection();
    const observerConnection = createDatabaseConnection();
    const starterId = "00000000-0000-4000-8000-000000000510";
    const calls: string[] = [];
    const releaseCreateLock = createDeferred<void>();
    const createLockAcquired = createDeferred<void>();
    const startReachedLockBoundary = createDeferred<void>();
    const createLocks: Array<{ runnerId: string; userId: string }> = [];
    const startLockAttempts: Array<{ runnerId: string; userId: string }> = [];
    const startLocks: Array<{ runnerId: string; userId: string }> = [];
    const pending: Promise<unknown>[] = [];
    await seedAssignedAgent(connection, {
      id: starterId,
      runnerId,
      status: "stopped",
      desiredStatus: "stopped",
      name: "Start race capacity consumer",
    });

    try {
      const create = createAgentForUser(USER_A_ID, readyInput("ready-start-race"), {
        createConnection: () => createConnection,
        env: KEYRING_ENV,
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator(),
        readyCreateTestHooks: {
          afterCapacityLock: async (input) => {
            createLocks.push(input);
            createLockAcquired.resolve();
            await releaseCreateLock.promise;
          },
          beforeInsertBoundary: (boundary) => {
            if (boundary === "config") {
              throw new Error("Forced ready-create rollback after capacity lock.");
            }
          },
        },
      });
      pending.push(create);
      await createLockAcquired.promise;

      const start = startAgentForUser(USER_A_ID, starterId, {
        createConnection: () => startConnection,
        now: () => NOW,
        manualRunnerAdapter: () => createManualLifecycleRunnerStub(calls),
        runnerCapacityTestHooks: {
          beforeCapacityLock: (input) => {
            startLockAttempts.push(input);
            startReachedLockBoundary.resolve();
          },
          afterCapacityLock: (input) => {
            startLocks.push(input);
          },
        },
      });
      pending.push(start);
      await startReachedLockBoundary.promise;
      await waitForBlockedDatabaseSessions(observerConnection, 1, "ready create versus Start");
      expect(startLocks).toEqual([]);
      releaseCreateLock.resolve();

      const [createResult, startResult] = await Promise.allSettled([create, start]);
      expect(createResult.status).toBe("rejected");
      if (createResult.status === "rejected") {
        expect(createResult.reason).toBeInstanceOf(AgentPersistenceError);
      }
      expect(startResult).toMatchObject({
        status: "fulfilled",
        value: expect.objectContaining({
          ok: true,
          agent: expect.objectContaining({ status: "running" }),
        }),
      });
      const reservations = await connection.db
        .select({ id: agents.id, status: agents.status, desiredStatus: agents.desiredStatus })
        .from(agents)
        .where(eq(agents.runnerId, runnerId));

      expect(reservations).toEqual([
        { id: starterId, status: "running", desiredStatus: "running" },
      ]);
      expect(calls).toEqual([`start:${starterId}`]);
      expect(createLocks).toEqual([{ runnerId, userId: USER_A_ID }]);
      expect(startLockAttempts).toEqual([{ runnerId, userId: USER_A_ID }]);
      expect(startLocks).toEqual([{ runnerId, userId: USER_A_ID }]);
    } finally {
      releaseCreateLock.resolve();
      await Promise.allSettled(pending);
      await createConnection.close();
      await startConnection.close();
      await observerConnection.close();
    }
  }, 15_000);

  it("leaves ready create unassigned when deployment retry placement consumes capacity before the lock", async () => {
    const runnerId = "00000000-0000-4000-8000-000000000411";
    await seedOnlineRunner(connection, { runnerId, userId: USER_A_ID });
    const createConnection = createDatabaseConnection();
    const mutationConnection = createDatabaseConnection();
    const retryAgentId = "00000000-0000-4000-8000-000000000511";
    const allowCreateLock = createDeferred<void>();
    const createReachedLockBoundary = createDeferred<void>();
    const createLockAttempts: Array<{ runnerId: string; userId: string }> = [];
    const createLocks: Array<{ runnerId: string; userId: string }> = [];
    const pending: Promise<unknown>[] = [];
    await seedRetryableUnassignedAgent(connection, retryAgentId);

    try {
      const create = createAgentForUser(USER_A_ID, readyInput("ready-retry-race"), {
        createConnection: () => createConnection,
        env: KEYRING_ENV,
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator(),
        readyCreateTestHooks: {
          beforeCapacityLock: async (input) => {
            createLockAttempts.push(input);
            createReachedLockBoundary.resolve();
            await allowCreateLock.promise;
          },
          afterCapacityLock: (input) => {
            createLocks.push(input);
          },
        },
      });
      pending.push(create);
      await createReachedLockBoundary.promise;

      const retry = await retryAgentDeploymentForUser({
        userId: USER_A_ID,
        agentId: retryAgentId,
        idempotencyKey: "retry-race-deployment",
        dependencies: { createConnection: () => mutationConnection, now: () => NOW },
      });
      expect(retry.ok).toBe(true);
      if (!retry.ok) throw new Error("Expected retry workflow to create a deployment.");
      await expect(
        reconcileTargetAgentDeployment(retry.deployment.id, {
          createConnection: () => mutationConnection,
          now: () => NOW,
        }),
      ).resolves.toEqual({ processed: 1, outcome: "advanced" });
      allowCreateLock.resolve();

      const result = await create;
      const reservations = await connection.db
        .select({ id: agents.id, desiredStatus: agents.desiredStatus })
        .from(agents)
        .where(eq(agents.runnerId, runnerId));
      const [retryAgent] = await connection.db
        .select({ runnerId: agents.runnerId, desiredStatus: agents.desiredStatus })
        .from(agents)
        .where(eq(agents.id, retryAgentId));

      expect(result.agent.runnerId).toBeNull();
      expect(retryAgent).toEqual({ runnerId, desiredStatus: "running" });
      expect(reservations).toHaveLength(1);
      expect(createLockAttempts).toEqual([{ runnerId, userId: USER_A_ID }]);
      expect(createLocks).toEqual([{ runnerId, userId: USER_A_ID }]);
    } finally {
      allowCreateLock.resolve();
      await Promise.allSettled(pending);
      await createConnection.close();
      await mutationConnection.close();
    }
  });

  it("rolls replacement handover back atomically when a blocked ready create wins capacity", async () => {
    const targetRunnerId = "00000000-0000-4000-8000-000000000412";
    const sourceRunnerId = "00000000-0000-4000-8000-000000000512";
    const movingAgentId = "00000000-0000-4000-8000-000000000612";
    const replacementId = "00000000-0000-4000-8000-000000000712";
    const previousRunnerImage = process.env.AGENTBAY_RUNNER_IMAGE;
    process.env.AGENTBAY_RUNNER_IMAGE = RUNNER_IMAGE;
    await seedReplacementHandoverRace(connection, {
      sourceRunnerId,
      targetRunnerId,
      movingAgentId,
      replacementId,
    });
    const createConnection = createDatabaseConnection();
    const mutationConnection = createDatabaseConnection();
    const observerConnection = createDatabaseConnection();
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });
    const releaseCreateLock = createDeferred<void>();
    const createLockAcquired = createDeferred<void>();
    const createLocks: Array<{ runnerId: string; userId: string }> = [];
    const pending: Promise<unknown>[] = [];

    try {
      const create = createAgentForUser(USER_A_ID, readyInput("ready-replacement-race"), {
        createConnection: () => createConnection,
        env: KEYRING_ENV,
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator(),
        readyCreateTestHooks: {
          afterCapacityLock: async (input) => {
            createLocks.push(input);
            createLockAcquired.resolve();
            await releaseCreateLock.promise;
          },
        },
      });
      pending.push(create);
      await createLockAcquired.promise;

      const replacement = reconcileNextRunnerReplacement({
        replacementId,
        leaseOwner: "runner-replacement:00000000-0000-4000-8000-000000000812",
        dependencies: {
          createConnection: () => mutationConnection,
          now: () => NOW,
          provider,
          readConfig: () => replacementRaceProviderConfig(),
          retryMs: 0,
        },
      });
      pending.push(replacement);
      await waitForBlockedDatabaseSessions(
        observerConnection,
        1,
        "ready create versus replacement",
      );
      releaseCreateLock.resolve();

      const [result, replacementResult] = await Promise.all([create, replacement]);
      const reservations = await connection.db
        .select({ id: agents.id, runnerId: agents.runnerId, desiredStatus: agents.desiredStatus })
        .from(agents)
        .where(eq(agents.runnerId, targetRunnerId));
      const [movingAgent] = await connection.db
        .select({ runnerId: agents.runnerId, desiredStatus: agents.desiredStatus })
        .from(agents)
        .where(eq(agents.id, movingAgentId));
      const [workflow] = await connection.db
        .select({ state: runnerReplacements.state, terminalCode: runnerReplacements.terminalCode })
        .from(runnerReplacements)
        .where(eq(runnerReplacements.id, replacementId));
      const replacementDeployments = await connection.db
        .select({ id: agentDeployments.id })
        .from(agentDeployments)
        .where(eq(agentDeployments.agentId, movingAgentId));
      const reassignedEvents = await connection.db
        .select({ id: agentEvents.id })
        .from(agentEvents)
        .where(eq(agentEvents.type, "agent.runner_reassigned"));

      expect(result.agent.runnerId).toBe(targetRunnerId);
      expect(replacementResult).toMatchObject({ outcome: "failed", state: "failed" });
      expect(reservations).toEqual([
        { id: result.agent.id, runnerId: targetRunnerId, desiredStatus: "running" },
      ]);
      expect(movingAgent).toEqual({ runnerId: sourceRunnerId, desiredStatus: "running" });
      expect(workflow).toEqual({ state: "failed", terminalCode: "reassignment_failed" });
      expect(replacementDeployments).toHaveLength(1);
      expect(reassignedEvents).toHaveLength(0);
      expect(createLocks).toEqual([{ runnerId: targetRunnerId, userId: USER_A_ID }]);
    } finally {
      releaseCreateLock.resolve();
      await Promise.allSettled(pending);
      if (previousRunnerImage === undefined) {
        delete process.env.AGENTBAY_RUNNER_IMAGE;
      } else {
        process.env.AGENTBAY_RUNNER_IMAGE = previousRunnerImage;
      }
      await createConnection.close();
      await mutationConnection.close();
      await observerConnection.close();
    }
  }, 15_000);

  it.each([
    "stop",
    "delete",
  ] as const)("does not resurrect capacity released by the real %s workflow during ready create", async (releaseSource) => {
    const runnerId = `00000000-0000-4000-8000-0000000004${releaseSource === "stop" ? "13" : "14"}`;
    await seedOnlineRunner(connection, { runnerId, userId: USER_A_ID });
    const createConnection = createDatabaseConnection();
    const mutationConnection = createDatabaseConnection();
    const blockerId = `00000000-0000-4000-8000-0000000005${releaseSource === "stop" ? "13" : "14"}`;
    const calls: string[] = [];
    const releaseCreateLock = createDeferred<void>();
    const createLockAcquired = createDeferred<void>();
    const createLocks: Array<{ runnerId: string; userId: string }> = [];
    const pending: Promise<unknown>[] = [];
    await seedAssignedAgent(connection, {
      id: blockerId,
      runnerId,
      status: "running",
      desiredStatus: "running",
      name: `${releaseSource} release capacity consumer`,
    });

    try {
      const create = createAgentForUser(USER_A_ID, readyInput(`ready-${releaseSource}-release`), {
        createConnection: () => createConnection,
        env: KEYRING_ENV,
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator(),
        runnerPlacementCapacityOptions: LOCAL_TWO_AGENT_CAPACITY,
        readyCreateTestHooks: {
          afterCapacityLock: async (input) => {
            createLocks.push(input);
            createLockAcquired.resolve();
            await releaseCreateLock.promise;
          },
        },
      });
      pending.push(create);
      await createLockAcquired.promise;

      const released =
        releaseSource === "stop"
          ? await stopAgentForUser(USER_A_ID, blockerId, {
              createConnection: () => mutationConnection,
              now: () => NOW,
              manualRunnerAdapter: () => createManualLifecycleRunnerStub(calls),
            })
          : await deleteAgentForUser(USER_A_ID, blockerId, {
              createConnection: () => mutationConnection,
              now: () => NOW,
              manualRunnerAdapter: () => createManualLifecycleRunnerStub(calls),
            });
      expect(released).toMatchObject({ ok: true });
      const [releasedBeforeCreateCommit] = await connection.db
        .select({ desiredStatus: agents.desiredStatus, deletedAt: agents.deletedAt })
        .from(agents)
        .where(eq(agents.id, blockerId));
      expect(releasedBeforeCreateCommit).toMatchObject(
        releaseSource === "stop"
          ? { desiredStatus: "stopped", deletedAt: null }
          : { deletedAt: NOW },
      );
      releaseCreateLock.resolve();

      const result = await create;
      const reservations = await connection.db
        .select({
          id: agents.id,
          desiredStatus: agents.desiredStatus,
          deletedAt: agents.deletedAt,
        })
        .from(agents)
        .where(eq(agents.runnerId, runnerId));

      expect(result.agent.runnerId).toBe(runnerId);
      expect(
        reservations.filter(
          (reservation) =>
            reservation.desiredStatus === "running" && reservation.deletedAt === null,
        ),
      ).toHaveLength(1);
      const blockerAfterCreate = reservations.find((reservation) => reservation.id === blockerId);
      expect(blockerAfterCreate).toEqual(
        expect.objectContaining(
          releaseSource === "stop"
            ? { desiredStatus: "stopped", deletedAt: null }
            : { desiredStatus: "running", deletedAt: NOW },
        ),
      );
      expect(createLocks).toEqual([{ runnerId, userId: USER_A_ID }]);
      expect(calls).toEqual([`stop:${blockerId}`]);
    } finally {
      releaseCreateLock.resolve();
      await Promise.allSettled(pending);
      await createConnection.close();
      await mutationConnection.close();
    }
  }, 15_000);

  it("fails closed when an explicit requested runner is already at durable capacity", async () => {
    const runnerId = "00000000-0000-4000-8000-000000000407";
    await seedOnlineRunner(connection, { runnerId, userId: USER_A_ID });
    await createAgentForUser(USER_A_ID, readyInput("ready-explicit-capacity-first", { runnerId }), {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: telegramValidator(),
    });
    const validator = telegramValidator("654321");

    await expect(
      createAgentForUser(
        USER_A_ID,
        readyInput("ready-explicit-capacity-second", { runnerId, token: SECOND_TOKEN }),
        {
          createConnection: () => connection,
          env: KEYRING_ENV,
          now: () => new Date(NOW.getTime() + 1_000),
          randomBytes: incrementalRandomBytes(),
          telegramBotValidator: validator,
        },
      ),
    ).rejects.toBeInstanceOf(AgentCreateBlockedError);
    expect(validator).not.toHaveBeenCalled();
  });

  it("creates Claude with the direct Anthropic binding and encrypted Anthropic key", async () => {
    const anthropicKey = `sk-ant-${"c".repeat(32)}`;
    const result = await createAgentForUser(
      USER_A_ID,
      readyInput("ready-key-claude", { assistant: "claude", modelApiKey: anthropicKey }),
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator(),
      },
    );

    expect(result).toMatchObject({
      agent: { assistant: { id: "claude", displayName: "Claude" } },
    });
    const [config] = await connection.db.select().from(agentConfigs);
    const secrets = await connection.db.select().from(agentSecrets);

    expect(config).toMatchObject({
      modelProvider: "anthropic",
      modelName: "claude-sonnet-4-6",
    });
    expect(secrets.map((secret) => secret.kind)).toContain("anthropic_api_key");
    expect(JSON.stringify(result)).not.toContain(anthropicKey);
  });

  it("reuses an owner-scoped encrypted ChatGPT connection without returning the key", async () => {
    await createAgentForUser(USER_A_ID, readyInput("ready-key-reuse-1"), {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: telegramValidator(),
    });
    await expect(
      listModelConnectionsForUser(USER_A_ID, { createConnection: () => connection }),
    ).resolves.toMatchObject([
      { assistant: "chatgpt", status: "action_required" },
      { assistant: "claude", status: "action_required" },
    ]);
    await connection.db.update(agentDeployments).set({
      stage: "ready",
      runnerOperationId: "88888888-8888-4888-8888-888888888888",
      runnerAcceptedAt: NOW,
      canaryState: "passed",
      canaryAttemptedAt: NOW,
      canaryCompletedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    });

    const connectionViews = await listModelConnectionsForUser(USER_A_ID, {
      createConnection: () => connection,
    });
    expect(connectionViews).toMatchObject([
      { assistant: "chatgpt", status: "connected" },
      { assistant: "claude", status: "action_required" },
    ]);
    expect(JSON.stringify(connectionViews)).not.toContain(OPENAI_KEY_FIXTURE);

    const reusedInput = readyInput("ready-key-reuse-2", {
      token: SECOND_TOKEN,
      modelApiKey: null,
    });
    const reused = await createAgentForUser(USER_A_ID, reusedInput, {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => new Date(NOW.getTime() + 1_000),
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: telegramValidator("654321"),
    });

    expect(reused).toMatchObject({ agent: { assistant: { id: "chatgpt" } } });
    expect(JSON.stringify(reused)).not.toContain(OPENAI_KEY_FIXTURE);
    const modelSecrets = await connection.db
      .select()
      .from(agentSecrets)
      .where(eq(agentSecrets.kind, "openai_api_key"));
    expect(modelSecrets).toHaveLength(2);

    const foreignInput = readyInput("ready-key-reuse-3", {
      token: "777777:abcdefghijklmnopqrstuvwxyz",
      modelApiKey: null,
    });
    await expect(
      createAgentForUser(USER_B_ID, foreignInput, {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => new Date(NOW.getTime() + 2_000),
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator("777777"),
      }),
    ).rejects.toMatchObject({ name: "ReadyAgentValidationError" });
  });

  it("replays an existing ready deployment before flag and credential validation", async () => {
    const validator = telegramValidator();
    const onReadyDeploymentCommitted = vi.fn();
    const created = await createAgentForUser(USER_A_ID, readyInput("ready-key-002"), {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: validator,
      onReadyDeploymentCommitted,
    });
    const replay = await createAgentForUser(
      USER_A_ID,
      {
        name: "Changed Body",
        templateKey: "inbox_triage_agent",
        runnerId: null,
        launchMode: "ready",
        idempotencyKey: "ready-key-002",
      },
      {
        createConnection: () => connection,
        env: { ...KEYRING_ENV, AGENTBAY_READY_AGENT_CREATION_ENABLED: "false" },
        telegramBotValidator: vi.fn(),
        onReadyDeploymentCommitted,
      },
    );

    expect(replay).toEqual(created);
    expect(validator).toHaveBeenCalledTimes(1);
    expect(onReadyDeploymentCommitted).toHaveBeenCalledOnce();
    expect(onReadyDeploymentCommitted).toHaveBeenCalledWith(
      "deployment" in created ? created.deployment.id : null,
    );
    await expect(countRows(connection, "agents")).resolves.toBe(1);
    await expect(countRows(connection, "agent_events")).resolves.toBe(1);
  });

  it("checks requested runner ownership before Telegram validation", async () => {
    await seedForeignOnlineRunner(connection);
    const validator = telegramValidator();

    await expect(
      createAgentForUser(USER_A_ID, readyInput("ready-key-003", { runnerId: FOREIGN_RUNNER_ID }), {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: validator,
      }),
    ).rejects.toBeInstanceOf(AgentRunnerAssignmentError);

    expect(validator).not.toHaveBeenCalled();
    await expect(countRows(connection, "agents")).resolves.toBe(0);
  });

  it("parses the secret keyring before Telegram validation", async () => {
    const validator = telegramValidator();

    await expect(
      createAgentForUser(USER_A_ID, readyInput("ready-key-003b"), {
        createConnection: () => connection,
        env: {
          ...KEYRING_ENV,
          AGENTBAY_AGENT_SECRET_ACTIVE_KEY_VERSION: "missing",
        },
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: validator,
      }),
    ).rejects.toBeInstanceOf(AgentSecretKeyringError);

    expect(validator).not.toHaveBeenCalled();
    await expect(countRows(connection, "agents")).resolves.toBe(0);
  });

  it("rolls back all ready rows on active Telegram bot conflicts", async () => {
    await createAgentForUser(USER_A_ID, readyInput("ready-key-004"), {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: telegramValidator(),
    });

    await expect(
      createAgentForUser(USER_A_ID, readyInput("ready-key-005"), {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => new Date(NOW.getTime() + 1_000),
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator(),
      }),
    ).rejects.toBeInstanceOf(TelegramBotInUseError);

    await expect(countRows(connection, "agents")).resolves.toBe(1);
    await expect(countRows(connection, "agent_configs")).resolves.toBe(1);
    await expect(countRows(connection, "agent_secrets")).resolves.toBe(4);
    await expect(countRows(connection, "agent_deployments")).resolves.toBe(1);
    await expect(countRows(connection, "agent_events")).resolves.toBe(1);
  });

  it("rolls back when an existing soft-deleted same-key deployment wins insertion", async () => {
    const seeded = await createAgentForUser(USER_A_ID, readyInput("ready-key-006"), {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: telegramValidator(),
    });

    if (!("deployment" in seeded)) {
      throw new Error("Expected seeded ready agent.");
    }

    await connection.db
      .update(agents)
      .set({ deletedAt: new Date(NOW.getTime() + 1_000) })
      .where(eq(agents.id, seeded.agent.id));

    await expect(
      createAgentForUser(USER_A_ID, readyInput("ready-key-006", { token: SECOND_TOKEN }), {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => new Date(NOW.getTime() + 2_000),
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator("654321"),
      }),
    ).rejects.toBeInstanceOf(AgentPersistenceError);

    await expect(countRows(connection, "agents")).resolves.toBe(1);
    await expect(countRows(connection, "agent_events")).resolves.toBe(1);
  });

  it("rolls back every logical ready-create group at each insert boundary", async () => {
    const boundaries: ReadyCreateInsertBoundary[] = [
      "config",
      "secret:openai_api_key",
      "secret:telegram_bot_token",
      "secret:telegram_allowed_users",
      "secret:api_server_key",
      "deployment",
      "event",
    ];

    for (const boundary of boundaries) {
      await resetReadyCreateTables(connection);
      await seedReadyCreateUsers(connection);

      await expect(
        createAgentForUser(USER_A_ID, readyInput(`rollback-${boundary.replaceAll(":", "-")}`), {
          createConnection: () => connection,
          env: KEYRING_ENV,
          now: () => NOW,
          randomBytes: incrementalRandomBytes(),
          telegramBotValidator: telegramValidator(),
          readyCreateTestHooks: {
            beforeInsertBoundary: (actualBoundary) => {
              if (actualBoundary === boundary) {
                throw new Error(`injected ${boundary} failure`);
              }
            },
          },
        }),
      ).rejects.toBeInstanceOf(AgentPersistenceError);

      await expect(countReadyCreateGroups(connection)).resolves.toEqual({
        agents: 0,
        configs: 0,
        secrets: 0,
        deployments: 0,
        events: 0,
      });
    }
  });

  it("serializes same-key concurrent ready creates into one durable result", async () => {
    const firstConnection = createDatabaseConnection();
    const secondConnection = createDatabaseConnection();
    const barrier = createAsyncBarrier(2);

    try {
      const [first, second] = await Promise.all([
        createAgentForUser(USER_A_ID, readyInput("same-key-concurrent"), {
          createConnection: () => firstConnection,
          env: KEYRING_ENV,
          now: () => NOW,
          randomBytes: incrementalRandomBytes(),
          telegramBotValidator: telegramValidator("123456", barrier),
        }),
        createAgentForUser(USER_A_ID, readyInput("same-key-concurrent"), {
          createConnection: () => secondConnection,
          env: KEYRING_ENV,
          now: () => new Date(NOW.getTime() + 1_000),
          randomBytes: incrementalRandomBytes(),
          telegramBotValidator: telegramValidator("123456", barrier),
        }),
      ]);

      expect(second).toEqual(first);
      await expect(countReadyCreateGroups(connection)).resolves.toEqual({
        agents: 1,
        configs: 1,
        secrets: 4,
        deployments: 1,
        events: 1,
      });
    } finally {
      await firstConnection.close();
      await secondConnection.close();
    }
  });

  it("rolls back one side of concurrent active Telegram token and subject races", async () => {
    const tokenBarrier = createAsyncBarrier(2);
    await assertOneTelegramRaceRollsBack({
      observerConnection: connection,
      firstInput: readyInput("token-race-a"),
      secondInput: readyInput("token-race-b"),
      firstValidator: telegramValidator("123456", tokenBarrier),
      secondValidator: telegramValidator("123456", tokenBarrier),
    });

    await resetReadyCreateTables(connection);
    await seedReadyCreateUsers(connection);

    const subjectBarrier = createAsyncBarrier(2);
    await assertOneTelegramRaceRollsBack({
      observerConnection: connection,
      firstInput: readyInput("subject-race-a", { token: TOKEN }),
      secondInput: readyInput("subject-race-b", { token: SECOND_TOKEN }),
      firstValidator: telegramValidator("123456", subjectBarrier),
      secondValidator: telegramValidator("123456", subjectBarrier),
    });
  });

  it("isolates idempotency keys by user and replays only the owning deployment", async () => {
    const first = await createAgentForUser(USER_A_ID, readyInput("shared-user-key"), {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: telegramValidator("123456"),
    });
    const second = await createAgentForUser(
      USER_B_ID,
      readyInput("shared-user-key", { token: SECOND_TOKEN }),
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => new Date(NOW.getTime() + 1_000),
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator("654321"),
      },
    );
    const secondReplay = await createAgentForUser(
      USER_B_ID,
      {
        name: "Changed User B Body",
        templateKey: "github_issue_agent",
        runnerId: null,
        launchMode: "ready",
        idempotencyKey: "shared-user-key",
      },
      {
        createConnection: () => connection,
        env: { ...KEYRING_ENV, AGENTBAY_READY_AGENT_CREATION_ENABLED: "false" },
        telegramBotValidator: vi.fn(),
      },
    );

    expect(secondReplay).toEqual(second);
    expect(second.agent.id).not.toBe(first.agent.id);
    expect(second.agent.userId).toBe(USER_B_ID);
    await expect(countReadyCreateGroups(connection)).resolves.toEqual({
      agents: 2,
      configs: 2,
      secrets: 8,
      deployments: 2,
      events: 2,
    });
  });

  it("assigns only an owned requested runner and conceals the same runner from another user", async () => {
    const runnerId = "00000000-0000-4000-8000-000000000404";
    await seedOnlineRunner(connection, { runnerId, userId: USER_A_ID });

    const assigned = await createAgentForUser(
      USER_A_ID,
      readyInput("owned-runner-ready", { runnerId }),
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator(),
      },
    );
    const validator = telegramValidator("654321");

    expect(assigned.agent.runnerId).toBe(runnerId);
    await expect(
      createAgentForUser(
        USER_B_ID,
        readyInput("foreign-runner-ready", { runnerId, token: SECOND_TOKEN }),
        {
          createConnection: () => connection,
          env: KEYRING_ENV,
          now: () => new Date(NOW.getTime() + 1_000),
          randomBytes: incrementalRandomBytes(),
          telegramBotValidator: validator,
        },
      ),
    ).rejects.toBeInstanceOf(AgentRunnerAssignmentError);
    expect(validator).not.toHaveBeenCalled();
    await expect(countReadyCreateGroups(connection)).resolves.toEqual({
      agents: 1,
      configs: 1,
      secrets: 4,
      deployments: 1,
      events: 1,
    });
  });
});

function readyInput(
  idempotencyKey: string,
  overrides: {
    runnerId?: string | null;
    token?: string;
    assistant?: "chatgpt" | "claude";
    modelApiKey?: string | null;
  } = {},
) {
  return {
    name: "Ready Agent",
    templateKey: "research_agent" as const,
    runnerId: overrides.runnerId ?? null,
    launchMode: "ready" as const,
    idempotencyKey,
    assistant: overrides.assistant ?? "chatgpt",
    ...(overrides.modelApiKey === null
      ? {}
      : { modelApiKey: overrides.modelApiKey ?? OPENAI_KEY_FIXTURE }),
    telegramBotToken: overrides.token ?? TOKEN,
    telegramAllowedUserIds: ["111111", "222222", "111111"],
  };
}

function telegramValidator(botId = "123456", barrier?: () => Promise<void>) {
  return vi.fn(async () => {
    await barrier?.();

    return {
      ok: true as const,
      bot: { botId, username: "Valid_bot" },
    };
  });
}

function incrementalRandomBytes() {
  let next = 1;

  return (size: number) => {
    const value = Buffer.alloc(size, next);
    next += 1;
    return value;
  };
}

async function seedForeignOnlineRunner(connection: DatabaseConnection) {
  await seedOnlineRunner(connection, { runnerId: FOREIGN_RUNNER_ID, userId: USER_B_ID });
}

async function seedOnlineRunner(
  connection: DatabaseConnection,
  input: { runnerId: string; userId: string },
) {
  const [runner] = await connection.db
    .insert(runners)
    .values({
      id: input.runnerId,
      userId: input.userId,
      name: "Ready Runner",
      kind: "manual_vps",
      endpointUrl: `https://runner-${input.runnerId.slice(-4)}.example.com`,
      status: "online",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning();

  if (!runner) {
    throw new Error("Expected runner insert.");
  }

  await connection.db.insert(runnerHeartbeats).values({
    runnerId: runner.id,
    status: "online",
    metadata: { metrics: { maxAgents: 2, runningAgents: 0 } },
    observedAt: NOW,
    createdAt: NOW,
  });
}

async function seedAssignedAgent(
  connection: DatabaseConnection,
  input: {
    id: string;
    runnerId: string;
    status: "running" | "stopped";
    desiredStatus: "running" | "stopped";
    name: string;
  },
): Promise<void> {
  await connection.db.insert(agents).values({
    id: input.id,
    userId: USER_A_ID,
    runnerId: input.runnerId,
    name: input.name,
    templateKey: "research_agent",
    templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
    status: input.status,
    desiredStatus: input.desiredStatus,
    createdAt: new Date(NOW.getTime() - 1_000),
    updatedAt: new Date(NOW.getTime() - 1_000),
  });
}

async function seedRetryableUnassignedAgent(
  connection: DatabaseConnection,
  agentId: string,
): Promise<void> {
  await connection.db.insert(agents).values({
    id: agentId,
    userId: USER_A_ID,
    runnerId: null,
    name: "Retry race capacity consumer",
    templateKey: "research_agent",
    templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
    status: "error",
    desiredStatus: "running",
    createdAt: new Date(NOW.getTime() - 1_000),
    updatedAt: new Date(NOW.getTime() - 1_000),
  });
  await connection.db.insert(agentDeployments).values({
    id: "00000000-0000-4000-8000-000000000611",
    agentId,
    userId: USER_A_ID,
    stage: "failed",
    configRevision: "cfg-retry-race",
    idempotencyKey: "failed-before-retry-race",
    errorCode: "runner_capacity_wait",
    errorDetail: "Prior deployment failed before retry race.",
    failedAt: new Date(NOW.getTime() - 500),
    createdAt: new Date(NOW.getTime() - 1_000),
    updatedAt: new Date(NOW.getTime() - 500),
  });
}

async function seedReplacementHandoverRace(
  connection: DatabaseConnection,
  input: {
    sourceRunnerId: string;
    targetRunnerId: string;
    movingAgentId: string;
    replacementId: string;
  },
): Promise<void> {
  await connection.db.insert(runners).values([
    {
      id: input.sourceRunnerId,
      userId: USER_A_ID,
      name: `agentbay-deploy-${"1".repeat(32)}`,
      kind: "digitalocean",
      endpointUrl: "https://replacement-source.example.com",
      status: "degraded",
      provider: "digitalocean",
      providerResourceId: "replacement-source-1",
      providerFirewallId: "replacement-source-firewall",
      region: "sfo3",
      sizeSlug: "s-1vcpu-2gb",
      image: RUNNER_IMAGE,
      provisioningStatus: "ready",
      provisioningOperationKey: `agentbay-deploy-${"1".repeat(32)}`,
      requiredRunnerImageDigest: `sha256:${"b".repeat(64)}`,
      observedRunnerImageDigest: `sha256:${"b".repeat(64)}`,
      observedRunnerReleaseVersion: "a".repeat(40),
      observedRunnerBootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      compatibilityState: "compatible",
      compatibilityVerifiedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: input.targetRunnerId,
      userId: USER_A_ID,
      name: `agentbay-deploy-${"2".repeat(32)}`,
      kind: "digitalocean",
      endpointUrl: "https://replacement-target.example.com",
      status: "online",
      provider: "digitalocean",
      providerResourceId: "replacement-target-1",
      providerFirewallId: "replacement-target-firewall",
      region: "sfo3",
      sizeSlug: "s-1vcpu-2gb",
      image: RUNNER_IMAGE,
      provisioningStatus: "ready",
      provisioningOperationKey: `agentbay-deploy-${"2".repeat(32)}`,
      requiredRunnerImageDigest: `sha256:${"b".repeat(64)}`,
      observedRunnerImageDigest: `sha256:${"b".repeat(64)}`,
      observedRunnerReleaseVersion: "a".repeat(40),
      observedRunnerBootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      compatibilityState: "compatible",
      compatibilityVerifiedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  await connection.db.insert(runnerHeartbeats).values([
    {
      runnerId: input.sourceRunnerId,
      status: "degraded",
      metadata: { metrics: { maxAgents: 1, runningAgents: 1 } },
      observedAt: NOW,
      createdAt: NOW,
    },
    {
      runnerId: input.targetRunnerId,
      status: "online",
      metadata: { metrics: { maxAgents: 1, runningAgents: 0 } },
      observedAt: NOW,
      createdAt: NOW,
    },
  ]);
  await connection.db.insert(agents).values({
    id: input.movingAgentId,
    userId: USER_A_ID,
    runnerId: input.sourceRunnerId,
    name: "Replacement handover capacity consumer",
    templateKey: "research_agent",
    templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
    status: "running",
    desiredStatus: "running",
    createdAt: new Date(NOW.getTime() - 1_000),
    updatedAt: new Date(NOW.getTime() - 1_000),
  });
  await connection.db.insert(agentDeployments).values({
    id: "00000000-0000-4000-8000-000000000613",
    agentId: input.movingAgentId,
    userId: USER_A_ID,
    stage: "ready",
    configRevision: "cfg-replacement-race",
    idempotencyKey: "ready-before-replacement-race",
    runnerOperationId: "00000000-0000-4000-8000-000000000614",
    runnerAcceptedAt: NOW,
    canaryState: "passed",
    canaryAttemptedAt: NOW,
    canaryCompletedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    createdAt: new Date(NOW.getTime() - 1_000),
    updatedAt: new Date(NOW.getTime() - 1_000),
  });
  await connection.db.insert(agentRuntimeReconciliations).values({
    agentId: input.movingAgentId,
    userId: USER_A_ID,
    state: "observing",
    configRevision: "cfg-replacement-race",
    operationId: "00000000-0000-4000-8000-000000000614",
    stableSince: NOW,
    lastObservedAt: NOW,
    lastReadyAt: NOW,
    nextAttemptAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await connection.db.insert(agentUsagePeriods).values({
    agentId: input.movingAgentId,
    runnerId: input.sourceRunnerId,
    source: "lifecycle",
    startedAt: new Date(NOW.getTime() - 1_000),
    createdAt: new Date(NOW.getTime() - 1_000),
    updatedAt: new Date(NOW.getTime() - 1_000),
  });
  await connection.db.insert(runnerCredentials).values({
    runnerId: input.sourceRunnerId,
    credentialHash: "revoked-replacement-source-credential-hash",
    credentialPrefix: "agb_run_race",
    status: "revoked",
    revokedAt: NOW,
    createdAt: new Date(NOW.getTime() - 1_000),
    updatedAt: NOW,
  });
  await connection.db.insert(runnerReplacements).values({
    id: input.replacementId,
    sourceRunnerId: input.sourceRunnerId,
    targetRunnerId: input.targetRunnerId,
    reason: "stale_heartbeat",
    state: "reassigning",
    operationKey: `agentbay-replace-${"1".repeat(32)}`,
    nextAttemptAt: NOW,
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function replacementRaceProviderConfig(): DigitalOceanProviderConfig {
  return {
    token: "fake-provider-token",
    providerMode: "digitalocean",
    runnerBearerToken: "fake-runner-bearer",
    runnerImage: RUNNER_IMAGE,
    runnerMaxAgents: 1,
    region: "sfo3",
    sizeSlug: "s-1vcpu-2gb",
    image: "ubuntu-24-04-x64",
    tags: ["agentbay", "agentbay-runner"],
    sshKeyIds: ["fake-key"],
    sshSourceAddresses: ["203.0.113.5/32"],
  };
}

function createManualLifecycleRunnerStub(calls: string[]): RunnerAdapter {
  let processSequence = 0;
  const processFor = (agentId: string, status: LocalRunnerProcessDto["status"]) => {
    processSequence += 1;
    const timestamp = new Date(`2026-08-03T06:10:${String(processSequence).padStart(2, "0")}.000Z`);

    return {
      id: `00000000-0000-4000-8000-${String(processSequence).padStart(12, "0")}`,
      agentId,
      pid: 10_000 + processSequence,
      commandMetadata: { command: "stub-local-runner", args: [] },
      status,
      startedAt: timestamp.toISOString(),
      stoppedAt: status === "stopped" ? timestamp.toISOString() : null,
      exitCode: null,
      signal: null,
      lastError: null,
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
    } satisfies LocalRunnerProcessDto;
  };

  return {
    async start(agentId: string) {
      calls.push(`start:${agentId}`);

      return { ok: true, process: processFor(agentId, "running") };
    },
    async stop(agentId: string) {
      calls.push(`stop:${agentId}`);

      return { ok: true, process: processFor(agentId, "stopped") };
    },
    async restart(agentId: string) {
      calls.push(`restart:${agentId}`);

      return { ok: true, process: processFor(agentId, "running") };
    },
    async status(agentId: string) {
      calls.push(`status:${agentId}`);

      return { ok: true, process: processFor(agentId, "running") };
    },
    async streamLogs() {
      return { logs: [], nextAfter: null };
    },
  };
}

async function countRows(connection: DatabaseConnection, tableName: string): Promise<number> {
  const result = await connection.client.unsafe<{ count: string }[]>(
    `select count(*)::text as count from ${tableName}`,
  );

  return Number(result[0]?.count ?? 0);
}

async function countReadyCreateGroups(connection: DatabaseConnection) {
  const [agentCount, configCount, secretCount, deploymentCount, eventCount] = await Promise.all([
    countRows(connection, "agents"),
    countRows(connection, "agent_configs"),
    countRows(connection, "agent_secrets"),
    countRows(connection, "agent_deployments"),
    countRows(connection, "agent_events"),
  ]);

  return {
    agents: agentCount,
    configs: configCount,
    secrets: secretCount,
    deployments: deploymentCount,
    events: eventCount,
  };
}

async function assertOneTelegramRaceRollsBack(input: {
  observerConnection: DatabaseConnection;
  firstInput: ReturnType<typeof readyInput>;
  secondInput: ReturnType<typeof readyInput>;
  firstValidator: ReturnType<typeof telegramValidator>;
  secondValidator: ReturnType<typeof telegramValidator>;
}) {
  const firstConnection = createDatabaseConnection();
  const secondConnection = createDatabaseConnection();

  try {
    const settled = await Promise.allSettled([
      createAgentForUser(USER_A_ID, input.firstInput, {
        createConnection: () => firstConnection,
        env: KEYRING_ENV,
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: input.firstValidator,
      }),
      createAgentForUser(USER_A_ID, input.secondInput, {
        createConnection: () => secondConnection,
        env: KEYRING_ENV,
        now: () => new Date(NOW.getTime() + 1_000),
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: input.secondValidator,
      }),
    ]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(TelegramBotInUseError);
    await expect(countReadyCreateGroups(input.observerConnection)).resolves.toEqual({
      agents: 1,
      configs: 1,
      secrets: 4,
      deployments: 1,
      events: 1,
    });
  } finally {
    await firstConnection.close();
    await secondConnection.close();
  }
}

async function seedReadyCreateUsers(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(users).values([{ id: USER_A_ID }, { id: USER_B_ID }]);
}

function createAsyncBarrier(count: number): () => Promise<void> {
  let waiting = 0;
  let release: (() => void) | null = null;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    waiting += 1;

    if (waiting === count) {
      release?.();
    }

    await released;
  };
}

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

async function waitForBlockedDatabaseSessions(
  observer: DatabaseConnection,
  expectedCount: number,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await countBlockedDatabaseSessions(observer)) >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for blocked database sessions: ${description}.`);
}

async function countBlockedDatabaseSessions(observer: DatabaseConnection): Promise<number> {
  const [row] = await observer.client<{ blockedCount: number }[]>`
    select count(*)::int as "blockedCount"
    from pg_stat_activity
    where datname = current_database()
      and cardinality(pg_blocking_pids(pid)) > 0
  `;

  return row?.blockedCount ?? 0;
}

async function resetReadyCreateTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_deployments, agent_secrets, backups, agent_approvals, agent_configs, agent_usage_periods, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runner_provisioning_events, runner_heartbeats, runner_credentials, runner_registration_tokens, runners, app_metadata, users restart identity cascade`;
}
