import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNotNull, lte, sql } from "drizzle-orm";
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
  assertFounderRecoveryArchiveDeletionIdentity,
  type FounderRecoveryArchiveCreationProvider,
  type FounderRecoveryArchiveDurableState,
  type FounderRecoveryArchiveProvider,
  founderRecoveryArchiveObjectIdentity,
} from "./recovery-archive-provider";

const DAILY_ARCHIVE_WINDOW_MS = 24 * 60 * 60 * 1_000;
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
  providers: FounderRecoveryArchiveCreationProvider,
  connection: DatabaseConnection,
): Promise<string> {
  const intent = await connection.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:founder-lifecycle:${input.userId}`}, 0))`,
    );
    const [operator] = await tx
      .select({
        id: operators.id,
        createdAt: operators.createdAt,
        mailOfferDisposition: operators.mailOfferDisposition,
        externalActionPause: operators.externalActionPause,
      })
      .from(operators)
      .where(and(eq(operators.userId, input.userId), eq(operators.status, "active")))
      .limit(1)
      .for("update");
    if (!operator) throw new Error("An active persisted Operator is required.");
    const [preparation] = await tx
      .select({
        status: operatorPreparations.status,
        timezone: operatorPreparations.timezone,
        timezoneConfirmedAt: operatorPreparations.timezoneConfirmedAt,
      })
      .from(operatorPreparations)
      .where(eq(operatorPreparations.operatorId, operator.id))
      .limit(1);
    if (
      preparation?.status !== "ready" ||
      !preparation.timezone ||
      !preparation.timezoneConfirmedAt
    ) {
      throw new Error("A ready persisted Operator preparation is required.");
    }
    const [runtime] = await tx
      .select({ status: operatorRuntimes.status, configRevision: operatorRuntimes.configRevision })
      .from(operatorRuntimes)
      .where(eq(operatorRuntimes.operatorId, operator.id))
      .limit(1);
    if (runtime?.status !== "ready" || !runtime.configRevision) {
      throw new Error("A ready persisted Operator runtime is required.");
    }
    if (input.action === "recovery_archive_lifecycle") {
      await requireOperationalEntitlement(tx, input.userId, input.now);
    }
    if (input.action === "scheduled_archive" || input.action === "release_stage_admission") {
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
            gt(
              founderRecoveryArchives.observedAt,
              new Date(input.now.valueOf() - DAILY_ARCHIVE_WINDOW_MS),
            ),
          ),
        )
        .orderBy(desc(founderRecoveryArchives.observedAt))
        .limit(1);
      if (current) return { archiveId: current.id, operatorId: operator.id, alreadyCurrent: true };
    }
    const archiveId = await persistFounderRecoveryArchiveIntentInTransaction(tx, {
      userId: input.userId,
      operatorId: operator.id,
      now: input.now,
    });
    return { archiveId, operatorId: operator.id, alreadyCurrent: false };
  });

  if (intent.alreadyCurrent) return intent.archiveId;

  await fulfillRecoveryArchiveIntent(
    input,
    providers,
    connection,
    intent.archiveId,
    intent.operatorId,
    true,
  );
  return intent.archiveId;
}

export async function persistFounderRecoveryArchiveIntentInTransaction(
  tx: RecoveryArchiveTransaction,
  input: { userId: string; operatorId: string; now: Date },
): Promise<string> {
  const archiveWindowStart = new Date(input.now.valueOf() - DAILY_ARCHIVE_WINDOW_MS);
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
  providers: FounderRecoveryArchiveCreationProvider,
  connection: DatabaseConnection,
  archiveId: string,
  operatorId: string,
  failClosed: boolean,
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
    if (!verified) throw new Error("Recovery Archive intent is no longer pending.");
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

export async function reconcileFounderRecoveryArchives(input: {
  now: Date;
  provider: FounderRecoveryArchiveProvider;
  createConnection?: () => DatabaseConnection;
}): Promise<{ eligible: number; created: number; failed: number; deleted: number }> {
  const connection =
    input.createConnection?.() ??
    (await import("@/src/server/db/client")).createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  try {
    const decisions = await connection.db
      .select({
        userId: founderReleaseDecisions.userId,
        outcome: founderReleaseDecisions.outcome,
        decidedAt: founderReleaseDecisions.decidedAt,
      })
      .from(founderReleaseDecisions)
      .innerJoin(
        operators,
        and(eq(operators.id, founderReleaseDecisions.operatorId), eq(operators.status, "active")),
      )
      .orderBy(desc(founderReleaseDecisions.decidedAt));
    const latestByUser = new Map<string, (typeof decisions)[number]>();
    for (const decision of decisions) {
      if (!latestByUser.has(decision.userId)) latestByUser.set(decision.userId, decision);
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
    const eligibleUsers = [...latestByUser.values()]
      .filter(
        (decision) =>
          decision.outcome === "enter" &&
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
          if (statusBeforeCreation.state === "current") continue;
          await createDurableRecoveryArchive(
            { action: "scheduled_archive", userId, now: input.now },
            input.provider,
            connection,
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
