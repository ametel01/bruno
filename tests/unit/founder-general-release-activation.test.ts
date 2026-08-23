import { describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/operator/general-release/route";
import { buildTestAnthropicAcceptanceRelease } from "@/scripts/founder-anthropic-test-release";
import { buildTestOpenAiConnectedAcceptanceRelease } from "@/scripts/founder-openai-test-release";
import { createDatabaseConnection } from "@/src/server/db/client";
import {
  founderGeneralReleaseActivations,
  operatorAiConnections,
  operatorCalendarConnections,
  operatorLimitedOperations,
  operatorMorningBriefs,
  operators,
  runners,
  users,
} from "@/src/server/db/schema";
import {
  areFounderGeneralReleaseAiProvidersReleased,
  type FounderGeneralReleaseActivationDto,
  FounderGeneralReleaseError,
  founderGeneralReleaseSetupAuthorizesInTransaction,
  hasFounderGeneralReleaseSetupAccessForUser,
  reconcileFounderGeneralReleaseDeadlineForUser,
} from "@/src/server/founder-product-contract/initial-general-release";

const USER_ID = "00000000-0000-4000-8000-000000000381";
const NOW = new Date("2026-08-23T08:00:00.000Z");

describe("public Initial General Release application boundary", () => {
  it("requires current exact-revision releases for both OpenAI and Anthropic", () => {
    const revision = "a".repeat(40);
    const env = {
      VERCEL_GIT_COMMIT_SHA: revision,
      BRUNO_OPENAI_CONNECTED_ACCEPTANCE_RELEASE: buildTestOpenAiConnectedAcceptanceRelease(
        NOW,
        revision,
      ),
      BRUNO_ANTHROPIC_CONNECTED_ACCEPTANCE_RELEASE: buildTestAnthropicAcceptanceRelease(
        NOW,
        revision,
      ),
    };
    expect(areFounderGeneralReleaseAiProvidersReleased(env, NOW)).toBe(true);
    expect(
      areFounderGeneralReleaseAiProvidersReleased(
        { ...env, BRUNO_ANTHROPIC_CONNECTED_ACCEPTANCE_RELEASE: undefined },
        NOW,
      ),
    ).toBe(false);
    expect(
      areFounderGeneralReleaseAiProvidersReleased(
        { ...env, VERCEL_GIT_COMMIT_SHA: "b".repeat(40) },
        NOW,
      ),
    ).toBe(false);
  });

  it("requires Clerk authentication and exposes no-cache capacity and price facts", async () => {
    const unauthorized = await GET(
      new Request("https://bruno.example/api/operator/general-release"),
      undefined,
      { requireUser: async () => ({ ok: false, status: 401, code: "unauthenticated" }) },
    );
    expect(unauthorized.status).toBe(401);

    const getStatus = vi.fn(async () => status());
    const response = await GET(
      new Request("https://bruno.example/api/operator/general-release"),
      undefined,
      {
        requireUser: async () => ({ ok: true, userId: USER_ID }),
        getStatus,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      generalRelease: {
        admission: { publicSelfServe: true, personalSelection: false, capacity: "available" },
        offer: {
          priceLabel: "$30/month",
          brunoPriceSeparateFromAiProviderCosts: true,
          aiProviderCosts: "Paid separately to OpenAI or Anthropic",
          freeTier: false,
          betaConversion: false,
        },
      },
    });
    expect(getStatus).toHaveBeenCalledWith(USER_ID);
  });

  it("accepts public eligibility before explicit creation and preserves each decision", async () => {
    const confirmEligibility = vi.fn(async () => status());
    const createOperator = vi.fn(async () => status({ state: "activation_pending" }));
    const declineOffer = vi.fn(async () => undefined);
    const getStatus = vi.fn(async () => status({ state: "retirement_due" }));
    const dependencies = {
      requireUser: async () => ({ ok: true as const, userId: USER_ID }),
      confirmEligibility,
      createOperator,
      declineOffer,
      getStatus,
      now: () => NOW,
    };

    const eligibility = await POST(
      request({
        action: "confirm_eligibility",
        serviceBusinessConfirmed: true,
        geographyCode: "ph",
      }),
      undefined,
      dependencies,
    );
    expect(eligibility.status).toBe(200);
    expect(confirmEligibility).toHaveBeenCalledWith({
      userId: USER_ID,
      serviceBusinessConfirmed: true,
      geographyCode: "ph",
      now: NOW,
    });
    expect(createOperator).not.toHaveBeenCalled();

    const creation = await POST(request({ action: "create_operator" }), undefined, dependencies);
    expect(creation.status).toBe(201);
    expect(createOperator).toHaveBeenCalledWith({ userId: USER_ID, now: NOW });

    const decline = await POST(request({ action: "decline_offer" }), undefined, dependencies);
    expect(decline.status).toBe(200);
    expect(declineOffer).toHaveBeenCalledWith(USER_ID, NOW);
    expect(getStatus).toHaveBeenCalledWith(USER_ID);
  });

  it("fails closed when required setup or capacity evidence is unavailable", async () => {
    const response = await POST(request({ action: "create_operator" }), undefined, {
      requireUser: async () => ({ ok: true, userId: USER_ID }),
      createOperator: async () => {
        throw new FounderGeneralReleaseError(
          "connections_not_ready",
          "Ready AI, Company Connections, and consent are required.",
        );
      },
      now: () => NOW,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "connections_not_ready",
        message: "Ready AI, Company Connections, and consent are required.",
      },
    });
  });

  it("stops abandoned activation at 24 hours and makes retirement due within one hour", async () => {
    const connection = createDatabaseConnection();
    const activationDueAt = new Date("2026-08-24T08:00:00.000Z");
    try {
      await connection.db.insert(users).values({ id: USER_ID });
      const [operator] = await connection.db
        .insert(operators)
        .values({ userId: USER_ID })
        .returning();
      const [runner] = await connection.db
        .insert(runners)
        .values({
          userId: USER_ID,
          name: "General Release deadline fixture",
          kind: "digitalocean",
          status: "online",
          provider: "digitalocean",
          providerResourceId: "droplet-general-release-deadline",
          providerFirewallId: "firewall-general-release-deadline",
          region: "sgp1",
          sizeSlug: "s-1vcpu-1gb",
          image: "ubuntu-24-04-x64",
          provisioningStatus: "ready",
          provisioningOperationKey: `bruno-deploy-${"c".repeat(32)}`,
          provisioningStartedAt: NOW,
          provisioningCompletedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .returning();
      if (!operator || !runner) throw new Error("Deadline fixture could not be created.");
      await connection.db.insert(founderGeneralReleaseActivations).values({
        userId: USER_ID,
        operatorId: operator.id,
        runnerId: runner.id,
        status: "activation_pending",
        serviceBusinessConfirmedAt: NOW,
        geographyCode: "PH",
        admissionState: "eligible",
        admissionReason: "Public capacity is available in this geography.",
        publishedPriceLabel: "$30/month",
        capacityObservedAt: NOW,
        createConfirmedAt: NOW,
        setupEvidenceDigest: `sha256:${"d".repeat(64)}`,
        dropletCreatedAt: NOW,
        activationDueAt,
        createdAt: NOW,
        updatedAt: NOW,
      });

      expect(
        await hasFounderGeneralReleaseSetupAccessForUser(USER_ID, {
          createConnection: () => connection,
          now: () => activationDueAt,
        }),
      ).toBe(false);
      await expect(
        connection.db.transaction((tx) =>
          founderGeneralReleaseSetupAuthorizesInTransaction(tx, USER_ID, activationDueAt),
        ),
      ).resolves.toBe(false);

      await reconcileFounderGeneralReleaseDeadlineForUser(USER_ID, activationDueAt, {
        createConnection: () => connection,
      });

      expect(await connection.db.select().from(founderGeneralReleaseActivations)).toEqual([
        expect.objectContaining({
          status: "retirement_due",
          workStoppedAt: activationDueAt,
          retirementDueAt: new Date(activationDueAt.valueOf() + 60 * 60 * 1_000),
        }),
      ]);
      expect(await connection.db.select().from(operators)).toEqual([
        expect.objectContaining({
          externalActionPause: true,
          externalActionPausedAt: activationDueAt,
        }),
      ]);
    } finally {
      await connection.client.unsafe("truncate table users restart identity cascade");
      await connection.close();
    }
  });

  it("keeps the activation pause separate from the 24-hour purchase retirement deadline", async () => {
    const connection = createDatabaseConnection();
    const activatedAt = new Date("2026-08-23T09:00:00.000Z");
    const entitlementDueAt = new Date("2026-08-24T09:00:00.000Z");
    try {
      await connection.db.insert(users).values({ id: USER_ID });
      const [operator] = await connection.db
        .insert(operators)
        .values({
          userId: USER_ID,
          externalActionPause: true,
          externalActionPauseReason: "Founder Activation awaits verified Product Entitlement.",
          externalActionPausedAt: activatedAt,
        })
        .returning();
      const [runner] = await connection.db
        .insert(runners)
        .values({
          userId: USER_ID,
          name: "General Release purchase deadline fixture",
          kind: "digitalocean",
          status: "online",
          provider: "digitalocean",
          providerResourceId: "droplet-general-release-purchase-deadline",
          providerFirewallId: "firewall-general-release-purchase-deadline",
          region: "sgp1",
          sizeSlug: "s-1vcpu-1gb",
          image: "ubuntu-24-04-x64",
          provisioningStatus: "ready",
          provisioningOperationKey: `bruno-deploy-${"e".repeat(32)}`,
          provisioningStartedAt: NOW,
          provisioningCompletedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .returning();
      if (!operator || !runner) throw new Error("Purchase deadline fixture could not be created.");
      const [aiConnection] = await connection.db
        .insert(operatorAiConnections)
        .values({ operatorId: operator.id })
        .returning();
      const [calendarConnection] = await connection.db
        .insert(operatorCalendarConnections)
        .values({ operatorId: operator.id })
        .returning();
      if (!aiConnection || !calendarConnection) {
        throw new Error("Purchase deadline connections could not be created.");
      }
      const [operation] = await connection.db
        .insert(operatorLimitedOperations)
        .values({
          operatorId: operator.id,
          aiConnectionId: aiConnection.id,
          calendarConnectionId: calendarConnection.id,
        })
        .returning();
      if (!operation) throw new Error("Purchase deadline operation could not be created.");
      const [brief] = await connection.db
        .insert(operatorMorningBriefs)
        .values({
          operatorId: operator.id,
          operationId: operation.id,
          generation: 1,
          status: "opened",
          evidenceState: "current",
          quiet: true,
          attentionCount: 0,
          content: "Nothing needs attention right now. This is a verified quiet brief.",
          evidenceDigest: `sha256:${"a".repeat(64)}`,
          evidenceWatermark: `sha256:${"a".repeat(64)}`,
          windowStartedAt: new Date("2026-08-23T08:00:00.000Z"),
          windowEndedAt: activatedAt,
          generatedAt: activatedAt,
          openedAt: activatedAt,
        })
        .returning();
      if (!brief) throw new Error("Purchase deadline brief could not be created.");
      await connection.db.insert(founderGeneralReleaseActivations).values({
        userId: USER_ID,
        operatorId: operator.id,
        runnerId: runner.id,
        status: "activated",
        serviceBusinessConfirmedAt: NOW,
        geographyCode: "PH",
        admissionState: "eligible",
        admissionReason: "Public capacity is available in this geography.",
        publishedPriceLabel: "$30/month",
        capacityObservedAt: NOW,
        createConfirmedAt: NOW,
        setupEvidenceDigest: `sha256:${"f".repeat(64)}`,
        dropletCreatedAt: NOW,
        activationDueAt: new Date("2026-08-24T08:00:00.000Z"),
        firstBriefId: brief.id,
        activationEvidenceDigest: `sha256:${"b".repeat(64)}`,
        activatedAt,
        entitlementDueAt,
        workStoppedAt: activatedAt,
        createdAt: NOW,
        updatedAt: NOW,
      });

      await reconcileFounderGeneralReleaseDeadlineForUser(USER_ID, entitlementDueAt, {
        createConnection: () => connection,
      });

      expect(await connection.db.select().from(founderGeneralReleaseActivations)).toEqual([
        expect.objectContaining({
          status: "retirement_due",
          workStoppedAt: activatedAt,
          retirementDueAt: entitlementDueAt,
        }),
      ]);
      expect(await connection.db.select().from(operators)).toEqual([
        expect.objectContaining({
          externalActionPause: true,
          externalActionPausedAt: activatedAt,
        }),
      ]);
    } finally {
      await connection.client.unsafe("truncate table users restart identity cascade");
      await connection.close();
    }
  });
});

function request(body: object): Request {
  return new Request("https://bruno.example/api/operator/general-release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function status(
  override: Partial<FounderGeneralReleaseActivationDto> = {},
): FounderGeneralReleaseActivationDto {
  return {
    state: "setup",
    admission: {
      publicSelfServe: true,
      personalSelection: false,
      geographyCode: "PH",
      capacity: "available",
      reason: "Public capacity is available in this geography.",
    },
    setup: {
      authenticated: true,
      serviceBusinessConfirmed: true,
      readyAiConnection: true,
      selectedCompanyConnections: true,
      processingConsent: true,
      explicitCreateConfirmed: false,
      canCreate: true,
    },
    activation: { dropletCreatedAt: null, dueAt: null, activatedAt: null },
    offer: {
      available: false,
      priceLabel: "$30/month",
      brunoPriceSeparateFromAiProviderCosts: true,
      aiProviderCosts: "Paid separately to OpenAI or Anthropic",
      freeTier: false,
      betaConversion: false,
      decisionDueAt: null,
    },
    retirement: { dueAt: null, workStoppedAt: null },
    ...override,
  };
}
