import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  operatorCalendarConnections,
  operatorMailConnections,
  operatorMorningBriefItems,
  operatorMorningBriefPreferences,
  operatorMorningBriefs,
  operatorPreparations,
  operatorProposedActions,
  operatorRelationshipEvidence,
  operatorRelationshipRecords,
} from "@/src/server/db/schema";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";

type MorningBriefTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type FounderMorningBriefAttentionKind =
  | "unanswered_inbound"
  | "external_meeting"
  | "overdue_relationship_work"
  | "proposed_action";

export type FounderMorningBriefItemDto = {
  id: string;
  kind: FounderMorningBriefAttentionKind;
  sourceId: string;
  title: string;
  detail: string;
  priority: number;
};

export type FounderMorningBriefDeliveryDto = {
  localTime: string;
  nextDeliveryAt: string | null;
  timezone: string | null;
};

export type FounderMorningBriefProjection = {
  id: string;
  generation: number;
  status: "prepared" | "opened";
  evidenceState: "current" | "unavailable";
  quiet: boolean;
  attentionCount: number;
  content: string;
  evidenceWatermark: string;
  generatedAt: string;
  openedAt: string | null;
  calendarWindow: { startedAt: string; endedAt: string };
  mailWindow: { startedAt: string; endedAt: string } | null;
  items: FounderMorningBriefItemDto[];
  delivery: FounderMorningBriefDeliveryDto | null;
};

export type FounderMorningBriefPreferencesDto = FounderMorningBriefDeliveryDto & {
  operatorId: string;
};

