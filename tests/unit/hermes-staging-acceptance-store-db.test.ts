import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { hermesStagingAcceptanceRuns, users } from "@/src/server/db/schema";
import {
  applyClaimedHermesStagingAcceptanceResult,
  attestHermesStagingAcceptanceChallenge,
  beginHermesStagingAcceptanceRun,
  type ClaimedHermesStagingAcceptanceRun,
  claimNextHermesStagingAcceptanceRun,
  HERMES_STAGING_ACCEPTANCE_LEASE_MS,
  type HermesStagingAcceptanceResultMutation,
  persistClaimedHermesStagingAcceptanceDecision,
  requestHermesStagingAcceptanceCleanup,
  toHermesStagingAcceptanceWorkflowState,
} from "@/src/server/staging/hermes-staging-acceptance-store";

const execFileAsync = promisify(execFile);
const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://bruno:bruno@127.0.0.1:54329/bruno";
const OWNER_ID = "00000000-0000-4000-8000-000000011001";
const NOW = new Date("2026-08-03T10:00:00.000Z");
const DEADLINE = new Date("2026-08-03T11:00:00.000Z");
const CLEANUP_DEADLINE = new Date("2026-08-03T12:00:00.000Z");
const LEASE_A = "staging-acceptance:11111111-1111-4111-8111-111111111111";
const LEASE_B = "staging-acceptance:22222222-2222-4222-8222-222222222222";

