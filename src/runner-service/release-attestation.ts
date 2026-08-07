import { createHash, sign, verify } from "node:crypto";
import {
  parseRunnerReleaseIdentity,
  releaseIdentitiesEqual,
  type RunnerReleaseIdentity,
} from "@/src/runner-service/release-identity";

export const RUNNER_RELEASE_ATTESTATION_SCHEMA_VERSION =
  "plingpling.runner.release-attestation.v1" as const;
export const MAX_RUNNER_RELEASE_ATTESTATION_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SNAPSHOT_ID = /^[1-9][0-9]{0,18}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const WORKFLOW_NUMBER = /^[1-9][0-9]{0,19}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export type RunnerReleaseAttestation = {
  schemaVersion: typeof RUNNER_RELEASE_ATTESTATION_SCHEMA_VERSION;
  release: RunnerReleaseIdentity;
  snapshot: {
    expiresAt: string;
    id: string;
    manifestDigest: string;
  };
  sourceRevision: string;
  workflow: {
    runId: string;
    runAttempt: string;
  };
  validation: {
    fullFixturePassedAt: string;
    cleanupVerifiedAt: string;
  };
  issuedAt: string;
  expiresAt: string;
};

export type RunnerReleaseAttestationFailureReason =
  | "attestation_json_invalid"
  | "attestation_schema_invalid"
  | "attestation_signature_invalid"
  | "attestation_identity_mismatch"
  | "attestation_not_yet_valid"
  | "attestation_stale";

export type RunnerReleaseAttestationCheck =
  | { ok: true; attestation: RunnerReleaseAttestation; digest: string }
  | { ok: false; reason: RunnerReleaseAttestationFailureReason };

export type RunnerReleaseAttestationExpected = {
  release: RunnerReleaseIdentity;
  snapshotId: string;
  snapshotExpiresAt: string;
  snapshotManifestDigest: string;
  sourceRevision: string;
  now?: Date;
};

export function createRunnerReleaseAttestation(input: {
  attestation: RunnerReleaseAttestation;
  privateKeyPem: string;
}): { canonicalBytes: string; digest: string; signature: string } {
  const parsed = parseRunnerReleaseAttestation(input.attestation);
  if (!parsed.ok) {
    throw new Error(`Runner release attestation is invalid: ${parsed.reason}.`);
  }

  const canonicalBytes = canonicalJson(parsed.attestation);
  return {
    canonicalBytes,
    digest: digestBytes(canonicalBytes),
    signature: sign(null, Buffer.from(canonicalBytes), input.privateKeyPem).toString("base64url"),
  };
}

