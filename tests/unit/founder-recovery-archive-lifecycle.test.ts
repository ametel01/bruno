import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestGoogleConnectedAcceptanceRelease } from "@/scripts/founder-google-test-release";
import { buildTestOpenAiConnectedAcceptanceRelease } from "@/scripts/founder-openai-test-release";
import { FakeBackupObjectStorage } from "@/src/server/backups/backup-storage";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
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
  createDurableRecoveryArchive,
  getFounderRecoveryArchiveStatusForUser,
  persistFounderRecoveryArchiveIntentInTransaction,
  reconcileFounderRecoveryArchives,
} from "@/src/server/founder-product-contract/recovery-archive";

const USER_ID = "00000000-0000-4000-8000-000000003730";
const OPERATOR_ID = "00000000-0000-4000-8000-000000003731";
const START = new Date("2026-08-22T00:00:00.000Z");

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
      { action: "release_stage_admission", userId: USER_ID, now: START },
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
      createConnection: () => connection,
    });
    expect(status).toEqual({
      state: "current",
      lastVerifiedAt: START.toISOString(),
      restoreVerifiedAt: START.toISOString(),
      nextArchiveDueAt: new Date(START.valueOf() + 24 * 60 * 60 * 1_000).toISOString(),
      retentionEndsAt: new Date(START.valueOf() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      deletion: null,
    });
    expect(JSON.stringify(status)).not.toMatch(/objectKey|digest|credential|ciphertext/i);

    await expect(
      createDurableRecoveryArchive(
        {
          action: "release_stage_admission",
          userId: USER_ID,
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
        .select()
        .from(founderReleaseDecisions)
        .where(eq(founderReleaseDecisions.applicationRevision, applicationRevision)),
    ).resolves.toEqual([]);
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
  });

  it("creates at most one verified archive per 24-hour window", async () => {
    await createDurableRecoveryArchive(
      { action: "release_stage_admission", userId: USER_ID, now: START },
      provider,
      connection,
      () => START,
    );

    await expect(
      reconcileFounderRecoveryArchives({
        now: new Date(START.valueOf() + 23 * 60 * 60 * 1_000),
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({ eligible: 1, created: 0, failed: 0, deleted: 0 });

    await expect(
      reconcileFounderRecoveryArchives({
        now: new Date(START.valueOf() + 24 * 60 * 60 * 1_000),
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({ eligible: 1, created: 1, failed: 0, deleted: 0 });

    expect(await connection.db.select().from(founderRecoveryArchives)).toHaveLength(2);
  });

  it("resumes daily protection after an explicit Release Hold", async () => {
    const holdAt = new Date(START.valueOf() + 1_000);
    await connection.db.insert(founderReleaseDecisions).values({
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      stage: "owner_preview",
      outcome: "hold",
      applicationRevision: "7".repeat(40),
      runtimeRevision: "runtime-v1",
      capabilityManifest: ["openai", "calendar_reading"],
      evidenceDigests: [`sha256:${"6".repeat(64)}`],
      decidedAt: holdAt,
      createdAt: holdAt,
    });
    await expect(
      reconcileFounderRecoveryArchives({
        now: new Date(START.valueOf() + 24 * 60 * 60 * 1_000),
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ eligible: 0, created: 0, failed: 0, deleted: 0 });

    const resumeAt = new Date(holdAt.valueOf() + 1_000);
    await connection.db.insert(founderReleaseDecisions).values({
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      stage: "owner_preview",
      outcome: "resume",
      applicationRevision: "5".repeat(40),
      runtimeRevision: "runtime-v1",
      capabilityManifest: ["openai", "calendar_reading"],
      evidenceDigests: [`sha256:${"4".repeat(64)}`],
      decidedAt: resumeAt,
      createdAt: resumeAt,
    });
    await expect(
      reconcileFounderRecoveryArchives({
        now: new Date(START.valueOf() + 24 * 60 * 60 * 1_000 + 1_000),
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ eligible: 1, created: 1, failed: 0, deleted: 0 });
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
      { action: "release_stage_admission", userId: USER_ID, now: START },
      blockingProvider,
      connection,
      () => START,
    );
    await firstUploadStarted;
    const second = createDurableRecoveryArchive(
      { action: "release_stage_admission", userId: USER_ID, now: START },
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
      { action: "release_stage_admission", userId: USER_ID, now: START },
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
        now: START,
      }),
    );

    const [intent] = await connection.db
      .select()
      .from(founderRecoveryArchives)
      .where(eq(founderRecoveryArchives.id, archiveId));
    expect(intent).toMatchObject({
      status: "pending",
      storageObjectKey: `founder-recovery/${USER_ID}/${archiveId}.age`,
      recoveryCredentialObjectKey: `founder-recovery/${USER_ID}/${archiveId}.key`,
      expiresAt: new Date(START.valueOf() + 30 * 24 * 60 * 60 * 1_000),
    });
  });

  it("fails admission closed and records bounded failure state when storage is unavailable", async () => {
    await expect(
      createDurableRecoveryArchive(
        { action: "release_stage_admission", userId: USER_ID, now: START },
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
      evidenceDigests: [`sha256:${"f".repeat(64)}`],
      decidedAt: new Date(START.valueOf() + 1_000),
      createdAt: new Date(START.valueOf() + 1_000),
    });
    const expiresAt = new Date(START.valueOf() + 30 * 24 * 60 * 60 * 1_000);
    await expect(
      reconcileFounderRecoveryArchives({
        now: expiresAt,
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ eligible: 0, created: 0, failed: 0, deleted: 1 });
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
      { action: "release_stage_admission", userId: USER_ID, now: START },
      provider,
      connection,
      () => START,
    );
    const expiresAt = new Date(START.valueOf() + 30 * 24 * 60 * 60 * 1_000);

    await expect(
      reconcileFounderRecoveryArchives({
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
      { action: "release_stage_admission", userId: USER_ID, now: START },
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

  it("deletes expired archives after the latest release decision becomes ineligible", async () => {
    const archiveId = await createDurableRecoveryArchive(
      { action: "release_stage_admission", userId: USER_ID, now: START },
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
      evidenceDigests: [`sha256:${"d".repeat(64)}`],
      decidedAt: new Date(START.valueOf() + 60 * 60 * 1_000),
      createdAt: new Date(START.valueOf() + 60 * 60 * 1_000),
    });
    const expiresAt = new Date(START.valueOf() + 30 * 24 * 60 * 60 * 1_000);

    await expect(
      reconcileFounderRecoveryArchives({
        now: expiresAt,
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ eligible: 0, created: 0, failed: 0, deleted: 1 });

    const [deleted] = await connection.db
      .select()
      .from(founderRecoveryArchives)
      .where(eq(founderRecoveryArchives.id, archiveId));
    expect(deleted).toMatchObject({ status: "deleted", deletedAt: expiresAt });
  });

  it("retains the final archive for expiry without minting replacements after retirement", async () => {
    await createDurableRecoveryArchive(
      { action: "release_stage_admission", userId: USER_ID, now: START },
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
      idempotencyKey: `sha256:${"1".repeat(64)}`,
      providerResourceId: "droplet-373",
      providerFirewallId: "firewall-373",
      status: "completed",
      resourcesBefore: 2,
      resourcesAfter: 0,
      workStoppedAt: retiredAt,
      credentialsDisabledAt: retiredAt,
      firewallDeletedAt: retiredAt,
      dropletDeletedAt: retiredAt,
      absenceVerifiedAt: retiredAt,
      failureCode: null,
      attemptCount: 1,
      leaseToken: "retirement-lease-373",
      leaseExpiresAt: retiredAt,
      createdAt: retiredAt,
      updatedAt: retiredAt,
    });

    await expect(
      reconcileFounderRecoveryArchives({
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
      evidenceDigests: [`sha256:${"3".repeat(64)}`],
      decidedAt: readmittedAt,
      createdAt: readmittedAt,
    });
    await expect(
      reconcileFounderRecoveryArchives({
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
      "delete from founder_recovery_archive_deletion_receipts; delete from founder_infrastructure_retirements; delete from founder_recovery_archives; delete from founder_release_decisions; delete from runners; delete from operator_runtimes; delete from operator_preparations; delete from operators; delete from users",
    );
  }
});
