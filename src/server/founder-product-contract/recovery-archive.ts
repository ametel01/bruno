import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNotNull, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  founderInfrastructureRetirements,
  founderRecoveryArchiveDeletionReceipts,
  founderRecoveryArchives,
  founderReleaseDecisions,
  operatorPreparations,
  operatorRuntimes,
  operators,
} from "@/src/server/db/schema";
import { expireFounderRecoveryArchivesForUser } from "./archive-expiry";
import { requireOperationalEntitlement } from "./entitlement";
import type { FounderProductContractLifecycleAction } from "./lifecycle";
import {
  lockFounderProductContractLifecycleInTransaction,
  requireReadyFounderOperatorAuthorityInTransaction,
} from "./operator-authority";
import {
  assertFounderRecoveryArchiveDeletionIdentity,
  type FounderRecoveryArchiveCreationProvider,
  type FounderRecoveryArchiveDurableState,
  type FounderRecoveryArchiveProvider,
  founderRecoveryArchiveObjectIdentity,
} from "./recovery-archive-provider";

const DAILY_ARCHIVE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const SCHEDULED_ARCHIVE_REFRESH_MS = DAILY_ARCHIVE_WINDOW_MS - 2 * 60 * 60 * 1_000;
const ARCHIVE_RETENTION_MS = 30 * DAILY_ARCHIVE_WINDOW_MS;

type RecoveryArchiveTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

type ArchiveLifecycleInput = {
  action: FounderProductContractLifecycleAction | "scheduled_archive";
  userId: string;
  now: Date;
};

export type FounderRecoveryArchiveStatusDto = {
  state: "current" | "due" | "failed" | "unavailable";
  lastVerifiedAt: string | null;
  restoreVerifiedAt: string | null;
  nextArchiveDueAt: string | null;
  retentionEndsAt: string | null;
  deletion: {
    status: "pending" | "failed" | "completed";
    attemptedAt: string;
    completedAt: string | null;
  } | null;
};

export async function createDurableRecoveryArchive(
  input: ArchiveLifecycleInput,
  providers: FounderRecoveryArchiveProvider,
  connection: DatabaseConnection,
  clock: () => Date,
): Promise<string> {
  const intent = await connection.db.transaction(async (tx) => {
    const { operatorId } = await requireReadyFounderOperatorAuthorityInTransaction(
      tx,
      input.userId,
    );
    if (input.action === "recovery_archive_lifecycle") {
      await requireOperationalEntitlement(tx, input.userId, input.now);
    }
    if (input.action === "scheduled_archive" || input.action === "release_stage_admission") {
      const reuseWindowMs =
        input.action === "scheduled_archive"
          ? SCHEDULED_ARCHIVE_REFRESH_MS
          : DAILY_ARCHIVE_WINDOW_MS;
      const [current] = await tx
        .select({ id: founderRecoveryArchives.id })
        .from(founderRecoveryArchives)
        .where(
          and(
            eq(founderRecoveryArchives.userId, input.userId),
            eq(founderRecoveryArchives.status, "verified"),
            eq(founderRecoveryArchives.formatVersion, 1),
            eq(founderRecoveryArchives.restorableVerified, true),
            lte(founderRecoveryArchives.observedAt, input.now),
            gt(founderRecoveryArchives.observedAt, new Date(input.now.valueOf() - reuseWindowMs)),
          ),
        )
        .orderBy(desc(founderRecoveryArchives.observedAt))
        .limit(1);
      if (current) return { archiveId: current.id, operatorId, alreadyCurrent: true };
    }
    const archiveId = await persistFounderRecoveryArchiveIntentInTransaction(tx, {
      userId: input.userId,
      operatorId,
      now: input.now,
    });
    return { archiveId, operatorId, alreadyCurrent: false };
  });

  if (intent.alreadyCurrent) return intent.archiveId;

  await fulfillRecoveryArchiveIntent(
    input,
    providers,
    connection,
    intent.archiveId,
    intent.operatorId,
    true,
    clock,
  );
  return intent.archiveId;
}

