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
const RUNNER_IMAGE = `ghcr.io/ametel01/bruno-runner:abc123@${RUNNER_DIGEST}`;
const AGENT_IMAGE = `ghcr.io/ametel01/bruno-default:abc123@${AGENT_DIGEST}`;
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

  it.each([
    ["wrong schema", () => ({ ...manifest(), schemaVersion: "other" }), "manifest_schema_invalid"],
    [
      "future timestamp",
      () => ({ ...manifest(), availableAt: "2026-08-08T00:00:00.000Z" }),
      "manifest_not_yet_valid",
    ],
    [
      "reversed timestamps",
      () => ({
        ...manifest(),
        validation: {
          fullBootFixturePassedAt: "2026-08-06T23:59:00.000Z",
          sanitationPassedAt: "2026-08-07T00:00:01.000Z",
        },
        createdAt: "2026-08-07T00:00:00.000Z",
      }),
      "manifest_schema_invalid",
    ],
    [
      "wrong region",
      () => ({ ...manifest(), snapshot: { ...manifest().snapshot, regions: ["nyc3"] } }),
      "manifest_region_unavailable",
    ],
    [
      "wrong base",
      () => ({ ...manifest(), baseImage: { ...manifest().baseImage, slug: "ubuntu-22-04-x64" } }),
      "manifest_identity_mismatch",
    ],
    [
      "wrong arch",
      () => ({ ...manifest(), snapshot: { ...manifest().snapshot, architecture: "arm64" } }),
      "manifest_schema_invalid",
    ],
    [
      "wrong source",
      () => ({ ...manifest(), source: { ...manifest().source, revision: "2".repeat(40) } }),
      "manifest_identity_mismatch",
    ],
    [
      "wrong boot contract",
      () => ({ ...manifest(), bootContractVersion: "bruno.runner.boot.v0" }),
      "manifest_schema_invalid",
    ],
    [
      "wrong agent image",
      () => ({
        ...manifest(),
        defaultAgentImage: {
          reference: AGENT_IMAGE.replace("abc123", "def456"),
          digest: AGENT_DIGEST,
        },
      }),
      "manifest_identity_mismatch",
    ],
    [
      "minimum disk mismatch",
      () => ({ ...manifest(), snapshot: { ...manifest().snapshot, minDiskSizeGb: 26 } }),
      "manifest_min_disk_mismatch",
    ],
  ])("fails closed for %s", (_label, mutate, reason) => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const rawManifest = mutate() as RunnerSnapshotManifest;

    if (reason === "manifest_schema_invalid") {
      expect(() =>
        createRunnerSnapshotAttestation({
          manifest: rawManifest,
          privateKeyPem,
        }),
      ).toThrow("manifest_schema_invalid");
      return;
    }

    const attestation = createRunnerSnapshotAttestation({
      manifest: rawManifest,
      privateKeyPem,
    });

    expect(
      verifyRunnerSnapshotManifest({
        manifestBytes: attestation.canonicalBytes,
        signature: attestation.signature,
        publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
        expected: expected(),
      }),
    ).toEqual({ ok: false, reason });
  });

  it("fails closed for wrong signing key and unavailable provider image", async () => {
    const signing = generateKeyPairSync("ed25519");
    const wrong = generateKeyPairSync("ed25519");
    const attestation = createRunnerSnapshotAttestation({
      manifest: manifest(),
      privateKeyPem: signing.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });

    expect(
      verifyRunnerSnapshotManifest({
        manifestBytes: attestation.canonicalBytes,
        signature: attestation.signature,
        publicKeyPem: wrong.publicKey.export({ format: "pem", type: "spki" }).toString(),
        expected: expected(),
      }),
    ).toEqual({ ok: false, reason: "manifest_signature_invalid" });

    const provider = new UnavailableImageProvider();
    await expect(
      selectVerifiedRunnerSnapshotImage({
        manifestBytes: attestation.canonicalBytes,
        signature: attestation.signature,
        publicKeyPem: signing.publicKey.export({ format: "pem", type: "spki" }).toString(),
        expected: expected(),
        provider,
      }),
    ).resolves.toEqual({ ok: false, reason: "provider_image_unavailable" });
    expect(provider.calls.map((call) => call.step)).toEqual(["readImage"]);
  });
});

class UnavailableImageProvider extends FakeDigitalOceanProvider {
  override async readImageAvailability(
    input: Parameters<FakeDigitalOceanProvider["readImageAvailability"]>[0],
  ) {
    await super.readImageAvailability(input);
    return {
      ok: true as const,
      value: {
        id: input.imageId,
        name: "unavailable",
        regions: ["nyc3"],
        minDiskSizeGb: 25,
        architecture: "amd64" as const,
        status: "available" as const,
      },
    };
  }
}

function expected(): RunnerSnapshotExpectedIdentities {
  return {
    region: "sfo3",
    sizeDiskGb: 25,
    baseImageSlug: "ubuntu-24-04-x64",
    architecture: "amd64",
    runnerImage: RUNNER_IMAGE,
    defaultAgentImage: AGENT_IMAGE,
    hermesImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
    sourceRepository: "ametel01/bruno",
    sourceRevision: SOURCE_REVISION,
    now: NOW,
  };
}

function manifest(): RunnerSnapshotManifest {
  return {
    schemaVersion: "bruno.runner.snapshot.v1",
    snapshot: {
      id: "1102",
      name: "bruno-snapshot-builder-111111111111",
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
    source: { repository: "ametel01/bruno", revision: SOURCE_REVISION },
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
