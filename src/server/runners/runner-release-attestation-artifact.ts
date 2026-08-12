import "server-only";

import { RUNNER_BOOT_CONTRACT_VERSION } from "@/src/runner-service/constants";
import {
  createRunnerReleaseBundle,
  RUNNER_RELEASE_MANIFEST_SCHEMA_VERSION,
} from "@/src/runner-service/release-attestation";
import { parseImmutableRunnerImageReference } from "@/src/runner-service/release-identity";
import {
  RUNNER_BOOT_COMPONENTS,
  RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
} from "@/src/runner-service/runner-contracts";
import {
  parseRunnerSnapshotBundle,
  type RunnerSnapshotManifest,
  type RunnerSnapshotTrustedPublicKeys,
  verifyRunnerSnapshotBundle,
} from "@/src/server/runners/runner-snapshot-manifest";

const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const REQUIRED_SYNTHETIC_ACTIONS = ["start", "status", "canary", "stop"] as const;

type ReleaseSmokeResult = {
  ok: true;
  code: "passed";
  sideEffectsAttempted: true;
  cleanupVerified: true;
  evidence: {
    providerMode: "local_docker";
    releaseVersion: string;
    imageDigest: string;
    bootContractVersion: string;
    bootComponents: readonly string[];
    syntheticActions: readonly string[];
  };
};

export function buildRunnerReleaseBundleArtifact(input: {
  controlPlaneSourceRevision: string;
  runnerImage: string;
  snapshotOciReference: string;
  snapshotBundleBytes: string;
  approvedSnapshotDigest: string;
  snapshotTrustedPublicKeys: RunnerSnapshotTrustedPublicKeys;
  releaseSigningKeyId: string;
  releasePrivateKeyPem: string;
  workflowRunId: string;
  workflowRunAttempt: string;
  smokeResult: unknown;
  fullFixturePassedAt: string;
  cleanupVerifiedAt: string;
  now?: Date;
}) {
  if (!SOURCE_REVISION.test(input.controlPlaneSourceRevision)) {
    throw new Error("Verified Release requires an exact control-plane source revision.");
  }
  const runner = parseImmutableRunnerImageReference(input.runnerImage);
  if (!runner || !SOURCE_REVISION.test(runner.version)) {
    throw new Error("Verified Release requires an immutable Git-SHA runner image.");
  }
  const {
    manifest: snapshotManifest,
    digest: snapshotDigest,
    signingKeyId,
  } = verifyRunnerReleaseSnapshotInput({
    runnerImage: input.runnerImage,
    snapshotBundleBytes: input.snapshotBundleBytes,
    approvedSnapshotDigest: input.approvedSnapshotDigest,
    snapshotTrustedPublicKeys: input.snapshotTrustedPublicKeys,
  });

  const smoke = parsePassingSmoke(input.smokeResult);
  if (!smoke) {
    throw new Error("Verified Release requires full fixture and cleanup evidence.");
  }
  if (
    smoke.evidence.releaseVersion !== runner.version ||
    smoke.evidence.imageDigest !== runner.imageDigest ||
    smoke.evidence.bootContractVersion !== RUNNER_BOOT_CONTRACT_VERSION
  ) {
    throw new Error("Verified Release smoke runner identity does not match.");
  }

  const now = input.now ?? new Date();
  const fullFixturePassedAt = parseTimestamp(input.fullFixturePassedAt);
  const cleanupVerifiedAt = parseTimestamp(input.cleanupVerifiedAt);
  if (
    !fullFixturePassedAt ||
    !cleanupVerifiedAt ||
    fullFixturePassedAt.getTime() > cleanupVerifiedAt.getTime() ||
    cleanupVerifiedAt.getTime() > now.getTime()
  ) {
    throw new Error("Verified Release validation timestamps are invalid.");
  }

  return createRunnerReleaseBundle({
    manifest: {
      schemaVersion: RUNNER_RELEASE_MANIFEST_SCHEMA_VERSION,
      controlPlane: {
        source: { repository: "ametel01/bruno", revision: input.controlPlaneSourceRevision },
        contracts: {
          launch: "bruno.runner.launch.v2",
          status: "bruno.runner.status.v3",
          canary: "bruno.runner.canary.v1",
          bootSnapshot: RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
          boot: RUNNER_BOOT_CONTRACT_VERSION,
        },
      },
      runnerImage: {
        reference: input.runnerImage,
        digest: runner.imageDigest,
        version: runner.version,
      },
      defaultAgentImage: snapshotManifest.defaultAgentImage,
      hermesImage: snapshotManifest.hermesImage,
      snapshot: {
        ociReference: input.snapshotOciReference,
        bundleDigest: snapshotDigest,
        signingKeyId,
        manifestSchemaVersion: snapshotManifest.schemaVersion,
        provider: snapshotManifest.snapshot.provider,
        imageId: snapshotManifest.snapshot.id,
      },
      workflow: { runId: input.workflowRunId, runAttempt: input.workflowRunAttempt },
      validation: {
        mode: "full",
        providerMode: "local_docker",
        observedChecks: [...RUNNER_BOOT_COMPONENTS],
        syntheticActions: [...REQUIRED_SYNTHETIC_ACTIONS],
        fullFixturePassedAt: fullFixturePassedAt.toISOString(),
        cleanupVerifiedAt: cleanupVerifiedAt.toISOString(),
      },
      createdAt: now.toISOString(),
    },
    signingKeyId: input.releaseSigningKeyId,
    privateKeyPem: input.releasePrivateKeyPem,
  });
}

