import { describe, expect, it } from "vitest";
import type { FounderAiAdapter } from "@/src/server/operators/founder-ai-connection";

type FounderAiProvider = "openai" | "anthropic";

export function runFounderAiAdapterConformanceSuite(input: {
  provider: FounderAiProvider;
  createAdapter: (
    request: (path: string, init?: RequestInit) => Promise<unknown>,
  ) => FounderAiAdapter;
}): void {
  describe(`${input.provider} provider adapter conformance`, () => {
    it("uses the structured OAuth lifecycle and keeps credentials server-side", async () => {
      const requests: Array<{ path: string; method: string; body?: string | undefined }> = [];
      const accountId = `${input.provider}-account-conformance`;
      const model = input.provider === "openai" ? "gpt-5.4" : "claude-sonnet-4-6";
      const adapter = input.createAdapter(async (path, init) => {
        requests.push({ path, method: init?.method ?? "GET", body: init?.body?.toString() });
        if (path.endsWith("/start")) {
          return {
            session_id: `${input.provider}-session-conformance`,
            user_code: "CONFORMANCE-CODE",
            verification_url: "https://provider.example/oauth/authorize",
            expires_in: 900,
          };
        }
        if (path.includes("/poll/")) {
          return { status: "approved", account_id: accountId, account: "Conformance Account" };
        }
        if (path === "/api/providers/oauth") {
          return {
            providers: [
              {
                id: input.provider === "openai" ? "openai-codex" : "anthropic",
                account_id: accountId,
                account_label: "Conformance Account",
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
        if (path === "/api/model/info") {
          return { provider: input.provider === "openai" ? "openai-codex" : "anthropic", model };
        }
        if (
          path === "/api/providers/oauth/anthropic" ||
          path === "/api/providers/oauth/openai-codex"
        ) {
          return {};
        }
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
      });

      await expect(
        adapter.startAuthorization({
          operatorId: "operator",
          userId: "owner",
          reconnecting: false,
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        adapter.pollAuthorization({
          operatorId: "operator",
          userId: "owner",
          sessionId: `${input.provider}-session-conformance`,
        }),
      ).resolves.toMatchObject({ state: "authorized", providerIdentity: accountId });
      await expect(
        adapter.verifyConnection({
          operatorId: "operator",
          userId: "owner",
          providerIdentity: accountId,
        }),
      ).resolves.toMatchObject({
        providerIdentity: accountId,
        eligibleAccount: true,
        authorizationPersisted: true,
        approvedModelAssigned: true,
        capacity: "available",
        inference: "passed",
      });
      await expect(
        adapter.revokeAuthorization({
          operatorId: "operator",
          userId: "owner",
          providerIdentity: accountId,
        }),
      ).resolves.toEqual({ providerRevoked: true });

      expect(requests.every(({ body }) => !/token|setup-token|api.?key/i.test(body ?? ""))).toBe(
        true,
      );
    });
  });
}
