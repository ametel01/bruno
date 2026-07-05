import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { runnerCredentials, runnerHeartbeats, runners, users } from "@/src/server/db/schema";
import {
  recordRunnerHeartbeat,
  reconcileStaleRunnerHeartbeats,
  RUNNER_HEARTBEAT_STALE_THRESHOLD_MS,
  validateRunnerHeartbeatPayload,
} from "@/src/server/runners/runner-heartbeat";
import { createRunnerCredential, hashRunnerSecret } from "@/src/server/runners/runner-auth-secrets";

describe("runner heartbeat persistence", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetRunnerHeartbeatTables(connection);
  });

  afterEach(async () => {
    await resetRunnerHeartbeatTables(connection);
    await connection.close();
  });

  it("records a valid authenticated heartbeat, bounded metrics, credential use, and online status", async () => {
    const now = new Date("2026-07-05T08:00:00.000Z");
    const credential = createRunnerCredential({
      randomBytes: (size) => Buffer.alloc(size, 3),
    });
    const runner = await seedRunnerCredential(connection, {
      credentialValue: credential.value,
      runnerStatus: "active",
    });

    const result = await recordRunnerHeartbeat(
      {
        authorizationHeader: `Bearer ${credential.value}`,
        payload: {
          runnerId: runner.id,
          version: " agentbay-runner/1.0.0 <token=secret> ",
          metrics: {
            cpuPercent: 250,
            memoryUsedMb: 128.4,
            memoryTotalMb: Number.POSITIVE_INFINITY,
            diskUsedMb: -20,
            runningAgents: 2,
            apiToken: "must-not-persist",
          },
        },
      },
      { createConnection: () => connection, now: () => now },
    );

    const [persistedRunner] = await connection.db
      .select({ status: runners.status, updatedAt: runners.updatedAt })
      .from(runners)
      .where(eq(runners.id, runner.id))
      .limit(1);
    const [persistedCredential] = await connection.db
      .select({ lastUsedAt: runnerCredentials.lastUsedAt })
      .from(runnerCredentials)
      .where(eq(runnerCredentials.runnerId, runner.id))
      .limit(1);
    const persistedHeartbeats = await connection.db
      .select()
      .from(runnerHeartbeats)
      .where(eq(runnerHeartbeats.runnerId, runner.id));

    expect(result).toEqual({
      ok: true,
      runner: {
        id: runner.id,
        status: "online",
        observedAt: "2026-07-05T08:00:00.000Z",
      },
    });
    expect(persistedRunner).toMatchObject({ status: "online", updatedAt: now });
    expect(persistedCredential?.lastUsedAt).toEqual(now);
    expect(persistedHeartbeats).toHaveLength(1);
    expect(persistedHeartbeats[0]).toMatchObject({
      runnerId: runner.id,
      status: "online",
      observedAt: now,
      createdAt: now,
      metadata: {
        version: "agentbay-runner/1.0.0 tokensecret",
        metrics: {
          cpuPercent: 100,
          memoryUsedMb: 128.4,
          diskUsedMb: 0,
          runningAgents: 2,
        },
      },
    });
    expect(JSON.stringify(persistedHeartbeats[0]?.metadata)).not.toContain("apiToken");
    expect(JSON.stringify(persistedHeartbeats[0]?.metadata)).not.toContain("must-not-persist");
  });

  it.each([
    ["missing bearer", null],
    ["malformed bearer", "Token wrong"],
    ["unknown bearer", "Bearer agb_run_unknown"],
  ])("rejects %s credentials with a safe auth failure", async (_label, authorizationHeader) => {
    const runner = await seedRunnerCredential(connection, {
      credentialValue: "agb_run_valid",
      runnerStatus: "active",
    });

    const result = await recordRunnerHeartbeat(
      {
        authorizationHeader,
        payload: { runnerId: runner.id },
      },
      { createConnection: () => connection, now: () => new Date("2026-07-05T08:00:00.000Z") },
    );

    await expect(countRows(connection, "runner_heartbeats")).resolves.toBe(0);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("agb_run_valid");
    expect(JSON.stringify(result)).not.toContain("agb_run_unknown");
  });

  it.each([
    ["expired", { expiresAt: new Date("2026-07-05T07:59:59.000Z") }],
    ["revoked", { status: "revoked", revokedAt: new Date("2026-07-05T07:00:00.000Z") }],
  ])("rejects %s credentials without writing heartbeat state", async (_label, overrides) => {
    const credential = createRunnerCredential({
      randomBytes: (size) => Buffer.alloc(size, 5),
    });
    const runner = await seedRunnerCredential(connection, {
      credentialValue: credential.value,
      runnerStatus: "active",
      credentialOverrides: overrides,
    });

    const result = await recordRunnerHeartbeat(
      {
        authorizationHeader: `Bearer ${credential.value}`,
        payload: { runnerId: runner.id },
      },
      { createConnection: () => connection, now: () => new Date("2026-07-05T08:00:00.000Z") },
    );

    const [persistedRunner] = await connection.db
      .select({ status: runners.status })
      .from(runners)
      .where(eq(runners.id, runner.id))
      .limit(1);

    expect(result).toEqual({ ok: false, reason: "invalid_credential" });
    await expect(countRows(connection, "runner_heartbeats")).resolves.toBe(0);
    expect(persistedRunner?.status).toBe("active");
  });

  it("rejects a valid credential scoped to a different runner", async () => {
    const credential = createRunnerCredential({
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    const credentialRunner = await seedRunnerCredential(connection, {
      credentialValue: credential.value,
      runnerStatus: "active",
      endpointUrl: "https://runner-one.example.com",
    });
    const targetRunner = await seedRunner(connection, {
      endpointUrl: "https://runner-two.example.com",
      status: "active",
    });

    const result = await recordRunnerHeartbeat(
      {
        authorizationHeader: `Bearer ${credential.value}`,
        payload: { runnerId: targetRunner.id },
      },
      { createConnection: () => connection, now: () => new Date("2026-07-05T08:00:00.000Z") },
    );

    const runnerStatuses = await connection.db
      .select({ id: runners.id, status: runners.status })
      .from(runners)
      .where(inArray(runners.id, [credentialRunner.id, targetRunner.id]));

    expect(result).toEqual({ ok: false, reason: "wrong_runner" });
    await expect(countRows(connection, "runner_heartbeats")).resolves.toBe(0);
    expect(runnerStatuses).toEqual(
      expect.arrayContaining([
        { id: credentialRunner.id, status: "active" },
        { id: targetRunner.id, status: "active" },
      ]),
    );
  });

  it("marks online runners offline after the stale heartbeat threshold", async () => {
    const now = new Date("2026-07-05T08:02:00.000Z");
    const staleObservedAt = new Date(now.getTime() - RUNNER_HEARTBEAT_STALE_THRESHOLD_MS - 1);
    const freshObservedAt = new Date(now.getTime() - RUNNER_HEARTBEAT_STALE_THRESHOLD_MS + 1);
    const staleRunner = await seedRunner(connection, {
      endpointUrl: "https://stale.example.com",
      status: "online",
    });
    const missingRunner = await seedRunner(connection, {
      endpointUrl: "https://missing.example.com",
      status: "online",
    });
    const freshRunner = await seedRunner(connection, {
      endpointUrl: "https://fresh.example.com",
      status: "online",
    });
    await seedHeartbeat(connection, staleRunner.id, staleObservedAt);
    await seedHeartbeat(connection, freshRunner.id, freshObservedAt);

    const result = await reconcileStaleRunnerHeartbeats({
      createConnection: () => connection,
      now: () => now,
    });
    const runnerStatuses = await connection.db
      .select({ id: runners.id, status: runners.status })
      .from(runners)
      .where(inArray(runners.id, [staleRunner.id, missingRunner.id, freshRunner.id]));

    expect(result).toEqual({
      offlineCount: 2,
      runnerIds: expect.arrayContaining([staleRunner.id, missingRunner.id]),
      cutoff: "2026-07-05T08:00:30.000Z",
    });
    expect(runnerStatuses).toEqual(
      expect.arrayContaining([
        { id: staleRunner.id, status: "offline" },
        { id: missingRunner.id, status: "offline" },
        { id: freshRunner.id, status: "online" },
      ]),
    );
  });

  it("validates runner IDs and ignores untrusted metric keys", () => {
    expect(validateRunnerHeartbeatPayload({ runnerId: "not-a-uuid", metrics: [] })).toEqual({
      ok: false,
      reason: "invalid_payload",
      issues: [{ field: "runnerId", message: "Runner ID must be a valid UUID." }],
    });

    expect(
      validateRunnerHeartbeatPayload({
        runnerId: "00000000-0000-4000-8000-000000000130",
        status: "online",
        metrics: {
          cpuPercent: 50,
          password: "secret",
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        runnerId: "00000000-0000-4000-8000-000000000130",
        status: "online",
        metadata: {
          metrics: { cpuPercent: 50 },
        },
      },
    });
  });
});

async function seedRunnerCredential(
  connection: DatabaseConnection,
  input: {
    credentialValue: string;
    runnerStatus: string;
    endpointUrl?: string;
    credentialOverrides?: Partial<typeof runnerCredentials.$inferInsert>;
  },
): Promise<{ id: string }> {
  const runner = await seedRunner(connection, {
    endpointUrl: input.endpointUrl ?? "https://runner.example.com",
    status: input.runnerStatus,
  });

  await connection.db.insert(runnerCredentials).values({
    runnerId: runner.id,
    credentialHash: hashRunnerSecret(input.credentialValue),
    credentialPrefix: input.credentialValue.slice(0, 16),
    status: "active",
    ...input.credentialOverrides,
  });

  return runner;
}

async function seedRunner(
  connection: DatabaseConnection,
  input: {
    endpointUrl: string;
    status: string;
  },
): Promise<{ id: string }> {
  const [user] = await connection.db.insert(users).values({}).returning({ id: users.id });

  if (!user) {
    throw new Error("Test user insert returned no rows.");
  }

  const [runner] = await connection.db
    .insert(runners)
    .values({
      userId: user.id,
      name: "Test Runner",
      kind: "manual_vps",
      endpointUrl: input.endpointUrl,
      status: input.status,
      createdAt: new Date("2026-07-05T07:00:00.000Z"),
      updatedAt: new Date("2026-07-05T07:00:00.000Z"),
    })
    .returning({ id: runners.id });

  if (!runner) {
    throw new Error("Test runner insert returned no rows.");
  }

  return runner;
}

async function seedHeartbeat(
  connection: DatabaseConnection,
  runnerId: string,
  observedAt: Date,
): Promise<void> {
  await connection.db.insert(runnerHeartbeats).values({
    runnerId,
    status: "online",
    metadata: {},
    observedAt,
    createdAt: observedAt,
  });
}

async function resetRunnerHeartbeatTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table runner_heartbeats, runner_credentials, runner_registration_tokens, runners, app_metadata, users restart identity cascade`;
}

async function countRows(
  connection: DatabaseConnection,
  tableName: "runner_heartbeats",
): Promise<number> {
  const [row] = await connection.db.execute<{ count: string }>(
    sql.raw(`select count(*)::text as count from ${tableName}`),
  );

  return Number(row?.count ?? 0);
}
