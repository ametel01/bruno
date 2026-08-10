import { createHash, sign, verify } from "node:crypto";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import { parseImmutableRunnerImageReference } from "@/src/runner-service/release-identity";
import {
  RUNNER_BOOT_COMPONENTS,
  RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
  RUNNER_CANARY_CONTRACT_VERSION,
  RUNNER_LAUNCH_CONTRACT_VERSION,
  RUNNER_STATUS_CONTRACT_VERSION,
} from "@/src/runner-service/runner-contracts";

export const RUNNER_RELEASE_MANIFEST_SCHEMA_VERSION = "bruno.runner.release.v2" as const;
export const RUNNER_RELEASE_BUNDLE_SCHEMA_VERSION = "bruno.runner.release.bundle.v1" as const;

const SIGNATURE_ALGORITHM = "Ed25519" as const;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const WORKFLOW_NUMBER = /^[1-9][0-9]{0,19}$/;
const PROVIDER_IMAGE_ID = /^[1-9][0-9]{0,18}$/;
const SIGNING_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OCI_REFERENCE =
  /^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export type RunnerReleaseManifest = {
  schemaVersion: typeof RUNNER_RELEASE_MANIFEST_SCHEMA_VERSION;
  controlPlane: {
    source: { repository: "ametel01/bruno"; revision: string };
    contracts: {
      launch: typeof RUNNER_LAUNCH_CONTRACT_VERSION;
      status: typeof RUNNER_STATUS_CONTRACT_VERSION;
      canary: typeof RUNNER_CANARY_CONTRACT_VERSION;
      bootSnapshot: typeof RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION;
      boot: typeof RUNNER_BOOT_CONTRACT_VERSION;
    };
  };
  runnerImage: { reference: string; digest: string; version: string };
  defaultAgentImage: { reference: string; digest: string };
  hermesImage: { reference: string; indexDigest: string; amd64ManifestDigest: string };
  snapshot: {
    ociReference: string;
    bundleDigest: string;
    signingKeyId: string;
    manifestSchemaVersion: "bruno.runner.snapshot.v2";
    provider: "digitalocean";
    imageId: string;
  };
  workflow: { runId: string; runAttempt: string };
  validation: {
    mode: "full";
    providerMode: "local_docker";
    observedChecks: [...typeof RUNNER_BOOT_COMPONENTS];
    syntheticActions: ["start", "status", "canary", "stop"];
    fullFixturePassedAt: string;
    cleanupVerifiedAt: string;
  };
  createdAt: string;
};

export type RunnerReleaseBundle = {
  schemaVersion: typeof RUNNER_RELEASE_BUNDLE_SCHEMA_VERSION;
  manifest: RunnerReleaseManifest;
  signature: { algorithm: typeof SIGNATURE_ALGORITHM; keyId: string; value: string };
};

export type RunnerReleaseExpectedIdentities = {
  sourceRevision: string;
  runnerImage: string;
  defaultAgentImage: string;
  hermesImage: string;
  snapshotOciReference: string;
  snapshotBundleDigest: string;
  bootContractVersion?: string;
};

export type RunnerReleaseTrustedPublicKeys = Readonly<Record<string, string>>;

export type RunnerReleaseBundleFailureReason =
  | "release_bundle_json_invalid"
  | "release_bundle_schema_invalid"
  | "release_manifest_schema_invalid"
  | "release_not_approved"
  | "release_signing_key_untrusted"
  | "release_signature_invalid"
  | "release_identity_mismatch";

export type RunnerReleaseBundleCheck =
  | {
      ok: true;
      bundle: RunnerReleaseBundle;
      manifest: RunnerReleaseManifest;
      digest: string;
      signingKeyId: string;
    }
  | { ok: false; reason: RunnerReleaseBundleFailureReason };

type ParsedRunnerReleaseBundle =
  | { ok: true; bundle: RunnerReleaseBundle; digest: string }
  | {
      ok: false;
      reason:
        | "release_bundle_json_invalid"
        | "release_bundle_schema_invalid"
        | "release_manifest_schema_invalid";
    };

export function createRunnerReleaseBundle(input: {
  manifest: RunnerReleaseManifest;
  signingKeyId: string;
  privateKeyPem: string;
}): { bundle: RunnerReleaseBundle; bundleBytes: string; digest: string } {
  const manifest = parseRunnerReleaseManifest(input.manifest);
  if (!manifest) throw new Error("Runner release manifest is invalid.");
  if (!SIGNING_KEY_ID.test(input.signingKeyId)) {
    throw new Error("Runner release signing key ID is invalid.");
  }

  const signature = sign(null, Buffer.from(canonicalJson(manifest)), input.privateKeyPem).toString(
    "base64url",
  );
  const bundle: RunnerReleaseBundle = {
    schemaVersion: RUNNER_RELEASE_BUNDLE_SCHEMA_VERSION,
    manifest,
    signature: { algorithm: SIGNATURE_ALGORITHM, keyId: input.signingKeyId, value: signature },
  };
  const bundleBytes = canonicalJson(bundle);
  return { bundle, bundleBytes, digest: digestBytes(bundleBytes) };
}

