import "server-only";

import { createHash, sign, verify } from "node:crypto";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import { parseImmutableRunnerImageReference } from "@/src/runner-service/release-identity";
import type {
  DigitalOceanImageAvailability,
  DigitalOceanProvider,
  DigitalOceanProviderRequestContext,
} from "@/src/server/runners/digitalocean-provider";

export const RUNNER_SNAPSHOT_MANIFEST_SCHEMA_VERSION = "bruno.runner.snapshot.v2";
export const RUNNER_SNAPSHOT_BUNDLE_SCHEMA_VERSION = "bruno.runner.snapshot.bundle.v1";

const SNAPSHOT_SIGNATURE_ALGORITHM = "Ed25519";
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SNAPSHOT_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const DIGITALOCEAN_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const SAFE_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const SIGNING_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export type RunnerSnapshotManifest = {
  schemaVersion: typeof RUNNER_SNAPSHOT_MANIFEST_SCHEMA_VERSION;
  runner: {
    region: string;
    sizeSlug: string;
    diskSizeGb: number;
    architecture: "amd64";
  };
  snapshot: {
    provider: "digitalocean";
    id: string;
    name: string;
    status: "available";
    regions: string[];
    minDiskSizeGb: number;
    architecture: "amd64";
  };
  baseImage: {
    id: string;
    slug: string;
  };
  runnerImage: {
    reference: string;
    digest: string;
  };
  defaultAgentImage: {
    reference: string;
    digest: string;
  };
  hermesImage: {
    reference: string;
    indexDigest: string;
    amd64ManifestDigest: string;
  };
  bootContractVersion: typeof RUNNER_BOOT_CONTRACT_VERSION;
  source: {
    repository: string;
    revision: string;
  };
  workflow: {
    runId: string;
    runAttempt: string;
  };
  validation: {
    fullBootFixturePassedAt: string;
    sanitationPassedAt: string;
  };
  createdAt: string;
  availableAt: string;
};

export type RunnerSnapshotBundle = {
  schemaVersion: typeof RUNNER_SNAPSHOT_BUNDLE_SCHEMA_VERSION;
  manifest: RunnerSnapshotManifest;
  signature: {
    algorithm: typeof SNAPSHOT_SIGNATURE_ALGORITHM;
    keyId: string;
    value: string;
  };
};

export type RunnerSnapshotAttestation = {
  bundle: RunnerSnapshotBundle;
  bundleBytes: string;
  digest: string;
};

export type RunnerSnapshotManifestFailureReason =
  | "bundle_json_invalid"
  | "bundle_schema_invalid"
  | "manifest_schema_invalid"
  | "manifest_signature_invalid"
  | "manifest_signing_key_untrusted"
  | "manifest_not_approved"
  | "manifest_identity_mismatch"
  | "manifest_region_unavailable"
  | "manifest_min_disk_mismatch"
  | "provider_image_lookup_unavailable"
  | "provider_image_unavailable";

export type RunnerSnapshotManifestCheck =
  | {
      ok: true;
      manifest: RunnerSnapshotManifest;
      bundle: RunnerSnapshotBundle;
      digest: string;
      signingKeyId: string;
    }
  | { ok: false; reason: RunnerSnapshotManifestFailureReason };

export type RunnerSnapshotExpectedIdentities = {
  region: string;
  sizeSlug: string;
  sizeDiskGb: number;
  baseImageSlug: string;
  architecture: "amd64";
  runnerImage: string;
  defaultAgentImage: string;
  hermesImage: string;
  bootContractVersion?: string;
};

export type RunnerSnapshotTrustedPublicKeys = Readonly<Record<string, string>>;

export type RunnerSnapshotManifestSelection =
  | {
      ok: true;
      image: string;
      manifest: RunnerSnapshotManifest;
      bundle: RunnerSnapshotBundle;
      digest: string;
      signingKeyId: string;
    }
  | { ok: false; reason: RunnerSnapshotManifestFailureReason };

type ParsedRunnerSnapshotManifest =
  | { ok: true; manifest: RunnerSnapshotManifest }
  | { ok: false; reason: "manifest_schema_invalid" };

