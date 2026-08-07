import "server-only";

import {
  createRunnerReleaseAttestation,
  MAX_RUNNER_RELEASE_ATTESTATION_AGE_MS,
  RUNNER_RELEASE_ATTESTATION_SCHEMA_VERSION,
} from "@/src/runner-service/release-attestation";
import { parseImmutableRunnerImageReference } from "@/src/runner-service/release-identity";
import {
  parseRunnerSnapshotManifest,
  verifyRunnerSnapshotManifest,
} from "@/src/server/runners/runner-snapshot-manifest";

export function buildRunnerReleaseAttestationArtifact(input: {
  runnerImage: string;
  snapshotManifestBytes: string;
  snapshotSignature: string;
  snapshotPublicKeyPem: string;
  releasePrivateKeyPem: string;
  workflowRunId: string;
  workflowRunAttempt: string;
  fullFixturePassedAt: string;
  cleanupVerifiedAt: string;
  now?: Date;
}): { canonicalBytes: string; digest: string; signature: string } {
  const release = parseImmutableRunnerImageReference(input.runnerImage);
  if (!release) throw new Error("Release attestation requires an immutable runner image.");

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(input.snapshotManifestBytes);
  } catch {
    throw new Error("Release attestation requires a valid snapshot manifest.");
  }
  const parsed = parseRunnerSnapshotManifest(rawManifest);
  if (!parsed.ok) {
    throw new Error(`Release attestation snapshot failed closed: ${parsed.reason}.`);
  }
  const manifest = parsed.manifest;
  if (manifest.runnerImage.reference !== input.runnerImage) {
    throw new Error("Release attestation snapshot runner identity does not match.");
  }

  const verified = verifyRunnerSnapshotManifest({
    manifestBytes: input.snapshotManifestBytes,
    signature: input.snapshotSignature,
    publicKeyPem: input.snapshotPublicKeyPem,
    expected: {
      region: manifest.snapshot.regions[0] ?? "",
      sizeDiskGb: manifest.snapshot.minDiskSizeGb,
      baseImageSlug: manifest.baseImage.slug,
      architecture: manifest.snapshot.architecture,
      runnerImage: input.runnerImage,
      defaultAgentImage: manifest.defaultAgentImage.reference,
      hermesImage: manifest.hermesImage.reference,
      sourceRepository: manifest.source.repository,
      sourceRevision: manifest.source.revision,
      bootContractVersion: manifest.bootContractVersion,
      ...(input.now ? { now: input.now } : {}),
    },
  });
  if (!verified.ok) {
    throw new Error(`Release attestation snapshot failed closed: ${verified.reason}.`);
  }

  const now = input.now ?? new Date();
  const maximumExpiry = now.getTime() + MAX_RUNNER_RELEASE_ATTESTATION_AGE_MS;
  const snapshotExpiry = Date.parse(manifest.expiresAt);
  const expiry = Math.min(maximumExpiry, snapshotExpiry);
  if (expiry <= now.getTime()) {
    throw new Error("Release attestation snapshot is already expired.");
  }

  return createRunnerReleaseAttestation({
    attestation: {
      schemaVersion: RUNNER_RELEASE_ATTESTATION_SCHEMA_VERSION,
      release: {
        version: release.version,
        imageDigest: release.imageDigest,
        bootContractVersion: manifest.bootContractVersion,
      },
      snapshot: {
        id: manifest.snapshot.id,
        manifestDigest: verified.digest,
        expiresAt: manifest.expiresAt,
      },
      sourceRevision: manifest.source.revision,
      workflow: {
        runId: input.workflowRunId,
        runAttempt: input.workflowRunAttempt,
      },
      validation: {
        fullFixturePassedAt: input.fullFixturePassedAt,
        cleanupVerifiedAt: input.cleanupVerifiedAt,
      },
      issuedAt: now.toISOString(),
      expiresAt: new Date(expiry).toISOString(),
    },
    privateKeyPem: input.releasePrivateKeyPem,
  });
}
