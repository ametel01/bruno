import "server-only";

import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  operatorAiConnections,
  operatorAuthorityPolicies,
  operatorCalendarConnections,
  operatorFounderActivations,
  operatorGovernanceReceipts,
  operatorLimitedOperations,
  operatorMailConnections,
  operatorMorningBriefs,
  operatorPrimaryCommunicationsSuites,
  operatorProcessingConsents,
} from "@/src/server/db/schema";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";
import {
  projectFounderActionPreview,
  type FounderActionPreviewDto,
} from "@/src/server/operators/founder-action-previews";

type CoreTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

const CORE_PURPOSE = "core_operation" as const;

export type FounderCoreOperationStatus = "awaiting_consent" | "core" | "needs_attention";

export type FounderCoreOperationDto = {
  name: "Core Operation";
  status: FounderCoreOperationStatus;
  mailIncluded: true;
  mailSendingRequired: false;
  suite: {
    status: "active" | "unavailable" | "mismatch";
    providerSubjectId: string | null;
  };
  access: {
    ai: "ready" | "unavailable";
    calendar: "ready" | "unavailable";
    mail: "ready" | "unavailable";
    evidence: "current" | "unavailable";
  };
  consent: {
    status: "active" | "missing";
    purpose: typeof CORE_PURPOSE;
    confirmedAt: string | null;
  };
  authorityPolicy: {
    version: number;
    observation: "always";
    preparation: "always";
    externalEffects: "approval_required";
    mailIncluded: false;
  } | null;
  brief: {
    id: string;
    generation: number;
    status: "prepared" | "opened";
    evidenceState: "current" | "unavailable";
    quiet: boolean;
    attentionCount: number;
    content: string;
    generatedAt: string;
    openedAt: string | null;
  } | null;
  actionPreview?: FounderActionPreviewDto;
  activatedAt: string | null;
};

export type FounderCoreOperationDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
};

export class FounderCoreOperationError extends Error {
  readonly code: string;
  readonly status: 400 | 409 | 503;

  constructor(code: string, message: string, status: 400 | 409 | 503 = 409) {
    super(message);
    this.name = "FounderCoreOperationError";
    this.code = code;
    this.status = status;
  }
}

export async function getFounderCoreOperationForUser(
  userId: string,
  dependencies: FounderCoreOperationDependencies = {},
): Promise<FounderCoreOperationDto | null> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, async (connection) =>
    connection.db.transaction(async (tx) => {
      const operation = await ensureCoreOperation(
        tx,
        operator.id,
        dependencies.now?.() ?? new Date(),
      );
      return operation ? projectCoreOperation(tx, operation, operator.id) : null;
    }),
  );
}

