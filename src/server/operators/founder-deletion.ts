import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  LemonSqueezyApiProvider,
  readLemonSqueezyConfig,
} from "@/src/server/commerce/lemon-squeezy-provider";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  founderProductEntitlements,
  operatorActionPreviewRevisions,
  operatorActionPreviews,
  operatorAiConnections,
  operatorCalendarConnections,
  operatorConversationMessages,
  operatorConversations,
  operatorConversationWorks,
  operatorDeletionBackupExpiries,
  operatorDeletionCommerceCancellations,
  operatorDeletionReceipts,
  operatorDeletionRequests,
  operatorDeletionRevocations,
  operatorDeletionTombstones,
  operatorFounderActivations,
  operatorFounderDataExports,
  operatorMailConnections,
  operatorMailSendingConnections,
  operatorMorningBriefItems,
  operatorMorningBriefs,
  operatorProcessingConsents,
  operatorProposedActions,
  operatorRelationshipCandidates,
  operatorRelationshipCorrections,
  operatorRelationshipEvidence,
  operatorRelationshipRecords,
  operators,
} from "@/src/server/db/schema";
import { revokeDeterministicFounderContractGoogleConnection } from "@/src/server/founder-product-contract/deterministic-providers";
import {
  disconnectFounderAnthropicForUser,
  disconnectFounderOpenAiForUser,
} from "@/src/server/operators/founder-ai-connection";
import {
  createGoogleCalendarAdapter,
  disconnectFounderGoogleCalendarForUser,
} from "@/src/server/operators/founder-calendar-connection";
import { disconnectFounderGoogleMailForUser } from "@/src/server/operators/founder-mail-connection";
import { disconnectFounderGoogleMailSendingForUser } from "@/src/server/operators/founder-mail-sending-connection";

type DeletionTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export const FOUNDER_ACTIVE_PURGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const FOUNDER_BACKUP_EXPIRY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const FOUNDER_REVOCATION_RETRY_MS = 60 * 60 * 1000;
export const FOUNDER_REVOCATION_MAX_ATTEMPTS = 3;

