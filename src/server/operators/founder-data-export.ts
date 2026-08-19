import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import { redactSecretText } from "@/src/shared/secret-redaction";
import {
  operatorActionAuthorizations,
  operatorActionDecisions,
  operatorActionExecutionAttempts,
  operatorActionPreviewRevisions,
  operatorActionPreviews,
  operatorActionReceipts,
  operatorAiConnectionReceipts,
  operatorAiConnections,
  operatorAuthorityPolicies,
  operatorCalendarConnectionReceipts,
  operatorCalendarConnections,
  operatorCalendarResources,
  operatorConversationMessages,
  operatorConversationWorks,
  operatorConversations,
  operatorFounderActivations,
  operatorFounderDataExportAccesses,
  operatorFounderDataExports,
  operatorGovernanceReceipts,
  operatorLimitedOperations,
  operatorMailConnectionReceipts,
  operatorMailConnections,
  operatorMailResources,
  operatorMailSendingConnectionReceipts,
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

export const FOUNDER_DATA_EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
export const FOUNDER_DATA_EXPORT_FORMATS = ["json", "html"] as const;
export type FounderDataExportFormat = (typeof FOUNDER_DATA_EXPORT_FORMATS)[number];

type ExportRecord = Record<string, unknown>;
type PrivacyTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type FounderDataExportPayload = {
  schemaVersion: 1;
  export: {
    id: string;
    generatedAt: string;
    expiresAt: string;
  };
  owner: { ownerId: string };
  exclusions: string[];
  sourceAvailability: string;
  connections: {
    ai: ExportRecord[];
    calendar: ExportRecord[];
    mail: ExportRecord[];
    mailSending: ExportRecord[];
  };
  records: {
    conversations: ExportRecord[];
    conversationWorks: ExportRecord[];
    conversationMessages: ExportRecord[];
    relationshipRecords: ExportRecord[];
    relationshipCandidates: ExportRecord[];
    relationshipCorrections: ExportRecord[];
    relationshipEvidence: ExportRecord[];
    limitedOperations: ExportRecord[];
    morningBriefs: ExportRecord[];
    morningBriefItems: ExportRecord[];
    founderActivations: ExportRecord[];
    actionPreviews: ExportRecord[];
    actionPreviewRevisions: ExportRecord[];
  };
  decisions: {
    proposedActions: ExportRecord[];
    actionDecisions: ExportRecord[];
    actionAuthorizations: ExportRecord[];
    executionAttempts: ExportRecord[];
  };
  receipts: {
    action: ExportRecord[];
    aiConnection: ExportRecord[];
    calendarConnection: ExportRecord[];
    mailConnection: ExportRecord[];
    mailSendingConnection: ExportRecord[];
    governance: ExportRecord[];
  };
  processing: {
    consents: ExportRecord[];
    authorityPolicies: ExportRecord[];
  };
};

export type FounderDataExportCreation = {
  exportId: string;
  token: string;
  createdAt: string;
  expiresAt: string;
};

export type FounderDataExportDownload =
  | {
      ok: true;
      format: FounderDataExportFormat;
      body: string;
      contentType: string;
      fileName: string;
      expiresAt: string;
    }
  | {
      ok: false;
      code: "export_not_found" | "export_expired" | "owner_mismatch";
      status: 404 | 410;
    };

export type FounderDataExportCreateDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  randomUUID?: () => string;
  randomBytes?: (size: number) => Buffer;
};

export type FounderDataExportDownloadDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
};

const EXCLUSIONS = [
  "Credentials, OAuth tokens, authorization codes, and encrypted secret material.",
  "Provider source archives or data outside the selected Connection Resources.",
  "Raw technical logs, prompts, provider responses, and infrastructure-only state.",
  "Restricted Data that Bruno.Ai does not intentionally process at launch.",
] as const;

