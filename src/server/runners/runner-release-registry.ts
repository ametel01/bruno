import "server-only";

import { createPublicKey } from "node:crypto";
import {
  canonicalReleaseJson,
  parseRunnerReleaseBundle,
  type RunnerReleaseManifest,
  type RunnerReleaseTrustedPublicKeys,
  verifyRunnerReleaseBundle,
} from "@/src/runner-service/release-attestation";
import type {
  RunnerSnapshotRegistryAdapter,
  RunnerSnapshotRegistryFile,
} from "@/src/server/runners/runner-snapshot-registry";

export const RUNNER_RELEASE_OCI_ARTIFACT_TYPE = "application/vnd.bruno.runner.release.bundle.v2";

const BUNDLE_MEDIA_TYPE = "application/vnd.bruno.runner.release.bundle.v2+json";
const DIGEST_MEDIA_TYPE = "text/plain";
const PUBLIC_KEY_MEDIA_TYPE = "application/x-pem-file";
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const OCI_REPOSITORY =
  /^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;
const OCI_REFERENCE =
  /^(ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+)@(sha256:[a-f0-9]{64})$/;

export type RunnerReleaseBundleIdentity = { ociReference: string; bundleDigest: string };
export type VerifiedRunnerReleaseBundleIdentity = RunnerReleaseBundleIdentity & {
  signingKeyId: string;
};

export async function publishRunnerReleaseBundle(input: {
  repository: string;
  bundleBytes: string;
  expectedBundleDigest: string;
  trustedPublicKeys: RunnerReleaseTrustedPublicKeys;
  previous?: RunnerReleaseBundleIdentity;
  registry: RunnerSnapshotRegistryAdapter;
}): Promise<VerifiedRunnerReleaseBundleIdentity> {
  if (!OCI_REPOSITORY.test(input.repository)) {
    throw new Error("Runner release OCI repository is invalid.");
  }
  const tags = await input.registry.listTags(input.repository);
  if (tags.length > 0 && !input.previous) {
    throw new Error("A previous Verified Release is required after bootstrap publication.");
  }
  if (input.previous?.bundleDigest === input.expectedBundleDigest) {
    throw new Error("Active and previous Verified Releases must be distinct.");
  }
  if (input.previous) {
    await retrieveRunnerReleaseBundle({
      ...input.previous,
      expectedBundleDigest: input.previous.bundleDigest,
      trustedPublicKeys: input.trustedPublicKeys,
      registry: input.registry,
    });
  }

  const files = validatedFiles({
    bundleBytes: input.bundleBytes,
    expectedBundleDigest: input.expectedBundleDigest,
    trustedPublicKeys: input.trustedPublicKeys,
  });
  const published = await input.registry.publish({
    repository: input.repository,
    tag: `bundle-${input.expectedBundleDigest.replace("sha256:", "")}`,
    artifactType: RUNNER_RELEASE_OCI_ARTIFACT_TYPE,
    files,
  });
  const match = OCI_REFERENCE.exec(published.ociReference);
  if (!match || match[1] !== input.repository) {
    throw new Error("Runner release publication did not return an immutable OCI reference.");
  }

  return retrieveRunnerReleaseBundle({
    ociReference: published.ociReference,
    expectedBundleDigest: input.expectedBundleDigest,
    trustedPublicKeys: input.trustedPublicKeys,
    registry: input.registry,
  });
}

export async function retrieveRunnerReleaseBundle(input: {
  ociReference: string;
  expectedBundleDigest: string;
  trustedPublicKeys: RunnerReleaseTrustedPublicKeys;
  registry: RunnerSnapshotRegistryAdapter;
}): Promise<VerifiedRunnerReleaseBundleIdentity> {
  if (!OCI_REFERENCE.test(input.ociReference)) {
    throw new Error("Runner release OCI reference is not digest-addressed.");
  }
  if (!SHA256_DIGEST.test(input.expectedBundleDigest)) {
    throw new Error("Runner release bundle digest is invalid.");
  }
  const artifact = await input.registry.retrieve(input.ociReference);
  if (artifact.ociReference !== input.ociReference) {
    throw new Error("Runner release OCI retrieval changed the immutable reference.");
  }
  if (artifact.artifactType !== RUNNER_RELEASE_OCI_ARTIFACT_TYPE) {
    throw new Error("Runner release OCI artifact type is invalid.");
  }

  const files = exactFiles(artifact.files);
  const verified = validateBundle({
    bundleBytes: files.bundle.contents,
    expectedBundleDigest: input.expectedBundleDigest,
    trustedPublicKeys: input.trustedPublicKeys,
    retainedPublicKeyPem: files.publicKey.contents,
  });
  if (files.digest.contents !== `${input.expectedBundleDigest}\n`) {
    throw new Error("Runner release OCI bundle digest mismatch.");
  }
  return {
    ociReference: input.ociReference,
    bundleDigest: input.expectedBundleDigest,
    signingKeyId: verified.signingKeyId,
  };
}

