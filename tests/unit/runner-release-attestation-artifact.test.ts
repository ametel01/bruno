import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import { verifyRunnerReleaseAttestation } from "@/src/runner-service/release-attestation";
import { buildRunnerReleaseAttestationArtifact } from "@/src/server/runners/runner-release-attestation-artifact";
import {
  createRunnerSnapshotAttestation,
  type RunnerSnapshotManifest,
} from "@/src/server/runners/runner-snapshot-manifest";

const NOW = new Date("2026-08-07T10:00:00.000Z");
const SOURCE_REVISION = "1".repeat(40);
const RUNNER_IMAGE = `ghcr.io/ametel01/agentbay-runner:${SOURCE_REVISION}@sha256:${"a".repeat(64)}`;

describe("runner release attestation artifact", () => {
  it("ties a successful full fixture to an exact signed snapshot and release", () => {
    const snapshotKeys = generateKeyPairSync("ed25519");
    const releaseKeys = generateKeyPairSync("ed25519");
    const snapshot = createRunnerSnapshotAttestation({
      manifest: manifest(),
      privateKeyPem: snapshotKeys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });
    const artifact = buildRunnerReleaseAttestationArtifact({
      runnerImage: RUNNER_IMAGE,
      snapshotManifestBytes: snapshot.canonicalBytes,
      snapshotSignature: snapshot.signature,
      snapshotPublicKeyPem: snapshotKeys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
      releasePrivateKeyPem: releaseKeys.privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
      workflowRunId: "123456",
      workflowRunAttempt: "1",
      fullFixturePassedAt: "2026-08-07T09:58:00.000Z",
      cleanupVerifiedAt: "2026-08-07T09:59:00.000Z",
      now: NOW,
    });

    expect(
      verifyRunnerReleaseAttestation({
        attestationBytes: artifact.canonicalBytes,
        signature: artifact.signature,
        publicKeyPem: releaseKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        expected: {
          release: {
            version: SOURCE_REVISION,
            imageDigest: `sha256:${"a".repeat(64)}`,
            bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
          },
          snapshotId: "1102",
          snapshotManifestDigest: snapshot.digest,
          snapshotExpiresAt: "2026-08-15T00:00:00.000Z",
          sourceRevision: SOURCE_REVISION,
          now: NOW,
        },
      }),
    ).toMatchObject({ ok: true, digest: artifact.digest });
  });

  it("fails closed when the signed snapshot belongs to another runner", () => {
    const keys = generateKeyPairSync("ed25519");
    const snapshot = createRunnerSnapshotAttestation({
      manifest: manifest(),
      privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });

    expect(() =>
      buildRunnerReleaseAttestationArtifact({
        runnerImage: RUNNER_IMAGE.replace("a".repeat(64), "f".repeat(64)),
        snapshotManifestBytes: snapshot.canonicalBytes,
        snapshotSignature: snapshot.signature,
        snapshotPublicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        releasePrivateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        workflowRunId: "123456",
        workflowRunAttempt: "1",
        fullFixturePassedAt: "2026-08-07T09:58:00.000Z",
        cleanupVerifiedAt: "2026-08-07T09:59:00.000Z",
        now: NOW,
      }),
    ).toThrow("snapshot runner identity does not match");
  });
});

function manifest(): RunnerSnapshotManifest {
  return {
    schemaVersion: "plingpling.runner.snapshot.v1",
    snapshot: {
      id: "1102",
      name: "runner-snapshot-1102",
      regions: ["sfo3"],
      minDiskSizeGb: 25,
      architecture: "amd64",
    },
    baseImage: { id: "24.04", slug: "ubuntu-24-04-x64" },
    runnerImage: { reference: RUNNER_IMAGE, digest: `sha256:${"a".repeat(64)}` },
    defaultAgentImage: {
      reference: `ghcr.io/ametel01/default-agent:exact@sha256:${"b".repeat(64)}`,
      digest: `sha256:${"b".repeat(64)}`,
    },
    hermesImage: {
      reference: `ghcr.io/ametel01/hermes:exact@${DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST}`,
      indexDigest: DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
      amd64ManifestDigest: DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
    },
    bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
    source: { repository: "ametel01/plingpling", revision: SOURCE_REVISION },
    workflow: { runId: "654321", runAttempt: "1" },
    validation: {
      fullBootFixturePassedAt: "2026-08-07T09:00:00.000Z",
      sanitationPassedAt: "2026-08-07T09:05:00.000Z",
    },
    createdAt: "2026-08-07T09:06:00.000Z",
    availableAt: "2026-08-07T09:07:00.000Z",
    expiresAt: "2026-08-15T00:00:00.000Z",
  };
}
