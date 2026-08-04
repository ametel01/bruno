import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  runnerCredentials,
  runnerHeartbeats,
  runnerProvisioningEvents,
  runners,
  users,
} from "@/src/server/db/schema";
import {
  confirmCloudRunnerReadiness,
  probeRunnerEndpointReadiness,
  recordRunnerHeartbeat,
  reconcileStaleRunnerHeartbeats,
  RUNNER_HEARTBEAT_STALE_THRESHOLD_MS,
  validateRunnerHeartbeatPayload,
} from "@/src/server/runners/runner-heartbeat";
import { createRunnerCredential, hashRunnerSecret } from "@/src/server/runners/runner-auth-secrets";
import { RUNNER_BOOT_CONTRACT_VERSION } from "@/src/runner-service/constants";

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

  it("persists only canonical release fields from an authenticated heartbeat", async () => {
    const credential = createRunnerCredential({
      randomBytes: (size) => Buffer.alloc(size, 13),
    });
    const runner = await seedRunnerCredential(connection, {
      credentialValue: credential.value,
      runnerStatus: "active",
    });
    const observedDigest = `sha256:${"d".repeat(64)}`;

    await expect(
      recordRunnerHeartbeat(
        {
          authorizationHeader: `Bearer ${credential.value}`,
          payload: {
            runnerId: runner.id,
            version: "agentbay-runner/baseline",
            release: {
              version: "release-sha",
              imageDigest: observedDigest,
              bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
              registryCredential: "must-not-persist",
            },
          },
        },
        {
          createConnection: () => connection,
          now: () => new Date("2026-07-05T08:00:00.000Z"),
        },
      ),
    ).resolves.toMatchObject({ ok: true, runner: { id: runner.id, status: "online" } });

    const [heartbeat] = await connection.db
      .select({ metadata: runnerHeartbeats.metadata })
      .from(runnerHeartbeats)
      .where(eq(runnerHeartbeats.runnerId, runner.id));

    expect(heartbeat?.metadata).toEqual({
      version: "agentbay-runner/baseline",
      releaseEvidence: "present",
      release: {
        version: "release-sha",
        imageDigest: observedDigest,
        bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      },
    });
    expect(JSON.stringify(heartbeat?.metadata)).not.toContain("must-not-persist");
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

  it("keeps a cloud runner blocked until its authenticated readiness endpoint succeeds", async () => {
    const now = new Date("2026-07-06T02:02:00.000Z");
    const credential = createRunnerCredential({
      randomBytes: (size) => Buffer.alloc(size, 8),
    });
    const runner = await seedRunnerCredential(connection, {
      credentialValue: credential.value,
      runnerStatus: "registering",
      kind: "digitalocean",
      endpointUrl: "https://cloud-runner.example.com",
      provisioningStatus: "waiting_for_runner",
      provisioningStartedAt: new Date("2026-07-06T02:00:00.000Z"),
    });

    const result = await recordRunnerHeartbeat(
      {
        authorizationHeader: `Bearer ${credential.value}`,
        payload: {
          runnerId: runner.id,
          status: "online",
          version: "agentbay-runner/bootstrap",
        },
      },
      { createConnection: () => connection, now: () => now },
    );

    const [heartbeatOnlyRunner] = await connection.db
      .select()
      .from(runners)
      .where(eq(runners.id, runner.id))
      .limit(1);
    const heartbeatOnlyEvents = await connection.db
      .select()
      .from(runnerProvisioningEvents)
      .where(eq(runnerProvisioningEvents.runnerId, runner.id));

    expect(result).toEqual({
      ok: true,
      runner: {
        id: runner.id,
        status: "online",
        observedAt: "2026-07-06T02:02:00.000Z",
      },
    });
    expect(heartbeatOnlyRunner).toMatchObject({
      status: "online",
      provisioningStatus: "waiting_for_runner",
      provisioningCompletedAt: null,
    });
    expect(heartbeatOnlyEvents).toEqual([]);

    const failedProbe = await confirmCloudRunnerReadiness(runner.id, {
      createConnection: () => connection,
      fetch: async () => {
        throw new Error("TLS certificate is not ready");
      },
      now: () => now,
      runnerBearerToken: "runner-command-token",
    });
    const [runnerAfterFailedProbe] = await connection.db
      .select()
      .from(runners)
      .where(eq(runners.id, runner.id))
      .limit(1);

    expect(failedProbe).toEqual({ outcome: "pending", reason: "network_error" });
    expect(runnerAfterFailedProbe).toMatchObject({
      status: "online",
      provisioningStatus: "waiting_for_runner",
      provisioningCompletedAt: null,
    });

    const requests: Array<{ url: string; authorization: string | null }> = [];
    const successfulProbe = await confirmCloudRunnerReadiness(runner.id, {
      createConnection: () => connection,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ ok: true, status: "ready" });
      },
      now: () => now,
      runnerBearerToken: "runner-command-token",
    });
    const duplicateProbe = await confirmCloudRunnerReadiness(runner.id, {
      createConnection: () => connection,
      fetch: async () => {
        throw new Error("Ready runners must not be probed again.");
      },
      now: () => now,
      runnerBearerToken: "runner-command-token",
    });
    const [persistedRunner] = await connection.db
      .select()
      .from(runners)
      .where(eq(runners.id, runner.id))
      .limit(1);
    const events = await connection.db
      .select()
      .from(runnerProvisioningEvents)
      .where(eq(runnerProvisioningEvents.runnerId, runner.id));

    expect(successfulProbe).toEqual({ outcome: "ready", transitioned: true });
    expect(duplicateProbe).toEqual({ outcome: "not_applicable", reason: "already_ready" });
    expect(requests).toEqual([
      {
        url: "https://cloud-runner.example.com/runner/v1/readiness",
        authorization: "Bearer runner-command-token",
      },
    ]);
    expect(persistedRunner).toMatchObject({
      status: "online",
      provisioningStatus: "ready",
      provisioningCompletedAt: now,
    });
    expect(events).toEqual([
      expect.objectContaining({
        phase: "ready",
        status: "completed",
        message: "Authenticated runner readiness probe succeeded.",
        metadata: {
          provider: "digitalocean",
          heartbeatStatus: "online",
          readinessProbe: "authenticated_endpoint",
        },
      }),
    ]);
    expect(JSON.stringify([persistedRunner, events])).not.toContain(credential.value);
  });

  it("fails closed when readiness authentication or endpoint configuration is invalid", async () => {
    const runner = await seedRunner(connection, {
      endpointUrl: "http://public-runner.example.com",
      status: "online",
      kind: "digitalocean",
      provisioningStatus: "waiting_for_runner",
    });
    let fetchCalls = 0;
    const fetchImplementation: typeof fetch = async () => {
      fetchCalls += 1;
      return Response.json({ ok: true, status: "ready" });
    };

    await expect(
      confirmCloudRunnerReadiness(runner.id, {
        createConnection: () => connection,
        fetch: fetchImplementation,
        runnerBearerToken: null,
      }),
    ).resolves.toEqual({ outcome: "pending", reason: "token_not_configured" });
    await expect(
      confirmCloudRunnerReadiness(runner.id, {
        createConnection: () => connection,
        fetch: fetchImplementation,
        runnerBearerToken: "runner-command-token",
      }),
    ).resolves.toEqual({ outcome: "pending", reason: "endpoint_invalid" });
    expect(fetchCalls).toBe(0);
  });

  it("accepts only the exact authenticated not-found response from a legacy runner image", async () => {
    const common = {
      endpointUrl: "https://legacy-cloud-runner.example.com",
      runnerBearerToken: "runner-command-token",
    };

    await expect(
      probeRunnerEndpointReadiness({
        ...common,
        fetch: async () =>
          Response.json(
            {
              ok: false,
              error: { code: "not_found", message: "Runner route was not found." },
            },
            { status: 404 },
          ),
      }),
    ).resolves.toEqual({ ok: true, protocol: "legacy_authenticated_not_found" });
    await expect(
      probeRunnerEndpointReadiness({
        ...common,
        fetch: async () =>
          Response.json({ ok: false, error: { code: "unauthorized" } }, { status: 401 }),
      }),
    ).resolves.toEqual({ ok: false, reason: "endpoint_rejected" });
    await expect(
      probeRunnerEndpointReadiness({
        ...common,
        fetch: async () => Response.json({ ok: false }, { status: 404 }),
      }),
    ).resolves.toEqual({ ok: false, reason: "endpoint_rejected" });
  });

  it("allows insecure loopback readiness only for the explicit local Docker mode", async () => {
    const runner = await seedRunner(connection, {
      endpointUrl: "http://host.docker.internal:3045",
      status: "online",
      kind: "digitalocean",
      provisioningStatus: "waiting_for_runner",
    });
    const requests: string[] = [];

    const result = await confirmCloudRunnerReadiness(runner.id, {
      allowInsecureLoopback: true,
      createConnection: () => connection,
      fetch: async (input) => {
        requests.push(String(input));
        return Response.json({ ok: true, status: "ready" });
      },
      runnerBearerToken: "local-runner-command-token",
    });

    expect(result).toEqual({ outcome: "ready", transitioned: true });
    expect(requests).toEqual(["http://host.docker.internal:3045/runner/v1/readiness"]);
  });

  it("does not mark a cloud runner ready from a degraded bootstrap heartbeat", async () => {
    const credential = createRunnerCredential({
      randomBytes: (size) => Buffer.alloc(size, 6),
    });
    const runner = await seedRunnerCredential(connection, {
      credentialValue: credential.value,
      runnerStatus: "registering",
      kind: "digitalocean",
      endpointUrl: "https://degraded-cloud-runner.example.com",
      provisioningStatus: "waiting_for_runner",
      provisioningStartedAt: new Date("2026-07-06T02:00:00.000Z"),
    });

    const result = await recordRunnerHeartbeat(
      {
        authorizationHeader: `Bearer ${credential.value}`,
        payload: {
          runnerId: runner.id,
          status: "degraded",
        },
      },
      {
        createConnection: () => connection,
        now: () => new Date("2026-07-06T02:02:00.000Z"),
      },
    );

    const [persistedRunner] = await connection.db
      .select()
      .from(runners)
      .where(eq(runners.id, runner.id))
      .limit(1);
    const events = await connection.db
      .select()
      .from(runnerProvisioningEvents)
      .where(eq(runnerProvisioningEvents.runnerId, runner.id));

    expect(result).toMatchObject({
      ok: true,
      runner: {
        status: "degraded",
      },
    });
    expect(persistedRunner).toMatchObject({
      status: "degraded",
      provisioningStatus: "waiting_for_runner",
      provisioningCompletedAt: null,
    });
    expect(events).toEqual([]);
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
          releaseEvidence: "missing",
          metrics: { cpuPercent: 50 },
        },
      },
    });
  });

  it.each([
    ["missing fields", { version: "release-sha" }],
    [
      "uppercase digest",
      {
        version: "release-sha",
        imageDigest: `sha256:${"A".repeat(64)}`,
        bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      },
    ],
    [
      "unbounded version",
      {
        version: "x".repeat(81),
        imageDigest: `sha256:${"a".repeat(64)}`,
        bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      },
    ],
  ])("rejects %s release evidence safely", (_case, release) => {
    expect(
      validateRunnerHeartbeatPayload({
        runnerId: "00000000-0000-4000-8000-000000000130",
        release,
      }),
    ).toEqual({
      ok: false,
      reason: "invalid_payload",
      issues: [
        {
          field: "release",
          message: "Release identity must contain canonical bounded fields.",
        },
      ],
    });
  });
});

