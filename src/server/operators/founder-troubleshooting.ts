import "server-only";

import { createHash } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  operatorActionExecutionAttempts,
  operatorAiConnections,
  operatorCalendarConnections,
  operatorConversationWorks,
  operatorConversations,
  operatorMailConnections,
  operatorMailSendingConnections,
  operatorMorningBriefs,
  operatorProposedActions,
  operatorTroubleshootingEvidence,
  operatorTroubleshootingIncidents,
} from "@/src/server/db/schema";
import {
  deriveFounderConnectionRecovery,
  deriveFounderConversationRecovery,
  deriveFounderRecovery,
  FOUNDER_RECOVERY_CAPABILITIES,
  isFounderRecoveryCapability,
  type FounderRecoveryCapability,
  type FounderRecoveryDto,
} from "@/src/server/operators/founder-recovery";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";

type TroubleshootingTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

const EVIDENCE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const CASE_CLOSED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const CAPABILITY_LABELS: Readonly<Record<FounderRecoveryCapability, string>> = {
  ai: "AI responses",
  calendar: "Calendar evidence",
  mail: "Mail reading",
  mail_sending: "Mail Sending",
  brief: "Founder Morning Brief",
  conversation: "Bruno Conversation",
  external_effect: "approved external effects",
};

const SELF_SERVICE_ACTIONS: Readonly<
  Record<FounderRecoveryCapability, { label: string; href: string | null }>
> = {
  ai: { label: "Review AI access", href: "/operator#connections" },
  calendar: { label: "Review Calendar access", href: "/operator#calendar" },
  mail: { label: "Review Mail access", href: "/operator#mail" },
  mail_sending: { label: "Review Mail Sending", href: "/operator#mail-sending" },
  brief: { label: "Review connections", href: "/operator#connections" },
  conversation: { label: "Resume from checkpoint", href: null },
  external_effect: { label: "Review Action Inbox", href: "/operator#action-inbox" },
};

const BUSINESS_CAPABILITY_LABELS = new Set(Object.values(CAPABILITY_LABELS));
const SAFE_ACTION_LABELS = new Set(
  Object.values(SELF_SERVICE_ACTIONS).map((action) => action.label),
);

export type FounderTroubleshootingEvidencePayload = {
  capability: FounderRecoveryCapability;
  state: "recovery_exhausted";
  attemptCount: number;
  maxAttempts: number;
  elapsedMs: number;
  maxElapsedMs: number;
  affectedCapabilities?: string[];
  unaffectedCapabilities?: string[];
  safeAction?: string;
};

export type FounderTroubleshootingIncidentDto = {
  id: string;
  title: string;
  capability: FounderRecoveryCapability;
  impactSummary: string;
  affectedCapabilities: string[];
  unaffectedCapabilities: string[];
  status: "open" | "closed";
  openedAt: string;
  closedAt: string | null;
  evidenceExpiresAt: string | null;
  supportCase: "not_attached" | "open" | "closed";
  evidence: Array<{
    kind: "recovery_summary" | "capability_impact" | "safe_action";
    payload: FounderTroubleshootingEvidencePayload;
    capturedAt: string;
    expiresAt: string | null;
  }>;
};

export type FounderTroubleshootingHelpDto = {
  capability: FounderRecoveryCapability | null;
  state: FounderRecoveryDto["state"] | null;
  title: string;
  impact: string;
  action: { label: string; href: string | null } | null;
  technicalEvidenceAvailable: boolean;
  incidentId: string | null;
};

export type FounderTroubleshootingDto = {
  help: FounderTroubleshootingHelpDto;
  incidents: FounderTroubleshootingIncidentDto[];
};

export type FounderTroubleshootingDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
};

export class FounderTroubleshootingError extends Error {
  constructor(
    readonly code: "incident_not_found" | "not_exhausted" | "invalid_incident",
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "FounderTroubleshootingError";
  }
}

/**
 * Fresh sanitization is allowlist-based. Caller-provided provider text and
 * unknown keys are never copied into Troubleshooting Evidence.
 */
