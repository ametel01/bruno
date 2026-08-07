import "server-only";

import {
  createRunnerSnapshotAttestation,
  type RunnerSnapshotManifest,
} from "./runner-snapshot-manifest";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
  DEFAULT_MANUAL_RUNNER_IMAGE,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import { parseImmutableRunnerImageReference } from "@/src/runner-service/release-identity";
import type {
  DigitalOceanProvider,
  DigitalOceanProviderRequestContext,
  DigitalOceanResource,
} from "@/src/server/runners/digitalocean-provider";

const SNAPSHOT_AUTHORIZATION_SENTINEL = "I_UNDERSTAND_THIS_CREATES_A_BILLABLE_SNAPSHOT_BUILDER";
const SNAPSHOT_OPERATION_TAG_PREFIX = "agentbay-snapshot-build";
const SNAPSHOT_BUILDER_NAME_PREFIX = "agentbay-snapshot-builder";
const SNAPSHOT_MIN_DISK_GB = 25;

export type BuildRunnerSnapshotInput = {
  costAuthorization: string;
  operationId: string;
  sourceRevision: string;
  region: string;
  sizeSlug: string;
  baseImageId: string;
  baseImageSlug: string;
  runnerImage: string;
  defaultAgentImage?: string;
  hermesImage?: string;
  bootResult: SnapshotBootFixtureResult;
  sanitationResult: SnapshotSanitationResult;
  privateKeyPem: string;
  provider: DigitalOceanProvider;
  context: DigitalOceanProviderRequestContext;
  now?: () => Date;
};

export type SnapshotBootFixtureResult = {
  ok: boolean;
  runnerImage: string;
  defaultAgentImage: string;
  hermesImage: string;
  bootContractVersion: string;
  completedAt: string;
};

export type SnapshotSanitationResult = {
  ok: boolean;
  forbiddenPathsAbsent: boolean;
  hostileMarkersAbsent: boolean;
  completedAt: string;
};

export type BuildRunnerSnapshotResult =
  | {
      ok: true;
      manifest: RunnerSnapshotManifest;
      manifestBytes: string;
      digest: string;
      signature: string;
      cleanup: SnapshotCleanupEvidence;
    }
  | {
      ok: false;
      reason: BuildRunnerSnapshotFailureReason;
      cleanup: SnapshotCleanupEvidence;
    };

export type BuildRunnerSnapshotFailureReason =
  | "authorization_missing"
  | "input_invalid"
  | "provider_contract_missing"
  | "builder_create_failed"
  | "boot_fixture_failed"
  | "sanitation_failed"
  | "power_off_failed"
  | "snapshot_failed"
  | "snapshot_unavailable";

export type SnapshotCleanupEvidence = {
  deletedSnapshotId: string | null;
  deletedDropletId: string | null;
  ambiguousOwnership: boolean;
  steps: string[];
};