async function seedRunnerCredential(
  connection: DatabaseConnection,
  input: {
    credentialValue: string;
    runnerStatus: string;
    kind?: "manual_vps" | "digitalocean";
    endpointUrl?: string;
    provisioningStatus?: string;
    provisioningStartedAt?: Date;
    credentialOverrides?: Partial<typeof runnerCredentials.$inferInsert>;
  },
): Promise<{ id: string }> {
  const runner = await seedRunner(connection, {
    endpointUrl: input.endpointUrl ?? "https://runner.example.com",
    status: input.runnerStatus,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.provisioningStatus ? { provisioningStatus: input.provisioningStatus } : {}),
    ...(input.provisioningStartedAt ? { provisioningStartedAt: input.provisioningStartedAt } : {}),
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
    kind?: "manual_vps" | "digitalocean";
    provisioningStatus?: string;
    provisioningStartedAt?: Date;
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
      kind: input.kind ?? "manual_vps",
      endpointUrl: input.endpointUrl,
      status: input.status,
      ...(input.kind === "digitalocean"
        ? {
            provider: "digitalocean",
            region: "sfo3",
            sizeSlug: "s-1vcpu-1gb",
            image: "ubuntu-24-04-x64",
            provisioningStatus: input.provisioningStatus ?? "waiting_for_runner",
            provisioningStartedAt:
              input.provisioningStartedAt ?? new Date("2026-07-05T07:00:00.000Z"),
          }
        : {}),
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
  await connection.client`truncate table runner_provisioning_events, runner_heartbeats, runner_credentials, runner_registration_tokens, runners, app_metadata, users restart identity cascade`;
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
