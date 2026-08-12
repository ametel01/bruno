import "server-only";

import { createPublicKey } from "node:crypto";
import {
  canonicalJson,
  parseRunnerSnapshotBundle,
  type RunnerSnapshotExpectedIdentities,
  type RunnerSnapshotManifest,
  type RunnerSnapshotTrustedPublicKeys,
  verifyRunnerSnapshotBundle,
} from "@/src/server/runners/runner-snapshot-manifest";

export const RUNNER_SNAPSHOT_OCI_ARTIFACT_TYPE = "application/vnd.bruno.runner.snapshot.bundle.v2";

const RUNNER_SNAPSHOT_BUNDLE_MEDIA_TYPE = "application/vnd.bruno.runner.snapshot.bundle.v2+json";
const RUNNER_SNAPSHOT_DIGEST_MEDIA_TYPE = "text/plain";
const RUNNER_SNAPSHOT_PUBLIC_KEY_MEDIA_TYPE = "application/x-pem-file";
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OCI_REPOSITORY_PATTERN =
  /^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;
const OCI_REFERENCE_PATTERN =
  /^(ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+)@(sha256:[a-f0-9]{64})$/;

export type RunnerSnapshotRegistryFile = {
  name: string;
  mediaType: string;
  contents: string;
};

export type RunnerSnapshotRegistryArtifact = {
  ociReference: string;
  artifactType: string;
  files: RunnerSnapshotRegistryFile[];
};

export interface RunnerSnapshotRegistryAdapter {
  listTags(repository: string): Promise<string[]>;
  publish(input: {
    repository: string;
    tag: string;
    artifactType: string;
    files: RunnerSnapshotRegistryFile[];
  }): Promise<{ ociReference: string }>;
  retrieve(ociReference: string): Promise<RunnerSnapshotRegistryArtifact>;
}

export type RunnerSnapshotBundleIdentity = {
  ociReference: string;
  bundleDigest: string;
};

export type VerifiedRunnerSnapshotBundleIdentity = RunnerSnapshotBundleIdentity & {
  signingKeyId: string;
};

export async function publishRunnerSnapshotBundle(input: {
  repository: string;
  bundleBytes: string;
  expectedBundleDigest: string;
  trustedPublicKeys: RunnerSnapshotTrustedPublicKeys;
  previous?: RunnerSnapshotBundleIdentity;
  registry: RunnerSnapshotRegistryAdapter;
}): Promise<VerifiedRunnerSnapshotBundleIdentity> {
  if (!OCI_REPOSITORY_PATTERN.test(input.repository)) {
    throw new Error("Runner snapshot OCI repository is invalid.");
  }

  const existingTags = await input.registry.listTags(input.repository);

  if (existingTags.length > 0 && !input.previous) {
    throw new Error("A previous snapshot candidate is required after bootstrap publication.");
  }
  if (input.previous?.bundleDigest === input.expectedBundleDigest) {
    throw new Error("The active and previous snapshot candidates must be distinct.");
  }
  if (input.previous) {
    await retrieveRunnerSnapshotBundle({
      ociReference: input.previous.ociReference,
      expectedBundleDigest: input.previous.bundleDigest,
      trustedPublicKeys: input.trustedPublicKeys,
      registry: input.registry,
    });
  }

  const files = validatedArtifactFiles({
    bundleBytes: input.bundleBytes,
    expectedBundleDigest: input.expectedBundleDigest,
    trustedPublicKeys: input.trustedPublicKeys,
  });
  const published = await input.registry.publish({
    repository: input.repository,
    tag: `bundle-${input.expectedBundleDigest.replace("sha256:", "")}`,
    artifactType: RUNNER_SNAPSHOT_OCI_ARTIFACT_TYPE,
    files,
  });
  const match = OCI_REFERENCE_PATTERN.exec(published.ociReference);

  if (!match || match[1] !== input.repository) {
    throw new Error("Runner snapshot publication did not return an immutable OCI reference.");
  }

  return retrieveRunnerSnapshotBundle({
    ociReference: published.ociReference,
    expectedBundleDigest: input.expectedBundleDigest,
    trustedPublicKeys: input.trustedPublicKeys,
    registry: input.registry,
  });
}

