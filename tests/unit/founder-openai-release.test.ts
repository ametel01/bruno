import { describe, expect, it } from "vitest";
import {
  evaluateFounderOpenAiRelease,
  FOUNDER_OPENAI_CONNECTED_ACCEPTANCE_SCHEMA,
  FOUNDER_OPENAI_POLICY_VERSION,
} from "@/src/server/operators/founder-openai-release";

const REVISION = "a".repeat(40);
const NOW = new Date("2026-08-20T10:00:00.000Z");

function release(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: FOUNDER_OPENAI_CONNECTED_ACCEPTANCE_SCHEMA,
    outcome: "passed",
    provider: "openai",
    accountClass: "founder_owned_eligible_subscription",
    authorizationRoute: "hermes_structured_oauth",
    policyVersion: FOUNDER_OPENAI_POLICY_VERSION,
    sourceRevision: REVISION,
    operatorReleaseRevision: REVISION,
    hermesReleaseRevision: "b".repeat(40),
    qualifiedAt: "2026-08-20T09:00:00.000Z",
    expiresAt: "2026-08-27T09:00:00.000Z",
    evidenceDigest: `sha256:${"c".repeat(64)}`,
    gates: {
      immutableIdentity: true,
      persistedAfterRestart: true,
      approvedModelInference: true,
      capacityAndQuota: true,
      privacyDisclosure: true,
      revocationAndRecovery: true,
      noFundedOrRawKeyFallback: true,
      cleanup: true,
    },
    ...overrides,
  });
}

describe("Founder OpenAI release evidence", () => {
  it("releases only a complete current record bound to the deployed revision", () => {
    expect(
      evaluateFounderOpenAiRelease(
        {
          VERCEL_GIT_COMMIT_SHA: REVISION,
          BRUNO_OPENAI_CONNECTED_ACCEPTANCE_RELEASE: release(),
        },
        NOW,
      ),
    ).toMatchObject({ released: true, evidence: { policyVersion: 2 } });
  });

  it.each([
    ["missing", {}, "connected_acceptance_missing"],
    [
      "wrong revision",
      { BRUNO_OPENAI_CONNECTED_ACCEPTANCE_RELEASE: release() },
      "operator_release_identity_missing",
    ],
    [
      "failed gate",
      {
        VERCEL_GIT_COMMIT_SHA: REVISION,
        BRUNO_OPENAI_CONNECTED_ACCEPTANCE_RELEASE: release({
          gates: { immutableIdentity: false },
        }),
      },
      "connected_acceptance_mismatch",
    ],
    [
      "expired",
      {
        VERCEL_GIT_COMMIT_SHA: REVISION,
        BRUNO_OPENAI_CONNECTED_ACCEPTANCE_RELEASE: release({
          qualifiedAt: "2026-08-10T09:00:00.000Z",
          expiresAt: "2026-08-18T09:00:00.000Z",
        }),
      },
      "connected_acceptance_stale",
    ],
  ])("fails closed when evidence is %s", (_name, environment, reason) => {
    expect(evaluateFounderOpenAiRelease(environment, NOW)).toEqual({ released: false, reason });
  });
});
