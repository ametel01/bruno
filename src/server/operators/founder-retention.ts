import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorActionAuthorizations,
  operatorActionDecisions,
  operatorActionExecutionAttempts,
  operatorActionPreviewRevisions,
  operatorActionPreviews,
  operatorActionReceipts,
  operatorAiConnections,
  operatorAiConnectionReceipts,
  operatorCalendarConnections,
  operatorCalendarConnectionReceipts,
  operatorConversationMessages,
  operatorConversationWorks,
  operatorConversations,
  operatorDeletionReceipts,
  operatorDeletionRequests,
  operatorGovernanceReceipts,
  operatorMailConnectionReceipts,
  operatorMailConnections,
  operatorMailSendingConnections,
  operatorMailSendingConnectionReceipts,
  operatorMorningBriefs,
  operatorMorningBriefItems,
  operatorAuthorityPolicies,
  operatorLimitedOperations,
  operatorProcessingConsents,
  operatorRelationshipCandidates,
  operatorRelationshipCorrections,
  operatorRelationshipEvidence,
  operatorRelationshipRecords,
  operatorRetentionRuns,
  operatorRetentionTombstones,
  operatorTroubleshootingIncidents,
  operatorProposedActions,
  operators,
} from "@/src/server/db/schema";

export const FOUNDER_WORKING_CONTEXT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const FOUNDER_RELATIONSHIP_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
export const FOUNDER_RELATIONSHIP_WARNING_MS = 30 * 24 * 60 * 60 * 1000;
export const FOUNDER_DECISION_METADATA_RETENTION_MS = 730 * 24 * 60 * 60 * 1000;

type RetentionTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type FounderRetentionCounts = {
  conversations: number;
  conversationWorks: number;
  conversationMessages: number;
  morningBriefs: number;
  morningBriefItems: number;
  relationshipRecords: number;
  relationshipCandidates: number;
  relationshipEvidence: number;
  relationshipCorrections: number;
  actionPreviews: number;
  actionPreviewRevisions: number;
  proposedActions: number;
  actionDecisions: number;
  actionAuthorizations: number;
  executionAttempts: number;
  actionReceipts: number;
  governanceReceipts: number;
  processingConsents: number;
  authorityPolicies: number;
  connectionReceipts: number;
  supportIncidents: number;
  deletionReceipts: number;
  deletionRequests: number;
  tombstones: number;
};

export type FounderRetentionResult = {
  operatorId: string;
  runId: string;
  runKey: string;
  status: "completed" | "failed";
  counts: FounderRetentionCounts;
  startedAt: string;
  completedAt: string | null;
};

export type FounderRetentionDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  randomUUID?: () => string;
  runKey?: string;
};

export type FounderRetentionWarning = {
  entityId: string;
  label: string;
  warningAt: string;
  expiresAt: string;
};

export type FounderRetentionStatus = {
  schedules: {
    workingContextDays: 90;
    closedRelationshipMonths: 12;
    decisionMetadataMonths: 24;
    relationshipWarningDays: 30;
  };
  warnings: FounderRetentionWarning[];
  lastRun: FounderRetentionResult | null;
};

const EMPTY_COUNTS: FounderRetentionCounts = {
  conversations: 0,
  conversationWorks: 0,
  conversationMessages: 0,
  morningBriefs: 0,
  morningBriefItems: 0,
  relationshipRecords: 0,
  relationshipCandidates: 0,
  relationshipEvidence: 0,
  relationshipCorrections: 0,
  actionPreviews: 0,
  actionPreviewRevisions: 0,
  proposedActions: 0,
  actionDecisions: 0,
  actionAuthorizations: 0,
  executionAttempts: 0,
  actionReceipts: 0,
  governanceReceipts: 0,
  processingConsents: 0,
  authorityPolicies: 0,
  connectionReceipts: 0,
  supportIncidents: 0,
  deletionReceipts: 0,
  deletionRequests: 0,
  tombstones: 0,
};

