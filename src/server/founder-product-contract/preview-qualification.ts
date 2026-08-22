import "server-only";

const OWNER_PREVIEW_QUALIFICATION_SCHEMA = "bruno.owner-preview-qualification.v1";
const OWNER_PREVIEW_QUALIFICATION_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1_000;
const OWNER_PREVIEW_CAPABILITIES = ["openai", "calendar_reading"] as const;

type PreviewQualificationEnvironment = Record<string, string | undefined>;

export type FounderOwnerPreviewQualification = {
  schemaVersion: typeof OWNER_PREVIEW_QUALIFICATION_SCHEMA;
  outcome: "passed";
  audience: "owner";
  ownerUserId: string;
  operatorId: string;
  stage: "owner_preview";
  applicationRevision: string;
  runtimeRevision: string;
  capabilityManifest: typeof OWNER_PREVIEW_CAPABILITIES;
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

export function requireFounderOwnerPreviewQualification(
  input: {
    userId: string;
    operatorId: string;
    applicationRevision: string;
    runtimeRevision: string;
    now: Date;
  },
  environment: PreviewQualificationEnvironment = process.env,
): FounderOwnerPreviewQualification {
  const raw = environment.BRUNO_OWNER_PREVIEW_QUALIFICATION?.trim();
  if (!raw) throw new Error("Owner Preview Qualification is unavailable.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Owner Preview Qualification is invalid.");
  }
  if (!isRecord(value)) throw new Error("Owner Preview Qualification is invalid.");
  const capabilities = value.capabilityManifest;
  if (
    value.schemaVersion !== OWNER_PREVIEW_QUALIFICATION_SCHEMA ||
    value.outcome !== "passed" ||
    value.audience !== "owner" ||
    value.ownerUserId !== input.userId ||
    value.operatorId !== input.operatorId ||
    value.stage !== "owner_preview" ||
    value.applicationRevision !== input.applicationRevision ||
    value.runtimeRevision !== input.runtimeRevision ||
    !Array.isArray(capabilities) ||
    capabilities.length !== OWNER_PREVIEW_CAPABILITIES.length ||
    !OWNER_PREVIEW_CAPABILITIES.every((capability, index) => capabilities[index] === capability) ||
    !isEvidenceDigest(value.evidenceDigest) ||
    !allQualificationGatesPassed(value.gates)
  ) {
    throw new Error("Owner Preview Qualification does not match this Owner and candidate.");
  }
  const qualifiedAt = readDate(value.qualifiedAt);
  const expiresAt = readDate(value.expiresAt);
  if (
    !qualifiedAt ||
    !expiresAt ||
    qualifiedAt > input.now ||
    expiresAt <= input.now ||
    expiresAt.valueOf() - qualifiedAt.valueOf() > OWNER_PREVIEW_QUALIFICATION_MAX_AGE_MS
  ) {
    throw new Error("Owner Preview Qualification is stale.");
  }
  return value as FounderOwnerPreviewQualification;
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
