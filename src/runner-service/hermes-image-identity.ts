import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
} from "@/src/runner-service/constants";
import { parseImmutableRunnerImageReference } from "@/src/runner-service/release-identity";

const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OCI_INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
const DOCKER_INDEX_MEDIA_TYPE = "application/vnd.docker.distribution.manifest.list.v2+json";
const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST_MEDIA_TYPE = "application/vnd.docker.distribution.manifest.v2+json";
const INDEX_MEDIA_TYPES = new Set([OCI_INDEX_MEDIA_TYPE, DOCKER_INDEX_MEDIA_TYPE]);
const MANIFEST_MEDIA_TYPES = new Set([OCI_MANIFEST_MEDIA_TYPE, DOCKER_MANIFEST_MEDIA_TYPE]);
const MANIFEST_MAX_BYTES = 1024 * 1024;
const OPTIMIZED_HERMES_REFERENCE_PATTERN =
  /^ghcr\.io\/ametel01\/bruno-hermes(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,79})?@sha256:[a-f0-9]{64}$/;

export type HermesImageIdentity = {
  reference: string;
  indexDigest: string;
  amd64ManifestDigest: string;
};

export function validateHermesImageIdentity(
  reference: string,
  amd64ManifestDigest: string | undefined,
): HermesImageIdentity | null {
  if (reference === DEFAULT_HERMES_WORKLOAD_IMAGE) {
    if (
      amd64ManifestDigest !== undefined &&
      amd64ManifestDigest !== DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST
    ) {
      return null;
    }
    return {
      reference,
      indexDigest: DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
      amd64ManifestDigest: DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
    };
  }

  const parsed = parseImmutableRunnerImageReference(reference);
  if (
    !parsed ||
    !OPTIMIZED_HERMES_REFERENCE_PATTERN.test(reference) ||
    !amd64ManifestDigest ||
    !SHA256_DIGEST_PATTERN.test(amd64ManifestDigest)
  ) {
    return null;
  }

  return { reference, indexDigest: parsed.imageDigest, amd64ManifestDigest };
}

export function readLinuxAmd64ManifestDigest(rawIndex: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(rawIndex);
  } catch {
    throw new Error("Hermes OCI index response was invalid JSON.");
  }

  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 2 ||
    typeof raw.mediaType !== "string" ||
    !INDEX_MEDIA_TYPES.has(raw.mediaType) ||
    !Array.isArray(raw.manifests) ||
    raw.manifests.length > 64
  ) {
    throw new Error("Hermes OCI reference did not resolve to a valid OCI or Docker image index.");
  }

  const matches: Record<string, unknown>[] = [];
  for (const entry of raw.manifests) {
    if (
      !isRecord(entry) ||
      typeof entry.mediaType !== "string" ||
      !MANIFEST_MEDIA_TYPES.has(entry.mediaType) ||
      typeof entry.digest !== "string" ||
      !SHA256_DIGEST_PATTERN.test(entry.digest) ||
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0 ||
      entry.size > MANIFEST_MAX_BYTES ||
      !isRecord(entry.platform)
    ) {
      throw new Error("Hermes OCI index contained an invalid image manifest descriptor.");
    }

    if (!hasExactKeys(entry.platform, ["architecture", "os"])) {
      throw new Error(
        "Hermes OCI manifest platform must contain exact os and architecture fields.",
      );
    }
    if (
      typeof entry.platform.os !== "string" ||
      entry.platform.os.trim().length === 0 ||
      typeof entry.platform.architecture !== "string" ||
      entry.platform.architecture.trim().length === 0
    ) {
      throw new Error(
        "Hermes OCI manifest platform must contain non-empty os and architecture strings.",
      );
    }

    if (entry.platform.os === "linux" && entry.platform.architecture === "amd64") {
      matches.push(entry);
    }
  }
  const [match] = matches;

  if (
    matches.length !== 1 ||
    !isRecord(match) ||
    typeof match.digest !== "string" ||
    !SHA256_DIGEST_PATTERN.test(match.digest)
  ) {
    throw new Error("Hermes OCI index must contain one exact linux/amd64 manifest.");
  }

  return match.digest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
}