export function verifyRunnerReleaseAttestation(input: {
  attestationBytes: string;
  signature: string;
  publicKeyPem: string;
  expected: RunnerReleaseAttestationExpected;
}): RunnerReleaseAttestationCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(input.attestationBytes);
  } catch {
    return { ok: false, reason: "attestation_json_invalid" };
  }

  const parsed = parseRunnerReleaseAttestation(raw);
  if (!parsed.ok) return parsed;

  const canonicalBytes = canonicalJson(parsed.attestation);
  let signatureValid = false;
  try {
    signatureValid = verify(
      null,
      Buffer.from(canonicalBytes),
      input.publicKeyPem,
      Buffer.from(input.signature, "base64url"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { ok: false, reason: "attestation_signature_invalid" };

  const now = input.expected.now ?? new Date();
  const issuedAt = Date.parse(parsed.attestation.issuedAt);
  const expiresAt = Date.parse(parsed.attestation.expiresAt);
  if (issuedAt > now.getTime()) {
    return { ok: false, reason: "attestation_not_yet_valid" };
  }
  if (
    expiresAt <= now.getTime() ||
    now.getTime() - issuedAt > MAX_RUNNER_RELEASE_ATTESTATION_AGE_MS
  ) {
    return { ok: false, reason: "attestation_stale" };
  }

  if (
    !releaseIdentitiesEqual(parsed.attestation.release, input.expected.release) ||
    parsed.attestation.snapshot.id !== input.expected.snapshotId ||
    parsed.attestation.snapshot.expiresAt !== input.expected.snapshotExpiresAt ||
    parsed.attestation.snapshot.manifestDigest !== input.expected.snapshotManifestDigest ||
    parsed.attestation.sourceRevision !== input.expected.sourceRevision
  ) {
    return { ok: false, reason: "attestation_identity_mismatch" };
  }

  return {
    ok: true,
    attestation: parsed.attestation,
    digest: digestBytes(canonicalBytes),
  };
}

export function parseRunnerReleaseAttestation(raw: unknown): RunnerReleaseAttestationCheck {
  if (!isExactRecord(raw, ATTESTATION_KEYS)) {
    return { ok: false, reason: "attestation_schema_invalid" };
  }

  const release = parseRunnerReleaseIdentity(raw.release);
  if (
    raw.schemaVersion !== RUNNER_RELEASE_ATTESTATION_SCHEMA_VERSION ||
    !isExactRecord(raw.release, ["bootContractVersion", "imageDigest", "version"]) ||
    !release ||
    !isExactRecord(raw.snapshot, ["expiresAt", "id", "manifestDigest"]) ||
    !isTimestamp(raw.snapshot.expiresAt) ||
    typeof raw.snapshot.id !== "string" ||
    !SNAPSHOT_ID.test(raw.snapshot.id) ||
    typeof raw.snapshot.manifestDigest !== "string" ||
    !SHA256_DIGEST.test(raw.snapshot.manifestDigest) ||
    typeof raw.sourceRevision !== "string" ||
    !SOURCE_REVISION.test(raw.sourceRevision) ||
    !isExactRecord(raw.workflow, ["runAttempt", "runId"]) ||
    typeof raw.workflow.runId !== "string" ||
    !WORKFLOW_NUMBER.test(raw.workflow.runId) ||
    typeof raw.workflow.runAttempt !== "string" ||
    !WORKFLOW_NUMBER.test(raw.workflow.runAttempt) ||
    !isExactRecord(raw.validation, ["cleanupVerifiedAt", "fullFixturePassedAt"]) ||
    !isTimestamp(raw.validation.fullFixturePassedAt) ||
    !isTimestamp(raw.validation.cleanupVerifiedAt) ||
    !isTimestamp(raw.issuedAt) ||
    !isTimestamp(raw.expiresAt)
  ) {
    return { ok: false, reason: "attestation_schema_invalid" };
  }

  const fullFixturePassedAt = Date.parse(raw.validation.fullFixturePassedAt);
  const cleanupVerifiedAt = Date.parse(raw.validation.cleanupVerifiedAt);
  const issuedAt = Date.parse(raw.issuedAt);
  const expiresAt = Date.parse(raw.expiresAt);
  const snapshotExpiresAt = Date.parse(raw.snapshot.expiresAt);
  if (
    fullFixturePassedAt > cleanupVerifiedAt ||
    cleanupVerifiedAt > issuedAt ||
    issuedAt >= expiresAt ||
    expiresAt - issuedAt > MAX_RUNNER_RELEASE_ATTESTATION_AGE_MS ||
    expiresAt > snapshotExpiresAt
  ) {
    return { ok: false, reason: "attestation_schema_invalid" };
  }

  return {
    ok: true,
    attestation: { ...(raw as RunnerReleaseAttestation), release },
    digest: digestBytes(canonicalJson(raw)),
  };
}

function digestBytes(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, field]) => [key, canonicalValue(field)]),
    );
  }
  return value;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" && ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value))
  );
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

const ATTESTATION_KEYS = [
  "expiresAt",
  "issuedAt",
  "release",
  "schemaVersion",
  "snapshot",
  "sourceRevision",
  "validation",
  "workflow",
] as const;
