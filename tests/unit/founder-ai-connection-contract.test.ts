import { describe, expect, it } from "vitest";
import {
  createHermesOpenAiAdapter,
  evaluateFounderOpenAiReadiness,
  type FounderOpenAiReadinessInput,
} from "@/src/server/operators/founder-ai-connection";

const readyInput: FounderOpenAiReadinessInput = {
  providerIdentity: "acct_founder_123",
  accountLabel: "founder@example.com",
  eligibleAccount: true,
  authorizationPersisted: true,
  approvedModelAssigned: true,
  capacity: "available",
  inference: "passed",
};

describe("Founder OpenAI connection readiness contract", () => {
  it("is ready only when every provider gate is proven", () => {
    expect(evaluateFounderOpenAiReadiness(readyInput)).toEqual({ ok: true });
  });

  it.each([
    ["immutable provider identity", { providerIdentity: null }, "provider_identity_missing"],
    ["eligible account", { eligibleAccount: false }, "account_not_eligible"],
    ["persisted authorization", { authorizationPersisted: false }, "authorization_not_persisted"],
    ["approved model", { approvedModelAssigned: false }, "approved_model_missing"],
    ["current capacity", { capacity: "exhausted" }, "capacity_unavailable"],
    ["bounded inference", { inference: "failed" }, "inference_failed"],
  ] as const)("blocks readiness when %s is not proven", (_gate, override, code) => {
    expect(evaluateFounderOpenAiReadiness({ ...readyInput, ...override })).toEqual({
      ok: false,
      code,
    });
  });

  it("treats an explicit denial or expired authorization as a recoverable failure", () => {
    expect(
      evaluateFounderOpenAiReadiness({
        ...readyInput,
        authorizationPersisted: false,
        authorizationState: "denied",
      }),
    ).toEqual({ ok: false, code: "authorization_denied" });
    expect(
      evaluateFounderOpenAiReadiness({
        ...readyInput,
        authorizationPersisted: false,
        authorizationState: "expired",
      }),
    ).toEqual({ ok: false, code: "authorization_expired" });
  });

  it("uses Hermes structured OpenAI surfaces without forwarding credentials to the browser", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    const adapter = createHermesOpenAiAdapter({
      request: async (path, init) => {
        requests.push({ path, method: init?.method ?? "GET" });
        if (path.endsWith("/start")) {
          return {
            session_id: "session-1",
            user_code: "ABCD-EFGH",
            verification_url: "https://auth.openai.com/codex/device",
            expires_in: 900,
          };
        }
        if (path.includes("/poll/")) return { status: "approved", account_id: "acct_founder_123" };
        if (path === "/api/providers/oauth") {
          return {
            providers: [
              {
                id: "openai-codex",
                account_id: "acct_founder_123",
                account_label: "founder@example.com",
                status: { logged_in: true },
              },
            ],
          };
        }
        if (path === "/api/model/info") return { provider: "openai-codex", model: "gpt-5.4" };
        return { capacity: "available", inference: "passed" };
      },
    });

    const authorization = await adapter.startAuthorization({
      operatorId: "operator",
      userId: "owner",
      reconnecting: false,
    });
    expect(authorization).toMatchObject({ ok: true, authorization: { sessionId: "session-1" } });
    await expect(
      adapter.pollAuthorization({
        operatorId: "operator",
        userId: "owner",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ state: "authorized", providerIdentity: "acct_founder_123" });
    await expect(
      adapter.verifyConnection({
        operatorId: "operator",
        userId: "owner",
        providerIdentity: "acct_founder_123",
      }),
    ).resolves.toMatchObject({
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
        providerIdentity: "acct_founder_123",
      }),
    ).resolves.toEqual({ providerRevoked: true });
    expect(requests.map(({ path }) => path)).toEqual([
      "/api/providers/oauth/openai-codex/start",
      "/api/providers/oauth/openai-codex/poll/session-1",
      "/api/providers/oauth",
      "/api/model/info",
      "/api/status",
      "/api/providers/oauth/openai-codex",
    ]);
  });

  it("maps Hermes denial, expiry, quota, and revoke failures to safe states", async () => {
    for (const [status, expected] of [
      ["denied", "denied"],
      ["expired", "expired"],
    ] as const) {
      const adapter = createHermesOpenAiAdapter({
        request: async (path) => (path.includes("/poll/") ? { status } : { providers: [] }),
      });
      await expect(
        adapter.pollAuthorization({
          operatorId: "operator",
          userId: "owner",
          sessionId: "session-1",
        }),
      ).resolves.toEqual({ state: expected });
    }

    const unavailable = createHermesOpenAiAdapter({
      request: async (path) => {
        if (path === "/api/providers/oauth") {
          return {
            providers: [{ id: "openai-codex", account_id: "acct", status: { logged_in: false } }],
          };
        }
        if (path === "/api/model/info") return { provider: "openai-codex", model: "gpt-5.4" };
        return { capacity: "exhausted", inference: "failed" };
      },
    });
    await expect(
      unavailable.verifyConnection({
        operatorId: "operator",
        userId: "owner",
        providerIdentity: "acct",
      }),
    ).resolves.toMatchObject({
      eligibleAccount: false,
      authorizationPersisted: false,
      capacity: "exhausted",
      inference: "failed",
    });

    const revokeFailed = createHermesOpenAiAdapter({
      request: async () => {
        throw new Error("provider unavailable");
      },
    });
    await expect(
      revokeFailed.revokeAuthorization({
        operatorId: "operator",
        userId: "owner",
        providerIdentity: "acct",
      }),
    ).resolves.toEqual({ providerRevoked: false });
  });
});
