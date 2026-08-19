import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorActionPreviewRevisions,
  operatorActionPreviews,
  operatorAiConnections,
  operatorCalendarConnections,
  operatorDeletionBackupExpiries,
  operatorDeletionReceipts,
  operatorDeletionRequests,
  operatorDeletionRevocations,
  operatorDeletionTombstones,
  operatorFounderActivations,
  operatorFounderDataExports,
  operatorMorningBriefItems,
  operatorMorningBriefs,
  operatorMailConnections,
  operatorMailSendingConnections,
  operatorProposedActions,
  operatorProcessingConsents,
  operatorRelationshipCandidates,
  operatorRelationshipCorrections,
  operatorRelationshipEvidence,
  operatorRelationshipRecords,
  operatorConversationMessages,
  operatorConversationWorks,
  operatorConversations,
  operators,
} from "@/src/server/db/schema";
import {
  disconnectFounderAnthropicForUser,
  disconnectFounderOpenAiForUser,
} from "@/src/server/operators/founder-ai-connection";
import { disconnectFounderGoogleCalendarForUser } from "@/src/server/operators/founder-calendar-connection";
import { disconnectFounderGoogleMailForUser } from "@/src/server/operators/founder-mail-connection";
import { disconnectFounderGoogleMailSendingForUser } from "@/src/server/operators/founder-mail-sending-connection";

type DeletionTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export const FOUNDER_ACTIVE_PURGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const FOUNDER_BACKUP_EXPIRY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const FOUNDER_REVOCATION_RETRY_MS = 60 * 60 * 1000;

export type FounderDeletionKind = "retained_data" | "account_closure";
export type FounderDeletionStage =
  | "requested"
  | "access_stopped"
  | "active_purge_complete"
  | "backup_expiry"
  | "revocation";

export type FounderDeletionRevocationResult = {
  connectionKind: string;
  ok: boolean;
  errorCode?: string;
};

export type FounderDeletionDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  randomUUID?: () => string;
  revokeConnections?: (userId: string) => Promise<FounderDeletionRevocationResult[]>;
};

export type FounderDeletionReceipt = {
  request: {
    id: string;
    kind: FounderDeletionKind;
    status: string;
    requestedAt: string;
    activePurgeDueAt: string;
    backupExpiryDueAt: string;
    accessStoppedAt: string | null;
    activePurgeCompletedAt: string | null;
    backupExpiredAt: string | null;
    completedAt: string | null;
    failureCode: string | null;
  };
  stages: Array<{
    stage: FounderDeletionStage;
    occurredAt: string;
    details: Record<string, unknown>;
  }>;
  revocations: Array<{
    connectionKind: string;
    provider: string;
    status: string;
    attemptCount: number;
    errorCode: string | null;
    lastAttemptAt: string | null;
    nextAttemptAt: string | null;
  }>;
  backups: Array<{
    backupKind: string;
    backupId: string;
    status: string;
    expiresAt: string;
    expiredAt: string | null;
    errorCode: string | null;
  }>;
};