export async function buildRunnerSnapshot(
  input: BuildRunnerSnapshotInput,
): Promise<BuildRunnerSnapshotResult> {
  const cleanup: SnapshotCleanupEvidence = {
    deletedSnapshotId: null,
    deletedDropletId: null,
    ambiguousOwnership: false,
    steps: [],
  };
  const now = input.now ?? (() => new Date());
  let builder: DigitalOceanResource | null = null;
  let snapshotId: string | null = null;

  const validated = validateSnapshotBuildInput(input);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason, cleanup };
  }

  if (
    !input.provider.powerOffResource ||
    !input.provider.snapshotResource ||
    !input.provider.readAction ||
    !input.provider.readImageAvailability ||
    !input.provider.deleteImage
  ) {
    return { ok: false, reason: "provider_contract_missing", cleanup };
  }

  try {
    const operationTag = `${SNAPSHOT_OPERATION_TAG_PREFIX}-${input.operationId}`;
    const snapshotName = `${SNAPSHOT_BUILDER_NAME_PREFIX}-${input.sourceRevision.slice(0, 12)}`;
    const created = await input.provider.createRunner(
      {
        name: snapshotName,
        region: input.region,
        sizeSlug: input.sizeSlug,
        image: input.baseImageSlug,
        tags: [SNAPSHOT_OPERATION_TAG_PREFIX, operationTag],
        userData: buildSnapshotBuilderBootstrap({
          runnerImage: input.runnerImage,
          defaultAgentImage: validated.defaultAgentImage,
          hermesImage: validated.hermesImage,
        }),
      },
      input.context,
    );
    cleanup.steps.push("create_builder");

    if (!created.ok) {
      return { ok: false, reason: "builder_create_failed", cleanup };
    }

    builder = created.value;

    if (!bootFixtureMatches(input.bootResult, input)) {
      return { ok: false, reason: "boot_fixture_failed", cleanup };
    }

    if (!sanitationPassed(input.sanitationResult)) {
      return { ok: false, reason: "sanitation_failed", cleanup };
    }

    const poweredOff = await input.provider.powerOffResource(
      { providerResourceId: builder.providerResourceId },
      input.context,
    );
    cleanup.steps.push("power_off");

    if (!poweredOff.ok || poweredOff.value.status !== "completed") {
      return { ok: false, reason: "power_off_failed", cleanup };
    }

    const snapshot = await input.provider.snapshotResource(
      { providerResourceId: builder.providerResourceId, name: snapshotName },
      input.context,
    );
    cleanup.steps.push("snapshot");

    if (!snapshot.ok || snapshot.value.status !== "completed") {
      return { ok: false, reason: "snapshot_failed", cleanup };
    }

    snapshotId = snapshot.value.id;
    const availability = await input.provider.readImageAvailability(
      { imageId: snapshotId },
      input.context,
    );
    cleanup.steps.push("read_snapshot");

    if (
      !availability.ok ||
      availability.value.status !== "available" ||
      !availability.value.regions.includes(input.region) ||
      availability.value.minDiskSizeGb > SNAPSHOT_MIN_DISK_GB
    ) {
      return { ok: false, reason: "snapshot_unavailable", cleanup };
    }

    const availableAt = now().toISOString();
    const manifest: RunnerSnapshotManifest = {
      schemaVersion: "plingpling.runner.snapshot.v1",
      snapshot: {
        id: snapshotId,
        name: snapshotName,
        regions: availability.value.regions,
        minDiskSizeGb: availability.value.minDiskSizeGb,
        architecture: "amd64",
      },
      baseImage: { id: input.baseImageId, slug: input.baseImageSlug },
      runnerImage: {
        reference: input.runnerImage,
        digest: validated.runnerDigest,
      },
      defaultAgentImage: {
        reference: validated.defaultAgentImage,
        digest: validated.defaultAgentDigest,
      },
      hermesImage: {
        reference: validated.hermesImage,
        indexDigest: DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
        amd64ManifestDigest: DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
      },
      bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      source: { repository: "ametel01/plingpling", revision: input.sourceRevision },
      workflow: { runId: input.operationId, runAttempt: "1" },
      validation: {
        fullBootFixturePassedAt: input.bootResult.completedAt,
        sanitationPassedAt: input.sanitationResult.completedAt,
      },
      createdAt: input.sanitationResult.completedAt,
      availableAt,
      expiresAt: new Date(new Date(availableAt).getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const attestation = createRunnerSnapshotAttestation({
      manifest,
      privateKeyPem: input.privateKeyPem,
    });

    snapshotId = null;

    return {
      ok: true,
      manifest,
      manifestBytes: attestation.canonicalBytes,
      digest: attestation.digest,
      signature: attestation.signature,
      cleanup,
    };
  } finally {
    if (snapshotId && input.provider.deleteImage) {
      const deleted = await input.provider.deleteImage({ imageId: snapshotId }, input.context);
      cleanup.steps.push("delete_partial_snapshot");
      if (deleted.ok) cleanup.deletedSnapshotId = snapshotId;
    }

    if (builder) {
      const deleted = await input.provider.cleanupResource(
        { providerResourceId: builder.providerResourceId },
        input.context,
      );
      cleanup.steps.push("delete_builder");
      if (deleted.ok) cleanup.deletedDropletId = builder.providerResourceId;
    }
  }
}

export function buildSnapshotBuilderBootstrap(input: {
  runnerImage: string;
  defaultAgentImage: string;
  hermesImage: string;
}): string {
  return `#cloud-config
package_update: true
package_upgrade: false
packages:
  - bash
  - ca-certificates
  - curl
  - gnupg
  - caddy
runcmd:
  - |
    set -euo pipefail
    install -m 0755 -d /etc/agentbay-snapshot-builder
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    docker pull '${input.runnerImage}'
    docker pull '${input.defaultAgentImage}'
    docker pull '${input.hermesImage}'
`;
}

function validateSnapshotBuildInput(input: BuildRunnerSnapshotInput):
  | {
      ok: true;
      runnerDigest: string;
      defaultAgentImage: string;
      defaultAgentDigest: string;
      hermesImage: string;
    }
  | { ok: false; reason: "authorization_missing" | "input_invalid" } {
  if (input.costAuthorization !== SNAPSHOT_AUTHORIZATION_SENTINEL) {
    return { ok: false, reason: "authorization_missing" };
  }

  const runner = parseImmutableRunnerImageReference(input.runnerImage);
  const defaultAgentImage = input.defaultAgentImage ?? DEFAULT_MANUAL_RUNNER_IMAGE;
  const defaultAgent = parseImmutableRunnerImageReference(defaultAgentImage);
  const hermesImage = input.hermesImage ?? DEFAULT_HERMES_WORKLOAD_IMAGE;

  if (
    !runner ||
    !defaultAgent ||
    !/^[1-9][0-9]{0,18}$/.test(input.operationId) ||
    !/^[a-f0-9]{40}$/.test(input.sourceRevision) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(input.region) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(input.sizeSlug) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.baseImageId) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(input.baseImageSlug) ||
    input.hermesImage === undefined ||
    !hermesImage.includes("@sha256:")
  ) {
    return { ok: false, reason: "input_invalid" };
  }

  return {
    ok: true,
    runnerDigest: runner.imageDigest,
    defaultAgentImage,
    defaultAgentDigest: defaultAgent.imageDigest,
    hermesImage,
  };
}

function bootFixtureMatches(
  boot: SnapshotBootFixtureResult,
  input: BuildRunnerSnapshotInput,
): boolean {
  return (
    boot.ok &&
    boot.runnerImage === input.runnerImage &&
    boot.defaultAgentImage === (input.defaultAgentImage ?? DEFAULT_MANUAL_RUNNER_IMAGE) &&
    boot.hermesImage === (input.hermesImage ?? DEFAULT_HERMES_WORKLOAD_IMAGE) &&
    boot.bootContractVersion === RUNNER_BOOT_CONTRACT_VERSION
  );
}

function sanitationPassed(result: SnapshotSanitationResult): boolean {
  return result.ok && result.forbiddenPathsAbsent && result.hostileMarkersAbsent;
}