type ParsedRunnerSnapshotBundle =
  | { ok: true; bundle: RunnerSnapshotBundle; digest: string }
  | {
      ok: false;
      reason: "bundle_json_invalid" | "bundle_schema_invalid" | "manifest_schema_invalid";
    };

type RunnerSnapshotIdentityCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "manifest_identity_mismatch"
        | "manifest_region_unavailable"
        | "manifest_min_disk_mismatch";
    };

export function createRunnerSnapshotAttestation(input: {
  manifest: RunnerSnapshotManifest;
  signingKeyId: string;
  privateKeyPem: string;
}): RunnerSnapshotAttestation {
  const parsed = parseRunnerSnapshotManifest(input.manifest);

  if (!parsed.ok) {
    throw new Error(`Runner snapshot manifest is invalid: ${parsed.reason}.`);
  }
  if (!SIGNING_KEY_ID_PATTERN.test(input.signingKeyId)) {
    throw new Error("Runner snapshot signing key ID is invalid.");
  }

  const canonicalBytes = canonicalJson(parsed.manifest);
  const signature = sign(null, Buffer.from(canonicalBytes), input.privateKeyPem).toString(
    "base64url",
  );
  const bundle: RunnerSnapshotBundle = {
    schemaVersion: RUNNER_SNAPSHOT_BUNDLE_SCHEMA_VERSION,
    manifest: parsed.manifest,
    signature: {
      algorithm: SNAPSHOT_SIGNATURE_ALGORITHM,
      keyId: input.signingKeyId,
      value: signature,
    },
  };
  const bundleBytes = canonicalJson(bundle);

  return {
    bundle,
    bundleBytes,
    digest: digestCanonicalBytes(bundleBytes),
  };
}

export function verifyRunnerSnapshotBundle(input: {
  bundleBytes: string;
  approvedDigest?: string;
  trustedPublicKeys: RunnerSnapshotTrustedPublicKeys;
  expected: RunnerSnapshotExpectedIdentities;
}): RunnerSnapshotManifestCheck {
  const parsed = parseRunnerSnapshotBundle(input.bundleBytes);

  if (!parsed.ok) {
    return parsed;
  }
  if (input.approvedDigest !== parsed.digest) {
    return { ok: false, reason: "manifest_not_approved" };
  }

  const { bundle } = parsed;
  const publicKeyPem = Object.hasOwn(input.trustedPublicKeys, bundle.signature.keyId)
    ? input.trustedPublicKeys[bundle.signature.keyId]
    : undefined;

  if (!publicKeyPem) {
    return { ok: false, reason: "manifest_signing_key_untrusted" };
  }

  let verified = false;

  try {
    verified = verify(
      null,
      Buffer.from(canonicalJson(bundle.manifest)),
      publicKeyPem,
      Buffer.from(bundle.signature.value, "base64url"),
    );
  } catch {
    return { ok: false, reason: "manifest_signature_invalid" };
  }

  if (!verified) {
    return { ok: false, reason: "manifest_signature_invalid" };
  }

  const identity = checkManifestIdentities(bundle.manifest, input.expected);

  if (!identity.ok) {
    return identity;
  }

  return {
    ok: true,
    manifest: bundle.manifest,
    bundle,
    digest: parsed.digest,
    signingKeyId: bundle.signature.keyId,
  };
}

