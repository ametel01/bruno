import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  pollFounderAnthropicAuthorizationForUser,
  startFounderAnthropicAuthorizationForUser,
  createHermesAnthropicAdapter,
  evaluateFounderAnthropicCompatibility,
  evaluateFounderAiReadiness,
  type FounderAiReadinessInput,
} from "@/src/server/operators/founder-ai-connection";
import { runFounderAiAdapterConformanceSuite } from "./founder-ai-adapter-conformance";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorAiConnections,
  operatorCalendarConnections,
  operatorPreparations,
  operatorProcessingConsents,
  operatorRuntimes,
  users,
} from "@/src/server/db/schema";
import {
  confirmFounderTimezoneForUser,
  ensureFounderOperatorForUser,
} from "@/src/server/operators/founder-operator";

const readyAnthropic: FounderAiReadinessInput = {
  providerIdentity: "claude-account-123",
  accountLabel: "Founder Claude",
  eligibleAccount: true,
  billingVerified: true,
  privacyAccepted: true,
  retentionBounded: true,
  thirdPartyPermissionGranted: true,
  credentialHealthy: true,
  reconnectSupported: true,
  productionUseApproved: true,
  authorizationPersisted: true,
  approvedModelAssigned: true,
  processingConsentActive: true,
  capacity: "available",
  inference: "passed",
};

const OWNER_ID = "00000000-0000-4000-8000-000000003593";

runFounderAiAdapterConformanceSuite({
  provider: "anthropic",
  createAdapter: (request) => createHermesAnthropicAdapter({ request }),
});

