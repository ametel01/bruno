import { describe, expect, it } from "vitest";
import { buildTestAnthropicAcceptanceRelease } from "@/scripts/founder-anthropic-test-release";
import {
  evaluateFounderAnthropicRelease,
  FOUNDER_ANTHROPIC_ACCEPTANCE_SCHEMA,
  FOUNDER_ANTHROPIC_COMPATIBILITY_POLICY_DIGEST,
  FOUNDER_ANTHROPIC_COMPATIBILITY_POLICY_ID,
} from "@/src/server/operators/founder-anthropic-release";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const REVISION = "d".repeat(40);

function environment(overrides: Record<string, unknown> = {}) {
  const value = JSON.parse(buildTestAnthropicAcceptanceRelease(NOW, REVISION)) as Record<
    string,
    unknown
  >;
  return {
    VERCEL_GIT_COMMIT_SHA: REVISION,
    BRUNO_ANTHROPIC_CONNECTED_ACCEPTANCE_RELEASE: JSON.stringify({
      ...value,
      ...overrides,
    }),
  };
}

describe("Founder Anthropic release evidence", () => {
  it("releases only from a complete exact-policy and exact-revision record", () => {
    expect(evaluateFounderAnthropicRelease(environment(), NOW)).toMatchObject({
      released: true,
      evidence: {
        provider: "anthropic",
        compatibilityPolicyId: FOUNDER_ANTHROPIC_COMPATIBILITY_POLICY_ID,
        compatibilityPolicyDigest: FOUNDER_ANTHROPIC_COMPATIBILITY_POLICY_DIGEST,
        sourceRevision: REVISION,
      },
    });
  });

  it("rejects missing, stale, failed, policy-mismatched, and revision-mismatched records", () => {
    expect(evaluateFounderAnthropicRelease({}, NOW)).toEqual({
      released: false,
      reason: "connected_acceptance_missing",
    });
    expect(evaluateFounderAnthropicRelease(environment({ outcome: "failed" }), NOW)).toMatchObject({
      released: false,
      reason: "connected_acceptance_mismatch",
    });
    expect(
      evaluateFounderAnthropicRelease(
        environment({ compatibilityPolicyDigest: `sha256:${"9".repeat(64)}` }),
        NOW,
      ),
    ).toMatchObject({ released: false, reason: "connected_acceptance_mismatch" });
    expect(
      evaluateFounderAnthropicRelease(environment({ sourceRevision: "e".repeat(40) }), NOW),
    ).toMatchObject({ released: false, reason: "connected_acceptance_mismatch" });
    expect(
      evaluateFounderAnthropicRelease(environment({ expiresAt: NOW.toISOString() }), NOW),
    ).toMatchObject({ released: false, reason: "connected_acceptance_stale" });
  });

  it("rejects a partial compatibility run", () => {
    const partial = JSON.parse(buildTestAnthropicAcceptanceRelease(NOW, REVISION)) as {
      gates: Record<string, boolean>;
    };
    delete partial.gates.privacyAndModelImprovementReviewed;

    expect(
      evaluateFounderAnthropicRelease(
        {
          VERCEL_GIT_COMMIT_SHA: REVISION,
          BRUNO_ANTHROPIC_CONNECTED_ACCEPTANCE_RELEASE: JSON.stringify(partial),
        },
        NOW,
      ),
    ).toMatchObject({ released: false, reason: "connected_acceptance_mismatch" });
  });

  it("keeps the acceptance schema stable", () => {
    expect(FOUNDER_ANTHROPIC_ACCEPTANCE_SCHEMA).toBe(
      "bruno.founder-anthropic-connected-acceptance.v1",
    );
  });
});
