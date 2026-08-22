import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorAiConnections,
  operatorAuthorityPolicies,
  operatorCalendarConnections,
  operatorCalendarResources,
  operatorFounderActivations,
  operatorGovernanceReceipts,
  operatorLimitedOperations,
  operatorMorningBriefs,
  operatorPreparations,
  operatorProcessingConsents,
  operatorRelationshipEvidence,
  operatorRuntimes,
  operators,
  users,
} from "@/src/server/db/schema";
import {
  confirmFounderProcessingConsentForUser,
  getFounderLimitedOperationForUser,
  openFounderMorningBriefForUser,
  reconcileFounderLimitedOperationForUser,
} from "@/src/server/operators/founder-limited-operation";
import {
  confirmFounderTimezoneForUser,
  ensureFounderOperatorForUser,
} from "@/src/server/operators/founder-operator";

const OWNER_ID = "00000000-0000-4000-8000-000000003420";
const REPLACEMENT_OWNER_ID = "00000000-0000-4000-8000-000000003421";
const NOW = new Date("2026-08-19T01:00:00.000Z");

describe("Founder Calendar-only Limited Operation", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await connection.db.insert(users).values({ id: OWNER_ID });
    const operator = await ensureFounderOperatorForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    await confirmFounderTimezoneForUser(OWNER_ID, "Asia/Manila", {
      createConnection: () => connection,
      now: () => NOW,
    });
    await connection.db.update(operatorPreparations).set({ status: "ready", completedAt: NOW });
    await connection.db
      .update(operatorRuntimes)
      .set({ status: "ready", transportState: "connected", safetyState: "verified", readyAt: NOW });
    const [ai] = await connection.db
      .insert(operatorAiConnections)
      .values({
        operatorId: operator.id,
        provider: "openai",
        providerSubjectId: "openai-founder",
        accountLabel: "Founder OpenAI",
        status: "ready",
        authorizationState: "authorized",
        capacityState: "available",
        inferenceState: "passed",
        eligibleAccount: true,
        authorizationPersisted: true,
        approvedModelAssignment: "openai-codex",
        authorizedAt: NOW,
        lastVerifiedAt: NOW,
      })
      .returning();
    const [calendar] = await connection.db
      .insert(operatorCalendarConnections)
      .values({
        operatorId: operator.id,
        provider: "google_calendar",
        providerSubjectId: "google-founder",
        accountLabel: "founder@example.com",
        status: "ready",
        authorizationState: "authorized",
        accessTokenCiphertext: "encrypted-access",
        accessTokenIv: "encrypted-iv",
        accessTokenAuthTag: "encrypted-tag",
        refreshTokenCiphertext: "encrypted-refresh",
        refreshTokenIv: "encrypted-refresh-iv",
        refreshTokenAuthTag: "encrypted-refresh-tag",
        secretKeyVersion: "test-v1",
        grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
        authorizedAt: NOW,
        lastVerifiedAt: NOW,
        lastEvidenceAt: NOW,
        lastEvidenceCount: 0,
        evidenceState: "current",
      })
      .returning();
    if (!ai || !calendar) throw new Error("test fixtures could not be created");
    await connection.db.insert(operatorCalendarResources).values({
      connectionId: calendar.id,
      providerResourceId: "primary",
      summary: "Primary Calendar",
      timeZone: "Asia/Manila",
      accessRole: "owner",
      primaryCalendar: true,
      selected: true,
      selectionReviewedAt: NOW,
    });
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("requires explicit consent, installs the safe policy, and prepares a verified quiet brief", async () => {
    await expect(
      getFounderLimitedOperationForUser(OWNER_ID, {
        createConnection: () => connection,
      }),
    ).resolves.toBeNull();
    await expect(
      reconcileFounderLimitedOperationForUser(OWNER_ID, {
        createConnection: () => connection,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({
      name: "Calendar-only Limited Operation",
      status: "awaiting_consent",
      mailIncluded: false,
      consent: { status: "missing" },
      brief: null,
    });

    const confirmed = await confirmFounderProcessingConsentForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    expect(confirmed).toMatchObject({
      status: "limited",
      mailIncluded: false,
      consent: { status: "active", purpose: "calendar_morning_brief" },
      authorityPolicy: {
        version: 1,
        observation: "always",
        preparation: "always",
        externalEffects: "approval_required",
        mailIncluded: false,
      },
      brief: {
        status: "prepared",
        evidenceState: "current",
        quiet: true,
        attentionCount: 0,
      },
      activatedAt: null,
    });
    expect(confirmed.brief?.content).toContain("verified quiet brief");
  });

  it("replays consent, brief preparation, and activation without duplicates", async () => {
    const first = await confirmFounderProcessingConsentForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    const second = await confirmFounderProcessingConsentForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => new Date(NOW.getTime() + 1_000),
    });
    await reconcileFounderLimitedOperationForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    expect(second.brief?.id).toBe(first.brief?.id);
    expect(await connection.db.select().from(operatorProcessingConsents)).toHaveLength(1);
    expect(await connection.db.select().from(operatorAuthorityPolicies)).toHaveLength(1);
    expect(await connection.db.select().from(operatorGovernanceReceipts)).toHaveLength(2);
    expect(await connection.db.select().from(operatorMorningBriefs)).toHaveLength(1);

    const opened = await openFounderMorningBriefForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    const replayed = await openFounderMorningBriefForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => new Date(NOW.getTime() + 2_000),
    });
    expect(opened.activatedAt).toBe(replayed.activatedAt);
    expect(replayed.brief).toMatchObject({ id: first.brief?.id, status: "opened" });
    expect(await connection.db.select().from(operatorFounderActivations)).toHaveLength(1);
    expect(await connection.db.select().from(operatorLimitedOperations)).toHaveLength(1);
  });

  it("keeps a verified quiet brief when evidence matches no deterministic rule", async () => {
    await connection.db.update(operatorCalendarConnections).set({ lastEvidenceCount: 2 });
    const [calendar] = await connection.db.select().from(operatorCalendarConnections).limit(1);
    expect(calendar).toMatchObject({ lastEvidenceCount: 2 });

    const operation = await confirmFounderProcessingConsentForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });

    expect(operation.brief).toMatchObject({
      quiet: true,
      attentionCount: 0,
      evidenceState: "current",
    });
    expect(operation.brief?.content).toContain("verified quiet brief");
  });

  it("creates a new generation when material Calendar evidence changes", async () => {
    const first = await confirmFounderProcessingConsentForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    const [operator] = await connection.db
      .select()
      .from(operators)
      .where(eq(operators.userId, OWNER_ID));
    const [calendar] = await connection.db.select().from(operatorCalendarConnections).limit(1);
    if (!operator || !calendar) throw new Error("test fixtures could not be loaded");
    await connection.db.insert(operatorRelationshipEvidence).values({
      operatorId: operator.id,
      sourceKind: "calendar",
      calendarConnectionId: calendar.id,
      mailConnectionId: null,
      provider: "google_calendar",
      providerItemId: "event-material:person@example.com",
      providerIdentity: null,
      email: "person@example.com",
      displayName: "Person",
      company: null,
      domain: "example.com",
      excerpt: "Planning",
      sourceMetadata: {
        kind: "calendar_event",
        eventId: "event-material",
        eventStartAt: "2026-08-19T02:00:00.000Z",
        external: true,
      },
      evidenceState: "current",
      observedAt: NOW,
      sourceFingerprint: "material-calendar-fingerprint",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const refreshed = await reconcileFounderLimitedOperationForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    expect(refreshed?.brief?.generation).toBe((first.brief?.generation ?? 0) + 1);
    expect(refreshed?.brief?.attentionCount).toBe(1);
    expect(refreshed?.brief?.calendarWindow).toEqual({
      startedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      endedAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  it("does not inherit a Limited Operation when the Calendar connection is replaced", async () => {
    const original = await confirmFounderProcessingConsentForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    await connection.db.insert(users).values({ id: REPLACEMENT_OWNER_ID });
    const replacementOperator = await ensureFounderOperatorForUser(REPLACEMENT_OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    const [replacementCalendar] = await connection.db
      .insert(operatorCalendarConnections)
      .values({
        operatorId: replacementOperator.id,
        provider: "google_calendar",
        providerSubjectId: "google-replacement",
        accountLabel: "replacement@example.com",
        status: "ready",
        authorizationState: "authorized",
        accessTokenCiphertext: "replacement-access",
        accessTokenIv: "replacement-iv",
        accessTokenAuthTag: "replacement-tag",
        refreshTokenCiphertext: "replacement-refresh",
        refreshTokenIv: "replacement-refresh-iv",
        refreshTokenAuthTag: "replacement-refresh-tag",
        secretKeyVersion: "test-v1",
        authorizedAt: NOW,
        lastVerifiedAt: NOW,
        lastEvidenceAt: NOW,
        evidenceState: "current",
      })
      .returning();
    if (!replacementCalendar) throw new Error("replacement fixture could not be created");
    const [operationRow] = await connection.db.select().from(operatorLimitedOperations).limit(1);
    if (!operationRow) throw new Error("operation fixture could not be loaded");
    await connection.db
      .update(operatorLimitedOperations)
      .set({ calendarConnectionId: replacementCalendar.id })
      .where(eq(operatorLimitedOperations.id, operationRow.id));

    const needsAttention = await reconcileFounderLimitedOperationForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    expect(needsAttention).toMatchObject({
      status: "needs_attention",
      consent: { status: "missing" },
      brief: null,
      activatedAt: null,
    });
    expect(needsAttention?.brief?.id).not.toBe(original.brief?.id);
    await expect(
      confirmFounderProcessingConsentForUser(OWNER_ID, {
        createConnection: () => connection,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "connection_replacement_requires_migration" });
  });
});

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table operator_founder_activations, operator_morning_briefs, operator_limited_operations, operator_governance_receipts, operator_authority_policies, operator_processing_consents, operator_calendar_resources, operator_calendar_connection_receipts, operator_calendar_connections, operator_ai_connection_receipts, operator_ai_connections, operator_runtimes, operator_preparations, operators, users restart identity cascade",
  );
}
