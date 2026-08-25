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
  operatorMorningBriefs,
  operatorProcessingConsents,
  operatorProductGuardrails,
} from "@/src/server/db/schema";
import { FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS } from "@/src/server/founder-product-contract/preview-qualification";
import {
  type FounderOwnerPreviewWorkAuthorityDependencies,
  withFounderOwnerPreviewWorkAuthority,
} from "@/src/server/founder-product-contract/work-authority";
import {
  type FounderActionPreviewDto,
  projectFounderActionPreview,
} from "@/src/server/operators/founder-action-previews";
import { selectFounderAiProvider } from "@/src/server/operators/founder-ai-routing";
import {
  type FounderMorningBriefProjection,
  prepareFounderMorningBrief,
  projectFounderMorningBrief,
} from "@/src/server/operators/founder-morning-brief";
import {
  ensureFounderOperatorForUser,
  getFounderOperatorForUser,
} from "@/src/server/operators/founder-operator";
import type {
  FounderActionFamily,
  FounderAuthorityMode,
} from "@/src/server/operators/founder-proposed-actions";
import {
  type FounderProposedActionDto,
  projectFounderProposedAction,
} from "@/src/server/operators/founder-proposed-actions";
import type { FounderRecoveryDto } from "@/src/server/operators/founder-recovery";

type LimitedOperationTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

const CALENDAR_PURPOSE = "calendar_morning_brief" as const;

export type FounderLimitedOperationStatus = "awaiting_consent" | "limited" | "needs_attention";

export type FounderLimitedOperationDto = {
  name: "Calendar-only Limited Operation";
  status: FounderLimitedOperationStatus;
  mailIncluded: false;
  access: {
    ai: "ready" | "unavailable";
    calendar: "ready" | "unavailable";
    evidence: "current" | "unavailable";
  };
  consent: {
    status: "active" | "missing";
    purpose: typeof CALENDAR_PURPOSE;
    confirmedAt: string | null;
    version?: number;
  };
  authorityPolicy: {
    version: number;
    observation: "always";
    preparation: "always";
    externalEffects: "approval_required";
    mailIncluded: false;
    actionFamilies?: Record<FounderActionFamily, FounderAuthorityMode>;
    productGuardrails?: { version: number; blockedSubtypes: string[] };
  } | null;
  brief: {
    id: string;
    generation: number;
    status: "prepared" | "opened";
    evidenceState: "current" | "unavailable";
    recovery?: FounderRecoveryDto | null;
    quiet: boolean;
    attentionCount: number;
    content: string;
    generatedAt: string;
    openedAt: string | null;
    evidenceWatermark?: string;
    calendarWindow?: { startedAt: string; endedAt: string };
    mailWindow?: { startedAt: string; endedAt: string } | null;
    items?: FounderMorningBriefProjection["items"];
    delivery?: FounderMorningBriefProjection["delivery"];
  } | null;
  actionPreview?: FounderActionPreviewDto | null;
  proposedAction?: FounderProposedActionDto | null;
  activatedAt: string | null;
};

export type FounderLimitedOperationDependencies = FounderOwnerPreviewWorkAuthorityDependencies & {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
};

export class FounderLimitedOperationError extends Error {
  readonly code: string;
  readonly status: 400 | 409 | 503;

  constructor(code: string, message: string, status: 400 | 409 | 503 = 409) {
    super(message);
    this.name = "FounderLimitedOperationError";
    this.code = code;
    this.status = status;
  }
}

export async function getFounderLimitedOperationForUser(
  userId: string,
  dependencies: FounderLimitedOperationDependencies = {},
): Promise<FounderLimitedOperationDto | null> {
  const operator = await getFounderOperatorForUser(userId, dependencies);
  if (!operator) return null;
  return withConnection(dependencies, async (connection) => {
    return connection.db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(operatorLimitedOperations)
        .where(eq(operatorLimitedOperations.operatorId, operator.id))
        .limit(1);
      return operation && !operation.mailConnectionId
        ? projectOperation(tx, operation, operator.id)
        : null;
    });
  });
}

