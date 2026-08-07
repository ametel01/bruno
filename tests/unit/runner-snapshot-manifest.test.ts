import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import { FakeDigitalOceanProvider } from "@/src/server/runners/digitalocean-provider";
import {
  createRunnerSnapshotAttestation,
  selectVerifiedRunnerSnapshotImage,
  verifyRunnerSnapshotManifest,
  type RunnerSnapshotExpectedIdentities,
  type RunnerSnapshotManifest,
} from "@/src/server/runners/runner-snapshot-manifest";

const RUNNER_DIGEST = `sha256:${"a".repeat(64)}`;
const AGENT_DIGEST = `sha256:${"b".repeat(64)}`;
const RUNNER_IMAGE = `ghcr.io/ametel01/agentbay-runner:abc123@${RUNNER_DIGEST}`;
const AGENT_IMAGE = `ghcr.io/ametel01/agentbay-default:abc123@${AGENT_DIGEST}`;
const NOW = new Date("2026-08-07T00:00:00.000Z");
const SOURCE_REVISION = "1".repeat(40);

describe("runner snapshot manifest", () => {
  it("verifies canonical signed manifest bytes and provider region availability", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const attestation = createRunnerSnapshotAttestation({
      manifest: manifest(),
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });

    expect(
      verifyRunnerSnapshotManifest({
        manifestBytes: attestation.canonicalBytes,
        signature: attestation.signature,
        publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
        expected: expected(),
      }),
    ).toMatchObject({ ok: true, digest: attestation.digest });

    await expect(
      selectVerifiedRunnerSnapshotImage({
        manifestBytes: attestation.canonicalBytes,
        signature: attestation.signature,
        publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
        expected: expected(),
        provider: new FakeDigitalOceanProvider(),
      }),
    ).resolves.toMatchObject({ ok: true, image: "1102" });
  });

  it("fails closed for tampering, unknown fields, stale evidence, and wrong identity", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const attestation = createRunnerSnapshotAttestation({
      manifest: manifest(),
      privateKeyPem,
    });

    const tampered = attestation.canonicalBytes.replace("sfo3", "nyc3");
    expect(
      verifyRunnerSnapshotManifest({
        manifestBytes: tampered,
        signature: attestation.signature,
        publicKeyPem,
        expected: expected(),
      }),
    ).toEqual({ ok: false, reason: "manifest_signature_invalid" });

    expect(() =>
      createRunnerSnapshotAttestation({
        manifest: { ...manifest(), hostile: true } as unknown as RunnerSnapshotManifest,
        privateKeyPem,
      }),
    ).toThrow("manifest_schema_invalid");

    expect(
      verifyRunnerSnapshotManifest({
        manifestBytes: attestation.canonicalBytes,
        signature: attestation.signature,
        publicKeyPem,
        expected: { ...expected(), now: new Date("2026-09-01T00:00:00.000Z") },
      }),
    ).toEqual({ ok: false, reason: "manifest_stale" });

    expect(
      verifyRunnerSnapshotManifest({
        manifestBytes: attestation.canonicalBytes,
        signature: attestation.signature,
        publicKeyPem,
        expected: { ...expected(), runnerImage: RUNNER_IMAGE.replace("abc123", "def456") },
      }),
    ).toEqual({ ok: false, reason: "manifest_identity_mismatch" });
  });
});

function expected(): RunnerSnapshotExpectedIdentities {
  return {
    region: "sfo3",
    sizeDiskGb: 25,
    baseImageSlug: "ubuntu-24-04-x64",
    architecture: "amd64",
    runnerImage: RUNNER_IMAGE,
    defaultAgentImage: AGENT_IMAGE,
    hermesImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
    sourceRepository: "ametel01/plingpling",
    sourceRevision: SOURCE_REVISION,
    now: NOW,
  };
}

function manifest(): RunnerSnapshotManifest {
  return {
    schemaVersion: "plingpling.runner.snapshot.v1",
    snapshot: {
      id: "1102",
      name: "agentbay-snapshot-builder-111111111111",
      regions: ["sfo3"],
      minDiskSizeGb: 25,
      architecture: "amd64",
    },
    baseImage: { id: "ubuntu-24-04-x64-20260801", slug: "ubuntu-24-04-x64" },
    runnerImage: { reference: RUNNER_IMAGE, digest: RUNNER_DIGEST },
    defaultAgentImage: { reference: AGENT_IMAGE, digest: AGENT_DIGEST },
    hermesImage: {
      reference: DEFAULT_HERMES_WORKLOAD_IMAGE,
      indexDigest: "sha256:9c841866021c54c4596849f6135717e8a4d52ba510b7f52c50aef1de1a283973",
      amd64ManifestDigest:
        "sha256:3db34ce19adfa080736a2a3feb0316dbcccc588faa9afe7fd8ae1c03b4f1a53a",
    },
    bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
    source: { repository: "ametel01/plingpling", revision: SOURCE_REVISION },
    workflow: { runId: "123456", runAttempt: "1" },
    validation: {
      fullBootFixturePassedAt: "2026-08-06T23:59:00.000Z",
      sanitationPassedAt: "2026-08-06T23:59:30.000Z",
    },
    createdAt: "2026-08-06T23:59:31.000Z",
    availableAt: "2026-08-07T00:00:00.000Z",
    expiresAt: "2026-08-14T00:00:00.000Z",
  };
}
