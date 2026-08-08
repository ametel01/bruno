import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import { OrasRunnerSnapshotRegistryAdapter } from "@/src/server/runners/oras-runner-snapshot-registry";
import {
  createRunnerSnapshotAttestation,
  type RunnerSnapshotManifest,
} from "@/src/server/runners/runner-snapshot-manifest";
import {
  publishRunnerSnapshotBundle,
  RUNNER_SNAPSHOT_OCI_ARTIFACT_TYPE,
  type RunnerSnapshotRegistryAdapter,
  type RunnerSnapshotRegistryArtifact,
  verifyRetainedRunnerSnapshotBundles,
} from "@/src/server/runners/runner-snapshot-registry";

const RUNNER_DIGEST = `sha256:${"a".repeat(64)}`;
const AGENT_DIGEST = `sha256:${"b".repeat(64)}`;
const RUNNER_IMAGE = `ghcr.io/ametel01/bruno-runner:abc123@${RUNNER_DIGEST}`;
const AGENT_IMAGE = `ghcr.io/ametel01/bruno-default:abc123@${AGENT_DIGEST}`;
const OCI_REPOSITORY = "ghcr.io/ametel01/bruno-runner-snapshot-bundles";

describe("runner snapshot registry", () => {
  it("publishes a sanitized v2 bundle and consumes it again by immutable OCI digest", async () => {
    const signing = generateKeyPairSync("ed25519");
    const attestation = attest(manifest("123456"), "snapshot-current", signing.privateKey);
    const registry = new InMemorySnapshotRegistry();

    const published = await publishRunnerSnapshotBundle({
      repository: OCI_REPOSITORY,
      bundleBytes: attestation.bundleBytes,
      expectedBundleDigest: attestation.digest,
      trustedPublicKeys: { "snapshot-current": publicKeyPem(signing.publicKey) },
      registry,
    });

    expect(published).toEqual({
      bundleDigest: attestation.digest,
      ociReference: expect.stringMatching(
        /^ghcr\.io\/ametel01\/bruno-runner-snapshot-bundles@sha256:[a-f0-9]{64}$/,
      ),
      signingKeyId: "snapshot-current",
    });
    expect(registry.published).toHaveLength(1);
    expect(registry.retrieved).toEqual([published.ociReference]);
    expect(registry.published[0]).toMatchObject({
      repository: OCI_REPOSITORY,
      tag: `bundle-${attestation.digest.replace("sha256:", "")}`,
      artifactType: RUNNER_SNAPSHOT_OCI_ARTIFACT_TYPE,
    });
    expect(registry.published[0]?.files.map((file) => file.name).sort()).toEqual([
      "runner-snapshot-bundle.json",
      "runner-snapshot-bundle.sha256",
      "runner-snapshot-signing-key.pem",
    ]);
    expect(registry.published[0]?.files.find((file) => file.name.endsWith(".pem"))?.contents).toBe(
      publicKeyPem(signing.publicKey),
    );
  });

  it("rejects retrieval when signed bytes or the expected bundle digest do not match", async () => {
    const signing = generateKeyPairSync("ed25519");
    const attestation = attest(manifest("123456"), "snapshot-current", signing.privateKey);
    const trustSet = { "snapshot-current": publicKeyPem(signing.publicKey) };
    const registry = new InMemorySnapshotRegistry();
    const published = await publishRunnerSnapshotBundle({
      repository: OCI_REPOSITORY,
      bundleBytes: attestation.bundleBytes,
      expectedBundleDigest: attestation.digest,
      trustedPublicKeys: trustSet,
      registry,
    });

    await expect(
      verifyRetainedRunnerSnapshotBundles({
        active: {
          ociReference: published.ociReference,
          bundleDigest: `sha256:${"f".repeat(64)}`,
        },
        previous: {
          ociReference: published.ociReference,
          bundleDigest: attestation.digest,
        },
        trustedPublicKeys: trustSet,
        registry,
      }),
    ).rejects.toThrow("bundle digest mismatch");

    registry.mutateFile(
      published.ociReference,
      "runner-snapshot-bundle.json",
      attestation.bundleBytes.replace("sfo3", "nyc3"),
    );
    await expect(
      verifyRetainedRunnerSnapshotBundles({
        active: {
          ociReference: published.ociReference,
          bundleDigest: attestation.digest,
        },
        previous: {
          ociReference: published.ociReference,
          bundleDigest: attestation.digest,
        },
        trustedPublicKeys: trustSet,
        registry,
      }),
    ).rejects.toThrow("bundle digest mismatch");
  });

  it("retains independently verifiable active and previous bundles with overlapping keys", async () => {
    const currentKey = generateKeyPairSync("ed25519");
    const previousKey = generateKeyPairSync("ed25519");
    const current = attest(manifest("123457"), "snapshot-current", currentKey.privateKey);
    const previous = attest(manifest("123456"), "snapshot-previous", previousKey.privateKey);
    const trustSet = {
      "snapshot-current": publicKeyPem(currentKey.publicKey),
      "snapshot-previous": publicKeyPem(previousKey.publicKey),
    };
    const registry = new InMemorySnapshotRegistry();
    const previousPublished = await publishRunnerSnapshotBundle({
      repository: OCI_REPOSITORY,
      bundleBytes: previous.bundleBytes,
      expectedBundleDigest: previous.digest,
      trustedPublicKeys: trustSet,
      registry,
    });
    const currentPublished = await publishRunnerSnapshotBundle({
      repository: OCI_REPOSITORY,
      bundleBytes: current.bundleBytes,
      expectedBundleDigest: current.digest,
      previous: previousPublished,
      trustedPublicKeys: trustSet,
      registry,
    });

    await expect(
      verifyRetainedRunnerSnapshotBundles({
        active: currentPublished,
        previous: previousPublished,
        trustedPublicKeys: trustSet,
        registry,
      }),
    ).resolves.toEqual({
      active: currentPublished,
      previous: previousPublished,
    });

    await expect(
      verifyRetainedRunnerSnapshotBundles({
        active: currentPublished,
        previous: previousPublished,
        trustedPublicKeys: { "snapshot-current": publicKeyPem(currentKey.publicKey) },
        registry,
      }),
    ).rejects.toThrow("signing key is not trusted");
  });

  it("allows bootstrap only for an empty repository and requires a distinct previous candidate later", async () => {
    const signing = generateKeyPairSync("ed25519");
    const first = attest(manifest("123456"), "snapshot-current", signing.privateKey);
    const second = attest(manifest("123457"), "snapshot-current", signing.privateKey);
    const trustSet = { "snapshot-current": publicKeyPem(signing.publicKey) };
    const registry = new InMemorySnapshotRegistry();
    const firstPublished = await publishRunnerSnapshotBundle({
      repository: OCI_REPOSITORY,
      bundleBytes: first.bundleBytes,
      expectedBundleDigest: first.digest,
      trustedPublicKeys: trustSet,
      registry,
    });

    await expect(
      publishRunnerSnapshotBundle({
        repository: OCI_REPOSITORY,
        bundleBytes: second.bundleBytes,
        expectedBundleDigest: second.digest,
        trustedPublicKeys: trustSet,
        registry,
      }),
    ).rejects.toThrow("previous snapshot candidate is required");
    await expect(
      publishRunnerSnapshotBundle({
        repository: OCI_REPOSITORY,
        bundleBytes: first.bundleBytes,
        expectedBundleDigest: first.digest,
        previous: firstPublished,
        trustedPublicKeys: trustSet,
        registry,
      }),
    ).rejects.toThrow("active and previous snapshot candidates must be distinct");
  });

  it("uses ORAS for tag discovery, publication, and digest-addressed retrieval", async () => {
    const calls: string[][] = [];
    const adapter = new OrasRunnerSnapshotRegistryAdapter(async (args, _options) => {
      calls.push(args);
      if (args[0] === "repo") {
        return { stdout: JSON.stringify({ tags: ["bundle-existing"] }) };
      }
      if (args[0] === "push") {
        return { stdout: `sha256:${"d".repeat(64)}\n` };
      }
      if (args[0] === "manifest") {
        return {
          stdout: JSON.stringify({
            artifactType: RUNNER_SNAPSHOT_OCI_ARTIFACT_TYPE,
            layers: [
              layer("runner-snapshot-bundle.json", "application/json"),
              layer("runner-snapshot-bundle.sha256", "text/plain"),
              layer("runner-snapshot-signing-key.pem", "application/x-pem-file"),
            ],
          }),
        };
      }
      if (args[0] === "pull") {
        const outputIndex = args.indexOf("--output");
        const output = args[outputIndex + 1];
        if (!output) throw new Error("missing ORAS output directory");
        await Promise.all([
          writeFile(join(output, "runner-snapshot-bundle.json"), "bundle"),
          writeFile(join(output, "runner-snapshot-bundle.sha256"), "digest"),
          writeFile(join(output, "runner-snapshot-signing-key.pem"), "public-key"),
        ]);
        return { stdout: "" };
      }
      throw new Error(`unexpected ORAS command ${args[0]}`);
    });
    const files = [
      { name: "runner-snapshot-bundle.json", mediaType: "application/json", contents: "bundle" },
      { name: "runner-snapshot-bundle.sha256", mediaType: "text/plain", contents: "digest" },
      {
        name: "runner-snapshot-signing-key.pem",
        mediaType: "application/x-pem-file",
        contents: "public-key",
      },
    ];

    await expect(adapter.listTags(OCI_REPOSITORY)).resolves.toEqual(["bundle-existing"]);
    await expect(
      adapter.publish({
        repository: OCI_REPOSITORY,
        tag: "bundle-candidate",
        artifactType: RUNNER_SNAPSHOT_OCI_ARTIFACT_TYPE,
        files,
      }),
    ).resolves.toEqual({
      ociReference: `${OCI_REPOSITORY}@sha256:${"d".repeat(64)}`,
    });
    await expect(adapter.retrieve(`${OCI_REPOSITORY}@sha256:${"d".repeat(64)}`)).resolves.toEqual({
      ociReference: `${OCI_REPOSITORY}@sha256:${"d".repeat(64)}`,
      artifactType: RUNNER_SNAPSHOT_OCI_ARTIFACT_TYPE,
      files,
    });
    expect(calls).toContainEqual(["repo", "tags", OCI_REPOSITORY, "--format", "json"]);
    expect(calls.find((args) => args[0] === "push")).toContain(
      `${OCI_REPOSITORY}:bundle-candidate`,
    );
    expect(calls).toContainEqual([
      "manifest",
      "fetch",
      `${OCI_REPOSITORY}@sha256:${"d".repeat(64)}`,
    ]);
    expect(calls).toContainEqual([
      "pull",
      `${OCI_REPOSITORY}@sha256:${"d".repeat(64)}`,
      "--output",
      expect.any(String),
    ]);
  });

  it("treats only OCI NAME_UNKNOWN as an empty repository during bootstrap", async () => {
    const missing = new OrasRunnerSnapshotRegistryAdapter(async () => {
      throw Object.assign(new Error("ORAS failed"), {
        stderr: "Error response from registry: name unknown: repository name not known to registry",
      });
    });
    const denied = new OrasRunnerSnapshotRegistryAdapter(async () => {
      throw Object.assign(new Error("ORAS failed"), {
        stderr: "Error response from registry: denied: requested access to the resource is denied",
      });
    });

    await expect(missing.listTags(OCI_REPOSITORY)).resolves.toEqual([]);
    await expect(denied.listTags(OCI_REPOSITORY)).rejects.toThrow("ORAS failed");
  });

  it("rejects non-allowlisted evidence and never publishes private signing material", async () => {
    const signing = generateKeyPairSync("ed25519");
    const attestation = attest(manifest("123456"), "snapshot-current", signing.privateKey);
    const unsafe = JSON.parse(attestation.bundleBytes) as Record<string, unknown>;
    unsafe.ownerToken = "owner-secret";
    const registry = new InMemorySnapshotRegistry();

    await expect(
      publishRunnerSnapshotBundle({
        repository: OCI_REPOSITORY,
        bundleBytes: JSON.stringify(unsafe),
        expectedBundleDigest: attestation.digest,
        trustedPublicKeys: { "snapshot-current": publicKeyPem(signing.publicKey) },
        registry,
      }),
    ).rejects.toThrow("bundle schema is invalid");
    expect(registry.published).toEqual([]);

    await expect(
      publishRunnerSnapshotBundle({
        repository: OCI_REPOSITORY,
        bundleBytes: attestation.bundleBytes,
        expectedBundleDigest: attestation.digest,
        trustedPublicKeys: {
          "snapshot-current": signing.privateKey
            .export({ format: "pem", type: "pkcs8" })
            .toString(),
        },
        registry,
      }),
    ).rejects.toThrow("trusted signing key must be an Ed25519 public key");
    expect(registry.published).toEqual([]);
  });
});

