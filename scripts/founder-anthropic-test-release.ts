import { createHash } from "node:crypto";

const COMPATIBILITY_POLICY = {
  authorizationRoute: "hermes_anthropic_oauth",
  billing: "claude_max_with_purchased_extra_usage_credits",
  credentialHandling: "hermes_managed_refreshable_oauth_no_raw_credential",
  approvedModel: "claude-sonnet-4-6",
  privacy: "consumer_model_improvement_and_safety_review_disclosed",
  retention: "consumer_retention_and_deletion_limits_disclosed",
  fallback: "none",
} as const;

export function buildTestAnthropicAcceptanceRelease(
  now = new Date(),
  revision = "a".repeat(40),
): string {
  return JSON.stringify({
    schemaVersion: "bruno.founder-anthropic-connected-acceptance.v1",
    outcome: "passed",
    provider: "anthropic",
    capability: "claude_inference",
    accountClass: "founder_owned_anthropic_account",
    authorizationRoute: "hermes_anthropic_oauth",
    credentialMode: "hermes_managed_refreshable_oauth",
    compatibilityPolicyId: "bruno.founder-anthropic-compatibility-policy.v1",
    compatibilityPolicyDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(COMPATIBILITY_POLICY))
      .digest("hex")}`,
    sourceRevision: revision,
    operatorReleaseRevision: revision,
    qualifiedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    accountIdentityDigest: `sha256:${"3".repeat(64)}`,
    privacyDisclosureDigest: `sha256:${"4".repeat(64)}`,
    evidenceDigest: `sha256:${"5".repeat(64)}`,
    gates: {
      immutableAccountIdentity: true,
      eligiblePlanAndBilling: true,
      authorizationPersistedAfterRestart: true,
      approvedModelInference: true,
      capacityBehavior: true,
      permissionsReviewed: true,
      credentialHandlingReviewed: true,
      privacyAndModelImprovementReviewed: true,
      retentionAndDeletionReviewed: true,
      revocationExpiryQuotaRestartReconnect: true,
      checkpointSafeRouting: true,
      noRawCredentialCollection: true,
      noBrunoFundedFallback: true,
      cleanup: true,
    },
  });
}
