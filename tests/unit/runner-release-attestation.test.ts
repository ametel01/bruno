import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RUNNER_BOOT_CONTRACT_VERSION,
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
} from "@/src/runner-service/constants";
import {
  RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
  RUNNER_CANARY_CONTRACT_VERSION,
  RUNNER_LAUNCH_CONTRACT_VERSION,
  RUNNER_STATUS_CONTRACT_VERSION,
} from "@/src/runner-service/runner-contracts";
import {
  createRunnerReleaseBundle,
  RUNNER_RELEASE_BUNDLE_SCHEMA_VERSION,
  RUNNER_RELEASE_MANIFEST_SCHEMA_VERSION,
  verifyRunnerReleaseBundle,
  type RunnerReleaseManifest,
} from "@/src/runner-service/release-attestation";

const SOURCE_REVISION = "1".repeat(40);
const RUNNER_DIGEST = `sha256:${"a".repeat(64)}`;
const AGENT_DIGEST = `sha256:${"b".repeat(64)}`;
const SNAPSHOT_DIGEST = `sha256:${"c".repeat(64)}`;
const RUNNER_IMAGE = `ghcr.io/ametel01/bruno-runner:${SOURCE_REVISION}@${RUNNER_DIGEST}`;
const AGENT_IMAGE = `ghcr.io/ametel01/bruno-default:release@${AGENT_DIGEST}`;
const SNAPSHOT_OCI = `ghcr.io/ametel01/bruno-runner-snapshot-bundles@sha256:${"d".repeat(64)}`;
const OPTIMIZED_HERMES_INDEX_DIGEST = `sha256:${"e".repeat(64)}`;
const OPTIMIZED_HERMES_AMD64_DIGEST = `sha256:${"f".repeat(64)}`;
const OPTIMIZED_HERMES_IMAGE = `ghcr.io/ametel01/bruno-hermes:optimized-test@${OPTIMIZED_HERMES_INDEX_DIGEST}`;

describe("runner Verified Release bundle", () => {
  it("verifies exact immutable release and snapshot identities without time expiry", () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    const signed = createRunnerReleaseBundle({
      manifest: manifest(),
      signingKeyId: "release-current",
      privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });

    expect(JSON.parse(signed.bundleBytes)).toMatchObject({
      schemaVersion: RUNNER_RELEASE_BUNDLE_SCHEMA_VERSION,
      manifest: { schemaVersion: RUNNER_RELEASE_MANIFEST_SCHEMA_VERSION },
      signature: { algorithm: "Ed25519", keyId: "release-current" },
    });
    expect(
      verifyRunnerReleaseBundle({
        bundleBytes: signed.bundleBytes,
        approvedDigest: signed.digest,
        trustedPublicKeys: { "release-current": publicKey },
        expected: expected(),
      }),
    ).toMatchObject({ ok: true, digest: signed.digest, signingKeyId: "release-current" });

    const historical = {
      ...manifest(),
      validation: {
        ...manifest().validation,
        fullFixturePassedAt: "2019-12-31T23:58:00.000Z",
        cleanupVerifiedAt: "2019-12-31T23:59:00.000Z",
      },
      createdAt: "2020-01-01T00:00:00.000Z",
    };
    const historicalBundle = createRunnerReleaseBundle({
      manifest: historical,
      signingKeyId: "release-current",
      privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });
    expect(
      verifyRunnerReleaseBundle({
        bundleBytes: historicalBundle.bundleBytes,
        approvedDigest: historicalBundle.digest,
        trustedPublicKeys: { "release-current": publicKey },
        expected: expected(),
      }),
    ).toMatchObject({ ok: true });
  });

  it("verifies an optimized Hermes image carried by the signed snapshot release", () => {
    const keys = generateKeyPairSync("ed25519");
    const optimizedManifest: RunnerReleaseManifest = {
      ...manifest(),
      hermesImage: {
        reference: OPTIMIZED_HERMES_IMAGE,
        indexDigest: OPTIMIZED_HERMES_INDEX_DIGEST,
        amd64ManifestDigest: OPTIMIZED_HERMES_AMD64_DIGEST,
      },
    };
    const signed = createRunnerReleaseBundle({
      manifest: optimizedManifest,
      signingKeyId: "release-current",
      privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });

    expect(
      verifyRunnerReleaseBundle({
        bundleBytes: signed.bundleBytes,
        approvedDigest: signed.digest,
        trustedPublicKeys: {
          "release-current": keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        },
        expected: { ...expected(), hermesImage: OPTIMIZED_HERMES_IMAGE },
      }),
    ).toMatchObject({ ok: true });
  });

  it("fails closed for an unapproved, tampered, untrusted, or mismatched bundle", () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    const signed = createRunnerReleaseBundle({
      manifest: manifest(),
      signingKeyId: "release-current",
      privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });
    const base = {
      bundleBytes: signed.bundleBytes,
      approvedDigest: signed.digest,
      trustedPublicKeys: { "release-current": publicKey },
      expected: expected(),
    };

    expect(
      verifyRunnerReleaseBundle({ ...base, approvedDigest: `sha256:${"f".repeat(64)}` }),
    ).toEqual({ ok: false, reason: "release_not_approved" });
    expect(
      verifyRunnerReleaseBundle({
        ...base,
        bundleBytes: signed.bundleBytes.replace(SOURCE_REVISION, "2".repeat(40)),
      }),
    ).toEqual({ ok: false, reason: "release_not_approved" });
    expect(verifyRunnerReleaseBundle({ ...base, trustedPublicKeys: {} })).toEqual({
      ok: false,
      reason: "release_signing_key_untrusted",
    });
    expect(
      verifyRunnerReleaseBundle({
        ...base,
        expected: { ...expected(), snapshotBundleDigest: `sha256:${"e".repeat(64)}` },
      }),
    ).toEqual({ ok: false, reason: "release_identity_mismatch" });
  });
});

