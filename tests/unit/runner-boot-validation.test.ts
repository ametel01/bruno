import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  resolveRunnerBootValidation,
  RUNNER_APPROVED_SNAPSHOT_DIGEST_ENV,
  RUNNER_APPROVED_SNAPSHOT_OCI_ENV,
  RUNNER_BOOT_VALIDATION_MODE_ENV,
  RUNNER_RELEASE_APPROVED_DIGEST_ENV,
  RUNNER_RELEASE_BUNDLE_ENV,
  RUNNER_RELEASE_TRUST_SET_ENV,
} from "@/src/runner-service/boot-validation";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import {
  createRunnerReleaseBundle,
  RUNNER_RELEASE_MANIFEST_SCHEMA_VERSION,
  type RunnerReleaseManifest,
} from "@/src/runner-service/release-attestation";
import {
  RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
  RUNNER_CANARY_CONTRACT_VERSION,
  RUNNER_LAUNCH_CONTRACT_VERSION,
  RUNNER_STATUS_CONTRACT_VERSION,
} from "@/src/runner-service/runner-contracts";

const SOURCE_REVISION = "1".repeat(40);
const RUNNER_DIGEST = `sha256:${"a".repeat(64)}`;
const AGENT_DIGEST = `sha256:${"b".repeat(64)}`;
const SNAPSHOT_DIGEST = `sha256:${"c".repeat(64)}`;
const RUNNER_IMAGE = `ghcr.io/ametel01/bruno-runner:${SOURCE_REVISION}@${RUNNER_DIGEST}`;
const AGENT_IMAGE = `ghcr.io/ametel01/bruno-default:release@${AGENT_DIGEST}`;
const HERMES_IMAGE = `nousresearch/hermes-agent:release@${DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST}`;
const SNAPSHOT_OCI = `ghcr.io/ametel01/bruno-runner-snapshot-bundles@sha256:${"d".repeat(64)}`;

describe("runner boot validation", () => {
  it("defaults stock runners to a full current-machine fixture", () => {
    expect(
      resolveRunnerBootValidation({
        env: {},
        releaseEvidence: {
          release: {
            version: SOURCE_REVISION,
            imageDigest: RUNNER_DIGEST,
            bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
          },
          expectedMatch: null,
        },
      }),
    ).toEqual({ mode: "full" });
  });

  it("accepts release-attested mode only with an approved signed release over the exact snapshot and images", () => {
    const configured = releaseAttestedEnv();

    expect(
      resolveRunnerBootValidation({
        env: configured.env,
        releaseEvidence: {
          release: {
            version: SOURCE_REVISION,
            imageDigest: RUNNER_DIGEST,
            bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
          },
          expectedMatch: true,
        },
      }),
    ).toEqual({
      mode: "release_attested",
      releaseBundleDigest: configured.releaseDigest,
      snapshotBundleDigest: SNAPSHOT_DIGEST,
      snapshotImageId: "1102",
      runnerImage: RUNNER_IMAGE,
      defaultAgentImage: AGENT_IMAGE,
      hermesImage: HERMES_IMAGE,
      attestedChecks: {
        fullFixture: "verified",
        detailedHealth: "verified",
        modelCanary: "verified",
        telegramConfig: "verified",
        cleanup: "verified",
      },
    });
  });

  it.each([
    ["missing evidence", {}, "release_configuration_missing"],
    ["unverified current runner", releaseAttestedEnv().env, "release_identity_unverified"],
    [
      "wrong approved snapshot",
      {
        ...releaseAttestedEnv().env,
        [RUNNER_APPROVED_SNAPSHOT_DIGEST_ENV]: `sha256:${"e".repeat(64)}`,
      },
      "release_identity_mismatch",
    ],
  ])("fails closed for %s", (_label, env, reason) => {
    expect(() =>
      resolveRunnerBootValidation({
        env: { [RUNNER_BOOT_VALIDATION_MODE_ENV]: "release_attested", ...env },
        releaseEvidence: {
          release: {
            version: SOURCE_REVISION,
            imageDigest: RUNNER_DIGEST,
            bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
          },
          expectedMatch: reason === "release_identity_unverified" ? null : true,
        },
      }),
    ).toThrow(expect.objectContaining({ reason }));
  });
});

function releaseAttestedEnv(): { env: Record<string, string>; releaseDigest: string } {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const signed = createRunnerReleaseBundle({
    manifest: releaseManifest(),
    signingKeyId: "release-current",
    privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  });

  return {
    releaseDigest: signed.digest,
    env: {
      [RUNNER_BOOT_VALIDATION_MODE_ENV]: "release_attested",
      [RUNNER_RELEASE_BUNDLE_ENV]: signed.bundleBytes,
      [RUNNER_RELEASE_APPROVED_DIGEST_ENV]: signed.digest,
      [RUNNER_RELEASE_TRUST_SET_ENV]: JSON.stringify({ "release-current": publicKey }),
      [RUNNER_APPROVED_SNAPSHOT_OCI_ENV]: SNAPSHOT_OCI,
      [RUNNER_APPROVED_SNAPSHOT_DIGEST_ENV]: SNAPSHOT_DIGEST,
      BRUNO_RUNNER_IMAGE: RUNNER_IMAGE,
      BRUNO_DOCKER_RUNNER_IMAGE: AGENT_IMAGE,
      BRUNO_HERMES_WORKLOAD_IMAGE: HERMES_IMAGE,
    },
  };
}

function releaseManifest(): RunnerReleaseManifest {
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
      reference: HERMES_IMAGE,
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
