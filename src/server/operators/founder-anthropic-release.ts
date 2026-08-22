import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { readFounderApplicationRevision } from "@/src/server/founder-product-contract/application-revision";

export const FOUNDER_ANTHROPIC_ACCEPTANCE_SCHEMA =
  "bruno.founder-anthropic-connected-acceptance.v1";
export const FOUNDER_ANTHROPIC_ACCEPTANCE_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
export const FOUNDER_ANTHROPIC_COMPATIBILITY_POLICY_ID =
  "bruno.founder-anthropic-compatibility-policy.v1";
export const FOUNDER_ANTHROPIC_COMPATIBILITY_POLICY = {
  authorizationRoute: "hermes_anthropic_oauth",
  billing: "claude_max_with_purchased_extra_usage_credits",
  credentialHandling: "hermes_managed_refreshable_oauth_no_raw_credential",
  approvedModel: "claude-sonnet-4-6",
  privacy: "consumer_model_improvement_and_safety_review_disclosed",
  retention: "consumer_retention_and_deletion_limits_disclosed",
  fallback: "none",
} as const;
export const FOUNDER_ANTHROPIC_COMPATIBILITY_POLICY_DIGEST = `sha256:${createHash("sha256")
  .update(JSON.stringify(FOUNDER_ANTHROPIC_COMPATIBILITY_POLICY))
  .digest("hex")}` as const;

type ReleaseEnvironment = Record<string, string | undefined>;

export type FounderAnthropicAcceptanceRelease = {
  schemaVersion: typeof FOUNDER_ANTHROPIC_ACCEPTANCE_SCHEMA;
  outcome: "passed";
  provider: "anthropic";
  capability: "claude_inference";
  accountClass: "founder_owned_anthropic_account";
  authorizationRoute: "hermes_anthropic_oauth";
  credentialMode: "hermes_managed_refreshable_oauth";
  compatibilityPolicyId: typeof FOUNDER_ANTHROPIC_COMPATIBILITY_POLICY_ID;
  compatibilityPolicyDigest: typeof FOUNDER_ANTHROPIC_COMPATIBILITY_POLICY_DIGEST;
  sourceRevision: string;
  operatorReleaseRevision: string;
  qualifiedAt: string;
  expiresAt: string;
  accountIdentityDigest: `sha256:${string}`;
  privacyDisclosureDigest: `sha256:${string}`;
  evidenceDigest: `sha256:${string}`;
  gates: {
    immutableAccountIdentity: true;
    eligiblePlanAndBilling: true;
    authorizationPersistedAfterRestart: true;
    approvedModelInference: true;
    capacityBehavior: true;
    permissionsReviewed: true;
    credentialHandlingReviewed: true;
    privacyAndModelImprovementReviewed: true;
    retentionAndDeletionReviewed: true;
    revocationExpiryQuotaRestartReconnect: true;
    checkpointSafeRouting: true;
    noRawCredentialCollection: true;
    noBrunoFundedFallback: true;
    cleanup: true;
  };
};

export type FounderAnthropicReleaseDecision =
  | { released: true; evidence: FounderAnthropicAcceptanceRelease }
  | { released: false; reason: string };

export function evaluateFounderAnthropicRelease(
  environment: ReleaseEnvironment = process.env,
  now = new Date(),
): FounderAnthropicReleaseDecision {
  const raw = environment.BRUNO_ANTHROPIC_CONNECTED_ACCEPTANCE_RELEASE?.trim();
  if (!raw) return { released: false, reason: "connected_acceptance_missing" };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { released: false, reason: "connected_acceptance_invalid" };
  }
  if (!isRecord(value)) return { released: false, reason: "connected_acceptance_invalid" };

  const revision = readFounderApplicationRevision({ env: environment });
  if (!revision) {
    return { released: false, reason: "operator_release_identity_missing" };
  }
  if (
    value.schemaVersion !== FOUNDER_ANTHROPIC_ACCEPTANCE_SCHEMA ||
    value.outcome !== "passed" ||
    value.provider !== "anthropic" ||
    value.capability !== "claude_inference" ||
    value.accountClass !== "founder_owned_anthropic_account" ||
    value.authorizationRoute !== FOUNDER_ANTHROPIC_COMPATIBILITY_POLICY.authorizationRoute ||
    value.credentialMode !== "hermes_managed_refreshable_oauth" ||
    value.compatibilityPolicyId !== FOUNDER_ANTHROPIC_COMPATIBILITY_POLICY_ID ||
    !safeEqual(value.compatibilityPolicyDigest, FOUNDER_ANTHROPIC_COMPATIBILITY_POLICY_DIGEST) ||
    !safeEqual(value.sourceRevision, revision) ||
    !safeEqual(value.operatorReleaseRevision, revision) ||
    !isEvidenceDigest(value.accountIdentityDigest) ||
    !isEvidenceDigest(value.privacyDisclosureDigest) ||
    !isEvidenceDigest(value.evidenceDigest) ||
    !allRequiredGatesPassed(value.gates)
  ) {
    return { released: false, reason: "connected_acceptance_mismatch" };
  }

  const qualifiedAt = readDate(value.qualifiedAt);
  const expiresAt = readDate(value.expiresAt);
  if (!qualifiedAt || !expiresAt) {
    return { released: false, reason: "connected_acceptance_time_invalid" };
  }
  if (
    qualifiedAt.getTime() > now.getTime() ||
    expiresAt.getTime() <= now.getTime() ||
    expiresAt.getTime() - qualifiedAt.getTime() > FOUNDER_ANTHROPIC_ACCEPTANCE_MAX_AGE_MS
  ) {
    return { released: false, reason: "connected_acceptance_stale" };
  }

  return { released: true, evidence: value as FounderAnthropicAcceptanceRelease };
}

export function isFounderAnthropicReleased(
  environment: ReleaseEnvironment = process.env,
  now = new Date(),
): boolean {
  return evaluateFounderAnthropicRelease(environment, now).released;
}

function allRequiredGatesPassed(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    "immutableAccountIdentity",
    "eligiblePlanAndBilling",
    "authorizationPersistedAfterRestart",
    "approvedModelInference",
    "capacityBehavior",
    "permissionsReviewed",
    "credentialHandlingReviewed",
    "privacyAndModelImprovementReviewed",
    "retentionAndDeletionReviewed",
    "revocationExpiryQuotaRestartReconnect",
    "checkpointSafeRouting",
    "noRawCredentialCollection",
    "noBrunoFundedFallback",
    "cleanup",
  ].every((key) => value[key] === true);
}

function isEvidenceDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? null : date;
}

function safeEqual(value: unknown, expected: unknown): boolean {
  if (typeof value !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