export async function persistFounderRecoveryArchiveIntentInTransaction(
  tx: RecoveryArchiveTransaction,
  input: {
    userId: string;
    operatorId: string;
    now: Date;
    pendingIntentPolicy?: "reject_recent" | "supersede_for_retirement";
  },
): Promise<string> {
  const archiveWindowStart = new Date(input.now.valueOf() - DAILY_ARCHIVE_WINDOW_MS);
  if (input.pendingIntentPolicy === "supersede_for_retirement") {
    await tx
      .update(founderRecoveryArchives)
      .set({ status: "failed", failureCode: "archive_create_superseded_by_retirement" })
      .where(
        and(
          eq(founderRecoveryArchives.userId, input.userId),
          eq(founderRecoveryArchives.status, "pending"),
        ),
      );
  } else {
    const [pending] = await tx
      .select({ id: founderRecoveryArchives.id })
      .from(founderRecoveryArchives)
      .where(
        and(
          eq(founderRecoveryArchives.userId, input.userId),
          eq(founderRecoveryArchives.status, "pending"),
          gt(founderRecoveryArchives.observedAt, archiveWindowStart),
        ),
      )
      .limit(1)
      .for("update");
    if (pending) throw new Error("Recovery Archive creation is already in progress.");

    await tx
      .update(founderRecoveryArchives)
      .set({ status: "failed", failureCode: "archive_create_abandoned" })
      .where(
        and(
          eq(founderRecoveryArchives.userId, input.userId),
          eq(founderRecoveryArchives.status, "pending"),
          isNotNull(founderRecoveryArchives.storageObjectKey),
          lte(founderRecoveryArchives.observedAt, archiveWindowStart),
        ),
      );
  }

  const archiveId = randomUUID();
  const objectIdentity = founderRecoveryArchiveObjectIdentity(input.userId, archiveId);
  const [record] = await tx
    .insert(founderRecoveryArchives)
    .values({
      id: archiveId,
      userId: input.userId,
      operatorId: input.operatorId,
      status: "pending",
      formatVersion: null,
      ...objectIdentity,
      ciphertextDigest: null,
      recoveryCredentialDigest: null,
      stateDigest: null,
      restorableVerified: false,
      restoreVerifiedAt: null,
      failureCode: null,
      observedAt: input.now,
      expiresAt: new Date(input.now.valueOf() + ARCHIVE_RETENTION_MS),
      createdAt: input.now,
    })
    .returning({ id: founderRecoveryArchives.id });
  if (!record) throw new Error("Recovery Archive intent was not persisted.");
  return record.id;
}

export async function fulfillRecoveryArchiveIntent(
  input: Pick<ArchiveLifecycleInput, "userId" | "now">,
  providers: FounderRecoveryArchiveProvider,
  connection: DatabaseConnection,
  archiveId: string,
  operatorId: string,
  failClosed: boolean,
  clock: () => Date,
): Promise<void> {
  try {
    const state = await loadFounderRecoveryArchiveDurableState(connection, operatorId);
    const archive = await providers.createRecoveryArchive({
      archiveIntentId: archiveId,
      userId: input.userId,
      operatorId,
      observedAt: input.now,
      state,
    });
    assertVerifiedArchiveOutcome(archiveId, input, operatorId, archive);
    const [verified] = await connection.db
      .update(founderRecoveryArchives)
      .set({
        status: "verified",
        formatVersion: archive.formatVersion,
        storageObjectKey: archive.storageObjectKey,
        recoveryCredentialObjectKey: archive.recoveryCredentialObjectKey,
        ciphertextDigest: archive.ciphertextDigest,
        recoveryCredentialDigest: archive.recoveryCredentialDigest,
        stateDigest: archive.stateDigest,
        restorableVerified: archive.restorableVerified,
        restoreVerifiedAt: archive.restoreVerifiedAt,
        failureCode: null,
      })
      .where(
        and(
          eq(founderRecoveryArchives.id, archiveId),
          eq(founderRecoveryArchives.status, "pending"),
        ),
      )
      .returning({ id: founderRecoveryArchives.id });
    if (!verified) {
      await cleanupRejectedRecoveryArchivePublication(
        input.userId,
        archiveId,
        archive,
        providers,
        connection,
        clock,
      );
      throw new Error("Recovery Archive intent is no longer pending.");
    }
  } catch (error) {
    await connection.db
      .update(founderRecoveryArchives)
      .set({
        status: "failed",
        formatVersion: null,
        ciphertextDigest: null,
        recoveryCredentialDigest: null,
        stateDigest: null,
        restorableVerified: false,
        restoreVerifiedAt: null,
        failureCode: "archive_create_failed",
      })
      .where(
        and(
          eq(founderRecoveryArchives.id, archiveId),
          eq(founderRecoveryArchives.status, "pending"),
        ),
      );
    if (failClosed) throw error;
  }
}