export async function selectApprovedRunnerSnapshotImage(input: {
  bundleBytes?: string;
  approvedDigest?: string;
  trustedPublicKeys: RunnerSnapshotTrustedPublicKeys;
  expected: RunnerSnapshotExpectedIdentities;
  provider: DigitalOceanProvider;
  context?: DigitalOceanProviderRequestContext;
}): Promise<RunnerSnapshotManifestSelection> {
  if (!input.bundleBytes) {
    return { ok: false, reason: "bundle_schema_invalid" };
  }

  const verified = verifyRunnerSnapshotBundle({
    bundleBytes: input.bundleBytes,
    ...(input.approvedDigest ? { approvedDigest: input.approvedDigest } : {}),
    trustedPublicKeys: input.trustedPublicKeys,
    expected: input.expected,
  });

  if (!verified.ok) {
    return verified;
  }
  if (!input.provider.readImageAvailability) {
    return { ok: false, reason: "provider_image_lookup_unavailable" };
  }

  const image = await input.provider.readImageAvailability(
    { imageId: verified.manifest.snapshot.id },
    input.context,
  );

  if (!image.ok || !imageAvailableForManifest(image.value, verified.manifest)) {
    return { ok: false, reason: "provider_image_unavailable" };
  }

  return {
    ok: true,
    image: verified.manifest.snapshot.id,
    manifest: verified.manifest,
    bundle: verified.bundle,
    digest: verified.digest,
    signingKeyId: verified.signingKeyId,
  };
}

export function parseRunnerSnapshotBundle(bundleBytes: string): ParsedRunnerSnapshotBundle {
  let raw: unknown;

  try {
    raw = JSON.parse(bundleBytes);
  } catch {
    return { ok: false, reason: "bundle_json_invalid" };
  }

  if (
    !isRecord(raw) ||
    hasUnknownKeys(raw, ["schemaVersion", "manifest", "signature"]) ||
    raw.schemaVersion !== RUNNER_SNAPSHOT_BUNDLE_SCHEMA_VERSION ||
    !isBundleSignature(raw.signature)
  ) {
    return { ok: false, reason: "bundle_schema_invalid" };
  }

  const manifest = parseRunnerSnapshotManifest(raw.manifest);

  if (!manifest.ok) {
    return manifest;
  }

  const bundle: RunnerSnapshotBundle = {
    schemaVersion: RUNNER_SNAPSHOT_BUNDLE_SCHEMA_VERSION,
    manifest: manifest.manifest,
    signature: raw.signature,
  };
  const canonicalBytes = canonicalJson(bundle);

  return {
    ok: true,
    bundle,
    digest: digestCanonicalBytes(canonicalBytes),
  };
}