export async function confirmFounderProcessingConsentForUser(
  userId: string,
  dependencies: FounderLimitedOperationDependencies = {},
): Promise<FounderLimitedOperationDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const now = dependencies.now ?? (() => new Date());
  return withFounderOwnerPreviewWorkAuthority(
    {
      userId,
      now,
      requiredCapabilities: FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.calendarLimitedOperation,
    },
    dependencies,
    async (tx, at) => {
      await lockOperator(tx, operator.id);
      const pair = await readyConnectionPair(tx, operator.id, at);
      if (!pair) {
        throw new FounderLimitedOperationError(
          "connections_not_ready",
          "Bruno needs a Ready AI Connection and a Current Calendar Connection before you confirm Processing Consent.",
        );
      }
      const operation = await ensureOperation(tx, operator.id, at, pair);
      if (!operation) {
        throw new FounderLimitedOperationError(
          "limited_operation_unavailable",
          "Calendar-only Limited Operation could not be established.",
          503,
        );
      }
      if (
        operation.status === "needs_attention" &&
        (operation.aiConnectionId !== pair.ai.id ||
          operation.calendarConnectionId !== pair.calendar.id)
      ) {
        throw new FounderLimitedOperationError(
          "connection_replacement_requires_migration",
          "A different connected account cannot inherit this Limited Operation. Review the connection replacement before starting a new one.",
        );
      }

      const consent = await upsertConsent(tx, operator.id, pair.ai.id, pair.calendar.id, at);
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
            purpose: CALENDAR_PURPOSE,
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
            mailIncluded: policy.mailIncluded,
          }),
          createdAt: at,
        })
        .onConflictDoNothing();

      const [saved] = await tx
        .update(operatorLimitedOperations)
        .set({
          aiConnectionId: pair.ai.id,
          calendarConnectionId: pair.calendar.id,
          processingConsentId: consent.id,
          authorityPolicyId: policy.id,
          status: "limited",
          updatedAt: at,
        })
        .where(eq(operatorLimitedOperations.id, operation.id))
        .returning();
      if (!saved) {
        throw new FounderLimitedOperationError(
          "limited_operation_unavailable",
          "Limited Operation could not be saved.",
          503,
        );
      }
      await ensureFirstBrief(tx, saved, at);
      return projectOperation(tx, saved, operator.id);
    },
  );
}

/**
 * Reconcile the first brief after a live Calendar check. It is deliberately
 * idempotent: consent and operation state are never recreated by a retry.
 */
export async function reconcileFounderLimitedOperationForUser(
  userId: string,
  dependencies: FounderLimitedOperationDependencies = {},
): Promise<FounderLimitedOperationDto | null> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const now = dependencies.now ?? (() => new Date());
  return withFounderOwnerPreviewWorkAuthority(
    {
      userId,
      now,
      requiredCapabilities: FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.calendarLimitedOperation,
    },
    dependencies,
    async (tx, at) => {
      await lockOperator(tx, operator.id);
      const operation = await ensureOperation(tx, operator.id, at);
      if (operation?.mailConnectionId) return null;
      if (operation?.status !== "limited" || !operation.processingConsentId) {
        return operation ? projectOperation(tx, operation, operator.id) : null;
      }
      const [calendar] = await tx
        .select()
        .from(operatorCalendarConnections)
        .where(eq(operatorCalendarConnections.id, operation.calendarConnectionId))
        .limit(1);
      if (calendar?.status === "ready" && calendar.evidenceState === "current") {
        await ensureFirstBrief(tx, operation, at);
      }
      const [fresh] = await tx
        .select()
        .from(operatorLimitedOperations)
        .where(eq(operatorLimitedOperations.id, operation.id))
        .limit(1);
      return fresh ? projectOperation(tx, fresh, operator.id) : null;
    },
  );
}