export async function verifyRetainedRunnerSnapshotBundles(input: {
  active: RunnerSnapshotBundleIdentity;
  previous: RunnerSnapshotBundleIdentity;
  trustedPublicKeys: RunnerSnapshotTrustedPublicKeys;
  registry: RunnerSnapshotRegistryAdapter;
}): Promise<{
  active: VerifiedRunnerSnapshotBundleIdentity;
  previous: VerifiedRunnerSnapshotBundleIdentity;
}> {
  const [active, previous] = await Promise.all([
    retrieveRunnerSnapshotBundle({
      ociReference: input.active.ociReference,
      expectedBundleDigest: input.active.bundleDigest,
      trustedPublicKeys: input.trustedPublicKeys,
      registry: input.registry,
    }),
    retrieveRunnerSnapshotBundle({
      ociReference: input.previous.ociReference,
      expectedBundleDigest: input.previous.bundleDigest,
      trustedPublicKeys: input.trustedPublicKeys,
      registry: input.registry,
    }),
  ]);

  return { active, previous };
}

export async function retrieveRunnerSnapshotBundle(input: {
  ociReference: string;
  expectedBundleDigest: string;
  trustedPublicKeys: RunnerSnapshotTrustedPublicKeys;
  registry: RunnerSnapshotRegistryAdapter;
}): Promise<VerifiedRunnerSnapshotBundleIdentity> {
  if (!OCI_REFERENCE_PATTERN.test(input.ociReference)) {
    throw new Error("Runner snapshot OCI reference is not digest-addressed.");
  }
  if (!SHA256_DIGEST_PATTERN.test(input.expectedBundleDigest)) {
    throw new Error("Runner snapshot bundle digest is invalid.");
  }

  const artifact = await input.registry.retrieve(input.ociReference);

  if (artifact.ociReference !== input.ociReference) {
    throw new Error("Runner snapshot OCI retrieval changed the immutable reference.");
  }
  if (artifact.artifactType !== RUNNER_SNAPSHOT_OCI_ARTIFACT_TYPE) {
    throw new Error("Runner snapshot OCI artifact type is invalid.");
  }

  const files = exactArtifactFiles(artifact.files);
  const verified = validateBundle({
    bundleBytes: files.bundle.contents,
    expectedBundleDigest: input.expectedBundleDigest,
    trustedPublicKeys: input.trustedPublicKeys,
    retainedPublicKeyPem: files.publicKey.contents,
  });

  if (files.digest.contents !== `${input.expectedBundleDigest}\n`) {
    throw new Error("Runner snapshot OCI bundle digest mismatch.");
  }

  return {
    ociReference: input.ociReference,
    bundleDigest: input.expectedBundleDigest,
    signingKeyId: verified.signingKeyId,
  };
}

function validatedArtifactFiles(input: {
  bundleBytes: string;
  expectedBundleDigest: string;
  trustedPublicKeys: RunnerSnapshotTrustedPublicKeys;
}): RunnerSnapshotRegistryFile[] {
  const verified = validateBundle(input);

  return [
    {
      name: "runner-snapshot-bundle.json",
      mediaType: RUNNER_SNAPSHOT_BUNDLE_MEDIA_TYPE,
      contents: input.bundleBytes,
    },
    {
      name: "runner-snapshot-bundle.sha256",
      mediaType: RUNNER_SNAPSHOT_DIGEST_MEDIA_TYPE,
      contents: `${input.expectedBundleDigest}\n`,
    },
    {
      name: "runner-snapshot-signing-key.pem",
      mediaType: RUNNER_SNAPSHOT_PUBLIC_KEY_MEDIA_TYPE,
      contents: verified.publicKeyPem,
    },
  ];
}