export function verifyRunnerReleaseBundle(input: {
  bundleBytes: string;
  approvedDigest?: string;
  trustedPublicKeys: RunnerReleaseTrustedPublicKeys;
  expected: RunnerReleaseExpectedIdentities;
}): RunnerReleaseBundleCheck {
  const parsed = parseRunnerReleaseBundle(input.bundleBytes);
  if (!parsed.ok) return parsed;
  if (parsed.digest !== input.approvedDigest) return { ok: false, reason: "release_not_approved" };

  const keyId = parsed.bundle.signature.keyId;
  const publicKey = Object.hasOwn(input.trustedPublicKeys, keyId)
    ? input.trustedPublicKeys[keyId]
    : undefined;
  if (!publicKey) return { ok: false, reason: "release_signing_key_untrusted" };

  try {
    if (
      !verify(
        null,
        Buffer.from(canonicalJson(parsed.bundle.manifest)),
        publicKey,
        Buffer.from(parsed.bundle.signature.value, "base64url"),
      )
    ) {
      return { ok: false, reason: "release_signature_invalid" };
    }
  } catch {
    return { ok: false, reason: "release_signature_invalid" };
  }

  if (!releaseIdentitiesMatch(parsed.bundle.manifest, input.expected)) {
    return { ok: false, reason: "release_identity_mismatch" };
  }

  return {
    ok: true,
    bundle: parsed.bundle,
    manifest: parsed.bundle.manifest,
    digest: parsed.digest,
    signingKeyId: keyId,
  };
}

export function parseRunnerReleaseBundle(bundleBytes: string): ParsedRunnerReleaseBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(bundleBytes);
  } catch {
    return { ok: false, reason: "release_bundle_json_invalid" };
  }

  if (
    !isExactRecord(raw, ["manifest", "schemaVersion", "signature"]) ||
    raw.schemaVersion !== RUNNER_RELEASE_BUNDLE_SCHEMA_VERSION ||
    !isBundleSignature(raw.signature)
  ) {
    return { ok: false, reason: "release_bundle_schema_invalid" };
  }

  const manifest = parseRunnerReleaseManifest(raw.manifest);
  if (!manifest) return { ok: false, reason: "release_manifest_schema_invalid" };

  const bundle: RunnerReleaseBundle = {
    schemaVersion: RUNNER_RELEASE_BUNDLE_SCHEMA_VERSION,
    manifest,
    signature: raw.signature,
  };
  const canonicalBytes = canonicalJson(bundle);
  if (canonicalBytes !== bundleBytes) {
    return { ok: false, reason: "release_bundle_schema_invalid" };
  }
  return { ok: true, bundle, digest: digestBytes(canonicalBytes) };
}

export function canonicalReleaseJson(value: unknown): string {
  return canonicalJson(value);
}

