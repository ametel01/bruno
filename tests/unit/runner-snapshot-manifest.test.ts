import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import { FakeDigitalOceanProvider } from "@/src/server/runners/digitalocean-provider";
import {
  createRunnerSnapshotAttestation,
  selectApprovedRunnerSnapshotImage,
  verifyRunnerSnapshotBundle,
  type RunnerSnapshotExpectedIdentities,
  type RunnerSnapshotManifest,
} from "@/src/server/runners/runner-snapshot-manifest";

const RUNNER_DIGEST = `sha256:${"a".repeat(64)}`;
const AGENT_DIGEST = `sha256:${"b".repeat(64)}`;
const RUNNER_IMAGE = `ghcr.io/ametel01/bruno-runner:abc123@${RUNNER_DIGEST}`;
const AGENT_IMAGE = `ghcr.io/ametel01/bruno-default:abc123@${AGENT_DIGEST}`;
const SOURCE_REVISION = "1".repeat(40);
const OPTIMIZED_HERMES_INDEX_DIGEST = `sha256:${"c".repeat(64)}`;
const OPTIMIZED_HERMES_AMD64_DIGEST = `sha256:${"d".repeat(64)}`;
const OPTIMIZED_HERMES_IMAGE = `ghcr.io/ametel01/bruno-hermes:optimized-test@${OPTIMIZED_HERMES_INDEX_DIGEST}`;

