import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import {
  RUNNER_BOOT_COMPONENTS,
  RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
  RUNNER_CANARY_CONTRACT_VERSION,
  RUNNER_LAUNCH_CONTRACT_VERSION,
  RUNNER_STATUS_CONTRACT_VERSION,
} from "@/src/runner-service/runner-contracts";
import {
  createRunnerReleaseBundle,
  RUNNER_RELEASE_MANIFEST_SCHEMA_VERSION,
  type RunnerReleaseManifest,
} from "@/src/runner-service/release-attestation";
import type {
  RunnerSnapshotRegistryAdapter,
  RunnerSnapshotRegistryArtifact,
} from "@/src/server/runners/runner-snapshot-registry";
import {
  publishRunnerReleaseBundle,
  RUNNER_RELEASE_OCI_ARTIFACT_TYPE,
  retrieveRunnerReleaseBundle,
  verifyRetainedRunnerReleaseBundles,
} from "@/src/server/runners/runner-release-registry";

const SOURCE_REVISION = "1".repeat(40);
const RUNNER_DIGEST = `sha256:${"a".repeat(64)}`;
const AGENT_DIGEST = `sha256:${"b".repeat(64)}`;
const SNAPSHOT_DIGEST = `sha256:${"c".repeat(64)}`;
const RUNNER_IMAGE = `ghcr.io/ametel01/bruno-runner:${SOURCE_REVISION}@${RUNNER_DIGEST}`;
const AGENT_IMAGE = `ghcr.io/ametel01/bruno-default:release@${AGENT_DIGEST}`;
const SNAPSHOT_OCI = `ghcr.io/ametel01/bruno-runner-snapshot-bundles@sha256:${"d".repeat(64)}`;
const REPOSITORY = "ghcr.io/ametel01/bruno-runner-release-bundles";

describe("Verified Release OCI registry", () => {
  it("publishes and re-verifies only the signed allowlisted bundle by immutable OCI digest", async () => {
    const keys = generateKeyPairSync("ed25519");
    const trust = {
      "release-current": keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    };
    const release = signedRelease(
      keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    );
    const registry = new InMemoryRegistry();

    const published = await publishRunnerReleaseBundle({
      repository: REPOSITORY,
      bundleBytes: release.bundleBytes,
      expectedBundleDigest: release.digest,
      trustedPublicKeys: trust,
      registry,
    });

    expect(published).toEqual({
      ociReference: expect.stringMatching(
        /^ghcr\.io\/ametel01\/bruno-runner-release-bundles@sha256:[a-f0-9]{64}$/,
      ),
      bundleDigest: release.digest,
      signingKeyId: "release-current",
    });
    expect(registry.published[0]).toMatchObject({
      repository: REPOSITORY,
      artifactType: RUNNER_RELEASE_OCI_ARTIFACT_TYPE,
    });
    expect(registry.published[0]?.files.map((file) => file.name).sort()).toEqual([
      "runner-release-bundle.json",
      "runner-release-bundle.sha256",
      "runner-release-signing-key.pem",
    ]);
    await expect(
      retrieveRunnerReleaseBundle({
        ociReference: published.ociReference,
        expectedBundleDigest: release.digest,
        trustedPublicKeys: trust,
        registry,
      }),
    ).resolves.toEqual(published);
  });

  it("retains independently verifiable active and previous releases and rejects tampering", async () => {
    const keys = generateKeyPairSync("ed25519");
    const trust = {
      "release-current": keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    };
    const registry = new InMemoryRegistry();
    const previousRelease = signedRelease(
      keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    );
    const previous = await publishRunnerReleaseBundle({
      repository: REPOSITORY,
      bundleBytes: previousRelease.bundleBytes,
      expectedBundleDigest: previousRelease.digest,
      trustedPublicKeys: trust,
      registry,
    });
    const activeRelease = signedRelease(
      keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      "123457",
    );
    const active = await publishRunnerReleaseBundle({
      repository: REPOSITORY,
      bundleBytes: activeRelease.bundleBytes,
      expectedBundleDigest: activeRelease.digest,
      previous,
      trustedPublicKeys: trust,
      registry,
    });

    await expect(
      verifyRetainedRunnerReleaseBundles({ active, previous, trustedPublicKeys: trust, registry }),
    ).resolves.toEqual({ active, previous });
    registry.mutate(active.ociReference, "runner-release-bundle.json", (contents) =>
      contents.replace(SOURCE_REVISION, "2".repeat(40)),
    );
    await expect(
      retrieveRunnerReleaseBundle({
        ociReference: active.ociReference,
        expectedBundleDigest: active.bundleDigest,
        trustedPublicKeys: trust,
        registry,
      }),
    ).rejects.toThrow("bundle digest mismatch");
  });
});

class InMemoryRegistry implements RunnerSnapshotRegistryAdapter {
  readonly artifacts = new Map<string, RunnerSnapshotRegistryArtifact>();
  readonly published: Array<Parameters<RunnerSnapshotRegistryAdapter["publish"]>[0]> = [];

  async listTags(repository: string): Promise<string[]> {
    return this.published
      .filter((publication) => publication.repository === repository)
      .map((publication) => publication.tag);
  }

  async publish(input: Parameters<RunnerSnapshotRegistryAdapter["publish"]>[0]) {
    this.published.push(structuredClone(input));
    const ociReference = `${input.repository}@sha256:${this.artifacts.size
      .toString(16)
      .padStart(64, "e")}`;
    this.artifacts.set(ociReference, {
      ociReference,
      artifactType: input.artifactType,
      files: structuredClone(input.files),
    });
    return { ociReference };
  }

  async retrieve(ociReference: string): Promise<RunnerSnapshotRegistryArtifact> {
    const artifact = this.artifacts.get(ociReference);
    if (!artifact) throw new Error("missing artifact");
    return structuredClone(artifact);
  }

  mutate(ociReference: string, name: string, transform: (contents: string) => string) {
    const file = this.artifacts
      .get(ociReference)
      ?.files.find((candidate) => candidate.name === name);
    if (!file) throw new Error("missing file");
    file.contents = transform(file.contents);
  }
}

function signedRelease(privateKeyPem: string, runId = "123456") {
  return createRunnerReleaseBundle({
    manifest: manifest(runId),
    signingKeyId: "release-current",
    privateKeyPem,
  });
}

function manifest(runId: string): RunnerReleaseManifest {
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
      reference: DEFAULT_HERMES_WORKLOAD_IMAGE,
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
    workflow: { runId, runAttempt: "1" },
    validation: {
      mode: "full",
      providerMode: "local_docker",
      observedChecks: [...RUNNER_BOOT_COMPONENTS],
      syntheticActions: ["start", "status", "canary", "stop"],
      fullFixturePassedAt: "2026-08-11T00:00:00.000Z",
      cleanupVerifiedAt: "2026-08-11T00:01:00.000Z",
    },
    createdAt: "2026-08-11T00:02:00.000Z",
  };
}
