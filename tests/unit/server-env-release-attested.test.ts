import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import { RUNNER_BOOT_COMPONENTS } from "@/src/runner-service/runner-contracts";
import { readDigitalOceanProviderConfig } from "@/src/server/env";
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

describe("release-attested provider configuration", () => {
  it("requires compatible approved Snapshot v2 and Verified Release bundles", () => {
    const configured = attestedEnvironment();
    const config = readDigitalOceanProviderConfig(configured.env);

    expect(config?.bootValidation).toMatchObject({
      mode: "release_attested",
      approvedReleaseDigest: configured.releaseDigest,
      snapshotBundleDigest: configured.snapshotDigest,
      snapshotImageId: "1102",
    });

    expect(() =>
      readDigitalOceanProviderConfig({
        ...configured.env,
        BRUNO_RUNNER_APPROVED_RELEASE_DIGEST: `sha256:${"f".repeat(64)}`,
      }),
    ).toThrow("release_not_approved");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_RUNNER_IMAGE: RUNNER_IMAGE,
        BRUNO_RUNNER_BOOT_VALIDATION_MODE: "release_attested",
      }),
    ).toThrow("requires an Approved Snapshot");
  });
});

function attestedEnvironment(): {
  env: Record<string, string>;
  releaseDigest: string;
  snapshotDigest: string;
} {
  const snapshotKeys = generateKeyPairSync("ed25519");
  const releaseKeys = generateKeyPairSync("ed25519");
  const snapshot = createRunnerSnapshotAttestation({
    manifest: snapshotManifest(),
    signingKeyId: "snapshot-current",
    privateKeyPem: snapshotKeys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  });
  const release = buildRunnerReleaseBundleArtifact({
    controlPlaneSourceRevision: SOURCE_REVISION,
    runnerImage: RUNNER_IMAGE,
    snapshotBundleBytes: snapshot.bundleBytes,
    approvedSnapshotDigest: snapshot.digest,
    snapshotTrustedPublicKeys: {
      "snapshot-current": snapshotKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    },
    snapshotOciReference: SNAPSHOT_OCI,
    releaseSigningKeyId: "release-current",
    releasePrivateKeyPem: releaseKeys.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    workflowRunId: "123456",
    workflowRunAttempt: "1",
    smokeResult: {
      ok: true,
      code: "passed",
      sideEffectsAttempted: true,
      cleanupVerified: true,
      evidence: {
        providerMode: "local_docker",
        releaseVersion: SOURCE_REVISION,
        imageDigest: RUNNER_DIGEST,
        bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
        bootComponents: [...RUNNER_BOOT_COMPONENTS],
        syntheticActions: ["start", "status", "canary", "stop"],
      },
    },
    fullFixturePassedAt: "2026-08-11T00:00:00.000Z",
    cleanupVerifiedAt: "2026-08-11T00:01:00.000Z",
    now: new Date("2026-08-11T00:02:00.000Z"),
  });
  const snapshotPublicKey = snapshotKeys.publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  const releasePublicKey = releaseKeys.publicKey.export({ format: "pem", type: "spki" }).toString();

  return {
    snapshotDigest: snapshot.digest,
    releaseDigest: release.digest,
    env: {
      BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
      BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
      BRUNO_RUNNER_IMAGE: RUNNER_IMAGE,
      BRUNO_DOCKER_RUNNER_IMAGE: AGENT_IMAGE,
      BRUNO_HERMES_WORKLOAD_IMAGE: DEFAULT_HERMES_WORKLOAD_IMAGE,
      BRUNO_DIGITALOCEAN_SIZE_SLUG: "s-1vcpu-2gb",
      BRUNO_DIGITALOCEAN_IMAGE_MODE: "snapshot",
      BRUNO_DIGITALOCEAN_SNAPSHOT_BASE_IMAGE_ID: "ubuntu-24-04-x64-20200101",
      BRUNO_DIGITALOCEAN_SNAPSHOT_BUNDLE: snapshot.bundleBytes,
      BRUNO_DIGITALOCEAN_APPROVED_SNAPSHOT_DIGEST: snapshot.digest,
      BRUNO_DIGITALOCEAN_SNAPSHOT_TRUST_SET: JSON.stringify({
        "snapshot-current": snapshotPublicKey,
      }),
      BRUNO_RUNNER_BOOT_VALIDATION_MODE: "release_attested",
      BRUNO_RUNNER_RELEASE_BUNDLE: release.bundleBytes,
      BRUNO_RUNNER_APPROVED_RELEASE_DIGEST: release.digest,
      BRUNO_RUNNER_RELEASE_TRUST_SET: JSON.stringify({
        "release-current": releasePublicKey,
      }),
      BRUNO_RUNNER_APPROVED_SNAPSHOT_OCI: SNAPSHOT_OCI,
    },
  };
}

function snapshotManifest(): RunnerSnapshotManifest {
  return {
    schemaVersion: "bruno.runner.snapshot.v2",
    runner: {
      region: "sfo3",
      sizeSlug: "s-1vcpu-2gb",
      diskSizeGb: 50,
      architecture: "amd64",
    },
    snapshot: {
      provider: "digitalocean",
      id: "1102",
      name: "bruno-snapshot-builder-111111111111",
      status: "available",
      regions: ["sfo3"],
      minDiskSizeGb: 25,
      architecture: "amd64",
    },
    baseImage: { id: "ubuntu-24-04-x64-20200101", slug: "ubuntu-24-04-x64" },
    runnerImage: { reference: RUNNER_IMAGE, digest: RUNNER_DIGEST },
    defaultAgentImage: { reference: AGENT_IMAGE, digest: AGENT_DIGEST },
    hermesImage: {
      reference: DEFAULT_HERMES_WORKLOAD_IMAGE,
      indexDigest: DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
      amd64ManifestDigest: DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
    },
    bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
    source: { repository: "ametel01/bruno", revision: SOURCE_REVISION },
    workflow: { runId: "123456", runAttempt: "1" },
    validation: {
      fullBootFixturePassedAt: "2026-08-11T00:00:00.000Z",
      sanitationPassedAt: "2026-08-11T00:00:30.000Z",
    },
    createdAt: "2026-08-11T00:01:00.000Z",
    availableAt: "2026-08-11T00:01:30.000Z",
  };
}
