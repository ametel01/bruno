import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestGoogleConnectedAcceptanceRelease } from "@/scripts/founder-google-test-release";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorAiConnections,
  operatorCalendarConnections,
  operatorFounderActivations,
  operatorLimitedOperations,
  operatorMailConnections,
  operatorMorningBriefs,
  operatorPreparations,
  operatorPrimaryCommunicationsSuites,
  operatorProcessingConsents,
  operatorRuntimes,
  users,
} from "@/src/server/db/schema";
import {
  confirmFounderCoreProcessingConsentForUser,
  getFounderCoreOperationForUser,
  openFounderCoreBriefForUser,
} from "@/src/server/operators/founder-core-operation";
import { getFounderOnboardingForUser } from "@/src/server/operators/founder-onboarding";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";

const OWNER_ID = "00000000-0000-4000-8000-000000003450";
const NOW = new Date("2026-08-19T01:00:00.000Z");
const GOOGLE_RELEASE_REVISION = "d".repeat(40);
const GOOGLE_MAIL_RELEASE_ENV = {
  BRUNO_GOOGLE_CALENDAR_CONNECTED_ACCEPTANCE_RELEASE: buildTestGoogleConnectedAcceptanceRelease(
    "calendar_reading",
    NOW,
    GOOGLE_RELEASE_REVISION,
  ),
  BRUNO_GOOGLE_MAIL_READING_CONNECTED_ACCEPTANCE_RELEASE: buildTestGoogleConnectedAcceptanceRelease(
    "gmail_reading",
    NOW,
    GOOGLE_RELEASE_REVISION,
  ),
  VERCEL_GIT_COMMIT_SHA: GOOGLE_RELEASE_REVISION,
};

describe("Founder Core Operation", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await connection.db.insert(users).values({ id: OWNER_ID });
    const operator = await ensureFounderOperatorForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    await connection.db.update(operatorPreparations).set({
      status: "ready",
      timezone: "Asia/Manila",
      timezoneConfirmedAt: NOW,
      completedAt: NOW,
    });
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
        providerSubjectId: "google-founder",
        accountLabel: "founder@example.com",
        status: "ready",
        authorizationState: "authorized",
        accessTokenCiphertext: "a",
        accessTokenIv: "b",
        accessTokenAuthTag: "c",
        refreshTokenCiphertext: "d",
        refreshTokenIv: "e",
        refreshTokenAuthTag: "f",
        secretKeyVersion: "test-v1",
        grantedScopes: ["calendar.readonly"],
        authorizedAt: NOW,
        lastVerifiedAt: NOW,
        lastEvidenceAt: NOW,
        lastEvidenceCount: 1,
        evidenceState: "current",
      })
      .returning();
    const [mail] = await connection.db
      .insert(operatorMailConnections)
      .values({
        operatorId: operator.id,
        providerSubjectId: "google-founder",
        accountLabel: "founder@example.com",
        status: "ready",
        authorizationState: "authorized",
        accessTokenCiphertext: "a",
        accessTokenIv: "b",
        accessTokenAuthTag: "c",
        refreshTokenCiphertext: "d",
        refreshTokenIv: "e",
        refreshTokenAuthTag: "f",
        secretKeyVersion: "test-v1",
        grantedScopes: ["gmail.readonly"],
        authorizedAt: NOW,
        lastVerifiedAt: NOW,
        lastEvidenceAt: NOW,
        lastEvidenceCount: 2,
        evidenceState: "current",
        suiteStatus: "matched",
      })
      .returning();
    if (!ai || !calendar || !mail) throw new Error("Core fixtures could not be created");
    await connection.db.insert(operatorPrimaryCommunicationsSuites).values({
      operatorId: operator.id,
      calendarConnectionId: calendar.id,
      mailConnectionId: mail.id,
      providerSubjectId: "google-founder",
      status: "active",
    });
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("requires the exact matched suite, creates a read-only Core brief, and replays activation", async () => {
    await expect(
      getFounderOnboardingForUser(OWNER_ID, {
        createConnection: () => connection,
        env: GOOGLE_MAIL_RELEASE_ENV,
      }),
    ).resolves.toMatchObject({
      nextStep: "consent",
      defaultRoute: "/operator#onboarding-consent",
      capabilities: { ai: "ready", calendar: "ready", mail: "ready" },
      facts: { primarySuiteIdentity: "google-founder" },
    });
    await expect(
      getFounderCoreOperationForUser(OWNER_ID, {
        createConnection: () => connection,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({
      name: "Core Operation",
      status: "awaiting_consent",
      mailIncluded: true,
      mailSendingRequired: false,
      suite: { status: "active", providerSubjectId: "google-founder" },
      access: { ai: "ready", calendar: "ready", mail: "ready", evidence: "current" },
    });
    const confirmed = await confirmFounderCoreProcessingConsentForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    expect(confirmed).toMatchObject({
      status: "core",
      consent: { status: "active", purpose: "core_operation" },
      brief: { attentionCount: 0, evidenceState: "current" },
      authorityPolicy: { mailIncluded: false },
      activatedAt: null,
    });
    const opened = await openFounderCoreBriefForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    const replayed = await openFounderCoreBriefForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => new Date(NOW.getTime() + 1000),
    });
    expect(replayed.activatedAt).toBe(opened.activatedAt);
    await expect(
      getFounderOnboardingForUser(OWNER_ID, {
        createConnection: () => connection,
        env: GOOGLE_MAIL_RELEASE_ENV,
      }),
    ).resolves.toMatchObject({
      nextStep: "conversation",
      defaultRoute: "/operator#conversation",
      activated: true,
      operation: "core",
      capabilities: { core: "ready" },
    });
    expect(await connection.db.select().from(operatorProcessingConsents)).toHaveLength(1);
    expect(await connection.db.select().from(operatorMorningBriefs)).toHaveLength(1);
    expect(await connection.db.select().from(operatorFounderActivations)).toHaveLength(1);
    expect(await connection.db.select().from(operatorLimitedOperations)).toHaveLength(1);
  });
});

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table operator_founder_activations, operator_morning_briefs, operator_governance_receipts, operator_authority_policies, operator_processing_consents, operator_limited_operations, operator_primary_communications_suites, operator_mail_connections, operator_calendar_connections, operator_runtimes, operator_preparations, operators, users restart identity cascade",
  );
}
