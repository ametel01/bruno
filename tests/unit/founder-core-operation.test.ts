import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET as coreOperationGET,
  POST as coreOperationPOST,
} from "@/app/api/operator/core-operation/route";
import { buildTestAnthropicAcceptanceRelease } from "@/scripts/founder-anthropic-test-release";
import { buildTestGoogleMailSendingAcceptanceRelease } from "@/scripts/founder-google-mail-sending-test-release";
import { buildTestGoogleConnectedAcceptanceRelease } from "@/scripts/founder-google-test-release";
import { buildTestOpenAiConnectedAcceptanceRelease } from "@/scripts/founder-openai-test-release";
import { createFounderCheckout } from "@/src/server/commerce/founder-commerce";
import type { LemonSqueezyCommerceProvider } from "@/src/server/commerce/lemon-squeezy-provider";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderGeneralReleaseActivations,
  founderReleaseDecisions,
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
  operators,
  runners,
  users,
} from "@/src/server/db/schema";
import {
  declineFounderGeneralReleaseOffer,
  hasFounderGeneralReleaseBriefAccessForUser,
} from "@/src/server/founder-product-contract/initial-general-release";
import { ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY } from "@/src/server/operators/founder-ai-routing";
import {
  confirmFounderCoreProcessingConsentForUser,
  getFounderCoreOperationForUser,
  openFounderCoreBriefForUser,
  reconcileFounderCoreOperationForUser,
} from "@/src/server/operators/founder-core-operation";
import { getFounderOnboardingForUser } from "@/src/server/operators/founder-onboarding";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";

