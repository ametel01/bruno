import "server-only";

const OWNER_PREVIEW_QUALIFICATIONS_SCHEMA = "bruno.owner-preview-qualifications.v1";
const PREVIEW_QUALIFICATION_SCHEMA = "bruno.preview-qualification.v1";
const PREVIEW_QUALIFICATION_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1_000;
const OWNER_PREVIEW_CAPABILITIES = ["openai", "calendar_reading"] as const;

type OwnerPreviewCapability = (typeof OWNER_PREVIEW_CAPABILITIES)[number];
type PreviewQualificationEnvironment = Record<string, string | undefined>;

export type FounderPreviewQualification = {
  schemaVersion: typeof PREVIEW_QUALIFICATION_SCHEMA;
  outcome: "passed";
  audience: "owner";
  ownerUserId: string;
  operatorId: string;
  stage: "owner_preview";
  applicationRevision: string;
  runtimeRevision: string;
  capability: OwnerPreviewCapability;
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

export function requireFounderOwnerPreviewQualifications(
  input: {
    userId: string;
    operatorId: string;
    applicationRevision: string;
    runtimeRevision: string;
    now: Date;
  },
  environment: PreviewQualificationEnvironment = process.env,
): readonly FounderPreviewQualification[] {
  const raw = environment.BRUNO_OWNER_PREVIEW_QUALIFICATIONS?.trim();
  if (!raw) throw new Error("Owner Preview Qualifications are unavailable.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Owner Preview Qualifications are invalid.");
  }
  const qualifications = isRecord(value) ? value.qualifications : null;
  if (
    !isRecord(value) ||
    value.schemaVersion !== OWNER_PREVIEW_QUALIFICATIONS_SCHEMA ||
    !Array.isArray(qualifications) ||
    qualifications.length !== OWNER_PREVIEW_CAPABILITIES.length
  ) {
    throw new Error("Owner Preview Qualifications are invalid.");
  }
  const validated = OWNER_PREVIEW_CAPABILITIES.map((capability) => {
    const matching = qualifications.filter(
      (qualification) => isRecord(qualification) && qualification.capability === capability,
    );
    if (matching.length !== 1) {
      throw new Error("Owner Preview requires one qualification per capability.");
    }
    return requireCapabilityQualification(matching[0], capability, input);
  });
  if (
    new Set(validated.map((qualification) => qualification.evidenceDigest)).size !==
    validated.length
  ) {
    throw new Error("Owner Preview capabilities require independent qualification evidence.");
  }
  return validated;
}

function requireCapabilityQualification(
  value: unknown,
  capability: OwnerPreviewCapability,
  input: {
    userId: string;
    operatorId: string;
    applicationRevision: string;
    runtimeRevision: string;
    now: Date;
  },
): FounderPreviewQualification {
  if (
    !isRecord(value) ||
    value.schemaVersion !== PREVIEW_QUALIFICATION_SCHEMA ||
    value.outcome !== "passed" ||
    value.audience !== "owner" ||
    value.ownerUserId !== input.userId ||
    value.operatorId !== input.operatorId ||
    value.stage !== "owner_preview" ||
    value.applicationRevision !== input.applicationRevision ||
    value.runtimeRevision !== input.runtimeRevision ||
    value.capability !== capability ||
    !isEvidenceDigest(value.evidenceDigest) ||
    !allQualificationGatesPassed(value.gates)
  ) {
    throw new Error(
      `Owner Preview ${capability} qualification does not match this Owner and candidate.`,
    );
  }
  const qualifiedAt = readDate(value.qualifiedAt);
  const expiresAt = readDate(value.expiresAt);
  if (
    !qualifiedAt ||
    !expiresAt ||
    qualifiedAt > input.now ||
    expiresAt <= input.now ||
    expiresAt.valueOf() - qualifiedAt.valueOf() > PREVIEW_QUALIFICATION_MAX_AGE_MS
  ) {
    throw new Error(`Owner Preview ${capability} qualification is stale.`);
  }
  return value as FounderPreviewQualification;
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