export type PrepareFounderMorningBriefInput = {
  operatorId: string;
  operationId: string;
  calendarConnectionId: string;
  mailConnectionId: string | null;
  now: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export async function prepareFounderMorningBrief(
  tx: MorningBriefTransaction,
  input: PrepareFounderMorningBriefInput,
): Promise<typeof operatorMorningBriefs.$inferSelect | null> {
  const calendarStartedAt = new Date(input.now.getTime() - DAY_MS);
  const calendarEndedAt = new Date(input.now.getTime() + 7 * DAY_MS);
  const mailStartedAt = new Date(input.now.getTime() - 14 * DAY_MS);
  const mailEndedAt = input.now;
  const [calendar] = await tx
    .select()
    .from(operatorCalendarConnections)
    .where(eq(operatorCalendarConnections.id, input.calendarConnectionId))
    .limit(1);
  const [mail] = input.mailConnectionId
    ? await tx
        .select()
        .from(operatorMailConnections)
        .where(eq(operatorMailConnections.id, input.mailConnectionId))
        .limit(1)
    : [];
  if (!calendar) return null;

  const calendarCurrent = calendar.status === "ready" && calendar.evidenceState === "current";
  const mailCurrent = input.mailConnectionId
    ? mail?.status === "ready" && mail.evidenceState === "current"
    : true;
  const evidenceState = calendarCurrent && mailCurrent ? "current" : "unavailable";

  const calendarEvidenceRows = await tx
    .select()
    .from(operatorRelationshipEvidence)
    .where(
      and(
        eq(operatorRelationshipEvidence.operatorId, input.operatorId),
        eq(operatorRelationshipEvidence.sourceKind, "calendar"),
        eq(operatorRelationshipEvidence.calendarConnectionId, input.calendarConnectionId),
      ),
    )
    .orderBy(asc(operatorRelationshipEvidence.observedAt), asc(operatorRelationshipEvidence.id));
  const calendarEvidence = calendarEvidenceRows.filter((evidence) =>
    isWithinSourceWindow(evidence, calendarStartedAt, calendarEndedAt, "calendar"),
  );
  const mailEvidenceRows = input.mailConnectionId
    ? await tx
        .select()
        .from(operatorRelationshipEvidence)
        .where(
          and(
            eq(operatorRelationshipEvidence.operatorId, input.operatorId),
            eq(operatorRelationshipEvidence.sourceKind, "mail"),
            eq(operatorRelationshipEvidence.mailConnectionId, input.mailConnectionId),
          ),
        )
        .orderBy(asc(operatorRelationshipEvidence.observedAt), asc(operatorRelationshipEvidence.id))
    : [];
  const mailEvidence = mailEvidenceRows.filter((evidence) =>
    isWithinSourceWindow(evidence, mailStartedAt, mailEndedAt, "mail"),
  );
  const records = await tx
    .select()
    .from(operatorRelationshipRecords)
    .where(
      and(
        eq(operatorRelationshipRecords.operatorId, input.operatorId),
        eq(operatorRelationshipRecords.status, "active"),
      ),
    );
  const actions = await tx
    .select()
    .from(operatorProposedActions)
    .where(
      and(
        eq(operatorProposedActions.operatorId, input.operatorId),
        eq(operatorProposedActions.state, "awaiting_approval"),
      ),
    )
    .orderBy(desc(operatorProposedActions.createdAt), desc(operatorProposedActions.version));

  const items = buildAttentionItems({
    calendarEvidence,
    mailEvidence,
    records,
    actions,
    now: input.now,
  });
  const evidenceWatermark = digest({
    calendar: {
      id: calendar.id,
      status: calendar.status,
      evidenceState: calendar.evidenceState,
    },
    mail: mail
      ? {
          id: mail.id,
          status: mail.status,
          evidenceState: mail.evidenceState,
        }
      : null,
    calendarEvidence,
    mailEvidence,
    records,
    actions,
  });
  const [preparation] = await tx
    .select()
    .from(operatorPreparations)
    .where(eq(operatorPreparations.operatorId, input.operatorId))
    .limit(1);
  const [preference] = await tx
    .select()
    .from(operatorMorningBriefPreferences)
    .where(eq(operatorMorningBriefPreferences.operatorId, input.operatorId))
    .limit(1);
  const deliveryLocalTime = preference?.deliveryLocalTime ?? "07:00";
  const nextDeliveryAt = nextMorningBriefDeliveryAt(
    input.now,
    preparation?.timezone ?? "UTC",
    deliveryLocalTime,
  );
  const deliveryDue =
    !preference?.nextDeliveryAt || input.now >= preference.nextDeliveryAt;
  const [latest] = await tx
    .select()
    .from(operatorMorningBriefs)
    .where(eq(operatorMorningBriefs.operationId, input.operationId))
    .orderBy(desc(operatorMorningBriefs.generation))
    .limit(1);
  if (latest && latest.evidenceWatermark === evidenceWatermark && !deliveryDue) return latest;

  const generation = (latest?.generation ?? 0) + 1;
  const attentionCount = items.length;
  const quiet = evidenceState === "current" && attentionCount === 0;
  const content = quiet
    ? "Nothing needs attention right now. This is a verified quiet brief."
    : evidenceState !== "current"
      ? "Some selected evidence is unavailable or stale. Bruno will disclose what could not be checked."
      : `Bruno found ${attentionCount} attention item${attentionCount === 1 ? "" : "s"} in the selected evidence.`;
  const [brief] = await tx
    .insert(operatorMorningBriefs)
    .values({
      operatorId: input.operatorId,
      operationId: input.operationId,
      generation,
      status: "prepared",
      evidenceState,
      quiet,
      attentionCount,
      content,
      evidenceDigest: evidenceWatermark,
      evidenceWatermark,
      windowStartedAt: calendarStartedAt,
      windowEndedAt: calendarEndedAt,
      calendarWindowStartedAt: calendarStartedAt,
      calendarWindowEndedAt: calendarEndedAt,
      mailWindowStartedAt: input.mailConnectionId ? mailStartedAt : null,
      mailWindowEndedAt: input.mailConnectionId ? mailEndedAt : null,
      generatedAt: input.now,
      createdAt: input.now,
    })
    .returning();
  if (!brief) return latest ?? null;
  if (deliveryDue) {
    if (preference) {
      await tx
        .update(operatorMorningBriefPreferences)
        .set({ nextDeliveryAt, updatedAt: input.now })
        .where(eq(operatorMorningBriefPreferences.id, preference.id));
    } else {
      await tx
        .insert(operatorMorningBriefPreferences)
        .values({
          operatorId: input.operatorId,
          deliveryLocalTime,
          nextDeliveryAt,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing({ target: operatorMorningBriefPreferences.operatorId });
    }
  }
  if (items.length > 0) {
    await tx.insert(operatorMorningBriefItems).values(
      items.map((item) => ({
        briefId: brief.id,
        operatorId: input.operatorId,
        kind: item.kind,
        sourceId: item.sourceId,
        title: item.title,
        detail: item.detail,
        priority: item.priority,
        sourceWatermark: evidenceWatermark,
        createdAt: input.now,
      })),
    );
  }
  return brief;
}

export async function projectFounderMorningBrief(
  tx: MorningBriefTransaction,
  brief: typeof operatorMorningBriefs.$inferSelect,
  timezone: string | null = null,
): Promise<FounderMorningBriefProjection> {
  const items = await tx
    .select()
    .from(operatorMorningBriefItems)
    .where(eq(operatorMorningBriefItems.briefId, brief.id))
    .orderBy(desc(operatorMorningBriefItems.priority), asc(operatorMorningBriefItems.id));
  const [preference] = await tx
    .select()
    .from(operatorMorningBriefPreferences)
    .where(eq(operatorMorningBriefPreferences.operatorId, brief.operatorId))
    .limit(1);
  return {
    id: brief.id,
    generation: brief.generation,
    status: brief.status,
    evidenceState: brief.evidenceState === "current" ? "current" : "unavailable",
    quiet: brief.quiet,
    attentionCount: brief.attentionCount,
    content: brief.content,
    evidenceWatermark: brief.evidenceWatermark,
    generatedAt: brief.generatedAt.toISOString(),
    openedAt: brief.openedAt?.toISOString() ?? null,
    calendarWindow: {
      startedAt: (brief.calendarWindowStartedAt ?? brief.windowStartedAt).toISOString(),
      endedAt: (brief.calendarWindowEndedAt ?? brief.windowEndedAt).toISOString(),
    },
    mailWindow:
      brief.mailWindowStartedAt && brief.mailWindowEndedAt
        ? {
            startedAt: brief.mailWindowStartedAt.toISOString(),
            endedAt: brief.mailWindowEndedAt.toISOString(),
          }
        : null,
    items: items.map((item) => ({
      id: item.id,
      kind: item.kind,
      sourceId: item.sourceId,
      title: item.title,
      detail: item.detail,
      priority: item.priority,
    })),
    delivery: preference
      ? {
          localTime: preference.deliveryLocalTime,
          nextDeliveryAt: preference.nextDeliveryAt?.toISOString() ?? null,
          timezone,
        }
      : null,
  };
}

export async function getFounderMorningBriefPreferencesForUser(
  userId: string,
  dependencies: { createConnection?: () => DatabaseConnection; now?: () => Date } = {},
): Promise<FounderMorningBriefPreferencesDto | null> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, async (connection) =>
    connection.db.transaction(async (tx) => {
      const [preparation] = await tx
        .select()
        .from(operatorPreparations)
        .where(eq(operatorPreparations.operatorId, operator.id))
        .limit(1);
      const [preference] = await tx
        .select()
        .from(operatorMorningBriefPreferences)
        .where(eq(operatorMorningBriefPreferences.operatorId, operator.id))
        .limit(1);
      const now = dependencies.now?.() ?? new Date();
      const deliveryLocalTime = preference?.deliveryLocalTime ?? "07:00";
      const nextDeliveryAt = nextMorningBriefDeliveryAt(
        now,
        preparation?.timezone ?? "UTC",
        deliveryLocalTime,
      );
      if (preference && preference.nextDeliveryAt?.getTime() !== nextDeliveryAt.getTime()) {
        await tx
          .update(operatorMorningBriefPreferences)
          .set({ nextDeliveryAt, updatedAt: now })
          .where(eq(operatorMorningBriefPreferences.id, preference.id));
      } else if (!preference) {
        await tx
          .insert(operatorMorningBriefPreferences)
          .values({
            operatorId: operator.id,
            deliveryLocalTime,
            nextDeliveryAt,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: operatorMorningBriefPreferences.operatorId });
      }
      return {
        operatorId: operator.id,
        localTime: deliveryLocalTime,
        nextDeliveryAt: nextDeliveryAt.toISOString(),
        timezone: preparation?.timezone ?? null,
      };
    }),
  );
}

export async function updateFounderMorningBriefPreferencesForUser(
  userId: string,
  deliveryLocalTime: string,
  dependencies: { createConnection?: () => DatabaseConnection; now?: () => Date } = {},
): Promise<FounderMorningBriefPreferencesDto> {
  if (!/^\d{2}:\d{2}$/.test(deliveryLocalTime)) throw new Error("Delivery time must use HH:mm.");
  const [hours = 0, minutes = 0] = deliveryLocalTime.split(":").map(Number);
  if (hours > 23 || minutes > 59) throw new Error("Delivery time must use a valid 24-hour time.");
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, async (connection) =>
    connection.db.transaction(async (tx) => {
      const [preparation] = await tx
        .select()
        .from(operatorPreparations)
        .where(eq(operatorPreparations.operatorId, operator.id))
        .limit(1);
      const now = dependencies.now?.() ?? new Date();
      const timezone = preparation?.timezone ?? "UTC";
      const nextDeliveryAt = nextMorningBriefDeliveryAt(now, timezone, deliveryLocalTime);
      const [saved] = await tx
        .insert(operatorMorningBriefPreferences)
        .values({
          operatorId: operator.id,
          deliveryLocalTime,
          nextDeliveryAt,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: operatorMorningBriefPreferences.operatorId,
          set: { deliveryLocalTime, nextDeliveryAt, updatedAt: now },
        })
        .returning();
      return {
        operatorId: operator.id,
        localTime: saved?.deliveryLocalTime ?? deliveryLocalTime,
        nextDeliveryAt: (saved?.nextDeliveryAt ?? nextDeliveryAt).toISOString(),
        timezone: preparation?.timezone ?? null,
      };
    }),
  );
}