export function parseRunnerSnapshotManifest(raw: unknown): ParsedRunnerSnapshotManifest {
  if (!isRecord(raw) || hasUnknownKeys(raw, RUNNER_SNAPSHOT_MANIFEST_KEYS)) {
    return { ok: false, reason: "manifest_schema_invalid" };
  }

  const runner = raw.runner;
  const snapshot = raw.snapshot;
  const baseImage = raw.baseImage;
  const runnerImage = raw.runnerImage;
  const defaultAgentImage = raw.defaultAgentImage;
  const hermesImage = raw.hermesImage;
  const source = raw.source;
  const workflow = raw.workflow;
  const validation = raw.validation;

  if (
    raw.schemaVersion !== RUNNER_SNAPSHOT_MANIFEST_SCHEMA_VERSION ||
    !isRunner(runner) ||
    !isSnapshot(snapshot) ||
    !isBaseImage(baseImage) ||
    !isDigestImage(runnerImage) ||
    !isDigestImage(defaultAgentImage) ||
    !isHermesImage(hermesImage) ||
    raw.bootContractVersion !== RUNNER_BOOT_CONTRACT_VERSION ||
    !isSource(source) ||
    !isWorkflow(workflow) ||
    !isValidation(validation) ||
    !isIsoTimestamp(raw.createdAt) ||
    !isIsoTimestamp(raw.availableAt)
  ) {
    return { ok: false, reason: "manifest_schema_invalid" };
  }

  const manifest = raw as RunnerSnapshotManifest;

  if (!timestampsAreOrdered(manifest)) {
    return { ok: false, reason: "manifest_schema_invalid" };
  }

  return { ok: true, manifest };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

function checkManifestIdentities(
  manifest: RunnerSnapshotManifest,
  expected: RunnerSnapshotExpectedIdentities,
): RunnerSnapshotIdentityCheck {
  const runner = parseImmutableRunnerImageReference(expected.runnerImage);
  const agent = parseImmutableRunnerImageReference(expected.defaultAgentImage);

  if (!manifest.snapshot.regions.includes(expected.region)) {
    return { ok: false, reason: "manifest_region_unavailable" };
  }
  if (manifest.snapshot.minDiskSizeGb > expected.sizeDiskGb) {
    return { ok: false, reason: "manifest_min_disk_mismatch" };
  }
  if (
    manifest.runner.region !== expected.region ||
    manifest.runner.sizeSlug !== expected.sizeSlug ||
    manifest.runner.diskSizeGb !== expected.sizeDiskGb ||
    manifest.runner.architecture !== expected.architecture ||
    manifest.snapshot.architecture !== expected.architecture ||
    manifest.baseImage.slug !== expected.baseImageSlug ||
    manifest.runnerImage.reference !== expected.runnerImage ||
    manifest.runnerImage.digest !== runner?.imageDigest ||
    manifest.defaultAgentImage.reference !== expected.defaultAgentImage ||
    manifest.defaultAgentImage.digest !== agent?.imageDigest ||
    manifest.hermesImage.reference !== expected.hermesImage ||
    manifest.hermesImage.indexDigest !== DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST ||
    manifest.hermesImage.amd64ManifestDigest !==
      DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST ||
    manifest.bootContractVersion !== (expected.bootContractVersion ?? RUNNER_BOOT_CONTRACT_VERSION)
  ) {
    return { ok: false, reason: "manifest_identity_mismatch" };
  }

  return { ok: true };
}

function imageAvailableForManifest(
  image: DigitalOceanImageAvailability,
  manifest: RunnerSnapshotManifest,
): boolean {
  return (
    image.id === manifest.snapshot.id &&
    image.name === manifest.snapshot.name &&
    image.status === manifest.snapshot.status &&
    image.architecture === manifest.snapshot.architecture &&
    image.minDiskSizeGb === manifest.snapshot.minDiskSizeGb &&
    sameStringSet(image.regions, manifest.snapshot.regions)
  );
}

function timestampsAreOrdered(manifest: RunnerSnapshotManifest): boolean {
  const values = [
    manifest.validation.fullBootFixturePassedAt,
    manifest.validation.sanitationPassedAt,
    manifest.createdAt,
    manifest.availableAt,
  ].map((value) => new Date(value).getTime());

  return (
    values.every(Number.isFinite) &&
    values.every((value, index) => {
      const previous = values[index - 1];
      return previous === undefined || previous <= value;
    })
  );
}

function digestCanonicalBytes(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function toCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toCanonicalValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, toCanonicalValue(value[key])]),
    );
  }
  return value;
}

function isRunner(value: unknown): value is RunnerSnapshotManifest["runner"] {
  const diskSizeGb = isRecord(value) ? value.diskSizeGb : null;

  return (
    isRecord(value) &&
    !hasUnknownKeys(value, ["region", "sizeSlug", "diskSizeGb", "architecture"]) &&
    typeof value.region === "string" &&
    DIGITALOCEAN_SLUG_PATTERN.test(value.region) &&
    typeof value.sizeSlug === "string" &&
    DIGITALOCEAN_SLUG_PATTERN.test(value.sizeSlug) &&
    typeof diskSizeGb === "number" &&
    Number.isInteger(diskSizeGb) &&
    diskSizeGb > 0 &&
    value.architecture === "amd64"
  );
}

function isSnapshot(value: unknown): value is RunnerSnapshotManifest["snapshot"] {
  const minDiskSizeGb = isRecord(value) ? value.minDiskSizeGb : null;

  return (
    isRecord(value) &&
    !hasUnknownKeys(value, [
      "provider",
      "id",
      "name",
      "status",
      "regions",
      "minDiskSizeGb",
      "architecture",
    ]) &&
    value.provider === "digitalocean" &&
    typeof value.id === "string" &&
    SNAPSHOT_ID_PATTERN.test(value.id) &&
    typeof value.name === "string" &&
    SAFE_IDENTITY_PATTERN.test(value.name) &&
    value.status === "available" &&
    isUniqueSlugList(value.regions) &&
    typeof minDiskSizeGb === "number" &&
    Number.isInteger(minDiskSizeGb) &&
    minDiskSizeGb > 0 &&
    value.architecture === "amd64"
  );
}

