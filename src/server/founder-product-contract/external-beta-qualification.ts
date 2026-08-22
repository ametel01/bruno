import "server-only";

import { evaluateFounderAnthropicRelease } from "@/src/server/operators/founder-anthropic-release";
import { evaluateFounderGoogleMailSendingRelease } from "@/src/server/operators/founder-google-mail-sending-release";
import {
  evaluateFounderGoogleCalendarRelease,
  evaluateFounderGoogleMailReadingRelease,
} from "@/src/server/operators/founder-google-reading-release";
import { evaluateFounderOpenAiRelease } from "@/src/server/operators/founder-openai-release";

export const FOUNDER_EXTERNAL_BETA_QUALIFICATIONS_SCHEMA = "bruno.external-beta-qualifications.v1";
export const FOUNDER_EXTERNAL_BETA_QUALIFICATION_SCHEMA = "bruno.preview-qualification.v1";
export const FOUNDER_EXTERNAL_BETA_QUALIFICATION_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1_000;
export const FOUNDER_EXTERNAL_BETA_CAPABILITIES = [
  "openai",
  "anthropic",
  "calendar_reading",
  "gmail_reading",
  "gmail_sending",
] as const;

export type FounderExternalBetaCapability = (typeof FOUNDER_EXTERNAL_BETA_CAPABILITIES)[number];
export type FounderExternalBetaQualification = {
  schemaVersion: typeof FOUNDER_EXTERNAL_BETA_QUALIFICATION_SCHEMA;
  outcome: "passed";
  stage: "external_beta";
  cohort: string;
  capability: FounderExternalBetaCapability;
  applicationRevision: string;
  runtimeRevision: string;
  evidenceDigest: `sha256:${string}`;
  observedAt: string;
  expiresAt: string;
};

export type FounderExternalBetaQualificationErrorCode =
  | "qualification_missing"
  | "qualification_malformed"
  | "qualification_mismatched"
  | "qualification_stale"
  | "qualification_expired";

export class FounderExternalBetaQualificationError extends Error {
  constructor(
    readonly code: FounderExternalBetaQualificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FounderExternalBetaQualificationError";
  }
}

type QualificationEnvironment = Record<string, string | undefined>;

