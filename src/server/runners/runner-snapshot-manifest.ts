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

export const RUNNER_SNAPSHOT_MANIFEST_SCHEMA_VERSION = "plingpling.runner.snapshot.v1";

const MAX_MANIFEST_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SNAPSHOT_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const DIGITALOCEAN_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const SAFE_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export type RunnerSnapshotManifest = {
  schemaVersion: typeof RUNNER_SNAPSHOT_MANIFEST_SCHEMA_VERSION;
  snapshot: {
    id: string;
    name: string;
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
  expiresAt: string;
};

export type RunnerSnapshotAttestation = {
  manifest: RunnerSnapshotManifest;
  canonicalBytes: string;
  digest: string;
  signature: string;
};

export type RunnerSnapshotManifestFailureReason =
  | "manifest_json_invalid"
  | "manifest_schema_invalid"
  | "manifest_signature_invalid"
  | "manifest_identity_mismatch"
  | "manifest_stale"
  | "manifest_not_yet_valid"
  | "manifest_region_unavailable"
  | "manifest_min_disk_mismatch"
  | "provider_image_lookup_unavailable"
  | "provider_image_unavailable";

export type RunnerSnapshotManifestCheck =
  | { ok: true; manifest: RunnerSnapshotManifest; digest: string }
  | { ok: false; reason: RunnerSnapshotManifestFailureReason };

export type RunnerSnapshotExpectedIdentities = {
  region: string;
  sizeDiskGb: number;
  baseImageSlug: string;
  architecture: "amd64";
  runnerImage: string;
  defaultAgentImage: string;
  hermesImage: string;
  sourceRepository: string;
  sourceRevision: string;
  bootContractVersion?: string;
  now?: Date;
};

export type RunnerSnapshotManifestSelection =
  | { ok: true; image: string; manifest: RunnerSnapshotManifest; digest: string }
  | { ok: false; reason: RunnerSnapshotManifestFailureReason };

export function createRunnerSnapshotAttestation(input: {
  manifest: RunnerSnapshotManifest;
  privateKeyPem: string;
}): RunnerSnapshotAttestation {
  const parsed = parseRunnerSnapshotManifest(input.manifest);

  if (!parsed.ok) {
    throw new Error(`Runner snapshot manifest is invalid: ${parsed.reason}.`);
  }

  const canonicalBytes = canonicalJson(parsed.manifest);
  const signature = sign(null, Buffer.from(canonicalBytes), input.privateKeyPem).toString(
    "base64url",
  );

  return {
    manifest: parsed.manifest,
    canonicalBytes,
    digest: digestCanonicalBytes(canonicalBytes),
    signature,
  };
}

export function verifyRunnerSnapshotManifest(input: {
  manifestBytes: string;
  signature: string;
  publicKeyPem: string;
  expected: RunnerSnapshotExpectedIdentities;
}): RunnerSnapshotManifestCheck {
  let raw: unknown;

  try {
    raw = JSON.parse(input.manifestBytes);
  } catch {
    return { ok: false, reason: "manifest_json_invalid" };
  }

  const parsed = parseRunnerSnapshotManifest(raw);

  if (!parsed.ok) {
    return parsed;
  }

  const canonicalBytes = canonicalJson(parsed.manifest);
  const verified = verify(
    null,
    Buffer.from(canonicalBytes),
    input.publicKeyPem,
    Buffer.from(input.signature, "base64url"),
  );

  if (!verified) {
    return { ok: false, reason: "manifest_signature_invalid" };
  }

  const identity = checkManifestIdentities(parsed.manifest, input.expected);

  if (!identity.ok) {
    return identity;
  }

  return {
    ok: true,
    manifest: parsed.manifest,
    digest: digestCanonicalBytes(canonicalBytes),
  };
}

export async function selectVerifiedRunnerSnapshotImage(input: {
  manifestBytes?: string;
  signature?: string;
  publicKeyPem?: string;
  expected: RunnerSnapshotExpectedIdentities;
  provider: DigitalOceanProvider;
  context?: DigitalOceanProviderRequestContext;
}): Promise<RunnerSnapshotManifestSelection> {
  if (!input.manifestBytes || !input.signature || !input.publicKeyPem) {
    return { ok: false, reason: "manifest_schema_invalid" };
  }

  const verified = verifyRunnerSnapshotManifest({
    manifestBytes: input.manifestBytes,
    signature: input.signature,
    publicKeyPem: input.publicKeyPem,
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

  if (!image.ok || !imageAvailableForManifest(image.value, verified.manifest, input.expected)) {
    return { ok: false, reason: "provider_image_unavailable" };
  }

  return {
    ok: true,
    image: verified.manifest.snapshot.id,
    manifest: verified.manifest,
    digest: verified.digest,
  };
}

export function parseRunnerSnapshotManifest(raw: unknown): RunnerSnapshotManifestCheck {
  if (!isRecord(raw) || hasUnknownKeys(raw, RUNNER_SNAPSHOT_MANIFEST_KEYS)) {
    return { ok: false, reason: "manifest_schema_invalid" };
  }

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
    !isIsoTimestamp(raw.availableAt) ||
    !isIsoTimestamp(raw.expiresAt)
  ) {
    return { ok: false, reason: "manifest_schema_invalid" };
  }

  const manifest = raw as RunnerSnapshotManifest;
  const ordered = checkTimestampOrder(manifest);

  if (!ordered.ok) {
    return ordered;
  }

  return {
    ok: true,
    manifest,
    digest: digestCanonicalBytes(canonicalJson(manifest)),
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

function checkManifestIdentities(
  manifest: RunnerSnapshotManifest,
  expected: RunnerSnapshotExpectedIdentities,
): RunnerSnapshotManifestCheck {
  const now = expected.now ?? new Date();
  const createdAt = new Date(manifest.createdAt).getTime();
  const availableAt = new Date(manifest.availableAt).getTime();
  const expiresAt = new Date(manifest.expiresAt).getTime();
  const runner = parseImmutableRunnerImageReference(expected.runnerImage);
  const agent = parseImmutableRunnerImageReference(expected.defaultAgentImage);

  if (createdAt > now.getTime() || availableAt > now.getTime()) {
    return { ok: false, reason: "manifest_not_yet_valid" };
  }

  if (expiresAt <= now.getTime() || now.getTime() - availableAt > MAX_MANIFEST_AGE_MS) {
    return { ok: false, reason: "manifest_stale" };
  }

  if (!manifest.snapshot.regions.includes(expected.region)) {
    return { ok: false, reason: "manifest_region_unavailable" };
  }

  if (manifest.snapshot.minDiskSizeGb > expected.sizeDiskGb) {
    return { ok: false, reason: "manifest_min_disk_mismatch" };
  }

  if (
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
    manifest.source.repository !== expected.sourceRepository ||
    manifest.source.revision !== expected.sourceRevision ||
    manifest.bootContractVersion !== (expected.bootContractVersion ?? RUNNER_BOOT_CONTRACT_VERSION)
  ) {
    return { ok: false, reason: "manifest_identity_mismatch" };
  }

  return { ok: true, manifest, digest: digestCanonicalBytes(canonicalJson(manifest)) };
}

function imageAvailableForManifest(
  image: DigitalOceanImageAvailability,
  manifest: RunnerSnapshotManifest,
  expected: RunnerSnapshotExpectedIdentities,
): boolean {
  return (
    image.id === manifest.snapshot.id &&
    image.status === "available" &&
    image.architecture === expected.architecture &&
    image.minDiskSizeGb <= expected.sizeDiskGb &&
    image.regions.includes(expected.region)
  );
}

function checkTimestampOrder(manifest: RunnerSnapshotManifest): RunnerSnapshotManifestCheck {
  const fullBoot = new Date(manifest.validation.fullBootFixturePassedAt).getTime();
  const sanitation = new Date(manifest.validation.sanitationPassedAt).getTime();
  const created = new Date(manifest.createdAt).getTime();
  const available = new Date(manifest.availableAt).getTime();
  const expires = new Date(manifest.expiresAt).getTime();

  if (
    ![fullBoot, sanitation, created, available, expires].every(Number.isFinite) ||
    fullBoot > sanitation ||
    sanitation > created ||
    created > available ||
    available >= expires
  ) {
    return { ok: false, reason: "manifest_schema_invalid" };
  }

  return { ok: true, manifest, digest: digestCanonicalBytes(canonicalJson(manifest)) };
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

function isSnapshot(value: unknown): value is RunnerSnapshotManifest["snapshot"] {
  const minDiskSizeGb = isRecord(value) ? value.minDiskSizeGb : null;

  return (
    isRecord(value) &&
    !hasUnknownKeys(value, ["id", "name", "regions", "minDiskSizeGb", "architecture"]) &&
    typeof value.id === "string" &&
    SNAPSHOT_ID_PATTERN.test(value.id) &&
    typeof value.name === "string" &&
    SAFE_IDENTITY_PATTERN.test(value.name) &&
    Array.isArray(value.regions) &&
    value.regions.length > 0 &&
    value.regions.every(
      (region) => typeof region === "string" && DIGITALOCEAN_SLUG_PATTERN.test(region),
    ) &&
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
    value.repository === "ametel01/plingpling" &&
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
  "expiresAt",
] as const;
