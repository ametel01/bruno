import {
  isEvidenceDigest,
  isEvidenceRecord,
  isExactInstant,
  isGitRevision,
  isRuntimeRevision,
} from "@/scripts/founder-release-evidence-validation";

export const FOUNDER_ATTENDED_ACCESSIBILITY_SUMMARY_SCHEMA =
  "bruno.founder-attended-accessibility-summary.v1";

const SUMMARY_KEYS = [
  "schemaVersion",
  "assistiveTechnology",
  "browser",
  "applicationRevision",
  "runtimeRevision",
  "evidenceDigest",
  "osVersion",
  "browserVersion",
  "observedAt",
  "attempts",
  "failures",
  "flakes",
  "skips",
  "participantBoundary",
  "sanitized",
] as const;

const PARTICIPANT_BOUNDARY_KEYS = [
  "independentHumanReviewers",
  "automatedRuns",
  "ownerParticipants",
  "selfTests",
  "friendOrFamilyParticipants",
  "supportInterventions",
  "externalBetaParticipants",
  "coachedParticipants",
  "facilitatorRescues",
  "trustedPreviewParticipants",
  "buildTeamParticipants",
] as const;

type AssistiveTechnology = "VoiceOver" | "TalkBack";
type AccessibilityBrowser = "Safari" | "Chrome";

export type FounderAttendedAccessibilitySummary = {
  schemaVersion: typeof FOUNDER_ATTENDED_ACCESSIBILITY_SUMMARY_SCHEMA;
  assistiveTechnology: AssistiveTechnology;
  browser: AccessibilityBrowser;
  applicationRevision: string;
  runtimeRevision: string;
  evidenceDigest: `sha256:${string}`;
  osVersion: string;
  browserVersion: string;
  observedAt: string;
  attempts: number;
  failures: number;
  flakes: number;
  skips: number;
  participantBoundary: {
    independentHumanReviewers: number;
    automatedRuns: number;
    ownerParticipants: number;
    selfTests: number;
    friendOrFamilyParticipants: number;
    supportInterventions: number;
    externalBetaParticipants: number;
    coachedParticipants: number;
    facilitatorRescues: number;
    trustedPreviewParticipants: number;
    buildTeamParticipants: number;
  };
  sanitized: true;
};

export function parseFounderAttendedAccessibilitySummary(input: {
  raw: string | undefined;
  assistiveTechnology: AssistiveTechnology;
  browser: AccessibilityBrowser;
}): FounderAttendedAccessibilitySummary | null {
  const raw = input.raw?.trim();
  if (!raw) return null;
  if (raw.length > 8_192) throw invalidSummary(input.assistiveTechnology);

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw invalidSummary(input.assistiveTechnology);
  }
  if (!isEvidenceRecord(value) || !hasExactKeys(value, SUMMARY_KEYS)) {
    throw invalidSummary(input.assistiveTechnology);
  }
  const boundary = value.participantBoundary;
  if (
    value.schemaVersion !== FOUNDER_ATTENDED_ACCESSIBILITY_SUMMARY_SCHEMA ||
    value.assistiveTechnology !== input.assistiveTechnology ||
    value.browser !== input.browser ||
    !isGitRevision(value.applicationRevision) ||
    !isRuntimeRevision(value.runtimeRevision) ||
    !isEvidenceDigest(value.evidenceDigest) ||
    !isVersionLabel(value.osVersion) ||
    !isVersionLabel(value.browserVersion) ||
    !isExactInstant(value.observedAt) ||
    !isCount(value.attempts) ||
    !isCount(value.failures) ||
    !isCount(value.flakes) ||
    !isCount(value.skips) ||
    !isEvidenceRecord(boundary) ||
    !hasExactKeys(boundary, PARTICIPANT_BOUNDARY_KEYS) ||
    !PARTICIPANT_BOUNDARY_KEYS.every((key) => isCount(boundary[key])) ||
    value.sanitized !== true
  ) {
    throw invalidSummary(input.assistiveTechnology);
  }

  return {
    schemaVersion: FOUNDER_ATTENDED_ACCESSIBILITY_SUMMARY_SCHEMA,
    assistiveTechnology: input.assistiveTechnology,
    browser: input.browser,
    applicationRevision: value.applicationRevision,
    runtimeRevision: value.runtimeRevision,
    evidenceDigest: value.evidenceDigest,
    osVersion: value.osVersion,
    browserVersion: value.browserVersion,
    observedAt: value.observedAt,
    attempts: value.attempts,
    failures: value.failures,
    flakes: value.flakes,
    skips: value.skips,
    participantBoundary: Object.fromEntries(
      PARTICIPANT_BOUNDARY_KEYS.map((key) => [key, boundary[key]]),
    ) as FounderAttendedAccessibilitySummary["participantBoundary"],
    sanitized: true,
  };
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isVersionLabel(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9 ._()+/-]{1,80}$/.test(value);
}

function invalidSummary(assistiveTechnology: AssistiveTechnology): Error {
  return new Error(`${assistiveTechnology} attended accessibility summary is invalid.`);
}