export async function processFounderRetentionForUser(
  userId: string,
  dependencies: FounderRetentionDependencies = {},
): Promise<FounderRetentionResult | null> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  const makeId = dependencies.randomUUID ?? randomUUID;
  const runKey = dependencies.runKey ?? `daily:${now.toISOString().slice(0, 10)}`;
  try {
    return await connection.db.transaction(async (tx) => {
      const [operator] = await tx
        .select({ id: operators.id })
        .from(operators)
        .where(and(eq(operators.userId, userId), eq(operators.status, "active")))
        .limit(1);
      if (!operator) return null;
      return executeRetention(tx, operator.id, runKey, now, makeId);
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function processFounderRetentionForAllUsers(
  dependencies: FounderRetentionDependencies = {},
): Promise<{ processed: number; failed: number; results: FounderRetentionResult[] }> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  try {
    const rows = await connection.db
      .select({ userId: sql<string>`${operators.userId}` })
      .from(operators)
      .where(eq(operators.status, "active"));
    const results: FounderRetentionResult[] = [];
    let failed = 0;
    for (const row of rows) {
      try {
        const result = await processFounderRetentionForUser(row.userId, {
          ...dependencies,
          createConnection: () => connection,
          now: () => now,
        });
        if (result) {
          results.push(result);
          if (result.status === "failed") failed += 1;
        }
      } catch {
        failed += 1;
      }
    }
    return { processed: results.length, failed, results };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function getFounderRetentionStatusForUser(
  userId: string,
  dependencies: Pick<FounderRetentionDependencies, "createConnection" | "now"> = {},
): Promise<FounderRetentionStatus | null> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  try {
    return await connection.db.transaction(async (tx) => {
      const [operator] = await tx
        .select({ id: operators.id })
        .from(operators)
        .where(and(eq(operators.userId, userId), eq(operators.status, "active")))
        .limit(1);
      if (!operator) return null;
      const records = await tx
        .select({
          id: operatorRelationshipRecords.id,
          label: operatorRelationshipRecords.displayName,
          closedAt: operatorRelationshipRecords.closedAt,
        })
        .from(operatorRelationshipRecords)
        .where(
          and(
            eq(operatorRelationshipRecords.operatorId, operator.id),
            sql`${operatorRelationshipRecords.status} IN ('closed', 'ignored')`,
          ),
        );
      const warnings = records.flatMap((record) => {
        if (!record.closedAt) return [];
        const expiresAt = addMonths(record.closedAt, 12);
        const warningAt = new Date(expiresAt.getTime() - FOUNDER_RELATIONSHIP_WARNING_MS);
        if (now < warningAt || now >= expiresAt) return [];
        return [
          {
            entityId: record.id,
            label: record.label,
            warningAt: warningAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          },
        ];
      });
      const [run] = await tx
        .select()
        .from(operatorRetentionRuns)
        .where(eq(operatorRetentionRuns.operatorId, operator.id))
        .orderBy(sql`${operatorRetentionRuns.startedAt} DESC`)
        .limit(1);
      return {
        schedules: {
          workingContextDays: 90,
          closedRelationshipMonths: 12,
          decisionMetadataMonths: 24,
          relationshipWarningDays: 30,
        },
        warnings,
        lastRun: run ? mapRun(run) : null,
      };
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function executeRetention(
  tx: RetentionTransaction,
  operatorId: string,
  runKey: string,
  now: Date,
  makeId: () => string,
): Promise<FounderRetentionResult> {
  await tx.execute(sql`SELECT id FROM operators WHERE id = ${operatorId} FOR UPDATE`);
  const [existing] = await tx
    .select()
    .from(operatorRetentionRuns)
    .where(
      and(
        eq(operatorRetentionRuns.operatorId, operatorId),
        eq(operatorRetentionRuns.runKey, runKey),
      ),
    )
    .limit(1);
  if (existing?.status === "completed") return mapRun(existing);

  const startedAt = existing?.startedAt ?? now;
  const runId = existing?.id ?? makeId();
  if (existing) {
    await tx
      .update(operatorRetentionRuns)
      .set({ status: "running", failureCode: null, completedAt: null, updatedAt: now })
      .where(eq(operatorRetentionRuns.id, existing.id));
  } else {
    await tx.insert(operatorRetentionRuns).values({
      id: runId,
      operatorId,
      runKey,
      status: "running",
      counts: {},
      startedAt,
      createdAt: now,
      updatedAt: now,
    });
  }

  const counts = { ...EMPTY_COUNTS };
  try {
    const workingCutoff = new Date(now.getTime() - FOUNDER_WORKING_CONTEXT_RETENTION_MS);
    const relationshipCutoff = addMonths(now, -12);
    const decisionCutoff = addMonths(now, -24);
    await expireWorkingContext(tx, operatorId, workingCutoff, now, counts, makeId);
    await expireRelationships(
      tx,
      operatorId,
      relationshipCutoff,
      workingCutoff,
      now,
      counts,
      makeId,
    );
    await expireDecisionMetadata(tx, operatorId, decisionCutoff, now, counts, makeId);
    await tx
      .update(operatorRetentionRuns)
      .set({ status: "completed", counts, completedAt: now, updatedAt: now })
      .where(eq(operatorRetentionRuns.id, runId));
    return {
      operatorId,
      runId,
      runKey,
      status: "completed",
      counts,
      startedAt: startedAt.toISOString(),
      completedAt: now.toISOString(),
    };
  } catch (error) {
    await tx
      .update(operatorRetentionRuns)
      .set({
        status: "failed",
        counts,
        failureCode: error instanceof Error ? error.name : "retention_failed",
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(operatorRetentionRuns.id, runId));
    return {
      operatorId,
      runId,
      runKey,
      status: "failed",
      counts,
      startedAt: startedAt.toISOString(),
      completedAt: now.toISOString(),
    };
  }
}

async function expireWorkingContext(
  tx: RetentionTransaction,
  operatorId: string,
  cutoff: Date,
  now: Date,
  counts: FounderRetentionCounts,
  makeId: () => string,
) {
  const oldMessages = await tx
    .select({
      id: operatorConversationMessages.id,
      createdAt: operatorConversationMessages.createdAt,
    })
    .from(operatorConversationMessages)
    .innerJoin(
      operatorConversations,
      eq(operatorConversations.id, operatorConversationMessages.conversationId),
    )
    .where(
      and(
        eq(operatorConversations.operatorId, operatorId),
        lte(operatorConversationMessages.createdAt, cutoff),
      ),
    );
  for (const row of oldMessages) {
    await tombstone(
      tx,
      operatorId,
      "working_context",
      "operator_conversation_messages",
      row.id,
      row.createdAt,
      now,
      counts,
      makeId,
    );
    await tx
      .delete(operatorConversationMessages)
      .where(eq(operatorConversationMessages.id, row.id));
    counts.conversationMessages += 1;
  }

  const oldWorks = await tx
    .select({
      id: operatorConversationWorks.id,
      conversationId: operatorConversationWorks.conversationId,
      createdAt: operatorConversationWorks.createdAt,
    })
    .from(operatorConversationWorks)
    .innerJoin(
      operatorConversations,
      eq(operatorConversations.id, operatorConversationWorks.conversationId),
    )
    .where(
      and(
        eq(operatorConversations.operatorId, operatorId),
        lte(operatorConversationWorks.updatedAt, cutoff),
      ),
    );
  for (const row of oldWorks) {
    const messages = await tx
      .delete(operatorConversationMessages)
      .where(eq(operatorConversationMessages.workId, row.id))
      .returning({ id: operatorConversationMessages.id });
    counts.conversationMessages += messages.length;
    await tombstone(
      tx,
      operatorId,
      "working_context",
      "operator_conversation_works",
      row.id,
      row.createdAt,
      now,
      counts,
      makeId,
    );
    await tx.delete(operatorConversationWorks).where(eq(operatorConversationWorks.id, row.id));
    counts.conversationWorks += 1;
  }

  const oldConversations = await tx
    .select({ id: operatorConversations.id, createdAt: operatorConversations.createdAt })
    .from(operatorConversations)
    .where(
      and(
        eq(operatorConversations.operatorId, operatorId),
        lte(operatorConversations.updatedAt, cutoff),
      ),
    );
  for (const row of oldConversations) {
    await tx
      .delete(operatorConversationMessages)
      .where(eq(operatorConversationMessages.conversationId, row.id));
    await tx
      .delete(operatorConversationWorks)
      .where(eq(operatorConversationWorks.conversationId, row.id));
    await tombstone(
      tx,
      operatorId,
      "working_context",
      "operator_conversations",
      row.id,
      row.createdAt,
      now,
      counts,
      makeId,
    );
    await tx.delete(operatorConversations).where(eq(operatorConversations.id, row.id));
    counts.conversations += 1;
  }

  const oldBriefs = await tx
    .select({ id: operatorMorningBriefs.id, createdAt: operatorMorningBriefs.createdAt })
    .from(operatorMorningBriefs)
    .where(
      and(
        eq(operatorMorningBriefs.operatorId, operatorId),
        lte(operatorMorningBriefs.generatedAt, cutoff),
      ),
    );
  for (const row of oldBriefs) {
    const briefItems = await tx
      .delete(operatorMorningBriefItems)
      .where(eq(operatorMorningBriefItems.briefId, row.id))
      .returning({ id: operatorMorningBriefItems.id });
    counts.morningBriefItems += briefItems.length;
    const [brief] = await tx
      .update(operatorMorningBriefs)
      .set({ content: "Morning Brief content expired under the retention schedule." })
      .where(eq(operatorMorningBriefs.id, row.id))
      .returning({ id: operatorMorningBriefs.id });
    if (brief) {
      await tombstone(
        tx,
        operatorId,
        "working_context",
        "operator_morning_briefs",
        row.id,
        row.createdAt,
        now,
        counts,
        makeId,
      );
      counts.morningBriefs += 1;
    }
  }
}

async function expireRelationships(
  tx: RetentionTransaction,
  operatorId: string,
  cutoff: Date,
  workingCutoff: Date,
  now: Date,
  counts: FounderRetentionCounts,
  makeId: () => string,
) {
  const records = await tx
    .select({
      id: operatorRelationshipRecords.id,
      createdAt: operatorRelationshipRecords.createdAt,
    })
    .from(operatorRelationshipRecords)
    .where(
      and(
        eq(operatorRelationshipRecords.operatorId, operatorId),
        sql`${operatorRelationshipRecords.status} IN ('closed', 'ignored')`,
        lte(operatorRelationshipRecords.closedAt, cutoff),
      ),
    );
  for (const row of records) {
    const evidence = await tx
      .select({
        id: operatorRelationshipEvidence.id,
        createdAt: operatorRelationshipEvidence.createdAt,
      })
      .from(operatorRelationshipEvidence)
      .where(eq(operatorRelationshipEvidence.recordId, row.id));
    for (const item of evidence) {
      await tombstone(
        tx,
        operatorId,
        "relationship_record",
        "operator_relationship_evidence",
        item.id,
        item.createdAt,
        now,
        counts,
        makeId,
      );
    }
    await tx
      .delete(operatorRelationshipEvidence)
      .where(eq(operatorRelationshipEvidence.recordId, row.id));
    counts.relationshipEvidence += evidence.length;

    const corrections = await tx
      .select({
        id: operatorRelationshipCorrections.id,
        createdAt: operatorRelationshipCorrections.createdAt,
      })
      .from(operatorRelationshipCorrections)
      .where(eq(operatorRelationshipCorrections.recordId, row.id));
    for (const item of corrections) {
      await tombstone(
        tx,
        operatorId,
        "relationship_record",
        "operator_relationship_corrections",
        item.id,
        item.createdAt,
        now,
        counts,
        makeId,
      );
    }
    await tx
      .delete(operatorRelationshipCorrections)
      .where(eq(operatorRelationshipCorrections.recordId, row.id));
    counts.relationshipCorrections += corrections.length;

    const candidates = await tx
      .select({
        id: operatorRelationshipCandidates.id,
        createdAt: operatorRelationshipCandidates.createdAt,
      })
      .from(operatorRelationshipCandidates)
      .where(eq(operatorRelationshipCandidates.proposedRecordId, row.id));
    for (const item of candidates) {
      await tombstone(
        tx,
        operatorId,
        "relationship_record",
        "operator_relationship_candidates",
        item.id,
        item.createdAt,
        now,
        counts,
        makeId,
      );
    }
    await tx
      .delete(operatorRelationshipCandidates)
      .where(eq(operatorRelationshipCandidates.proposedRecordId, row.id));
    counts.relationshipCandidates += candidates.length;
    await tombstone(
      tx,
      operatorId,
      "relationship_record",
      "operator_relationship_records",
      row.id,
      row.createdAt,
      now,
      counts,
      makeId,
    );
    await tx.delete(operatorRelationshipRecords).where(eq(operatorRelationshipRecords.id, row.id));
    counts.relationshipRecords += 1;
  }

  const oldEvidence = await tx
    .select({
      id: operatorRelationshipEvidence.id,
      createdAt: operatorRelationshipEvidence.createdAt,
    })
    .from(operatorRelationshipEvidence)
    .where(
      and(
        eq(operatorRelationshipEvidence.operatorId, operatorId),
        lte(operatorRelationshipEvidence.observedAt, workingCutoff),
      ),
    );
  for (const row of oldEvidence) {
    await tombstone(
      tx,
      operatorId,
      "working_context",
      "operator_relationship_evidence",
      row.id,
      row.createdAt,
      now,
      counts,
      makeId,
    );
    await tx
      .delete(operatorRelationshipEvidence)
      .where(eq(operatorRelationshipEvidence.id, row.id));
    counts.relationshipEvidence += 1;
  }

  const oldCandidates = await tx
    .select({
      id: operatorRelationshipCandidates.id,
      createdAt: operatorRelationshipCandidates.createdAt,
    })
    .from(operatorRelationshipCandidates)
    .where(
      and(
        eq(operatorRelationshipCandidates.operatorId, operatorId),
        lte(operatorRelationshipCandidates.updatedAt, workingCutoff),
      ),
    );
  for (const row of oldCandidates) {
    await tombstone(
      tx,
      operatorId,
      "working_context",
      "operator_relationship_candidates",
      row.id,
      row.createdAt,
      now,
      counts,
      makeId,
    );
    await tx
      .delete(operatorRelationshipCandidates)
      .where(eq(operatorRelationshipCandidates.id, row.id));
    counts.relationshipCandidates += 1;
  }
}

async function expireDecisionMetadata(
  tx: RetentionTransaction,
  operatorId: string,
  cutoff: Date,
  now: Date,
  counts: FounderRetentionCounts,
  makeId: () => string,
) {
  const governance = await tx
    .select({ id: operatorGovernanceReceipts.id, createdAt: operatorGovernanceReceipts.createdAt })
    .from(operatorGovernanceReceipts)
    .where(
      and(
        eq(operatorGovernanceReceipts.operatorId, operatorId),
        lte(operatorGovernanceReceipts.createdAt, cutoff),
      ),
    );
  for (const row of governance) {
    await tombstone(
      tx,
      operatorId,
      "governance",
      "operator_governance_receipts",
      row.id,
      row.createdAt,
      now,
      counts,
      makeId,
    );
    await tx.delete(operatorGovernanceReceipts).where(eq(operatorGovernanceReceipts.id, row.id));
    counts.governanceReceipts += 1;
  }

  const deletionReceipts = await tx
    .select({ id: operatorDeletionReceipts.id, createdAt: operatorDeletionReceipts.createdAt })
    .from(operatorDeletionReceipts)
    .where(
      and(
        eq(operatorDeletionReceipts.operatorId, operatorId),
        lte(operatorDeletionReceipts.createdAt, cutoff),
      ),
    );
  for (const row of deletionReceipts) {
    await tombstone(
      tx,
      operatorId,
      "deletion",
      "operator_deletion_receipts",
      row.id,
      row.createdAt,
      now,
      counts,
      makeId,
    );
    await tx.delete(operatorDeletionReceipts).where(eq(operatorDeletionReceipts.id, row.id));
    counts.deletionReceipts += 1;
  }

  const deletionRequests = await tx
    .select({ id: operatorDeletionRequests.id, createdAt: operatorDeletionRequests.createdAt })
    .from(operatorDeletionRequests)
    .where(
      and(
        eq(operatorDeletionRequests.operatorId, operatorId),
        eq(operatorDeletionRequests.status, "completed"),
        lte(operatorDeletionRequests.updatedAt, cutoff),
      ),
    );
  for (const row of deletionRequests) {
    await tombstone(
      tx,
      operatorId,
      "deletion",
      "operator_deletion_requests",
      row.id,
      row.createdAt,
      now,
      counts,
      makeId,
    );
    await tx
      .update(operatorDeletionRequests)
      .set({ scope: {}, summary: {}, updatedAt: now })
      .where(eq(operatorDeletionRequests.id, row.id));
    counts.deletionRequests += 1;
  }

  const connectionReceiptQueries = [
    tx
      .select({
        id: operatorAiConnectionReceipts.id,
        createdAt: operatorAiConnectionReceipts.createdAt,
      })
      .from(operatorAiConnectionReceipts)
      .innerJoin(
        operatorAiConnections,
        eq(operatorAiConnections.id, operatorAiConnectionReceipts.connectionId),
      )
      .where(
        and(
          eq(operatorAiConnections.operatorId, operatorId),
          lte(operatorAiConnectionReceipts.createdAt, cutoff),
        ),
      ),
    tx
      .select({
        id: operatorCalendarConnectionReceipts.id,
        createdAt: operatorCalendarConnectionReceipts.createdAt,
      })
      .from(operatorCalendarConnectionReceipts)
      .innerJoin(
        operatorCalendarConnections,
        eq(operatorCalendarConnections.id, operatorCalendarConnectionReceipts.connectionId),
      )
      .where(
        and(
          eq(operatorCalendarConnections.operatorId, operatorId),
          lte(operatorCalendarConnectionReceipts.createdAt, cutoff),
        ),
      ),
    tx
      .select({
        id: operatorMailConnectionReceipts.id,
        createdAt: operatorMailConnectionReceipts.createdAt,
      })
      .from(operatorMailConnectionReceipts)
      .innerJoin(
        operatorMailConnections,
        eq(operatorMailConnections.id, operatorMailConnectionReceipts.connectionId),
      )
      .where(
        and(
          eq(operatorMailConnections.operatorId, operatorId),
          lte(operatorMailConnectionReceipts.createdAt, cutoff),
        ),
      ),
    tx
      .select({
        id: operatorMailSendingConnectionReceipts.id,
        createdAt: operatorMailSendingConnectionReceipts.createdAt,
      })
      .from(operatorMailSendingConnectionReceipts)
      .innerJoin(
        operatorMailSendingConnections,
        eq(operatorMailSendingConnections.id, operatorMailSendingConnectionReceipts.connectionId),
      )
      .where(
        and(
          eq(operatorMailSendingConnections.operatorId, operatorId),
          lte(operatorMailSendingConnectionReceipts.createdAt, cutoff),
        ),
      ),
  ];
  const connectionReceiptTables = [
    operatorAiConnectionReceipts,
    operatorCalendarConnectionReceipts,
    operatorMailConnectionReceipts,
    operatorMailSendingConnectionReceipts,
  ];
  const connectionReceiptNames = [
    "operator_ai_connection_receipts",
    "operator_calendar_connection_receipts",
    "operator_mail_connection_receipts",
    "operator_mail_sending_connection_receipts",
  ];
  for (let index = 0; index < connectionReceiptQueries.length; index += 1) {
    const rows = (await connectionReceiptQueries[index]) ?? [];
    const table = connectionReceiptTables[index];
    const entityType = connectionReceiptNames[index];
    if (!table || !entityType) continue;
    for (const row of rows) {
      await tombstone(
        tx,
        operatorId,
        "connection",
        entityType,
        row.id,
        row.createdAt,
        now,
        counts,
        makeId,
      );
      await tx.delete(table).where(eq(table.id, row.id));
      counts.connectionReceipts += 1;
    }
  }

  const revisions = await tx
    .select({
      id: operatorActionPreviewRevisions.id,
      previewId: operatorActionPreviewRevisions.previewId,
      createdAt: operatorActionPreviewRevisions.createdAt,
    })
    .from(operatorActionPreviewRevisions)
    .innerJoin(
      operatorActionPreviews,
      eq(operatorActionPreviews.id, operatorActionPreviewRevisions.previewId),
    )
    .where(
      and(
        eq(operatorActionPreviews.operatorId, operatorId),
        lte(operatorActionPreviewRevisions.createdAt, cutoff),
      ),
    );
  for (const row of revisions) {
    await tombstone(
      tx,
      operatorId,
      "action",
      "operator_action_preview_revisions",
      row.id,
      row.createdAt,
      now,
      counts,
      makeId,
    );
    await tx
      .delete(operatorActionPreviewRevisions)
      .where(eq(operatorActionPreviewRevisions.id, row.id));
    counts.actionPreviewRevisions += 1;
  }

  const previews = await tx
    .select({ id: operatorActionPreviews.id, createdAt: operatorActionPreviews.createdAt })
    .from(operatorActionPreviews)
    .where(
      and(
        eq(operatorActionPreviews.operatorId, operatorId),
        lte(operatorActionPreviews.updatedAt, cutoff),
      ),
    );
  for (const row of previews) {
    await tombstone(
      tx,
      operatorId,
      "action",
      "operator_action_previews",
      row.id,
      row.createdAt,
      now,
      counts,
      makeId,
    );
    await tx.delete(operatorActionPreviews).where(eq(operatorActionPreviews.id, row.id));
    counts.actionPreviews += 1;
  }

  const actions = await tx
    .select({ id: operatorProposedActions.id, createdAt: operatorProposedActions.createdAt })
    .from(operatorProposedActions)
    .where(
      and(
        eq(operatorProposedActions.operatorId, operatorId),
        lte(operatorProposedActions.createdAt, cutoff),
      ),
    );
  for (const row of actions) {
    const receipts = await tx
      .select({ id: operatorActionReceipts.id })
      .from(operatorActionReceipts)
      .where(eq(operatorActionReceipts.proposedActionId, row.id));
    const attempts = await tx
      .select({ id: operatorActionExecutionAttempts.id })
      .from(operatorActionExecutionAttempts)
      .where(eq(operatorActionExecutionAttempts.proposedActionId, row.id));
    const authorizations = await tx
      .select({ id: operatorActionAuthorizations.id })
      .from(operatorActionAuthorizations)
      .where(eq(operatorActionAuthorizations.proposedActionId, row.id));
    const decisions = await tx
      .select({ id: operatorActionDecisions.id })
      .from(operatorActionDecisions)
      .where(eq(operatorActionDecisions.proposedActionId, row.id));
    for (const receipt of receipts)
      await tombstone(
        tx,
        operatorId,
        "action",
        "operator_action_receipts",
        receipt.id,
        row.createdAt,
        now,
        counts,
        makeId,
      );
    for (const attempt of attempts)
      await tombstone(
        tx,
        operatorId,
        "action",
        "operator_action_execution_attempts",
        attempt.id,
        row.createdAt,
        now,
        counts,
        makeId,
      );
    for (const authorization of authorizations)
      await tombstone(
        tx,
        operatorId,
        "action",
        "operator_action_authorizations",
        authorization.id,
        row.createdAt,
        now,
        counts,
        makeId,
      );
    for (const decision of decisions)
      await tombstone(
        tx,
        operatorId,
        "action",
        "operator_action_decisions",
        decision.id,
        row.createdAt,
        now,
        counts,
        makeId,
      );
    await tx
      .delete(operatorActionReceipts)
      .where(eq(operatorActionReceipts.proposedActionId, row.id));
    await tx
      .delete(operatorActionDecisions)
      .where(eq(operatorActionDecisions.proposedActionId, row.id));
    await tx
      .delete(operatorActionExecutionAttempts)
      .where(eq(operatorActionExecutionAttempts.proposedActionId, row.id));
    await tx
      .delete(operatorActionAuthorizations)
      .where(eq(operatorActionAuthorizations.proposedActionId, row.id));
    counts.actionReceipts += receipts.length;
    counts.executionAttempts += attempts.length;
    counts.actionAuthorizations += authorizations.length;
    counts.actionDecisions += decisions.length;
    await tombstone(
      tx,
      operatorId,
      "action",
      "operator_proposed_actions",
      row.id,
      row.createdAt,
      now,
      counts,
      makeId,
    );
    await tx.delete(operatorProposedActions).where(eq(operatorProposedActions.id, row.id));
    counts.proposedActions += 1;
  }

  // Governance sources are processed after action children so a policy or
  // consent cannot be deleted while an immutable receipt still references it.
  const oldConsents = await tx
    .select({ id: operatorProcessingConsents.id, createdAt: operatorProcessingConsents.createdAt })
    .from(operatorProcessingConsents)
    .where(
      and(
        eq(operatorProcessingConsents.operatorId, operatorId),
        lte(operatorProcessingConsents.createdAt, cutoff),
      ),
    );
  for (const row of oldConsents) {
    const [limitedUse, proposedUse, receiptUse] = await Promise.all([
      tx
        .select({ id: operatorLimitedOperations.id })
        .from(operatorLimitedOperations)
        .where(
          and(
            eq(operatorLimitedOperations.operatorId, operatorId),
            eq(operatorLimitedOperations.processingConsentId, row.id),
          ),
        )
        .limit(1),
      tx
        .select({ id: operatorProposedActions.id })
        .from(operatorProposedActions)
        .where(
          and(
            eq(operatorProposedActions.operatorId, operatorId),
            eq(operatorProposedActions.processingConsentId, row.id),
          ),
        )
        .limit(1),
      tx
        .select({ id: operatorActionReceipts.id })
        .from(operatorActionReceipts)
        .where(
          and(
            eq(operatorActionReceipts.operatorId, operatorId),
            eq(operatorActionReceipts.processingConsentId, row.id),
          ),
        )
        .limit(1),
    ]);
    if (limitedUse[0] || proposedUse[0] || receiptUse[0]) continue;
    await tombstone(
      tx,
      operatorId,
      "governance",
      "operator_processing_consents",
      row.id,
      row.createdAt,
      now,
      counts,
      makeId,
    );
    await tx.delete(operatorProcessingConsents).where(eq(operatorProcessingConsents.id, row.id));
    counts.processingConsents += 1;
  }

  const oldPolicies = await tx
    .select({ id: operatorAuthorityPolicies.id, createdAt: operatorAuthorityPolicies.createdAt })
    .from(operatorAuthorityPolicies)
    .where(
      and(
        eq(operatorAuthorityPolicies.operatorId, operatorId),
        lte(operatorAuthorityPolicies.createdAt, cutoff),
      ),
    );
  for (const row of oldPolicies) {
    const [limitedUse, proposedUse, receiptUse] = await Promise.all([
      tx
        .select({ id: operatorLimitedOperations.id })
        .from(operatorLimitedOperations)
        .where(
          and(
            eq(operatorLimitedOperations.operatorId, operatorId),
            eq(operatorLimitedOperations.authorityPolicyId, row.id),
          ),
        )
        .limit(1),
      tx
        .select({ id: operatorProposedActions.id })
        .from(operatorProposedActions)
        .where(
          and(
            eq(operatorProposedActions.operatorId, operatorId),
            eq(operatorProposedActions.authorityPolicyId, row.id),
          ),
        )
        .limit(1),
      tx
        .select({ id: operatorActionReceipts.id })
        .from(operatorActionReceipts)
        .where(
          and(
            eq(operatorActionReceipts.operatorId, operatorId),
            eq(operatorActionReceipts.authorityPolicyId, row.id),
          ),
        )
        .limit(1),
    ]);
    if (limitedUse[0] || proposedUse[0] || receiptUse[0]) continue;
    await tombstone(
      tx,
      operatorId,
      "governance",
      "operator_authority_policies",
      row.id,
      row.createdAt,
      now,
      counts,
      makeId,
    );
    await tx.delete(operatorAuthorityPolicies).where(eq(operatorAuthorityPolicies.id, row.id));
    counts.authorityPolicies += 1;
  }

  const incidents = await tx
    .select({
      id: operatorTroubleshootingIncidents.id,
      createdAt: operatorTroubleshootingIncidents.createdAt,
    })
    .from(operatorTroubleshootingIncidents)
    .where(
      and(
        eq(operatorTroubleshootingIncidents.operatorId, operatorId),
        eq(operatorTroubleshootingIncidents.status, "closed"),
        lte(operatorTroubleshootingIncidents.updatedAt, cutoff),
      ),
    );
  for (const row of incidents) {
    await tombstone(
      tx,
      operatorId,
      "support",
      "operator_troubleshooting_incidents",
      row.id,
      row.createdAt,
      now,
      counts,
      makeId,
    );
    await tx
      .delete(operatorTroubleshootingIncidents)
      .where(eq(operatorTroubleshootingIncidents.id, row.id));
    counts.supportIncidents += 1;
  }

  const corrections = await tx
    .select({
      id: operatorRelationshipCorrections.id,
      createdAt: operatorRelationshipCorrections.createdAt,
    })
    .from(operatorRelationshipCorrections)
    .where(
      and(
        eq(operatorRelationshipCorrections.operatorId, operatorId),
        lte(operatorRelationshipCorrections.createdAt, cutoff),
      ),
    );
  for (const row of corrections) {
    await tombstone(
      tx,
      operatorId,
      "governance",
      "operator_relationship_corrections",
      row.id,
      row.createdAt,
      now,
      counts,
      makeId,
    );
    await tx
      .delete(operatorRelationshipCorrections)
      .where(eq(operatorRelationshipCorrections.id, row.id));
    counts.relationshipCorrections += 1;
  }
}

async function tombstone(
  tx: RetentionTransaction,
  operatorId: string,
  kind: (typeof schema.operatorRetentionTombstoneKindEnum.enumValues)[number],
  entityType: string,
  entityId: string,
  sourceCreatedAt: Date,
  expiredAt: Date,
  counts: FounderRetentionCounts,
  makeId: () => string,
) {
  const identityDigest = createHash("sha256")
    .update(`${kind}:${entityType}:${entityId}`)
    .digest("hex");
  const inserted = await tx
    .insert(operatorRetentionTombstones)
    .values({
      id: makeId(),
      operatorId,
      kind,
      entityType,
      entityId,
      identityDigest: `sha256:${identityDigest}`,
      sourceCreatedAt,
      expiredAt,
    })
    .onConflictDoNothing()
    .returning({ id: operatorRetentionTombstones.id });
  if (inserted.length > 0) counts.tombstones += 1;
}

function addMonths(value: Date, months: number): Date {
  const result = new Date(value);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

function mapRun(run: typeof operatorRetentionRuns.$inferSelect): FounderRetentionResult {
  return {
    operatorId: run.operatorId,
    runId: run.id,
    runKey: run.runKey,
    status: run.status === "failed" ? "failed" : "completed",
    counts: { ...EMPTY_COUNTS, ...run.counts },
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}
