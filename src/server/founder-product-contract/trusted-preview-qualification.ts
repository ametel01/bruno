import "server-only";

import {
  FOUNDER_OWNER_PREVIEW_CAPABILITIES,
  FOUNDER_PREVIEW_QUALIFICATION_MAX_AGE_MS,
  type FounderOwnerPreviewCapability,
} from "./preview-qualification";

const TRUSTED_PREVIEW_QUALIFICATIONS_SCHEMA = "bruno.trusted-preview-qualifications.v1";
const TRUSTED_PREVIEW_QUALIFICATION_SCHEMA = "bruno.trusted-preview-qualification.v1";

export const FOUNDER_TRUSTED_PREVIEW_CAPABILITIES = FOUNDER_OWNER_PREVIEW_CAPABILITIES;

export type FounderTrustedPreviewQualification = {
  schemaVersion: typeof TRUSTED_PREVIEW_QUALIFICATION_SCHEMA;
  outcome: "passed";
  audience: "trusted_cohort";
  cohortOwnerUserId: string;
  operatorId: string;
  stage: "trusted_preview";
  applicationRevision: string;
  runtimeRevision: string;
  capability: FounderOwnerPreviewCapability;
  qualifiedAt: string;
  expiresAt: string;
  evidenceDigest: `sha256:${string}`;
  gates: {
    safeAuthorization: true;
    realUse: true;
    recovery: true;
    revocation: true;
    providerDisclosure: true;
    cleanup: true;
  };
};

export function requireFounderTrustedPreviewQualifications(
  input: {
    cohortOwnerUserId: string;
    operatorId: string;
    applicationRevision: string;
    runtimeRevision: string;
    now: Date;
  },
  environment: Record<string, string | undefined> = process.env,
): readonly FounderTrustedPreviewQualification[] {
  const raw = environment.BRUNO_TRUSTED_PREVIEW_QUALIFICATIONS?.trim();
  if (!raw) throw new Error("Trusted Preview Qualifications are unavailable.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Trusted Preview Qualifications are invalid.");
  }
  const qualifications = isRecord(value) ? value.qualifications : null;
  if (
    !isRecord(value) ||
    value.schemaVersion !== TRUSTED_PREVIEW_QUALIFICATIONS_SCHEMA ||
    !Array.isArray(qualifications) ||
    qualifications.length !== FOUNDER_TRUSTED_PREVIEW_CAPABILITIES.length
  ) {
    throw new Error("Trusted Preview Qualifications are invalid.");
  }
  const validated = FOUNDER_TRUSTED_PREVIEW_CAPABILITIES.map((capability) => {
    const matching = qualifications.filter(
      (qualification) => isRecord(qualification) && qualification.capability === capability,
    );
    if (matching.length !== 1) {
      throw new Error("Trusted Preview requires one qualification per capability.");
    }
    return requireCapabilityQualification(matching[0], capability, input);
  });
  if (
    new Set(validated.map((qualification) => qualification.evidenceDigest)).size !==
    validated.length
  ) {
    throw new Error("Trusted Preview capabilities require independent qualification evidence.");
  }
  return validated;
}

function requireCapabilityQualification(
  value: unknown,
  capability: FounderOwnerPreviewCapability,
  input: {
    cohortOwnerUserId: string;
    operatorId: string;
    applicationRevision: string;
    runtimeRevision: string;
    now: Date;
  },
): FounderTrustedPreviewQualification {
  if (
    !isRecord(value) ||
    value.schemaVersion !== TRUSTED_PREVIEW_QUALIFICATION_SCHEMA ||
    value.outcome !== "passed" ||
    value.audience !== "trusted_cohort" ||
    value.cohortOwnerUserId !== input.cohortOwnerUserId ||
    value.operatorId !== input.operatorId ||
    value.stage !== "trusted_preview" ||
    value.applicationRevision !== input.applicationRevision ||
    value.runtimeRevision !== input.runtimeRevision ||
    value.capability !== capability ||
    !isEvidenceDigest(value.evidenceDigest) ||
    !allQualificationGatesPassed(value.gates)
  ) {
    throw new Error(
      `Trusted Preview ${capability} qualification does not match this cohort and candidate.`,
    );
  }
  const qualifiedAt = readDate(value.qualifiedAt);
  const expiresAt = readDate(value.expiresAt);
  if (
    !qualifiedAt ||
    !expiresAt ||
    qualifiedAt > input.now ||
    expiresAt <= input.now ||
    expiresAt.valueOf() - qualifiedAt.valueOf() > FOUNDER_PREVIEW_QUALIFICATION_MAX_AGE_MS
  ) {
    throw new Error(`Trusted Preview ${capability} qualification is stale.`);
  }
  return value as FounderTrustedPreviewQualification;
}

function allQualificationGatesPassed(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    "safeAuthorization",
    "realUse",
    "recovery",
    "revocation",
    "providerDisclosure",
    "cleanup",
  ].every((gate) => value[gate] === true);
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
