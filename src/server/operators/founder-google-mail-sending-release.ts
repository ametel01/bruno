import "server-only";

import { timingSafeEqual } from "node:crypto";

export const FOUNDER_GOOGLE_MAIL_SENDING_ACCEPTANCE_SCHEMA =
  "bruno.founder-google-mail-sending-connected-acceptance.v1";
export const FOUNDER_GOOGLE_MAIL_SENDING_ACCEPTANCE_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
export const FOUNDER_GOOGLE_MAIL_SENDING_POLICY_VERSION = 1;

type ReleaseEnvironment = Record<string, string | undefined>;

export type FounderGoogleMailSendingAcceptanceRelease = {
  schemaVersion: typeof FOUNDER_GOOGLE_MAIL_SENDING_ACCEPTANCE_SCHEMA;
  outcome: "passed";
  provider: "google";
  capability: "gmail_sending";
  accountClass: "founder_owned_google_account";
  authorizationRoute: "google_oauth_web_server";
  deliveryRoute: "gmail_users_messages_send";
  requiredScope: "https://www.googleapis.com/auth/gmail.send";
  policyVersion: typeof FOUNDER_GOOGLE_MAIL_SENDING_POLICY_VERSION;
  sourceRevision: string;
  operatorReleaseRevision: string;
  qualifiedAt: string;
  expiresAt: string;
  readingIdentityDigest: `sha256:${string}`;
  sendingIdentityDigest: `sha256:${string}`;
  approvedMessageDigest: `sha256:${string}`;
  providerAcknowledgementDigest: `sha256:${string}`;
  deliveryVerificationDigest: `sha256:${string}`;
  evidenceDigest: `sha256:${string}`;
  gates: {
    sameImmutableIdentity: true;
    sendScopeOnly: true;
    persistedAfterRestart: true;
    approvedControlledMessage: true;
    providerAcknowledged: true;
    independentlyDelivered: true;
    exactlyOneCopy: true;
    uncertainNoSpeculativeResend: true;
    revocationIsolationAndRecovery: true;
    cleanup: true;
  };
};

export type FounderGoogleMailSendingReleaseDecision =
  | { released: true; evidence: FounderGoogleMailSendingAcceptanceRelease }
  | { released: false; reason: string };

export function evaluateFounderGoogleMailSendingRelease(
  environment: ReleaseEnvironment = process.env,
  now = new Date(),
): FounderGoogleMailSendingReleaseDecision {
  const raw = environment.BRUNO_GOOGLE_MAIL_SENDING_CONNECTED_ACCEPTANCE_RELEASE?.trim();
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
    value.schemaVersion !== FOUNDER_GOOGLE_MAIL_SENDING_ACCEPTANCE_SCHEMA ||
    value.outcome !== "passed" ||
    value.provider !== "google" ||
    value.capability !== "gmail_sending" ||
    value.accountClass !== "founder_owned_google_account" ||
    value.authorizationRoute !== "google_oauth_web_server" ||
    value.deliveryRoute !== "gmail_users_messages_send" ||
    value.requiredScope !== "https://www.googleapis.com/auth/gmail.send" ||
    value.policyVersion !== FOUNDER_GOOGLE_MAIL_SENDING_POLICY_VERSION ||
    !safeEqual(value.sourceRevision, revision) ||
    !safeEqual(value.operatorReleaseRevision, revision) ||
    !isEvidenceDigest(value.readingIdentityDigest) ||
    !isEvidenceDigest(value.sendingIdentityDigest) ||
    !safeEqual(value.sendingIdentityDigest, value.readingIdentityDigest) ||
    !isEvidenceDigest(value.approvedMessageDigest) ||
    !isEvidenceDigest(value.providerAcknowledgementDigest) ||
    !isEvidenceDigest(value.deliveryVerificationDigest) ||
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
    expiresAt.getTime() - qualifiedAt.getTime() > FOUNDER_GOOGLE_MAIL_SENDING_ACCEPTANCE_MAX_AGE_MS
  ) {
    return { released: false, reason: "connected_acceptance_stale" };
  }

  return { released: true, evidence: value as FounderGoogleMailSendingAcceptanceRelease };
}

export function isFounderGoogleMailSendingReleased(
  environment: ReleaseEnvironment = process.env,
  now = new Date(),
): boolean {
  return evaluateFounderGoogleMailSendingRelease(environment, now).released;
}

function allRequiredGatesPassed(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    "sameImmutableIdentity",
    "sendScopeOnly",
    "persistedAfterRestart",
    "approvedControlledMessage",
    "providerAcknowledged",
    "independentlyDelivered",
    "exactlyOneCopy",
    "uncertainNoSpeculativeResend",
    "revocationIsolationAndRecovery",
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

function safeEqual(value: unknown, expected: unknown): boolean {
  if (typeof value !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
