import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeploymentReplacementBudgets,
  agentDeployments,
  agents,
  runnerReplacements,
  runners,
  users,
} from "@/src/server/db/schema";
import {
  applyClaimedRunnerReplacementTransition,
  claimNextRunnerReplacement,
  createOrGetRunnerReplacement,
  reserveClaimedRunnerReplacementBudget,
  RUNNER_REPLACEMENT_LEASE_MS,
  RunnerReplacementPersistenceError,
} from "@/src/server/runners/runner-replacement-store";

const execFileAsync = promisify(execFile);
const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://agentbay:agentbay@127.0.0.1:54329/plingpling";
const USER_ID = "00000000-0000-4000-8000-000000005001";
const SOURCE_ID = "00000000-0000-4000-8000-000000005101";
const TARGET_ID = "00000000-0000-4000-8000-000000005102";
const MANUAL_ID = "00000000-0000-4000-8000-000000005103";
const AGENT_ID = "00000000-0000-4000-8000-000000005201";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000005301";
const RUNNER_OPERATION_ID = "00000000-0000-4000-8000-000000005401";
const LEASE_A = "runner-replacement:11111111-1111-4111-8111-111111111111";
const LEASE_B = "runner-replacement:22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-04T08:00:00.000Z");

describe("runner replacement persistence", () => {
  let databaseName: string;
  let databaseUrl: string;
  let connection: DatabaseConnection;

  beforeAll(async () => {
    ({ databaseName, databaseUrl } = await createDisposableDatabase());
    await runDbMigrate(databaseUrl);
    connection = createDatabaseConnection(databaseUrl);
  });

  beforeEach(async () => {
    await resetFixture(connection);
    await seedFixture(connection);
  });

  afterAll(async () => {
    await connection?.close();
    if (databaseName) await dropDisposableDatabase(databaseName);
  });

  it("converges concurrent duplicate triggers on one active source workflow", async () => {
    const competingConnections = Array.from({ length: 3 }, () =>
      createDatabaseConnection(databaseUrl),
    );
    try {
      const triggers = await Promise.all(
        [connection, ...competingConnections].map((triggerConnection, index) =>
          createReplacement(triggerConnection, String(index + 1)),
        ),
      );

      expect(triggers.filter((trigger) => trigger.created)).toHaveLength(1);
      expect(new Set(triggers.map((trigger) => trigger.replacement.id))).toHaveProperty("size", 1);
      await expect(connection.db.select().from(runnerReplacements)).resolves.toHaveLength(1);
    } finally {
      await Promise.all(competingConnections.map((triggerConnection) => triggerConnection.close()));
    }
  });

  it("claims once, rejects a live competing lease, and permits exact-expiry takeover", async () => {
    await createReplacement(connection, "1");
    const first = await claimRequired(connection, LEASE_A, NOW);
    expect(first).toMatchObject({ state: "pending", attemptCount: 1, leaseOwner: LEASE_A });

    await expect(
      claimNextRunnerReplacement({
        db: connection.db,
        target: { kind: "source", sourceRunnerId: SOURCE_ID },
        leaseOwner: LEASE_B,
        now: new Date(NOW.getTime() + RUNNER_REPLACEMENT_LEASE_MS - 1),
      }),
    ).resolves.toBeNull();

    await expect(
      claimNextRunnerReplacement({
        db: connection.db,
        target: { kind: "source", sourceRunnerId: SOURCE_ID },
        leaseOwner: LEASE_B,
        now: new Date(NOW.getTime() + RUNNER_REPLACEMENT_LEASE_MS),
      }),
    ).resolves.toMatchObject({ attemptCount: 2, leaseOwner: LEASE_B });
  });

  it("applies one generation-fenced transition and resumes after process death", async () => {
    await createReplacement(connection, "1");
    const claim = await claimRequired(connection, LEASE_A, NOW);
    const appliedAt = new Date(NOW.getTime() + 1_000);

    await expect(
      applyClaimedRunnerReplacementTransition({
        db: connection.db,
        claim,
        action: { kind: "advance" },
        now: appliedAt,
      }),
    ).resolves.toBe(true);
    await expect(
      applyClaimedRunnerReplacementTransition({
        db: connection.db,
        claim,
        action: { kind: "advance" },
        now: appliedAt,
      }),
    ).resolves.toBe(false);

    await expect(claimRequired(connection, LEASE_B, appliedAt)).resolves.toMatchObject({
      state: "provisioning_target",
      generation: 1,
      attemptCount: 2,
    });
  });

  it("can resume after every committed state and reach one terminal completion", async () => {
    const created = await createReplacement(connection, "1");
    let now = NOW;

    for (let step = 0; step < 7; step += 1) {
      const claim = await claimRequired(connection, step % 2 === 0 ? LEASE_A : LEASE_B, now);
      const action =
        claim.state === "provisioning_target"
          ? ({ kind: "advance", targetRunnerId: TARGET_ID } as const)
          : ({ kind: "advance" } as const);
      now = new Date(now.getTime() + 1_000);
      await expect(
        applyClaimedRunnerReplacementTransition({
          db: connection.db,
          claim,
          action,
          now,
        }),
      ).resolves.toBe(true);
    }

    const [workflow] = await connection.db
      .select()
      .from(runnerReplacements)
      .where(eq(runnerReplacements.id, created.replacement.id));
    expect(workflow).toMatchObject({
      state: "complete",
      generation: 7,
      attemptCount: 7,
      targetRunnerId: TARGET_ID,
      nextAttemptAt: null,
      leaseOwner: null,
      completedAt: now,
    });
    await expect(
      claimNextRunnerReplacement({
        db: connection.db,
        target: { kind: "replacement", replacementId: created.replacement.id },
        leaseOwner: LEASE_A,
        now,
      }),
    ).resolves.toBeNull();
  });

  it("keeps billable replacements separate from claims and enforces two per deployment window", async () => {
    await createReplacement(connection, "1");
    const claim = await claimRequired(connection, LEASE_A, NOW);

    await expect(
      reserveClaimedRunnerReplacementBudget({ connection, claim, now: NOW }),
    ).resolves.toEqual({ reserved: true, replacementCount: 1 });
    await expect(
      reserveClaimedRunnerReplacementBudget({
        connection,
        claim,
        now: new Date(NOW.getTime() + 1_000),
      }),
    ).resolves.toEqual({ reserved: true, replacementCount: 2 });
    await expect(
      reserveClaimedRunnerReplacementBudget({
        connection,
        claim,
        now: new Date(NOW.getTime() + 2_000),
      }),
    ).resolves.toEqual({ reserved: false, replacementCount: 2 });

    const [workflow] = await connection.db.select().from(runnerReplacements);
    expect(workflow).toMatchObject({
      state: "failed",
      attemptCount: 1,
      replacementCount: 2,
      terminalCode: "replacement_budget_exhausted",
      terminalSummary: "Automatic runner replacement budget was exhausted.",
      leaseOwner: null,
    });
  });

  it("serializes concurrent billable reservations against one deployment budget", async () => {
    await createReplacement(connection, "1");
    const claim = await claimRequired(connection, LEASE_A, NOW);
    const second = createDatabaseConnection(databaseUrl);
    try {
      const reservations = await Promise.all([
        reserveClaimedRunnerReplacementBudget({ connection, claim, now: NOW }),
        reserveClaimedRunnerReplacementBudget({ connection: second, claim, now: NOW }),
      ]);
      expect(reservations.map((reservation) => reservation.replacementCount).sort()).toEqual([
        1, 2,
      ]);
      expect(reservations.every((reservation) => reservation.reserved)).toBe(true);

      await expect(
        reserveClaimedRunnerReplacementBudget({ connection, claim, now: NOW }),
      ).resolves.toEqual({ reserved: false, replacementCount: 2 });
    } finally {
      await second.close();
    }
  });

  it("resets the deployment budget only after the full 24-hour window", async () => {
    await createReplacement(connection, "1");
    const claim = await claimRequired(connection, LEASE_A, NOW);
    await reserveClaimedRunnerReplacementBudget({ connection, claim, now: NOW });
    await reserveClaimedRunnerReplacementBudget({
      connection,
      claim,
      now: new Date(NOW.getTime() + 1_000),
    });
    await applyClaimedRunnerReplacementTransition({
      db: connection.db,
      claim: { ...claim, replacementCount: 2 },
      action: { kind: "fail", code: "target_provisioning_failed" },
      now: new Date(NOW.getTime() + 2_000),
    });

    const result = await createReplacement(connection, "2", new Date(NOW.getTime() + 86_400_001));
    const nextClaim = await claimRequired(
      connection,
      LEASE_B,
      new Date(NOW.getTime() + 86_400_001),
    );
    expect(result.created).toBe(true);
    await expect(
      reserveClaimedRunnerReplacementBudget({
        connection,
        claim: nextClaim,
        now: new Date(NOW.getTime() + 86_400_001),
      }),
    ).resolves.toEqual({ reserved: true, replacementCount: 1 });
  });

  it("rejects a missing source and invalid operation data without creating rows", async () => {
    await expect(
      createOrGetRunnerReplacement({
        db: connection.db,
        sourceRunnerId: MANUAL_ID,
        triggerDeploymentId: DEPLOYMENT_ID,
        reason: "gateway_deadline",
        operationKey: operationKey("1"),
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(RunnerReplacementPersistenceError);
    await expect(connection.db.select().from(runnerReplacements)).resolves.toHaveLength(0);
  });

  it("enforces terminal, ownership, operation, lease, and budget constraints in PostgreSQL", async () => {
    const created = await createReplacement(connection, "1");

    await expect(
      connection.db.execute(sql`
        update runner_replacements
        set state = 'failed', next_attempt_at = null
        where id = ${created.replacement.id}
      `),
    ).rejects.toMatchObject({
      cause: { constraint_name: "runner_replacements_terminal_state_check" },
    });
    await expect(
      connection.db.execute(sql`
        update runner_replacements
        set state = 'failed', next_attempt_at = null,
            terminal_code = 'target_validation_failed',
            terminal_summary = 'raw provider error with credential material',
            failed_at = ${NOW.toISOString()}
        where id = ${created.replacement.id}
      `),
    ).rejects.toMatchObject({
      cause: { constraint_name: "runner_replacements_terminal_evidence_check" },
    });
    await expect(
      connection.db.execute(sql`
        update runner_replacements set operation_key = 'hostile' where id = ${created.replacement.id}
      `),
    ).rejects.toMatchObject({
      cause: { constraint_name: "runner_replacements_operation_key_check" },
    });
    await expect(
      connection.db.execute(sql`
        update runner_replacements set lease_owner = ${LEASE_A} where id = ${created.replacement.id}
      `),
    ).rejects.toMatchObject({
      cause: { constraint_name: "runner_replacements_lease_pair_check" },
    });
    await expect(
      connection.db.insert(agentDeploymentReplacementBudgets).values({
        deploymentId: DEPLOYMENT_ID,
        windowStartedAt: NOW,
        replacementCount: 3,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).rejects.toMatchObject({
      cause: { constraint_name: "agent_deployment_replacement_budgets_count_check" },
    });
  });
});

async function createReplacement(connection: DatabaseConnection, suffix: string, now = NOW) {
  return createOrGetRunnerReplacement({
    db: connection.db,
    sourceRunnerId: SOURCE_ID,
    triggerDeploymentId: DEPLOYMENT_ID,
    reason: "gateway_deadline",
    operationKey: operationKey(suffix),
    now,
  });
}

async function claimRequired(connection: DatabaseConnection, leaseOwner: string, now: Date) {
  const claim = await claimNextRunnerReplacement({
    db: connection.db,
    target: { kind: "source", sourceRunnerId: SOURCE_ID },
    leaseOwner,
    now,
  });
  if (!claim) throw new Error("Expected a runner replacement claim.");
  return claim;
}

function operationKey(suffix: string): string {
  return `agentbay-replace-${suffix.padStart(32, "0")}`;
}

async function resetFixture(connection: DatabaseConnection): Promise<void> {
  await connection.db.execute(sql`
    truncate table agent_deployment_replacement_budgets, runner_replacements,
      agent_runtime_reconciliations, agent_events, agent_usage_periods,
      agent_deployments, agent_secrets, agent_configs, agent_approvals,
      agent_logs, docker_runner_containers, local_runner_processes,
      runner_heartbeats, runner_credentials, runner_registration_tokens,
      runner_provisioning_events, backups, agents, runners, users restart identity cascade
  `);
}

async function seedFixture(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(users).values({ id: USER_ID, createdAt: NOW, updatedAt: NOW });
  await connection.db.insert(runners).values([
    {
      id: SOURCE_ID,
      userId: USER_ID,
      name: "Source runner",
      kind: "digitalocean",
      status: "online",
      provider: "digitalocean",
      region: "sfo3",
      sizeSlug: "s-1vcpu-2gb",
      image: `ghcr.io/example/runner@sha256:${"1".repeat(64)}`,
      provisioningStatus: "ready",
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: TARGET_ID,
      userId: USER_ID,
      name: "Target runner",
      kind: "digitalocean",
      status: "online",
      provider: "digitalocean",
      region: "sfo3",
      sizeSlug: "s-1vcpu-2gb",
      image: `ghcr.io/example/runner@sha256:${"2".repeat(64)}`,
      provisioningStatus: "ready",
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: MANUAL_ID,
      userId: USER_ID,
      name: "Manual non-source runner",
      kind: "manual_vps",
      endpointUrl: "http://127.0.0.1:3045",
      status: "online",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  await connection.db.insert(agents).values({
    id: AGENT_ID,
    userId: USER_ID,
    runnerId: SOURCE_ID,
    name: "Replacement fixture agent",
    templateKey: "research_agent",
    templateVersion: "1.0.0",
    status: "running",
    desiredStatus: "running",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await connection.db.insert(agentDeployments).values({
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    userId: USER_ID,
    stage: "ready",
    configRevision: "cfg-replacement-test",
    idempotencyKey: "replacement-test-deployment",
    runnerOperationId: RUNNER_OPERATION_ID,
    runnerAcceptedAt: NOW,
    canaryState: "passed",
    canaryAttemptedAt: NOW,
    canaryCompletedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function createDisposableDatabase(): Promise<{
  databaseName: string;
  databaseUrl: string;
}> {
  const databaseName = `plingpling_runner_replacement_${process.pid}_${Date.now()}`.toLowerCase();
  const admin = postgres(adminDatabaseUrl(), { max: 1 });
  try {
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
  } finally {
    await admin.end();
  }
  return { databaseName, databaseUrl: databaseUrlFor(databaseName) };
}

async function dropDisposableDatabase(databaseName: string): Promise<void> {
  const admin = postgres(adminDatabaseUrl(), { max: 1 });
  try {
    await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
  } finally {
    await admin.end();
  }
}

async function runDbMigrate(databaseUrl: string): Promise<void> {
  await execFileAsync("bun", ["run", "db:migrate"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 30_000,
  });
}

function validatedBaseUrl(): URL {
  const parsed = new URL(BASE_DATABASE_URL);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Runner replacement tests require loopback PostgreSQL.");
  }
  return parsed;
}

function adminDatabaseUrl(): string {
  const url = validatedBaseUrl();
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrlFor(databaseName: string): string {
  const url = validatedBaseUrl();
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error("Disposable runner replacement database name is invalid.");
  }
  return `"${value}"`;
}