describe("runner snapshot manifest", () => {
  it("verifies an approved v2 bundle through its identified trusted key without time expiry", () => {
    const signing = generateKeyPairSync("ed25519");
    const attestation = attest(manifest(), "snapshot-2026-08", signing.privateKey);

    expect(
      verifyRunnerSnapshotBundle({
        bundleBytes: attestation.bundleBytes,
        approvedDigest: attestation.digest,
        trustedPublicKeys: {
          "snapshot-2026-08": publicKeyPem(signing.publicKey),
        },
        expected: expected(),
      }),
    ).toMatchObject({
      ok: true,
      digest: attestation.digest,
      signingKeyId: "snapshot-2026-08",
      manifest: {
        source: { repository: "ametel01/bruno", revision: SOURCE_REVISION },
        createdAt: "2020-01-01T00:00:00.000Z",
      },
    });
  });

  it("verifies a signed allowlisted optimized Hermes image identity", () => {
    const signing = generateKeyPairSync("ed25519");
    const optimizedManifest: RunnerSnapshotManifest = {
      ...manifest(),
      hermesImage: {
        reference: OPTIMIZED_HERMES_IMAGE,
        indexDigest: OPTIMIZED_HERMES_INDEX_DIGEST,
        amd64ManifestDigest: OPTIMIZED_HERMES_AMD64_DIGEST,
      },
    };
    const attestation = attest(optimizedManifest, "snapshot-current", signing.privateKey);

    expect(
      verifyRunnerSnapshotBundle({
        bundleBytes: attestation.bundleBytes,
        approvedDigest: attestation.digest,
        trustedPublicKeys: { "snapshot-current": publicKeyPem(signing.publicKey) },
        expected: {
          ...expected(),
          hermesImage: OPTIMIZED_HERMES_IMAGE,
          hermesAmd64ManifestDigest: OPTIMIZED_HERMES_AMD64_DIGEST,
        },
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects manifest v1 and unknown evidence fields before approval", () => {
    const signing = generateKeyPairSync("ed25519");
    const v1 = {
      ...manifest(),
      schemaVersion: "bruno.runner.snapshot.v1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };

    expect(() =>
      attest(v1 as unknown as RunnerSnapshotManifest, "snapshot-old", signing.privateKey),
    ).toThrow("manifest_schema_invalid");
    expect(() =>
      attest(
        { ...manifest(), ownerToken: "secret" } as unknown as RunnerSnapshotManifest,
        "snapshot-current",
        signing.privateKey,
      ),
    ).toThrow("manifest_schema_invalid");
    expect(() =>
      attest(
        {
          ...manifest(),
          validation: {
            ...manifest().validation,
            sanitationPassedAt: "2020-01-01T00:00:02.000Z",
          },
        },
        "snapshot-current",
        signing.privateKey,
      ),
    ).toThrow("manifest_schema_invalid");
    expect(() => attest(manifest(), "bad key id", signing.privateKey)).toThrow(
      "signing key ID is invalid",
    );
    expect(() =>
      attest(
        {
          ...manifest(),
          runner: { ...manifest().runner, architecture: "arm64" },
        } as unknown as RunnerSnapshotManifest,
        "snapshot-current",
        signing.privateKey,
      ),
    ).toThrow("manifest_schema_invalid");
  });

  it.each([
    ["runner profile", { sizeSlug: "s-2vcpu-4gb" }, "manifest_identity_mismatch"],
    ["runner disk", { sizeDiskGb: 60 }, "manifest_identity_mismatch"],
    ["base OS ID", { baseImageId: "ubuntu-24-04-x64-20200202" }, "manifest_identity_mismatch"],
    ["base OS", { baseImageSlug: "ubuntu-22-04-x64" }, "manifest_identity_mismatch"],
    [
      "runner image",
      { runnerImage: RUNNER_IMAGE.replace("abc123", "def456") },
      "manifest_identity_mismatch",
    ],
    [
      "default-agent image",
      { defaultAgentImage: AGENT_IMAGE.replace("abc123", "def456") },
      "manifest_identity_mismatch",
    ],
    [
      "Hermes image",
      { hermesImage: `${DEFAULT_HERMES_WORKLOAD_IMAGE}-other` },
      "manifest_identity_mismatch",
    ],
    [
      "boot contract",
      { bootContractVersion: "bruno.runner.boot.v0" },
      "manifest_identity_mismatch",
    ],
    ["region", { region: "nyc3" }, "manifest_region_unavailable"],
  ])("rejects an exact %s mismatch", (_label, changedExpected, reason) => {
    const signing = generateKeyPairSync("ed25519");
    const attestation = attest(manifest(), "snapshot-current", signing.privateKey);

    expect(
      verifyRunnerSnapshotBundle({
        bundleBytes: attestation.bundleBytes,
        approvedDigest: attestation.digest,
        trustedPublicKeys: { "snapshot-current": publicKeyPem(signing.publicKey) },
        expected: { ...expected(), ...changedExpected },
      }),
    ).toEqual({ ok: false, reason });
  });

  it("supports overlapping trusted keys and fails closed after a signing key is removed", () => {
    const previous = generateKeyPairSync("ed25519");
    const current = generateKeyPairSync("ed25519");
    const previousBundle = attest(manifest(), "snapshot-previous", previous.privateKey);
    const currentBundle = attest(
      { ...manifest(), workflow: { runId: "123457", runAttempt: "1" } },
      "snapshot-current",
      current.privateKey,
    );
    const overlap = {
      "snapshot-previous": publicKeyPem(previous.publicKey),
      "snapshot-current": publicKeyPem(current.publicKey),
    };

    for (const attestation of [previousBundle, currentBundle]) {
      expect(
        verifyRunnerSnapshotBundle({
          bundleBytes: attestation.bundleBytes,
          approvedDigest: attestation.digest,
          trustedPublicKeys: overlap,
          expected: expected(),
        }),
      ).toMatchObject({ ok: true });
    }

    expect(
      verifyRunnerSnapshotBundle({
        bundleBytes: previousBundle.bundleBytes,
        approvedDigest: previousBundle.digest,
        trustedPublicKeys: { "snapshot-current": publicKeyPem(current.publicKey) },
        expected: expected(),
      }),
    ).toEqual({ ok: false, reason: "manifest_signing_key_untrusted" });
  });

  it("rejects a snapshot minimum disk larger than the exact runner disk", () => {
    const signing = generateKeyPairSync("ed25519");
    const attestation = attest(
      {
        ...manifest(),
        snapshot: { ...manifest().snapshot, minDiskSizeGb: 51 },
      },
      "snapshot-current",
      signing.privateKey,
    );

    expect(
      verifyRunnerSnapshotBundle({
        bundleBytes: attestation.bundleBytes,
        approvedDigest: attestation.digest,
        trustedPublicKeys: { "snapshot-current": publicKeyPem(signing.publicKey) },
        expected: expected(),
      }),
    ).toEqual({ ok: false, reason: "manifest_min_disk_mismatch" });
  });

  it("promotes, revokes, and rolls back exact retained bundle digests without rewriting attestations", () => {
    const signing = generateKeyPairSync("ed25519");
    const retained = attest(manifest(), "snapshot-retained", signing.privateKey);
    const promoted = attest(
      { ...manifest(), workflow: { runId: "123457", runAttempt: "1" } },
      "snapshot-retained",
      signing.privateKey,
    );
    const trustSet = { "snapshot-retained": publicKeyPem(signing.publicKey) };

    expect(
      verifyRunnerSnapshotBundle({
        bundleBytes: retained.bundleBytes,
        approvedDigest: promoted.digest,
        trustedPublicKeys: trustSet,
        expected: expected(),
      }),
    ).toEqual({ ok: false, reason: "manifest_not_approved" });
    expect(
      verifyRunnerSnapshotBundle({
        bundleBytes: promoted.bundleBytes,
        trustedPublicKeys: trustSet,
        expected: expected(),
      }),
    ).toEqual({ ok: false, reason: "manifest_not_approved" });
    expect(
      verifyRunnerSnapshotBundle({
        bundleBytes: retained.bundleBytes,
        approvedDigest: retained.digest,
        trustedPublicKeys: trustSet,
        expected: expected(),
      }),
    ).toMatchObject({ ok: true, digest: retained.digest });
    expect(retained.bundleBytes).toContain(SOURCE_REVISION);
  });

  it("checks exact authoritative provider availability only after trust and approval", async () => {
    const signing = generateKeyPairSync("ed25519");
    const attestation = attest(manifest(), "snapshot-current", signing.privateKey);
    const trustedPublicKeys = { "snapshot-current": publicKeyPem(signing.publicKey) };
    const matchingProvider = new MatchingImageProvider();

    await expect(
      selectApprovedRunnerSnapshotImage({
        bundleBytes: attestation.bundleBytes,
        approvedDigest: attestation.digest,
        trustedPublicKeys,
        expected: expected(),
        provider: matchingProvider,
      }),
    ).resolves.toMatchObject({
      ok: true,
      image: "1102",
      digest: attestation.digest,
      signingKeyId: "snapshot-current",
    });
    expect(matchingProvider.calls.map((call) => call.step)).toEqual(["readImage"]);

    const provider = new UnavailableImageProvider();

    await expect(
      selectApprovedRunnerSnapshotImage({
        bundleBytes: attestation.bundleBytes,
        approvedDigest: attestation.digest,
        trustedPublicKeys,
        expected: expected(),
        provider,
      }),
    ).resolves.toEqual({ ok: false, reason: "provider_image_unavailable" });
    expect(provider.calls.map((call) => call.step)).toEqual(["readImage"]);

    const unapprovedProvider = new UnavailableImageProvider();
    await expect(
      selectApprovedRunnerSnapshotImage({
        bundleBytes: attestation.bundleBytes,
        approvedDigest: `sha256:${"f".repeat(64)}`,
        trustedPublicKeys,
        expected: expected(),
        provider: unapprovedProvider,
      }),
    ).resolves.toEqual({ ok: false, reason: "manifest_not_approved" });
    expect(unapprovedProvider.calls).toEqual([]);

    const v1Provider = new MatchingImageProvider();
    await expect(
      selectApprovedRunnerSnapshotImage({
        bundleBytes: attestation.bundleBytes.replace(
          "bruno.runner.snapshot.v2",
          "bruno.runner.snapshot.v1",
        ),
        approvedDigest: attestation.digest,
        trustedPublicKeys,
        expected: expected(),
        provider: v1Provider,
      }),
    ).resolves.toEqual({ ok: false, reason: "manifest_schema_invalid" });
    expect(v1Provider.calls).toEqual([]);
  });

  it("fails closed for tampering, malformed bundles, invalid signatures, and untrusted keys", () => {
    const signing = generateKeyPairSync("ed25519");
    const wrong = generateKeyPairSync("ed25519");
    const attestation = attest(manifest(), "snapshot-current", signing.privateKey);
    const base = {
      approvedDigest: attestation.digest,
      trustedPublicKeys: { "snapshot-current": publicKeyPem(signing.publicKey) },
      expected: expected(),
    };

    expect(verifyRunnerSnapshotBundle({ ...base, bundleBytes: "{" })).toEqual({
      ok: false,
      reason: "bundle_json_invalid",
    });
    expect(
      verifyRunnerSnapshotBundle({
        ...base,
        bundleBytes: attestation.bundleBytes.replace("sfo3", "nyc3"),
      }),
    ).toEqual({ ok: false, reason: "manifest_not_approved" });
    expect(
      verifyRunnerSnapshotBundle({
        ...base,
        trustedPublicKeys: { "snapshot-current": publicKeyPem(wrong.publicKey) },
        bundleBytes: attestation.bundleBytes,
      }),
    ).toEqual({ ok: false, reason: "manifest_signature_invalid" });
    expect(
      verifyRunnerSnapshotBundle({
        ...base,
        trustedPublicKeys: {},
        bundleBytes: attestation.bundleBytes,
      }),
    ).toEqual({ ok: false, reason: "manifest_signing_key_untrusted" });

    const unknownBundle = JSON.parse(attestation.bundleBytes) as Record<string, unknown>;
    unknownBundle.ownerToken = "secret";
    expect(
      verifyRunnerSnapshotBundle({ ...base, bundleBytes: JSON.stringify(unknownBundle) }),
    ).toEqual({ ok: false, reason: "bundle_schema_invalid" });

    const malformedSignature = JSON.parse(attestation.bundleBytes) as {
      signature: { value: string };
    };
    malformedSignature.signature.value = "not-a-valid-ed25519-signature";
    expect(
      verifyRunnerSnapshotBundle({ ...base, bundleBytes: JSON.stringify(malformedSignature) }),
    ).toEqual({ ok: false, reason: "bundle_schema_invalid" });
  });
});

function attest(manifestValue: RunnerSnapshotManifest, keyId: string, privateKey: KeyObject) {
  return createRunnerSnapshotAttestation({
    manifest: manifestValue,
    signingKeyId: keyId,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  });
}

function publicKeyPem(publicKey: KeyObject): string {
  return publicKey.export({ format: "pem", type: "spki" }).toString();
}

function expected(): RunnerSnapshotExpectedIdentities {
  return {
    region: "sfo3",
    sizeSlug: "s-1vcpu-2gb",
    sizeDiskGb: 50,
    baseImageId: "ubuntu-24-04-x64-20200101",
    baseImageSlug: "ubuntu-24-04-x64",
    architecture: "amd64",
    runnerImage: RUNNER_IMAGE,
    defaultAgentImage: AGENT_IMAGE,
    hermesImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
    hermesAmd64ManifestDigest: DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  };
}

function manifest(): RunnerSnapshotManifest {
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
      indexDigest: "sha256:9c841866021c54c4596849f6135717e8a4d52ba510b7f52c50aef1de1a283973",
      amd64ManifestDigest:
        "sha256:3db34ce19adfa080736a2a3feb0316dbcccc588faa9afe7fd8ae1c03b4f1a53a",
    },
    bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
    source: { repository: "ametel01/bruno", revision: SOURCE_REVISION },
    workflow: { runId: "123456", runAttempt: "1" },
    validation: {
      fullBootFixturePassedAt: "2019-12-31T23:59:00.000Z",
      sanitationPassedAt: "2019-12-31T23:59:30.000Z",
    },
    createdAt: "2020-01-01T00:00:00.000Z",
    availableAt: "2020-01-01T00:00:01.000Z",
  };
}

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

class MatchingImageProvider extends FakeDigitalOceanProvider {
  override async readImageAvailability(
    input: Parameters<FakeDigitalOceanProvider["readImageAvailability"]>[0],
  ) {
    await super.readImageAvailability(input);
    return {
      ok: true as const,
      value: {
        id: input.imageId,
        name: "bruno-snapshot-builder-111111111111",
        regions: ["sfo3"],
        minDiskSizeGb: 25,
        architecture: "amd64" as const,
        status: "available" as const,
      },
    };
  }
}