export async function confirmFounderCoreProcessingConsentForUser(
  userId: string,
  dependencies: FounderCoreOperationDependencies = {},
): Promise<FounderCoreOperationDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, async (connection) => {
    const at = dependencies.now?.() ?? new Date();
    return connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const pair = await readyCoreConnectionSet(tx, operator.id);
      if (!pair) {
        throw new FounderCoreOperationError(
          "core_connections_not_ready",
          "Bruno needs Ready AI, Current Calendar, and Current Mail from the same Primary Communications Suite before you confirm Core Operation consent.",
        );
      }
      const operation = await ensureCoreOperation(tx, operator.id, at, pair);
      if (!operation) {
        throw new FounderCoreOperationError(
          "core_operation_unavailable",
          "Core Operation could not be established.",
          503,
        );
      }
      if (
        operation.status === "needs_attention" &&
        (operation.aiConnectionId !== pair.ai.id ||
          operation.calendarConnectionId !== pair.calendar.id ||
          operation.mailConnectionId !== pair.mail.id)
      ) {
        throw new FounderCoreOperationError(
          "connection_replacement_requires_migration",
          "A replaced provider identity cannot inherit Core Operation. Review the connection replacement before confirming again.",
        );
      }

      const consent = await upsertCoreConsent(tx, operator.id, pair, at);
      const policy = await upsertSafePolicy(tx, operator.id, at);
      await tx
        .insert(operatorGovernanceReceipts)
        .values({
          operatorId: operator.id,
          kind: "processing_consent",
          processingConsentId: consent.id,
          evidenceDigest: digest({
            kind: "processing_consent",
            consentId: consent.id,
            aiConnectionId: pair.ai.id,
            calendarConnectionId: pair.calendar.id,
            mailConnectionId: pair.mail.id,
            purpose: CORE_PURPOSE,
          }),
          createdAt: at,
        })
        .onConflictDoNothing();
      await tx
        .insert(operatorGovernanceReceipts)
        .values({
          operatorId: operator.id,
          kind: "authority_policy",
          authorityPolicyId: policy.id,
          evidenceDigest: digest({
            kind: "authority_policy",
            policyId: policy.id,
            version: policy.version,
            observation: policy.observation,
            preparation: policy.preparation,
            externalEffects: policy.externalEffects,
            mailIncluded: false,
          }),
          createdAt: at,
        })
        .onConflictDoNothing();

      const [saved] = await tx
        .update(operatorLimitedOperations)
        .set({
          aiConnectionId: pair.ai.id,
          calendarConnectionId: pair.calendar.id,
          mailConnectionId: pair.mail.id,
          processingConsentId: consent.id,
          authorityPolicyId: policy.id,
          status: "core",
          updatedAt: at,
        })
        .where(eq(operatorLimitedOperations.id, operation.id))
        .returning();
      if (!saved) {
        throw new FounderCoreOperationError(
          "core_operation_unavailable",
          "Core Operation could not be saved.",
          503,
        );
      }
      await ensureCoreBrief(
        tx,
        saved,
        pair.calendar.lastEvidenceCount + pair.mail.lastEvidenceCount,
        at,
      );
      return projectCoreOperation(tx, saved, operator.id);
    });
  });
}

export async function reconcileFounderCoreOperationForUser(
  userId: string,
  dependencies: FounderCoreOperationDependencies = {},
): Promise<FounderCoreOperationDto | null> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, async (connection) =>
    connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const operation = await ensureCoreOperation(
        tx,
        operator.id,
        dependencies.now?.() ?? new Date(),
      );
      if (operation?.status !== "core" || !operation.processingConsentId) {
        return operation ? projectCoreOperation(tx, operation, operator.id) : null;
      }
      const [calendar] = await tx
        .select()
        .from(operatorCalendarConnections)
        .where(eq(operatorCalendarConnections.id, operation.calendarConnectionId))
        .limit(1);
      const [mail] = operation.mailConnectionId
        ? await tx
            .select()
            .from(operatorMailConnections)
            .where(eq(operatorMailConnections.id, operation.mailConnectionId))
            .limit(1)
        : [];
      if (calendar?.evidenceState === "current" && mail?.evidenceState === "current") {
        await ensureCoreBrief(
          tx,
          operation,
          calendar.lastEvidenceCount + (mail.lastEvidenceCount ?? 0),
          dependencies.now?.() ?? new Date(),
        );
      }
      const [fresh] = await tx
        .select()
        .from(operatorLimitedOperations)
        .where(eq(operatorLimitedOperations.id, operation.id))
        .limit(1);
      return fresh ? projectCoreOperation(tx, fresh, operator.id) : null;
    }),
  );
}