export function sanitizeTroubleshootingEvidence(input: {
  capability?: unknown;
  state?: unknown;
  attemptCount?: unknown;
  maxAttempts?: unknown;
  elapsedMs?: unknown;
  maxElapsedMs?: unknown;
  affectedCapabilities?: unknown;
  unaffectedCapabilities?: unknown;
  safeAction?: unknown;
}): FounderTroubleshootingEvidencePayload {
  const capability = isFounderRecoveryCapability(input.capability)
    ? input.capability
    : "conversation";
  const safeInteger = (value: unknown, fallback: number, maximum: number) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(maximum, Math.max(0, Math.trunc(value)));
  };
  const safeList = (value: unknown) =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => BUSINESS_CAPABILITY_LABELS.has(item))
          .slice(0, FOUNDER_RECOVERY_CAPABILITIES.length)
      : undefined;

  const affectedCapabilities = safeList(input.affectedCapabilities);
  const unaffectedCapabilities = safeList(input.unaffectedCapabilities);
  return {
    capability,
    state: "recovery_exhausted",
    attemptCount: safeInteger(input.attemptCount, 0, 1000),
    maxAttempts: safeInteger(input.maxAttempts, 1, 1000) || 1,
    elapsedMs: safeInteger(input.elapsedMs, 0, 365 * 24 * 60 * 60 * 1000),
    maxElapsedMs:
      safeInteger(input.maxElapsedMs, EVIDENCE_RETENTION_MS, 365 * 24 * 60 * 60 * 1000) || 1,
    ...(affectedCapabilities ? { affectedCapabilities } : {}),
    ...(unaffectedCapabilities ? { unaffectedCapabilities } : {}),
    ...(typeof input.safeAction === "string" && SAFE_ACTION_LABELS.has(input.safeAction.trim())
      ? { safeAction: input.safeAction.trim() }
      : {}),
  };
}

export function troubleshootingEvidenceDigest(payload: FounderTroubleshootingEvidencePayload) {
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

export function troubleshootingDeduplicationKey(recovery: FounderRecoveryDto): string {
  return createHash("sha256")
    .update(
      [
        recovery.capability,
        recovery.state,
        recovery.startedAt ?? "none",
        recovery.attemptCount,
        recovery.maxAttempts,
        recovery.maxElapsedMs,
      ].join(":"),
    )
    .digest("hex");
}

export async function getFounderTroubleshootingForUser(
  userId: string,
  capability: FounderRecoveryCapability | null = null,
  dependencies: FounderTroubleshootingDependencies = {},
): Promise<FounderTroubleshootingDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, async (connection) =>
    connection.db.transaction(async (tx) => {
      const now = dependencies.now?.() ?? new Date();
      const snapshots = await selectRecoverySnapshots(tx, operator.id, now);
      const incidents = [] as (typeof operatorTroubleshootingIncidents.$inferSelect)[];
      for (const snapshot of snapshots) {
        if (snapshot.recovery.state !== "recovery_exhausted") continue;
        incidents.push(await ensureIncidentInTransaction(tx, operator.id, snapshot, now));
      }
      const incidentRows = await tx
        .select()
        .from(operatorTroubleshootingIncidents)
        .where(eq(operatorTroubleshootingIncidents.operatorId, operator.id))
        .orderBy(desc(operatorTroubleshootingIncidents.openedAt));
      await purgeExpiredEvidenceInTransaction(tx, incidentRows, now);
      const rows = await tx
        .select()
        .from(operatorTroubleshootingIncidents)
        .where(eq(operatorTroubleshootingIncidents.operatorId, operator.id))
        .orderBy(desc(operatorTroubleshootingIncidents.openedAt));
      const selected =
        snapshots.find((snapshot) => snapshot.recovery.capability === capability) ??
        snapshots.find((snapshot) => snapshot.recovery.state === "recovery_exhausted") ??
        snapshots[0] ??
        null;
      const incident = selected
        ? rows.find(
            (row) => row.deduplicationKey === troubleshootingDeduplicationKey(selected.recovery),
          )
        : null;
      return {
        help: toHelpDto(selected?.recovery ?? null, incident?.id ?? null),
        incidents: await Promise.all(rows.map((row) => projectIncident(tx, row, now))),
      };
    }),
  );
}

export async function createFounderTroubleshootingIncidentForRecovery(
  userId: string,
  recovery: FounderRecoveryDto,
  dependencies: FounderTroubleshootingDependencies = {},
): Promise<FounderTroubleshootingIncidentDto> {
  if (recovery.state !== "recovery_exhausted") {
    throw new FounderTroubleshootingError(
      "not_exhausted",
      "Troubleshooting incidents open only after Recovery exhausted.",
    );
  }
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, (connection) =>
    connection.db.transaction(async (tx) => {
      const now = dependencies.now?.() ?? new Date();
      const row = await ensureIncidentInTransaction(
        tx,
        operator.id,
        {
          recovery,
          deduplicationKey: troubleshootingDeduplicationKey(recovery),
        },
        now,
      );
      return projectIncident(tx, row, now);
    }),
  );
}