export function requireFounderExternalBetaQualifications(
  input: {
    cohort: string;
    applicationRevision: string;
    runtimeRevision: string;
    now: Date;
  },
  environment: QualificationEnvironment = process.env,
): readonly FounderExternalBetaQualification[] {
  if (
    !isCohort(input.cohort) ||
    !isGitRevision(input.applicationRevision) ||
    !input.runtimeRevision.trim() ||
    Number.isNaN(input.now.valueOf())
  ) {
    throw new FounderExternalBetaQualificationError(
      "qualification_mismatched",
      "External Beta candidate identity is invalid.",
    );
  }

  const raw = environment.BRUNO_EXTERNAL_BETA_QUALIFICATIONS?.trim();
  if (!raw) {
    throw new FounderExternalBetaQualificationError(
      "qualification_missing",
      "External Beta qualification is not available yet.",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new FounderExternalBetaQualificationError(
      "qualification_malformed",
      "External Beta qualification could not be verified.",
    );
  }
  const qualificationValues = isRecord(value) ? value.qualifications : null;
  if (
    !isRecord(value) ||
    value.schemaVersion !== FOUNDER_EXTERNAL_BETA_QUALIFICATIONS_SCHEMA ||
    value.cohort !== input.cohort ||
    !Array.isArray(qualificationValues) ||
    qualificationValues.length !== FOUNDER_EXTERNAL_BETA_CAPABILITIES.length
  ) {
    throw new FounderExternalBetaQualificationError(
      "qualification_malformed",
      "External Beta qualification could not be verified.",
    );
  }

  const providerEvidence = requireIndependentConnectedAcceptance(environment, input.now);
  const qualifications = FOUNDER_EXTERNAL_BETA_CAPABILITIES.map((capability) => {
    const matching = qualificationValues.filter(
      (qualification) => isRecord(qualification) && qualification.capability === capability,
    );
    if (matching.length !== 1) {
      throw new FounderExternalBetaQualificationError(
        "qualification_malformed",
        "External Beta needs one independent qualification for every capability.",
      );
    }
    return requireCapabilityQualification(matching[0], capability, input, providerEvidence);
  });

  if (
    new Set(qualifications.map((qualification) => qualification.evidenceDigest)).size !==
    qualifications.length
  ) {
    throw new FounderExternalBetaQualificationError(
      "qualification_mismatched",
      "External Beta capabilities must use independent evidence.",
    );
  }
  return qualifications;
}

function requireIndependentConnectedAcceptance(
  environment: QualificationEnvironment,
  now: Date,
): Readonly<Record<FounderExternalBetaCapability, `sha256:${string}`>> {
  const decisions = {
    openai: evaluateFounderOpenAiRelease(environment, now),
    anthropic: evaluateFounderAnthropicRelease(environment, now),
    calendar_reading: evaluateFounderGoogleCalendarRelease(environment, now),
    gmail_reading: evaluateFounderGoogleMailReadingRelease(environment, now),
    gmail_sending: evaluateFounderGoogleMailSendingRelease(environment, now),
  } as const;

  return {
    openai: requireReleasedEvidenceDigest(decisions.openai, "openai"),
    anthropic: requireReleasedEvidenceDigest(decisions.anthropic, "anthropic"),
    calendar_reading: requireReleasedEvidenceDigest(decisions.calendar_reading, "calendar_reading"),
    gmail_reading: requireReleasedEvidenceDigest(decisions.gmail_reading, "gmail_reading"),
    gmail_sending: requireReleasedEvidenceDigest(decisions.gmail_sending, "gmail_sending"),
  };
}

function requireCapabilityQualification(
  value: unknown,
  capability: FounderExternalBetaCapability,
  input: {
    cohort: string;
    applicationRevision: string;
    runtimeRevision: string;
    now: Date;
  },
  providerEvidence: Readonly<Record<FounderExternalBetaCapability, `sha256:${string}`>>,
): FounderExternalBetaQualification {
  if (
    !isRecord(value) ||
    value.schemaVersion !== FOUNDER_EXTERNAL_BETA_QUALIFICATION_SCHEMA ||
    value.outcome !== "passed" ||
    value.stage !== "external_beta" ||
    value.cohort !== input.cohort ||
    value.capability !== capability ||
    value.applicationRevision !== input.applicationRevision ||
    value.runtimeRevision !== input.runtimeRevision ||
    !isEvidenceDigest(value.evidenceDigest) ||
    value.evidenceDigest !== providerEvidence[capability]
  ) {
    throw new FounderExternalBetaQualificationError(
      "qualification_mismatched",
      `External Beta ${capabilityLabel(capability)} qualification does not match this candidate.`,
    );
  }

  const observedAt = readDate(value.observedAt);
  const expiresAt = readDate(value.expiresAt);
  if (!observedAt || !expiresAt || observedAt > input.now) {
    throw new FounderExternalBetaQualificationError(
      "qualification_malformed",
      `External Beta ${capabilityLabel(capability)} qualification time is invalid.`,
    );
  }
  if (expiresAt <= input.now) {
    throw new FounderExternalBetaQualificationError(
      "qualification_expired",
      `External Beta ${capabilityLabel(capability)} qualification has expired.`,
    );
  }
  if (expiresAt.valueOf() - observedAt.valueOf() > FOUNDER_EXTERNAL_BETA_QUALIFICATION_MAX_AGE_MS) {
    throw new FounderExternalBetaQualificationError(
      "qualification_stale",
      `External Beta ${capabilityLabel(capability)} qualification is stale.`,
    );
  }
  return value as FounderExternalBetaQualification;
}

function requireReleasedEvidenceDigest(
  decision:
    | { released: true; evidence: { evidenceDigest: `sha256:${string}` } }
    | { released: false; reason: string },
  capability: FounderExternalBetaCapability,
): `sha256:${string}` {
  if (!decision.released) {
    throw new FounderExternalBetaQualificationError(
      decision.reason === "connected_acceptance_missing"
        ? "qualification_missing"
        : decision.reason === "connected_acceptance_stale"
          ? "qualification_stale"
          : "qualification_mismatched",
      `External Beta ${capabilityLabel(capability)} qualification is unavailable.`,
    );
  }
  return decision.evidence.evidenceDigest;
}

export function founderExternalBetaCapabilityLabel(
  capability: FounderExternalBetaCapability,
): string {
  return capabilityLabel(capability);
}

function capabilityLabel(capability: FounderExternalBetaCapability): string {
  return {
    openai: "OpenAI",
    anthropic: "Anthropic",
    calendar_reading: "Calendar reading",
    gmail_reading: "Gmail reading",
    gmail_sending: "one-to-one Gmail sending",
  }[capability];
}

function isCohort(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isGitRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function isEvidenceDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function readDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) || date.toISOString() !== value ? null : date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