describe("Anthropic AI Connection contract", () => {
  it("requires every explicit provider, privacy, consent, and inference gate", () => {
    expect(evaluateFounderAiReadiness(readyAnthropic, "anthropic")).toEqual({ ok: true });

    const gates: Array<[keyof FounderAiReadinessInput, unknown, string]> = [
      ["providerIdentity", null, "provider_identity_missing"],
      ["eligibleAccount", false, "account_not_eligible"],
      ["billingVerified", false, "billing_unverified"],
      ["privacyAccepted", false, "privacy_not_accepted"],
      ["retentionBounded", false, "retention_unbounded"],
      ["thirdPartyPermissionGranted", false, "third_party_permission_missing"],
      ["credentialHealthy", false, "credential_unhealthy"],
      ["reconnectSupported", false, "reconnect_unsupported"],
      ["productionUseApproved", false, "production_use_unapproved"],
      ["authorizationPersisted", false, "authorization_not_persisted"],
      ["approvedModelAssigned", false, "approved_model_missing"],
      ["processingConsentActive", false, "processing_consent_missing"],
      ["capacity", "exhausted", "capacity_unavailable"],
      ["inference", "failed", "inference_failed"],
    ];

    for (const [field, value, code] of gates) {
      expect(
        evaluateFounderAiReadiness({ ...readyAnthropic, [field]: value }, "anthropic"),
      ).toEqual({
        ok: false,
        code,
      });
    }
  });

  it("keeps Anthropic hidden until every compatibility release gate is proven", () => {
    expect(
      evaluateFounderAnthropicCompatibility({
        subscriptionPlan: "claude_max",
        extraUsageCredits: true,
        privacyReviewed: true,
        retentionReviewed: true,
        thirdPartyPermissionReviewed: true,
        credentialStorageReviewed: true,
        reconnectReviewed: true,
        productionUseReviewed: true,
      }),
    ).toEqual({ released: true });

    expect(
      evaluateFounderAnthropicCompatibility({
        subscriptionPlan: "claude_pro",
        extraUsageCredits: true,
        privacyReviewed: true,
        retentionReviewed: true,
        thirdPartyPermissionReviewed: true,
        credentialStorageReviewed: true,
        reconnectReviewed: true,
        productionUseReviewed: true,
      }),
    ).toEqual({ released: false, code: "subscription_ineligible" });
  });

  it("uses Hermes' structured Anthropic OAuth surface without exposing a token or setup-token", async () => {
    const requests: Array<{ path: string; method: string; body?: string | undefined }> = [];
    const adapter = createHermesAnthropicAdapter({
      request: async (path, init) => {
        requests.push({ path, method: init?.method ?? "GET", body: init?.body?.toString() });
        if (path.endsWith("/start")) {
          return {
            session_id: "anthropic-session-1",
            user_code: "CLAUDE-CODE",
            verification_url: "https://console.anthropic.com/oauth/authorize",
            expires_in: 900,
          };
        }
        if (path.includes("/poll/")) {
          return {
            status: "approved",
            account_id: "claude-account-123",
            account: "Founder Claude",
          };
        }
        if (path === "/api/providers/oauth") {
          return {
            providers: [
              {
                id: "anthropic",
                account_id: "claude-account-123",
                account_label: "Founder Claude",
                status: {
                  logged_in: true,
                  eligible: true,
                  subscription_plan: "claude_max",
                  billing_verified: true,
                  extra_usage_credits: true,
                },
              },
            ],
          };
        }
        if (path === "/api/model/info")
          return { provider: "anthropic", model: "claude-sonnet-4-6" };
        if (path === "/api/providers/oauth/anthropic") return {};
        return {
          capacity: "available",
          inference: "passed",
          privacy_accepted: true,
          retention_bounded: true,
          third_party_permission_granted: true,
          credential_healthy: true,
          reconnect_supported: true,
          production_use_approved: true,
        };
      },
    });

    await expect(
      adapter.startAuthorization({ operatorId: "operator", userId: "owner", reconnecting: false }),
    ).resolves.toMatchObject({ ok: true, authorization: { sessionId: "anthropic-session-1" } });
    await expect(
      adapter.pollAuthorization({
        operatorId: "operator",
        userId: "owner",
        sessionId: "anthropic-session-1",
      }),
    ).resolves.toMatchObject({ state: "authorized", providerIdentity: "claude-account-123" });
    await expect(
      adapter.verifyConnection({
        operatorId: "operator",
        userId: "owner",
        providerIdentity: "claude-account-123",
      }),
    ).resolves.toMatchObject({
      eligibleAccount: true,
      billingVerified: true,
      privacyAccepted: true,
      retentionBounded: true,
      approvedModelAssigned: true,
    });
    await expect(
      adapter.revokeAuthorization({
        operatorId: "operator",
        userId: "owner",
        providerIdentity: "claude-account-123",
      }),
    ).resolves.toEqual({ providerRevoked: true });

    expect(requests.map(({ path }) => path)).toEqual([
      "/api/providers/oauth/anthropic/start",
      "/api/providers/oauth/anthropic/poll/anthropic-session-1",
      "/api/providers/oauth",
      "/api/model/info",
      "/api/status",
      "/api/providers/oauth/anthropic",
    ]);
    expect(requests.every(({ body }) => !/token|setup-token|api.?key/i.test(body ?? ""))).toBe(
      true,
    );
  });

  it("runs the shared lifecycle against Anthropic and stays blocked without active consent", async () => {
    const connection = createDatabaseConnection();
    const now = new Date("2026-08-19T01:00:00.000Z");
    try {
      await reset(connection);
      await connection.db.insert(users).values({ id: OWNER_ID });
      const operator = await ensureFounderOperatorForUser(OWNER_ID, {
        createConnection: () => connection,
        now: () => now,
      });
      await confirmFounderTimezoneForUser(OWNER_ID, "Asia/Manila", {
        createConnection: () => connection,
        now: () => now,
      });
      await connection.db.update(operatorPreparations).set({ status: "ready", completedAt: now });
      await connection.db.update(operatorRuntimes).set({
        status: "ready",
        transportState: "connected",
        safetyState: "verified",
        readyAt: now,
      });

      const adapter = {
        startAuthorization: async () => ({
          ok: true as const,
          authorization: {
            sessionId: "anthropic-session-lifecycle",
            authorizationUrl: "https://console.anthropic.com/oauth/authorize",
            userCode: "CLAUDE-CODE",
            expiresAt: new Date("2026-08-19T01:15:00.000Z"),
          },
        }),
        pollAuthorization: async () => ({
          state: "authorized" as const,
          providerIdentity: "claude-account-lifecycle",
          accountLabel: "Founder Claude",
        }),
        verifyConnection: async () => ({
          ...readyAnthropic,
          providerIdentity: "claude-account-lifecycle",
        }),
        revokeAuthorization: async () => ({ providerRevoked: true }),
      };

      const started = await startFounderAnthropicAuthorizationForUser(OWNER_ID, {
        createConnection: () => connection,
        adapter,
        now: () => now,
        anthropicReleased: true,
      });
      const [ai] = await connection.db
        .select()
        .from(operatorAiConnections)
        .where(eq(operatorAiConnections.operatorId, operator.id));
      expect(ai?.id).toBeTruthy();
      const pending = await pollFounderAnthropicAuthorizationForUser(
        OWNER_ID,
        started.authorization?.sessionId ?? "",
        { createConnection: () => connection, adapter, now: () => now, anthropicReleased: true },
      );
      expect(pending.status).toBe("needs_attention");

      const [calendar] = await connection.db
        .insert(operatorCalendarConnections)
        .values({ operatorId: (ai as typeof operatorAiConnections.$inferSelect).operatorId })
        .returning();
      await connection.db.insert(operatorProcessingConsents).values({
        operatorId: operator.id,
        aiConnectionId: ai?.id ?? "00000000-0000-4000-8000-000000000000",
        calendarConnectionId: calendar?.id ?? "00000000-0000-4000-8000-000000000000",
        purpose: "calendar_morning_brief",
        status: "active",
        confirmedAt: now,
        createdAt: now,
      });
      const reauthorized = await startFounderAnthropicAuthorizationForUser(OWNER_ID, {
        createConnection: () => connection,
        adapter,
        now: () => now,
        anthropicReleased: true,
      });
      const ready = await pollFounderAnthropicAuthorizationForUser(
        OWNER_ID,
        reauthorized.authorization?.sessionId ?? "",
        { createConnection: () => connection, adapter, now: () => now, anthropicReleased: true },
      );
      expect(ready.status).toBe("ready");
      const [persisted] = await connection.db
        .select()
        .from(operatorAiConnections)
        .where(eq(operatorAiConnections.id, ai?.id ?? ""));
      expect(persisted).toMatchObject({
        billingVerified: true,
        privacyAccepted: true,
        retentionBounded: true,
        thirdPartyPermissionGranted: true,
        credentialHealthy: true,
        reconnectSupported: true,
        productionUseApproved: true,
        processingConsentActive: true,
        approvedModelAssignment: "anthropic-claude",
      });
    } finally {
      await reset(connection);
      await connection.close();
    }
  });
});

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table operator_processing_consents, operator_calendar_connections, operator_ai_connection_receipts, operator_ai_connections, operator_runtimes, operator_preparations, operators, users restart identity cascade",
  );
}