function validateBundle(input: {
  bundleBytes: string;
  expectedBundleDigest: string;
  trustedPublicKeys: RunnerSnapshotTrustedPublicKeys;
  retainedPublicKeyPem?: string;
}): { signingKeyId: string; publicKeyPem: string } {
  if (!SHA256_DIGEST_PATTERN.test(input.expectedBundleDigest)) {
    throw new Error("Runner snapshot bundle digest is invalid.");
  }

  const parsed = parseRunnerSnapshotBundle(input.bundleBytes);

  if (!parsed.ok) {
    throw new Error(`Runner snapshot bundle schema is invalid: ${parsed.reason}.`);
  }
  if (input.bundleBytes !== canonicalJson(parsed.bundle)) {
    throw new Error("Runner snapshot bundle bytes are not canonical.");
  }
  if (parsed.digest !== input.expectedBundleDigest) {
    throw new Error("Runner snapshot OCI bundle digest mismatch.");
  }

  const signingKeyId = parsed.bundle.signature.keyId;
  const trustedKey = Object.hasOwn(input.trustedPublicKeys, signingKeyId)
    ? input.trustedPublicKeys[signingKeyId]
    : undefined;

  if (!trustedKey) {
    throw new Error("Runner snapshot signing key is not trusted.");
  }

  const publicKeyPem = canonicalEd25519PublicKey(trustedKey);

  if (
    input.retainedPublicKeyPem !== undefined &&
    canonicalEd25519PublicKey(input.retainedPublicKeyPem) !== publicKeyPem
  ) {
    throw new Error("Runner snapshot retained signing key does not match the trust set.");
  }

  const verified = verifyRunnerSnapshotBundle({
    bundleBytes: input.bundleBytes,
    approvedDigest: input.expectedBundleDigest,
    trustedPublicKeys: { [signingKeyId]: publicKeyPem },
    expected: expectedIdentities(parsed.bundle.manifest),
  });

  if (!verified.ok) {
    throw new Error(`Runner snapshot bundle signature verification failed: ${verified.reason}.`);
  }

  return { signingKeyId, publicKeyPem };
}

function exactArtifactFiles(files: RunnerSnapshotRegistryFile[]): {
  bundle: RunnerSnapshotRegistryFile;
  digest: RunnerSnapshotRegistryFile;
  publicKey: RunnerSnapshotRegistryFile;
} {
  const expected = new Map([
    ["runner-snapshot-bundle.json", RUNNER_SNAPSHOT_BUNDLE_MEDIA_TYPE],
    ["runner-snapshot-bundle.sha256", RUNNER_SNAPSHOT_DIGEST_MEDIA_TYPE],
    ["runner-snapshot-signing-key.pem", RUNNER_SNAPSHOT_PUBLIC_KEY_MEDIA_TYPE],
  ]);

  if (
    files.length !== expected.size ||
    files.some((file) => expected.get(file.name) !== file.mediaType) ||
    new Set(files.map((file) => file.name)).size !== expected.size
  ) {
    throw new Error("Runner snapshot OCI artifact contains non-allowlisted files.");
  }

  const byName = new Map(files.map((file) => [file.name, file]));
  const bundle = byName.get("runner-snapshot-bundle.json");
  const digest = byName.get("runner-snapshot-bundle.sha256");
  const publicKey = byName.get("runner-snapshot-signing-key.pem");

  if (!bundle || !digest || !publicKey) {
    throw new Error("Runner snapshot OCI artifact is incomplete.");
  }

  return { bundle, digest, publicKey };
}

function canonicalEd25519PublicKey(value: string): string {
  if (value.includes("PRIVATE KEY")) {
    throw new Error("Runner snapshot trusted signing key must be an Ed25519 public key.");
  }

  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("wrong key type");
    }
    return key.export({ format: "pem", type: "spki" }).toString();
  } catch {
    throw new Error("Runner snapshot trusted signing key must be an Ed25519 public key.");
  }
}

function expectedIdentities(manifest: RunnerSnapshotManifest): RunnerSnapshotExpectedIdentities {
  return {
    region: manifest.runner.region,
    sizeSlug: manifest.runner.sizeSlug,
    sizeDiskGb: manifest.runner.diskSizeGb,
    baseImageId: manifest.baseImage.id,
    baseImageSlug: manifest.baseImage.slug,
    architecture: manifest.runner.architecture,
    runnerImage: manifest.runnerImage.reference,
    defaultAgentImage: manifest.defaultAgentImage.reference,
    hermesImage: manifest.hermesImage.reference,
    hermesAmd64ManifestDigest: manifest.hermesImage.amd64ManifestDigest,
    bootContractVersion: manifest.bootContractVersion,
  };
}