export function nextMorningBriefDeliveryAt(now: Date, timezone: string, localTime: string): Date {
  const [hours = 0, minutes = 0] = localTime.split(":").map(Number);
  const current = zonedParts(now, timezone);
  const currentMinutes = current.hour * 60 + current.minute;
  let date = { year: current.year, month: current.month, day: current.day };
  if (currentMinutes >= hours * 60 + minutes) date = addLocalDays(date, 1);
  return localToUtc({ ...date, hour: hours, minute: minutes }, timezone);
}

export function buildAttentionItems(input: {
  calendarEvidence: Array<typeof operatorRelationshipEvidence.$inferSelect>;
  mailEvidence: Array<typeof operatorRelationshipEvidence.$inferSelect>;
  records: Array<typeof operatorRelationshipRecords.$inferSelect>;
  actions: Array<typeof operatorProposedActions.$inferSelect>;
  now: Date;
}): Array<Omit<FounderMorningBriefItemDto, "id">> {
  const items: Array<Omit<FounderMorningBriefItemDto, "id">> = [];
  const threads = new Map<string, (typeof input.mailEvidence)[number]>();
  for (const evidence of input.mailEvidence) {
    const metadata = evidence.sourceMetadata;
    const threadId =
      typeof metadata.threadId === "string" ? metadata.threadId : evidence.providerItemId;
    const existing = threads.get(threadId);
    const existingAt = existing ? messageTime(existing) : 0;
    if (!existing || messageTime(evidence) >= existingAt) threads.set(threadId, evidence);
  }
  for (const evidence of threads.values()) {
    if (evidence.sourceMetadata.direction !== "inbound") continue;
    items.push({
      kind: "unanswered_inbound",
      sourceId: (evidence.sourceMetadata.threadId as string) ?? evidence.providerItemId,
      title: `Reply to ${evidence.displayName ?? evidence.email ?? "an inbound message"}`,
      detail:
        evidence.excerpt ?? "An inbound message has no later outbound message in this thread.",
      priority: 70,
    });
  }
  const meetingIds = new Set<string>();
  for (const evidence of input.calendarEvidence) {
    const metadata = evidence.sourceMetadata;
    const eventId = typeof metadata.eventId === "string" ? metadata.eventId : null;
    const startsAt =
      typeof metadata.eventStartAt === "string" ? new Date(metadata.eventStartAt) : null;
    if (
      !eventId ||
      meetingIds.has(eventId) ||
      metadata.external !== true ||
      !startsAt ||
      Number.isNaN(startsAt.getTime())
    )
      continue;
    if (startsAt >= input.now && startsAt <= new Date(input.now.getTime() + DAY_MS)) {
      meetingIds.add(eventId);
      items.push({
        kind: "external_meeting",
        sourceId: eventId,
        title: `External meeting with ${evidence.displayName ?? evidence.email ?? "a contact"}`,
        detail: evidence.excerpt ?? "External meeting starts within 24 hours.",
        priority: 80,
      });
    }
  }
  for (const record of input.records) {
    if (
      !record.founderConfirmedAt ||
      !record.nextActionDueAt ||
      record.nextActionDueAt >= input.now
    )
      continue;
    if (!record.nextAction && record.commitments.length === 0) continue;
    items.push({
      kind: "overdue_relationship_work",
      sourceId: record.id,
      title: `Overdue work with ${record.displayName}`,
      detail:
        record.nextAction ?? record.commitments[0] ?? "Confirmed relationship work is overdue.",
      priority: 60,
    });
  }
  for (const action of input.actions) {
    items.push({
      kind: "proposed_action",
      sourceId: action.id,
      title: "Proposed Action awaiting your decision",
      detail: action.businessOutcome,
      priority: 100,
    });
  }
  return items.sort(
    (a, b) =>
      b.priority - a.priority ||
      a.kind.localeCompare(b.kind) ||
      a.sourceId.localeCompare(b.sourceId),
  );
}

