import "server-only";

import { timingSafeEqual } from "node:crypto";

export const FOUNDER_GOOGLE_CONNECTED_ACCEPTANCE_SCHEMA =
  "bruno.founder-google-connected-acceptance.v1";
export const FOUNDER_GOOGLE_CONNECTED_ACCEPTANCE_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
export const FOUNDER_GOOGLE_CONNECTED_ACCEPTANCE_POLICY_VERSION = 1;

type ReleaseEnvironment = Record<string, string | undefined>;
type GoogleReadingCapability = "calendar_reading" | "gmail_reading";

export type FounderGoogleConnectedAcceptanceRelease = {
  schemaVersion: typeof FOUNDER_GOOGLE_CONNECTED_ACCEPTANCE_SCHEMA;
  outcome: "passed";
  provider: "google";
  capability: GoogleReadingCapability;
  accountClass: "founder_owned_google_account";
  authorizationRoute: "google_oauth_web_server";
  policyVersion: typeof FOUNDER_GOOGLE_CONNECTED_ACCEPTANCE_POLICY_VERSION;
  sourceRevision: string;
  operatorReleaseRevision: string;
  qualifiedAt: string;
  expiresAt: string;
  evidenceDigest: `sha256:${string}`;
  gates: {
    returnedScopes: true;
    immutableSubjectIdentity: true;
    selectedResourceNarrowing: true;
    zeroAndPopulatedResults: true;
    refreshPersistsAfterRestart: true;
    omittedRefreshTokenPreserved: true;
    denialPartialExpiryAdminAndStale: true;
    revocationAndReauthorization: true;
    siblingRevocationIsolation: true;
    cleanup: true;
    restrictedScopeVerification?: true;
    casaDisposition?: true;
    aiLimitedUse?: true;
    retentionDeletionDisclosure?: true;
  };
};

export type FounderGoogleReleaseDecision =
  | { released: true; evidence: FounderGoogleConnectedAcceptanceRelease }
  | { released: false; reason: string };

export function evaluateFounderGoogleCalendarRelease(
  environment: ReleaseEnvironment = process.env,
  now = new Date(),
): FounderGoogleReleaseDecision {
  return evaluateRelease(
    environment.BRUNO_GOOGLE_CALENDAR_CONNECTED_ACCEPTANCE_RELEASE,
    "calendar_reading",
    environment,
    now,
  );
}

export function evaluateFounderGoogleMailReadingRelease(
  environment: ReleaseEnvironment = process.env,
  now = new Date(),
): FounderGoogleReleaseDecision {
  return evaluateRelease(
    environment.BRUNO_GOOGLE_MAIL_READING_CONNECTED_ACCEPTANCE_RELEASE,
    "gmail_reading",
    environment,
    now,
  );
}

export function isFounderGoogleCalendarReleased(
  environment: ReleaseEnvironment = process.env,
  now = new Date(),
): boolean {
  return evaluateFounderGoogleCalendarRelease(environment, now).released;
}

export function isFounderGoogleMailReadingReleased(
  environment: ReleaseEnvironment = process.env,
  now = new Date(),
): boolean {
  return evaluateFounderGoogleMailReadingRelease(environment, now).released;
}

function evaluateRelease(
  rawValue: string | undefined,
  capability: GoogleReadingCapability,
  environment: ReleaseEnvironment,
  now: Date,
): FounderGoogleReleaseDecision {
  const raw = rawValue?.trim();
  if (!raw) return { released: false, reason: "connected_acceptance_missing" };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { released: false, reason: "connected_acceptance_invalid" };
  }
  if (!isRecord(value)) return { released: false, reason: "connected_acceptance_invalid" };

  const revision = environment.VERCEL_GIT_COMMIT_SHA?.trim();
  if (!revision || !isGitRevision(revision)) {
    return { released: false, reason: "operator_release_identity_missing" };
  }
  if (
    value.schemaVersion !== FOUNDER_GOOGLE_CONNECTED_ACCEPTANCE_SCHEMA ||
    value.outcome !== "passed" ||
    value.provider !== "google" ||
    value.capability !== capability ||
    value.accountClass !== "founder_owned_google_account" ||
    value.authorizationRoute !== "google_oauth_web_server" ||
    value.policyVersion !== FOUNDER_GOOGLE_CONNECTED_ACCEPTANCE_POLICY_VERSION ||
    !safeEqual(value.sourceRevision, revision) ||
    !safeEqual(value.operatorReleaseRevision, revision) ||
    !isEvidenceDigest(value.evidenceDigest) ||
    !allRequiredGatesPassed(value.gates, capability)
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
    expiresAt.getTime() - qualifiedAt.getTime() > FOUNDER_GOOGLE_CONNECTED_ACCEPTANCE_MAX_AGE_MS
  ) {
    return { released: false, reason: "connected_acceptance_stale" };
  }

  return { released: true, evidence: value as FounderGoogleConnectedAcceptanceRelease };
}

function allRequiredGatesPassed(value: unknown, capability: GoogleReadingCapability): boolean {
  if (!isRecord(value)) return false;
  const common = [
    "returnedScopes",
    "immutableSubjectIdentity",
    "selectedResourceNarrowing",
    "zeroAndPopulatedResults",
    "refreshPersistsAfterRestart",
    "omittedRefreshTokenPreserved",
    "denialPartialExpiryAdminAndStale",
    "revocationAndReauthorization",
    "siblingRevocationIsolation",
    "cleanup",
  ];
  const mailOnly = [
    "restrictedScopeVerification",
    "casaDisposition",
    "aiLimitedUse",
    "retentionDeletionDisclosure",
  ];
  return [...common, ...(capability === "gmail_reading" ? mailOnly : [])].every(
    (key) => value[key] === true,
  );
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
