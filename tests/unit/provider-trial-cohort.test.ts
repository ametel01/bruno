import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import {
  beginProviderTrialSlot,
  buildProviderTrialCohortReport,
  createProviderTrialCohort,
  createSignedProviderTrialCohortReport,
  providerTrialDeploymentIdempotencyKey,
  recordProviderTrialRequestOutcome,
  recordProviderTrialTerminalOutcome,
  verifySignedProviderTrialCohortReport,
} from "@/src/server/agents/provider-trial-cohort";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agents,
  providerTrialCohorts,
  providerTrialSlots,
  users,
} from "@/src/server/db/schema";

const USER_ID = "00000000-0000-4000-8000-000000002801";
const AGENT_ID = "00000000-0000-4000-8000-000000002811";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000002821";
const OTHER_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000002822";
const THIRD_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000002823";
const FOURTH_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000002824";
const UNRELATED_REQUEST_ATTEMPT_ID = "00000000-0000-4000-8000-000000002831";

describe("Provider Trial Cohort ledger", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
    await seedOwner(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("creates all 30 immutable numbered slots before any request begins", async () => {
    const cohort = await createCohort(connection);
    const slots = await connection.db
      .select()
      .from(providerTrialSlots)
      .where(eq(providerTrialSlots.cohortId, cohort.id));

    expect(slots.map((slot) => slot.slotNumber).sort((left, right) => left - right)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );
    expect(slots.every((slot) => slot.requestStartedAt === null)).toBe(true);
    await expect(
      connection.db
        .update(providerTrialSlots)
        .set({
          requestAttemptId: UNRELATED_REQUEST_ATTEMPT_ID,
          requestStartedAt: new Date(),
        })
        .where(eq(providerTrialSlots.id, slots[0]?.id ?? "")),
    ).rejects.toMatchObject({
      cause: { constraint_name: "provider_trial_slots_request_start_boundary_check" },
    });
    await expect(
      connection.db
        .update(providerTrialSlots)
        .set({
          requestOutcome: "pre_commit_failure",
          requestSafeCode: "request_validation_failed",
          requestOutcomeRecordedAt: new Date(),
          terminalOutcome: "pre_commit_failure",
          terminalSafeCode: "request_validation_failed",
          terminalRecordedAt: new Date(),
        })
        .where(eq(providerTrialSlots.id, slots[0]?.id ?? "")),
    ).rejects.toMatchObject({
      cause: { constraint_name: "provider_trial_slots_request_outcome_after_start_check" },
    });

    const attempt = await beginProviderTrialSlot(connection, {
      cohortId: cohort.id,
      slotNumber: 1,
    });

    expect(attempt).toMatchObject({ cohortId: cohort.id, slotNumber: 1 });
    expect(attempt.requestAttemptId).toMatch(/^[0-9a-f-]{36}$/);

    await expect(
      connection.db
        .update(providerTrialSlots)
        .set({ slotNumber: 31 })
        .where(eq(providerTrialSlots.id, attempt.slotId)),
    ).rejects.toMatchObject({
      cause: { constraint_name: "provider_trial_slots_identity_immutable_check" },
    });
    await expect(
      connection.db.delete(providerTrialSlots).where(eq(providerTrialSlots.id, attempt.slotId)),
    ).rejects.toMatchObject({
      cause: { constraint_name: "provider_trial_slots_membership_immutable_check" },
    });
    await expect(
      connection.db.insert(providerTrialSlots).values({ cohortId: cohort.id, slotNumber: 31 }),
    ).rejects.toMatchObject({
      cause: { constraint_name: "provider_trial_slots_membership_immutable_check" },
    });
  });

  it("records one immutable pre-commit outcome without inventing a deployment", async () => {
    const cohort = await createCohort(connection);
    const attempt = await beginProviderTrialSlot(connection, {
      cohortId: cohort.id,
      slotNumber: 1,
    });

    const outcome = await recordProviderTrialRequestOutcome(connection, {
      ...attempt,
      outcome: "pre_commit_failure",
      safeCode: "request_validation_failed",
    });

    expect(outcome).toMatchObject({
      requestOutcome: "pre_commit_failure",
      deploymentId: null,
      terminalOutcome: "pre_commit_failure",
    });
    await expect(
      recordProviderTrialRequestOutcome(connection, {
        ...attempt,
        outcome: "pre_commit_failure",
        safeCode: "request_failed",
      }),
    ).rejects.toThrow(/request outcome has already been recorded/i);
    await expect(
      connection.db
        .update(providerTrialSlots)
        .set({ requestSafeCode: "rewritten" })
        .where(eq(providerTrialSlots.id, attempt.slotId)),
    ).rejects.toMatchObject({
      cause: { constraint_name: "provider_trial_slots_outcome_immutable_check" },
    });
  });

  it("rejects evidence-bearing slot inserts before a cohort starts", async () => {
    const cohort = await createCohort(connection);
    const [slot] = await connection.db
      .select()
      .from(providerTrialSlots)
      .where(eq(providerTrialSlots.cohortId, cohort.id))
      .limit(1);
    if (!slot) throw new Error("Provider Trial fixture has no slot to replace.");

    await connection.db.delete(providerTrialSlots).where(eq(providerTrialSlots.id, slot.id));

    await expect(
      connection.db.insert(providerTrialSlots).values({
        cohortId: cohort.id,
        slotNumber: slot.slotNumber,
        requestAttemptId: UNRELATED_REQUEST_ATTEMPT_ID,
        requestStartedAt: new Date(Date.now() + 1_000),
      }),
    ).rejects.toMatchObject({
      cause: { constraint_name: "provider_trial_slots_insert_evidence_check" },
    });

    await seedDeployment(connection, {
      id: DEPLOYMENT_ID,
      requestAttemptId: UNRELATED_REQUEST_ATTEMPT_ID,
      stage: "pending",
    });
    const requestStartedAt = new Date(Date.now() + 1_000);
    await expect(
      connection.db.insert(providerTrialSlots).values({
        cohortId: cohort.id,
        slotNumber: slot.slotNumber,
        requestAttemptId: UNRELATED_REQUEST_ATTEMPT_ID,
        requestStartedAt,
        requestOutcome: "committed",
        requestOutcomeRecordedAt: new Date(requestStartedAt.getTime() + 1_000),
        deploymentId: DEPLOYMENT_ID,
      }),
    ).rejects.toMatchObject({
      cause: { constraint_name: "provider_trial_slots_insert_evidence_check" },
    });

    await expect(
      connection.db.insert(providerTrialSlots).values({
        cohortId: cohort.id,
        slotNumber: slot.slotNumber,
      }),
    ).resolves.toBeDefined();
  });

  it("links a committed request to its exact operator-trial deployment and retains its terminal outcome", async () => {
    const cohort = await createCohort(connection);
    const attempt = await beginProviderTrialSlot(connection, {
      cohortId: cohort.id,
      slotNumber: 2,
    });
    await seedDeployment(connection, {
      id: DEPLOYMENT_ID,
      requestAttemptId: attempt.requestAttemptId,
      stage: "ready",
      completedAt: new Date("2026-08-08T10:00:30.000Z"),
    });

    await expect(
      recordProviderTrialRequestOutcome(connection, {
        ...attempt,
        outcome: "committed",
        deploymentId: DEPLOYMENT_ID,
      }),
    ).resolves.toMatchObject({ requestOutcome: "committed", deploymentId: DEPLOYMENT_ID });
    await expect(
      recordProviderTrialTerminalOutcome(connection, {
        ...attempt,
        outcome: "observe_deployment",
      }),
    ).resolves.toMatchObject({ terminalOutcome: "ready_within_objective" });
  });

  it("rejects links to non-trial or wrong-generation deployments", async () => {
    const cohort = await createCohort(connection);
    const first = await beginProviderTrialSlot(connection, {
      cohortId: cohort.id,
      slotNumber: 1,
    });
    const second = await beginProviderTrialSlot(connection, {
      cohortId: cohort.id,
      slotNumber: 2,
    });
    const third = await beginProviderTrialSlot(connection, {
      cohortId: cohort.id,
      slotNumber: 3,
    });
    await seedDeployment(connection, {
      id: DEPLOYMENT_ID,
      requestAttemptId: first.requestAttemptId,
      origin: "owner_request",
    });
    await seedDeployment(connection, {
      id: OTHER_DEPLOYMENT_ID,
      requestAttemptId: second.requestAttemptId,
      rolloutConfigurationGeneration: 8,
    });
    await seedDeployment(connection, {
      id: THIRD_DEPLOYMENT_ID,
      requestAttemptId: UNRELATED_REQUEST_ATTEMPT_ID,
    });

    await expect(
      recordProviderTrialRequestOutcome(connection, {
        ...first,
        outcome: "committed",
        deploymentId: DEPLOYMENT_ID,
      }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/operator-trial deployment/i) },
    });
    await expect(
      recordProviderTrialRequestOutcome(connection, {
        ...second,
        outcome: "committed",
        deploymentId: OTHER_DEPLOYMENT_ID,
      }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/Rollout Configuration generation/i) },
    });
    await expect(
      recordProviderTrialRequestOutcome(connection, {
        ...third,
        outcome: "committed",
        deploymentId: THIRD_DEPLOYMENT_ID,
      }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/exact request attempt/i) },
    });
  });

  it("allows only one concurrent request start for a numbered slot", async () => {
    const cohort = await createCohort(connection);
    const secondConnection = createDatabaseConnection();

    try {
      const results = await Promise.allSettled([
        beginProviderTrialSlot(connection, { cohortId: cohort.id, slotNumber: 1 }),
        beginProviderTrialSlot(secondConnection, { cohortId: cohort.id, slotNumber: 1 }),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        reason: expect.objectContaining({ message: expect.stringMatching(/already started/i) }),
      });
    } finally {
      await secondConnection.close();
    }
  });

  it("serializes cohort start against concurrent slot deletion", async () => {
    const cohort = await createCohort(connection);
    const [slot] = await connection.db
      .select()
      .from(providerTrialSlots)
      .where(eq(providerTrialSlots.cohortId, cohort.id))
      .limit(1);
    const secondConnection = createDatabaseConnection();
    const observerConnection = createDatabaseConnection();
    const [backend] = await secondConnection.client<
      { pid: number }[]
    >`select pg_backend_pid() as pid`;
    if (!backend) throw new Error("Could not identify the concurrent database connection.");
    let releaseStart!: () => void;
    const holdStart = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let startLocked!: () => void;
    const startHasLock = new Promise<void>((resolve) => {
      startLocked = resolve;
    });

    try {
      const start = connection.db.transaction(async (tx) => {
        await tx
          .update(providerTrialCohorts)
          .set({ startedAt: new Date() })
          .where(eq(providerTrialCohorts.id, cohort.id));
        startLocked();
        await holdStart;
      });
      await startHasLock;
      const deletion = (async () =>
        await secondConnection.db
          .delete(providerTrialSlots)
          .where(eq(providerTrialSlots.id, slot?.id ?? "")))();

      await waitForDatabaseLock(observerConnection, backend.pid);

      releaseStart();
      await start;
      await expect(deletion).rejects.toMatchObject({
        cause: { constraint_name: "provider_trial_slots_membership_immutable_check" },
      });
    } finally {
      releaseStart();
      await observerConnection.close();
      await secondConnection.close();
    }
  });

  it("derives slow and failed terminal outcomes from durable deployment evidence", async () => {
    const cohort = await createCohort(connection);
    const slowAttempt = await beginProviderTrialSlot(connection, {
      cohortId: cohort.id,
      slotNumber: 4,
    });
    await seedDeployment(connection, {
      id: DEPLOYMENT_ID,
      requestAttemptId: slowAttempt.requestAttemptId,
      stage: "ready",
      completedAt: new Date("2026-08-08T10:05:00.001Z"),
    });
    await recordProviderTrialRequestOutcome(connection, {
      ...slowAttempt,
      outcome: "committed",
      deploymentId: DEPLOYMENT_ID,
    });

    const failedAttempt = await beginProviderTrialSlot(connection, {
      cohortId: cohort.id,
      slotNumber: 5,
    });
    await seedDeployment(connection, {
      id: FOURTH_DEPLOYMENT_ID,
      requestAttemptId: failedAttempt.requestAttemptId,
    });
    await recordProviderTrialRequestOutcome(connection, {
      ...failedAttempt,
      outcome: "committed",
      deploymentId: FOURTH_DEPLOYMENT_ID,
    });

    await expect(
      recordProviderTrialTerminalOutcome(connection, {
        ...slowAttempt,
        outcome: "timed_out",
      }),
    ).resolves.toMatchObject({ terminalOutcome: "ready_after_objective" });
    await expect(
      recordProviderTrialTerminalOutcome(connection, {
        ...failedAttempt,
        outcome: "observe_deployment",
      }),
    ).resolves.toMatchObject({ terminalOutcome: "deployment_failed" });
  });

  it("reports API acceptance separately from failure-inclusive ready-within-objective results", async () => {
    const cohort = await createCohort(connection);

    const failedAttempt = await beginProviderTrialSlot(connection, {
      cohortId: cohort.id,
      slotNumber: 1,
    });
    await recordProviderTrialRequestOutcome(connection, {
      ...failedAttempt,
      outcome: "pre_commit_failure",
      safeCode: "request_validation_failed",
    });

    const committedAttempt = await beginProviderTrialSlot(connection, {
      cohortId: cohort.id,
      slotNumber: 2,
    });
    await seedDeployment(connection, {
      id: DEPLOYMENT_ID,
      requestAttemptId: committedAttempt.requestAttemptId,
      stage: "ready",
      completedAt: new Date("2026-08-08T10:00:30.000Z"),
    });
    await recordProviderTrialRequestOutcome(connection, {
      ...committedAttempt,
      outcome: "committed",
      deploymentId: DEPLOYMENT_ID,
    });
    await recordProviderTrialTerminalOutcome(connection, {
      ...committedAttempt,
      outcome: "observe_deployment",
    });

    const pendingAttempt = await beginProviderTrialSlot(connection, {
      cohortId: cohort.id,
      slotNumber: 3,
    });
    await seedDeployment(connection, {
      id: OTHER_DEPLOYMENT_ID,
      requestAttemptId: pendingAttempt.requestAttemptId,
      stage: "pending",
    });
    await recordProviderTrialRequestOutcome(connection, {
      ...pendingAttempt,
      outcome: "committed",
      deploymentId: OTHER_DEPLOYMENT_ID,
    });

    const report = await buildProviderTrialCohortReport(connection, cohort.id, {
      generatedAt: new Date("2026-08-08T12:00:00.000Z"),
    });

    expect(report.apiAcceptance).toEqual({
      totalSlots: 30,
      committed: 2,
      preCommitFailures: 1,
      pending: 27,
      availability: 2 / 30,
    });
    expect(report.readiness).toMatchObject({
      totalSlots: 30,
      committed: 2,
      objectiveSeconds: 300,
      readyWithinObjective: 1,
      allSlotMisses: 1,
      pending: 28,
      committedPassRate: 0.5,
      passesGate: false,
    });
    expect(report.slots.map((slot) => slot.slotNumber)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );
  });

  it("signs deterministic sanitized reports and rejects tampering", async () => {
    const cohort = await createCohort(connection);
    const report = await buildProviderTrialCohortReport(connection, cohort.id, {
      generatedAt: new Date("2026-08-08T12:00:00.000Z"),
    });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const signed = createSignedProviderTrialCohortReport({
      report,
      keyId: "provider-trial-report-2026-08",
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();

    expect(() =>
      createSignedProviderTrialCohortReport({
        report: {
          ...report,
          apiAcceptance: { ...report.apiAcceptance, committed: 1 },
        },
        keyId: "provider-trial-report-2026-08",
        privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      }),
    ).toThrow(/report_invalid/);
    expect(() =>
      createSignedProviderTrialCohortReport({
        report: {
          ...report,
          apiAcceptance: {
            totalSlots: 30,
            committed: 0,
            preCommitFailures: 1,
            pending: 29,
            availability: 0,
          },
          readiness: {
            totalSlots: 30,
            committed: 0,
            objectiveSeconds: 300,
            readyWithinObjective: 0,
            allSlotMisses: 1,
            pending: 29,
            committedPassRate: 0,
            passesGate: false,
          },
          slots: report.slots.map((slot, index) =>
            index === 0
              ? {
                  ...slot,
                  requestOutcome: "pre_commit_failure",
                  requestSafeCode: "lowercasecredentialvalue",
                  terminalOutcome: "pre_commit_failure",
                  terminalSafeCode: "lowercasecredentialvalue",
                }
              : slot,
          ),
        } as unknown as typeof report,
        keyId: "provider-trial-report-2026-08",
        privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      }),
    ).toThrow(/report_invalid/);
    expect(() =>
      createSignedProviderTrialCohortReport({
        report: {
          ...report,
          slots: report.slots.map((slot, index) =>
            index === 0 ? { ...slot, deploymentId: DEPLOYMENT_ID } : slot,
          ),
        },
        keyId: "provider-trial-report-2026-08",
        privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      }),
    ).toThrow(/report_invalid/);

    expect(verifySignedProviderTrialCohortReport({ ...signed, publicKeyPem })).toMatchObject({
      ok: true,
      digest: signed.digest,
    });
    expect(
      verifySignedProviderTrialCohortReport({
        ...signed,
        canonicalBytes: signed.canonicalBytes.replace('"pending":30', '"pending":29'),
        publicKeyPem,
      }),
    ).toEqual({ ok: false, reason: "report_invalid" });
    expect(signed.canonicalBytes).not.toMatch(
      /owner|userId|telegram|token|credential|endpoint|requestAttemptId/i,
    );
  });
});

