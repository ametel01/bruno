import type { RunnerReleaseEvidence } from "@/src/runner-service/release-identity";
import {
  parseRunnerReleaseBundle,
  verifyRunnerReleaseBundle,
  type RunnerReleaseBundleFailureReason,
  type RunnerReleaseTrustedPublicKeys,
} from "@/src/runner-service/release-attestation";

export const RUNNER_BOOT_VALIDATION_MODE_ENV = "BRUNO_RUNNER_BOOT_VALIDATION_MODE";
export const RUNNER_RELEASE_BUNDLE_ENV = "BRUNO_RUNNER_RELEASE_BUNDLE";
export const RUNNER_RELEASE_APPROVED_DIGEST_ENV = "BRUNO_RUNNER_APPROVED_RELEASE_DIGEST";
export const RUNNER_RELEASE_TRUST_SET_ENV = "BRUNO_RUNNER_RELEASE_TRUST_SET";
export const RUNNER_APPROVED_SNAPSHOT_OCI_ENV = "BRUNO_RUNNER_APPROVED_SNAPSHOT_OCI";
export const RUNNER_APPROVED_SNAPSHOT_DIGEST_ENV = "BRUNO_RUNNER_APPROVED_SNAPSHOT_BUNDLE_DIGEST";

export type RunnerBootValidationMode = "full" | "release_attested";

export type RunnerBootAttestedChecks = {
  fullFixture: "verified";
  detailedHealth: "verified";
  modelCanary: "verified";
  telegramConfig: "verified";
  cleanup: "verified";
};

export type RunnerBootValidationPlan =
  | { mode: "full" }
  | {
      mode: "release_attested";
      releaseBundleDigest: string;
      snapshotBundleDigest: string;
      snapshotImageId: string;
      runnerImage: string;
      defaultAgentImage: string;
      hermesImage: string;
      attestedChecks: RunnerBootAttestedChecks;
    };

export type RunnerBootValidationFailureReason =
  | "validation_mode_invalid"
  | "release_identity_unverified"
  | "release_configuration_missing"
  | "release_trust_set_invalid"
  | RunnerReleaseBundleFailureReason;

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
}): RunnerBootValidationPlan {
  const env = input.env ?? process.env;
  const mode = readRunnerBootValidationMode(env);
  if (mode === "full") return { mode };

  if (input.releaseEvidence.expectedMatch !== true) {
    throw new RunnerBootValidationError("release_identity_unverified");
  }

  const bundleBytes = configured(env[RUNNER_RELEASE_BUNDLE_ENV]);
  const approvedDigest = configured(env[RUNNER_RELEASE_APPROVED_DIGEST_ENV]);
  const trustSetBytes = configured(env[RUNNER_RELEASE_TRUST_SET_ENV]);
  const runnerImage = configured(env.BRUNO_RUNNER_IMAGE);
  const defaultAgentImage = configured(env.BRUNO_DOCKER_RUNNER_IMAGE);
  const hermesImage = configured(env.BRUNO_HERMES_WORKLOAD_IMAGE);
  const snapshotOciReference = configured(env[RUNNER_APPROVED_SNAPSHOT_OCI_ENV]);
  const snapshotBundleDigest = configured(env[RUNNER_APPROVED_SNAPSHOT_DIGEST_ENV]);

  if (
    !bundleBytes ||
    !approvedDigest ||
    !trustSetBytes ||
    !runnerImage ||
    !defaultAgentImage ||
    !hermesImage ||
    !snapshotOciReference ||
    !snapshotBundleDigest
  ) {
    throw new RunnerBootValidationError("release_configuration_missing");
  }

  const parsed = parseRunnerReleaseBundle(bundleBytes);
  if (!parsed.ok) throw new RunnerBootValidationError(parsed.reason);
  const trustedPublicKeys = parseTrustSet(trustSetBytes);
  const verified = verifyRunnerReleaseBundle({
    bundleBytes,
    approvedDigest,
    trustedPublicKeys,
    expected: {
      sourceRevision: parsed.bundle.manifest.controlPlane.source.revision,
      runnerImage,
      defaultAgentImage,
      hermesImage,
      snapshotOciReference,
      snapshotBundleDigest,
      bootContractVersion: input.releaseEvidence.release.bootContractVersion,
    },
  });
  if (!verified.ok) throw new RunnerBootValidationError(verified.reason);
  if (
    verified.manifest.runnerImage.version !== input.releaseEvidence.release.version ||
    verified.manifest.runnerImage.digest !== input.releaseEvidence.release.imageDigest
  ) {
    throw new RunnerBootValidationError("release_identity_mismatch");
  }

  return {
    mode,
    releaseBundleDigest: verified.digest,
    snapshotBundleDigest: verified.manifest.snapshot.bundleDigest,
    snapshotImageId: verified.manifest.snapshot.imageId,
    runnerImage: verified.manifest.runnerImage.reference,
    defaultAgentImage: verified.manifest.defaultAgentImage.reference,
    hermesImage: verified.manifest.hermesImage.reference,
    attestedChecks: {
      fullFixture: "verified",
      detailedHealth: "verified",
      modelCanary: "verified",
      telegramConfig: "verified",
      cleanup: "verified",
    },
  };
}

function parseTrustSet(value: string): RunnerReleaseTrustedPublicKeys {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new RunnerBootValidationError("release_trust_set_invalid");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RunnerBootValidationError("release_trust_set_invalid");
  }
  const entries = Object.entries(raw);
  if (
    entries.length === 0 ||
    entries.length > 16 ||
    entries.some(
      ([keyId, publicKey]) =>
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId) ||
        typeof publicKey !== "string" ||
        publicKey.trim().length === 0 ||
        publicKey.length > 8192,
    )
  ) {
    throw new RunnerBootValidationError("release_trust_set_invalid");
  }
  return Object.fromEntries(
    entries.map(([keyId, publicKey]) => [keyId, (publicKey as string).trim()]),
  );
}

function configured(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