async function cleanupRejectedRecoveryArchivePublication(
  userId: string,
  archiveId: string,
  archive: Awaited<ReturnType<FounderRecoveryArchiveProvider["createRecoveryArchive"]>>,
  providers: FounderRecoveryArchiveProvider,
  connection: DatabaseConnection,
  clock: () => Date,
): Promise<void> {
  try {
    const deleted = await providers.deleteRecoveryArchive({
      archiveId,
      storageObjectKey: archive.storageObjectKey,
      recoveryCredentialObjectKey: archive.recoveryCredentialObjectKey,
      idempotencyKey: archive.deletionIdempotencyKey,
    });
    if (!deleted.archiveAbsent || !deleted.recoveryCredentialsAbsent) {
      throw new Error("Rejected Recovery Archive publication absence was not verified.");
    }
    await recordRejectedRecoveryArchivePublicationCleanup(userId, archiveId, clock(), connection);
  } catch {
    await connection.db.transaction(async (tx) => {
      await lockFounderProductContractLifecycleInTransaction(tx, userId);
      const [reopened] = await tx
        .update(founderRecoveryArchives)
        .set({
          status: "failed",
          formatVersion: null,
          storageObjectKey: archive.storageObjectKey,
          recoveryCredentialObjectKey: archive.recoveryCredentialObjectKey,
          ciphertextDigest: null,
          recoveryCredentialDigest: null,
          stateDigest: null,
          restorableVerified: false,
          restoreVerifiedAt: null,
          failureCode: "archive_late_publication_cleanup_failed",
          deletedAt: null,
        })
        .where(
          and(
            eq(founderRecoveryArchives.id, archiveId),
            eq(founderRecoveryArchives.status, "deleted"),
          ),
        )
        .returning({ id: founderRecoveryArchives.id });
      if (!reopened) return;
      await tx
        .update(founderRecoveryArchiveDeletionReceipts)
        .set({
          status: "pending",
          archiveProviderConfirmed: false,
          recoveryCredentialsConfirmed: false,
          completedAt: null,
          failureCode: "archive_late_publication_cleanup_failed",
        })
        .where(eq(founderRecoveryArchiveDeletionReceipts.archiveId, archiveId));
    });
  }
}