export async function openFounderCoreBriefForUser(
  userId: string,
  dependencies: FounderCoreOperationDependencies = {},
): Promise<FounderCoreOperationDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, async (connection) => {
    const at = dependencies.now?.() ?? new Date();
    return connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const operation = await ensureCoreOperation(tx, operator.id, at);
      if (operation?.status !== "core") {
        throw new FounderCoreOperationError(
          "core_operation_not_ready",
          "Confirm Core Operation Processing Consent before opening the current brief.",
        );
      }
      const [brief] = await tx
        .select()
        .from(operatorMorningBriefs)
        .where(
          and(
            eq(operatorMorningBriefs.operationId, operation.id),
            eq(operatorMorningBriefs.generation, 1),
          ),
        )
        .limit(1);
      if (!brief) {
        throw new FounderCoreOperationError(
          "first_brief_not_ready",
          "Bruno is waiting for Current Calendar and Mail evidence.",
        );
      }
      const openedAt = brief.openedAt ?? at;
      if (brief.status === "prepared") {
        await tx
          .update(operatorMorningBriefs)
          .set({ status: "opened", openedAt })
          .where(eq(operatorMorningBriefs.id, brief.id));
      }
      await tx
        .insert(operatorFounderActivations)
        .values({
          operatorId: operator.id,
          firstBriefId: brief.id,
          activatedAt: openedAt,
          evidenceDigest: digest({
            operatorId: operator.id,
            firstBriefId: brief.id,
            purpose: CORE_PURPOSE,
          }),
        })
        .onConflictDoNothing();
      await tx
        .update(operatorLimitedOperations)
        .set({
          firstBriefId: brief.id,
          activatedAt: operation.activatedAt ?? openedAt,
          updatedAt: at,
        })
        .where(eq(operatorLimitedOperations.id, operation.id));
      const [fresh] = await tx
        .select()
        .from(operatorLimitedOperations)
        .where(eq(operatorLimitedOperations.id, operation.id))
        .limit(1);
      if (!fresh)
        throw new FounderCoreOperationError(
          "core_operation_unavailable",
          "Core Operation could not be reloaded.",
          503,
        );
      return projectCoreOperation(tx, fresh, operator.id);
    });
  });
}