export async function approveFounderTroubleshootingCaseForUser(
  userId: string,
  incidentId: string,
  dependencies: FounderTroubleshootingDependencies = {},
): Promise<FounderTroubleshootingIncidentDto> {
  return updateIncidentCase(userId, incidentId, "approve", dependencies);
}

export async function closeFounderTroubleshootingCaseForUser(
  userId: string,
  incidentId: string,
  dependencies: FounderTroubleshootingDependencies = {},
): Promise<FounderTroubleshootingIncidentDto> {
  return updateIncidentCase(userId, incidentId, "close", dependencies);
}

type RecoverySnapshot = {
  recovery: FounderRecoveryDto;
  deduplicationKey: string;
};

async function selectRecoverySnapshots(
  tx: TroubleshootingTransaction,
  operatorId: string,
  now: Date,
): Promise<RecoverySnapshot[]> {
  const snapshots: RecoverySnapshot[] = [];
  const [ai, calendar, mail, mailSending, brief, conversation, action] = await Promise.all([
    tx
      .select()
      .from(operatorAiConnections)
      .where(eq(operatorAiConnections.operatorId, operatorId))
      .orderBy(desc(operatorAiConnections.updatedAt))
      .limit(1),
    tx
      .select()
      .from(operatorCalendarConnections)
      .where(eq(operatorCalendarConnections.operatorId, operatorId))
      .orderBy(desc(operatorCalendarConnections.updatedAt))
      .limit(1),
    tx
      .select()
      .from(operatorMailConnections)
      .where(eq(operatorMailConnections.operatorId, operatorId))
      .orderBy(desc(operatorMailConnections.updatedAt))
      .limit(1),
    tx
      .select()
      .from(operatorMailSendingConnections)
      .where(eq(operatorMailSendingConnections.operatorId, operatorId))
      .orderBy(desc(operatorMailSendingConnections.updatedAt))
      .limit(1),
    tx
      .select()
      .from(operatorMorningBriefs)
      .where(eq(operatorMorningBriefs.operatorId, operatorId))
      .orderBy(desc(operatorMorningBriefs.generatedAt), desc(operatorMorningBriefs.id))
      .limit(1),
    tx
      .select()
      .from(operatorConversations)
      .where(eq(operatorConversations.operatorId, operatorId))
      .limit(1),
    tx
      .select()
      .from(operatorProposedActions)
      .where(eq(operatorProposedActions.operatorId, operatorId))
      .orderBy(desc(operatorProposedActions.updatedAt), desc(operatorProposedActions.id))
      .limit(1),
  ]);

  const [aiRow] = ai;
  if (aiRow) {
    const recovery = deriveFounderConnectionRecovery({
      capability: "ai",
      status: aiRow.status,
      failureCode: aiRow.failureCode,
      recoveryMessage: aiRow.recoveryMessage,
      createdAt: aiRow.createdAt,
      updatedAt: aiRow.updatedAt,
      now,
      attemptCount: aiRow.authorizationGeneration,
    });
    if (recovery)
      snapshots.push({ recovery, deduplicationKey: troubleshootingDeduplicationKey(recovery) });
  }
  const [calendarRow] = calendar;
  if (calendarRow) {
    const recovery = deriveFounderConnectionRecovery({
      capability: "calendar",
      status: calendarRow.status,
      evidenceState: calendarRow.evidenceState,
      failureCode: calendarRow.failureCode,
      recoveryMessage: calendarRow.recoveryMessage,
      createdAt: calendarRow.createdAt,
      updatedAt: calendarRow.updatedAt,
      now,
      attemptCount: calendarRow.authorizationGeneration,
    });
    if (recovery)
      snapshots.push({ recovery, deduplicationKey: troubleshootingDeduplicationKey(recovery) });
  }
  const [mailRow] = mail;
  if (mailRow) {
    const recovery = deriveFounderConnectionRecovery({
      capability: "mail",
      status: mailRow.status,
      evidenceState: mailRow.evidenceState,
      failureCode: mailRow.failureCode,
      recoveryMessage: mailRow.recoveryMessage,
      createdAt: mailRow.createdAt,
      updatedAt: mailRow.updatedAt,
      now,
      attemptCount: mailRow.authorizationGeneration,
    });
    if (recovery)
      snapshots.push({ recovery, deduplicationKey: troubleshootingDeduplicationKey(recovery) });
  }
  const [sendingRow] = mailSending;
  if (sendingRow) {
    const recovery = deriveFounderConnectionRecovery({
      capability: "mail_sending",
      status: sendingRow.status,
      failureCode: sendingRow.failureCode,
      recoveryMessage: sendingRow.recoveryMessage,
      createdAt: sendingRow.createdAt,
      updatedAt: sendingRow.updatedAt,
      now,
      attemptCount: sendingRow.authorizationGeneration,
    });
    if (recovery)
      snapshots.push({ recovery, deduplicationKey: troubleshootingDeduplicationKey(recovery) });
  }
  const [briefRow] = brief;
  if (briefRow) {
    const recovery = deriveFounderRecovery({
      capability: "brief",
      now: now,
      startedAt: briefRow.createdAt,
      attemptCount: 1,
      durableFailure: briefRow.evidenceState !== "current",
      waitingOnProvider: briefRow.evidenceState !== "current",
    });
    if (recovery)
      snapshots.push({ recovery, deduplicationKey: troubleshootingDeduplicationKey(recovery) });
  }
  const [conversationRow] = conversation;
  if (conversationRow) {
    const [work] = await tx
      .select()
      .from(operatorConversationWorks)
      .where(eq(operatorConversationWorks.conversationId, conversationRow.id))
      .orderBy(desc(operatorConversationWorks.updatedAt), desc(operatorConversationWorks.id))
      .limit(1);
    if (work) {
      const recovery = deriveFounderConversationRecovery({
        state: work.state,
        externalEffectStarted: work.externalEffectStarted,
        startedAt: work.createdAt,
        attemptCount: work.providerAttempts.length,
        recoveryMessage: work.recoveryMessage,
        now,
      });
      if (recovery)
        snapshots.push({ recovery, deduplicationKey: troubleshootingDeduplicationKey(recovery) });
    }
  }
  const [actionRow] = action;
  if (actionRow) {
    const attempts = await tx
      .select()
      .from(operatorActionExecutionAttempts)
      .where(eq(operatorActionExecutionAttempts.proposedActionId, actionRow.id))
      .orderBy(desc(operatorActionExecutionAttempts.createdAt));
    const latestAttempt = attempts[0];
    const recovery = deriveFounderRecovery({
      capability: "external_effect",
      now,
      startedAt: latestAttempt?.createdAt ?? actionRow.createdAt,
      attemptCount: Math.max(attempts.length, latestAttempt?.attemptNumber ?? 0),
      durableFailure: ["executing", "failed", "outcome_uncertain", "blocked"].includes(
        actionRow.state,
      ),
      waitingOnProvider: actionRow.state === "executing",
      outcomeUncertain:
        actionRow.state === "outcome_uncertain" || latestAttempt?.phase === "ambiguous",
      needsFounder: actionRow.state === "failed" || actionRow.state === "blocked",
      safeToRetry: false,
    });
    if (recovery)
      snapshots.push({ recovery, deduplicationKey: troubleshootingDeduplicationKey(recovery) });
  }
  return snapshots;
}