function expected() {
  return {
    sourceRevision: SOURCE_REVISION,
    runnerImage: RUNNER_IMAGE,
    defaultAgentImage: AGENT_IMAGE,
    hermesImage: `nousresearch/hermes-agent:release@${DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST}`,
    snapshotOciReference: SNAPSHOT_OCI,
    snapshotBundleDigest: SNAPSHOT_DIGEST,
    bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
  };
}

function manifest(): RunnerReleaseManifest {
  return {
    schemaVersion: RUNNER_RELEASE_MANIFEST_SCHEMA_VERSION,
    controlPlane: {
      source: { repository: "ametel01/bruno", revision: SOURCE_REVISION },
      contracts: {
        launch: RUNNER_LAUNCH_CONTRACT_VERSION,
        status: RUNNER_STATUS_CONTRACT_VERSION,
        canary: RUNNER_CANARY_CONTRACT_VERSION,
        bootSnapshot: RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
        boot: RUNNER_BOOT_CONTRACT_VERSION,
      },
    },
    runnerImage: { reference: RUNNER_IMAGE, digest: RUNNER_DIGEST, version: SOURCE_REVISION },
    defaultAgentImage: { reference: AGENT_IMAGE, digest: AGENT_DIGEST },
    hermesImage: {
      reference: `nousresearch/hermes-agent:release@${DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST}`,
      indexDigest: DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
      amd64ManifestDigest: DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
    },
    snapshot: {
      ociReference: SNAPSHOT_OCI,
      bundleDigest: SNAPSHOT_DIGEST,
      signingKeyId: "snapshot-current",
      manifestSchemaVersion: "bruno.runner.snapshot.v2",
      provider: "digitalocean",
      imageId: "1102",
    },
    workflow: { runId: "123456", runAttempt: "1" },
    validation: {
      mode: "full",
      providerMode: "local_docker",
      observedChecks: [
        "docker",
        "hermesFixture",
        "detailedHealth",
        "modelCanary",
        "telegramConfig",
        "cleanup",
      ],
      syntheticActions: ["start", "status", "canary", "stop"],
      fullFixturePassedAt: "2026-08-11T00:00:00.000Z",
      cleanupVerifiedAt: "2026-08-11T00:01:00.000Z",
    },
    createdAt: "2026-08-11T00:02:00.000Z",
  };
}