function messageTime(evidence: typeof operatorRelationshipEvidence.$inferSelect): number {
  const value = evidence.sourceMetadata.messageAt;
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? Date.parse(value)
    : evidence.observedAt.getTime();
}

function isWithinSourceWindow(
  evidence: typeof operatorRelationshipEvidence.$inferSelect,
  startedAt: Date,
  endedAt: Date,
  sourceKind: "calendar" | "mail",
): boolean {
  const metadataKey = sourceKind === "calendar" ? "eventStartAt" : "messageAt";
  const sourceTime = evidence.sourceMetadata[metadataKey];
  const timestamp =
    typeof sourceTime === "string" && !Number.isNaN(Date.parse(sourceTime))
      ? new Date(sourceTime)
      : evidence.observedAt;
  return timestamp >= startedAt && timestamp <= endedAt;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) => (item instanceof Date ? item.toISOString() : item)),
    )
    .digest("hex")}`;
}

function zonedParts(
  date: Date,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

function addLocalDays(date: { year: number; month: number; day: number }, days: number) {
  const result = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: result.getUTCFullYear(),
    month: result.getUTCMonth() + 1,
    day: result.getUTCDate(),
  };
}

function localToUtc(
  input: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): Date {
  let candidate = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute);
  for (let i = 0; i < 4; i += 1) {
    const actual = zonedParts(new Date(candidate), timezone);
    const desired = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute);
    const observed = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    candidate += desired - observed;
  }
  return new Date(candidate);
}

async function withConnection<T>(
  dependencies: { createConnection?: () => DatabaseConnection },
  fn: (connection: DatabaseConnection) => Promise<T>,
): Promise<T> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  try {
    return await fn(connection);
  } finally {
    if (!dependencies.createConnection) await connection.close();
  }
}