function isBaseImage(value: unknown): value is RunnerSnapshotManifest["baseImage"] {
  return (
    isRecord(value) &&
    !hasUnknownKeys(value, ["id", "slug"]) &&
    typeof value.id === "string" &&
    SAFE_IDENTITY_PATTERN.test(value.id) &&
    typeof value.slug === "string" &&
    DIGITALOCEAN_SLUG_PATTERN.test(value.slug)
  );
}

function isDigestImage(value: unknown): value is RunnerSnapshotManifest["runnerImage"] {
  return (
    isRecord(value) &&
    !hasUnknownKeys(value, ["reference", "digest"]) &&
    typeof value.reference === "string" &&
    parseImmutableRunnerImageReference(value.reference) !== null &&
    typeof value.digest === "string" &&
    SHA256_DIGEST_PATTERN.test(value.digest)
  );
}

function isHermesImage(value: unknown): value is RunnerSnapshotManifest["hermesImage"] {
  return (
    isRecord(value) &&
    !hasUnknownKeys(value, ["reference", "indexDigest", "amd64ManifestDigest"]) &&
    typeof value.reference === "string" &&
    value.reference.includes("@sha256:") &&
    typeof value.indexDigest === "string" &&
    SHA256_DIGEST_PATTERN.test(value.indexDigest) &&
    typeof value.amd64ManifestDigest === "string" &&
    SHA256_DIGEST_PATTERN.test(value.amd64ManifestDigest)
  );
}

function isSource(value: unknown): value is RunnerSnapshotManifest["source"] {
  return (
    isRecord(value) &&
    !hasUnknownKeys(value, ["repository", "revision"]) &&
    value.repository === "ametel01/bruno" &&
    typeof value.revision === "string" &&
    /^[a-f0-9]{40}$/.test(value.revision)
  );
}

function isWorkflow(value: unknown): value is RunnerSnapshotManifest["workflow"] {
  return (
    isRecord(value) &&
    !hasUnknownKeys(value, ["runId", "runAttempt"]) &&
    typeof value.runId === "string" &&
    /^[1-9][0-9]{0,18}$/.test(value.runId) &&
    typeof value.runAttempt === "string" &&
    /^[1-9][0-9]{0,8}$/.test(value.runAttempt)
  );
}

function isValidation(value: unknown): value is RunnerSnapshotManifest["validation"] {
  return (
    isRecord(value) &&
    !hasUnknownKeys(value, ["fullBootFixturePassedAt", "sanitationPassedAt"]) &&
    isIsoTimestamp(value.fullBootFixturePassedAt) &&
    isIsoTimestamp(value.sanitationPassedAt)
  );
}

function isBundleSignature(value: unknown): value is RunnerSnapshotBundle["signature"] {
  if (
    !isRecord(value) ||
    hasUnknownKeys(value, ["algorithm", "keyId", "value"]) ||
    value.algorithm !== SNAPSHOT_SIGNATURE_ALGORITHM ||
    typeof value.keyId !== "string" ||
    !SIGNING_KEY_ID_PATTERN.test(value.keyId) ||
    typeof value.value !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value.value)
  ) {
    return false;
  }

  const decoded = Buffer.from(value.value, "base64url");
  return decoded.byteLength === 64 && decoded.toString("base64url") === value.value;
}

function isUniqueSlugList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && DIGITALOCEAN_SLUG_PATTERN.test(entry)) &&
    new Set(value).size === value.length
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_TIMESTAMP_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnknownKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).some((key) => !allowed.has(key));
}

const RUNNER_SNAPSHOT_MANIFEST_KEYS = [
  "schemaVersion",
  "runner",
  "snapshot",
  "baseImage",
  "runnerImage",
  "defaultAgentImage",
  "hermesImage",
  "bootContractVersion",
  "source",
  "workflow",
  "validation",
  "createdAt",
  "availableAt",
] as const;