async function recordRejectedRecoveryArchivePublicationCleanup(
  userId: string,
  archiveId: string,
  cleanupObservedAt: Date,
  connection: DatabaseConnection,
): Promise<void> {
  await connection.db.transaction(async (tx) => {
    await lockFounderProductContractLifecycleInTransaction(tx, userId);
    const [archive] = await tx
      .select({ status: founderRecoveryArchives.status })
      .from(founderRecoveryArchives)
      .where(eq(founderRecoveryArchives.id, archiveId))
      .limit(1)
      .for("update");
    if (archive?.status !== "deleted") return;
    const [receipt] = await tx
      .select({ completedAt: founderRecoveryArchiveDeletionReceipts.completedAt })
      .from(founderRecoveryArchiveDeletionReceipts)
      .where(eq(founderRecoveryArchiveDeletionReceipts.archiveId, archiveId))
      .limit(1)
      .for("update");
    if (!receipt?.completedAt) {
      throw new Error("Recovery Archive late-cleanup receipt is unavailable.");
    }
    if (cleanupObservedAt <= receipt.completedAt) {
      throw new Error("Recovery Archive late-cleanup observation time is stale.");
    }
    const [updated] = await tx
      .update(founderRecoveryArchiveDeletionReceipts)
      .set({
        status: "completed",
        archiveProviderConfirmed: true,
        recoveryCredentialsConfirmed: true,
        attemptedAt: cleanupObservedAt,
        completedAt: cleanupObservedAt,
        failureCode: null,
      })
      .where(eq(founderRecoveryArchiveDeletionReceipts.archiveId, archiveId))
      .returning({ id: founderRecoveryArchiveDeletionReceipts.id });
    if (!updated) throw new Error("Recovery Archive late cleanup was not recorded.");
  });
}

