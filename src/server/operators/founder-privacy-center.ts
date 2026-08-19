import "server-only";

import { and, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  operatorActionReceipts,
  operatorAiConnections,
  operatorCalendarConnections,
  operatorCalendarResources,
  operatorConversationMessages,
  operatorConversationWorks,
  operatorConversations,
  operatorMailConnections,
  operatorMailResources,
  operatorMailSendingConnections,
  operatorRelationshipEvidence,
  operatorRelationshipCandidates,
  operatorRelationshipRecords,
  operators,
} from "@/src/server/db/schema";
import { routeFounderAiProvider } from "@/src/server/operators/founder-ai-routing";

type PrivacyTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type FounderPrivacyConnection = {
  id: string;
  kind: "ai" | "calendar" | "mail" | "mail_sending";
  provider: string;
  providerIdentity: string | null;
  accountLabel: string | null;
  availability: string;
  selectedResources: string[];
  grantedAccess: string[];
  narrowerUse: string;
  capabilities: string[];
  freshness: string | null;
  lastUse: string | null;
  isActiveRoute: boolean;
};

export type FounderPrivacyCenterDto = {
  ownerId: string;
  aiRoute: {
    provider: string | null;
    accountLabel: string | null;
    purpose: string;
    policyVersion: number;
    posture: string;
    knownRetention: string;
    limitations: string[];
  };
  connections: FounderPrivacyConnection[];
  retainedData: Array<{
    category: string;
    purpose: string;
    retention: string;
    deletableInBruno: boolean;
  }>;
  exportPolicy: {
    description: string;
    expiresAfterHours: number;
    formats: Array<"json" | "html">;
    exclusions: string[];
  };
  restrictedCategories: string[];
  deletionBoundary: string;
};

export type FounderPrivacyDeletionResult = {
  deleted: {
    conversationMessages: number;
    conversationWorks: number;
    conversations: number;
    relationshipEvidence: number;
    relationshipRecords: number;
    relationshipCandidates: number;
    relationshipCorrections: number;
  };
  retained: string[];
};

const RETAINED_DATA = [
  {
    category: "Founder conversations and generated responses",
    purpose: "Operate the private Founder workspace and preserve checkpoint state.",
    retention:
      "Kept in Bruno until you delete retained data; provider copies are governed by provider policy.",
    deletableInBruno: true,
  },
  {
    category: "Relationship evidence excerpts",
    purpose: "Ground relationship context and bounded Founder preparation.",
    retention: "Kept in Bruno until you delete retained data; source systems remain unchanged.",
    deletableInBruno: true,
  },
  {
    category: "Relationship records, candidates, and corrections",
    purpose: "Keep the Founder relationship graph and its reviewed changes coherent.",
    retention: "Kept in Bruno until you delete retained data; source systems remain unchanged.",
    deletableInBruno: true,
  },
  {
    category: "Connection identity, consent, and safety receipts",
    purpose: "Prove which account, scope, policy, and approval were used.",
    retention: "Retained as safety and audit records; disconnect does not delete these records.",
    deletableInBruno: false,
  },
] as const;

const RESTRICTED_CATEGORIES = [
  "Passwords, API keys, OAuth tokens, and other credentials",
  "Provider data outside the resources and labels you selected",
  "Mail sending content unless you explicitly approve an exact message",
  "Unobserved provider data: Bruno cannot detect every copy, export, or provider-side retention",
] as const;

