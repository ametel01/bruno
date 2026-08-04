import { execFile } from "node:child_process";
import {
  DOCKER_CLI_TIMEOUT_MS,
  RUNNER_BOOT_CONTRACT_VERSION,
  RUNNER_BOOT_CONTRACT_VERSION_MAX_LENGTH,
  RUNNER_OCI_REVISION_LABEL,
  RUNNER_OCI_VERSION_LABEL,
  RUNNER_RELEASE_DOCKER_OUTPUT_MAX_BYTES,
  RUNNER_RELEASE_MAX_REPO_DIGESTS,
  RUNNER_RELEASE_VERSION_MAX_LENGTH,
} from "@/src/runner-service/constants";

export const RUNNER_EXPECTED_RELEASE_VERSION_ENV = "AGENTBAY_RUNNER_EXPECTED_RELEASE_VERSION";
export const RUNNER_EXPECTED_IMAGE_DIGEST_ENV = "AGENTBAY_RUNNER_EXPECTED_IMAGE_DIGEST";
export const RUNNER_EXPECTED_BOOT_CONTRACT_VERSION_ENV =
  "AGENTBAY_RUNNER_EXPECTED_BOOT_CONTRACT_VERSION";
export const RUNNER_RELEASE_IDENTITY_MODE_ENV = "AGENTBAY_RUNNER_RELEASE_IDENTITY_MODE";
export const RUNNER_CONTAINER_ID_ENV = "AGENTBAY_RUNNER_CONTAINER_ID";
export const RUNNER_RELEASE_DEVELOPMENT_MODE = "development";

const CONTAINER_INSPECT_FORMAT = '{"imageId":{{json .Image}}}';
const IMAGE_INSPECT_FORMAT =
  '{"imageId":{{json .Id}},"repoDigests":{{json .RepoDigests}},"labels":{{json .Config.Labels}}}';
const CANONICAL_IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const CANONICAL_RELEASE_FIELD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_CONTAINER_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type RunnerReleaseIdentity = {
  version: string;
  imageDigest: string;
  bootContractVersion: string;
};

export type RunnerReleaseEvidence = {
  release: RunnerReleaseIdentity;
  expectedMatch: boolean | null;
};