export async function reconcileFounderRecoveryArchives(input: {
  now: Date;
  provider: FounderRecoveryArchiveProvider;
  createConnection?: () => DatabaseConnection;
  clock?: () => Date;
}): Promise<{ eligible: number; created: number; failed: number; deleted: number }> {
  const connection =
    input.createConnection?.() ??
    (await import("@/src/server/db/client")).createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  try {
    const decisions = await connection.db
      .select({
        userId: founderReleaseDecisions.userId,
        stage: founderReleaseDecisions.stage,
        outcome: founderReleaseDecisions.outcome,
        capabilityManifest: founderReleaseDecisions.capabilityManifest,
        affectedCapabilities: founderReleaseDecisions.affectedCapabilities,
        decidedAt: founderReleaseDecisions.decidedAt,
      })
      .from(founderReleaseDecisions)
      .innerJoin(
        operators,
        and(eq(operators.id, founderReleaseDecisions.operatorId), eq(operators.status, "active")),
      )
      .orderBy(desc(founderReleaseDecisions.decidedAt));
    const latestByUserAndStage = new Map<string, (typeof decisions)[number]>();
    for (const decision of decisions) {
      const key = `${decision.userId}:${decision.stage}`;
      if (!latestByUserAndStage.has(key)) latestByUserAndStage.set(key, decision);
    }
    const retiredOwners = await connection.db
      .select({
        userId: founderInfrastructureRetirements.userId,
        retiredAt: founderInfrastructureRetirements.absenceVerifiedAt,
      })
      .from(founderInfrastructureRetirements)
      .where(eq(founderInfrastructureRetirements.status, "completed"))
      .orderBy(desc(founderInfrastructureRetirements.absenceVerifiedAt));
    const latestRetirementByUser = new Map<string, Date>();
    for (const retirement of retiredOwners) {
      if (retirement.retiredAt && !latestRetirementByUser.has(retirement.userId)) {
        latestRetirementByUser.set(retirement.userId, retirement.retiredAt);
      }
    }
    const latestAdmissionByUserAndStage = new Map<string, (typeof decisions)[number]>();
    for (const decision of decisions) {
      if (decision.outcome !== "enter" && decision.outcome !== "resume") continue;
      const key = `${decision.userId}:${decision.stage}`;
      if (!latestAdmissionByUserAndStage.has(key)) {
        latestAdmissionByUserAndStage.set(key, decision);
      }
    }
    const latestAdmittedDecisionByUser = new Map<string, (typeof decisions)[number]>();
    for (const [key, latestDecision] of latestByUserAndStage) {
      if (latestDecision.outcome === "deny") continue;
      if (
        latestDecision.outcome === "hold" &&
        latestDecision.capabilityManifest.every((capability) =>
          latestDecision.affectedCapabilities.includes(capability),
        )
      ) {
        continue;
      }
      const admission = latestAdmissionByUserAndStage.get(key);
      if (!admission) continue;
      const current = latestAdmittedDecisionByUser.get(admission.userId);
      if (!current || current.decidedAt < admission.decidedAt) {
        latestAdmittedDecisionByUser.set(admission.userId, admission);
      }
    }
    const eligibleUsers = [...latestAdmittedDecisionByUser.values()]
      .filter(
        (decision) =>
          (latestRetirementByUser.get(decision.userId) ?? new Date(0)) < decision.decidedAt,
      )
      .map((decision) => decision.userId);
    const retainedArchives = await connection.db
      .select({ userId: founderRecoveryArchives.userId })
      .from(founderRecoveryArchives)
      .where(inArray(founderRecoveryArchives.status, ["pending", "verified", "failed"]));
    const usersToProcess = new Set([
      ...eligibleUsers,
      ...retainedArchives.map((archive) => archive.userId),
    ]);
    const eligible = new Set(eligibleUsers);
    let created = 0;
    let failed = 0;
    let deleted = 0;
    for (const userId of usersToProcess) {
      try {
        deleted += await expireFounderRecoveryArchivesForUser(
          userId,
          input.now,
          input.provider,
          connection,
        );
        if (eligible.has(userId)) {
          const statusBeforeCreation = await getFounderRecoveryArchiveStatusForUser(
            userId,
            input.now,
            {
              createConnection: () => connection,
            },
          );
          const lastVerifiedAt = statusBeforeCreation.lastVerifiedAt
            ? new Date(statusBeforeCreation.lastVerifiedAt)
            : null;
          if (
            statusBeforeCreation.state === "current" &&
            lastVerifiedAt &&
            lastVerifiedAt > new Date(input.now.valueOf() - SCHEDULED_ARCHIVE_REFRESH_MS)
          ) {
            continue;
          }
          await createDurableRecoveryArchive(
            { action: "scheduled_archive", userId, now: input.now },
            input.provider,
            connection,
            input.clock ?? (() => new Date()),
          );
          created += 1;
        }
      } catch {
        failed += 1;
      }
    }
    return { eligible: eligibleUsers.length, created, failed, deleted };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function getFounderRecoveryArchiveStatusForUser(
  userId: string,
  now: Date,
  dependencies: { createConnection?: () => DatabaseConnection } = {},
): Promise<FounderRecoveryArchiveStatusDto> {
  const connection =
    dependencies.createConnection?.() ??
    (await import("@/src/server/db/client")).createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const [latest] = await connection.db
      .select()
      .from(founderRecoveryArchives)
      .where(eq(founderRecoveryArchives.userId, userId))
      .orderBy(desc(founderRecoveryArchives.observedAt))
      .limit(1);
    const [deletion] = await connection.db
      .select({
        status: founderRecoveryArchiveDeletionReceipts.status,
        attemptedAt: founderRecoveryArchiveDeletionReceipts.attemptedAt,
        completedAt: founderRecoveryArchiveDeletionReceipts.completedAt,
        failureCode: founderRecoveryArchiveDeletionReceipts.failureCode,
      })
      .from(founderRecoveryArchiveDeletionReceipts)
      .where(eq(founderRecoveryArchiveDeletionReceipts.userId, userId))
      .orderBy(desc(founderRecoveryArchiveDeletionReceipts.attemptedAt))
      .limit(1);
    const current = latest ? isCurrentVerifiedRecoveryArchive(latest, now) : false;
    return {
      state: current
        ? "current"
        : latest?.status === "failed"
          ? "failed"
          : latest && latest.status !== "deleted"
            ? "due"
            : "unavailable",
      lastVerifiedAt: latest?.status === "verified" ? latest.observedAt.toISOString() : null,
      restoreVerifiedAt: latest?.restoreVerifiedAt?.toISOString() ?? null,
      nextArchiveDueAt:
        latest?.status === "verified"
          ? new Date(latest.observedAt.valueOf() + DAILY_ARCHIVE_WINDOW_MS).toISOString()
          : null,
      retentionEndsAt: latest?.expiresAt.toISOString() ?? null,
      deletion: deletion
        ? {
            status:
              deletion.status === "completed"
                ? "completed"
                : deletion.failureCode
                  ? "failed"
                  : "pending",
            attemptedAt: deletion.attemptedAt.toISOString(),
            completedAt: deletion.completedAt?.toISOString() ?? null,
          }
        : null,
    };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function loadFounderRecoveryArchiveDurableState(
  connection: DatabaseConnection,
  operatorId: string,
): Promise<FounderRecoveryArchiveDurableState> {
  return connection.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ operator: operators, preparation: operatorPreparations, runtime: operatorRuntimes })
      .from(operators)
      .innerJoin(operatorPreparations, eq(operatorPreparations.operatorId, operators.id))
      .innerJoin(operatorRuntimes, eq(operatorRuntimes.operatorId, operators.id))
      .where(eq(operators.id, operatorId))
      .limit(1);
    if (
      row?.operator.status !== "active" ||
      row.preparation.status !== "ready" ||
      !row.preparation.timezone ||
      !row.preparation.timezoneConfirmedAt ||
      row.runtime.status !== "ready" ||
      !row.runtime.configRevision
    ) {
      throw new Error("Recovery Archive durable state is not eligible for restoration.");
    }
    return {
      schemaVersion: 1,
      operator: {
        id: row.operator.id,
        createdAt: row.operator.createdAt.toISOString(),
        mailOfferDisposition: row.operator.mailOfferDisposition,
        externalActionPaused: row.operator.externalActionPause,
        externalActionPauseReason: row.operator.externalActionPauseReason,
        externalActionPausedAt: row.operator.externalActionPausedAt?.toISOString() ?? null,
      },
      preparation: {
        timezone: row.preparation.timezone,
        timezoneConfirmedAt: row.preparation.timezoneConfirmedAt.toISOString(),
      },
      runtime: { configRevision: row.runtime.configRevision },
      restoration: {
        logicalOperatorId: row.operator.id,
        providerReauthorizationRequired: true,
        reusableCredentials: [],
      },
    };
  });
}