export async function getFounderPrivacyCenterForUser(
  userId: string,
  dependencies: { createConnection?: () => DatabaseConnection; now?: () => Date } = {},
): Promise<FounderPrivacyCenterDto | null> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      const [operator] = await tx
        .select()
        .from(operators)
        .where(and(eq(operators.userId, userId), eq(operators.status, "active")))
        .limit(1);
      if (!operator) return null;

      const [aiConnections, calendar, mail, mailSending] = await Promise.all([
        tx
          .select()
          .from(operatorAiConnections)
          .where(eq(operatorAiConnections.operatorId, operator.id))
          .orderBy(desc(operatorAiConnections.updatedAt)),
        tx
          .select()
          .from(operatorCalendarConnections)
          .where(eq(operatorCalendarConnections.operatorId, operator.id))
          .limit(1),
        tx
          .select()
          .from(operatorMailConnections)
          .where(eq(operatorMailConnections.operatorId, operator.id))
          .limit(1),
        tx
          .select()
          .from(operatorMailSendingConnections)
          .where(eq(operatorMailSendingConnections.operatorId, operator.id))
          .limit(1),
      ]);

      const route = await routeFounderAiProvider(tx, operator.id, {
        now: dependencies.now?.() ?? new Date(),
      });
      const aiUse = await Promise.all(
        aiConnections.map(async (item) => ({
          item,
          lastUse: await latestAiUse(tx, item.id),
        })),
      );
      const connections: FounderPrivacyConnection[] = aiUse.map(({ item, lastUse }) => ({
        id: item.id,
        kind: "ai",
        provider: item.provider,
        providerIdentity: item.providerSubjectId,
        accountLabel: item.accountLabel,
        availability: item.status,
        selectedResources: ["No provider resources; account-level inference grant only"],
        grantedAccess: [
          item.authorizationState === "authorized"
            ? "Authorized AI inference"
            : "Authorization not active",
          item.approvedModelAssignment ? "Bruno-owned model assignment" : "No model assignment",
        ],
        narrowerUse:
          "Only bounded Founder preparation and approved work units; no general-purpose account access.",
        capabilities: [
          "Generate bounded text responses",
          "Record provider/account and policy evidence",
        ],
        freshness: item.lastVerifiedAt?.toISOString() ?? null,
        lastUse,
        isActiveRoute: route?.connectionId === item.id,
      }));

      if (calendar[0]) {
        const item = calendar[0];
        const resources = await tx
          .select()
          .from(operatorCalendarResources)
          .where(eq(operatorCalendarResources.connectionId, item.id))
          .orderBy(operatorCalendarResources.summary);
        connections.push({
          id: item.id,
          kind: "calendar",
          provider: item.provider,
          providerIdentity: item.providerSubjectId,
          accountLabel: item.accountLabel,
          availability: item.status,
          selectedResources: resources
            .filter((resource) => resource.selected)
            .map((resource) => resource.summary),
          grantedAccess: item.grantedScopes,
          narrowerUse:
            "Read selected calendars only to prepare bounded Founder context and briefs.",
          capabilities: ["Read event evidence", "Read selected calendar metadata"],
          freshness:
            item.lastVerifiedAt?.toISOString() ?? item.lastEvidenceAt?.toISOString() ?? null,
          lastUse: item.lastEvidenceAt?.toISOString() ?? null,
          isActiveRoute: false,
        });
      }

      if (mail[0]) {
        const item = mail[0];
        const resources = await tx
          .select()
          .from(operatorMailResources)
          .where(eq(operatorMailResources.connectionId, item.id))
          .orderBy(operatorMailResources.name);
        connections.push({
          id: item.id,
          kind: "mail",
          provider: item.provider,
          providerIdentity: item.providerSubjectId,
          accountLabel: item.accountLabel,
          availability: item.status,
          selectedResources: resources
            .filter((resource) => resource.selected)
            .map((resource) => resource.name),
          grantedAccess: item.grantedScopes,
          narrowerUse:
            "Read selected Gmail labels only for bounded Founder context; this grant cannot send mail.",
          capabilities: ["Read selected message evidence", "Read selected label metadata"],
          freshness:
            item.lastVerifiedAt?.toISOString() ?? item.lastEvidenceAt?.toISOString() ?? null,
          lastUse: item.lastEvidenceAt?.toISOString() ?? null,
          isActiveRoute: false,
        });
      }

      if (mailSending[0]) {
        const item = mailSending[0];
        const [lastUse] = await tx
          .select({ createdAt: operatorActionReceipts.createdAt })
          .from(operatorActionReceipts)
          .where(eq(operatorActionReceipts.providerConnectionId, item.id))
          .orderBy(desc(operatorActionReceipts.createdAt))
          .limit(1);
        connections.push({
          id: item.id,
          kind: "mail_sending",
          provider: item.provider,
          providerIdentity: item.providerSubjectId,
          accountLabel: item.accountLabel,
          availability: item.status,
          selectedResources: ["No reading resources; send-only grant"],
          grantedAccess: item.grantedScopes,
          narrowerUse:
            "Send one exact Founder-approved message at a time; cannot read, modify, or delete mail.",
          capabilities: ["Send an approved exact message", "Record immutable action receipt"],
          freshness: item.lastVerifiedAt?.toISOString() ?? null,
          lastUse: lastUse?.createdAt.toISOString() ?? null,
          isActiveRoute: false,
        });
      }

      return {
        ownerId: userId,
        aiRoute: {
          provider: route?.provider ?? null,
          accountLabel: route?.accountLabel ?? null,
          purpose: "Bounded Founder workspace preparation and approved work units.",
          policyVersion: route?.policyVersion ?? 1,
          posture:
            "Only selected evidence and the current work-unit context are sent; credentials and unrelated provider data are excluded.",
          knownRetention:
            "Bruno controls its local retention. Provider-side retention is governed by the provider policy and is not controlled or deleted by Bruno.",
          limitations: [
            "No hidden or Bruno-funded fallback provider is used.",
            "Provider availability, account limits, and policy freshness can pause work.",
            "Bruno cannot observe or delete every provider-side copy.",
          ],
        },
        connections,
        retainedData: [...RETAINED_DATA],
        exportPolicy: {
          description:
            "A Founder-only snapshot of retained Bruno records, decisions, and receipts. Downloads require recent authentication and expire after 24 hours.",
          expiresAfterHours: 24,
          formats: ["json", "html"],
          exclusions: [
            "Credentials, provider source archives, and raw technical logs",
            "Provider-held copies or data outside selected Connection Resources",
          ],
        },
        restrictedCategories: [...RESTRICTED_CATEGORIES],
        deletionBoundary:
          "Delete retained data removes Bruno-local conversation content and relationship evidence. It does not disconnect accounts, revoke provider grants, remove consent or safety receipts, or delete provider-held copies.",
      };
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function deleteFounderRetainedDataForUser(
  userId: string,
  dependencies: { createConnection?: () => DatabaseConnection } = {},
): Promise<FounderPrivacyDeletionResult> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      const [operator] = await tx
        .select({ id: operators.id })
        .from(operators)
        .where(and(eq(operators.userId, userId), eq(operators.status, "active")))
        .limit(1);
      if (!operator) {
        return {
          deleted: {
            conversationMessages: 0,
            conversationWorks: 0,
            conversations: 0,
            relationshipEvidence: 0,
            relationshipRecords: 0,
            relationshipCandidates: 0,
            relationshipCorrections: 0,
          },
          retained: ["No active Founder Operator was found."],
        };
      }

      const conversations = await tx
        .select({ id: operatorConversations.id })
        .from(operatorConversations)
        .where(eq(operatorConversations.operatorId, operator.id));
      const conversationIds = conversations.map((conversation) => conversation.id);
      let conversationMessages = 0;
      let conversationWorks = 0;
      if (conversationIds.length > 0) {
        const firstConversationId = conversationIds[0];
        if (!firstConversationId) {
          return finishDeletion(tx, operator.id, {
            conversationMessages,
            conversationWorks,
            conversations: 0,
          });
        }
        const messages = await tx
          .delete(operatorConversationMessages)
          .where(eq(operatorConversationMessages.conversationId, firstConversationId))
          .returning({ id: operatorConversationMessages.id });
        conversationMessages += messages.length;
        for (const conversationId of conversationIds.slice(1)) {
          const removed = await tx
            .delete(operatorConversationMessages)
            .where(eq(operatorConversationMessages.conversationId, conversationId))
            .returning({ id: operatorConversationMessages.id });
          conversationMessages += removed.length;
        }
        const works = await tx
          .delete(operatorConversationWorks)
          .where(eq(operatorConversationWorks.conversationId, firstConversationId))
          .returning({ id: operatorConversationWorks.id });
        conversationWorks += works.length;
        for (const conversationId of conversationIds.slice(1)) {
          const removed = await tx
            .delete(operatorConversationWorks)
            .where(eq(operatorConversationWorks.conversationId, conversationId))
            .returning({ id: operatorConversationWorks.id });
          conversationWorks += removed.length;
        }
        const removedConversations = await tx
          .delete(operatorConversations)
          .where(eq(operatorConversations.operatorId, operator.id))
          .returning({ id: operatorConversations.id });
        return finishDeletion(tx, operator.id, {
          conversationMessages,
          conversationWorks,
          conversations: removedConversations.length,
        });
      }
      return finishDeletion(tx, operator.id, {
        conversationMessages,
        conversationWorks,
        conversations: 0,
      });
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function finishDeletion(
  tx: PrivacyTransaction,
  operatorId: string,
  deleted: Omit<
    FounderPrivacyDeletionResult["deleted"],
    | "relationshipEvidence"
    | "relationshipRecords"
    | "relationshipCandidates"
    | "relationshipCorrections"
  >,
): Promise<FounderPrivacyDeletionResult> {
  const evidence = await tx
    .delete(operatorRelationshipEvidence)
    .where(eq(operatorRelationshipEvidence.operatorId, operatorId))
    .returning({ id: operatorRelationshipEvidence.id });
  const candidates = await tx
    .delete(operatorRelationshipCandidates)
    .where(eq(operatorRelationshipCandidates.operatorId, operatorId))
    .returning({ id: operatorRelationshipCandidates.id });
  const records = await tx
    .delete(operatorRelationshipRecords)
    .where(eq(operatorRelationshipRecords.operatorId, operatorId))
    .returning({ id: operatorRelationshipRecords.id });
  return {
    deleted: {
      ...deleted,
      relationshipEvidence: evidence.length,
      relationshipRecords: records.length,
      relationshipCandidates: candidates.length,
      relationshipCorrections: 0,
    },
    retained: [
      "Connection identities, granted scopes, processing consent, provider receipts, and safety audit records remain.",
      "Provider-held copies remain subject to each provider's policy and controls.",
    ],
  };
}

async function latestAiUse(tx: PrivacyTransaction, connectionId: string): Promise<string | null> {
  const [work] = await tx
    .select({ updatedAt: operatorConversationWorks.updatedAt })
    .from(operatorConversationWorks)
    .where(eq(operatorConversationWorks.providerConnectionId, connectionId))
    .orderBy(desc(operatorConversationWorks.updatedAt))
    .limit(1);
  return work?.updatedAt.toISOString() ?? null;
}
