import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import { RUNNER_BOOT_COMPONENTS } from "@/src/runner-service/runner-contracts";
import { verifyRunnerReleaseBundle } from "@/src/runner-service/release-attestation";
import { buildRunnerReleaseBundleArtifact } from "@/src/server/runners/runner-release-attestation-artifact";
import {
  createRunnerSnapshotAttestation,
  type RunnerSnapshotManifest,
} from "@/src/server/runners/runner-snapshot-manifest";

const SOURCE_REVISION = "1".repeat(40);
const RUNNER_DIGEST = `sha256:${"a".repeat(64)}`;
const AGENT_DIGEST = `sha256:${"b".repeat(64)}`;
const RUNNER_IMAGE = `ghcr.io/ametel01/bruno-runner:${SOURCE_REVISION}@${RUNNER_DIGEST}`;
const AGENT_IMAGE = `ghcr.io/ametel01/bruno-default:release@${AGENT_DIGEST}`;
const SNAPSHOT_OCI = `ghcr.io/ametel01/bruno-runner-snapshot-bundles@sha256:${"d".repeat(64)}`;

describe("Verified Release artifact builder", () => {
  it("joins full-fixture evidence to one exact trusted Snapshot Attestation v2 bundle", () => {
    const snapshotKeys = generateKeyPairSync("ed25519");
    const releaseKeys = generateKeyPairSync("ed25519");
    const snapshot = attestSnapshot(snapshotKeys.privateKey);
    const snapshotTrust = {
      "snapshot-current": snapshotKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    };
    const releaseTrust = {
      "release-current": releaseKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    };
    const artifact = buildRunnerReleaseBundleArtifact({
      runnerImage: RUNNER_IMAGE,
      snapshotOciReference: SNAPSHOT_OCI,
      snapshotBundleBytes: snapshot.bundleBytes,
      approvedSnapshotDigest: snapshot.digest,
      snapshotTrustedPublicKeys: snapshotTrust,
      releaseSigningKeyId: "release-current",
      releasePrivateKeyPem: releaseKeys.privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
      workflowRunId: "123456",
      workflowRunAttempt: "1",
      smokeResult: passingSmoke(),
      fullFixturePassedAt: "2026-08-11T00:00:00.000Z",
      cleanupVerifiedAt: "2026-08-11T00:01:00.000Z",
      now: new Date("2026-08-11T00:02:00.000Z"),
    });

    expect(
      verifyRunnerReleaseBundle({
        bundleBytes: artifact.bundleBytes,
        approvedDigest: artifact.digest,
        trustedPublicKeys: releaseTrust,
        expected: {
          sourceRevision: SOURCE_REVISION,
          runnerImage: RUNNER_IMAGE,
          defaultAgentImage: AGENT_IMAGE,
          hermesImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
          snapshotOciReference: SNAPSHOT_OCI,
          snapshotBundleDigest: snapshot.digest,
          bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
        },
      }),
    ).toMatchObject({
      ok: true,
      manifest: {
        snapshot: { signingKeyId: "snapshot-current", imageId: "1102" },
        validation: { mode: "full", providerMode: "local_docker" },
      },
    });
    expect(artifact.bundleBytes).not.toMatch(/token|credential|endpoint|bootstrapOutput/i);
  });

  it("rejects mismatched snapshot identity and incomplete smoke evidence", () => {
    const keys = generateKeyPairSync("ed25519");
    const snapshot = attestSnapshot(keys.privateKey);
    const base = {
      runnerImage: RUNNER_IMAGE,
      snapshotOciReference: SNAPSHOT_OCI,
      snapshotBundleBytes: snapshot.bundleBytes,
      approvedSnapshotDigest: snapshot.digest,
      snapshotTrustedPublicKeys: {
        "snapshot-current": keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      },
      releaseSigningKeyId: "release-current",
      releasePrivateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      workflowRunId: "123456",
      workflowRunAttempt: "1",
      smokeResult: passingSmoke(),
      fullFixturePassedAt: "2026-08-11T00:00:00.000Z",
      cleanupVerifiedAt: "2026-08-11T00:01:00.000Z",
      now: new Date("2026-08-11T00:02:00.000Z"),
    };

    expect(() =>
      buildRunnerReleaseBundleArtifact({
        ...base,
        runnerImage: RUNNER_IMAGE.replace(RUNNER_DIGEST, `sha256:${"f".repeat(64)}`),
      }),
    ).toThrow("snapshot runner identity does not match");
    expect(() =>
      buildRunnerReleaseBundleArtifact({
        ...base,
        smokeResult: { ...passingSmoke(), cleanupVerified: false },
      }),
    ).toThrow("full fixture and cleanup evidence");
  });
});

function passingSmoke() {
  return {
    ok: true as const,
    code: "passed" as const,
    sideEffectsAttempted: true as const,
    cleanupVerified: true as const,
    evidence: {
      providerMode: "local_docker" as const,
      releaseVersion: SOURCE_REVISION,
      imageDigest: RUNNER_DIGEST,
      bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      bootComponents: [...RUNNER_BOOT_COMPONENTS],
      syntheticActions: ["start", "status", "canary", "stop"] as const,
    },
  };
}

function attestSnapshot(privateKey: KeyObject) {
  return createRunnerSnapshotAttestation({
    manifest: snapshotManifest(),
    signingKeyId: "snapshot-current",
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  });
}

function snapshotManifest(): RunnerSnapshotManifest {
  return {
    schemaVersion: "bruno.runner.snapshot.v2",
    runner: { region: "sfo3", sizeSlug: "s-1vcpu-2gb", diskSizeGb: 50, architecture: "amd64" },
    snapshot: {
      provider: "digitalocean",
      id: "1102",
      name: "runner-snapshot-1102",
      status: "available",
      regions: ["sfo3"],
      minDiskSizeGb: 25,
      architecture: "amd64",
    },
    baseImage: { id: "24.04", slug: "ubuntu-24-04-x64" },
    runnerImage: { reference: RUNNER_IMAGE, digest: RUNNER_DIGEST },
    defaultAgentImage: { reference: AGENT_IMAGE, digest: AGENT_DIGEST },
    hermesImage: {
      reference: DEFAULT_HERMES_WORKLOAD_IMAGE,
      indexDigest: DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
      amd64ManifestDigest: DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
    },
    bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
    source: { repository: "ametel01/bruno", revision: "0".repeat(40) },
    workflow: { runId: "654321", runAttempt: "1" },
    validation: {
      fullBootFixturePassedAt: "2026-08-10T23:00:00.000Z",
      sanitationPassedAt: "2026-08-10T23:05:00.000Z",
    },
    createdAt: "2026-08-10T23:06:00.000Z",
    availableAt: "2026-08-10T23:07:00.000Z",
  };
}
