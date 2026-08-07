import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import { readDigitalOceanProviderConfig } from "@/src/server/env";
import { buildRunnerReleaseAttestationArtifact } from "@/src/server/runners/runner-release-attestation-artifact";
import {
  createRunnerSnapshotAttestation,
  type RunnerSnapshotManifest,
} from "@/src/server/runners/runner-snapshot-manifest";

const SOURCE_REVISION = "1".repeat(40);
const RUNNER_DIGEST = `sha256:${"a".repeat(64)}`;
const RUNNER_IMAGE = `ghcr.io/ametel01/agentbay-runner:sha-test@${RUNNER_DIGEST}`;
const AGENT_DIGEST = `sha256:${"b".repeat(64)}`;
const AGENT_IMAGE = `ghcr.io/ametel01/default-agent:exact@${AGENT_DIGEST}`;

describe("server release-attested boot configuration", () => {
  it("accepts only an exact fresh release attestation bound to the configured signed snapshot", () => {
    const now = new Date();
    const snapshotKeys = generateKeyPairSync("ed25519");
    const releaseKeys = generateKeyPairSync("ed25519");
    const snapshot = createRunnerSnapshotAttestation({
      manifest: manifest(now),
      privateKeyPem: snapshotKeys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });
    const release = buildRunnerReleaseAttestationArtifact({
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
      fullFixturePassedAt: timestamp(now, -2),
      cleanupVerifiedAt: timestamp(now, -1),
      now,
    });
    const env = {
      AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
      AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
      AGENTBAY_DIGITALOCEAN_REGION: "sfo3",
      AGENTBAY_DIGITALOCEAN_SIZE_SLUG: "s-1vcpu-2gb",
      AGENTBAY_DIGITALOCEAN_IMAGE: "ubuntu-24-04-x64",
      AGENTBAY_RUNNER_IMAGE: RUNNER_IMAGE,
      AGENTBAY_DOCKER_RUNNER_IMAGE: AGENT_IMAGE,
      AGENTBAY_DIGITALOCEAN_IMAGE_MODE: "snapshot",
      AGENTBAY_DIGITALOCEAN_SNAPSHOT_MANIFEST: snapshot.canonicalBytes,
      AGENTBAY_DIGITALOCEAN_SNAPSHOT_SIGNATURE: snapshot.signature,
      AGENTBAY_DIGITALOCEAN_SNAPSHOT_PUBLIC_KEY: snapshotKeys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
      AGENTBAY_RELEASE_SOURCE_REVISION: SOURCE_REVISION,
      AGENTBAY_RUNNER_BOOT_VALIDATION_MODE: "release_attested",
      AGENTBAY_RUNNER_RELEASE_ATTESTATION: release.canonicalBytes,
      AGENTBAY_RUNNER_RELEASE_ATTESTATION_SIGNATURE: release.signature,
      AGENTBAY_RUNNER_RELEASE_ATTESTATION_PUBLIC_KEY: releaseKeys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
    };

    expect(readDigitalOceanProviderConfig(env)?.bootValidation).toMatchObject({
      mode: "release_attested",
      releaseAttestationDigest: release.digest,
      snapshotId: "1102",
      snapshotManifestDigest: snapshot.digest,
      sourceRevision: SOURCE_REVISION,
    });
    expect(() =>
      readDigitalOceanProviderConfig({
        ...env,
        AGENTBAY_RUNNER_RELEASE_ATTESTATION_SIGNATURE: `${release.signature}tampered`,
      }),
    ).toThrow("attestation_signature_invalid");
  });
});

function manifest(now: Date): RunnerSnapshotManifest {
  return {
    schemaVersion: "plingpling.runner.snapshot.v1",
    snapshot: {
      id: "1102",
      name: "runner-snapshot-1102",
      regions: ["sfo3"],
      minDiskSizeGb: 50,
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
    source: { repository: "ametel01/plingpling", revision: SOURCE_REVISION },
    workflow: { runId: "654321", runAttempt: "1" },
    validation: {
      fullBootFixturePassedAt: timestamp(now, -10),
      sanitationPassedAt: timestamp(now, -9),
    },
    createdAt: timestamp(now, -8),
    availableAt: timestamp(now, -7),
    expiresAt: timestamp(now, 7 * 24 * 60),
  };
}

function timestamp(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}