function parseRunnerReleaseManifest(raw: unknown): RunnerReleaseManifest | null {
  if (!isExactRecord(raw, RELEASE_MANIFEST_KEYS)) return null;
  const controlPlane = raw.controlPlane;
  const runnerImage = raw.runnerImage;
  const defaultAgentImage = raw.defaultAgentImage;
  const hermesImage = raw.hermesImage;
  const snapshot = raw.snapshot;
  const workflow = raw.workflow;
  const validation = raw.validation;

  if (
    raw.schemaVersion !== RUNNER_RELEASE_MANIFEST_SCHEMA_VERSION ||
    !isExactRecord(controlPlane, ["contracts", "source"]) ||
    !isExactRecord(controlPlane.source, ["repository", "revision"]) ||
    controlPlane.source.repository !== "ametel01/bruno" ||
    typeof controlPlane.source.revision !== "string" ||
    !SOURCE_REVISION.test(controlPlane.source.revision) ||
    !isExactRecord(controlPlane.contracts, [
      "boot",
      "bootSnapshot",
      "canary",
      "launch",
      "status",
    ]) ||
    controlPlane.contracts.launch !== RUNNER_LAUNCH_CONTRACT_VERSION ||
    controlPlane.contracts.status !== RUNNER_STATUS_CONTRACT_VERSION ||
    controlPlane.contracts.canary !== RUNNER_CANARY_CONTRACT_VERSION ||
    controlPlane.contracts.bootSnapshot !== RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION ||
    controlPlane.contracts.boot !== RUNNER_BOOT_CONTRACT_VERSION ||
    !isExactRecord(runnerImage, ["digest", "reference", "version"]) ||
    typeof runnerImage.reference !== "string" ||
    typeof runnerImage.digest !== "string" ||
    typeof runnerImage.version !== "string" ||
    !runnerImageMatches(runnerImage.reference, runnerImage.digest, runnerImage.version) ||
    !isExactRecord(defaultAgentImage, ["digest", "reference"]) ||
    typeof defaultAgentImage.reference !== "string" ||
    typeof defaultAgentImage.digest !== "string" ||
    parseImmutableRunnerImageReference(defaultAgentImage.reference)?.imageDigest !==
      defaultAgentImage.digest ||
    !isExactRecord(hermesImage, ["amd64ManifestDigest", "indexDigest", "reference"]) ||
    typeof hermesImage.reference !== "string" ||
    hermesImage.indexDigest !== DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST ||
    hermesImage.amd64ManifestDigest !== DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST ||
    !hermesImage.reference.endsWith(`@${hermesImage.indexDigest}`) ||
    !isExactRecord(snapshot, [
      "bundleDigest",
      "imageId",
      "manifestSchemaVersion",
      "ociReference",
      "provider",
      "signingKeyId",
    ]) ||
    typeof snapshot.ociReference !== "string" ||
    !OCI_REFERENCE.test(snapshot.ociReference) ||
    typeof snapshot.bundleDigest !== "string" ||
    !SHA256_DIGEST.test(snapshot.bundleDigest) ||
    typeof snapshot.signingKeyId !== "string" ||
    !SIGNING_KEY_ID.test(snapshot.signingKeyId) ||
    snapshot.manifestSchemaVersion !== "bruno.runner.snapshot.v2" ||
    snapshot.provider !== "digitalocean" ||
    typeof snapshot.imageId !== "string" ||
    !PROVIDER_IMAGE_ID.test(snapshot.imageId) ||
    !isExactRecord(workflow, ["runAttempt", "runId"]) ||
    typeof workflow.runId !== "string" ||
    !WORKFLOW_NUMBER.test(workflow.runId) ||
    typeof workflow.runAttempt !== "string" ||
    !WORKFLOW_NUMBER.test(workflow.runAttempt) ||
    !isExactRecord(validation, [
      "cleanupVerifiedAt",
      "fullFixturePassedAt",
      "mode",
      "observedChecks",
      "providerMode",
      "syntheticActions",
    ]) ||
    validation.mode !== "full" ||
    validation.providerMode !== "local_docker" ||
    !sameList(validation.observedChecks, RUNNER_BOOT_COMPONENTS) ||
    !sameList(validation.syntheticActions, ["start", "status", "canary", "stop"]) ||
    !isTimestamp(validation.fullFixturePassedAt) ||
    !isTimestamp(validation.cleanupVerifiedAt) ||
    !isTimestamp(raw.createdAt)
  ) {
    return null;
  }

  const timestamps = [
    validation.fullFixturePassedAt,
    validation.cleanupVerifiedAt,
    raw.createdAt,
  ].map(Date.parse);
  if (timestamps.some((value, index) => index > 0 && value < (timestamps[index - 1] ?? value))) {
    return null;
  }

  return raw as RunnerReleaseManifest;
}

function releaseIdentitiesMatch(
  manifest: RunnerReleaseManifest,
  expected: RunnerReleaseExpectedIdentities,
): boolean {
  return (
    manifest.controlPlane.source.revision === expected.sourceRevision &&
    manifest.runnerImage.reference === expected.runnerImage &&
    manifest.defaultAgentImage.reference === expected.defaultAgentImage &&
    manifest.hermesImage.reference === expected.hermesImage &&
    manifest.snapshot.ociReference === expected.snapshotOciReference &&
    manifest.snapshot.bundleDigest === expected.snapshotBundleDigest &&
    manifest.controlPlane.contracts.boot ===
      (expected.bootContractVersion ?? RUNNER_BOOT_CONTRACT_VERSION)
  );
}

function runnerImageMatches(reference: string, digest: string, version: string): boolean {
  const parsed = parseImmutableRunnerImageReference(reference);
  return parsed?.imageDigest === digest && parsed.version === version;
}

function isBundleSignature(value: unknown): value is RunnerReleaseBundle["signature"] {
  if (
    !isExactRecord(value, ["algorithm", "keyId", "value"]) ||
    value.algorithm !== SIGNATURE_ALGORITHM ||
    typeof value.keyId !== "string" ||
    !SIGNING_KEY_ID.test(value.keyId) ||
    typeof value.value !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value.value)
  ) {
    return false;
  }
  const decoded = Buffer.from(value.value, "base64url");
  return decoded.byteLength === 64 && decoded.toString("base64url") === value.value;
}

function sameList(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" && ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value))
  );
}

function digestBytes(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return expected.length === actual.length && expected.every((key, index) => key === actual[index]);
}

const RELEASE_MANIFEST_KEYS = [
  "controlPlane",
  "createdAt",
  "defaultAgentImage",
  "hermesImage",
  "runnerImage",
  "schemaVersion",
  "snapshot",
  "validation",
  "workflow",
] as const;