export type RunnerReleaseDocker = (
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export type RunnerReleaseIdentityErrorReason =
  | "container_identity_invalid"
  | "container_inspect_failed"
  | "container_inspect_invalid"
  | "expected_identity_invalid"
  | "image_inspect_failed"
  | "image_inspect_invalid"
  | "observed_digest_ambiguous"
  | "observed_digest_missing"
  | "observed_version_invalid";

export class RunnerReleaseIdentityError extends Error {
  readonly reason: RunnerReleaseIdentityErrorReason;

  constructor(reason: RunnerReleaseIdentityErrorReason) {
    super(`Runner release identity is unavailable: ${reason}.`);
    this.name = "RunnerReleaseIdentityError";
    this.reason = reason;
  }
}

export function parseImmutableRunnerImageReference(
  value: string,
): { imageReference: string; imageDigest: string; version: string } | null {
  const normalized = value.trim();
  const match =
    /^([a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+)(?::([A-Za-z0-9_][A-Za-z0-9._-]{0,79}))?@(sha256:[a-f0-9]{64})$/.exec(
      normalized,
    );

  if (!match?.[1] || !match[3]) {
    return null;
  }

  const version = match[2] ?? match[3].slice("sha256:".length);

  if (!normalizeRunnerReleaseVersion(version)) {
    return null;
  }

  return {
    imageReference: normalized,
    imageDigest: match[3],
    version,
  };
}

export function parseRunnerReleaseIdentity(value: unknown): RunnerReleaseIdentity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const input = value as Record<string, unknown>;
  const version = normalizeRunnerReleaseVersion(input.version);
  const imageDigest = normalizeRunnerImageDigest(input.imageDigest);
  const bootContractVersion = normalizeRunnerBootContractVersion(input.bootContractVersion);

  return version && imageDigest && bootContractVersion
    ? { version, imageDigest, bootContractVersion }
    : null;
}

export function normalizeRunnerReleaseVersion(value: unknown): string | null {
  return normalizeBoundedReleaseField(value, RUNNER_RELEASE_VERSION_MAX_LENGTH);
}

export function normalizeRunnerImageDigest(value: unknown): string | null {
  return typeof value === "string" && CANONICAL_IMAGE_DIGEST.test(value) ? value : null;
}

export function normalizeRunnerBootContractVersion(value: unknown): string | null {
  return normalizeBoundedReleaseField(value, RUNNER_BOOT_CONTRACT_VERSION_MAX_LENGTH);
}

export function readExpectedRunnerReleaseIdentity(
  env: Record<string, string | undefined>,
): RunnerReleaseIdentity | null {
  const fields = [
    env[RUNNER_EXPECTED_RELEASE_VERSION_ENV]?.trim(),
    env[RUNNER_EXPECTED_IMAGE_DIGEST_ENV]?.trim(),
    env[RUNNER_EXPECTED_BOOT_CONTRACT_VERSION_ENV]?.trim(),
  ] as const;

  if (fields.every((field) => !field)) {
    return null;
  }

  const parsed = parseRunnerReleaseIdentity({
    version: fields[0],
    imageDigest: fields[1],
    bootContractVersion: fields[2],
  });

  if (!parsed) {
    throw new RunnerReleaseIdentityError("expected_identity_invalid");
  }

  return parsed;
}

export async function resolveRunnerReleaseEvidence(
  input: {
    containerIdentity?: string;
    docker?: RunnerReleaseDocker;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<RunnerReleaseEvidence> {
  const env = input.env ?? process.env;
  const containerIdentity =
    input.containerIdentity?.trim() || env[RUNNER_CONTAINER_ID_ENV]?.trim() || env.HOSTNAME?.trim();

  if (!containerIdentity || !SAFE_CONTAINER_IDENTITY.test(containerIdentity)) {
    throw new RunnerReleaseIdentityError("container_identity_invalid");
  }

  const docker = input.docker ?? executeDocker;
  const containerInspect = await runDockerInspect(
    docker,
    ["inspect", "--type", "container", "--format", CONTAINER_INSPECT_FORMAT, containerIdentity],
    "container_inspect_failed",
  );
  const containerRecord = parseJsonRecord(containerInspect);
  const containerImageId = normalizeRunnerImageDigest(containerRecord?.imageId);

  if (!containerImageId) {
    throw new RunnerReleaseIdentityError("container_inspect_invalid");
  }

  const imageInspect = await runDockerInspect(
    docker,
    ["image", "inspect", "--format", IMAGE_INSPECT_FORMAT, containerImageId],
    "image_inspect_failed",
  );
  const imageRecord = parseJsonRecord(imageInspect);

  if (!imageRecord || normalizeRunnerImageDigest(imageRecord.imageId) !== containerImageId) {
    throw new RunnerReleaseIdentityError("image_inspect_invalid");
  }

  const labels = parseStringRecord(imageRecord.labels);
  const version =
    normalizeRunnerReleaseVersion(labels?.[RUNNER_OCI_VERSION_LABEL]) ??
    normalizeRunnerReleaseVersion(labels?.[RUNNER_OCI_REVISION_LABEL]);

  if (!version) {
    throw new RunnerReleaseIdentityError("observed_version_invalid");
  }

  const repoDigests = parseObservedRepoDigests(imageRecord.repoDigests);
  let imageDigest: string;

  if (repoDigests.size === 1) {
    imageDigest = [...repoDigests][0] as string;
  } else if (repoDigests.size > 1) {
    throw new RunnerReleaseIdentityError("observed_digest_ambiguous");
  } else if (env[RUNNER_RELEASE_IDENTITY_MODE_ENV] === RUNNER_RELEASE_DEVELOPMENT_MODE) {
    imageDigest = containerImageId;
  } else {
    throw new RunnerReleaseIdentityError("observed_digest_missing");
  }

  const release = {
    version,
    imageDigest,
    bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
  };
  const expected = readExpectedRunnerReleaseIdentity(env);

  return {
    release,
    expectedMatch: expected ? releaseIdentitiesEqual(release, expected) : null,
  };
}

export function releaseIdentitiesEqual(
  observed: RunnerReleaseIdentity,
  expected: RunnerReleaseIdentity,
): boolean {
  return (
    observed.version === expected.version &&
    observed.imageDigest === expected.imageDigest &&
    observed.bootContractVersion === expected.bootContractVersion
  );
}

function normalizeBoundedReleaseField(value: unknown, maxLength: number): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    !CANONICAL_RELEASE_FIELD.test(value)
  ) {
    return null;
  }

  return value;
}

function parseObservedRepoDigests(value: unknown): Set<string> {
  const parsed = new Set<string>();

  if (!Array.isArray(value) || value.length > RUNNER_RELEASE_MAX_REPO_DIGESTS) {
    return parsed;
  }

  for (const reference of value) {
    if (typeof reference !== "string") {
      continue;
    }

    const separator = reference.lastIndexOf("@");
    const digest = normalizeRunnerImageDigest(
      separator >= 0 ? reference.slice(separator + 1) : reference,
    );

    if (digest) {
      parsed.add(digest);
    }
  }

  return parsed;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseStringRecord(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const result: Record<string, string> = {};

  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "string") {
      result[key] = field;
    }
  }

  return result;
}

async function runDockerInspect(
  docker: RunnerReleaseDocker,
  args: readonly string[],
  failureReason: "container_inspect_failed" | "image_inspect_failed",
): Promise<string> {
  try {
    const result = await docker(args);

    if (Buffer.byteLength(result.stdout, "utf8") > RUNNER_RELEASE_DOCKER_OUTPUT_MAX_BYTES) {
      throw new Error("oversized");
    }

    return result.stdout.trim();
  } catch {
    throw new RunnerReleaseIdentityError(failureReason);
  }
}

function executeDocker(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      [...args],
      {
        encoding: "utf8",
        maxBuffer: RUNNER_RELEASE_DOCKER_OUTPUT_MAX_BYTES,
        timeout: DOCKER_CLI_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });
}