export async function requestFounderDeletionForUser(
  userId: string,
  kind: FounderDeletionKind,
  scope: Record<string, unknown> = {},
  dependencies: FounderDeletionDependencies = {},
): Promise<FounderDeletionReceipt | null> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const makeId = dependencies.randomUUID ?? randomUUID;
  try {
    const request = await connection.db.transaction(async (tx) => {
      const [operator] = await tx
        .select()
        .from(operators)
        .where(and(eq(operators.userId, userId), eq(operators.status, "active")))
        .orderBy(desc(operators.updatedAt))
        .limit(1);
      if (!operator) return null;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:deletion:${operator.id}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(operatorDeletionRequests)
        .where(
          and(
            eq(operatorDeletionRequests.operatorId, operator.id),
            sql`${operatorDeletionRequests.status} <> 'completed'`,
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.kind === kind || kind !== "account_closure") return existing;
        const [upgraded] = await tx
          .update(operatorDeletionRequests)
          .set({
            kind: "account_closure",
            scope: { ...(existing.scope ?? {}), ...scope },
            updatedAt: now(),
          })
          .where(eq(operatorDeletionRequests.id, existing.id))
          .returning();
        await tx
          .update(operators)
          .set({
            externalActionPause: true,
            externalActionPauseReason: "Account closure requested; external effects are paused.",
            externalActionPausedAt: existing.accessStoppedAt ?? now(),
            updatedAt: now(),
          })
          .where(eq(operators.id, operator.id));
        await stageAccountClosure(tx, operator.id, existing.id, now(), makeId);
        return upgraded ?? { ...existing, kind: "account_closure" as const };
      }

      const requestedAt = now();
      const activePurgeDueAt = new Date(requestedAt.getTime() + FOUNDER_ACTIVE_PURGE_WINDOW_MS);
      const backupExpiryDueAt = new Date(requestedAt.getTime() + FOUNDER_BACKUP_EXPIRY_WINDOW_MS);
      const [created] = await tx
        .insert(operatorDeletionRequests)
        .values({
          id: makeId(),
          operatorId: operator.id,
          kind,
          status: "access_stopped",
          scope,
          requestedAt,
          activePurgeDueAt,
          backupExpiryDueAt,
          accessStoppedAt: requestedAt,
          createdAt: requestedAt,
          updatedAt: requestedAt,
        })
        .returning();
      if (!created) throw new Error("deletion_request_not_created");

      await tx
        .update(operators)
        .set({
          externalActionPause: true,
          externalActionPauseReason:
            kind === "account_closure"
              ? "Account closure requested; external effects are paused."
              : "Data deletion requested; external effects are paused.",
          externalActionPausedAt: requestedAt,
          updatedAt: requestedAt,
        })
        .where(eq(operators.id, operator.id));
      await tx
        .update(operatorProcessingConsents)
        .set({ status: "revoked", revokedAt: requestedAt })
        .where(
          and(
            eq(operatorProcessingConsents.operatorId, operator.id),
            eq(operatorProcessingConsents.status, "active"),
          ),
        );

      await tx.insert(operatorDeletionReceipts).values([
        {
          id: makeId(),
          requestId: created.id,
          operatorId: operator.id,
          stage: "requested",
          occurredAt: requestedAt,
          details: { kind, scope },
          createdAt: requestedAt,
        },
        {
          id: makeId(),
          requestId: created.id,
          operatorId: operator.id,
          stage: "access_stopped",
          occurredAt: requestedAt,
          details: {
            externalActionPause: true,
            processingConsentsRevoked: true,
            activePurgeDueAt: activePurgeDueAt.toISOString(),
          },
          createdAt: requestedAt,
        },
      ]);

      if (kind === "account_closure") {
        await stageAccountClosure(tx, operator.id, created.id, requestedAt, makeId);
      }

      const exports = await tx
        .select({ id: operatorFounderDataExports.id })
        .from(operatorFounderDataExports)
        .where(eq(operatorFounderDataExports.operatorId, operator.id));
      const backupRows = exports.length > 0 ? exports : [{ id: `operator:${operator.id}` }];
      await tx
        .insert(operatorDeletionBackupExpiries)
        .values(
          backupRows.map((backup) => ({
            id: makeId(),
            requestId: created.id,
            operatorId: operator.id,
            backupKind: "founder_data_export",
            backupId: backup.id,
            expiresAt: backupExpiryDueAt,
            createdAt: requestedAt,
            updatedAt: requestedAt,
          })),
        )
        .onConflictDoNothing();
      return created;
    });
    if (!request) return null;
    if (request.kind === "account_closure") {
      await attemptFounderDeletionRevocations(userId, request.id, dependencies);
    }
    return getFounderDeletionReceiptForUser(userId, {
      ...dependencies,
      createConnection: () => connection,
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function processFounderDeletionRequests(
  dependencies: FounderDeletionDependencies = {},
): Promise<{ processed: number; failed: number }> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  try {
    const requests = await connection.db
      .select()
      .from(operatorDeletionRequests)
      .where(sql`${operatorDeletionRequests.status} <> 'completed'`);
    let processed = 0;
    let failed = 0;
    for (const request of requests) {
      try {
        await connection.db.transaction((tx) => processRequest(tx, request, now()));
        if (request.kind === "account_closure" && now() < request.backupExpiryDueAt) {
          const [owner] = await connection.db
            .select({ userId: operators.userId })
            .from(operators)
            .where(eq(operators.id, request.operatorId))
            .limit(1);
          if (owner)
            await attemptFounderDeletionRevocations(owner.userId, request.id, dependencies);
        }
        processed += 1;
      } catch {
        failed += 1;
        await connection.db
          .update(operatorDeletionRequests)
          .set({ status: "failed", failureCode: "deletion_processing_failed", updatedAt: now() })
          .where(eq(operatorDeletionRequests.id, request.id));
      }
    }
    return { processed, failed };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function retryFounderDeletionRevocationsForUser(
  userId: string,
  dependencies: FounderDeletionDependencies = {},
): Promise<FounderDeletionReceipt | null> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const [request] = await connection.db
      .select({ request: operatorDeletionRequests })
      .from(operatorDeletionRequests)
      .innerJoin(operators, eq(operators.id, operatorDeletionRequests.operatorId))
      .where(
        and(
          eq(operators.userId, userId),
          eq(operatorDeletionRequests.kind, "account_closure"),
          sql`${operatorDeletionRequests.status} <> 'completed'`,
        ),
      )
      .orderBy(desc(operatorDeletionRequests.createdAt))
      .limit(1);
    if (!request) return null;
    await attemptFounderDeletionRevocations(userId, request.request.id, dependencies);
    return getFounderDeletionReceiptForUser(userId, {
      ...dependencies,
      createConnection: () => connection,
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function getFounderDeletionReceiptForUser(
  userId: string,
  dependencies: Pick<FounderDeletionDependencies, "createConnection"> = {},
): Promise<FounderDeletionReceipt | null> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return connection.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ request: operatorDeletionRequests })
        .from(operatorDeletionRequests)
        .innerJoin(operators, eq(operators.id, operatorDeletionRequests.operatorId))
        .where(eq(operators.userId, userId))
        .orderBy(desc(operatorDeletionRequests.createdAt))
        .limit(1);
      if (!row) return null;
      const [stages, revocations, backups] = await Promise.all([
        tx
          .select()
          .from(operatorDeletionReceipts)
          .where(eq(operatorDeletionReceipts.requestId, row.request.id))
          .orderBy(operatorDeletionReceipts.occurredAt),
        tx
          .select()
          .from(operatorDeletionRevocations)
          .where(eq(operatorDeletionRevocations.requestId, row.request.id))
          .orderBy(operatorDeletionRevocations.connectionKind),
        tx
          .select()
          .from(operatorDeletionBackupExpiries)
          .where(eq(operatorDeletionBackupExpiries.requestId, row.request.id))
          .orderBy(
            operatorDeletionBackupExpiries.backupKind,
            operatorDeletionBackupExpiries.backupId,
          ),
      ]);
      return {
        request: {
          id: row.request.id,
          kind: row.request.kind,
          status: row.request.status,
          requestedAt: row.request.requestedAt.toISOString(),
          activePurgeDueAt: row.request.activePurgeDueAt.toISOString(),
          backupExpiryDueAt: row.request.backupExpiryDueAt.toISOString(),
          accessStoppedAt: row.request.accessStoppedAt?.toISOString() ?? null,
          activePurgeCompletedAt: row.request.activePurgeCompletedAt?.toISOString() ?? null,
          backupExpiredAt: row.request.backupExpiredAt?.toISOString() ?? null,
          completedAt: row.request.completedAt?.toISOString() ?? null,
          failureCode: row.request.failureCode,
        },
        stages: stages.map((stage) => ({
          stage: stage.stage,
          occurredAt: stage.occurredAt.toISOString(),
          details: stage.details,
        })),
        revocations: revocations.map((item) => ({
          connectionKind: item.connectionKind,
          provider: item.provider,
          status: item.status,
          attemptCount: item.attemptCount,
          errorCode: item.errorCode,
          lastAttemptAt: item.lastAttemptAt?.toISOString() ?? null,
          nextAttemptAt: item.nextAttemptAt?.toISOString() ?? null,
        })),
        backups: backups.map((item) => ({
          backupKind: item.backupKind,
          backupId: item.backupId,
          status: item.status,
          expiresAt: item.expiresAt.toISOString(),
          expiredAt: item.expiredAt?.toISOString() ?? null,
          errorCode: item.errorCode,
        })),
      };
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function stageAccountClosure(
  tx: DeletionTransaction,
  operatorId: string,
  requestId: string,
  requestedAt: Date,
  makeId: () => string,
): Promise<void> {
  await tx
    .update(operatorProposedActions)
    .set({ state: "cancelled", updatedAt: requestedAt })
    .where(
      and(
        eq(operatorProposedActions.operatorId, operatorId),
        inArray(operatorProposedActions.state, ["proposed", "awaiting_approval", "authorized"]),
      ),
    );
  const [aiConnections, calendarConnections, mailConnections, sendingConnections] =
    await Promise.all([
      tx
        .select({
          id: operatorAiConnections.id,
          provider: operatorAiConnections.provider,
          providerSubjectId: operatorAiConnections.providerSubjectId,
        })
        .from(operatorAiConnections)
        .where(eq(operatorAiConnections.operatorId, operatorId)),
      tx
        .select({
          id: operatorCalendarConnections.id,
          provider: operatorCalendarConnections.provider,
          providerSubjectId: operatorCalendarConnections.providerSubjectId,
        })
        .from(operatorCalendarConnections)
        .where(eq(operatorCalendarConnections.operatorId, operatorId)),
      tx
        .select({
          id: operatorMailConnections.id,
          provider: operatorMailConnections.provider,
          providerSubjectId: operatorMailConnections.providerSubjectId,
        })
        .from(operatorMailConnections)
        .where(eq(operatorMailConnections.operatorId, operatorId)),
      tx
        .select({
          id: operatorMailSendingConnections.id,
          provider: operatorMailSendingConnections.provider,
          providerSubjectId: operatorMailSendingConnections.providerSubjectId,
        })
        .from(operatorMailSendingConnections)
        .where(eq(operatorMailSendingConnections.operatorId, operatorId)),
    ]);
  const revocations = [
    ...aiConnections.map((item) => ({ ...item, connectionKind: `ai:${item.provider}` })),
    ...calendarConnections.map((item) => ({ ...item, connectionKind: "calendar" })),
    ...mailConnections.map((item) => ({ ...item, connectionKind: "mail" })),
    ...sendingConnections.map((item) => ({ ...item, connectionKind: "mail_sending" })),
  ];
  if (revocations.length === 0) return;
  await tx
    .insert(operatorDeletionRevocations)
    .values(
      revocations.map((item) => ({
        id: makeId(),
        requestId,
        operatorId,
        connectionKind: item.connectionKind,
        connectionId: item.id,
        provider: item.provider,
        providerIdentity: item.providerSubjectId,
        status: "pending" as const,
        createdAt: requestedAt,
        updatedAt: requestedAt,
      })),
    )
    .onConflictDoNothing();
}

async function attemptFounderDeletionRevocations(
  userId: string,
  requestId: string,
  dependencies: FounderDeletionDependencies,
): Promise<void> {
  let results: FounderDeletionRevocationResult[] = [];
  let revocationCallFailed = false;
  try {
    results = await (dependencies.revokeConnections ?? defaultRevokeConnections)(userId);
  } catch {
    revocationCallFailed = true;
  }
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  try {
    await connection.db.transaction(async (tx) => {
      const [requestOwner] = await tx
        .select({ operatorId: operatorDeletionRequests.operatorId })
        .from(operatorDeletionRequests)
        .where(eq(operatorDeletionRequests.id, requestId))
        .limit(1);
      if (!requestOwner) return;
      const localRevocationMessage =
        "Access was removed locally. Provider revocation remains unconfirmed and can be retried.";
      await tx
        .update(operatorAiConnections)
        .set({
          status: "disconnected",
          authorizationState: "revocation_unconfirmed",
          capacityState: "unknown",
          inferenceState: "unknown",
          authorizationPersisted: false,
          authorizationSessionHash: null,
          authorizationExpiresAt: null,
          approvedModelAssignment: null,
          disconnectedAt: sql`coalesce(${operatorAiConnections.disconnectedAt}, now())`,
          failureCode: "provider_revocation_unconfirmed",
          recoveryMessage: localRevocationMessage,
          workPausedReason: localRevocationMessage,
          updatedAt: now(),
        })
        .where(
          and(
            eq(operatorAiConnections.operatorId, requestOwner.operatorId),
            sql`${operatorAiConnections.status} <> 'disconnected'`,
          ),
        );
      await tx
        .update(operatorCalendarConnections)
        .set({
          status: "disconnected",
          authorizationState: "revocation_unconfirmed",
          authorizationSessionHash: null,
          authorizationExpiresAt: null,
          accessTokenCiphertext: null,
          accessTokenIv: null,
          accessTokenAuthTag: null,
          refreshTokenCiphertext: null,
          refreshTokenIv: null,
          refreshTokenAuthTag: null,
          secretKeyVersion: null,
          tokenExpiresAt: null,
          failureCode: "provider_revocation_unconfirmed",
          recoveryMessage: localRevocationMessage,
          disconnectedAt: sql`coalesce(${operatorCalendarConnections.disconnectedAt}, now())`,
          updatedAt: now(),
        })
        .where(
          and(
            eq(operatorCalendarConnections.operatorId, requestOwner.operatorId),
            sql`${operatorCalendarConnections.status} <> 'disconnected'`,
          ),
        );
      await tx
        .update(operatorMailConnections)
        .set({
          status: "disconnected",
          authorizationState: "revocation_unconfirmed",
          authorizationSessionHash: null,
          authorizationExpiresAt: null,
          accessTokenCiphertext: null,
          accessTokenIv: null,
          accessTokenAuthTag: null,
          refreshTokenCiphertext: null,
          refreshTokenIv: null,
          refreshTokenAuthTag: null,
          secretKeyVersion: null,
          tokenExpiresAt: null,
          failureCode: "provider_revocation_unconfirmed",
          recoveryMessage: localRevocationMessage,
          disconnectedAt: sql`coalesce(${operatorMailConnections.disconnectedAt}, now())`,
          updatedAt: now(),
        })
        .where(
          and(
            eq(operatorMailConnections.operatorId, requestOwner.operatorId),
            sql`${operatorMailConnections.status} <> 'disconnected'`,
          ),
        );
      await tx
        .update(operatorMailSendingConnections)
        .set({
          status: "disconnected",
          authorizationState: "revocation_unconfirmed",
          authorizationSessionHash: null,
          authorizationExpiresAt: null,
          accessTokenCiphertext: null,
          accessTokenIv: null,
          accessTokenAuthTag: null,
          refreshTokenCiphertext: null,
          refreshTokenIv: null,
          refreshTokenAuthTag: null,
          secretKeyVersion: null,
          tokenExpiresAt: null,
          failureCode: "provider_revocation_unconfirmed",
          recoveryMessage: localRevocationMessage,
          disconnectedAt: sql`coalesce(${operatorMailSendingConnections.disconnectedAt}, now())`,
          updatedAt: now(),
        })
        .where(
          and(
            eq(operatorMailSendingConnections.operatorId, requestOwner.operatorId),
            sql`${operatorMailSendingConnections.status} <> 'disconnected'`,
          ),
        );
      for (const result of results) {
        const [row] = await tx
          .select()
          .from(operatorDeletionRevocations)
          .where(
            and(
              eq(operatorDeletionRevocations.requestId, requestId),
              eq(operatorDeletionRevocations.connectionKind, result.connectionKind),
            ),
          )
          .limit(1);
        if (!row) continue;
        const attemptedAt = now();
        await tx
          .update(operatorDeletionRevocations)
          .set({
            status: result.ok ? "succeeded" : "failed",
            attemptCount: row.attemptCount + 1,
            lastAttemptAt: attemptedAt,
            nextAttemptAt: result.ok
              ? null
              : new Date(attemptedAt.getTime() + FOUNDER_REVOCATION_RETRY_MS),
            errorCode: result.ok ? null : (result.errorCode ?? "provider_revocation_unconfirmed"),
            updatedAt: attemptedAt,
          })
          .where(eq(operatorDeletionRevocations.id, row.id));
      }
      if (revocationCallFailed) {
        const pendingRows = await tx
          .select()
          .from(operatorDeletionRevocations)
          .where(
            and(
              eq(operatorDeletionRevocations.requestId, requestId),
              or(
                eq(operatorDeletionRevocations.status, "pending"),
                eq(operatorDeletionRevocations.status, "failed"),
              ),
            ),
          );
        for (const row of pendingRows) {
          const attemptedAt = now();
          await tx
            .update(operatorDeletionRevocations)
            .set({
              status: "failed",
              attemptCount: row.attemptCount + 1,
              lastAttemptAt: attemptedAt,
              nextAttemptAt: new Date(attemptedAt.getTime() + FOUNDER_REVOCATION_RETRY_MS),
              errorCode: "provider_revocation_failed",
              updatedAt: attemptedAt,
            })
            .where(eq(operatorDeletionRevocations.id, row.id));
        }
      }
      const [pending] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(operatorDeletionRevocations)
        .where(
          and(
            eq(operatorDeletionRevocations.requestId, requestId),
            or(
              eq(operatorDeletionRevocations.status, "pending"),
              eq(operatorDeletionRevocations.status, "failed"),
            ),
          ),
        );
      if (Number(pending?.count ?? 0) === 0) {
        const [request] = await tx
          .select({ operatorId: operatorDeletionRequests.operatorId })
          .from(operatorDeletionRequests)
          .where(eq(operatorDeletionRequests.id, requestId))
          .limit(1);
        if (!request) return;
        await tx
          .insert(operatorDeletionReceipts)
          .values({
            id: randomUUID(),
            requestId,
            operatorId: request.operatorId,
            stage: "revocation",
            occurredAt: now(),
            details: { outcome: "all_connections_revoked" },
            createdAt: now(),
          })
          .onConflictDoNothing();
      }
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function processRequest(
  tx: DeletionTransaction,
  request: typeof operatorDeletionRequests.$inferSelect,
  now: Date,
): Promise<void> {
  if (request.backupExpiredAt) {
    await tx
      .update(operatorDeletionRequests)
      .set({
        status: "completed",
        completedAt: request.completedAt ?? request.backupExpiredAt,
        updatedAt: now,
      })
      .where(eq(operatorDeletionRequests.id, request.id));
    if (request.kind === "account_closure") {
      await tx
        .update(operators)
        .set({ status: "archived", archivedAt: request.backupExpiredAt, updatedAt: now })
        .where(eq(operators.id, request.operatorId));
    }
    return;
  }
  if (!request.activePurgeCompletedAt && now >= request.activePurgeDueAt) {
    const counts = await purgeActiveFounderContent(tx, request);
    await tx
      .update(operatorDeletionRequests)
      .set({
        status: "backup_expiry_pending",
        activePurgeCompletedAt: now,
        updatedAt: now,
        summary: counts,
      })
      .where(eq(operatorDeletionRequests.id, request.id));
    await tx.insert(operatorDeletionReceipts).values({
      id: randomUUID(),
      requestId: request.id,
      operatorId: request.operatorId,
      stage: "active_purge_complete",
      occurredAt: now,
      details: counts,
      createdAt: now,
    });
  }
  if (now >= request.backupExpiryDueAt) {
    const expiredExports = await tx
      .update(operatorFounderDataExports)
      .set({ expiresAt: new Date(0), payload: { schemaVersion: 1, expired: true } })
      .where(eq(operatorFounderDataExports.operatorId, request.operatorId))
      .returning({ id: operatorFounderDataExports.id });
    await tx
      .update(operatorDeletionBackupExpiries)
      .set({ status: "expired", expiredAt: now, updatedAt: now })
      .where(eq(operatorDeletionBackupExpiries.requestId, request.id));
    await tx.insert(operatorDeletionReceipts).values({
      id: randomUUID(),
      requestId: request.id,
      operatorId: request.operatorId,
      stage: "backup_expiry",
      occurredAt: now,
      details: { expiredExports: expiredExports.length },
      createdAt: now,
    });
    await tx
      .update(operatorDeletionRequests)
      .set({
        status: "completed",
        backupExpiredAt: now,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(operatorDeletionRequests.id, request.id));
    if (request.kind === "account_closure") {
      await tx
        .update(operators)
        .set({ status: "archived", archivedAt: now, updatedAt: now })
        .where(eq(operators.id, request.operatorId));
    }
  }
}

async function purgeActiveFounderContent(
  tx: DeletionTransaction,
  request: typeof operatorDeletionRequests.$inferSelect,
): Promise<Record<string, number>> {
  const at = request.activePurgeDueAt;
  const tombstone = async (entityType: string, entityId: string) => {
    await tx
      .insert(operatorDeletionTombstones)
      .values({
        id: randomUUID(),
        requestId: request.id,
        operatorId: request.operatorId,
        entityType,
        entityId,
        erasedAt: at,
        reason: "founder_deletion",
        createdAt: at,
      })
      .onConflictDoNothing();
  };
  const conversations = await tx
    .select({ id: operatorConversations.id })
    .from(operatorConversations)
    .where(eq(operatorConversations.operatorId, request.operatorId));
  const conversationIds = conversations.map((item) => item.id);
  let conversationMessages = 0;
  let conversationWorks = 0;
  let conversationsDeleted = 0;
  if (conversationIds.length > 0) {
    const messages = await tx
      .delete(operatorConversationMessages)
      .where(inArray(operatorConversationMessages.conversationId, conversationIds))
      .returning({ id: operatorConversationMessages.id });
    for (const item of messages) await tombstone("conversation_message", item.id);
    conversationMessages = messages.length;
    const works = await tx
      .delete(operatorConversationWorks)
      .where(inArray(operatorConversationWorks.conversationId, conversationIds))
      .returning({ id: operatorConversationWorks.id });
    for (const item of works) await tombstone("conversation_work", item.id);
    conversationWorks = works.length;
    const removed = await tx
      .delete(operatorConversations)
      .where(eq(operatorConversations.operatorId, request.operatorId))
      .returning({ id: operatorConversations.id });
    for (const item of removed) await tombstone("conversation", item.id);
    conversationsDeleted = removed.length;
  }
  const briefs = await tx
    .select({ id: operatorMorningBriefs.id })
    .from(operatorMorningBriefs)
    .where(eq(operatorMorningBriefs.operatorId, request.operatorId));
  const briefIds = briefs.map((item) => item.id);
  let briefItems = 0;
  let briefsDeleted = 0;
  if (briefIds.length > 0) {
    const items = await tx
      .delete(operatorMorningBriefItems)
      .where(inArray(operatorMorningBriefItems.briefId, briefIds))
      .returning({ id: operatorMorningBriefItems.id });
    for (const item of items) await tombstone("morning_brief_item", item.id);
    briefItems = items.length;
    const activations = await tx
      .delete(operatorFounderActivations)
      .where(eq(operatorFounderActivations.operatorId, request.operatorId))
      .returning({ id: operatorFounderActivations.id });
    for (const item of activations) await tombstone("founder_activation", item.id);
    const removed = await tx
      .delete(operatorMorningBriefs)
      .where(eq(operatorMorningBriefs.operatorId, request.operatorId))
      .returning({ id: operatorMorningBriefs.id });
    for (const item of removed) await tombstone("morning_brief", item.id);
    briefsDeleted = removed.length;
  }
  const evidence = await tx
    .delete(operatorRelationshipEvidence)
    .where(eq(operatorRelationshipEvidence.operatorId, request.operatorId))
    .returning({ id: operatorRelationshipEvidence.id });
  for (const item of evidence) await tombstone("relationship_evidence", item.id);
  const candidates = await tx
    .delete(operatorRelationshipCandidates)
    .where(eq(operatorRelationshipCandidates.operatorId, request.operatorId))
    .returning({ id: operatorRelationshipCandidates.id });
  for (const item of candidates) await tombstone("relationship_candidate", item.id);
  const corrections = await tx
    .delete(operatorRelationshipCorrections)
    .where(eq(operatorRelationshipCorrections.operatorId, request.operatorId))
    .returning({ id: operatorRelationshipCorrections.id });
  for (const item of corrections) await tombstone("relationship_correction", item.id);
  const records = await tx
    .delete(operatorRelationshipRecords)
    .where(eq(operatorRelationshipRecords.operatorId, request.operatorId))
    .returning({ id: operatorRelationshipRecords.id });
  for (const item of records) await tombstone("relationship_record", item.id);

  const previews = await tx
    .select({ id: operatorActionPreviews.id })
    .from(operatorActionPreviews)
    .where(eq(operatorActionPreviews.operatorId, request.operatorId));
  const previewIds = previews.map((item) => item.id);
  let previewRevisions = 0;
  let previewsDeleted = 0;
  if (previewIds.length > 0) {
    const revisions = await tx
      .delete(operatorActionPreviewRevisions)
      .where(inArray(operatorActionPreviewRevisions.previewId, previewIds))
      .returning({ id: operatorActionPreviewRevisions.id });
    for (const item of revisions) await tombstone("action_preview_revision", item.id);
    previewRevisions = revisions.length;
    const removed = await tx
      .delete(operatorActionPreviews)
      .where(eq(operatorActionPreviews.operatorId, request.operatorId))
      .returning({ id: operatorActionPreviews.id });
    for (const item of removed) await tombstone("action_preview", item.id);
    previewsDeleted = removed.length;
  }

  const actions = await tx
    .select({ id: operatorProposedActions.id })
    .from(operatorProposedActions)
    .where(eq(operatorProposedActions.operatorId, request.operatorId));
  if (actions.length > 0) {
    await tx
      .update(operatorProposedActions)
      .set({
        businessOutcome: "Content removed under Founder deletion.",
        destination: {},
        materialContent: {},
        sideEffects: [],
        preconditions: [],
        updatedAt: at,
      })
      .where(eq(operatorProposedActions.operatorId, request.operatorId));
    for (const item of actions) await tombstone("proposed_action", item.id);
  }
  return {
    conversationMessages,
    conversationWorks,
    conversations: conversationsDeleted,
    morningBriefItems: briefItems,
    morningBriefs: briefsDeleted,
    relationshipEvidence: evidence.length,
    relationshipCandidates: candidates.length,
    relationshipCorrections: corrections.length,
    relationshipRecords: records.length,
    actionPreviewRevisions: previewRevisions,
    actionPreviews: previewsDeleted,
    proposedActions: actions.length,
  };
}

async function defaultRevokeConnections(
  userId: string,
): Promise<FounderDeletionRevocationResult[]> {
  const calls: Array<
    [string, () => Promise<{ status?: string; recoveryMessage?: string | null } | null>]
  > = [
    ["ai:openai", () => disconnectFounderOpenAiForUser(userId)],
    ["ai:anthropic", () => disconnectFounderAnthropicForUser(userId)],
    ["calendar", () => disconnectFounderGoogleCalendarForUser(userId)],
    ["mail", () => disconnectFounderGoogleMailForUser(userId)],
    ["mail_sending", () => disconnectFounderGoogleMailSendingForUser(userId)],
  ];
  const results: FounderDeletionRevocationResult[] = [];
  for (const [connectionKind, call] of calls) {
    try {
      const result = await call();
      if (result) {
        results.push({
          connectionKind,
          ok: result.status === "disconnected" && !result.recoveryMessage,
          ...(result.recoveryMessage ? { errorCode: "provider_revocation_unconfirmed" } : {}),
        });
      }
    } catch {
      results.push({ connectionKind, ok: false, errorCode: "provider_revocation_failed" });
    }
  }
  return results;
}
