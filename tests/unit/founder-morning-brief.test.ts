import { describe, expect, it } from "vitest";
import type {
  operatorProposedActions,
  operatorRelationshipEvidence,
  operatorRelationshipRecords,
} from "@/src/server/db/schema";
import {
  buildAttentionItems,
  nextMorningBriefDeliveryAt,
} from "@/src/server/operators/founder-morning-brief-oracle";

function evidence(input: Partial<typeof operatorRelationshipEvidence.$inferSelect>) {
  return {
    id: "evidence-id",
    operatorId: "operator-id",
    recordId: null,
    candidateId: null,
    sourceKind: "mail",
    calendarConnectionId: null,
    mailConnectionId: "mail-id",
    provider: "google",
    providerItemId: "message-id",
    providerIdentity: null,
    email: "person@example.com",
    displayName: "Person",
    company: null,
    domain: "example.com",
    excerpt: "Checking in",
    sourceMetadata: {},
    evidenceState: "current",
    observedAt: new Date("2026-08-19T01:00:00Z"),
    sourceFingerprint: "fingerprint",
    createdAt: new Date("2026-08-19T01:00:00Z"),
    updatedAt: new Date("2026-08-19T01:00:00Z"),
    ...input,
  } as typeof operatorRelationshipEvidence.$inferSelect;
}

describe("Founder Morning Brief oracle", () => {
  it("uses the founder timezone and advances recurring delivery across DST", () => {
    const beforeSpring = nextMorningBriefDeliveryAt(
      new Date("2026-03-07T16:00:00Z"),
      "America/New_York",
      "07:00",
    );
    const afterSpring = nextMorningBriefDeliveryAt(
      new Date("2026-03-08T16:00:00Z"),
      "America/New_York",
      "07:00",
    );
    expect(beforeSpring.toISOString()).toBe("2026-03-08T11:00:00.000Z");
    expect(afterSpring.toISOString()).toBe("2026-03-09T11:00:00.000Z");
  });

  it("recognizes only explicit deterministic attention facts", () => {
    const now = new Date("2026-08-19T01:00:00Z");
    const items = buildAttentionItems({
      now,
      calendarEvidence: [
        evidence({
          sourceKind: "calendar",
          calendarConnectionId: "calendar-id",
          mailConnectionId: null,
          providerItemId: "event-id:person@example.com",
          sourceMetadata: {
            kind: "calendar_event",
            eventId: "event-id",
            eventStartAt: "2026-08-19T12:00:00Z",
            external: true,
          },
        }),
      ],
      mailEvidence: [
        evidence({
          sourceMetadata: {
            kind: "mail_message",
            threadId: "thread-1",
            direction: "inbound",
            messageAt: "2026-08-18T23:00:00Z",
          },
        }),
        evidence({
          sourceMetadata: {
            kind: "mail_message",
            threadId: "thread-1",
            direction: "outbound",
            messageAt: "2026-08-18T23:30:00Z",
          },
          providerItemId: "message-2",
        }),
        evidence({
          sourceMetadata: {
            kind: "mail_message",
            threadId: "thread-2",
            direction: "inbound",
            messageAt: "2026-08-18T22:00:00Z",
          },
          providerItemId: "message-3",
        }),
      ],
      records: [
        {
          id: "record-id",
          operatorId: "operator-id",
          displayName: "Confirmed Contact",
          company: null,
          primaryEmail: "person@example.com",
          provider: null,
          providerIdentity: null,
          relationshipState: "client",
          status: "active",
          nextAction: "Send proposal",
          nextActionDueAt: new Date("2026-08-18T01:00:00Z"),
          commitments: [],
          revision: 1,
          founderConfirmedAt: new Date("2026-08-01T01:00:00Z"),
          closedAt: null,
          createdAt: now,
          updatedAt: now,
        } as typeof operatorRelationshipRecords.$inferSelect,
      ],
      actions: [
        {
          id: "action-id",
          businessOutcome: "Approve the proposal",
          state: "awaiting_approval",
        } as typeof operatorProposedActions.$inferSelect,
      ],
    });
    expect(items.map((item) => item.kind)).toEqual([
      "proposed_action",
      "external_meeting",
      "unanswered_inbound",
      "overdue_relationship_work",
    ]);
  });
});