const OWNER_ID = "00000000-0000-4000-8000-000000003450";
const NOW = new Date("2026-08-19T01:00:00.000Z");
const GOOGLE_RELEASE_REVISION = "d".repeat(40);
const RUNTIME_REVISION = "runtime-core-operation";
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
const GENERAL_RELEASE_ROUTING_POLICY = {
  ...ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY,
  providers: {
    ...ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY.providers,
    openai: { ...ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY.providers.openai, released: true },
    anthropic: { ...ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY.providers.anthropic, released: true },
  },
};
const GENERAL_RELEASE_ENV = {
  ...GOOGLE_MAIL_RELEASE_ENV,
  BRUNO_FOUNDER_RELEASE_RUNTIME_REVISION: RUNTIME_REVISION,
  BRUNO_OPENAI_CONNECTED_ACCEPTANCE_RELEASE: buildTestOpenAiConnectedAcceptanceRelease(
    NOW,
    GOOGLE_RELEASE_REVISION,
  ),
  BRUNO_ANTHROPIC_CONNECTED_ACCEPTANCE_RELEASE: buildTestAnthropicAcceptanceRelease(
    NOW,
    GOOGLE_RELEASE_REVISION,
  ),
  BRUNO_GOOGLE_MAIL_SENDING_CONNECTED_ACCEPTANCE_RELEASE:
    buildTestGoogleMailSendingAcceptanceRelease(NOW, GOOGLE_RELEASE_REVISION),
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
      }),
    ).resolves.toBeNull();
    const [generalReleaseOperator] = await connection.db.select().from(operators).limit(1);
    if (!generalReleaseOperator) throw new Error("General Release Operator fixture is missing.");
    const [releaseDecision] = await connection.db
      .insert(founderReleaseDecisions)
      .values({
        stage: "initial_general_release",
        outcome: "enter",
        applicationRevision: GOOGLE_RELEASE_REVISION,
        runtimeRevision: RUNTIME_REVISION,
        capabilityManifest: [
          "openai",
          "anthropic",
          "calendar_reading",
          "gmail_reading",
          "gmail_sending",
        ],
        evidenceDigests: Array.from(
          { length: 12 },
          (_, index) => `sha256:${index.toString(16).repeat(64)}`,
        ),
        authorityExpiresAt: new Date(NOW.valueOf() + 24 * 60 * 60 * 1_000),
        decidedAt: NOW,
      })
      .returning({ id: founderReleaseDecisions.id });
    if (!releaseDecision) throw new Error("General Release Decision fixture is missing.");
    await connection.db.insert(founderGeneralReleaseActivations).values({
      userId: OWNER_ID,
      operatorId: generalReleaseOperator.id,
      releaseDecisionId: releaseDecision.id,
      status: "setup",
      serviceBusinessConfirmedAt: NOW,
      geographyCode: "PH",
      admissionState: "eligible",
      admissionReason: "Public capacity is available in this geography.",
      publishedPriceLabel: "$30/month",
      capacityObservedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await expect(
      reconcileFounderCoreOperationForUser(OWNER_ID, {
        createConnection: () => connection,
        now: () => NOW,
        env: GENERAL_RELEASE_ENV,
        routingPolicy: GENERAL_RELEASE_ROUTING_POLICY,
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
      env: GENERAL_RELEASE_ENV,
      routingPolicy: GENERAL_RELEASE_ROUTING_POLICY,
    });
    expect(confirmed).toMatchObject({
      status: "core",
      consent: { status: "active", purpose: "core_operation" },
      brief: { attentionCount: 0, evidenceState: "current" },
      authorityPolicy: { mailIncluded: false },
      activatedAt: null,
    });
    const [persistedOperator] = await connection.db.select().from(operators).limit(1);
    const [runner] = await connection.db
      .insert(runners)
      .values({
        userId: OWNER_ID,
        name: "General Release fixture",
        kind: "digitalocean",
        status: "online",
        provider: "digitalocean",
        providerResourceId: "droplet-general-release-fixture",
        providerFirewallId: "firewall-general-release-fixture",
        region: "sgp1",
        sizeSlug: "s-1vcpu-1gb",
        image: "ubuntu-24-04-x64",
        provisioningStatus: "ready",
        provisioningOperationKey: `bruno-deploy-${"a".repeat(32)}`,
        provisioningStartedAt: NOW,
        provisioningCompletedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();
    if (!persistedOperator || !runner) throw new Error("Activation fixture could not be created.");
    await connection.db.update(founderGeneralReleaseActivations).set({
      runnerId: runner.id,
      status: "activation_pending",
      createConfirmedAt: NOW,
      setupEvidenceDigest: `sha256:${"b".repeat(64)}`,
      dropletCreatedAt: NOW,
      activationDueAt: new Date(NOW.valueOf() + 24 * 60 * 60 * 1_000),
      updatedAt: NOW,
    });
    const createCheckout = vi.fn(async ({ checkoutCorrelation }) => ({
      checkoutId: "checkout-general-release",
      checkoutUrl: "https://checkout.example/general-release",
      checkoutCorrelation,
    }));
    const commerceProvider = { createCheckout } as unknown as LemonSqueezyCommerceProvider;
    await expect(
      createFounderCheckout({
        userId: OWNER_ID,
        appUrl: "https://bruno.example",
        now: NOW,
        provider: commerceProvider,
        createConnection: () => connection,
      }),
    ).rejects.toMatchObject({ code: "purchase_decision_unavailable" });
    expect(createCheckout).not.toHaveBeenCalled();
    const opened = await openFounderCoreBriefForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
      env: GENERAL_RELEASE_ENV,
      routingPolicy: GENERAL_RELEASE_ROUTING_POLICY,
    });
    await expect(
      hasFounderGeneralReleaseBriefAccessForUser(OWNER_ID, {
        createConnection: () => connection,
        env: GENERAL_RELEASE_ENV,
        now: () => NOW,
      }),
    ).resolves.toBe(true);
    const reloadedBrief = await coreOperationGET(
      new Request("https://bruno.example/api/operator/core-operation"),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true, userId: OWNER_ID }),
        getOperation: (userId) =>
          getFounderCoreOperationForUser(userId, { createConnection: () => connection }),
      },
    );
    expect(reloadedBrief.status).toBe(200);
    await expect(reloadedBrief.json()).resolves.toMatchObject({
      operation: {
        activatedAt: NOW.toISOString(),
        brief: { status: "opened", content: expect.any(String) },
      },
    });
    const repeatedBrief = await coreOperationPOST(
      new Request("https://bruno.example/api/operator/core-operation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "open_brief" }),
      }),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true, userId: OWNER_ID }),
        openBrief: (userId) =>
          openFounderCoreBriefForUser(userId, {
            createConnection: () => connection,
            now: () => new Date(NOW.getTime() + 1000),
            env: GENERAL_RELEASE_ENV,
            routingPolicy: GENERAL_RELEASE_ROUTING_POLICY,
          }),
      },
    );
    expect(repeatedBrief.status).toBe(403);
    await expect(repeatedBrief.json()).resolves.toMatchObject({
      error: { code: "owner_preview_access_required" },
    });
    await expect(
      createFounderCheckout({
        userId: OWNER_ID,
        appUrl: "https://bruno.example",
        now: NOW,
        provider: commerceProvider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ checkoutUrl: "https://checkout.example/general-release" });
    expect(createCheckout).toHaveBeenCalledTimes(1);
    expect(opened.activatedAt).toBe(NOW.toISOString());
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
    expect(await connection.db.select().from(founderGeneralReleaseActivations)).toEqual([
      expect.objectContaining({
        status: "activated",
        activatedAt: NOW,
        workStoppedAt: NOW,
        entitlementDueAt: new Date(NOW.valueOf() + 24 * 60 * 60 * 1_000),
      }),
    ]);
    expect(await connection.db.select().from(operators)).toEqual([
      expect.objectContaining({
        externalActionPause: true,
        externalActionPauseReason: "Product Entitlement does not authorize new work.",
      }),
    ]);
    await connection.db
      .update(founderGeneralReleaseActivations)
      .set({ workStoppedAt: null, updatedAt: NOW });
    const declinedAt = new Date(NOW.valueOf() + 2_000);
    await declineFounderGeneralReleaseOffer(OWNER_ID, declinedAt, {
      createConnection: () => connection,
    });
    expect(await connection.db.select().from(founderGeneralReleaseActivations)).toEqual([
      expect.objectContaining({
        status: "retirement_due",
        retirementDueAt: declinedAt,
        workStoppedAt: NOW,
      }),
    ]);
    const entitlementDueAt = new Date(NOW.valueOf() + 24 * 60 * 60 * 1_000);
    const lateDeclineAt = new Date(entitlementDueAt.valueOf() + 60_000);
    await connection.db
      .update(founderGeneralReleaseActivations)
      .set({ status: "activated", retirementDueAt: null, updatedAt: declinedAt });
    await declineFounderGeneralReleaseOffer(OWNER_ID, lateDeclineAt, {
      createConnection: () => connection,
    });
    expect(await connection.db.select().from(founderGeneralReleaseActivations)).toEqual([
      expect.objectContaining({ status: "retirement_due", retirementDueAt: entitlementDueAt }),
    ]);
  });

  it("fails closed at every deep Core mutation seam during Owner Preview", async () => {
    const dependencies = {
      createConnection: () => connection,
      now: () => NOW,
      env: { VERCEL_GIT_COMMIT_SHA: GOOGLE_RELEASE_REVISION },
    };

    await expect(
      reconcileFounderCoreOperationForUser(OWNER_ID, dependencies),
    ).rejects.toMatchObject({ code: "owner_preview_access_required" });
    await expect(
      confirmFounderCoreProcessingConsentForUser(OWNER_ID, dependencies),
    ).rejects.toMatchObject({ code: "owner_preview_access_required" });
    await expect(openFounderCoreBriefForUser(OWNER_ID, dependencies)).rejects.toMatchObject({
      code: "owner_preview_access_required",
    });
    expect(await connection.db.select().from(operatorLimitedOperations)).toEqual([]);
    expect(await connection.db.select().from(operatorProcessingConsents)).toEqual([]);
    expect(await connection.db.select().from(operatorMorningBriefs)).toEqual([]);
  });
});

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table operator_founder_activations, operator_morning_briefs, operator_governance_receipts, operator_authority_policies, operator_processing_consents, operator_limited_operations, operator_primary_communications_suites, operator_mail_connections, operator_calendar_connections, operator_runtimes, operator_preparations, operators, users restart identity cascade",
  );
}