async function ensureCoreOperation(
  tx: CoreTransaction,
  operatorId: string,
  at: Date,
  pair?: Awaited<ReturnType<typeof readyCoreConnectionSet>>,
) {
  const currentPair = pair ?? (await readyCoreConnectionSet(tx, operatorId));
  const [existing] = await tx
    .select()
    .from(operatorLimitedOperations)
    .where(eq(operatorLimitedOperations.operatorId, operatorId))
    .limit(1);
  if (!currentPair) {
    if (existing?.mailConnectionId && existing.status === "core") {
      const [updated] = await tx
        .update(operatorLimitedOperations)
        .set({ status: "needs_attention", updatedAt: at })
        .where(eq(operatorLimitedOperations.id, existing.id))
        .returning();
      return updated ?? existing;
    }
    return existing?.mailConnectionId ? existing : null;
  }
  if (existing) {
    if (
      existing.mailConnectionId &&
      existing.status === "core" &&
      (existing.aiConnectionId !== currentPair.ai.id ||
        existing.calendarConnectionId !== currentPair.calendar.id ||
        existing.mailConnectionId !== currentPair.mail.id)
    ) {
      const [updated] = await tx
        .update(operatorLimitedOperations)
        .set({ status: "needs_attention", updatedAt: at })
        .where(eq(operatorLimitedOperations.id, existing.id))
        .returning();
      return updated ?? existing;
    }
    if (!existing.mailConnectionId && existing.status !== "core") {
      const [updated] = await tx
        .update(operatorLimitedOperations)
        .set({
          aiConnectionId: currentPair.ai.id,
          calendarConnectionId: currentPair.calendar.id,
          mailConnectionId: currentPair.mail.id,
          updatedAt: at,
        })
        .where(eq(operatorLimitedOperations.id, existing.id))
        .returning();
      return updated ?? existing;
    }
    return existing;
  }
  const [created] = await tx
    .insert(operatorLimitedOperations)
    .values({
      operatorId,
      aiConnectionId: currentPair.ai.id,
      calendarConnectionId: currentPair.calendar.id,
      mailConnectionId: currentPair.mail.id,
      status: "awaiting_consent",
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing({ target: operatorLimitedOperations.operatorId })
    .returning();
  return (
    created ??
    (
      await tx
        .select()
        .from(operatorLimitedOperations)
        .where(eq(operatorLimitedOperations.operatorId, operatorId))
        .limit(1)
    )[0]
  );
}

async function readyCoreConnectionSet(tx: CoreTransaction, operatorId: string) {
  const [ai] = await tx
    .select()
    .from(operatorAiConnections)
    .where(
      and(
        eq(operatorAiConnections.operatorId, operatorId),
        eq(operatorAiConnections.status, "ready"),
      ),
    )
    .orderBy(desc(operatorAiConnections.updatedAt))
    .limit(1);
  const [calendar] = await tx
    .select()
    .from(operatorCalendarConnections)
    .where(
      and(
        eq(operatorCalendarConnections.operatorId, operatorId),
        eq(operatorCalendarConnections.status, "ready"),
        eq(operatorCalendarConnections.evidenceState, "current"),
      ),
    )
    .orderBy(desc(operatorCalendarConnections.updatedAt))
    .limit(1);
  const [mail] = await tx
    .select()
    .from(operatorMailConnections)
    .where(
      and(
        eq(operatorMailConnections.operatorId, operatorId),
        eq(operatorMailConnections.status, "ready"),
        eq(operatorMailConnections.evidenceState, "current"),
        eq(operatorMailConnections.suiteStatus, "matched"),
      ),
    )
    .orderBy(desc(operatorMailConnections.updatedAt))
    .limit(1);
  if (
    !ai ||
    !calendar ||
    !mail ||
    !calendar.providerSubjectId ||
    calendar.providerSubjectId !== mail.providerSubjectId
  )
    return null;
  const [suite] = await tx
    .select()
    .from(operatorPrimaryCommunicationsSuites)
    .where(
      and(
        eq(operatorPrimaryCommunicationsSuites.operatorId, operatorId),
        eq(operatorPrimaryCommunicationsSuites.calendarConnectionId, calendar.id),
        eq(operatorPrimaryCommunicationsSuites.mailConnectionId, mail.id),
        eq(operatorPrimaryCommunicationsSuites.status, "active"),
      ),
    )
    .limit(1);
  return suite ? { ai, calendar, mail, suite } : null;
}

async function upsertCoreConsent(
  tx: CoreTransaction,
  operatorId: string,
  pair: NonNullable<Awaited<ReturnType<typeof readyCoreConnectionSet>>>,
  at: Date,
) {
  const [existing] = await tx
    .select()
    .from(operatorProcessingConsents)
    .where(
      and(
        eq(operatorProcessingConsents.operatorId, operatorId),
        eq(operatorProcessingConsents.aiConnectionId, pair.ai.id),
        eq(operatorProcessingConsents.calendarConnectionId, pair.calendar.id),
        eq(operatorProcessingConsents.mailConnectionId, pair.mail.id),
        eq(operatorProcessingConsents.purpose, CORE_PURPOSE),
      ),
    )
    .limit(1);
  if (existing?.status === "active") return existing;
  if (existing) {
    const [reactivated] = await tx
      .update(operatorProcessingConsents)
      .set({ status: "active", confirmedAt: at, revokedAt: null })
      .where(eq(operatorProcessingConsents.id, existing.id))
      .returning();
    if (reactivated) return reactivated;
  }
  const [created] = await tx
    .insert(operatorProcessingConsents)
    .values({
      operatorId,
      aiConnectionId: pair.ai.id,
      calendarConnectionId: pair.calendar.id,
      mailConnectionId: pair.mail.id,
      status: "active",
      purpose: CORE_PURPOSE,
      confirmedAt: at,
      createdAt: at,
    })
    .returning();
  if (!created)
    throw new FounderCoreOperationError(
      "consent_unavailable",
      "Core Processing Consent could not be saved.",
      503,
    );
  return created;
}

async function upsertSafePolicy(tx: CoreTransaction, operatorId: string, at: Date) {
  const [existing] = await tx
    .select()
    .from(operatorAuthorityPolicies)
    .where(eq(operatorAuthorityPolicies.operatorId, operatorId))
    .orderBy(desc(operatorAuthorityPolicies.version))
    .limit(1);
  if (existing) return existing;
  const [created] = await tx
    .insert(operatorAuthorityPolicies)
    .values({
      operatorId,
      version: 1,
      observation: "always",
      preparation: "always",
      externalEffects: "approval_required",
      mailIncluded: false,
      confirmedAt: at,
      createdAt: at,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [afterConflict] = await tx
    .select()
    .from(operatorAuthorityPolicies)
    .where(eq(operatorAuthorityPolicies.operatorId, operatorId))
    .orderBy(desc(operatorAuthorityPolicies.version))
    .limit(1);
  if (!afterConflict)
    throw new FounderCoreOperationError(
      "policy_unavailable",
      "Safe Authority Policy could not be saved.",
      503,
    );
  return afterConflict;
}

async function ensureCoreBrief(
  tx: CoreTransaction,
  operation: typeof operatorLimitedOperations.$inferSelect,
  evidenceCount: number,
  at: Date,
) {
  if (operation.status !== "core") return;
  const [existing] = await tx
    .select()
    .from(operatorMorningBriefs)
    .where(
      and(
        eq(operatorMorningBriefs.operationId, operation.id),
        eq(operatorMorningBriefs.generation, 1),
      ),
    )
    .limit(1);
  if (existing) return;
  const quiet = evidenceCount === 0;
  const windowStartedAt = new Date(at.getTime() - 24 * 60 * 60 * 1000);
  const windowEndedAt = new Date(at.getTime() + 7 * 24 * 60 * 60 * 1000);
  const content = quiet
    ? "Nothing needs attention across your Calendar and selected Mail right now. This is a verified quiet brief."
    : "Your Primary Communications Suite is Current. Bruno found Calendar and Mail evidence and is ready to help prepare your day.";
  await tx
    .insert(operatorMorningBriefs)
    .values({
      operatorId: operation.operatorId,
      operationId: operation.id,
      generation: 1,
      status: "prepared",
      evidenceState: "current",
      quiet,
      attentionCount: evidenceCount,
      content,
      evidenceDigest: digest({
        operationId: operation.id,
        generation: 1,
        evidenceCount,
        at: at.toISOString(),
        purpose: CORE_PURPOSE,
      }),
      windowStartedAt,
      windowEndedAt,
      generatedAt: at,
      createdAt: at,
    })
    .onConflictDoNothing();
}

async function projectCoreOperation(
  tx: CoreTransaction,
  operation: typeof operatorLimitedOperations.$inferSelect,
  operatorId: string,
): Promise<FounderCoreOperationDto> {
  const [consent] = operation.processingConsentId
    ? await tx
        .select()
        .from(operatorProcessingConsents)
        .where(eq(operatorProcessingConsents.id, operation.processingConsentId))
        .limit(1)
    : [];
  const [policy] = operation.authorityPolicyId
    ? await tx
        .select()
        .from(operatorAuthorityPolicies)
        .where(eq(operatorAuthorityPolicies.id, operation.authorityPolicyId))
        .limit(1)
    : [];
  const [ai] = await tx
    .select()
    .from(operatorAiConnections)
    .where(eq(operatorAiConnections.id, operation.aiConnectionId))
    .limit(1);
  const [calendar] = await tx
    .select()
    .from(operatorCalendarConnections)
    .where(eq(operatorCalendarConnections.id, operation.calendarConnectionId))
    .limit(1);
  const [mail] = operation.mailConnectionId
    ? await tx
        .select()
        .from(operatorMailConnections)
        .where(eq(operatorMailConnections.id, operation.mailConnectionId))
        .limit(1)
    : [];
  const [suite] = operation.mailConnectionId
    ? await tx
        .select()
        .from(operatorPrimaryCommunicationsSuites)
        .where(
          and(
            eq(
              operatorPrimaryCommunicationsSuites.calendarConnectionId,
              operation.calendarConnectionId,
            ),
            eq(operatorPrimaryCommunicationsSuites.mailConnectionId, operation.mailConnectionId),
          ),
        )
        .limit(1)
    : [];
  const [brief] = await tx
    .select()
    .from(operatorMorningBriefs)
    .where(
      and(
        eq(operatorMorningBriefs.operationId, operation.id),
        eq(operatorMorningBriefs.generation, 1),
      ),
    )
    .limit(1);
  const [activation] = await tx
    .select()
    .from(operatorFounderActivations)
    .where(eq(operatorFounderActivations.operatorId, operatorId))
    .limit(1);
  return {
    name: "Core Operation",
    status:
      operation.status === "core"
        ? "core"
        : operation.status === "needs_attention"
          ? "needs_attention"
          : "awaiting_consent",
    mailIncluded: true,
    mailSendingRequired: false,
    suite: {
      status:
        suite?.status === "active" &&
        mail?.suiteStatus === "matched" &&
        mail.providerSubjectId === calendar?.providerSubjectId
          ? "active"
          : mail &&
              calendar &&
              (mail.suiteStatus === "mismatch" ||
                mail.providerSubjectId !== calendar.providerSubjectId)
            ? "mismatch"
            : "unavailable",
      providerSubjectId: suite?.providerSubjectId ?? calendar?.providerSubjectId ?? null,
    },
    access: {
      ai: ai?.status === "ready" ? "ready" : "unavailable",
      calendar: calendar?.status === "ready" ? "ready" : "unavailable",
      mail: mail?.status === "ready" ? "ready" : "unavailable",
      evidence:
        calendar?.evidenceState === "current" && mail?.evidenceState === "current"
          ? "current"
          : "unavailable",
    },
    consent: {
      status:
        operation.status === "core" &&
        consent?.status === "active" &&
        consent.purpose === CORE_PURPOSE
          ? "active"
          : "missing",
      purpose: CORE_PURPOSE,
      confirmedAt:
        operation.status === "core" && consent?.purpose === CORE_PURPOSE
          ? consent.confirmedAt.toISOString()
          : null,
    },
    authorityPolicy:
      operation.status === "core" &&
      policy &&
      policy.observation === "always" &&
      policy.preparation === "always" &&
      policy.externalEffects === "approval_required"
        ? {
            version: policy.version,
            observation: "always",
            preparation: "always",
            externalEffects: "approval_required",
            mailIncluded: false,
          }
        : null,
    brief:
      operation.status === "core" && brief
        ? {
            id: brief.id,
            generation: brief.generation,
            status: brief.status,
            evidenceState: brief.evidenceState === "current" ? "current" : "unavailable",
            quiet: brief.quiet,
            attentionCount: brief.attentionCount,
            content: brief.content,
            generatedAt: brief.generatedAt.toISOString(),
            openedAt: brief.openedAt?.toISOString() ?? null,
          }
        : null,
    actionPreview: await projectFounderActionPreview(tx, operatorId),
    activatedAt:
      operation.status === "core"
        ? (activation?.activatedAt.toISOString() ?? operation.activatedAt?.toISOString() ?? null)
        : null,
  };
}

async function lockOperator(tx: CoreTransaction, operatorId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:founder-operator:${operatorId}`}, 0))`,
  );
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function withConnection<T>(
  dependencies: FounderCoreOperationDependencies,
  callback: (connection: DatabaseConnection) => Promise<T>,
): Promise<T> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await callback(connection);
  } finally {
    if (ownsConnection) await connection.close();
  }
}