class InMemorySnapshotRegistry implements RunnerSnapshotRegistryAdapter {
  readonly artifacts = new Map<string, RunnerSnapshotRegistryArtifact>();
  readonly published: Array<Parameters<RunnerSnapshotRegistryAdapter["publish"]>[0]> = [];
  readonly retrieved: string[] = [];

  async listTags(repository: string): Promise<string[]> {
    return this.published
      .filter((publication) => publication.repository === repository)
      .map((publication) => publication.tag);
  }

  async publish(
    input: Parameters<RunnerSnapshotRegistryAdapter["publish"]>[0],
  ): Promise<{ ociReference: string }> {
    this.published.push(structuredClone(input));
    const ociReference = `${input.repository}@sha256:${this.artifacts.size
      .toString(16)
      .padStart(64, "c")}`;
    this.artifacts.set(ociReference, {
      ociReference,
      artifactType: input.artifactType,
      files: structuredClone(input.files),
    });
    return { ociReference };
  }

  async retrieve(ociReference: string): Promise<RunnerSnapshotRegistryArtifact> {
    this.retrieved.push(ociReference);
    const artifact = this.artifacts.get(ociReference);
    if (!artifact) throw new Error("OCI artifact was not found.");
    return structuredClone(artifact);
  }

  mutateFile(ociReference: string, name: string, contents: string): void {
    const artifact = this.artifacts.get(ociReference);
    const file = artifact?.files.find((candidate) => candidate.name === name);
    if (!file) throw new Error("OCI artifact file was not found.");
    file.contents = contents;
  }
}

function layer(name: string, mediaType: string) {
  return {
    mediaType,
    annotations: { "org.opencontainers.image.title": name },
  };
}

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

function manifest(runId: string): RunnerSnapshotManifest {
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
      name: `bruno-snapshot-builder-${runId}`,
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
    source: { repository: "ametel01/bruno", revision: "1".repeat(40) },
    workflow: { runId, runAttempt: "1" },
    validation: {
      fullBootFixturePassedAt: "2019-12-31T23:59:00.000Z",
      sanitationPassedAt: "2019-12-31T23:59:30.000Z",
    },
    createdAt: "2020-01-01T00:00:00.000Z",
    availableAt: "2020-01-01T00:00:01.000Z",
  };
}