function assertVerifiedArchiveOutcome(
  archiveId: string,
  input: Pick<ArchiveLifecycleInput, "userId" | "now">,
  operatorId: string,
  archive: Awaited<ReturnType<FounderRecoveryArchiveCreationProvider["createRecoveryArchive"]>>,
): void {
  assertFounderRecoveryArchiveDeletionIdentity({
    archiveId,
    storageObjectKey: archive.storageObjectKey,
    recoveryCredentialObjectKey: archive.recoveryCredentialObjectKey,
    idempotencyKey: archive.deletionIdempotencyKey,
  });
  if (
    archive.formatVersion !== 1 ||
    archive.restorableVerified !== true ||
    archive.restoreVerifiedAt.valueOf() !== input.now.valueOf() ||
    !/^sha256:[a-f0-9]{64}$/.test(archive.ciphertextDigest) ||
    !/^sha256:[a-f0-9]{64}$/.test(archive.stateDigest) ||
    !archive.storageObjectKey.includes(`/${input.userId}/`) ||
    operatorId.length === 0
  ) {
    throw new Error("Recovery Archive provider did not prove an exact restorable v1 archive.");
  }
}

function isCurrentVerifiedRecoveryArchive(
  archive: typeof founderRecoveryArchives.$inferSelect,
  now: Date,
): boolean {
  return (
    archive.status === "verified" &&
    archive.formatVersion === 1 &&
    archive.restorableVerified &&
    archive.restoreVerifiedAt !== null &&
    archive.observedAt <= now &&
    archive.observedAt > new Date(now.valueOf() - DAILY_ARCHIVE_WINDOW_MS) &&
    archive.expiresAt > now
  );
}