async function createCohort(connection: DatabaseConnection) {
  return await createProviderTrialCohort(connection, {
    cohortKey: "provider-trial-sfo3-2026-08",
    region: "sfo3",
    runnerSizeSlug: "s-1vcpu-2gb",
    rolloutConfigurationGeneration: 7,
  });
}

async function seedOwner(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(users).values({ id: USER_ID });
  await connection.db.insert(agents).values({
    id: AGENT_ID,
    userId: USER_ID,
    name: "Provider trial fixture",
    templateKey: "research_agent",
    templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
  });
}

async function seedDeployment(
  connection: DatabaseConnection,
  input: {
    id: string;
    requestAttemptId: string;
    origin?: "owner_request" | "operator_trial";
    rolloutConfigurationGeneration?: number;
    stage?: "failed" | "pending" | "ready";
    completedAt?: Date;
  },
): Promise<void> {
  const stage = input.stage ?? "failed";
  await connection.db.insert(agentDeployments).values({
    id: input.id,
    agentId: AGENT_ID,
    userId: USER_ID,
    configRevision: `cfg-${input.id.slice(-4)}`,
    idempotencyKey: providerTrialDeploymentIdempotencyKey(input.requestAttemptId),
    origin: input.origin ?? "operator_trial",
    initialCohort: "cold_deployment",
    deploymentEnvironment: "non_production",
    rolloutConfigurationGeneration: input.rolloutConfigurationGeneration ?? 7,
    stage,
    acceptedAt: new Date("2026-08-08T10:00:00.000Z"),
    ...(stage === "failed"
      ? {
          errorCode: "fixture_terminal",
          failedAt: new Date("2026-08-08T10:00:30.000Z"),
        }
      : {}),
    ...(stage === "ready"
      ? {
          runnerOperationId: "00000000-0000-4000-8000-000000002899",
          runnerAcceptedAt: new Date("2026-08-08T10:00:01.000Z"),
          canaryState: "skipped",
          completedAt: input.completedAt,
        }
      : {}),
  });
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`
    truncate table provider_trial_slots, provider_trial_cohorts, agent_deployments, agents, users
    restart identity cascade
  `;
}

async function waitForDatabaseLock(connection: DatabaseConnection, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [activity] = await connection.client<{ waitEventType: string | null }[]>`
      select wait_event_type as "waitEventType"
      from pg_stat_activity
      where pid = ${pid}
    `;
    if (activity?.waitEventType === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Concurrent slot mutation did not wait on the cohort lock.");
}
