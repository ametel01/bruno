import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestGoogleConnectedAcceptanceRelease } from "@/scripts/founder-google-test-release";
import { buildTestOpenAiConnectedAcceptanceRelease } from "@/scripts/founder-openai-test-release";
import { FakeBackupObjectStorage } from "@/src/server/backups/backup-storage";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  appMetadata,
  founderGeneralReleaseActivations,
  founderInfrastructureRetirements,
  founderRecoveryArchiveDeletionReceipts,
  founderRecoveryArchives,
  founderReleaseDecisions,
  operatorPreparations,
  operatorRuntimes,
  operators,
  runners,
  users,
} from "@/src/server/db/schema";
import { expireFounderRecoveryArchivesForUser } from "@/src/server/founder-product-contract/archive-expiry";
import { EncryptedFounderRecoveryArchiveProvider } from "@/src/server/founder-product-contract/encrypted-recovery-archive-provider";
import { admitFounderOperatorToOwnerPreview } from "@/src/server/founder-product-contract/owner-preview-admission";
import {
  assessFounderOwnerPreviewPromotionEvidenceForUser,
  FOUNDER_OWNER_PREVIEW_PROMOTION_EVIDENCE_SCHEMA,
} from "@/src/server/founder-product-contract/owner-preview-promotion";
import {
  FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY,
  persistFounderOwnerPreviewDenialInTransaction,
} from "@/src/server/founder-product-contract/owner-preview-release-decision";
import {
  createDurableRecoveryArchive,
  getFounderRecoveryArchiveStatusForUser,
  persistFounderRecoveryArchiveIntentInTransaction,
  reconcileFounderRecoveryArchives,
} from "@/src/server/founder-product-contract/recovery-archive";
import { FOUNDER_RECOVERY_ARCHIVE_PAUSE_REASON } from "@/src/server/founder-product-contract/recovery-archive-provider";
import {
  getFounderOwnerPreviewAccessForUser,
  requireFounderOwnerPreviewAccessForUser,
} from "@/src/server/founder-product-contract/release-stage-access";
import { persistFounderOwnerPreviewHoldInTransaction } from "@/src/server/founder-product-contract/release-stage-hold";
import { withFounderOwnerPreviewWorkAuthority } from "@/src/server/founder-product-contract/work-authority";
import { prepareFounderOperatorRuntimeForUser } from "@/src/server/operators/founder-operator-runtime";

const USER_ID = "00000000-0000-4000-8000-000000003730";
const OPERATOR_ID = "00000000-0000-4000-8000-000000003731";
const APPLICATION_REVISION = "a".repeat(40);
const START = new Date("2026-08-22T00:00:00.000Z");
const QUALIFICATION_EXPIRES_AT = new Date(START.valueOf() + 8 * 24 * 60 * 60 * 1_000);