export async function createFounderDataExportForUser(
  userId: string,
  dependencies: FounderDataExportCreateDependencies = {},
): Promise<FounderDataExportCreation | null> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  const exportId = dependencies.randomUUID?.() ?? randomUUID();
  const token = (dependencies.randomBytes?.(32) ?? randomBytes(32)).toString("base64url");
  const expiresAt = new Date(now.getTime() + FOUNDER_DATA_EXPORT_TTL_MS);

  try {
    return await connection.db.transaction(async (tx) => {
      const [operator] = await tx
        .select({ id: operators.id })
        .from(operators)
        .where(and(eq(operators.userId, userId), eq(operators.status, "active")))
        .limit(1);
      if (!operator) return null;

      await tx
        .update(operatorFounderDataExports)
        .set({ payload: { schemaVersion: 1, expired: true } })
        .where(
          and(
            eq(operatorFounderDataExports.operatorId, operator.id),
            lt(operatorFounderDataExports.expiresAt, now),
          ),
        );

      const payload = await buildFounderDataExportPayload(tx, {
        ownerId: userId,
        operatorId: operator.id,
        exportId,
        generatedAt: now,
        expiresAt,
      });

      await tx.insert(operatorFounderDataExports).values({
        id: exportId,
        operatorId: operator.id,
        tokenHash: hashExportToken(token),
        payload,
        createdAt: now,
        expiresAt,
      });

      return {
        exportId,
        token,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function downloadFounderDataExport(
  userId: string,
  token: string,
  format: FounderDataExportFormat,
  dependencies: FounderDataExportDownloadDependencies = {},
): Promise<FounderDataExportDownload> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction(async (tx) => {
      const [artifact] = await tx
        .select()
        .from(operatorFounderDataExports)
        .where(eq(operatorFounderDataExports.tokenHash, hashExportToken(token)))
        .limit(1);
      if (!artifact) return { ok: false, code: "export_not_found", status: 404 } as const;

      const [owner] = await tx
        .select({ userId: operators.userId })
        .from(operators)
        .where(eq(operators.id, artifact.operatorId))
        .limit(1);
      if (!owner || owner.userId !== userId) {
        await recordExportAccess(tx, artifact.id, userId, format, "owner_mismatch", now);
        return { ok: false, code: "owner_mismatch", status: 404 } as const;
      }

      if (now >= artifact.expiresAt) {
        await recordExportAccess(tx, artifact.id, userId, format, "expired", now);
        await tx
          .update(operatorFounderDataExports)
          .set({ payload: { schemaVersion: 1, expired: true } })
          .where(eq(operatorFounderDataExports.id, artifact.id));
        return { ok: false, code: "export_expired", status: 410 } as const;
      }

      const payload = artifact.payload as FounderDataExportPayload;
      await recordExportAccess(tx, artifact.id, userId, format, "downloaded", now);
      return {
        ok: true,
        format,
        body:
          format === "json"
            ? JSON.stringify(payload, null, 2)
            : renderFounderDataExportHtml(payload),
        contentType:
          format === "json" ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
        fileName: `bruno-founder-data-export.${format}`,
        expiresAt: artifact.expiresAt.toISOString(),
      } as const;
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export function renderFounderDataExportHtml(payload: FounderDataExportPayload): string {
  const sections = [
    ["Connections", payload.connections],
    ["Records", payload.records],
    ["Decisions", payload.decisions],
    ["Receipts", payload.receipts],
    ["Processing consent and authority", payload.processing],
  ] as const;
  const sectionMarkup = sections
    .map(
      ([heading, value]) =>
        `<section><h2>${escapeHtml(heading)}</h2><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></section>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bruno Founder Data Export</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:72rem;margin:2rem auto;padding:0 1rem;color:#17202a}h1{margin-bottom:.25rem}h2{margin-top:2rem}pre{white-space:pre-wrap;background:#f4f6f8;padding:1rem;border-radius:.5rem;overflow:auto}li{margin:.35rem 0}.meta{color:#4b5563}</style></head>
<body><h1>Bruno Founder Data Export</h1>
<p class="meta">Generated ${escapeHtml(payload.export.generatedAt)} · Expires ${escapeHtml(payload.export.expiresAt)} · Schema ${payload.schemaVersion}</p>
<h2>Excluded from this export</h2><ul>${payload.exclusions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
<p>${escapeHtml(payload.sourceAvailability)}</p>${sectionMarkup}
</body></html>`;
}

export function buildFounderDataExportPayloadForTest(input: {
  ownerId: string;
  exportId: string;
  generatedAt: Date;
  expiresAt: Date;
  relationshipEvidence?: Array<{
    id: string;
    provider: string;
    providerItemId: string;
    providerIdentity: string | null;
    email: string | null;
    displayName: string | null;
    company: string | null;
    evidenceState: "current" | "stale" | "disconnected" | "unavailable";
    excerpt: string | null;
    observedAt: Date;
    sourceFingerprint: string;
  }>;
}): FounderDataExportPayload {
  return {
    schemaVersion: 1,
    export: {
      id: input.exportId,
      generatedAt: input.generatedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    },
    owner: { ownerId: input.ownerId },
    exclusions: [...EXCLUSIONS],
    sourceAvailability:
      "Evidence pointers remain in the export even when their source is disconnected or unavailable. Bruno does not recreate missing provider content.",
    connections: { ai: [], calendar: [], mail: [], mailSending: [] },
    records: {
      conversations: [],
      conversationWorks: [],
      conversationMessages: [],
      relationshipRecords: [],
      relationshipCandidates: [],
      relationshipCorrections: [],
      relationshipEvidence: (input.relationshipEvidence ?? []).map(mapTestEvidence),
      limitedOperations: [],
      morningBriefs: [],
      morningBriefItems: [],
      founderActivations: [],
      actionPreviews: [],
      actionPreviewRevisions: [],
    },
    decisions: {
      proposedActions: [],
      actionDecisions: [],
      actionAuthorizations: [],
      executionAttempts: [],
    },
    receipts: {
      action: [],
      aiConnection: [],
      calendarConnection: [],
      mailConnection: [],
      mailSendingConnection: [],
      governance: [],
    },
    processing: { consents: [], authorityPolicies: [] },
  };
}

async function buildFounderDataExportPayload(
  tx: PrivacyTransaction,
  input: {
    ownerId: string;
    operatorId: string;
    exportId: string;
    generatedAt: Date;
    expiresAt: Date;
  },
): Promise<FounderDataExportPayload> {
  const [
    aiConnections,
    calendarConnections,
    mailConnections,
    mailSendingConnections,
    processingConsents,
    authorityPolicies,
    governanceReceipts,
    limitedOperations,
    morningBriefs,
    founderActivations,
    relationshipRecords,
    relationshipCandidates,
    relationshipEvidence,
    relationshipCorrections,
    conversations,
    actionPreviews,
    proposedActions,
    actionDecisions,
    actionAuthorizations,
    executionAttempts,
    actionReceipts,
  ] = await Promise.all([
    tx
      .select()
      .from(operatorAiConnections)
      .where(eq(operatorAiConnections.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorCalendarConnections)
      .where(eq(operatorCalendarConnections.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorMailConnections)
      .where(eq(operatorMailConnections.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorMailSendingConnections)
      .where(eq(operatorMailSendingConnections.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorProcessingConsents)
      .where(eq(operatorProcessingConsents.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorAuthorityPolicies)
      .where(eq(operatorAuthorityPolicies.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorGovernanceReceipts)
      .where(eq(operatorGovernanceReceipts.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorLimitedOperations)
      .where(eq(operatorLimitedOperations.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorMorningBriefs)
      .where(eq(operatorMorningBriefs.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorFounderActivations)
      .where(eq(operatorFounderActivations.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorRelationshipRecords)
      .where(eq(operatorRelationshipRecords.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorRelationshipCandidates)
      .where(eq(operatorRelationshipCandidates.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorRelationshipEvidence)
      .where(eq(operatorRelationshipEvidence.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorRelationshipCorrections)
      .where(eq(operatorRelationshipCorrections.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorConversations)
      .where(eq(operatorConversations.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorActionPreviews)
      .where(eq(operatorActionPreviews.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorProposedActions)
      .where(eq(operatorProposedActions.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorActionDecisions)
      .where(eq(operatorActionDecisions.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorActionAuthorizations)
      .where(eq(operatorActionAuthorizations.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorActionExecutionAttempts)
      .where(eq(operatorActionExecutionAttempts.operatorId, input.operatorId)),
    tx
      .select()
      .from(operatorActionReceipts)
      .where(eq(operatorActionReceipts.operatorId, input.operatorId)),
  ]);

  const calendarIds = calendarConnections.map((item) => item.id);
  const mailIds = mailConnections.map((item) => item.id);
  const aiIds = aiConnections.map((item) => item.id);
  const sendingIds = mailSendingConnections.map((item) => item.id);
  const conversationIds = conversations.map((item) => item.id);
  const briefIds = morningBriefs.map((item) => item.id);
  const previewIds = actionPreviews.map((item) => item.id);

  const [
    calendarResources,
    mailResources,
    aiReceipts,
    calendarReceipts,
    mailReceipts,
    sendingReceipts,
    conversationWorks,
    conversationMessages,
    briefItems,
    previewRevisions,
  ] = await Promise.all([
    selectWhenIds(
      tx,
      operatorCalendarResources,
      operatorCalendarResources.connectionId,
      calendarIds,
    ),
    selectWhenIds(tx, operatorMailResources, operatorMailResources.connectionId, mailIds),
    selectWhenIds(
      tx,
      operatorAiConnectionReceipts,
      operatorAiConnectionReceipts.connectionId,
      aiIds,
    ),
    selectWhenIds(
      tx,
      operatorCalendarConnectionReceipts,
      operatorCalendarConnectionReceipts.connectionId,
      calendarIds,
    ),
    selectWhenIds(
      tx,
      operatorMailConnectionReceipts,
      operatorMailConnectionReceipts.connectionId,
      mailIds,
    ),
    selectWhenIds(
      tx,
      operatorMailSendingConnectionReceipts,
      operatorMailSendingConnectionReceipts.connectionId,
      sendingIds,
    ),
    selectWhenIds(
      tx,
      operatorConversationWorks,
      operatorConversationWorks.conversationId,
      conversationIds,
    ),
    selectWhenIds(
      tx,
      operatorConversationMessages,
      operatorConversationMessages.conversationId,
      conversationIds,
    ),
    selectWhenIds(tx, operatorMorningBriefItems, operatorMorningBriefItems.briefId, briefIds),
    selectWhenIds(
      tx,
      operatorActionPreviewRevisions,
      operatorActionPreviewRevisions.previewId,
      previewIds,
    ),
  ]);

  const calendarStatus = new Map(calendarConnections.map((item) => [item.id, item.status]));
  const mailStatus = new Map(mailConnections.map((item) => [item.id, item.status]));

  return {
    schemaVersion: 1,
    export: {
      id: input.exportId,
      generatedAt: input.generatedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    },
    owner: { ownerId: input.ownerId },
    exclusions: [...EXCLUSIONS],
    sourceAvailability:
      "Evidence pointers remain in the export even when their source is disconnected or unavailable. Bruno does not recreate missing provider content.",
    connections: {
      ai: aiConnections.map((item) => ({
        id: item.id,
        provider: item.provider,
        providerIdentity: item.providerSubjectId,
        accountLabel: item.accountLabel,
        status: item.status,
        authorizationState: item.authorizationState,
        approvedModelAssignment: item.approvedModelAssignment,
        lastVerifiedAt: iso(item.lastVerifiedAt),
      })),
      calendar: calendarConnections.map((item) => ({
        id: item.id,
        provider: item.provider,
        providerIdentity: item.providerSubjectId,
        accountLabel: item.accountLabel,
        status: item.status,
        authorizationState: item.authorizationState,
        grantedScopes: item.grantedScopes,
        selectedResources: calendarResources
          .filter((resource) => resource.connectionId === item.id && resource.selected)
          .map((resource) => ({
            id: resource.id,
            providerResourceId: resource.providerResourceId,
            summary: resource.summary,
            timeZone: resource.timeZone,
            status: resource.status,
          })),
        lastVerifiedAt: iso(item.lastVerifiedAt),
        lastEvidenceAt: iso(item.lastEvidenceAt),
        evidenceState: item.evidenceState,
      })),
      mail: mailConnections.map((item) => ({
        id: item.id,
        provider: item.provider,
        providerIdentity: item.providerSubjectId,
        accountLabel: item.accountLabel,
        status: item.status,
        authorizationState: item.authorizationState,
        grantedScopes: item.grantedScopes,
        selectedResources: mailResources
          .filter((resource) => resource.connectionId === item.id && resource.selected)
          .map((resource) => ({
            id: resource.id,
            providerResourceId: resource.providerResourceId,
            name: resource.name,
            labelType: resource.labelType,
            status: resource.status,
          })),
        lastVerifiedAt: iso(item.lastVerifiedAt),
        lastEvidenceAt: iso(item.lastEvidenceAt),
        evidenceState: item.evidenceState,
      })),
      mailSending: mailSendingConnections.map((item) => ({
        id: item.id,
        provider: item.provider,
        providerIdentity: item.providerSubjectId,
        accountLabel: item.accountLabel,
        status: item.status,
        authorizationState: item.authorizationState,
        grantedScopes: item.grantedScopes,
        lastVerifiedAt: iso(item.lastVerifiedAt),
      })),
    },
    records: {
      conversations: conversations.map((item) => ({
        id: item.id,
        status: item.status,
        createdAt: iso(item.createdAt),
        updatedAt: iso(item.updatedAt),
      })),
      conversationWorks: conversationWorks.map((item) => ({
        id: item.id,
        conversationId: item.conversationId,
        requestId: item.requestId,
        checkpointId: item.checkpointId,
        state: item.state,
        responseSequence: item.responseSequence,
        provider: item.provider,
        policyVersion: item.policyVersion,
        completionIdentity: item.completionIdentity,
        providerAttempts: sanitizeExportValue(item.providerAttempts),
        externalEffectStarted: item.externalEffectStarted,
        recoveryChoices: safeTextArray(item.recoveryChoices),
        recoveryMessage: safeText(item.recoveryMessage),
        createdAt: iso(item.createdAt),
        updatedAt: iso(item.updatedAt),
      })),
      conversationMessages: conversationMessages.map((item) => ({
        id: item.id,
        conversationId: item.conversationId,
        workId: item.workId,
        sequence: item.sequence,
        role: item.role,
        status: item.status,
        body: safeText(item.body) ?? "",
        createdAt: iso(item.createdAt),
      })),
      relationshipRecords: relationshipRecords.map((item) => ({
        id: item.id,
        displayName: item.displayName,
        company: item.company,
        primaryEmail: item.primaryEmail,
        provider: item.provider,
        providerIdentity: item.providerIdentity,
        relationshipState: item.relationshipState,
        status: item.status,
        nextAction: safeText(item.nextAction),
        nextActionDueAt: iso(item.nextActionDueAt),
        commitments: safeTextArray(item.commitments),
        revision: item.revision,
        founderConfirmedAt: iso(item.founderConfirmedAt),
        closedAt: iso(item.closedAt),
        createdAt: iso(item.createdAt),
        updatedAt: iso(item.updatedAt),
      })),
      relationshipCandidates: relationshipCandidates.map((item) => ({
        id: item.id,
        matchKind: item.matchKind,
        status: item.status,
        displayName: item.displayName,
        company: item.company,
        primaryEmail: item.primaryEmail,
        provider: item.provider,
        providerIdentity: item.providerIdentity,
        domain: item.domain,
        candidateKey: item.candidateKey,
        proposedRecordId: item.proposedRecordId,
        resolvedAt: iso(item.resolvedAt),
        createdAt: iso(item.createdAt),
        updatedAt: iso(item.updatedAt),
      })),
      relationshipCorrections: relationshipCorrections.map((item) => ({
        id: item.id,
        recordId: item.recordId,
        revision: item.revision,
        field: item.field,
        previousValue: sanitizeExportValue(item.previousValue),
        nextValue: sanitizeExportValue(item.nextValue),
        createdAt: iso(item.createdAt),
      })),
      relationshipEvidence: relationshipEvidence.map((item) =>
        mapEvidence(item, calendarStatus, mailStatus),
      ),
      limitedOperations: limitedOperations.map((item) => ({
        id: item.id,
        aiConnectionId: item.aiConnectionId,
        calendarConnectionId: item.calendarConnectionId,
        mailConnectionId: item.mailConnectionId,
        status: item.status,
        activatedAt: iso(item.activatedAt),
        createdAt: iso(item.createdAt),
        updatedAt: iso(item.updatedAt),
      })),
      morningBriefs: morningBriefs.map((item) => ({
        id: item.id,
        operationId: item.operationId,
        generation: item.generation,
        status: item.status,
        evidenceState: item.evidenceState,
        quiet: item.quiet,
        attentionCount: item.attentionCount,
        content: redactSecretText(item.content),
        evidenceDigest: item.evidenceDigest,
        evidenceWatermark: item.evidenceWatermark,
        windowStartedAt: iso(item.windowStartedAt),
        windowEndedAt: iso(item.windowEndedAt),
        generatedAt: iso(item.generatedAt),
        openedAt: iso(item.openedAt),
        createdAt: iso(item.createdAt),
      })),
      morningBriefItems: briefItems.map((item) => ({
        id: item.id,
        briefId: item.briefId,
        kind: item.kind,
        sourceId: item.sourceId,
        title: safeText(item.title) ?? "",
        detail: safeText(item.detail) ?? "",
        priority: item.priority,
        sourceWatermark: item.sourceWatermark,
        createdAt: iso(item.createdAt),
      })),
      founderActivations: founderActivations.map((item) => ({
        id: item.id,
        firstBriefId: item.firstBriefId,
        activatedAt: iso(item.activatedAt),
        evidenceDigest: item.evidenceDigest,
      })),
      actionPreviews: actionPreviews.map((item) => ({
        id: item.id,
        mailSendingOfferDismissedAt: iso(item.mailSendingOfferDismissedAt),
        createdAt: iso(item.createdAt),
        updatedAt: iso(item.updatedAt),
      })),
      actionPreviewRevisions: previewRevisions.map((item) => ({
        id: item.id,
        previewId: item.previewId,
        revision: item.revision,
        state: item.state,
        recipientName: item.recipientName,
        recipientAddress: item.recipientAddress,
        content: safeText(item.content) ?? "",
        supportingEvidence: sanitizeExportValue(item.supportingEvidence),
        expectedExternalEffect: safeText(item.expectedExternalEffect) ?? "",
        supersedesRevisionId: item.supersedesRevisionId,
        createdAt: iso(item.createdAt),
      })),
    },
    decisions: {
      proposedActions: proposedActions.map((item) => ({
        id: item.id,
        version: item.version,
        supersedesActionId: item.supersedesActionId,
        actionFamily: item.actionFamily,
        actionSubtype: item.actionSubtype,
        businessOutcome: redactSecretText(item.businessOutcome),
        destination: sanitizeExportValue(item.destination),
        materialContent: sanitizeExportValue(item.materialContent),
        sideEffects: safeTextArray(item.sideEffects),
        authorityPolicyVersion: item.authorityPolicyVersion,
        authorityMode: item.authorityMode,
        preconditions: sanitizeExportValue(item.preconditions),
        validUntil: iso(item.validUntil),
        executionWindowStart: iso(item.executionWindowStart),
        executionWindowEnd: iso(item.executionWindowEnd),
        state: item.state,
        createdAt: iso(item.createdAt),
        updatedAt: iso(item.updatedAt),
      })),
      actionDecisions: actionDecisions.map((item) => ({
        id: item.id,
        proposedActionId: item.proposedActionId,
        proposedActionVersion: item.proposedActionVersion,
        kind: item.kind,
        createdAt: iso(item.createdAt),
      })),
      actionAuthorizations: actionAuthorizations.map((item) => ({
        id: item.id,
        proposedActionId: item.proposedActionId,
        decisionId: item.decisionId,
        claimedAt: iso(item.claimedAt),
        createdAt: iso(item.createdAt),
      })),
      executionAttempts: executionAttempts.map((item) => ({
        id: item.id,
        proposedActionId: item.proposedActionId,
        authorizationId: item.authorizationId,
        attemptNumber: item.attemptNumber,
        phase: item.phase,
        provider: item.provider,
        messageIdentity: item.messageIdentity,
        providerMessageId: item.providerMessageId,
        providerThreadId: item.providerThreadId,
        requestDigest: item.requestDigest,
        responseDigest: item.responseDigest,
        errorCode: item.errorCode,
        createdAt: iso(item.createdAt),
      })),
    },
    receipts: {
      action: actionReceipts.map((item) => ({
        id: item.id,
        proposedActionId: item.proposedActionId,
        proposedActionVersion: item.proposedActionVersion,
        provider: item.provider,
        providerConnectionGeneration: item.providerConnectionGeneration,
        messageIdentity: item.messageIdentity,
        contentDigest: item.contentDigest,
        destinationDigest: item.destinationDigest,
        providerMessageId: item.providerMessageId,
        providerThreadId: item.providerThreadId,
        attemptCount: item.attemptCount,
        outcome: item.outcome,
        outcomeReason: safeText(item.outcomeReason),
        acknowledgedAt: iso(item.acknowledgedAt),
        evidenceDigest: item.evidenceDigest,
        createdAt: iso(item.createdAt),
      })),
      aiConnection: aiReceipts.map((item) => ({
        id: item.id,
        connectionId: item.connectionId,
        generation: item.generation,
        kind: item.kind,
        provider: item.provider,
        providerIdentity: item.providerSubjectId,
        accountLabel: item.accountLabel,
        status: item.status,
        evidenceDigest: item.evidenceDigest,
        createdAt: iso(item.createdAt),
      })),
      calendarConnection: calendarReceipts.map((item) => ({
        id: item.id,
        connectionId: item.connectionId,
        generation: item.generation,
        kind: item.kind,
        provider: item.provider,
        providerIdentity: item.providerSubjectId,
        accountLabel: item.accountLabel,
        grantedScopes: item.grantedScopes,
        selectedResourceCount: item.selectedResourceCount,
        selectedResourceDigest: item.selectedResourceDigest,
        evidenceState: item.evidenceState,
        status: item.status,
        evidenceDigest: item.evidenceDigest,
        createdAt: iso(item.createdAt),
      })),
      mailConnection: mailReceipts.map((item) => ({
        id: item.id,
        connectionId: item.connectionId,
        generation: item.generation,
        kind: item.kind,
        provider: item.provider,
        providerIdentity: item.providerSubjectId,
        accountLabel: item.accountLabel,
        grantedScopes: item.grantedScopes,
        selectedResourceCount: item.selectedResourceCount,
        selectedResourceDigest: item.selectedResourceDigest,
        evidenceState: item.evidenceState,
        suiteStatus: item.suiteStatus,
        status: item.status,
        evidenceDigest: item.evidenceDigest,
        createdAt: iso(item.createdAt),
      })),
      mailSendingConnection: sendingReceipts.map((item) => ({
        id: item.id,
        connectionId: item.connectionId,
        generation: item.generation,
        kind: item.kind,
        provider: item.provider,
        providerIdentity: item.providerSubjectId,
        accountLabel: item.accountLabel,
        grantedScopes: item.grantedScopes,
        status: item.status,
        evidenceDigest: item.evidenceDigest,
        createdAt: iso(item.createdAt),
      })),
      governance: governanceReceipts.map((item) => ({
        id: item.id,
        kind: item.kind,
        processingConsentId: item.processingConsentId,
        authorityPolicyId: item.authorityPolicyId,
        evidenceDigest: item.evidenceDigest,
        createdAt: iso(item.createdAt),
      })),
    },
    processing: {
      consents: processingConsents.map((item) => ({
        id: item.id,
        aiConnectionId: item.aiConnectionId,
        calendarConnectionId: item.calendarConnectionId,
        mailConnectionId: item.mailConnectionId,
        version: item.version,
        status: item.status,
        purpose: item.purpose,
        confirmedAt: iso(item.confirmedAt),
        revokedAt: iso(item.revokedAt),
        createdAt: iso(item.createdAt),
      })),
      authorityPolicies: authorityPolicies.map((item) => ({
        id: item.id,
        version: item.version,
        actionFamilies: item.actionFamilies,
        observation: item.observation,
        preparation: item.preparation,
        externalEffects: item.externalEffects,
        mailIncluded: item.mailIncluded,
        confirmedAt: iso(item.confirmedAt),
        createdAt: iso(item.createdAt),
      })),
    },
  };
}

async function selectWhenIds(
  tx: PrivacyTransaction,
  table: AnyPgTable,
  column: AnyPgColumn,
  ids: string[],
): Promise<Array<Record<string, unknown>>> {
  if (ids.length === 0) return [];
  return tx.select().from(table).where(inArray(column, ids));
}

async function recordExportAccess(
  tx: PrivacyTransaction,
  exportId: string,
  actorUserId: string,
  format: FounderDataExportFormat,
  outcome: "downloaded" | "expired" | "owner_mismatch",
  accessedAt: Date,
): Promise<void> {
  await tx.insert(operatorFounderDataExportAccesses).values({
    exportId,
    actorUserId,
    format,
    outcome,
    accessedAt,
  });
}

function mapEvidence(
  item: typeof operatorRelationshipEvidence.$inferSelect,
  calendarStatus: Map<string, string>,
  mailStatus: Map<string, string>,
): ExportRecord {
  const sourceStatus =
    item.sourceKind === "calendar"
      ? calendarStatus.get(item.calendarConnectionId ?? "")
      : mailStatus.get(item.mailConnectionId ?? "");
  const availability = evidenceAvailability(item.evidenceState, sourceStatus);
  const contentRetained = availability === "current" || availability === "stale";
  return {
    id: item.id,
    recordId: item.recordId,
    candidateId: item.candidateId,
    sourceKind: item.sourceKind,
    provider: item.provider,
    providerItemId: item.providerItemId,
    providerIdentity: item.providerIdentity,
    email: item.email,
    displayName: item.displayName,
    company: item.company,
    domain: item.domain,
    sourceAvailability: availability,
    contentStatus: item.excerpt === null ? "tombstone" : contentRetained ? "retained" : "tombstone",
    excerpt: contentRetained ? safeText(item.excerpt) : null,
    observedAt: item.observedAt.toISOString(),
    sourceFingerprint: item.sourceFingerprint,
    updatedAt: item.updatedAt.toISOString(),
  };
}

function mapTestEvidence(item: {
  id: string;
  provider: string;
  providerItemId: string;
  providerIdentity: string | null;
  email: string | null;
  displayName: string | null;
  company: string | null;
  evidenceState: "current" | "stale" | "disconnected" | "unavailable";
  excerpt: string | null;
  observedAt: Date;
  sourceFingerprint: string;
}): ExportRecord {
  const contentRetained = item.evidenceState === "current" || item.evidenceState === "stale";
  return {
    id: item.id,
    sourceKind: "mail",
    provider: item.provider,
    providerItemId: item.providerItemId,
    providerIdentity: item.providerIdentity,
    email: item.email,
    displayName: item.displayName,
    company: item.company,
    sourceAvailability: item.evidenceState,
    contentStatus: item.excerpt === null ? "tombstone" : contentRetained ? "retained" : "tombstone",
    excerpt: contentRetained ? safeText(item.excerpt) : null,
    observedAt: item.observedAt.toISOString(),
    sourceFingerprint: item.sourceFingerprint,
  };
}

function evidenceAvailability(
  evidenceState: (typeof operatorRelationshipEvidence.$inferSelect)["evidenceState"],
  sourceStatus: string | undefined,
): "current" | "stale" | "disconnected" | "unavailable" {
  if (evidenceState === "disconnected" || evidenceState === "unavailable") return evidenceState;
  if (sourceStatus && sourceStatus !== "ready") return "disconnected";
  return evidenceState;
}

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function safeText(value: unknown): string | null {
  return typeof value === "string" ? redactSecretText(value) : null;
}

function safeTextArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map(redactSecretText)
    : [];
}

function hashExportToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sanitizeExportValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value === "string" ? redactSecretText(value) : value;
  }
  if (Array.isArray(value))
    return value.map(sanitizeExportValue).filter((item) => item !== undefined);
  if (typeof value !== "object") return undefined;

  const result: ExportRecord = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isExcludedExportKey(key)) continue;
    const sanitized = sanitizeExportValue(nested);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function isExcludedExportKey(key: string): boolean {
  return /(token|secret|password|credential|ciphertext|auth.?tag|private.?key|authorization.?code|api.?key|cookie|raw.?log|provider.?response|source.?archive)/i.test(
    key,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
