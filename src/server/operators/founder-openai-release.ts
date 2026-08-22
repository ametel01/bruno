import "server-only";

import { timingSafeEqual } from "node:crypto";
import { readFounderApplicationRevision } from "@/src/server/founder-product-contract/application-revision";

export const FOUNDER_OPENAI_CONNECTED_ACCEPTANCE_SCHEMA =
  "bruno.founder-openai-connected-acceptance.v1";
export const FOUNDER_OPENAI_CONNECTED_ACCEPTANCE_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
export const FOUNDER_OPENAI_POLICY_VERSION = 2;

type ReleaseEnvironment = Record<string, string | undefined>;

export type FounderOpenAiConnectedAcceptanceRelease = {
  schemaVersion: typeof FOUNDER_OPENAI_CONNECTED_ACCEPTANCE_SCHEMA;
  outcome: "passed";
  provider: "openai";
  accountClass: "founder_owned_eligible_subscription";
  authorizationRoute: "hermes_structured_oauth";
  policyVersion: typeof FOUNDER_OPENAI_POLICY_VERSION;
  sourceRevision: string;
  operatorReleaseRevision: string;
  hermesReleaseRevision: string;
  qualifiedAt: string;
  expiresAt: string;
  evidenceDigest: `sha256:${string}`;
  gates: {
    immutableIdentity: true;
    persistedAfterRestart: true;
    approvedModelInference: true;
    capacityAndQuota: true;
    privacyDisclosure: true;
    revocationAndRecovery: true;
    noFundedOrRawKeyFallback: true;
    cleanup: true;
  };
};

export type FounderOpenAiReleaseDecision =
  | { released: true; evidence: FounderOpenAiConnectedAcceptanceRelease }
  | { released: false; reason: string };

/**
 * OpenAI is a release-evidence decision, not a deployment feature flag.
 * The complete allowlisted acceptance record must be bound to the exact
 * deployed source revision and remain inside the weekly evidence window.
 */
export function evaluateFounderOpenAiRelease(
  environment: ReleaseEnvironment = process.env,
  now = new Date(),
): FounderOpenAiReleaseDecision {
  const raw = environment.BRUNO_OPENAI_CONNECTED_ACCEPTANCE_RELEASE?.trim();
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
    value.schemaVersion !== FOUNDER_OPENAI_CONNECTED_ACCEPTANCE_SCHEMA ||
    value.outcome !== "passed" ||
    value.provider !== "openai" ||
    value.accountClass !== "founder_owned_eligible_subscription" ||
    value.authorizationRoute !== "hermes_structured_oauth" ||
    value.policyVersion !== FOUNDER_OPENAI_POLICY_VERSION ||
    !safeEqual(value.sourceRevision, revision) ||
    !safeEqual(value.operatorReleaseRevision, revision) ||
    !isGitRevision(value.hermesReleaseRevision) ||
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
    expiresAt.getTime() - qualifiedAt.getTime() > FOUNDER_OPENAI_CONNECTED_ACCEPTANCE_MAX_AGE_MS
  ) {
    return { released: false, reason: "connected_acceptance_stale" };
  }

  return {
    released: true,
    evidence: value as FounderOpenAiConnectedAcceptanceRelease,
  };
}

export function isFounderOpenAiReleased(
  environment: ReleaseEnvironment = process.env,
  now = new Date(),
): boolean {
  return evaluateFounderOpenAiRelease(environment, now).released;
}

function allRequiredGatesPassed(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    "immutableIdentity",
    "persistedAfterRestart",
    "approvedModelInference",
    "capacityAndQuota",
    "privacyDisclosure",
    "revocationAndRecovery",
    "noFundedOrRawKeyFallback",
    "cleanup",
  ].every((key) => value[key] === true);
}

function isEvidenceDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isGitRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? null : date;
}

function safeEqual(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