export async function openFounderMorningBriefForUser(
  userId: string,
  dependencies: FounderLimitedOperationDependencies = {},
): Promise<FounderLimitedOperationDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const now = dependencies.now ?? (() => new Date());
  return withFounderOwnerPreviewWorkAuthority(
    {
      userId,
      now,
      requiredCapabilities: FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.calendarLimitedOperation,
    },
    dependencies,
    async (tx, at) => {
      await lockOperator(tx, operator.id);
      const operation = await ensureOperation(tx, operator.id, at);
      if (operation?.status !== "limited") {
        throw new FounderLimitedOperationError(
          "limited_operation_not_ready",
          "Confirm Processing Consent before opening the Founder Morning Brief.",
        );
      }
      await ensureFirstBrief(tx, operation, at);
      const [brief] = await tx
        .select()
        .from(operatorMorningBriefs)
        .where(and(eq(operatorMorningBriefs.operationId, operation.id)))
        .orderBy(desc(operatorMorningBriefs.generation))
        .limit(1);
      if (!brief) {
        throw new FounderLimitedOperationError(
          "first_brief_not_ready",
          "Bruno is waiting for a Current check of your selected Calendar.",
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
            evidenceState: brief.evidenceState,
            generation: brief.generation,
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
        throw new FounderLimitedOperationError(
          "limited_operation_unavailable",
          "Limited Operation could not be reloaded.",
          503,
        );
      return projectOperation(tx, fresh, operator.id);
    },
  );
}

async function ensureOperation(
  tx: LimitedOperationTransaction,
  operatorId: string,
  at: Date,
  pair?: Awaited<ReturnType<typeof readyConnectionPair>>,
) {
  const currentPair = pair ?? (await readyConnectionPair(tx, operatorId, at));
  const [existing] = await tx
    .select()
    .from(operatorLimitedOperations)
    .where(eq(operatorLimitedOperations.operatorId, operatorId))
    .limit(1);
  if (!currentPair) {
    if (existing && existing.status === "limited") {
      const [updated] = await tx
        .update(operatorLimitedOperations)
        .set({ status: "needs_attention", updatedAt: at })
        .where(eq(operatorLimitedOperations.id, existing.id))
        .returning();
      return updated ?? existing;
    }
    return existing;
  }
  if (existing) {
    if (
      existing.status === "limited" &&
      (existing.aiConnectionId !== currentPair.ai.id ||
        existing.calendarConnectionId !== currentPair.calendar.id)
    ) {
      const [needsAttention] = await tx
        .update(operatorLimitedOperations)
        .set({ status: "needs_attention", updatedAt: at })
        .where(eq(operatorLimitedOperations.id, existing.id))
        .returning();
      return needsAttention ?? existing;
    }
    if (
      existing.status === "awaiting_consent" &&
      (existing.aiConnectionId !== currentPair.ai.id ||
        existing.calendarConnectionId !== currentPair.calendar.id)
    ) {
      const [updated] = await tx
        .update(operatorLimitedOperations)
        .set({
          aiConnectionId: currentPair.ai.id,
          calendarConnectionId: currentPair.calendar.id,
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

async function readyConnectionPair(
  tx: LimitedOperationTransaction,
  operatorId: string,
  now = new Date(),
) {
  const aiConnections = await tx
    .select()
    .from(operatorAiConnections)
    .where(
      and(
        eq(operatorAiConnections.operatorId, operatorId),
        eq(operatorAiConnections.status, "ready"),
      ),
    )
    .orderBy(desc(operatorAiConnections.updatedAt));
  const aiDecision = selectFounderAiProvider(aiConnections, { now });
  const ai = aiDecision
    ? aiConnections.find((connection) => connection.id === aiDecision.connectionId)
    : undefined;
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
  return ai && calendar ? { ai, calendar } : null;
}

async function upsertConsent(
  tx: LimitedOperationTransaction,
  operatorId: string,
  aiConnectionId: string,
  calendarConnectionId: string,
  at: Date,
) {
  const [existing] = await tx
    .select()
    .from(operatorProcessingConsents)
    .where(
      and(
        eq(operatorProcessingConsents.operatorId, operatorId),
        eq(operatorProcessingConsents.aiConnectionId, aiConnectionId),
        eq(operatorProcessingConsents.calendarConnectionId, calendarConnectionId),
        eq(operatorProcessingConsents.purpose, CALENDAR_PURPOSE),
      ),
    )
    .orderBy(desc(operatorProcessingConsents.version))
    .limit(1);
  if (existing?.status === "active") return existing;
  const [created] = await tx
    .insert(operatorProcessingConsents)
    .values({
      operatorId,
      aiConnectionId,
      calendarConnectionId,
      version: (existing?.version ?? 0) + 1,
      status: "active",
      purpose: CALENDAR_PURPOSE,
      confirmedAt: at,
      createdAt: at,
    })
    .returning();
  if (!created)
    throw new FounderLimitedOperationError(
      "consent_unavailable",
      "Processing Consent could not be saved.",
      503,
    );
  return created;
}

async function upsertSafePolicy(tx: LimitedOperationTransaction, operatorId: string, at: Date) {
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
    throw new FounderLimitedOperationError(
      "policy_unavailable",
      "Safe Authority Policy could not be saved.",
      503,
    );
  return afterConflict;
}

async function ensureFirstBrief(
  tx: LimitedOperationTransaction,
  operation: typeof operatorLimitedOperations.$inferSelect,
  at: Date,
): Promise<void> {
  if (operation.status !== "limited") return;
  await prepareFounderMorningBrief(tx, {
    operatorId: operation.operatorId,
    operationId: operation.id,
    calendarConnectionId: operation.calendarConnectionId,
    mailConnectionId: null,
    now: at,
  });
}

async function projectOperation(
  tx: LimitedOperationTransaction,
  operation: typeof operatorLimitedOperations.$inferSelect,
  operatorId: string,
): Promise<FounderLimitedOperationDto> {
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
  const [guardrails] = await tx
    .select()
    .from(operatorProductGuardrails)
    .where(eq(operatorProductGuardrails.operatorId, operatorId))
    .orderBy(desc(operatorProductGuardrails.version))
    .limit(1);
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
  const [brief] = await tx
    .select()
    .from(operatorMorningBriefs)
    .where(and(eq(operatorMorningBriefs.operationId, operation.id)))
    .orderBy(desc(operatorMorningBriefs.generation))
    .limit(1);
  const [activation] = await tx
    .select()
    .from(operatorFounderActivations)
    .where(eq(operatorFounderActivations.operatorId, operatorId))
    .limit(1);
  const limited = operation.status === "limited";
  const projectedStatus: FounderLimitedOperationStatus =
    operation.status === "core" ? "needs_attention" : operation.status;
  const briefProjection = brief ? await projectFounderMorningBrief(tx, brief) : null;
  return {
    name: "Calendar-only Limited Operation",
    status: projectedStatus,
    mailIncluded: false,
    access: {
      ai: ai?.status === "ready" ? "ready" : "unavailable",
      calendar: calendar?.status === "ready" ? "ready" : "unavailable",
      evidence: calendar?.evidenceState === "current" ? "current" : "unavailable",
    },
    consent: {
      status: limited && consent?.status === "active" ? "active" : "missing",
      purpose: CALENDAR_PURPOSE,
      confirmedAt: limited ? (consent?.confirmedAt.toISOString() ?? null) : null,
      version: consent?.version ?? 1,
    },
    authorityPolicy:
      limited &&
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
            actionFamilies: policy.actionFamilies,
            productGuardrails: {
              version: guardrails?.version ?? 1,
              blockedSubtypes: guardrails?.blockedSubtypes ?? [],
            },
          }
        : null,
    brief: limited && briefProjection ? briefProjection : null,
    actionPreview: await projectFounderActionPreview(tx, operatorId),
    proposedAction: await projectFounderProposedAction(tx, operatorId),
    activatedAt: limited
      ? (activation?.activatedAt.toISOString() ?? operation.activatedAt?.toISOString() ?? null)
      : null,
  };
}

async function lockOperator(tx: LimitedOperationTransaction, operatorId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:founder-operator:${operatorId}`}, 0))`,
  );
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function withConnection<T>(
  dependencies: FounderLimitedOperationDependencies,
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