export function verifyRunnerReleaseSnapshotInput(input: {
  runnerImage: string;
  snapshotBundleBytes: string;
  approvedSnapshotDigest: string;
  snapshotTrustedPublicKeys: RunnerSnapshotTrustedPublicKeys;
}): { manifest: RunnerSnapshotManifest; digest: string; signingKeyId: string } {
  const runner = parseImmutableRunnerImageReference(input.runnerImage);
  if (!runner || !SOURCE_REVISION.test(runner.version)) {
    throw new Error("Verified Release requires an immutable Git-SHA runner image.");
  }
  const snapshot = parseRunnerSnapshotBundle(input.snapshotBundleBytes);
  if (!snapshot.ok) {
    throw new Error(`Verified Release snapshot failed closed: ${snapshot.reason}.`);
  }
  const manifest = snapshot.bundle.manifest;
  const verified = verifyRunnerSnapshotBundle({
    bundleBytes: input.snapshotBundleBytes,
    approvedDigest: input.approvedSnapshotDigest,
    trustedPublicKeys: input.snapshotTrustedPublicKeys,
    expected: {
      region: manifest.runner.region,
      sizeSlug: manifest.runner.sizeSlug,
      sizeDiskGb: manifest.runner.diskSizeGb,
      baseImageId: manifest.baseImage.id,
      baseImageSlug: manifest.baseImage.slug,
      architecture: manifest.runner.architecture,
      runnerImage: manifest.runnerImage.reference,
      defaultAgentImage: manifest.defaultAgentImage.reference,
      hermesImage: manifest.hermesImage.reference,
      hermesAmd64ManifestDigest: manifest.hermesImage.amd64ManifestDigest,
      bootContractVersion: manifest.bootContractVersion,
    },
  });
  if (!verified.ok) {
    throw new Error(`Verified Release snapshot failed closed: ${verified.reason}.`);
  }
  if (manifest.runnerImage.reference !== input.runnerImage) {
    throw new Error("Verified Release snapshot runner identity does not match.");
  }
  return { manifest, digest: verified.digest, signingKeyId: verified.signingKeyId };
}

function parsePassingSmoke(value: unknown): ReleaseSmokeResult | null {
  if (!isRecord(value) || !isRecord(value.evidence)) return null;
  const evidence = value.evidence;
  return value.ok === true &&
    value.code === "passed" &&
    value.sideEffectsAttempted === true &&
    value.cleanupVerified === true &&
    evidence.providerMode === "local_docker" &&
    typeof evidence.releaseVersion === "string" &&
    typeof evidence.imageDigest === "string" &&
    typeof evidence.bootContractVersion === "string" &&
    sameList(evidence.bootComponents, RUNNER_BOOT_COMPONENTS) &&
    sameList(evidence.syntheticActions, REQUIRED_SYNTHETIC_ACTIONS)
    ? (value as ReleaseSmokeResult)
    : null;
}

function sameList(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function parseTimestamp(value: string): Date | null {
  const parsed = new Date(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(parsed.getTime())
    ? parsed
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