export async function verifyRetainedRunnerReleaseBundles(input: {
  active: RunnerReleaseBundleIdentity;
  previous: RunnerReleaseBundleIdentity;
  trustedPublicKeys: RunnerReleaseTrustedPublicKeys;
  registry: RunnerSnapshotRegistryAdapter;
}): Promise<{
  active: VerifiedRunnerReleaseBundleIdentity;
  previous: VerifiedRunnerReleaseBundleIdentity;
}> {
  const [active, previous] = await Promise.all([
    retrieveRunnerReleaseBundle({
      ...input.active,
      expectedBundleDigest: input.active.bundleDigest,
      trustedPublicKeys: input.trustedPublicKeys,
      registry: input.registry,
    }),
    retrieveRunnerReleaseBundle({
      ...input.previous,
      expectedBundleDigest: input.previous.bundleDigest,
      trustedPublicKeys: input.trustedPublicKeys,
      registry: input.registry,
    }),
  ]);
  return { active, previous };
}

function validatedFiles(input: {
  bundleBytes: string;
  expectedBundleDigest: string;
  trustedPublicKeys: RunnerReleaseTrustedPublicKeys;
}): RunnerSnapshotRegistryFile[] {
  const verified = validateBundle(input);
  return [
    {
      name: "runner-release-bundle.json",
      mediaType: BUNDLE_MEDIA_TYPE,
      contents: input.bundleBytes,
    },
    {
      name: "runner-release-bundle.sha256",
      mediaType: DIGEST_MEDIA_TYPE,
      contents: `${input.expectedBundleDigest}\n`,
    },
    {
      name: "runner-release-signing-key.pem",
      mediaType: PUBLIC_KEY_MEDIA_TYPE,
      contents: verified.publicKeyPem,
    },
  ];
}

function validateBundle(input: {
  bundleBytes: string;
  expectedBundleDigest: string;
  trustedPublicKeys: RunnerReleaseTrustedPublicKeys;
  retainedPublicKeyPem?: string;
}): { signingKeyId: string; publicKeyPem: string } {
  if (!SHA256_DIGEST.test(input.expectedBundleDigest)) {
    throw new Error("Runner release bundle digest is invalid.");
  }
  const parsed = parseRunnerReleaseBundle(input.bundleBytes);
  if (!parsed.ok) throw new Error(`Runner release bundle schema is invalid: ${parsed.reason}.`);
  if (input.bundleBytes !== canonicalReleaseJson(parsed.bundle)) {
    throw new Error("Runner release bundle bytes are not canonical.");
  }
  if (parsed.digest !== input.expectedBundleDigest) {
    throw new Error("Runner release OCI bundle digest mismatch.");
  }
  const signingKeyId = parsed.bundle.signature.keyId;
  const trustedKey = Object.hasOwn(input.trustedPublicKeys, signingKeyId)
    ? input.trustedPublicKeys[signingKeyId]
    : undefined;
  if (!trustedKey) throw new Error("Runner release signing key is not trusted.");
  const publicKeyPem = canonicalEd25519PublicKey(trustedKey);
  if (
    input.retainedPublicKeyPem !== undefined &&
    canonicalEd25519PublicKey(input.retainedPublicKeyPem) !== publicKeyPem
  ) {
    throw new Error("Runner release retained signing key does not match the trust set.");
  }

  const verified = verifyRunnerReleaseBundle({
    bundleBytes: input.bundleBytes,
    approvedDigest: input.expectedBundleDigest,
    trustedPublicKeys: { [signingKeyId]: publicKeyPem },
    expected: expectedIdentities(parsed.bundle.manifest),
  });
  if (!verified.ok) {
    throw new Error(`Runner release bundle signature verification failed: ${verified.reason}.`);
  }
  return { signingKeyId, publicKeyPem };
}

function exactFiles(files: RunnerSnapshotRegistryFile[]): {
  bundle: RunnerSnapshotRegistryFile;
  digest: RunnerSnapshotRegistryFile;
  publicKey: RunnerSnapshotRegistryFile;
} {
  const expected = new Map([
    ["runner-release-bundle.json", BUNDLE_MEDIA_TYPE],
    ["runner-release-bundle.sha256", DIGEST_MEDIA_TYPE],
    ["runner-release-signing-key.pem", PUBLIC_KEY_MEDIA_TYPE],
  ]);
  if (
    files.length !== expected.size ||
    files.some((file) => expected.get(file.name) !== file.mediaType) ||
    new Set(files.map((file) => file.name)).size !== expected.size
  ) {
    throw new Error("Runner release OCI artifact contains non-allowlisted files.");
  }
  const byName = new Map(files.map((file) => [file.name, file]));
  const bundle = byName.get("runner-release-bundle.json");
  const digest = byName.get("runner-release-bundle.sha256");
  const publicKey = byName.get("runner-release-signing-key.pem");
  if (!bundle || !digest || !publicKey)
    throw new Error("Runner release OCI artifact is incomplete.");
  return { bundle, digest, publicKey };
}

function canonicalEd25519PublicKey(value: string): string {
  if (value.includes("PRIVATE KEY")) {
    throw new Error("Runner release trusted signing key must be an Ed25519 public key.");
  }
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key.export({ format: "pem", type: "spki" }).toString();
  } catch {
    throw new Error("Runner release trusted signing key must be an Ed25519 public key.");
  }
}

function expectedIdentities(manifest: RunnerReleaseManifest) {
  return {
    sourceRevision: manifest.controlPlane.source.revision,
    runnerImage: manifest.runnerImage.reference,
    defaultAgentImage: manifest.defaultAgentImage.reference,
    hermesImage: manifest.hermesImage.reference,
    snapshotOciReference: manifest.snapshot.ociReference,
    snapshotBundleDigest: manifest.snapshot.bundleDigest,
    bootContractVersion: manifest.controlPlane.contracts.boot,
  };
}