async function ensureIncidentInTransaction(
  tx: TroubleshootingTransaction,
  operatorId: string,
  snapshot: RecoverySnapshot,
  now: Date,
) {
  const [existing] = await tx
    .select()
    .from(operatorTroubleshootingIncidents)
    .where(
      and(
        eq(operatorTroubleshootingIncidents.operatorId, operatorId),
        eq(operatorTroubleshootingIncidents.deduplicationKey, snapshot.deduplicationKey),
      ),
    )
    .limit(1);
  if (existing) return existing;

  if (snapshot.recovery.state !== "recovery_exhausted") {
    throw new FounderTroubleshootingError(
      "not_exhausted",
      "Troubleshooting incidents open only after Recovery exhausted.",
    );
  }
  const affected = [CAPABILITY_LABELS[snapshot.recovery.capability]];
  const unaffected = FOUNDER_RECOVERY_CAPABILITIES.filter(
    (capability) => capability !== snapshot.recovery.capability,
  ).map((capability) => CAPABILITY_LABELS[capability]);
  const impactSummary = `${CAPABILITY_LABELS[snapshot.recovery.capability]} is paused after Bruno reached its safe recovery limit. Other listed capabilities remain separately available unless their own status says otherwise.`;
  const [incident] = await tx
    .insert(operatorTroubleshootingIncidents)
    .values({
      operatorId,
      recoveryCapability: snapshot.recovery.capability,
      recoveryState: "recovery_exhausted",
      attemptCount: snapshot.recovery.attemptCount,
      maxAttempts: snapshot.recovery.maxAttempts,
      elapsedMs: snapshot.recovery.elapsedMs,
      maxElapsedMs: snapshot.recovery.maxElapsedMs,
      impactSummary,
      affectedCapabilities: affected,
      unaffectedCapabilities: unaffected,
      deduplicationKey: snapshot.deduplicationKey,
      openedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  const created =
    incident ??
    (
      await tx
        .select()
        .from(operatorTroubleshootingIncidents)
        .where(
          and(
            eq(operatorTroubleshootingIncidents.operatorId, operatorId),
            eq(operatorTroubleshootingIncidents.deduplicationKey, snapshot.deduplicationKey),
          ),
        )
        .limit(1)
    )[0];
  if (!created)
    throw new FounderTroubleshootingError("invalid_incident", "Incident could not be opened.", 503);

  const payloads = [
    sanitizeTroubleshootingEvidence(snapshot.recovery),
    sanitizeTroubleshootingEvidence({
      ...snapshot.recovery,
      affectedCapabilities: affected,
      unaffectedCapabilities: unaffected,
    }),
    sanitizeTroubleshootingEvidence({
      ...snapshot.recovery,
      safeAction: SELF_SERVICE_ACTIONS[snapshot.recovery.capability].label,
    }),
  ] as const;
  const kinds = ["recovery_summary", "capability_impact", "safe_action"] as const;
  await tx
    .insert(operatorTroubleshootingEvidence)
    .values(
      payloads.map((payload, index) => ({
        incidentId: created.id,
        kind: kinds[index] ?? "safe_action",
        payload,
        evidenceDigest: troubleshootingEvidenceDigest(payload),
        capturedAt: now,
        expiresAt: new Date(now.getTime() + EVIDENCE_RETENTION_MS),
        createdAt: now,
      })),
    )
    .onConflictDoNothing();
  return created;
}

async function projectIncident(
  tx: TroubleshootingTransaction,
  incident: typeof operatorTroubleshootingIncidents.$inferSelect,
  now: Date,
): Promise<FounderTroubleshootingIncidentDto> {
  const evidence = await tx
    .select()
    .from(operatorTroubleshootingEvidence)
    .where(
      and(
        eq(operatorTroubleshootingEvidence.incidentId, incident.id),
        or(
          isNull(operatorTroubleshootingEvidence.expiresAt),
          gt(operatorTroubleshootingEvidence.expiresAt, now),
        ),
      ),
    )
    .orderBy(operatorTroubleshootingEvidence.createdAt);
  const supportCase = incident.supportCaseClosedAt
    ? "closed"
    : incident.supportCaseApprovedAt
      ? "open"
      : "not_attached";
  const evidenceExpiresAt = evidence.reduce<Date | null>((latest, item) => {
    if (!item.expiresAt) return latest;
    if (!latest || item.expiresAt > latest) return item.expiresAt;
    return latest;
  }, null);
  return {
    id: incident.id,
    title: `${CAPABILITY_LABELS[incident.recoveryCapability as FounderRecoveryCapability]} troubleshooting`,
    capability: incident.recoveryCapability as FounderRecoveryCapability,
    impactSummary: incident.impactSummary,
    affectedCapabilities: incident.affectedCapabilities,
    unaffectedCapabilities: incident.unaffectedCapabilities,
    status: incident.status,
    openedAt: incident.openedAt.toISOString(),
    closedAt: incident.closedAt?.toISOString() ?? null,
    evidenceExpiresAt: evidenceExpiresAt?.toISOString() ?? null,
    supportCase,
    evidence: evidence.map((item) => ({
      kind: item.kind,
      payload: sanitizeTroubleshootingEvidence(
        item.payload as {
          capability?: unknown;
          state?: unknown;
          attemptCount?: unknown;
          maxAttempts?: unknown;
          elapsedMs?: unknown;
          maxElapsedMs?: unknown;
          affectedCapabilities?: unknown;
          unaffectedCapabilities?: unknown;
          safeAction?: unknown;
        },
      ),
      capturedAt: item.capturedAt.toISOString(),
      expiresAt: item.expiresAt?.toISOString() ?? null,
    })),
  };
}

async function updateIncidentCase(
  userId: string,
  incidentId: string,
  action: "approve" | "close",
  dependencies: FounderTroubleshootingDependencies,
) {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, (connection) =>
    connection.db.transaction(async (tx) => {
      const now = dependencies.now?.() ?? new Date();
      const [incident] = await tx
        .select()
        .from(operatorTroubleshootingIncidents)
        .where(
          and(
            eq(operatorTroubleshootingIncidents.id, incidentId),
            eq(operatorTroubleshootingIncidents.operatorId, operator.id),
          ),
        )
        .limit(1)
        .for("update");
      if (!incident)
        throw new FounderTroubleshootingError("incident_not_found", "Incident not found.", 404);
      if (action === "approve") {
        await tx
          .update(operatorTroubleshootingIncidents)
          .set({ supportCaseApprovedAt: incident.supportCaseApprovedAt ?? now, updatedAt: now })
          .where(eq(operatorTroubleshootingIncidents.id, incident.id));
        await tx
          .update(operatorTroubleshootingEvidence)
          .set({ expiresAt: null })
          .where(eq(operatorTroubleshootingEvidence.incidentId, incident.id));
      } else {
        const closedAt = incident.supportCaseApprovedAt
          ? new Date(now.getTime() + CASE_CLOSED_RETENTION_MS)
          : null;
        await tx
          .update(operatorTroubleshootingIncidents)
          .set({
            status: "closed",
            closedAt: now,
            supportCaseClosedAt: incident.supportCaseApprovedAt ? now : null,
            updatedAt: now,
          })
          .where(eq(operatorTroubleshootingIncidents.id, incident.id));
        if (closedAt) {
          await tx
            .update(operatorTroubleshootingEvidence)
            .set({ expiresAt: closedAt })
            .where(eq(operatorTroubleshootingEvidence.incidentId, incident.id));
        }
      }
      const [updated] = await tx
        .select()
        .from(operatorTroubleshootingIncidents)
        .where(eq(operatorTroubleshootingIncidents.id, incident.id))
        .limit(1);
      if (!updated)
        throw new FounderTroubleshootingError(
          "invalid_incident",
          "Incident could not be updated.",
          503,
        );
      return projectIncident(tx, updated, now);
    }),
  );
}

async function purgeExpiredEvidenceInTransaction(
  tx: TroubleshootingTransaction,
  incidents: Array<typeof operatorTroubleshootingIncidents.$inferSelect>,
  now: Date,
) {
  if (incidents.length === 0) return;
  await tx.delete(operatorTroubleshootingEvidence).where(
    and(
      inArray(
        operatorTroubleshootingEvidence.incidentId,
        incidents.map((incident) => incident.id),
      ),
      lt(operatorTroubleshootingEvidence.expiresAt, now),
    ),
  );
}

function toHelpDto(
  recovery: FounderRecoveryDto | null,
  incidentId: string | null,
): FounderTroubleshootingHelpDto {
  const capability = recovery?.capability ?? null;
  if (!recovery || !capability) {
    return {
      capability: null,
      state: null,
      title: "Help with Bruno",
      impact: "No capability currently needs troubleshooting.",
      action: null,
      technicalEvidenceAvailable: false,
      incidentId: null,
    };
  }
  const label = CAPABILITY_LABELS[capability];
  const exhausted = recovery.state === "recovery_exhausted";
  return {
    capability,
    state: recovery.state,
    title: exhausted ? `${label} needs troubleshooting` : `Help with ${label}`,
    impact: exhausted
      ? `${label} is paused after Bruno reached its safe recovery limit.`
      : `${label} may be delayed or unavailable while Bruno works through a safe recovery step.`,
    action: SELF_SERVICE_ACTIONS[capability],
    technicalEvidenceAvailable: exhausted,
    incidentId: exhausted ? incidentId : null,
  };
}

async function withConnection<T>(
  dependencies: FounderTroubleshootingDependencies,
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