export type FounderDeletionKind = "retained_data" | "account_closure";
export type FounderDeletionStage =
  | "requested"
  | "access_stopped"
  | "commerce_cancellation"
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
  revokeConnections?: (
    userId: string,
    connectionKinds?: readonly string[],
  ) => Promise<FounderDeletionRevocationResult[]>;
  cancelCommerce?: (providerSubscriptionId: string) => Promise<void>;
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
  commerceCancellation: {
    provider: "lemon_squeezy";
    status: "pending" | "succeeded" | "failed";
    attemptCount: number;
    lastAttemptAt: string | null;
    confirmedAt: string | null;
    errorCode: string | null;
    refundStarted: false;
  } | null;
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
      await coordinateFounderAccountClosureEffects(userId, request.id, dependencies);
      await synchronizeAccountClosureCompletionState(request.id, dependencies);
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
      .where(sql`${operatorDeletionRequests.status} <> 'completed'
        OR EXISTS (
          SELECT 1 FROM ${operatorDeletionCommerceCancellations}
          WHERE ${operatorDeletionCommerceCancellations.requestId} = ${operatorDeletionRequests.id}
            AND ${operatorDeletionCommerceCancellations.status} <> 'succeeded'
        )
        OR EXISTS (
          SELECT 1 FROM ${operatorDeletionRevocations}
          WHERE ${operatorDeletionRevocations.requestId} = ${operatorDeletionRequests.id}
            AND ${operatorDeletionRevocations.status} <> 'succeeded'
        )`);
    let processed = 0;
    let failed = 0;
    for (const request of requests) {
      try {
        if (request.kind === "account_closure") {
          const [owner] = await connection.db
            .select({ userId: operators.userId })
            .from(operators)
            .where(eq(operators.id, request.operatorId))
            .limit(1);
          if (!owner) throw new Error("account_closure_owner_unavailable");
          await coordinateFounderAccountClosureEffects(owner.userId, request.id, dependencies);
          const effectsResolved = await synchronizeAccountClosureCompletionState(
            request.id,
            dependencies,
          );
          if (!effectsResolved) {
            processed += 1;
            continue;
          }
        }
        await connection.db.transaction((tx) => processRequest(tx, request, now()));
        if (request.kind === "account_closure") {
          await synchronizeAccountClosureCompletionState(request.id, dependencies);
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
        and(eq(operators.userId, userId), eq(operatorDeletionRequests.kind, "account_closure")),
      )
      .orderBy(desc(operatorDeletionRequests.createdAt))
      .limit(1);
    if (!request) return null;
    await coordinateFounderAccountClosureEffects(userId, request.request.id, dependencies);
    await synchronizeAccountClosureCompletionState(request.request.id, dependencies);
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
      const [stages, revocations, commerceCancellations, backups] = await Promise.all([
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
          .from(operatorDeletionCommerceCancellations)
          .where(eq(operatorDeletionCommerceCancellations.requestId, row.request.id))
          .limit(1),
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
        commerceCancellation: commerceCancellations[0]
          ? {
              provider: "lemon_squeezy" as const,
              status: commerceCancellations[0].status,
              attemptCount: commerceCancellations[0].attemptCount,
              lastAttemptAt: commerceCancellations[0].lastAttemptAt?.toISOString() ?? null,
              confirmedAt: commerceCancellations[0].confirmedAt?.toISOString() ?? null,
              errorCode: commerceCancellations[0].errorCode,
              refundStarted: false as const,
            }
          : null,
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
  const [commerce] = await tx
    .select({
      providerSubscriptionId: founderProductEntitlements.providerSubscriptionId,
      status: founderProductEntitlements.status,
    })
    .from(founderProductEntitlements)
    .innerJoin(operators, eq(operators.userId, founderProductEntitlements.userId))
    .where(eq(operators.id, operatorId))
    .limit(1);
  if (commerce && ["verified", "past_due", "unpaid", "refunded"].includes(commerce.status)) {
    await tx
      .insert(operatorDeletionCommerceCancellations)
      .values({
        id: makeId(),
        requestId,
        operatorId,
        provider: "lemon_squeezy",
        providerSubscriptionId: commerce.providerSubscriptionId,
        createdAt: requestedAt,
        updatedAt: requestedAt,
      })
      .onConflictDoNothing({ target: operatorDeletionCommerceCancellations.requestId });
  } else if (commerce && ["cancelled", "expired"].includes(commerce.status)) {
    await tx
      .insert(operatorDeletionCommerceCancellations)
      .values({
        id: makeId(),
        requestId,
        operatorId,
        provider: "lemon_squeezy",
        providerSubscriptionId: commerce.providerSubscriptionId,
        status: "succeeded",
        attemptCount: 0,
        confirmedAt: requestedAt,
        createdAt: requestedAt,
        updatedAt: requestedAt,
      })
      .onConflictDoNothing({ target: operatorDeletionCommerceCancellations.requestId });
    await tx
      .insert(operatorDeletionReceipts)
      .values({
        id: makeId(),
        requestId,
        operatorId,
        stage: "commerce_cancellation",
        occurredAt: requestedAt,
        details: {
          provider: "lemon_squeezy",
          outcome: "subscription_already_terminal",
          providerStatus: commerce.status,
          productEntitlementChanged: false,
          refundStarted: false,
        },
        createdAt: requestedAt,
      })
      .onConflictDoNothing({
        target: [operatorDeletionReceipts.requestId, operatorDeletionReceipts.stage],
      });
  }
  const [aiConnections, calendarConnections, mailConnections, sendingConnections] =
    await Promise.all([
      tx
        .select({
          id: operatorAiConnections.id,
          provider: operatorAiConnections.provider,
          providerSubjectId: operatorAiConnections.providerSubjectId,
          authorizationState: operatorAiConnections.authorizationState,
        })
        .from(operatorAiConnections)
        .where(eq(operatorAiConnections.operatorId, operatorId)),
      tx
        .select({
          id: operatorCalendarConnections.id,
          provider: operatorCalendarConnections.provider,
          providerSubjectId: operatorCalendarConnections.providerSubjectId,
          authorizationState: operatorCalendarConnections.authorizationState,
        })
        .from(operatorCalendarConnections)
        .where(eq(operatorCalendarConnections.operatorId, operatorId)),
      tx
        .select({
          id: operatorMailConnections.id,
          provider: operatorMailConnections.provider,
          providerSubjectId: operatorMailConnections.providerSubjectId,
          authorizationState: operatorMailConnections.authorizationState,
        })
        .from(operatorMailConnections)
        .where(eq(operatorMailConnections.operatorId, operatorId)),
      tx
        .select({
          id: operatorMailSendingConnections.id,
          provider: operatorMailSendingConnections.provider,
          providerSubjectId: operatorMailSendingConnections.providerSubjectId,
          authorizationState: operatorMailSendingConnections.authorizationState,
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
        status:
          item.authorizationState === "revoked" ? ("succeeded" as const) : ("pending" as const),
        createdAt: requestedAt,
        updatedAt: requestedAt,
      })),
    )
    .onConflictDoNothing();
  if (revocations.every((item) => item.authorizationState === "revoked")) {
    await tx
      .insert(operatorDeletionReceipts)
      .values({
        id: makeId(),
        requestId,
        operatorId,
        stage: "revocation",
        occurredAt: requestedAt,
        details: { outcome: "connections_already_revoked" },
        createdAt: requestedAt,
      })
      .onConflictDoNothing({
        target: [operatorDeletionReceipts.requestId, operatorDeletionReceipts.stage],
      });
  }
}

async function attemptFounderCommerceCancellation(
  requestId: string,
  dependencies: FounderDeletionDependencies,
): Promise<void> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  try {
    const [cancellation] = await connection.db
      .select()
      .from(operatorDeletionCommerceCancellations)
      .where(eq(operatorDeletionCommerceCancellations.requestId, requestId))
      .limit(1);
    if (!cancellation || cancellation.status === "succeeded") return;

    const attemptedAt = now();
    let errorCode: string | null = null;
    try {
      await (dependencies.cancelCommerce ?? defaultCancelFounderCommerce)(
        cancellation.providerSubscriptionId,
      );
    } catch {
      errorCode = "commerce_cancellation_unconfirmed";
    }

    await connection.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(operatorDeletionCommerceCancellations)
        .where(eq(operatorDeletionCommerceCancellations.id, cancellation.id))
        .limit(1)
        .for("update");
      if (!current || current.status === "succeeded") return;
      await tx
        .update(operatorDeletionCommerceCancellations)
        .set({
          status: errorCode ? "failed" : "succeeded",
          attemptCount: current.attemptCount + 1,
          lastAttemptAt: attemptedAt,
          confirmedAt: errorCode ? null : attemptedAt,
          errorCode,
          updatedAt: attemptedAt,
        })
        .where(eq(operatorDeletionCommerceCancellations.id, current.id));
      if (!errorCode) {
        await tx
          .insert(operatorDeletionReceipts)
          .values({
            id: randomUUID(),
            requestId,
            operatorId: current.operatorId,
            stage: "commerce_cancellation",
            occurredAt: attemptedAt,
            details: {
              provider: "lemon_squeezy",
              outcome: "subscription_cancellation_requested",
              productEntitlementChanged: false,
              refundStarted: false,
            },
            createdAt: attemptedAt,
          })
          .onConflictDoNothing();
      }
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function coordinateFounderAccountClosureEffects(
  userId: string,
  requestId: string,
  dependencies: FounderDeletionDependencies,
): Promise<void> {
  await attemptFounderCommerceCancellation(requestId, dependencies);
  await attemptFounderDeletionRevocations(userId, requestId, dependencies);
}

async function synchronizeAccountClosureCompletionState(
  requestId: string,
  dependencies: FounderDeletionDependencies,
): Promise<boolean> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  try {
    return await connection.db.transaction(async (tx) => {
      const [request] = await tx
        .select({
          status: operatorDeletionRequests.status,
          activePurgeCompletedAt: operatorDeletionRequests.activePurgeCompletedAt,
          backupExpiredAt: operatorDeletionRequests.backupExpiredAt,
          completedAt: operatorDeletionRequests.completedAt,
        })
        .from(operatorDeletionRequests)
        .where(eq(operatorDeletionRequests.id, requestId))
        .limit(1)
        .for("update");
      if (!request) return false;
      const [unresolvedCommerce, unresolvedRevocation, exhaustedRevocation] = await Promise.all([
        tx
          .select({ id: operatorDeletionCommerceCancellations.id })
          .from(operatorDeletionCommerceCancellations)
          .where(
            and(
              eq(operatorDeletionCommerceCancellations.requestId, requestId),
              sql`${operatorDeletionCommerceCancellations.status} <> 'succeeded'`,
            ),
          )
          .limit(1),
        tx
          .select({ id: operatorDeletionRevocations.id })
          .from(operatorDeletionRevocations)
          .where(
            and(
              eq(operatorDeletionRevocations.requestId, requestId),
              sql`${operatorDeletionRevocations.status} <> 'succeeded'`,
            ),
          )
          .limit(1),
        tx
          .select({ id: operatorDeletionRevocations.id })
          .from(operatorDeletionRevocations)
          .where(
            and(
              eq(operatorDeletionRevocations.requestId, requestId),
              eq(operatorDeletionRevocations.errorCode, "provider_revocation_recovery_exhausted"),
            ),
          )
          .limit(1),
      ]);
      const unresolved = Boolean(unresolvedCommerce[0] || unresolvedRevocation[0]);
      const recoveryExhausted = Boolean(exhaustedRevocation[0]);
      await tx
        .update(operatorDeletionRequests)
        .set(
          unresolved
            ? {
                status: "failed",
                failureCode: recoveryExhausted
                  ? "account_closure_revocation_recovery_exhausted"
                  : "account_closure_external_effects_unresolved",
                completedAt: null,
                updatedAt: now(),
              }
            : !request.backupExpiredAt
              ? {
                  status: request.activePurgeCompletedAt
                    ? "backup_expiry_pending"
                    : "access_stopped",
                  failureCode: null,
                  completedAt: null,
                  updatedAt: now(),
                }
              : {
                  status: "completed",
                  failureCode: null,
                  completedAt: request.completedAt ?? request.backupExpiredAt,
                  updatedAt: now(),
                },
        )
        .where(eq(operatorDeletionRequests.id, requestId));
      return !unresolved;
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function defaultCancelFounderCommerce(providerSubscriptionId: string): Promise<void> {
  const config = readLemonSqueezyConfig();
  if (!config) throw new Error("Commerce provider is not configured.");
  const provider = new LemonSqueezyApiProvider({ config });
  await provider.cancelSubscription({ subscriptionId: providerSubscriptionId });
}

async function attemptFounderDeletionRevocations(
  userId: string,
  requestId: string,
  dependencies: FounderDeletionDependencies,
): Promise<void> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  try {
    const attemptedAt = now();
    const due = await connection.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:account-closure-revocation:${requestId}`}, 0))`,
      );
      const unresolved = await tx
        .select()
        .from(operatorDeletionRevocations)
        .where(
          and(
            eq(operatorDeletionRevocations.requestId, requestId),
            sql`${operatorDeletionRevocations.status} <> 'succeeded'`,
          ),
        )
        .for("update");
      const newlyExhausted = unresolved.filter(
        (row) =>
          row.attemptCount >= FOUNDER_REVOCATION_MAX_ATTEMPTS &&
          row.errorCode !== "provider_revocation_recovery_exhausted" &&
          (!row.nextAttemptAt || row.nextAttemptAt <= attemptedAt),
      );
      if (newlyExhausted.length > 0) {
        await markFounderRevocationRecoveryExhausted(tx, newlyExhausted, attemptedAt);
      }
      const dueRows = unresolved.filter(
        (row) =>
          row.attemptCount < FOUNDER_REVOCATION_MAX_ATTEMPTS &&
          (!row.nextAttemptAt || row.nextAttemptAt <= attemptedAt),
      );
      for (const row of dueRows) {
        await tx
          .update(operatorDeletionRevocations)
          .set({
            status: "failed",
            attemptCount: row.attemptCount + 1,
            lastAttemptAt: attemptedAt,
            nextAttemptAt: new Date(attemptedAt.getTime() + FOUNDER_REVOCATION_RETRY_MS),
            errorCode: "provider_revocation_attempt_in_progress",
            updatedAt: attemptedAt,
          })
          .where(eq(operatorDeletionRevocations.id, row.id));
      }
      return dueRows.map((row) => ({ ...row, attemptCount: row.attemptCount + 1 }));
    });
    if (due.length === 0) return;

    let results: FounderDeletionRevocationResult[] = [];
    let revocationCallFailed = false;
    try {
      results = await (dependencies.revokeConnections ?? defaultRevokeConnections)(
        userId,
        due.map((row) => row.connectionKind),
      );
    } catch {
      revocationCallFailed = true;
    }
    await connection.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:account-closure-revocation:${requestId}`}, 0))`,
      );
      const [requestOwner] = await tx
        .select({ operatorId: operatorDeletionRequests.operatorId })
        .from(operatorDeletionRequests)
        .where(eq(operatorDeletionRequests.id, requestId))
        .limit(1);
      if (!requestOwner) return;
      const localRevocationMessage =
        "Access was removed locally. Provider revocation remains unconfirmed and can be retried.";
      const dueIds = new Set(due.map((row) => row.connectionId));
      const aiIds = due
        .filter((row) => row.connectionKind.startsWith("ai:"))
        .map((row) => row.connectionId);
      const calendarIds = due
        .filter((row) => row.connectionKind === "calendar")
        .map((row) => row.connectionId);
      const mailIds = due
        .filter((row) => row.connectionKind === "mail")
        .map((row) => row.connectionId);
      const sendingIds = due
        .filter((row) => row.connectionKind === "mail_sending")
        .map((row) => row.connectionId);
      if (aiIds.length > 0) {
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
              inArray(operatorAiConnections.id, aiIds),
              sql`${operatorAiConnections.authorizationState} <> 'revoked'`,
            ),
          );
      }
      if (calendarIds.length > 0) {
        await tx
          .update(operatorCalendarConnections)
          .set({
            status: "disconnected",
            authorizationState: "revocation_unconfirmed",
            authorizationSessionHash: null,
            authorizationExpiresAt: null,
            failureCode: "provider_revocation_unconfirmed",
            recoveryMessage: localRevocationMessage,
            disconnectedAt: sql`coalesce(${operatorCalendarConnections.disconnectedAt}, now())`,
            updatedAt: now(),
          })
          .where(
            and(
              eq(operatorCalendarConnections.operatorId, requestOwner.operatorId),
              inArray(operatorCalendarConnections.id, calendarIds),
              sql`${operatorCalendarConnections.authorizationState} <> 'revoked'`,
            ),
          );
      }
      if (mailIds.length > 0) {
        await tx
          .update(operatorMailConnections)
          .set({
            status: "disconnected",
            authorizationState: "revocation_unconfirmed",
            authorizationSessionHash: null,
            authorizationExpiresAt: null,
            failureCode: "provider_revocation_unconfirmed",
            recoveryMessage: localRevocationMessage,
            disconnectedAt: sql`coalesce(${operatorMailConnections.disconnectedAt}, now())`,
            updatedAt: now(),
          })
          .where(
            and(
              eq(operatorMailConnections.operatorId, requestOwner.operatorId),
              inArray(operatorMailConnections.id, mailIds),
              sql`${operatorMailConnections.authorizationState} <> 'revoked'`,
            ),
          );
      }
      if (sendingIds.length > 0) {
        await tx
          .update(operatorMailSendingConnections)
          .set({
            status: "disconnected",
            authorizationState: "revocation_unconfirmed",
            authorizationSessionHash: null,
            authorizationExpiresAt: null,
            failureCode: "provider_revocation_unconfirmed",
            recoveryMessage: localRevocationMessage,
            disconnectedAt: sql`coalesce(${operatorMailSendingConnections.disconnectedAt}, now())`,
            updatedAt: now(),
          })
          .where(
            and(
              eq(operatorMailSendingConnections.operatorId, requestOwner.operatorId),
              inArray(operatorMailSendingConnections.id, sendingIds),
              sql`${operatorMailSendingConnections.authorizationState} <> 'revoked'`,
            ),
          );
      }
      const exhaustedAfterAttempt: typeof due = [];
      for (const row of due) {
        if (!dueIds.has(row.connectionId)) continue;
        const result = results.find((item) => item.connectionKind === row.connectionKind);
        const ok = !revocationCallFailed && result?.ok === true;
        const exhausted = !ok && row.attemptCount >= FOUNDER_REVOCATION_MAX_ATTEMPTS;
        const updated = await tx
          .update(operatorDeletionRevocations)
          .set({
            status: ok ? "succeeded" : "failed",
            lastAttemptAt: attemptedAt,
            nextAttemptAt:
              ok || exhausted
                ? null
                : new Date(attemptedAt.getTime() + FOUNDER_REVOCATION_RETRY_MS),
            errorCode: ok
              ? null
              : exhausted
                ? "provider_revocation_recovery_exhausted"
                : (result?.errorCode ??
                  (revocationCallFailed
                    ? "provider_revocation_failed"
                    : "provider_revocation_unconfirmed")),
            updatedAt: attemptedAt,
          })
          .where(
            and(
              eq(operatorDeletionRevocations.id, row.id),
              eq(operatorDeletionRevocations.attemptCount, row.attemptCount),
              eq(operatorDeletionRevocations.lastAttemptAt, attemptedAt),
              eq(operatorDeletionRevocations.errorCode, "provider_revocation_attempt_in_progress"),
            ),
          )
          .returning({ id: operatorDeletionRevocations.id });
        if (updated.length === 1 && exhausted) exhaustedAfterAttempt.push(row);
      }
      if (exhaustedAfterAttempt.length > 0) {
        await markFounderRevocationRecoveryExhausted(tx, exhaustedAfterAttempt, attemptedAt);
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

async function markFounderRevocationRecoveryExhausted(
  tx: DeletionTransaction,
  rows: Array<{ id: string; connectionId: string; connectionKind: string }>,
  at: Date,
): Promise<void> {
  const exhaustedMessage =
    "Recovery Exhausted. Provider revocation could not be confirmed within the safe retry budget. Retained retry credentials were removed; attended resolution is required.";
  await tx
    .update(operatorDeletionRevocations)
    .set({
      status: "failed",
      nextAttemptAt: null,
      errorCode: "provider_revocation_recovery_exhausted",
      updatedAt: at,
    })
    .where(
      inArray(
        operatorDeletionRevocations.id,
        rows.map((row) => row.id),
      ),
    );
  const calendarIds = rows
    .filter((row) => row.connectionKind === "calendar")
    .map((row) => row.connectionId);
  const mailIds = rows
    .filter((row) => row.connectionKind === "mail")
    .map((row) => row.connectionId);
  const sendingIds = rows
    .filter((row) => row.connectionKind === "mail_sending")
    .map((row) => row.connectionId);
  const clearedGrant = {
    accessTokenCiphertext: null,
    accessTokenIv: null,
    accessTokenAuthTag: null,
    refreshTokenCiphertext: null,
    refreshTokenIv: null,
    refreshTokenAuthTag: null,
    secretKeyVersion: null,
    tokenExpiresAt: null,
    failureCode: "provider_revocation_recovery_exhausted",
    recoveryMessage: exhaustedMessage,
    updatedAt: at,
  };
  if (calendarIds.length > 0) {
    await tx
      .update(operatorCalendarConnections)
      .set(clearedGrant)
      .where(inArray(operatorCalendarConnections.id, calendarIds));
  }
  if (mailIds.length > 0) {
    await tx
      .update(operatorMailConnections)
      .set(clearedGrant)
      .where(inArray(operatorMailConnections.id, mailIds));
  }
  if (sendingIds.length > 0) {
    await tx
      .update(operatorMailSendingConnections)
      .set(clearedGrant)
      .where(inArray(operatorMailSendingConnections.id, sendingIds));
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
  connectionKinds: readonly string[] = [
    "ai:openai",
    "ai:anthropic",
    "calendar",
    "mail",
    "mail_sending",
  ],
): Promise<FounderDeletionRevocationResult[]> {
  const selectedKinds = new Set(connectionKinds);
  const contractRunId = process.env.BRUNO_FOUNDER_CONTRACT_RUN_ID?.trim();
  const deterministicCalendarAdapter =
    process.env.BRUNO_FOUNDER_CONTRACT_PROVIDER_MODE === "deterministic" && contractRunId
      ? {
          ...createGoogleCalendarAdapter(),
          revokeAuthorization: async (input: {
            accessToken: string | null;
            refreshToken: string | null;
          }) => {
            const token = input.refreshToken ?? input.accessToken;
            if (!token) return { providerRevoked: false };
            return revokeDeterministicFounderContractGoogleConnection({
              runId: contractRunId,
              userId,
              connectionKind: "calendar",
              token,
            });
          },
        }
      : null;
  const calls: Array<
    [string, () => Promise<{ status?: string; recoveryMessage?: string | null } | null>]
  > = [
    ["ai:openai", () => disconnectFounderOpenAiForUser(userId)],
    ["ai:anthropic", () => disconnectFounderAnthropicForUser(userId)],
    [
      "calendar",
      () =>
        disconnectFounderGoogleCalendarForUser(userId, {
          preserveCredentialsOnUnconfirmedRevocation: true,
          ...(deterministicCalendarAdapter ? { adapter: deterministicCalendarAdapter } : {}),
        }),
    ],
    [
      "mail",
      () =>
        disconnectFounderGoogleMailForUser(userId, {
          preserveCredentialsOnUnconfirmedRevocation: true,
        }),
    ],
    [
      "mail_sending",
      () =>
        disconnectFounderGoogleMailSendingForUser(userId, {
          preserveCredentialsOnUnconfirmedRevocation: true,
        }),
    ],
  ];
  const results: FounderDeletionRevocationResult[] = [];
  for (const [connectionKind, call] of calls) {
    if (!selectedKinds.has(connectionKind)) continue;
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