describe("persisted Founder Recovery Archive lifecycle", () => {
  let connection: DatabaseConnection;
  let storage: FakeBackupObjectStorage;
  let provider: EncryptedFounderRecoveryArchiveProvider;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    storage = new FakeBackupObjectStorage("founder-recovery-test");
    provider = new EncryptedFounderRecoveryArchiveProvider({
      storage,
      masterKey: new Uint8Array(32).fill(73),
    });
    await reset();
    await seedReadyOwnerPreviewCandidate();
  });

  afterEach(async () => {
    await reset();
    await connection.close();
  });

  it("fails Owner Preview admission closed unless a current v1 restore has rebuilt durable state", async () => {
    const archiveId = await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      provider,
      connection,
      () => START,
    );

    const [archive] = await connection.db
      .select()
      .from(founderRecoveryArchives)
      .where(eq(founderRecoveryArchives.id, archiveId));
    expect(archive).toMatchObject({
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      applicationRevision: APPLICATION_REVISION,
      runtimeRevision: "runtime-v1",
      status: "verified",
      formatVersion: 1,
      restorableVerified: true,
      restoreVerifiedAt: START,
      failureCode: null,
    });
    expect(archive?.stateDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(archive?.recoveryCredentialObjectKey).toBe(
      `founder-recovery/${USER_ID}/${archiveId}.key`,
    );

    const status = await getFounderRecoveryArchiveStatusForUser(USER_ID, START, {
      applicationRevision: APPLICATION_REVISION,
      createConnection: () => connection,
    });
    expect(status).toEqual({
      state: "current",
      lastVerifiedAt: START.toISOString(),
      restoreVerifiedAt: START.toISOString(),
      nextArchiveDueAt: new Date(START.valueOf() + 24 * 60 * 60 * 1_000).toISOString(),
      retentionEndsAt: new Date(START.valueOf() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      latestAttempt: { status: "verified", observedAt: START.toISOString() },
      deletion: null,
    });
    expect(JSON.stringify(status)).not.toMatch(/objectKey|digest|credential|ciphertext/i);
    await expect(
      getFounderRecoveryArchiveStatusForUser(USER_ID, START, {
        applicationRevision: "b".repeat(40),
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({ state: "due", lastVerifiedAt: null, restoreVerifiedAt: null });

    await expect(
      createDurableRecoveryArchive(
        {
          action: "release_stage_admission",
          userId: USER_ID,
          applicationRevision: APPLICATION_REVISION,
          now: new Date(START.valueOf() + 60 * 60 * 1_000),
        },
        {
          createRecoveryArchive: async () => {
            throw new Error("a current archive must be reused");
          },
          deleteRecoveryArchive: (input) => provider.deleteRecoveryArchive(input),
        },
        connection,
        () => new Date(START.valueOf() + 60 * 60 * 1_000),
      ),
    ).resolves.toBe(archiveId);
    expect(await connection.db.select().from(founderRecoveryArchives)).toHaveLength(1);
  });

  it("binds promotion classification to the latest persisted uninterrupted admission", async () => {
    const [activeDecision] = await connection.db
      .select({ id: founderReleaseDecisions.id })
      .from(founderReleaseDecisions)
      .where(eq(founderReleaseDecisions.applicationRevision, APPLICATION_REVISION));
    if (!activeDecision) throw new Error("Expected seeded Owner Preview admission.");
    const journeyNames = [
      "desktop_activation",
      "phone_activation",
      "interruption_recovery",
      "provider_reauthorization",
      "provider_disconnect",
      "founder_data_export",
      "bruno_data_deletion",
    ] as const;
    const value = {
      schemaVersion: FOUNDER_OWNER_PREVIEW_PROMOTION_EVIDENCE_SCHEMA,
      stage: "owner_preview",
      classification: "learning_round",
      ownerUserId: USER_ID,
      operatorId: OPERATOR_ID,
      applicationRevision: APPLICATION_REVISION,
      runtimeRevision: "runtime-v1",
      activeDecisionId: activeDecision.id,
      dailyBriefs: Array.from({ length: 7 }, (_, index) => ({
        day: `2026-08-${String(index + 22).padStart(2, "0")}`,
        occurredAt: new Date(Date.UTC(2026, 7, index + 22, 12)).toISOString(),
        evidenceDigest: `sha256:${(index + 1).toString(16).padStart(64, "0")}`,
      })),
      journeys: Object.fromEntries(
        journeyNames.map((journey, index) => [
          journey,
          {
            occurredAt: new Date(START.valueOf() + (index + 1) * 1_000).toISOString(),
            evidenceDigest: `sha256:${(index + 8).toString(16).padStart(64, "0")}`,
          },
        ]),
      ),
      unresolvedReleaseBlockers: 0,
      unresolvedCriticalFailures: 0,
    };

    await expect(
      assessFounderOwnerPreviewPromotionEvidenceForUser({
        value,
        ownerUserId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        runtimeRevision: "runtime-v1",
        observedAt: new Date("2026-08-29T00:00:00.000Z"),
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({
      promotionEligible: true,
      founderAcceptanceEligible: false,
      automaticPromotion: false,
    });
    await expect(
      assessFounderOwnerPreviewPromotionEvidenceForUser({
        value: { ...value, activeDecisionId: randomUUID() },
        ownerUserId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        runtimeRevision: "runtime-v1",
        observedAt: new Date("2026-08-29T00:00:00.000Z"),
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({ promotionEligible: false, reasons: ["candidate_mismatch"] });
  });

  it("keeps current verified coverage visible when a newer refresh attempt fails", async () => {
    await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      provider,
      connection,
      () => START,
    );
    const failedAt = new Date(START.valueOf() + 22 * 60 * 60 * 1_000);
    await connection.db.insert(founderRecoveryArchives).values({
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      runtimeRevision: "runtime-v1",
      status: "failed",
      restorableVerified: false,
      failureCode: "archive_create_failed",
      observedAt: failedAt,
      expiresAt: new Date(failedAt.valueOf() + 30 * 24 * 60 * 60 * 1_000),
      createdAt: failedAt,
    });

    await expect(
      getFounderRecoveryArchiveStatusForUser(USER_ID, failedAt, {
        applicationRevision: APPLICATION_REVISION,
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({
      state: "current",
      lastVerifiedAt: START.toISOString(),
      restoreVerifiedAt: START.toISOString(),
      latestAttempt: { status: "failed", observedAt: failedAt.toISOString() },
    });
  });

  it("does not reuse or authorize an archive from a different runtime revision", async () => {
    const firstArchiveId = await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      provider,
      connection,
      () => START,
    );
    const nextRevisionAt = new Date(START.valueOf() + 60_000);
    await connection.db
      .update(operatorRuntimes)
      .set({ configRevision: "runtime-v2", updatedAt: nextRevisionAt })
      .where(eq(operatorRuntimes.operatorId, OPERATOR_ID));
    await connection.db.insert(founderReleaseDecisions).values({
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      stage: "owner_preview",
      outcome: "enter",
      applicationRevision: "a".repeat(40),
      runtimeRevision: "runtime-v2",
      capabilityManifest: ["openai", "calendar_reading"],
      openAiQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
      calendarQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
      evidenceDigests: [`sha256:${"9".repeat(64)}`],
      decidedAt: nextRevisionAt,
      createdAt: nextRevisionAt,
    });
    const refreshedAt = new Date(START.valueOf() + 60 * 60 * 1_000);

    await expect(
      getFounderOwnerPreviewAccessForUser(USER_ID, refreshedAt, {
        applicationRevision: "a".repeat(40),
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ admitted: true, availableCapabilities: [] });
    await expect(
      getFounderRecoveryArchiveStatusForUser(USER_ID, refreshedAt, {
        applicationRevision: APPLICATION_REVISION,
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({ state: "due" });

    const secondArchiveId = await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: refreshedAt,
      },
      provider,
      connection,
      () => refreshedAt,
    );
    expect(secondArchiveId).not.toBe(firstArchiveId);
    await expect(
      connection.db
        .select({ runtimeRevision: founderRecoveryArchives.runtimeRevision })
        .from(founderRecoveryArchives)
        .orderBy(founderRecoveryArchives.observedAt),
    ).resolves.toEqual([{ runtimeRevision: "runtime-v1" }, { runtimeRevision: "runtime-v2" }]);
    await expect(
      getFounderOwnerPreviewAccessForUser(USER_ID, refreshedAt, {
        applicationRevision: "a".repeat(40),
        createConnection: () => connection,
      }),
    ).resolves.toEqual({
      admitted: true,
      availableCapabilities: ["openai", "calendar_reading"],
    });
  });

  it("archives a closed pause reason without Founder-controlled text", async () => {
    const embeddedCredential = "Founder paused after seeing Bearer secret-token-value";
    await connection.db
      .update(operators)
      .set({
        externalActionPause: true,
        externalActionPauseReason: embeddedCredential,
        externalActionPausedAt: START,
      })
      .where(eq(operators.id, OPERATOR_ID));
    let archivedReason: string | null | undefined;

    await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      {
        async createRecoveryArchive(input) {
          archivedReason = input.state.operator.externalActionPauseReason;
          expect(JSON.stringify(input.state)).not.toContain(embeddedCredential);
          return provider.createRecoveryArchive(input);
        },
        deleteRecoveryArchive: (input) => provider.deleteRecoveryArchive(input),
      },
      connection,
      () => START,
    );

    expect(archivedReason).toBe(FOUNDER_RECOVERY_ARCHIVE_PAUSE_REASON);
  });

  it("separates persisted Owner Preview access from current work protection", async () => {
    await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      provider,
      connection,
      () => START,
    );

    await expect(
      getFounderOwnerPreviewAccessForUser(USER_ID, START, {
        applicationRevision: "a".repeat(40),
        createConnection: () => connection,
      }),
    ).resolves.toEqual({
      admitted: true,
      availableCapabilities: ["openai", "calendar_reading"],
    });
    await expect(
      requireFounderOwnerPreviewAccessForUser(
        USER_ID,
        START,
        {
          applicationRevision: "a".repeat(40),
          createConnection: () => connection,
        },
        [],
      ),
    ).rejects.toMatchObject({ code: "owner_preview_access_required" });

    await expect(
      connection.db.insert(founderReleaseDecisions).values({
        userId: USER_ID,
        operatorId: OPERATOR_ID,
        stage: "owner_preview",
        outcome: "hold",
        applicationRevision: "a".repeat(40),
        runtimeRevision: "runtime-v1",
        capabilityManifest: ["openai"],
        openAiQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
        calendarQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
        affectedCapabilities: ["openai"],
        evidenceDigests: [`sha256:${"b".repeat(64)}`],
        decidedAt: new Date(START.valueOf() + 30_000),
        createdAt: new Date(START.valueOf() + 30_000),
      }),
    ).rejects.toThrow();

    await expect(
      getFounderOwnerPreviewAccessForUser(USER_ID, START, {
        applicationRevision: "b".repeat(40),
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ admitted: false, availableCapabilities: [] });

    const heldAt = new Date(START.valueOf() + 60_000);
    await connection.db.transaction((tx) =>
      persistFounderOwnerPreviewHoldInTransaction(tx, {
        userId: USER_ID,
        operatorId: OPERATOR_ID,
        applicationRevision: "a".repeat(40),
        runtimeRevision: "runtime-v1",
        affectedCapabilities: ["openai"],
        evidenceDigests: [`sha256:${"c".repeat(64)}`],
        decidedAt: heldAt,
      }),
    );

    await expect(
      getFounderOwnerPreviewAccessForUser(USER_ID, heldAt, {
        applicationRevision: "a".repeat(40),
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ admitted: true, availableCapabilities: ["calendar_reading"] });

    await connection.db
      .update(operatorRuntimes)
      .set({
        status: "needs_attention",
        recoveryMessage: "Runtime recovery is required.",
        failureCode: "runtime_unavailable",
      })
      .where(eq(operatorRuntimes.operatorId, OPERATOR_ID));
    await expect(
      getFounderOwnerPreviewAccessForUser(USER_ID, heldAt, {
        applicationRevision: "a".repeat(40),
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ admitted: true, availableCapabilities: [] });
  });

  it("serializes concurrent capability Holds without losing either affected capability", async () => {
    const heldAt = new Date(START.valueOf() + 60_000);
    await Promise.all([
      connection.db.transaction((tx) =>
        persistFounderOwnerPreviewHoldInTransaction(tx, {
          userId: USER_ID,
          operatorId: OPERATOR_ID,
          applicationRevision: "a".repeat(40),
          runtimeRevision: "runtime-v1",
          affectedCapabilities: ["openai"],
          evidenceDigests: [`sha256:${"c".repeat(64)}`],
          decidedAt: heldAt,
        }),
      ),
      connection.db.transaction((tx) =>
        persistFounderOwnerPreviewHoldInTransaction(tx, {
          userId: USER_ID,
          operatorId: OPERATOR_ID,
          applicationRevision: "a".repeat(40),
          runtimeRevision: "runtime-v1",
          affectedCapabilities: ["calendar_reading"],
          evidenceDigests: [`sha256:${"d".repeat(64)}`],
          decidedAt: heldAt,
        }),
      ),
    ]);
    await connection.db.transaction((tx) =>
      persistFounderOwnerPreviewHoldInTransaction(tx, {
        userId: USER_ID,
        operatorId: OPERATOR_ID,
        applicationRevision: "a".repeat(40),
        runtimeRevision: "runtime-v1",
        affectedCapabilities: ["openai"],
        evidenceDigests: [`sha256:${"e".repeat(64)}`],
        decidedAt: heldAt,
      }),
    );

    const decisions = await connection.db
      .select()
      .from(founderReleaseDecisions)
      .orderBy(founderReleaseDecisions.decidedAt);
    expect(decisions.map((decision) => decision.outcome)).toEqual([
      "enter",
      "hold",
      "hold",
      "hold",
    ]);
    expect(decisions.at(-1)?.affectedCapabilities).toEqual(["openai", "calendar_reading"]);
    expect(decisions.at(-1)?.evidenceDigests).toHaveLength(3);
    expect(decisions.at(-1)?.evidenceDigests).toEqual(
      expect.arrayContaining([
        `sha256:${"c".repeat(64)}`,
        `sha256:${"d".repeat(64)}`,
        `sha256:${"e".repeat(64)}`,
      ]),
    );
  });

  it("persists a capability-scoped Hold when admitted Preview Qualification expires", async () => {
    const applicationRevision = "6".repeat(40);
    const expiresAt = new Date(START.valueOf() + 15 * 60 * 1_000);
    const environment = ownerPreviewEnvironment(applicationRevision);
    const bundle = JSON.parse(environment.BRUNO_OWNER_PREVIEW_QUALIFICATIONS ?? "null");
    bundle.qualifications[0].expiresAt = expiresAt.toISOString();
    environment.BRUNO_OWNER_PREVIEW_QUALIFICATIONS = JSON.stringify(bundle);
    await admitFounderOperatorToOwnerPreview(USER_ID, {
      applicationRevision,
      createConnection: () => connection,
      createProvider: () => provider,
      env: environment,
      now: () => START,
    });

    const observedAt = new Date(expiresAt.valueOf() + 1);
    await expect(
      getFounderOwnerPreviewAccessForUser(USER_ID, observedAt, {
        applicationRevision,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ admitted: true, availableCapabilities: ["calendar_reading"] });

    const beforeWork = await connection.db
      .select()
      .from(founderReleaseDecisions)
      .where(eq(founderReleaseDecisions.applicationRevision, applicationRevision));
    expect(beforeWork.map((decision) => decision.outcome)).toEqual(["enter"]);

    await expect(
      requireFounderOwnerPreviewAccessForUser(
        USER_ID,
        observedAt,
        { applicationRevision, createConnection: () => connection },
        ["openai"],
      ),
    ).rejects.toMatchObject({ code: "owner_preview_access_required" });

    const decisions = await connection.db
      .select()
      .from(founderReleaseDecisions)
      .where(eq(founderReleaseDecisions.applicationRevision, applicationRevision))
      .orderBy(founderReleaseDecisions.decidedAt);
    expect(decisions.at(-1)).toMatchObject({
      outcome: "hold",
      affectedCapabilities: ["openai"],
      decidedAt: observedAt,
    });
  });

  it("retains the lifecycle lock through the authorized work transaction", async () => {
    await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      provider,
      connection,
      () => START,
    );
    const competingConnection = createDatabaseConnection();

    try {
      await expect(
        withFounderOwnerPreviewWorkAuthority(
          {
            userId: USER_ID,
            now: () => START,
            requiredCapabilities: ["openai"],
          },
          {
            applicationRevision: "a".repeat(40),
            createConnection: () => connection,
          },
          async () => {
            const lockKey = `bruno:founder-lifecycle:${USER_ID}`;
            const result = await competingConnection.db.execute<{ acquired: boolean }>(
              sql`select pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) as acquired`,
            );
            expect(result[0]?.acquired).toBe(false);
            return "committed";
          },
        ),
      ).resolves.toBe("committed");
    } finally {
      await competingConnection.close();
    }
  });

  it("commits a scoped Hold when qualification expires at the fresh work check", async () => {
    await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      provider,
      connection,
      () => START,
    );
    const expiresAt = new Date(START.valueOf() + 15 * 60 * 1_000);
    await connection.db
      .update(founderReleaseDecisions)
      .set({ openAiQualificationExpiresAt: expiresAt })
      .where(eq(founderReleaseDecisions.userId, USER_ID));
    let current = START;
    let workStarted = false;

    await expect(
      withFounderOwnerPreviewWorkAuthority(
        {
          userId: USER_ID,
          now: () => current,
          requiredCapabilities: ["openai"],
        },
        {
          applicationRevision: "a".repeat(40),
          createConnection: () => connection,
          requireReleaseStageAccessForUser: async () => {
            current = new Date(expiresAt.valueOf() + 1);
          },
        },
        async () => {
          workStarted = true;
        },
      ),
    ).rejects.toMatchObject({ code: "owner_preview_access_required" });

    expect(workStarted).toBe(false);
    const decisions = await connection.db
      .select()
      .from(founderReleaseDecisions)
      .where(eq(founderReleaseDecisions.userId, USER_ID))
      .orderBy(founderReleaseDecisions.decidedAt);
    expect(decisions.at(-1)).toMatchObject({
      outcome: "hold",
      affectedCapabilities: ["openai"],
      decidedAt: current,
    });
  });

  it("records runtime recovery failure against the admitted revision", async () => {
    await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      provider,
      connection,
      () => START,
    );
    const failedAt = new Date(START.valueOf() + 60_000);
    await connection.db
      .update(operatorRuntimes)
      .set({ status: "needs_attention", updatedAt: failedAt })
      .where(eq(operatorRuntimes.operatorId, OPERATOR_ID));

    await prepareFounderOperatorRuntimeForUser(USER_ID, {
      createConnection: () => connection,
      now: () => failedAt,
      env: { VERCEL_GIT_COMMIT_SHA: "a".repeat(40) },
      adapter: {
        prepare: async () => ({
          ok: false,
          code: "runtime_prepare_failed",
          message: "Runtime recovery failed.",
        }),
        verify: async () => {
          throw new Error("A failed preparation must not be verified.");
        },
      },
    });

    const [runtime] = await connection.db.select().from(operatorRuntimes);
    expect(runtime).toMatchObject({ status: "needs_attention", configRevision: "runtime-v1" });
    const decisions = await connection.db
      .select()
      .from(founderReleaseDecisions)
      .orderBy(founderReleaseDecisions.decidedAt);
    expect(decisions.at(-1)).toMatchObject({
      outcome: "hold",
      runtimeRevision: "runtime-v1",
      affectedCapabilities: ["openai", "calendar_reading"],
    });
    await expect(
      getFounderOwnerPreviewAccessForUser(USER_ID, failedAt, {
        applicationRevision: "a".repeat(40),
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ admitted: true, availableCapabilities: [] });

    const refreshAt = new Date(START.valueOf() + 23 * 60 * 60 * 1_000);
    await expect(
      reconcileFounderRecoveryArchives({
        applicationRevision: APPLICATION_REVISION,
        now: refreshAt,
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ eligible: 1, created: 1, failed: 0, deleted: 0 });
    const archives = await connection.db
      .select()
      .from(founderRecoveryArchives)
      .orderBy(founderRecoveryArchives.observedAt);
    expect(archives.at(-1)).toMatchObject({ status: "verified", observedAt: refreshAt });
  });

  it("schedules a daily archive for a public General Release activation with global authority", async () => {
    const generalReleaseAt = new Date(START.valueOf() + 2 * 60 * 60 * 1_000);
    await connection.db
      .update(operatorRuntimes)
      .set({ configRevision: "runtime-v2", updatedAt: generalReleaseAt })
      .where(eq(operatorRuntimes.operatorId, OPERATOR_ID));
    const [decision] = await connection.db
      .insert(founderReleaseDecisions)
      .values({
        stage: "initial_general_release",
        outcome: "enter",
        applicationRevision: APPLICATION_REVISION,
        runtimeRevision: "runtime-v2",
        capabilityManifest: [
          "openai",
          "anthropic",
          "calendar_reading",
          "gmail_reading",
          "gmail_sending",
        ],
        evidenceDigests: Array.from(
          { length: 12 },
          (_, index) => `sha256:${index.toString(16).repeat(64)}`,
        ),
        authorityExpiresAt: QUALIFICATION_EXPIRES_AT,
        decidedAt: generalReleaseAt,
        createdAt: generalReleaseAt,
      })
      .returning({ id: founderReleaseDecisions.id });
    if (!decision) throw new Error("Global General Release fixture is unavailable.");
    const [runner] = await connection.db
      .insert(runners)
      .values({
        userId: USER_ID,
        name: "General Release archive fixture",
        kind: "digitalocean",
        status: "online",
        provider: "digitalocean",
        providerResourceId: "droplet-archive-387",
        region: "sgp1",
        sizeSlug: "s-1vcpu-1gb",
        image: "ubuntu-24-04-x64",
        provisioningStatus: "ready",
        createdAt: generalReleaseAt,
        updatedAt: generalReleaseAt,
      })
      .returning({ id: runners.id });
    if (!runner) throw new Error("Global General Release runner fixture is unavailable.");
    await connection.db.insert(founderGeneralReleaseActivations).values({
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      releaseDecisionId: decision.id,
      runnerId: runner.id,
      status: "activation_pending",
      serviceBusinessConfirmedAt: generalReleaseAt,
      geographyCode: "PH",
      admissionState: "eligible",
      admissionReason: "Public capacity is available.",
      publishedPriceLabel: "$30/month",
      capacityObservedAt: generalReleaseAt,
      createConfirmedAt: generalReleaseAt,
      setupEvidenceDigest: `sha256:${"f".repeat(64)}`,
      dropletCreatedAt: generalReleaseAt,
      createdAt: generalReleaseAt,
      updatedAt: generalReleaseAt,
    });
    const refreshAt = new Date(generalReleaseAt.valueOf() + 23 * 60 * 60 * 1_000);

    await expect(
      reconcileFounderRecoveryArchives({
        applicationRevision: APPLICATION_REVISION,
        now: refreshAt,
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ eligible: 1, created: 1, failed: 0, deleted: 0 });
    await expect(connection.db.select().from(founderRecoveryArchives)).resolves.toEqual([
      expect.objectContaining({ userId: USER_ID, status: "verified", observedAt: refreshAt }),
    ]);
  });

  it("admits a production Operator only after persisting its initial verified archive", async () => {
    const applicationRevision = "9".repeat(40);
    const environment = ownerPreviewEnvironment(applicationRevision);
    const result = await admitFounderOperatorToOwnerPreview(USER_ID, {
      applicationRevision,
      createConnection: () => connection,
      createProvider: () => provider,
      env: environment,
      now: () => START,
    });

    await expect(
      connection.db
        .select()
        .from(founderRecoveryArchives)
        .where(eq(founderRecoveryArchives.id, result.archiveId)),
    ).resolves.toEqual([expect.objectContaining({ status: "verified", restorableVerified: true })]);
    await expect(
      connection.db
        .select()
        .from(founderReleaseDecisions)
        .where(eq(founderReleaseDecisions.applicationRevision, "9".repeat(40))),
    ).resolves.toEqual([
      expect.objectContaining({
        stage: "owner_preview",
        outcome: "enter",
        applicationRevision,
        runtimeRevision: "runtime-v1",
        capabilityManifest: ["openai", "calendar_reading"],
        evidenceDigests: expect.arrayContaining([
          `sha256:${"d".repeat(64)}`,
          `sha256:${"f".repeat(64)}`,
        ]),
      }),
    ]);

    const holdAt = new Date(START.valueOf() + 60_000);
    await connection.db.insert(founderReleaseDecisions).values({
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      stage: "owner_preview",
      outcome: "hold",
      applicationRevision,
      runtimeRevision: "runtime-v1",
      capabilityManifest: ["openai", "calendar_reading"],
      openAiQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
      calendarQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
      affectedCapabilities: ["openai", "calendar_reading"],
      evidenceDigests: [`sha256:${"e".repeat(64)}`],
      decidedAt: holdAt,
      createdAt: holdAt,
    });
    const resumeAt = new Date(holdAt.valueOf() + 1_000);
    await expect(
      admitFounderOperatorToOwnerPreview(USER_ID, {
        applicationRevision,
        createConnection: () => connection,
        createProvider: () => provider,
        env: environment,
        now: () => resumeAt,
      }),
    ).rejects.toThrow("Release Hold requires fresh Preview Qualification evidence.");
    const freshEnvironment = ownerPreviewEnvironment(
      applicationRevision,
      new Date(holdAt.valueOf() + 500),
      resumeAt,
      ["1", "2"],
    );
    await admitFounderOperatorToOwnerPreview(USER_ID, {
      applicationRevision,
      createConnection: () => connection,
      createProvider: () => provider,
      env: freshEnvironment,
      now: () => resumeAt,
    });
    const decisions = await connection.db
      .select()
      .from(founderReleaseDecisions)
      .where(eq(founderReleaseDecisions.applicationRevision, applicationRevision))
      .orderBy(founderReleaseDecisions.decidedAt);
    expect(decisions.map((decision) => decision.outcome)).toEqual(["enter", "hold", "resume"]);
  });

  it("reruns restoration proof when the admission application revision changes", async () => {
    const firstArchiveId = await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      provider,
      connection,
      () => START,
    );
    const applicationRevision = "5".repeat(40);
    const admittedAt = new Date(START.valueOf() + 60_000);

    const admitted = await admitFounderOperatorToOwnerPreview(USER_ID, {
      applicationRevision,
      createConnection: () => connection,
      createProvider: () => provider,
      env: ownerPreviewEnvironment(applicationRevision),
      now: () => admittedAt,
    });

    expect(admitted.archiveId).not.toBe(firstArchiveId);
    const archives = await connection.db
      .select()
      .from(founderRecoveryArchives)
      .orderBy(founderRecoveryArchives.observedAt);
    expect(archives).toHaveLength(2);
    expect(archives.map((archive) => archive.applicationRevision)).toEqual([
      APPLICATION_REVISION,
      applicationRevision,
    ]);
  });

  it("does not replace an active exact-candidate admission when a redundant entry attempt fails", async () => {
    const applicationRevision = "1".repeat(40);
    const environment = ownerPreviewEnvironment(applicationRevision);
    await admitFounderOperatorToOwnerPreview(USER_ID, {
      applicationRevision,
      createConnection: () => connection,
      createProvider: () => provider,
      env: environment,
      now: () => START,
    });

    await expect(
      admitFounderOperatorToOwnerPreview(USER_ID, {
        applicationRevision,
        createConnection: () => connection,
        createProvider: () => null,
        env: environment,
        now: () => new Date(START.valueOf() + 1_000),
      }),
    ).rejects.toThrow("Recovery Archive provider is unavailable.");
    await expect(
      connection.db.transaction((tx) =>
        persistFounderOwnerPreviewDenialInTransaction(tx, {
          userId: USER_ID,
          operatorId: OPERATOR_ID,
          applicationRevision,
          runtimeRevision: "runtime-v1",
          reason: "recovery_archive_unavailable",
          decidedAt: new Date(START.valueOf() + 2_000),
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      connection.db
        .select({ outcome: founderReleaseDecisions.outcome })
        .from(founderReleaseDecisions)
        .where(eq(founderReleaseDecisions.applicationRevision, applicationRevision)),
    ).resolves.toEqual([{ outcome: "enter" }]);
  });

  it("rechecks Preview Qualification after Recovery Archive I/O before committing admission", async () => {
    const applicationRevision = "7".repeat(40);
    const environment = ownerPreviewEnvironment(applicationRevision);
    const bundle = JSON.parse(environment.BRUNO_OWNER_PREVIEW_QUALIFICATIONS ?? "null");
    const expiresAt = new Date(START.valueOf() + 15 * 60 * 1_000).toISOString();
    for (const qualification of bundle.qualifications) qualification.expiresAt = expiresAt;
    environment.BRUNO_OWNER_PREVIEW_QUALIFICATIONS = JSON.stringify(bundle);
    let current = START;

    await expect(
      admitFounderOperatorToOwnerPreview(USER_ID, {
        applicationRevision,
        createConnection: () => connection,
        createProvider: () => ({
          async createRecoveryArchive(input) {
            const outcome = await provider.createRecoveryArchive(input);
            current = new Date(START.valueOf() + 16 * 60 * 1_000);
            return outcome;
          },
          deleteRecoveryArchive: (input) => provider.deleteRecoveryArchive(input),
        }),
        env: environment,
        now: () => current,
      }),
    ).rejects.toThrow("Owner Preview openai qualification is stale.");
    await expect(
      connection.db
        .select({
          outcome: founderReleaseDecisions.outcome,
          capabilityManifest: founderReleaseDecisions.capabilityManifest,
          evidenceDigests: founderReleaseDecisions.evidenceDigests,
          openAiQualificationExpiresAt: founderReleaseDecisions.openAiQualificationExpiresAt,
          calendarQualificationExpiresAt: founderReleaseDecisions.calendarQualificationExpiresAt,
        })
        .from(founderReleaseDecisions)
        .where(eq(founderReleaseDecisions.applicationRevision, applicationRevision)),
    ).resolves.toEqual([
      {
        outcome: "deny",
        capabilityManifest: ["openai", "calendar_reading"],
        evidenceDigests: expect.arrayContaining([expect.stringMatching(/^sha256:[a-f0-9]{64}$/)]),
        openAiQualificationExpiresAt: null,
        calendarQualificationExpiresAt: null,
      },
    ]);
  });

  it("rechecks Recovery Archive currency at the final admission commit", async () => {
    const applicationRevision = "4".repeat(40);
    const environment = ownerPreviewEnvironment(applicationRevision);
    let current = START;

    await expect(
      admitFounderOperatorToOwnerPreview(USER_ID, {
        applicationRevision,
        createConnection: () => connection,
        createProvider: () => ({
          async createRecoveryArchive(input) {
            const outcome = await provider.createRecoveryArchive(input);
            current = new Date(START.valueOf() + 24 * 60 * 60 * 1_000);
            return outcome;
          },
          deleteRecoveryArchive: (input) => provider.deleteRecoveryArchive(input),
        }),
        env: environment,
        now: () => current,
      }),
    ).rejects.toThrow("A verified-restorable Recovery Archive is required.");
    await expect(
      connection.db
        .select({ outcome: founderReleaseDecisions.outcome })
        .from(founderReleaseDecisions)
        .where(eq(founderReleaseDecisions.applicationRevision, applicationRevision)),
    ).resolves.toEqual([{ outcome: "deny" }]);
  });

  it("does not replace missing Preview Qualification with Recovery Archive proof", async () => {
    const applicationRevision = "8".repeat(40);
    const environment = ownerPreviewEnvironment(applicationRevision);
    delete environment.BRUNO_OWNER_PREVIEW_QUALIFICATIONS;
    await expect(
      admitFounderOperatorToOwnerPreview(USER_ID, {
        applicationRevision,
        createConnection: () => connection,
        createProvider: () => provider,
        env: environment,
        now: () => START,
      }),
    ).rejects.toThrow("Owner Preview Qualifications are unavailable.");
    await expect(connection.db.select().from(founderRecoveryArchives)).resolves.toEqual([]);
    await expect(
      connection.db
        .select({ outcome: founderReleaseDecisions.outcome })
        .from(founderReleaseDecisions)
        .where(eq(founderReleaseDecisions.applicationRevision, applicationRevision)),
    ).resolves.toEqual([{ outcome: "deny" }]);
  });

  it("denies admission when the authenticated candidate is not the mapped Bruno.Ai Owner", async () => {
    const applicationRevision = "2".repeat(40);
    await connection.db
      .update(appMetadata)
      .set({ value: "00000000-0000-4000-8000-000000003799" })
      .where(eq(appMetadata.key, FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY));

    await expect(
      admitFounderOperatorToOwnerPreview(USER_ID, {
        applicationRevision,
        createConnection: () => connection,
        createProvider: () => provider,
        env: ownerPreviewEnvironment(applicationRevision),
        now: () => START,
      }),
    ).rejects.toThrow("Owner Preview is restricted to the mapped Bruno.Ai Owner.");
    await expect(connection.db.select().from(founderRecoveryArchives)).resolves.toEqual([]);
    await expect(
      connection.db
        .select({ outcome: founderReleaseDecisions.outcome })
        .from(founderReleaseDecisions)
        .where(eq(founderReleaseDecisions.applicationRevision, applicationRevision)),
    ).resolves.toEqual([{ outcome: "deny" }]);
  });

  it("admits the authenticated internal Owner in supported production operator mode", async () => {
    const applicationRevision = "3".repeat(40);
    await connection.db.update(users).set({ clerkUserId: null }).where(eq(users.id, USER_ID));
    const environment = {
      ...ownerPreviewEnvironment(applicationRevision),
      BRUNO_AUTH_MODE: "operator",
      BRUNO_OPERATOR_PASSWORD: "test-operator-password",
    };

    await expect(
      admitFounderOperatorToOwnerPreview(USER_ID, {
        applicationRevision,
        createConnection: () => connection,
        createProvider: () => provider,
        env: environment,
        now: () => START,
      }),
    ).resolves.toEqual({ archiveId: expect.any(String) });
    await expect(
      connection.db
        .select({ outcome: founderReleaseDecisions.outcome })
        .from(founderReleaseDecisions)
        .where(eq(founderReleaseDecisions.applicationRevision, applicationRevision)),
    ).resolves.toEqual([{ outcome: "enter" }]);
  });

  it("rejects Preview Qualification scoped to a different runtime", async () => {
    const applicationRevision = "6".repeat(40);
    const environment = ownerPreviewEnvironment(applicationRevision);
    const bundle = JSON.parse(environment.BRUNO_OWNER_PREVIEW_QUALIFICATIONS ?? "null");
    bundle.qualifications[0].runtimeRevision = "different-runtime";
    environment.BRUNO_OWNER_PREVIEW_QUALIFICATIONS = JSON.stringify(bundle);

    await expect(
      admitFounderOperatorToOwnerPreview(USER_ID, {
        applicationRevision,
        createConnection: () => connection,
        createProvider: () => provider,
        env: environment,
        now: () => START,
      }),
    ).rejects.toThrow(
      "Owner Preview openai qualification does not match this Owner and candidate.",
    );
    await expect(connection.db.select().from(founderRecoveryArchives)).resolves.toEqual([]);
    await expect(
      connection.db
        .select({ outcome: founderReleaseDecisions.outcome })
        .from(founderReleaseDecisions)
        .where(eq(founderReleaseDecisions.applicationRevision, applicationRevision)),
    ).resolves.toEqual([{ outcome: "deny" }]);
  });

  it("requires independent evidence for each Preview capability", async () => {
    const applicationRevision = "5".repeat(40);
    const environment = ownerPreviewEnvironment(applicationRevision);
    const bundle = JSON.parse(environment.BRUNO_OWNER_PREVIEW_QUALIFICATIONS ?? "null");
    bundle.qualifications[1].evidenceDigest = bundle.qualifications[0].evidenceDigest;
    environment.BRUNO_OWNER_PREVIEW_QUALIFICATIONS = JSON.stringify(bundle);

    await expect(
      admitFounderOperatorToOwnerPreview(USER_ID, {
        applicationRevision,
        createConnection: () => connection,
        createProvider: () => provider,
        env: environment,
        now: () => START,
      }),
    ).rejects.toThrow("Owner Preview capabilities require independent qualification evidence.");
    await expect(connection.db.select().from(founderRecoveryArchives)).resolves.toEqual([]);
    await expect(
      connection.db
        .select({ outcome: founderReleaseDecisions.outcome })
        .from(founderReleaseDecisions)
        .where(eq(founderReleaseDecisions.applicationRevision, applicationRevision)),
    ).resolves.toEqual([{ outcome: "deny" }]);
  });

  it("refreshes with two cron intervals of verification margin", async () => {
    await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      provider,
      connection,
      () => START,
    );

    await expect(
      reconcileFounderRecoveryArchives({
        applicationRevision: APPLICATION_REVISION,
        now: new Date(START.valueOf() + 22 * 60 * 60 * 1_000),
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({ eligible: 1, created: 1, failed: 0, deleted: 0 });

    await expect(
      reconcileFounderRecoveryArchives({
        applicationRevision: APPLICATION_REVISION,
        now: new Date(START.valueOf() + 23 * 60 * 60 * 1_000),
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({ eligible: 1, created: 0, failed: 0, deleted: 0 });

    expect(await connection.db.select().from(founderRecoveryArchives)).toHaveLength(2);
  });

  it("labels scheduled restoration proof with the executing application revision", async () => {
    await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      provider,
      connection,
      () => START,
    );
    const executingApplicationRevision = "1".repeat(40);

    await expect(
      reconcileFounderRecoveryArchives({
        applicationRevision: executingApplicationRevision,
        now: new Date(START.valueOf() + 60_000),
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ eligible: 1, created: 1, failed: 0, deleted: 0 });

    const archives = await connection.db
      .select({ applicationRevision: founderRecoveryArchives.applicationRevision })
      .from(founderRecoveryArchives)
      .orderBy(founderRecoveryArchives.observedAt);
    expect(archives).toEqual([
      { applicationRevision: APPLICATION_REVISION },
      { applicationRevision: executingApplicationRevision },
    ]);
  });

  it("continues daily protection through a capability-scoped Release Hold", async () => {
    const holdAt = new Date(START.valueOf() + 1_000);
    await connection.db.insert(founderReleaseDecisions).values({
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      stage: "owner_preview",
      outcome: "hold",
      applicationRevision: "7".repeat(40),
      runtimeRevision: "runtime-v1",
      capabilityManifest: ["openai", "calendar_reading"],
      openAiQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
      calendarQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
      affectedCapabilities: ["openai"],
      evidenceDigests: [`sha256:${"6".repeat(64)}`],
      decidedAt: holdAt,
      createdAt: holdAt,
    });
    await expect(
      reconcileFounderRecoveryArchives({
        applicationRevision: APPLICATION_REVISION,
        now: new Date(START.valueOf() + 24 * 60 * 60 * 1_000),
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ eligible: 1, created: 1, failed: 0, deleted: 0 });

    const resumeAt = new Date(holdAt.valueOf() + 1_000);
    await connection.db.insert(founderReleaseDecisions).values({
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      stage: "owner_preview",
      outcome: "resume",
      applicationRevision: "5".repeat(40),
      runtimeRevision: "runtime-v1",
      capabilityManifest: ["openai", "calendar_reading"],
      openAiQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
      calendarQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
      evidenceDigests: [`sha256:${"4".repeat(64)}`],
      decidedAt: resumeAt,
      createdAt: resumeAt,
    });
    await expect(
      reconcileFounderRecoveryArchives({
        applicationRevision: APPLICATION_REVISION,
        now: new Date(START.valueOf() + 24 * 60 * 60 * 1_000 + 1_000),
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ eligible: 1, created: 0, failed: 0, deleted: 0 });
  });

  it("reserves one archive intent while its provider upload is still pending", async () => {
    let releaseFirstUpload: (() => void) | undefined;
    let markFirstUploadStarted: (() => void) | undefined;
    const firstUploadStarted = new Promise<void>((resolve) => {
      markFirstUploadStarted = resolve;
    });
    const firstUploadReleased = new Promise<void>((resolve) => {
      releaseFirstUpload = resolve;
    });
    let providerCalls = 0;
    const blockingProvider = {
      createRecoveryArchive: async (
        input: Parameters<typeof provider.createRecoveryArchive>[0],
      ) => {
        providerCalls += 1;
        if (providerCalls === 1) {
          markFirstUploadStarted?.();
          await firstUploadReleased;
        } else {
          throw new Error("Concurrent provider upload must not start.");
        }
        return provider.createRecoveryArchive(input);
      },
      deleteRecoveryArchive: (input: Parameters<typeof provider.deleteRecoveryArchive>[0]) =>
        provider.deleteRecoveryArchive(input),
    };

    const first = createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      blockingProvider,
      connection,
      () => START,
    );
    await firstUploadStarted;
    const second = createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      blockingProvider,
      connection,
      () => START,
    );

    await expect(second).rejects.toThrow("Recovery Archive creation is already in progress.");
    releaseFirstUpload?.();
    await expect(first).resolves.toEqual(expect.any(String));
    expect(providerCalls).toBe(1);
    await expect(connection.db.select().from(founderRecoveryArchives)).resolves.toEqual([
      expect.objectContaining({ status: "verified" }),
    ]);
  });

  it("lets Infrastructure Retirement supersede an in-flight daily archive", async () => {
    let releaseDailyUpload: (() => void) | undefined;
    let markDailyUploadStarted: (() => void) | undefined;
    const dailyUploadStarted = new Promise<void>((resolve) => {
      markDailyUploadStarted = resolve;
    });
    const dailyUploadReleased = new Promise<void>((resolve) => {
      releaseDailyUpload = resolve;
    });
    const dailyArchive = createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      {
        createRecoveryArchive: async (input) => {
          markDailyUploadStarted?.();
          await dailyUploadReleased;
          return provider.createRecoveryArchive(input);
        },
        deleteRecoveryArchive: (input) => provider.deleteRecoveryArchive(input),
      },
      connection,
      () => START,
    );
    await dailyUploadStarted;

    const retirementArchiveId = await connection.db.transaction((tx) =>
      persistFounderRecoveryArchiveIntentInTransaction(tx, {
        userId: USER_ID,
        operatorId: OPERATOR_ID,
        applicationRevision: APPLICATION_REVISION,
        runtimeRevision: "runtime-v1",
        now: new Date(START.valueOf() + 1_000),
        pendingIntentPolicy: "supersede_for_retirement",
      }),
    );
    releaseDailyUpload?.();

    await expect(dailyArchive).rejects.toThrow("Recovery Archive intent is no longer pending.");
    const archives = await connection.db
      .select()
      .from(founderRecoveryArchives)
      .orderBy(founderRecoveryArchives.observedAt);
    expect(archives).toEqual([
      expect.objectContaining({
        status: "failed",
        failureCode: "archive_create_superseded_by_retirement",
        storageObjectKey: expect.stringMatching(/\.age$/),
        recoveryCredentialObjectKey: expect.stringMatching(/\.key$/),
      }),
      expect.objectContaining({
        id: retirementArchiveId,
        runtimeRevision: "runtime-v1",
        status: "pending",
        failureCode: null,
        storageObjectKey: `founder-recovery/${USER_ID}/${retirementArchiveId}.age`,
        recoveryCredentialObjectKey: `founder-recovery/${USER_ID}/${retirementArchiveId}.key`,
      }),
    ]);
  });

  it("persists deterministic deletion identities with every new archive intent", async () => {
    const archiveId = await connection.db.transaction((tx) =>
      persistFounderRecoveryArchiveIntentInTransaction(tx, {
        userId: USER_ID,
        operatorId: OPERATOR_ID,
        applicationRevision: APPLICATION_REVISION,
        runtimeRevision: "runtime-v1",
        now: START,
      }),
    );

    const [intent] = await connection.db
      .select()
      .from(founderRecoveryArchives)
      .where(eq(founderRecoveryArchives.id, archiveId));
    expect(intent).toMatchObject({
      runtimeRevision: "runtime-v1",
      status: "pending",
      storageObjectKey: `founder-recovery/${USER_ID}/${archiveId}.age`,
      recoveryCredentialObjectKey: `founder-recovery/${USER_ID}/${archiveId}.key`,
      expiresAt: new Date(START.valueOf() + 30 * 24 * 60 * 60 * 1_000),
    });
  });

  it("fails admission closed and records bounded failure state when storage is unavailable", async () => {
    await expect(
      createDurableRecoveryArchive(
        {
          action: "release_stage_admission",
          userId: USER_ID,
          applicationRevision: APPLICATION_REVISION,
          now: START,
        },
        {
          createRecoveryArchive: async () => {
            throw new Error("object storage unavailable");
          },
          deleteRecoveryArchive: (input) => provider.deleteRecoveryArchive(input),
        },
        connection,
        () => START,
      ),
    ).rejects.toThrow("object storage unavailable");

    const [archive] = await connection.db.select().from(founderRecoveryArchives);
    if (!archive) throw new Error("Expected a failed Recovery Archive intent.");
    expect(archive).toMatchObject({
      status: "failed",
      formatVersion: null,
      ciphertextDigest: null,
      recoveryCredentialDigest: null,
      stateDigest: null,
      restorableVerified: false,
      restoreVerifiedAt: null,
      failureCode: "archive_create_failed",
    });
    expect(archive.storageObjectKey).toBe(`founder-recovery/${USER_ID}/${archive.id}.age`);
    expect(archive.recoveryCredentialObjectKey).toBe(
      `founder-recovery/${USER_ID}/${archive.id}.key`,
    );

    await connection.db.insert(founderReleaseDecisions).values({
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      stage: "owner_preview",
      outcome: "hold",
      applicationRevision: "e".repeat(40),
      runtimeRevision: "runtime-v1",
      capabilityManifest: ["openai", "calendar_reading"],
      openAiQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
      calendarQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
      affectedCapabilities: ["openai", "calendar_reading"],
      evidenceDigests: [`sha256:${"f".repeat(64)}`],
      decidedAt: new Date(START.valueOf() + 1_000),
      createdAt: new Date(START.valueOf() + 1_000),
    });
    const expiresAt = new Date(START.valueOf() + 30 * 24 * 60 * 60 * 1_000);
    await expect(
      reconcileFounderRecoveryArchives({
        applicationRevision: APPLICATION_REVISION,
        now: expiresAt,
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ eligible: 1, created: 1, failed: 0, deleted: 1 });
    await expect(
      connection.db
        .select()
        .from(founderRecoveryArchiveDeletionReceipts)
        .where(eq(founderRecoveryArchiveDeletionReceipts.archiveId, archive.id)),
    ).resolves.toEqual([expect.objectContaining({ status: "completed" })]);
  });

  it("deletes expired ciphertext and credentials and persists a bounded deletion receipt", async () => {
    const keylessIntentId = randomUUID();
    const oldObservedAt = new Date(START.valueOf() - 31 * 24 * 60 * 60 * 1_000);
    await connection.db.insert(founderRecoveryArchives).values({
      id: keylessIntentId,
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      status: "pending",
      restorableVerified: false,
      observedAt: oldObservedAt,
      expiresAt: new Date(START.valueOf() - 24 * 60 * 60 * 1_000),
      createdAt: oldObservedAt,
    });
    const archiveId = await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      provider,
      connection,
      () => START,
    );
    const expiresAt = new Date(START.valueOf() + 30 * 24 * 60 * 60 * 1_000);

    await expect(
      reconcileFounderRecoveryArchives({
        applicationRevision: APPLICATION_REVISION,
        now: expiresAt,
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({ eligible: 1, created: 1, failed: 0, deleted: 1 });

    const [deleted] = await connection.db
      .select()
      .from(founderRecoveryArchives)
      .where(eq(founderRecoveryArchives.id, archiveId));
    expect(deleted).toMatchObject({
      status: "deleted",
      storageObjectKey: null,
      recoveryCredentialObjectKey: null,
      recoveryCredentialDigest: null,
      restorableVerified: false,
      deletedAt: expiresAt,
    });
    const [receipt] = await connection.db
      .select()
      .from(founderRecoveryArchiveDeletionReceipts)
      .where(eq(founderRecoveryArchiveDeletionReceipts.archiveId, archiveId));
    expect(receipt).toMatchObject({
      status: "completed",
      archiveProviderConfirmed: true,
      recoveryCredentialsConfirmed: true,
      completedAt: expiresAt,
      failureCode: null,
    });
    const [keylessIntent] = await connection.db
      .select()
      .from(founderRecoveryArchives)
      .where(eq(founderRecoveryArchives.id, keylessIntentId));
    expect(keylessIntent).toMatchObject({ status: "pending", storageObjectKey: null });
  });

  it("removes objects published after expiry already certified their absence", async () => {
    const underlyingStorage = new FakeBackupObjectStorage("founder-recovery-late-publication");
    let markUploadStarted: (() => void) | undefined;
    let releaseUpload: (() => void) | undefined;
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve;
    });
    const uploadReleased = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let shouldBlockUpload = true;
    const blockingStorage = {
      async upload(input: Parameters<typeof underlyingStorage.upload>[0]) {
        if (shouldBlockUpload) {
          shouldBlockUpload = false;
          markUploadStarted?.();
          await uploadReleased;
        }
        return underlyingStorage.upload(input);
      },
      download: (input: Parameters<typeof underlyingStorage.download>[0]) =>
        underlyingStorage.download(input),
      delete: (input: Parameters<typeof underlyingStorage.delete>[0]) =>
        underlyingStorage.delete(input),
      deleteVersion: (input: Parameters<typeof underlyingStorage.deleteVersion>[0]) =>
        underlyingStorage.deleteVersion(input),
      exists: (input: Parameters<typeof underlyingStorage.exists>[0]) =>
        underlyingStorage.exists(input),
      verifyDeletionSafety: () => underlyingStorage.verifyDeletionSafety(),
    };
    const lateProvider = new EncryptedFounderRecoveryArchiveProvider({
      storage: blockingStorage,
      masterKey: new Uint8Array(32).fill(91),
    });
    let cleanupObservedAt = START;
    const creation = createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      lateProvider,
      connection,
      () => cleanupObservedAt,
    );
    await uploadStarted;
    const [pending] = await connection.db.select().from(founderRecoveryArchives);
    if (!pending?.storageObjectKey || !pending.recoveryCredentialObjectKey) {
      throw new Error("Expected persisted publication identities.");
    }
    const expiresAt = new Date(START.valueOf() + 30 * 24 * 60 * 60 * 1_000);

    await expect(
      expireFounderRecoveryArchivesForUser(USER_ID, expiresAt, lateProvider, connection),
    ).resolves.toBe(1);
    cleanupObservedAt = new Date(expiresAt.valueOf() + 6 * 60 * 60 * 1_000);
    releaseUpload?.();
    await expect(creation).rejects.toThrow("Recovery Archive intent is no longer pending.");

    await expect(underlyingStorage.exists({ key: pending.storageObjectKey })).resolves.toEqual({
      ok: true,
      exists: false,
    });
    await expect(
      underlyingStorage.exists({ key: pending.recoveryCredentialObjectKey }),
    ).resolves.toEqual({ ok: true, exists: false });
    const [lateCleanupReceipt] = await connection.db
      .select()
      .from(founderRecoveryArchiveDeletionReceipts)
      .where(eq(founderRecoveryArchiveDeletionReceipts.archiveId, pending.id));
    expect(lateCleanupReceipt).toMatchObject({ status: "completed" });
    expect(lateCleanupReceipt?.completedAt).toEqual(cleanupObservedAt);
  });

  it("does not certify stale absence after an in-flight publication becomes verified", async () => {
    const archiveId = await connection.db.transaction((tx) =>
      persistFounderRecoveryArchiveIntentInTransaction(tx, {
        userId: USER_ID,
        operatorId: OPERATOR_ID,
        applicationRevision: APPLICATION_REVISION,
        runtimeRevision: "runtime-v1",
        now: START,
      }),
    );
    const expiresAt = new Date(START.valueOf() + 30 * 24 * 60 * 60 * 1_000);
    const digest = `sha256:${"a".repeat(64)}`;

    await expect(
      expireFounderRecoveryArchivesForUser(
        USER_ID,
        expiresAt,
        {
          deleteRecoveryArchive: async () => {
            await connection.db
              .update(founderRecoveryArchives)
              .set({
                status: "verified",
                formatVersion: 1,
                ciphertextDigest: digest,
                recoveryCredentialDigest: digest,
                stateDigest: digest,
                restorableVerified: true,
                restoreVerifiedAt: expiresAt,
              })
              .where(eq(founderRecoveryArchives.id, archiveId));
            return { archiveAbsent: true, recoveryCredentialsAbsent: true };
          },
        },
        connection,
      ),
    ).rejects.toThrow("Recovery Archive changed while deletion was being verified.");

    await expect(
      connection.db
        .select()
        .from(founderRecoveryArchives)
        .where(eq(founderRecoveryArchives.id, archiveId)),
    ).resolves.toEqual([expect.objectContaining({ status: "verified", deletedAt: null })]);
    await expect(
      connection.db
        .select()
        .from(founderRecoveryArchiveDeletionReceipts)
        .where(eq(founderRecoveryArchiveDeletionReceipts.archiveId, archiveId)),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "pending",
        archiveProviderConfirmed: false,
        recoveryCredentialsConfirmed: false,
        completedAt: null,
        failureCode: "archive_delete_failed",
      }),
    ]);

    await expect(
      expireFounderRecoveryArchivesForUser(USER_ID, expiresAt, provider, connection),
    ).resolves.toBe(1);
  });

  it("replaces expired archives while every admitted capability is held", async () => {
    const archiveId = await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      provider,
      connection,
      () => START,
    );
    await connection.db.insert(founderReleaseDecisions).values({
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      stage: "owner_preview",
      outcome: "hold",
      applicationRevision: "c".repeat(40),
      runtimeRevision: "runtime-v1",
      capabilityManifest: ["openai", "calendar_reading"],
      openAiQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
      calendarQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
      affectedCapabilities: ["openai", "calendar_reading"],
      evidenceDigests: [`sha256:${"d".repeat(64)}`],
      decidedAt: new Date(START.valueOf() + 60 * 60 * 1_000),
      createdAt: new Date(START.valueOf() + 60 * 60 * 1_000),
    });
    const expiresAt = new Date(START.valueOf() + 30 * 24 * 60 * 60 * 1_000);

    await expect(
      reconcileFounderRecoveryArchives({
        applicationRevision: APPLICATION_REVISION,
        now: expiresAt,
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ eligible: 1, created: 1, failed: 0, deleted: 1 });

    const [deleted] = await connection.db
      .select()
      .from(founderRecoveryArchives)
      .where(eq(founderRecoveryArchives.id, archiveId));
    expect(deleted).toMatchObject({ status: "deleted", deletedAt: expiresAt });
  });

  it("keeps daily archive eligibility scoped to each admitted Release Stage", async () => {
    await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      provider,
      connection,
      () => START,
    );
    const heldAt = new Date(START.valueOf() + 60 * 60 * 1_000);
    await connection.db.insert(founderReleaseDecisions).values({
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      stage: "trusted_preview",
      outcome: "hold",
      applicationRevision: "d".repeat(40),
      runtimeRevision: "runtime-v1",
      capabilityManifest: ["openai", "calendar_reading"],
      affectedCapabilities: ["openai", "calendar_reading"],
      evidenceDigests: [`sha256:${"e".repeat(64)}`],
      decidedAt: heldAt,
      createdAt: heldAt,
    });

    await expect(
      reconcileFounderRecoveryArchives({
        applicationRevision: APPLICATION_REVISION,
        now: new Date(START.valueOf() + 25 * 60 * 60 * 1_000),
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ eligible: 1, created: 1, failed: 0, deleted: 0 });
  });

  it("retains the final archive for expiry without minting replacements after retirement", async () => {
    const finalArchiveId = await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: USER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      provider,
      connection,
      () => START,
    );
    const runnerId = randomUUID();
    await connection.db.insert(runners).values({
      id: runnerId,
      userId: USER_ID,
      name: "retired-owner-runner",
      kind: "digitalocean",
      status: "deleted",
      provider: "digitalocean",
      providerResourceId: "droplet-373",
      providerFirewallId: "firewall-373",
      region: "sfo3",
      sizeSlug: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      provisioningStatus: "deleted",
      deletedAt: new Date(START.valueOf() + 1_000),
      createdAt: START,
      updatedAt: new Date(START.valueOf() + 1_000),
    });
    const retiredAt = new Date(START.valueOf() + 1_000);
    await connection.db.insert(founderInfrastructureRetirements).values({
      userId: USER_ID,
      runnerId,
      recoveryArchiveId: finalArchiveId,
      idempotencyKey: `sha256:${"1".repeat(64)}`,
      providerResourceId: "droplet-373",
      providerFirewallId: "firewall-373",
      providerOperationTag: `bruno-deploy-${runnerId.replaceAll("-", "")}`,
      providerResourceName: "retired-owner-runner",
      providerRegion: "sfo3",
      providerSizeSlug: "s-1vcpu-1gb",
      providerFirewallName: "bruno-runners-droplet-373",
      providerResourceCreatedAt: START,
      hardDestructionDueAt: retiredAt,
      status: "completed",
      resourcesBefore: 2,
      resourcesAfter: 0,
      providerDropletState: "absent",
      providerFirewallState: "absent",
      providerObservedAt: retiredAt,
      workStoppedAt: retiredAt,
      credentialsDisabledAt: retiredAt,
      archiveOutcome: "verified",
      firewallDeletedAt: retiredAt,
      dropletDeletedAt: retiredAt,
      absenceVerifiedAt: retiredAt,
      billableRuntimeSeconds: 1,
      failureCode: null,
      attemptCount: 1,
      leaseToken: "retirement-lease-373",
      leaseExpiresAt: retiredAt,
      createdAt: retiredAt,
      updatedAt: retiredAt,
    });

    await expect(
      reconcileFounderRecoveryArchives({
        applicationRevision: APPLICATION_REVISION,
        now: new Date(START.valueOf() + 24 * 60 * 60 * 1_000),
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ eligible: 0, created: 0, failed: 0, deleted: 0 });
    expect(await connection.db.select().from(founderRecoveryArchives)).toHaveLength(1);

    const readmittedAt = new Date(START.valueOf() + 24 * 60 * 60 * 1_000 + 1_000);
    await connection.db.insert(founderReleaseDecisions).values({
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      stage: "owner_preview",
      outcome: "resume",
      applicationRevision: "2".repeat(40),
      runtimeRevision: "runtime-v1",
      capabilityManifest: ["openai", "calendar_reading"],
      openAiQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
      calendarQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
      evidenceDigests: [`sha256:${"3".repeat(64)}`],
      decidedAt: readmittedAt,
      createdAt: readmittedAt,
    });
    await expect(
      reconcileFounderRecoveryArchives({
        applicationRevision: APPLICATION_REVISION,
        now: new Date(readmittedAt.valueOf() + 1_000),
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ eligible: 1, created: 1, failed: 0, deleted: 0 });
    expect(await connection.db.select().from(founderRecoveryArchives)).toHaveLength(2);
  });

  async function seedReadyOwnerPreviewCandidate(): Promise<void> {
    await connection.db.insert(users).values({
      id: USER_ID,
      clerkUserId: "user_recovery_archive_373",
      createdAt: START,
      updatedAt: START,
    });
    await connection.db.insert(appMetadata).values({
      key: FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY,
      value: USER_ID,
      updatedAt: START,
    });
    await connection.db.insert(operators).values({
      id: OPERATOR_ID,
      userId: USER_ID,
      status: "active",
      createdAt: START,
      updatedAt: START,
    });
    await connection.db.insert(operatorPreparations).values({
      id: randomUUID(),
      operatorId: OPERATOR_ID,
      status: "ready",
      timezone: "Asia/Manila",
      timezoneConfirmedAt: START,
      startedAt: START,
      completedAt: START,
      createdAt: START,
      updatedAt: START,
    });
    await connection.db.insert(operatorRuntimes).values({
      id: randomUUID(),
      operatorId: OPERATOR_ID,
      status: "ready",
      transportState: "connected",
      safetyState: "verified",
      configRevision: "runtime-v1",
      runtimeIdentity: "runtime-secret-identity-not-archived",
      attemptCount: 1,
      startedAt: START,
      readyAt: START,
      createdAt: START,
      updatedAt: START,
    });
    await connection.db.insert(founderReleaseDecisions).values({
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      stage: "owner_preview",
      outcome: "enter",
      applicationRevision: "a".repeat(40),
      runtimeRevision: "runtime-v1",
      capabilityManifest: ["openai", "calendar_reading"],
      openAiQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
      calendarQualificationExpiresAt: QUALIFICATION_EXPIRES_AT,
      evidenceDigests: [`sha256:${"b".repeat(64)}`],
      decidedAt: START,
      createdAt: START,
    });
  }

  function ownerPreviewEnvironment(
    applicationRevision: string,
    qualifiedAt = new Date(START.valueOf() - 60 * 60 * 1_000),
    observedAt = START,
    evidenceCharacters: readonly [string, string] = ["d", "f"],
  ): Record<string, string | undefined> {
    return {
      VERCEL_GIT_COMMIT_SHA: applicationRevision,
      BRUNO_OPENAI_CONNECTED_ACCEPTANCE_RELEASE: buildTestOpenAiConnectedAcceptanceRelease(
        observedAt,
        applicationRevision,
      ),
      BRUNO_GOOGLE_CALENDAR_CONNECTED_ACCEPTANCE_RELEASE: buildTestGoogleConnectedAcceptanceRelease(
        "calendar_reading",
        observedAt,
        applicationRevision,
      ),
      BRUNO_OWNER_PREVIEW_QUALIFICATIONS: JSON.stringify({
        schemaVersion: "bruno.owner-preview-qualifications.v1",
        qualifications: ["openai", "calendar_reading"].map((capability, index) => ({
          schemaVersion: "bruno.preview-qualification.v1",
          outcome: "passed",
          audience: "owner",
          ownerUserId: USER_ID,
          operatorId: OPERATOR_ID,
          stage: "owner_preview",
          applicationRevision,
          runtimeRevision: "runtime-v1",
          capability,
          qualifiedAt: qualifiedAt.toISOString(),
          expiresAt: new Date(qualifiedAt.valueOf() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
          evidenceDigest: `sha256:${evidenceCharacters[index]?.repeat(64)}`,
          gates: {
            safeAuthorization: true,
            realUse: true,
            recovery: true,
            revocation: true,
            providerDisclosure: true,
            cleanup: true,
          },
        })),
      }),
    };
  }

  async function reset(): Promise<void> {
    await connection.client.unsafe(
      "delete from founder_general_release_activations; delete from founder_recovery_archive_deletion_receipts; delete from founder_infrastructure_retirements; delete from founder_recovery_archives; delete from founder_release_decisions; delete from runners; delete from operator_runtimes; delete from operator_preparations; delete from operators; delete from users",
    );
    await connection.db
      .delete(appMetadata)
      .where(eq(appMetadata.key, FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY));
  }
});