describe("Hermes staging acceptance durable store", () => {
  let databaseName: string;
  let databaseUrl: string;
  let connection: DatabaseConnection;

  beforeAll(async () => {
    ({ databaseName, databaseUrl } = await createDisposableDatabase());
    await runDbMigrate(databaseUrl);
    connection = createDatabaseConnection(databaseUrl);
  });

  beforeEach(async () => {
    await connection.db.execute(sql`
      truncate table hermes_staging_acceptance_runs, users restart identity cascade
    `);
    await connection.db.insert(users).values({ id: OWNER_ID });
  });

  afterAll(async () => {
    await connection?.close();
    if (databaseName) await dropDisposableDatabase(databaseName);
  });

  it("begins idempotently with exact immutable provenance and returns the one active run", async () => {
    const first = await begin(connection, "staging-acceptance-a");
    const duplicate = await begin(connection, "staging-acceptance-a");
    const blockedByActive = await begin(connection, "staging-acceptance-b");

    expect(first.disposition).toBe("created");
    expect(duplicate).toMatchObject({ disposition: "idempotent", run: { id: first.run.id } });
    expect(blockedByActive).toMatchObject({
      disposition: "active_exists",
      run: { id: first.run.id },
    });
    expect(first.run).toMatchObject({
      ownerUserId: OWNER_ID,
      expectedSourceRevision: "a".repeat(40),
      expectedPublishWorkflowRunId: "123456789",
      expectedImageDigest: digest("a"),
      desiredOutcome: "acceptance",
      phase: "preflight",
      state: "pending",
      generation: 0,
      leaseAttempt: 0,
    });

    await expect(
      beginHermesStagingAcceptanceRun({
        db: connection.db,
        ownerUserId: OWNER_ID,
        idempotencyKey: "staging-acceptance-a",
        expectedSourceRevision: "b".repeat(40),
        expectedPublishWorkflowRunId: "123456789",
        expectedImageDigest: digest("a"),
        deadlineAt: DEADLINE,
        cleanupDeadlineAt: CLEANUP_DEADLINE,
        now: NOW,
      }),
    ).rejects.toMatchObject({ name: "HermesStagingAcceptancePersistenceError" });
  });

  it("uses separate connections and SKIP LOCKED to grant one claim", async () => {
    await begin(connection, "staging-claim-race");
    const first = createDatabaseConnection(databaseUrl);
    const second = createDatabaseConnection(databaseUrl);
    const barrier = createBarrier(2);
    try {
      const [claimA, claimB] = await Promise.all([
        runAfterBarrier(barrier, () => claim(first, LEASE_A, NOW)),
        runAfterBarrier(barrier, () => claim(second, LEASE_B, NOW)),
      ]);
      const claims = [claimA, claimB].filter(
        (value): value is ClaimedHermesStagingAcceptanceRun => value !== null,
      );
      expect(claims).toHaveLength(1);
      const onlyClaim = claims[0];
      if (!onlyClaim) throw new Error("Expected exactly one claimed run.");
      expect(onlyClaim).toMatchObject({
        state: "executing",
        generation: 0,
        attemptCount: 0,
        leaseAttempt: 1,
      });
      expect(onlyClaim.leaseExpiresAt.getTime() - NOW.getTime()).toBe(
        HERMES_STAGING_ACCEPTANCE_LEASE_MS,
      );
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("persists the exact pending external effect before execution and recovers it after process death", async () => {
    await begin(connection, "staging-effect-fence");
    const claimed = await requiredClaim(connection, LEASE_A, NOW);
    const decisionAt = new Date(NOW.getTime() + 1_000);
    const pendingChallenge = {
      ...toHermesStagingAcceptanceWorkflowState(claimed),
      phase: "awaiting_initial_human_proof" as const,
      attemptCount: 1,
      pendingEffect: "issue_initial_human_challenge" as const,
      nextAttemptAtMs: decisionAt.getTime() + 15_000,
    };
    const fenced = await persistClaimedHermesStagingAcceptanceDecision({
      db: connection.db,
      claim: claimed,
      now: decisionAt,
      workflowState: pendingChallenge,
    });
    expect(fenced).toMatchObject({
      state: "executing",
      phase: "awaiting_initial_human_proof",
      challengePurpose: null,
      initialChallengeDigest: null,
      pendingEffect: "issue_initial_human_challenge",
      generation: 1,
      leaseAttempt: 1,
      leaseOwner: LEASE_A,
    });

    const takeoverAt = new Date(NOW.getTime() + HERMES_STAGING_ACCEPTANCE_LEASE_MS);
    const recovered = await requiredClaim(connection, LEASE_B, takeoverAt);
    expect(recovered).toMatchObject({
      phase: "awaiting_initial_human_proof",
      pendingEffect: "issue_initial_human_challenge",
      generation: 1,
      leaseAttempt: 2,
      leaseOwner: LEASE_B,
    });
    await expect(
      persistClaimedHermesStagingAcceptanceDecision({
        db: connection.db,
        claim: claimed,
        now: takeoverAt,
        workflowState: pendingChallenge,
      }),
    ).resolves.toBeNull();
  });

  it("allows one lease-expiry takeover and fences stale generation, attempt, and lease results", async () => {
    await begin(connection, "staging-takeover");
    const firstClaim = await requiredClaim(connection, LEASE_A, NOW);
    const expiry = new Date(NOW.getTime() + HERMES_STAGING_ACCEPTANCE_LEASE_MS);
    const secondClaim = await requiredClaim(connection, LEASE_B, expiry);
    expect(secondClaim.leaseAttempt).toBe(2);

    const resultAt = new Date(expiry.getTime() + 1_000);
    await expect(
      applyClaimedHermesStagingAcceptanceResult({
        db: connection.db,
        claim: firstClaim,
        now: resultAt,
        mutation: nextMutation(firstClaim, resultAt),
      }),
    ).resolves.toBe(false);
    const staleGeneration = { ...secondClaim, generation: secondClaim.generation + 1 };
    await expect(
      applyClaimedHermesStagingAcceptanceResult({
        db: connection.db,
        claim: staleGeneration,
        now: resultAt,
        mutation: nextMutation(staleGeneration, resultAt),
      }),
    ).resolves.toBe(false);
    const staleAttempt = { ...secondClaim, attemptCount: secondClaim.attemptCount + 1 };
    await expect(
      applyClaimedHermesStagingAcceptanceResult({
        db: connection.db,
        claim: staleAttempt,
        now: resultAt,
        mutation: nextMutation(staleAttempt, resultAt),
      }),
    ).resolves.toBe(false);
    await expect(
      applyClaimedHermesStagingAcceptanceResult({
        db: connection.db,
        claim: secondClaim,
        now: resultAt,
        mutation: nextMutation(secondClaim, resultAt),
      }),
    ).resolves.toBe(true);

    const [persisted] = await connection.db.select().from(hermesStagingAcceptanceRuns);
    expect(persisted).toMatchObject({
      state: "waiting",
      phase: "attesting_image",
      generation: 1,
      attemptCount: 1,
      leaseAttempt: 2,
      leaseOwner: null,
    });
    await expect(
      applyClaimedHermesStagingAcceptanceResult({
        db: connection.db,
        claim: secondClaim,
        now: new Date(resultAt.getTime() + 1_000),
        mutation: nextMutation(secondClaim, resultAt),
      }),
    ).resolves.toBe(false);
  });

  it("preempts a live claim with durable cleanup intent and invalidates its generation", async () => {
    const begun = await begin(connection, "staging-cancel");
    const claimed = await requiredClaim(connection, LEASE_A, NOW);
    const cancelledAt = new Date(NOW.getTime() + 1_000);
    const cleanup = await requestHermesStagingAcceptanceCleanup({
      db: connection.db,
      runId: begun.run.id,
      expectedGeneration: claimed.generation,
      now: cancelledAt,
    });
    expect(cleanup).toMatchObject({
      changed: true,
      run: {
        desiredOutcome: "cleanup",
        phase: "cleaning_workload",
        state: "pending",
        terminalOutcome: "cancelled",
        errorCode: "acceptance_cancelled",
        generation: 1,
        leaseOwner: null,
      },
    });
    await expect(
      applyClaimedHermesStagingAcceptanceResult({
        db: connection.db,
        claim: claimed,
        now: new Date(cancelledAt.getTime() + 1_000),
        mutation: nextMutation(claimed, cancelledAt),
      }),
    ).resolves.toBe(false);
    await expect(
      requestHermesStagingAcceptanceCleanup({
        db: connection.db,
        runId: begun.run.id,
        expectedGeneration: claimed.generation,
        now: new Date(cancelledAt.getTime() + 2_000),
      }),
    ).resolves.toMatchObject({ changed: false, run: { generation: 1 } });
  });

  it("persists two distinct bounded human proofs without storing message or user data", async () => {
    const begun = await begin(connection, "staging-proofs");
    const initialClaim = await requiredClaim(connection, LEASE_A, NOW);
    const initialChallenge = digest("b");
    const initialAttestation = digest("c");
    const initialAt = new Date(NOW.getTime() + 1_000);
    const initialExpiry = new Date(NOW.getTime() + 60_000);
    const initialWorkflow = {
      ...toHermesStagingAcceptanceWorkflowState(initialClaim),
      phase: "awaiting_initial_human_proof" as const,
      attemptCount: 1,
      nextAttemptAtMs: initialExpiry.getTime(),
      pendingEffect: null,
      initialChallengeDigest: initialChallenge,
      initialChallengeExpiresAtMs: initialExpiry.getTime(),
    };
    await expect(
      applyClaimedHermesStagingAcceptanceResult({
        db: connection.db,
        claim: initialClaim,
        now: initialAt,
        mutation: { workflowState: initialWorkflow, queueState: "waiting" },
      }),
    ).resolves.toBe(true);

    const initialProof = await attestHermesStagingAcceptanceChallenge({
      db: connection.db,
      runId: begun.run.id,
      expectedGeneration: 1,
      purpose: "initial",
      challengeDigest: initialChallenge,
      attestationDigest: initialAttestation,
      now: new Date(NOW.getTime() + 2_000),
    });
    expect(initialProof).toMatchObject({
      accepted: true,
      run: { phase: "restarting", generation: 2, initialHumanProofVerified: true },
    });

    const postClaim = await requiredClaim(connection, LEASE_B, new Date(NOW.getTime() + 2_000));
    const postChallenge = digest("d");
    const postAttestation = digest("e");
    const postAt = new Date(NOW.getTime() + 3_000);
    const postExpiry = new Date(NOW.getTime() + 90_000);
    const postWorkflow = {
      ...toHermesStagingAcceptanceWorkflowState(postClaim),
      phase: "awaiting_post_restart_human_proof" as const,
      attemptCount: 1,
      nextAttemptAtMs: postExpiry.getTime(),
      pendingEffect: null,
      postRestartChallengeDigest: postChallenge,
      postRestartChallengeExpiresAtMs: postExpiry.getTime(),
    };
    await expect(
      applyClaimedHermesStagingAcceptanceResult({
        db: connection.db,
        claim: postClaim,
        now: postAt,
        mutation: { workflowState: postWorkflow, queueState: "waiting" },
      }),
    ).resolves.toBe(true);
    const postProof = await attestHermesStagingAcceptanceChallenge({
      db: connection.db,
      runId: begun.run.id,
      expectedGeneration: 3,
      purpose: "post_restart",
      challengeDigest: postChallenge,
      attestationDigest: postAttestation,
      now: new Date(NOW.getTime() + 4_000),
    });
    expect(postProof).toMatchObject({
      accepted: true,
      run: {
        phase: "auditing_diagnostics",
        generation: 4,
        initialChallengeDigest: initialChallenge,
        initialAttestationDigest: initialAttestation,
        postRestartChallengeDigest: postChallenge,
        postRestartAttestationDigest: postAttestation,
        postRestartHumanProofVerified: true,
      },
    });
    await expect(
      attestHermesStagingAcceptanceChallenge({
        db: connection.db,
        runId: begun.run.id,
        expectedGeneration: 3,
        purpose: "post_restart",
        challengeDigest: postChallenge,
        attestationDigest: postAttestation,
        now: new Date(NOW.getTime() + 5_000),
      }),
    ).resolves.toMatchObject({ accepted: false, run: { generation: 4 } });
  });

  it("writes cleanup/image locators once and rejects direct or claimed replacement", async () => {
    await begin(connection, "staging-immutable");
    const firstClaim = await requiredClaim(connection, LEASE_A, NOW);
    const resultAt = new Date(NOW.getTime() + 1_000);
    const firstMutation = nextMutation(firstClaim, resultAt);
    firstMutation.evidence = {
      observedImageDigest: digest("a"),
      agentId: "00000000-0000-4000-8000-000000011101",
      deploymentId: "00000000-0000-4000-8000-000000011201",
      runnerId: "00000000-0000-4000-8000-000000011301",
      providerResourceId: "582999991",
      providerFirewallId: "11111111-1111-4111-8111-111111111111",
      hostImageVerifiedAt: resultAt,
    };
    await expect(
      applyClaimedHermesStagingAcceptanceResult({
        db: connection.db,
        claim: firstClaim,
        now: resultAt,
        mutation: firstMutation,
      }),
    ).resolves.toBe(true);

    await connection.db
      .update(hermesStagingAcceptanceRuns)
      .set({ nextAttemptAt: new Date(resultAt.getTime() + 1_000), state: "pending" })
      .where(eq(hermesStagingAcceptanceRuns.id, firstClaim.id));
    const secondClaim = await requiredClaim(
      connection,
      LEASE_B,
      new Date(resultAt.getTime() + 1_000),
    );
    const replacement = nextMutation(secondClaim, new Date(resultAt.getTime() + 2_000));
    replacement.evidence = { observedImageDigest: digest("f") };
    await expect(
      applyClaimedHermesStagingAcceptanceResult({
        db: connection.db,
        claim: secondClaim,
        now: new Date(resultAt.getTime() + 2_000),
        mutation: replacement,
      }),
    ).resolves.toBe(false);
    await expect(
      connection.client`
        update hermes_staging_acceptance_runs set provider_resource_id = 'foreign'
        where id = ${firstClaim.id}
      `,
    ).rejects.toMatchObject({
      constraint_name: "hermes_staging_acceptance_runs_immutable_check",
    });
  });
});

async function begin(connection: DatabaseConnection, idempotencyKey: string) {
  return beginHermesStagingAcceptanceRun({
    db: connection.db,
    ownerUserId: OWNER_ID,
    idempotencyKey,
    expectedSourceRevision: "a".repeat(40),
    expectedPublishWorkflowRunId: "123456789",
    expectedImageDigest: digest("a"),
    deadlineAt: DEADLINE,
    cleanupDeadlineAt: CLEANUP_DEADLINE,
    now: NOW,
  });
}

function nextMutation(
  claim: ClaimedHermesStagingAcceptanceRun,
  now: Date,
): HermesStagingAcceptanceResultMutation {
  return {
    workflowState: {
      ...toHermesStagingAcceptanceWorkflowState(claim),
      phase: "attesting_image",
      attemptCount: claim.attemptCount + 1,
      nextAttemptAtMs: now.getTime() + 15_000,
      pendingEffect: "attest_published_image",
    },
    queueState: "waiting",
  };
}

function claim(connection: DatabaseConnection, leaseOwner: string, now: Date) {
  return claimNextHermesStagingAcceptanceRun({
    db: connection.db,
    target: { kind: "global" },
    leaseOwner,
    now,
  });
}

async function requiredClaim(connection: DatabaseConnection, leaseOwner: string, now: Date) {
  const claimed = await claim(connection, leaseOwner, now);
  if (!claimed) throw new Error("Expected staging acceptance claim.");
  return claimed;
}

function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) release?.();
    await ready;
  };
}

async function runAfterBarrier<T>(barrier: () => Promise<void>, run: () => Promise<T>): Promise<T> {
  await barrier();
  return run();
}

async function createDisposableDatabase(): Promise<{
  databaseName: string;
  databaseUrl: string;
}> {
  const databaseName = `bruno_step10_store_${process.pid}_${Date.now()}`.toLowerCase();
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

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function validatedBaseUrl(): URL {
  const url = new URL(BASE_DATABASE_URL);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Staging store tests require loopback PostgreSQL.");
  }
  return url;
}

function adminDatabaseUrl(): string {
  const url = validatedBaseUrl();
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrlFor(database: string): string {
  const url = validatedBaseUrl();
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error("Invalid disposable database name.");
  return `"${value}"`;
}
