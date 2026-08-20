import { describe, expect, it } from "vitest";
import {
  ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY,
  type FounderAiRoutingCandidate,
  getActiveFounderAiCompatibilityPolicy,
  isEligibleFounderAiConnection,
  selectFounderAiProvider,
  selectFounderAiProviderAtCheckpoint,
} from "@/src/server/operators/founder-ai-routing";

const NOW = new Date("2026-08-19T02:00:00.000Z");
const MULTI_PROVIDER_POLICY = {
  ...ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY,
  providers: {
    ...ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY.providers,
    openai: {
      ...ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY.providers.openai,
      released: true,
    },
    anthropic: {
      ...ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY.providers.anthropic,
      released: true,
    },
  },
};

function candidate(
  provider: "openai" | "anthropic",
  overrides: Partial<FounderAiRoutingCandidate> = {},
): FounderAiRoutingCandidate {
  return {
    id: `${provider}-connection`,
    provider,
    providerSubjectId: `${provider}-account`,
    accountLabel: `${provider}@example.com`,
    status: "ready",
    authorizationState: "authorized",
    capacityState: "available",
    inferenceState: "passed",
    eligibleAccount: true,
    authorizationPersisted: true,
    approvedModelAssignment: provider === "openai" ? "openai-codex" : "anthropic-claude",
    authorizationGeneration: 1,
    lastVerifiedAt: NOW,
    revokedAt: null,
    disconnectedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("Founder AI compatibility routing", () => {
  it("uses deterministic policy priority and records the selected account", () => {
    const selected = selectFounderAiProvider(
      [
        candidate("anthropic", { updatedAt: new Date("2026-08-19T01:59:00.000Z") }),
        candidate("openai", { updatedAt: new Date("2026-08-19T01:00:00.000Z") }),
      ],
      { now: NOW, policy: MULTI_PROVIDER_POLICY },
    );

    expect(selected).toMatchObject({
      connectionId: "openai-connection",
      provider: "openai",
      providerSubjectId: "openai-account",
      accountLabel: "openai@example.com",
      approvedModelAssignment: "openai-codex",
      policyVersion: 2,
    });
  });

  it("keeps OpenAI unroutable when current Connected Acceptance is absent", () => {
    expect(
      selectFounderAiProvider([candidate("openai")], {
        now: NOW,
        policy: getActiveFounderAiCompatibilityPolicy(false),
      }),
    ).toBeNull();
  });

  it("keeps provider releases independent in the active routing policy", () => {
    const openAiOnly = getActiveFounderAiCompatibilityPolicy(true, false);
    const anthropicOnly = getActiveFounderAiCompatibilityPolicy(false, true);

    expect(
      selectFounderAiProvider([candidate("openai"), candidate("anthropic")], {
        now: NOW,
        policy: openAiOnly,
      }),
    ).toMatchObject({ provider: "openai" });
    expect(
      selectFounderAiProvider([candidate("openai"), candidate("anthropic")], {
        now: NOW,
        policy: anthropicOnly,
      }),
    ).toMatchObject({ provider: "anthropic" });
  });

  it("fails over only when the checkpoint explicitly excludes the failed provider", () => {
    const connections = [candidate("openai"), candidate("anthropic")];
    expect(
      selectFounderAiProvider(connections, { now: NOW, policy: MULTI_PROVIDER_POLICY }),
    ).toMatchObject({
      provider: "openai",
    });
    expect(
      selectFounderAiProviderAtCheckpoint(connections, "openai", {
        now: NOW,
        policy: MULTI_PROVIDER_POLICY,
      }),
    ).toMatchObject({ connectionId: "anthropic-connection", provider: "anthropic" });
  });

  it("pauses when all providers fail, then recovers after one becomes ready", () => {
    const unavailable = [
      candidate("openai", { capacityState: "exhausted" }),
      candidate("anthropic", { status: "needs_attention" }),
    ];
    expect(
      selectFounderAiProvider(unavailable, { now: NOW, policy: MULTI_PROVIDER_POLICY }),
    ).toBeNull();

    const recovered = selectFounderAiProvider(
      [
        candidate("openai", {
          capacityState: "available",
          updatedAt: new Date("2026-08-19T02:01:00.000Z"),
        }),
        candidate("anthropic", { status: "needs_attention" }),
      ],
      { now: new Date("2026-08-19T02:02:00.000Z"), policy: MULTI_PROVIDER_POLICY },
    );
    expect(recovered).toMatchObject({ provider: "openai", connectionId: "openai-connection" });
  });

  it("removes revoked and stale accounts without speculative duplication", () => {
    const stale = candidate("openai", {
      lastVerifiedAt: new Date("2026-08-19T01:00:00.000Z"),
    });
    expect(isEligibleFounderAiConnection(stale, { now: NOW, policy: MULTI_PROVIDER_POLICY })).toBe(
      false,
    );
    expect(
      selectFounderAiProvider([stale, candidate("anthropic")], {
        now: NOW,
        policy: MULTI_PROVIDER_POLICY,
      }),
    ).toMatchObject({ provider: "anthropic" });
    expect(
      selectFounderAiProvider([candidate("openai", { revokedAt: NOW }), candidate("anthropic")], {
        now: NOW,
        policy: MULTI_PROVIDER_POLICY,
      }),
    ).toMatchObject({ provider: "anthropic" });
  });
});
