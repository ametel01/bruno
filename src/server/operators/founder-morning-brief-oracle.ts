import type {
  operatorProposedActions,
  operatorRelationshipEvidence,
  operatorRelationshipRecords,
} from "@/src/server/db/schema";

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

const DAY_MS = 24 * 60 * 60 * 1000;

export function nextMorningBriefDeliveryAt(now: Date, timezone: string, localTime: string): Date {
  const [hours = 0, minutes = 0] = localTime.split(":").map(Number);
  const current = zonedParts(now, timezone);
  let date = { year: current.year, month: current.month, day: current.day };
  if (current.hour * 60 + current.minute >= hours * 60 + minutes) date = addLocalDays(date, 1);
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
  const threads = new Map<string, typeof operatorRelationshipEvidence.$inferSelect>();
  for (const evidence of input.mailEvidence) {
    const threadId =
      typeof evidence.sourceMetadata.threadId === "string"
        ? evidence.sourceMetadata.threadId
        : evidence.providerItemId;
    const existing = threads.get(threadId);
    if (!existing || messageTime(evidence) >= messageTime(existing))
      threads.set(threadId, evidence);
  }
  for (const evidence of threads.values()) {
    if (evidence.sourceMetadata.direction !== "inbound") continue;
    items.push({
      kind: "unanswered_inbound",
      sourceId: String(evidence.sourceMetadata.threadId ?? evidence.providerItemId),
      title: `Reply to ${evidence.displayName ?? evidence.email ?? "an inbound message"}`,
      detail:
        evidence.excerpt ?? "An inbound message has no later outbound message in this thread.",
      priority: 70,
    });
  }
  const meetingIds = new Set<string>();
  for (const evidence of input.calendarEvidence) {
    const eventId =
      typeof evidence.sourceMetadata.eventId === "string" ? evidence.sourceMetadata.eventId : null;
    const value = evidence.sourceMetadata.eventStartAt;
    const startsAt = typeof value === "string" ? new Date(value) : null;
    if (
      !eventId ||
      meetingIds.has(eventId) ||
      evidence.sourceMetadata.external !== true ||
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
      record.nextActionDueAt >= input.now ||
      (!record.nextAction && record.commitments.length === 0)
    )
      continue;
    items.push({
      kind: "overdue_relationship_work",
      sourceId: record.id,
      title: `Overdue work with ${record.displayName}`,
      detail:
        record.nextAction ?? record.commitments[0] ?? "Confirmed relationship work is overdue.",
      priority: 60,
    });
  }
  for (const action of input.actions)
    items.push({
      kind: "proposed_action",
      sourceId: action.id,
      title: "Proposed Action awaiting your decision",
      detail: action.businessOutcome,
      priority: 100,
    });
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
    candidate +=
      Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute) -
      Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
  }
  return new Date(candidate);
}
