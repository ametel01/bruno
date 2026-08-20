export const TEST_OPENAI_RELEASE_REVISION = "a".repeat(40);

/**
 * Deterministic test harnesses exercise the product path after provider
 * release. This fixture never enters a production environment and cannot
 * match a real deployment revision.
 */
export function buildTestOpenAiConnectedAcceptanceRelease(now = new Date()): string {
  return JSON.stringify({
    schemaVersion: "bruno.founder-openai-connected-acceptance.v1",
    outcome: "passed",
    provider: "openai",
    accountClass: "founder_owned_eligible_subscription",
    authorizationRoute: "hermes_structured_oauth",
    policyVersion: 2,
    sourceRevision: TEST_OPENAI_RELEASE_REVISION,
    operatorReleaseRevision: TEST_OPENAI_RELEASE_REVISION,
    hermesReleaseRevision: "b".repeat(40),
    qualifiedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
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
  });
}
