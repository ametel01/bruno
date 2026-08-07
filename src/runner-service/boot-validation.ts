import type { RunnerReleaseEvidence } from "@/src/runner-service/release-identity";
import {
  verifyRunnerReleaseAttestation,
  type RunnerReleaseAttestationFailureReason,
} from "@/src/runner-service/release-attestation";

export const RUNNER_BOOT_VALIDATION_MODE_ENV = "AGENTBAY_RUNNER_BOOT_VALIDATION_MODE";
export const RUNNER_RELEASE_ATTESTATION_ENV = "AGENTBAY_RUNNER_RELEASE_ATTESTATION";
export const RUNNER_RELEASE_ATTESTATION_B64_ENV = "AGENTBAY_RUNNER_RELEASE_ATTESTATION_B64";
export const RUNNER_RELEASE_ATTESTATION_SIGNATURE_ENV =
  "AGENTBAY_RUNNER_RELEASE_ATTESTATION_SIGNATURE";
export const RUNNER_RELEASE_ATTESTATION_PUBLIC_KEY_ENV =
  "AGENTBAY_RUNNER_RELEASE_ATTESTATION_PUBLIC_KEY";
export const RUNNER_RELEASE_ATTESTATION_PUBLIC_KEY_B64_ENV =
  "AGENTBAY_RUNNER_RELEASE_ATTESTATION_PUBLIC_KEY_B64";
export const RUNNER_SNAPSHOT_ID_ENV = "AGENTBAY_RUNNER_SNAPSHOT_ID";
export const RUNNER_SNAPSHOT_MANIFEST_DIGEST_ENV = "AGENTBAY_RUNNER_SNAPSHOT_MANIFEST_DIGEST";
export const RUNNER_SNAPSHOT_EXPIRES_AT_ENV = "AGENTBAY_RUNNER_SNAPSHOT_EXPIRES_AT";
export const RUNNER_RELEASE_SOURCE_REVISION_ENV = "AGENTBAY_RELEASE_SOURCE_REVISION";

export type RunnerBootValidationMode = "full" | "release_attested";

export type RunnerBootValidationPlan =
  | { mode: "full" }
  | {
      mode: "release_attested";
      releaseAttestationDigest: string;
      releaseAttestationExpiresAt: string;
      snapshotId: string;
      snapshotManifestDigest: string;
      snapshotExpiresAt: string;
    };

export type RunnerBootValidationFailureReason =
  | "validation_mode_invalid"
  | "release_identity_unverified"
  | "attestation_configuration_missing"
  | RunnerReleaseAttestationFailureReason;

export class RunnerBootValidationError extends Error {
  readonly reason: RunnerBootValidationFailureReason;

  constructor(reason: RunnerBootValidationFailureReason) {
    super(`Runner boot validation is unavailable: ${reason}.`);
    this.name = "RunnerBootValidationError";
    this.reason = reason;
  }
}

export function readRunnerBootValidationMode(
  env: Record<string, string | undefined> = process.env,
): RunnerBootValidationMode {
  const value = env[RUNNER_BOOT_VALIDATION_MODE_ENV]?.trim() || "full";
  if (value === "full" || value === "release_attested") return value;
  throw new RunnerBootValidationError("validation_mode_invalid");
}

export function resolveRunnerBootValidation(input: {
  env?: Record<string, string | undefined>;
  releaseEvidence: RunnerReleaseEvidence;
  now?: Date;
}): RunnerBootValidationPlan {
  const env = input.env ?? process.env;
  const mode = readRunnerBootValidationMode(env);
  if (mode === "full") return { mode };

  if (input.releaseEvidence.expectedMatch !== true) {
    throw new RunnerBootValidationError("release_identity_unverified");
  }

  const attestationBytes =
    configured(env[RUNNER_RELEASE_ATTESTATION_ENV]) ??
    decodeBase64Url(env[RUNNER_RELEASE_ATTESTATION_B64_ENV]);
  const signature = configured(env[RUNNER_RELEASE_ATTESTATION_SIGNATURE_ENV]);
  const publicKeyPem =
    configured(env[RUNNER_RELEASE_ATTESTATION_PUBLIC_KEY_ENV]) ??
    decodeBase64Url(env[RUNNER_RELEASE_ATTESTATION_PUBLIC_KEY_B64_ENV]);
  const snapshotId = configured(env[RUNNER_SNAPSHOT_ID_ENV]);
  const snapshotManifestDigest = configured(env[RUNNER_SNAPSHOT_MANIFEST_DIGEST_ENV]);
  const snapshotExpiresAt = configured(env[RUNNER_SNAPSHOT_EXPIRES_AT_ENV]);
  const sourceRevision = configured(env[RUNNER_RELEASE_SOURCE_REVISION_ENV]);

  if (
    !attestationBytes ||
    !signature ||
    !publicKeyPem ||
    !snapshotId ||
    !snapshotManifestDigest ||
    !snapshotExpiresAt ||
    !sourceRevision
  ) {
    throw new RunnerBootValidationError("attestation_configuration_missing");
  }

  const verified = verifyRunnerReleaseAttestation({
    attestationBytes,
    signature,
    publicKeyPem,
    expected: {
      release: input.releaseEvidence.release,
      snapshotId,
      snapshotManifestDigest,
      snapshotExpiresAt,
      sourceRevision,
      ...(input.now ? { now: input.now } : {}),
    },
  });
  if (!verified.ok) throw new RunnerBootValidationError(verified.reason);

  return {
    mode,
    releaseAttestationDigest: verified.digest,
    releaseAttestationExpiresAt: verified.attestation.expiresAt,
    snapshotId: verified.attestation.snapshot.id,
    snapshotManifestDigest: verified.attestation.snapshot.manifestDigest,
    snapshotExpiresAt: verified.attestation.snapshot.expiresAt,
  };
}

function configured(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function decodeBase64Url(value: string | undefined): string | null {
  const normalized = configured(value);
  if (!normalized || !/^[A-Za-z0-9_-]+$/.test(normalized)) return null;
  try {
    const decoded = Buffer.from(normalized, "base64url").toString("utf8");
    return decoded ? decoded : null;
  } catch {
    return null;
  }
}
