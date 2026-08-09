import "server-only";

import { isIP } from "node:net";
import {
  createRunnerSnapshotAttestation,
  isRunnerSnapshotSigningKeyId,
  type RunnerSnapshotBundle,
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
import { findDigitalOceanRunnerResourceProfile } from "@/src/server/runners/runner-resource-profiles";
import type {
  DigitalOceanAction,
  DigitalOceanOwnedSetExpectation,
  DigitalOceanOwnedSetProvider,
  DigitalOceanProvider,
  DigitalOceanProviderResult,
  DigitalOceanProviderRequestContext,
  DigitalOceanReadSnapshotBuilderEvidenceInput,
  DigitalOceanResource,
  DigitalOceanSnapshotBuilderEvidence,
} from "@/src/server/runners/digitalocean-provider";

const SNAPSHOT_AUTHORIZATION_SENTINEL = "I_UNDERSTAND_THIS_CREATES_A_BILLABLE_SNAPSHOT_BUILDER";
const SNAPSHOT_OPERATION_TAG_PREFIX = "bruno-snapshot-build";
const SNAPSHOT_BUILDER_NAME_PREFIX = "bruno-snapshot-builder";
const SNAPSHOT_MIN_DISK_GB = 25;
const SNAPSHOT_BUILDER_EVIDENCE_POLL_ATTEMPTS = 60;
const SNAPSHOT_BUILDER_EVIDENCE_DEADLINE_MS = 20 * 60 * 1_000;
const SNAPSHOT_CLEANUP_DEADLINE_MS = 2 * 60 * 1_000;

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
  controllerSshSourceCidr: string;
  builderSshKeyId?: string;
  builderSshPrivateKeyPath?: string;
  expectedBuilderHostKeySha256?: string;
  privateKeyPem: string;
  signingKeyId: string;
  provider: DigitalOceanProvider;
  context: DigitalOceanProviderRequestContext;
  now?: () => Date;
  actionPollAttempts?: number;
  actionPollIntervalMs?: number;
  builderEvidencePollIntervalMs?: number;
};

export type SnapshotBootFixtureResult = {
  ok: boolean;
  builderResourceId?: string;
  runnerImage: string;
  defaultAgentImage: string;
  hermesImage: string;
  bootContractVersion: string;
  preloadedImages?: string[];
  components?: Record<string, string>;
  completedAt: string;
};

export type SnapshotSanitationResult = {
  ok: boolean;
  builderResourceId?: string;
  forbiddenPathsAbsent: boolean;
  hostileMarkersAbsent: boolean;
  removedPaths?: string[];
  scannedPaths?: string[];
  hostileMarkers?: string[];
  completedAt: string;
};

export type BuildRunnerSnapshotResult =
  | {
      ok: true;
      manifest: RunnerSnapshotManifest;
      bundle: RunnerSnapshotBundle;
      bundleBytes: string;
      digest: string;
      bootResult: SnapshotBootFixtureResult;
      sanitationResult: SnapshotSanitationResult;
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
  | "snapshot_unavailable"
  | "cleanup_failed";

export type SnapshotCleanupEvidence = {
  deletedSnapshotId: string | null;
  snapshotAbsenceVerified: boolean;
  deletedDropletId: string | null;
  deletedFirewallId: string | null;
  deletedSshKeyId: string | null;
  sshKeyAbsenceVerified: boolean;
  sshKeyDeletionFailed: boolean;
  ambiguousOwnership: boolean;
  absenceVerified: boolean;
  steps: string[];
};

export async function buildRunnerSnapshot(
  input: BuildRunnerSnapshotInput,
): Promise<BuildRunnerSnapshotResult> {
  const result = await buildRunnerSnapshotCandidate(input);
  if (input.builderSshKeyId && !result.cleanup.sshKeyAbsenceVerified) {
    const cleanupController = new AbortController();
    const cleanupTimeout = setTimeout(
      () => cleanupController.abort(),
      SNAPSHOT_CLEANUP_DEADLINE_MS,
    );
    try {
      await deleteSshKeyAndVerifyAbsence({
        provider: input.provider,
        sshKeyId: input.builderSshKeyId,
        cleanup: result.cleanup,
        context: { signal: cleanupController.signal },
      });
    } finally {
      clearTimeout(cleanupTimeout);
    }
  }

  if (terminalCleanupPassed(result.cleanup, input.builderSshKeyId)) return result;

  const cleanupController = new AbortController();
  const cleanupTimeout = setTimeout(() => cleanupController.abort(), SNAPSHOT_CLEANUP_DEADLINE_MS);
  try {
    if (result.ok) {
      result.cleanup.snapshotAbsenceVerified = false;
      await deleteImageAndVerifyAbsence({
        provider: input.provider,
        imageId: result.manifest.snapshot.id,
        cleanup: result.cleanup,
        context: { signal: cleanupController.signal },
      });
    }
  } finally {
    clearTimeout(cleanupTimeout);
  }

  return { ok: false, reason: "cleanup_failed", cleanup: result.cleanup };
}

async function buildRunnerSnapshotCandidate(
  input: BuildRunnerSnapshotInput,
): Promise<BuildRunnerSnapshotResult> {
  const cleanup: SnapshotCleanupEvidence = {
    deletedSnapshotId: null,
    snapshotAbsenceVerified: true,
    deletedDropletId: null,
    deletedFirewallId: null,
    deletedSshKeyId: null,
    sshKeyAbsenceVerified: !input.builderSshKeyId,
    sshKeyDeletionFailed: false,
    ambiguousOwnership: false,
    absenceVerified: false,
    steps: [],
  };
  const now = input.now ?? (() => new Date());
  let builder: DigitalOceanResource | null = null;
  let snapshotId: string | null = null;
  let snapshotAction: DigitalOceanAction | null = null;

  const validated = validateSnapshotBuildInput(input);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason, cleanup };
  }

  if (
    !input.provider.powerOffResource ||
    !input.provider.snapshotResource ||
    !input.provider.readAction ||
    !input.provider.readImageAvailability ||
    !input.provider.findSnapshotImageByName ||
    !input.provider.observeSnapshotImageByName ||
    !input.provider.readSnapshotBuilderEvidence ||
    !input.provider.deleteImage ||
    !input.provider.verifyImageAbsent ||
    (input.builderSshKeyId && (!input.provider.deleteSshKey || !input.provider.verifySshKeyAbsent))
  ) {
    return { ok: false, reason: "provider_contract_missing", cleanup };
  }

  const ownedSetProvider = asOwnedSetProvider(input.provider);

  if (!ownedSetProvider) {
    return { ok: false, reason: "provider_contract_missing", cleanup };
  }

  const operationTag = `${SNAPSHOT_OPERATION_TAG_PREFIX}-${input.operationId}`;
  const snapshotName = `${SNAPSHOT_BUILDER_NAME_PREFIX}-${input.sourceRevision.slice(0, 12)}-${input.operationId}`;

  try {
    const firewallName = `${snapshotName}-firewall`;
    const created = await input.provider.createRunner(
      {
        name: snapshotName,
        region: input.region,
        sizeSlug: input.sizeSlug,
        image: input.baseImageSlug,
        tags: [SNAPSHOT_OPERATION_TAG_PREFIX, operationTag],
        firewallName,
        ...(input.builderSshKeyId ? { sshKeyIds: [input.builderSshKeyId] } : {}),
        userData: buildSnapshotBuilderBootstrap({
          runnerImage: input.runnerImage,
          runnerVersion: validated.runnerVersion,
          runnerDigest: validated.runnerDigest,
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

    const firewalled = await input.provider.applyFirewall(
      {
        providerResourceId: builder.providerResourceId,
        firewallName,
        sshSourceAddresses: [input.controllerSshSourceCidr],
        webSourceAddresses: [],
      },
      input.context,
    );
    cleanup.steps.push("create_firewall");

    if (!firewalled.ok) {
      return { ok: false, reason: "builder_create_failed", cleanup };
    }

    builder = firewalled.value;

    const evidence = await pollSnapshotBuilderEvidence({
      readEvidence: input.provider.readSnapshotBuilderEvidence.bind(input.provider),
      evidenceInput: {
        providerResourceId: builder.providerResourceId,
        ...(input.builderSshPrivateKeyPath
          ? { privateKeyPath: input.builderSshPrivateKeyPath }
          : {}),
        ...(input.expectedBuilderHostKeySha256
          ? { expectedHostKeySha256: input.expectedBuilderHostKeySha256 }
          : {}),
      },
      context: input.context,
      ...(input.builderEvidencePollIntervalMs === undefined
        ? {}
        : { intervalMs: input.builderEvidencePollIntervalMs }),
    });
    cleanup.steps.push("read_builder_evidence");

    if (!evidence.ok) {
      return { ok: false, reason: "boot_fixture_failed", cleanup };
    }

    const bootResult = evidence.value.bootResult as SnapshotBootFixtureResult;
    const sanitationResult = evidence.value.sanitationResult as SnapshotSanitationResult;

    if (!bootFixtureMatches(bootResult, input, builder.providerResourceId)) {
      return { ok: false, reason: "boot_fixture_failed", cleanup };
    }

    if (!sanitationPassed(sanitationResult, builder.providerResourceId)) {
      return { ok: false, reason: "sanitation_failed", cleanup };
    }

    const powerOffAction = await input.provider.powerOffResource(
      { providerResourceId: builder.providerResourceId },
      input.context,
    );
    cleanup.steps.push("power_off");

    if (!powerOffAction.ok) {
      return { ok: false, reason: "power_off_failed", cleanup };
    }

    const poweredOff = await pollDigitalOceanAction({
      provider: input.provider,
      action: powerOffAction.value,
      context: input.context,
      ...(input.actionPollAttempts === undefined ? {} : { attempts: input.actionPollAttempts }),
      ...(input.actionPollIntervalMs === undefined
        ? {}
        : { intervalMs: input.actionPollIntervalMs }),
    });
    cleanup.steps.push("poll_power_off");

    if (!poweredOff.ok || poweredOff.action.status !== "completed") {
      return { ok: false, reason: "power_off_failed", cleanup };
    }

    cleanup.snapshotAbsenceVerified = false;
    const createdSnapshotAction = await input.provider.snapshotResource(
      { providerResourceId: builder.providerResourceId, name: snapshotName },
      input.context,
    );
    cleanup.steps.push("snapshot");

    if (!createdSnapshotAction.ok) {
      return { ok: false, reason: "snapshot_failed", cleanup };
    }
    snapshotAction = createdSnapshotAction.value;

    const snapshot = await pollDigitalOceanAction({
      provider: input.provider,
      action: snapshotAction,
      context: input.context,
      ...(input.actionPollAttempts === undefined ? {} : { attempts: input.actionPollAttempts }),
      ...(input.actionPollIntervalMs === undefined
        ? {}
        : { intervalMs: input.actionPollIntervalMs }),
    });
    cleanup.steps.push("poll_snapshot");

    if (!snapshot.ok || snapshot.action.status !== "completed") {
      return { ok: false, reason: "snapshot_failed", cleanup };
    }

    const foundImage = await input.provider.findSnapshotImageByName(
      { name: snapshotName },
      input.context,
    );
    cleanup.steps.push("find_snapshot_image");

    if (!foundImage.ok || foundImage.value.id === snapshot.action.id) {
      return { ok: false, reason: "snapshot_unavailable", cleanup };
    }

    snapshotId = foundImage.value.id;
    const availability = await input.provider.readImageAvailability(
      { imageId: snapshotId },
      input.context,
    );
    cleanup.steps.push("read_snapshot");

    if (
      !availability.ok ||
      availability.value.status !== "available" ||
      availability.value.id !== foundImage.value.id ||
      availability.value.name !== snapshotName ||
      !availability.value.regions.includes(input.region) ||
      availability.value.minDiskSizeGb > SNAPSHOT_MIN_DISK_GB
    ) {
      return { ok: false, reason: "snapshot_unavailable", cleanup };
    }

    const availableAt = now().toISOString();
    const manifest: RunnerSnapshotManifest = {
      schemaVersion: "bruno.runner.snapshot.v2",
      runner: {
        region: input.region,
        sizeSlug: input.sizeSlug,
        diskSizeGb: validated.runnerDiskGiB,
        architecture: "amd64",
      },
      snapshot: {
        provider: "digitalocean",
        id: snapshotId,
        name: snapshotName,
        status: "available",
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
      source: { repository: "ametel01/bruno", revision: input.sourceRevision },
      workflow: { runId: input.operationId, runAttempt: "1" },
      validation: {
        fullBootFixturePassedAt: bootResult.completedAt,
        sanitationPassedAt: sanitationResult.completedAt,
      },
      createdAt: sanitationResult.completedAt,
      availableAt,
    };
    const attestation = createRunnerSnapshotAttestation({
      manifest,
      signingKeyId: input.signingKeyId,
      privateKeyPem: input.privateKeyPem,
    });

    cleanup.snapshotAbsenceVerified = true;
    snapshotId = null;

    return {
      ok: true,
      manifest,
      bundle: attestation.bundle,
      bundleBytes: attestation.bundleBytes,
      digest: attestation.digest,
      bootResult,
      sanitationResult,
      cleanup,
    };
  } catch {
    return { ok: false, reason: "cleanup_failed", cleanup };
  } finally {
    cleanup.steps.push("revoke_ephemeral_registration_token");
    cleanup.steps.push("revoke_ephemeral_registry_credential");
    const builderSshKeyId = input.builderSshKeyId;
    if (builderSshKeyId && input.provider.deleteSshKey) {
      await runWithSnapshotCleanupContext(async (cleanupContext) => {
        await deleteSshKeyAndVerifyAbsence({
          provider: input.provider,
          sshKeyId: builderSshKeyId,
          cleanup,
          context: cleanupContext,
        });
      });
    } else if (builderSshKeyId) {
      cleanup.sshKeyDeletionFailed = true;
      cleanup.steps.push("delete_ephemeral_ssh_key");
    } else {
      cleanup.steps.push("delete_ephemeral_ssh_key");
    }

    const builderToCleanup = builder;
    if (builderToCleanup) {
      await runWithSnapshotCleanupContext(async (cleanupContext) => {
        try {
          await cleanupOwnedBuilder({
            provider: input.provider,
            builder: builderToCleanup,
            operationTag,
            cleanup,
            context: cleanupContext,
          });
        } catch {
          cleanup.ambiguousOwnership = true;
          cleanup.steps.push("owned_builder_cleanup_failed");
        }
      });
    }

    await runWithSnapshotCleanupContext(async (cleanupContext) => {
      if (snapshotId) {
        cleanup.snapshotAbsenceVerified = false;
        await deleteImageAndVerifyAbsence({
          provider: input.provider,
          imageId: snapshotId,
          cleanup,
          context: cleanupContext,
        });
      } else if (!cleanup.snapshotAbsenceVerified) {
        await reconcilePartialSnapshot({
          provider: input.provider,
          snapshotAction,
          snapshotName,
          cleanup,
          context: cleanupContext,
          intervalMs: input.actionPollIntervalMs ?? 5_000,
        });
      }
    });
  }
}

async function runWithSnapshotCleanupContext(
  operation: (context: DigitalOceanProviderRequestContext) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SNAPSHOT_CLEANUP_DEADLINE_MS);
  try {
    await operation({ signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function terminalCleanupPassed(
  cleanup: SnapshotCleanupEvidence,
  builderSshKeyId: string | undefined,
): boolean {
  const builderWasAttempted = cleanup.steps.includes("create_builder");
  return (
    (!builderWasAttempted || (cleanup.absenceVerified && !cleanup.ambiguousOwnership)) &&
    cleanup.snapshotAbsenceVerified &&
    !cleanup.sshKeyDeletionFailed &&
    (!builderSshKeyId ||
      (cleanup.deletedSshKeyId === builderSshKeyId && cleanup.sshKeyAbsenceVerified))
  );
}

async function deleteSshKeyAndVerifyAbsence(input: {
  provider: DigitalOceanProvider;
  sshKeyId: string;
  cleanup: SnapshotCleanupEvidence;
  context: DigitalOceanProviderRequestContext;
}): Promise<void> {
  input.cleanup.steps.push("delete_ephemeral_ssh_key");
  try {
    const deleted = await input.provider.deleteSshKey?.({ id: input.sshKeyId }, input.context);
    if (!deleted?.ok) {
      input.cleanup.sshKeyDeletionFailed = true;
      return;
    }

    const observed = await input.provider.verifySshKeyAbsent?.(
      { id: input.sshKeyId },
      input.context,
    );
    input.cleanup.steps.push("verify_ephemeral_ssh_key_absence");
    if (observed?.ok) {
      input.cleanup.deletedSshKeyId = input.sshKeyId;
      input.cleanup.sshKeyAbsenceVerified = true;
      return;
    }
  } catch {
    input.cleanup.steps.push("ephemeral_ssh_key_cleanup_failed");
  }

  input.cleanup.sshKeyDeletionFailed = true;
}

async function deleteImageAndVerifyAbsence(input: {
  provider: DigitalOceanProvider;
  imageId: string;
  cleanup: SnapshotCleanupEvidence;
  context: DigitalOceanProviderRequestContext;
}): Promise<void> {
  input.cleanup.steps.push("delete_partial_snapshot");
  try {
    const deleted = await input.provider.deleteImage?.({ imageId: input.imageId }, input.context);
    if (!deleted?.ok) return;

    const verified = await input.provider.verifyImageAbsent?.(
      { imageId: input.imageId },
      input.context,
    );
    input.cleanup.steps.push("verify_partial_snapshot_absence");
    if (!verified?.ok) return;

    input.cleanup.deletedSnapshotId = input.imageId;
    input.cleanup.snapshotAbsenceVerified = true;
  } catch {
    input.cleanup.steps.push("partial_snapshot_deletion_failed");
  }
}

async function reconcilePartialSnapshot(input: {
  provider: DigitalOceanProvider;
  snapshotAction: DigitalOceanAction | null;
  snapshotName: string;
  cleanup: SnapshotCleanupEvidence;
  context: DigitalOceanProviderRequestContext;
  intervalMs: number;
}): Promise<void> {
  let action = input.snapshotAction;
  input.cleanup.steps.push("reconcile_partial_snapshot_action");

  try {
    for (let attempt = 0; attempt < 24 && !input.context.signal.aborted; attempt += 1) {
      if (action && action.status === "in-progress" && input.provider.readAction) {
        const read = await input.provider.readAction({ actionId: action.id }, input.context);
        if (read.ok) action = read.value;
      }

      const observed = await input.provider.observeSnapshotImageByName?.(
        { name: input.snapshotName },
        input.context,
      );
      input.cleanup.steps.push("observe_partial_snapshot");
      if (observed?.ok && observed.value.state === "present") {
        await deleteImageAndVerifyAbsence({
          provider: input.provider,
          imageId: observed.value.image.id,
          cleanup: input.cleanup,
          context: input.context,
        });
        return;
      }
      if (observed?.ok && observed.value.state === "absent" && action?.status === "errored") {
        input.cleanup.snapshotAbsenceVerified = true;
        return;
      }

      if (attempt < 23 && input.intervalMs > 0) {
        await sleep(input.intervalMs, input.context.signal);
      }
    }
  } catch {
    input.cleanup.steps.push("partial_snapshot_reconciliation_failed");
  }
}

async function cleanupOwnedBuilder(input: {
  provider: DigitalOceanProvider;
  builder: DigitalOceanResource;
  operationTag: string;
  cleanup: SnapshotCleanupEvidence;
  context: DigitalOceanProviderRequestContext;
}): Promise<void> {
  const ownedSetProvider = asOwnedSetProvider(input.provider);
  const firewallId = input.builder.providerFirewallId;

  if (!ownedSetProvider || !firewallId) {
    input.cleanup.ambiguousOwnership = true;
    input.cleanup.steps.push("owned_cleanup_unavailable");
    return;
  }

  const expectation: DigitalOceanOwnedSetExpectation = {
    operationTag: input.operationTag,
    providerResourceId: input.builder.providerResourceId,
    providerFirewallId: firewallId,
    expectedName: input.builder.name,
    expectedRegion: input.builder.region,
    expectedSizeSlug: input.builder.sizeSlug,
    expectedFirewallName: `${input.builder.name}-firewall`,
  };

  const observed = await ownedSetProvider.observeOwnedSet(expectation, input.context);
  input.cleanup.steps.push("observe_owned_builder");
  if (!observed.ok) {
    input.cleanup.ambiguousOwnership = true;
    input.cleanup.steps.push("owned_builder_ambiguous");
    return;
  }

  const firewall = await ownedSetProvider.deleteFirewall(expectation, input.context);
  input.cleanup.steps.push("delete_firewall");
  if (!firewall.ok) {
    input.cleanup.ambiguousOwnership = true;
    return;
  }
  input.cleanup.deletedFirewallId = firewallId;

  const droplet = await ownedSetProvider.deleteDroplet(expectation, input.context);
  input.cleanup.steps.push("delete_builder");
  if (!droplet.ok) {
    input.cleanup.ambiguousOwnership = true;
    return;
  }
  input.cleanup.deletedDropletId = input.builder.providerResourceId;

  const verified = await ownedSetProvider.observeOwnedSet(expectation, input.context);
  input.cleanup.steps.push("verify_absence");
  if (verified.ok && verified.value.state === "absent") {
    input.cleanup.absenceVerified = true;
  } else {
    input.cleanup.ambiguousOwnership = true;
  }
}

async function pollDigitalOceanAction(input: {
  provider: DigitalOceanProvider;
  action: DigitalOceanAction;
  context: DigitalOceanProviderRequestContext;
  attempts?: number;
  intervalMs?: number;
}): Promise<{ ok: true; action: DigitalOceanAction } | { ok: false }> {
  const attempts = input.attempts ?? 30;
  const intervalMs = input.intervalMs ?? 20_000;
  let action = input.action;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (action.status === "errored") return { ok: true, action };
    if (input.context.signal.aborted) return { ok: false };
    if (!input.provider.readAction) return { ok: false };
    const read = await input.provider.readAction({ actionId: action.id }, input.context);
    if (!read.ok) return { ok: false };
    action = read.value;
    if (action.status === "completed") return { ok: true, action };
    if (action.status === "errored") return { ok: true, action };
    if (attempt < attempts - 1 && intervalMs > 0) {
      await sleep(intervalMs, input.context.signal);
    }
  }

  return { ok: false };
}

async function pollSnapshotBuilderEvidence(input: {
  readEvidence: (
    input: DigitalOceanReadSnapshotBuilderEvidenceInput,
    context?: DigitalOceanProviderRequestContext,
  ) => Promise<DigitalOceanProviderResult<DigitalOceanSnapshotBuilderEvidence>>;
  evidenceInput: DigitalOceanReadSnapshotBuilderEvidenceInput;
  context: DigitalOceanProviderRequestContext;
  intervalMs?: number;
}): Promise<DigitalOceanProviderResult<DigitalOceanSnapshotBuilderEvidence>> {
  const intervalMs = input.intervalMs ?? 5_000;
  const deadlineAt = Date.now() + SNAPSHOT_BUILDER_EVIDENCE_DEADLINE_MS;
  let lastEvidence: DigitalOceanProviderResult<DigitalOceanSnapshotBuilderEvidence> = {
    ok: false,
    reason: "builder_evidence_not_ready",
    message: "Snapshot builder evidence polling did not start.",
  };

  for (let attempt = 0; attempt < SNAPSHOT_BUILDER_EVIDENCE_POLL_ATTEMPTS; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0 || input.context.signal.aborted) return lastEvidence;

    const evidence = await readSnapshotBuilderEvidenceBeforeDeadline({
      readEvidence: input.readEvidence,
      evidenceInput: input.evidenceInput,
      context: input.context,
      timeoutMs: remainingMs,
    });
    lastEvidence = evidence;
    if (evidence.ok || evidence.reason !== "builder_evidence_not_ready") return evidence;
    if (input.context.signal.aborted || attempt === SNAPSHOT_BUILDER_EVIDENCE_POLL_ATTEMPTS - 1) {
      return evidence;
    }

    const remainingAfterReadMs = deadlineAt - Date.now();
    if (remainingAfterReadMs <= 0) return evidence;
    if (intervalMs > 0) {
      try {
        await sleep(Math.min(intervalMs, remainingAfterReadMs), input.context.signal);
      } catch {
        return evidence;
      }
    }
  }

  return lastEvidence;
}

async function readSnapshotBuilderEvidenceBeforeDeadline(input: {
  readEvidence: (
    input: DigitalOceanReadSnapshotBuilderEvidenceInput,
    context?: DigitalOceanProviderRequestContext,
  ) => Promise<DigitalOceanProviderResult<DigitalOceanSnapshotBuilderEvidence>>;
  evidenceInput: DigitalOceanReadSnapshotBuilderEvidenceInput;
  context: DigitalOceanProviderRequestContext;
  timeoutMs: number;
}): Promise<DigitalOceanProviderResult<DigitalOceanSnapshotBuilderEvidence>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, input.timeoutMs);
  input.context.signal.addEventListener("abort", abort, { once: true });

  try {
    return await input.readEvidence(input.evidenceInput, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    input.context.signal.removeEventListener("abort", abort);
  }
}

function asOwnedSetProvider(provider: DigitalOceanProvider): DigitalOceanOwnedSetProvider | null {
  const candidate = provider as Partial<DigitalOceanOwnedSetProvider>;

  return candidate.observeOwnedSet && candidate.deleteFirewall && candidate.deleteDroplet
    ? {
        observeOwnedSet: candidate.observeOwnedSet.bind(provider),
        deleteFirewall: candidate.deleteFirewall.bind(provider),
        deleteDroplet: candidate.deleteDroplet.bind(provider),
      }
    : null;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("DigitalOcean action polling aborted."));
      },
      { once: true },
    );
  });
}

export function buildSnapshotBuilderBootstrap(input: {
  runnerImage: string;
  runnerVersion: string;
  runnerDigest: string;
  defaultAgentImage: string;
  hermesImage: string;
}): string {
  const runnerImageShell = shellSingleQuote(input.runnerImage);
  const defaultAgentImageShell = shellSingleQuote(input.defaultAgentImage);
  const hermesImageShell = shellSingleQuote(input.hermesImage);
  const runnerImageJson = JSON.stringify(input.runnerImage);
  const defaultAgentImageJson = JSON.stringify(input.defaultAgentImage);
  const hermesImageJson = JSON.stringify(input.hermesImage);
  const runnerVersionShell = shellSingleQuote(input.runnerVersion);
  const runnerDigestShell = shellSingleQuote(input.runnerDigest);
  const runnerFixtureSource = shellSingleQuote(
    [
      'import { createRunnerBootReadinessController } from "./src/runner-service/boot-self-test.ts";',
      "const controller = createRunnerBootReadinessController();",
      "await controller.start();",
      "const result = await controller.read();",
      "process.stdout.write(JSON.stringify(result));",
      'if (result.status !== "ready") process.exit(1);',
    ].join(" "),
  );

  return `#cloud-config
package_update: true
package_upgrade: false
packages:
  - bash
  - ca-certificates
  - curl
  - gnupg
runcmd:
  - |
    set -euo pipefail
    install -m 0755 -d /etc/apt/keyrings /etc/bruno-snapshot-builder /run/bruno-snapshot-builder
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    . /etc/os-release
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin caddy
    systemctl enable --now docker
    systemctl enable --now caddy
    docker pull ${runnerImageShell}
    docker pull ${defaultAgentImageShell}
    docker pull ${hermesImageShell}
    docker image inspect ${runnerImageShell} ${defaultAgentImageShell} ${hermesImageShell} >/dev/null
    install -m 0700 -d /var/lib/bruno/boot-self-test
    docker rm --force bruno-snapshot-runner-fixture >/dev/null 2>&1 || true
    docker run --rm \
      --name bruno-snapshot-runner-fixture \
      --platform linux/amd64 \
      --env BRUNO_RUNNER_CONTAINER_ID=bruno-snapshot-runner-fixture \
      --env BRUNO_RUNNER_EXPECTED_RELEASE_VERSION=${runnerVersionShell} \
      --env BRUNO_RUNNER_EXPECTED_IMAGE_DIGEST=${runnerDigestShell} \
      --env BRUNO_RUNNER_EXPECTED_BOOT_CONTRACT_VERSION=${RUNNER_BOOT_CONTRACT_VERSION} \
      --env BRUNO_RUNNER_BOOT_MODEL_CANARY_ENABLED=true \
      --volume /var/run/docker.sock:/var/run/docker.sock \
      --volume /var/lib/bruno/boot-self-test:/var/lib/bruno/boot-self-test \
      --entrypoint bun \
      ${runnerImageShell} \
      --conditions react-server -e ${runnerFixtureSource} \
      > /run/bruno-snapshot-builder/runner-boot-self-test.json
    BRUNO_BUILDER_RESOURCE_ID="$(curl -fsS http://169.254.169.254/metadata/v1/id)"
    export BRUNO_BUILDER_RESOURCE_ID
    printf '%s\\n' "$BRUNO_BUILDER_RESOURCE_ID" > /run/bruno-snapshot-builder/builder-resource-id
    python3 - <<'BRUNO_BOOT_RESULT_PY'
    import datetime
    import json
    import os

    with open("/run/bruno-snapshot-builder/runner-boot-self-test.json", encoding="utf-8") as source:
        fixture = json.load(source)
    required_components = {
        "docker",
        "hermesFixture",
        "detailedHealth",
        "modelCanary",
        "telegramConfig",
        "cleanup",
    }
    if fixture["status"] != "ready" or any(
        fixture["components"].get(component) != "passed" for component in required_components
    ):
        raise SystemExit("runner boot fixture did not pass")
    result = {
        "ok": True,
        "builderResourceId": os.environ["BRUNO_BUILDER_RESOURCE_ID"],
        "runnerImage": ${runnerImageJson},
        "defaultAgentImage": ${defaultAgentImageJson},
        "hermesImage": ${hermesImageJson},
        "bootContractVersion": "${RUNNER_BOOT_CONTRACT_VERSION}",
        "preloadedImages": [${runnerImageJson}, ${defaultAgentImageJson}, ${hermesImageJson}],
        "components": fixture["components"],
        "completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    with open("/run/bruno-snapshot-builder/boot-result.json", "w", encoding="utf-8") as output:
        json.dump(result, output, separators=(",", ":"), sort_keys=True)
        output.write("\\n")
    BRUNO_BOOT_RESULT_PY
    docker ps -aq | xargs --no-run-if-empty docker rm --force
    docker network ls --format '{{.Name}}' | grep '^bruno' | xargs --no-run-if-empty docker network rm
    rm -rf \
      /etc/bruno/runner.env \
      /root/.docker/config.json \
      /var/lib/bruno/agents \
      /var/lib/bruno/boot-self-test \
      /var/lib/cloud/instances \
      /etc/ssh/ssh_host_* \
      /tmp/bruno-* \
      /var/tmp/bruno-* \
      /var/log/cloud-init.log \
      /var/log/cloud-init-output.log
    truncate -s 0 /root/.bash_history || true
    journalctl --rotate || true
    journalctl --vacuum-time=1s || true
    rm -f /etc/machine-id /var/lib/dbus/machine-id
    touch /etc/machine-id
    FORBIDDEN_PATHS=(
      /etc/bruno/runner.env
      /root/.docker/config.json
      /var/lib/cloud/instances
      /etc/ssh/ssh_host_ed25519_key
      /etc/machine-id
      /var/log/cloud-init-output.log
    )
    for path in "\${FORBIDDEN_PATHS[@]}"; do
      if [ -e "$path" ] && [ "$path" != "/etc/machine-id" ]; then
        echo "forbidden path remains: $path" >&2
        exit 1
      fi
    done
    HOSTILE_MARKERS=(
      BRUNO_RUNNER_REGISTRATION_TOKEN
      BRUNO_RUNNER_BEARER_TOKEN
      dop_v1_
      "BEGIN OPENSSH PRIVATE KEY"
    )
    for marker in "\${HOSTILE_MARKERS[@]}"; do
      if grep -R -I -F -- "$marker" /etc /root /var/lib/bruno /var/log >/dev/null 2>&1; then
        echo "hostile marker remains" >&2
        exit 1
      fi
    done
    cat > /usr/local/sbin/bruno-finalize-snapshot-sanitation <<'BRUNO_SANITATION_FINALIZER'
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf /var/lib/cloud /root/.ssh/authorized_keys /root/.ssh/authorized_keys2
    test ! -e /var/lib/cloud
    test ! -e /root/.ssh/authorized_keys
    test ! -e /root/.ssh/authorized_keys2
    test ! -s /etc/machine-id
    for marker in BRUNO_RUNNER_REGISTRATION_TOKEN BRUNO_RUNNER_BEARER_TOKEN dop_v1_ "BEGIN OPENSSH PRIVATE KEY"; do
      if grep -R -I -F -- "$marker" /etc /root /var/lib/bruno /var/log >/dev/null 2>&1; then
        echo "hostile marker remains" >&2
        exit 1
      fi
    done
    BRUNO_BUILDER_RESOURCE_ID="$(cat /run/bruno-snapshot-builder/builder-resource-id)"
    rm -f /run/bruno-snapshot-builder/builder-resource-id /usr/local/sbin/bruno-finalize-snapshot-sanitation
    export BRUNO_BUILDER_RESOURCE_ID
    python3 - <<'BRUNO_SANITATION_RESULT_PY'
    import datetime
    import json
    import os

    result = {
        "ok": True,
        "builderResourceId": os.environ["BRUNO_BUILDER_RESOURCE_ID"],
        "forbiddenPathsAbsent": True,
        "hostileMarkersAbsent": True,
        "removedPaths": ["/etc/bruno/runner.env", "/root/.docker/config.json", "/var/lib/cloud", "/root/.ssh/authorized_keys", "/root/.ssh/authorized_keys2", "/etc/ssh/ssh_host_ed25519_key", "/etc/machine-id", "/var/log/cloud-init-output.log", "/usr/local/sbin/bruno-finalize-snapshot-sanitation"],
        "scannedPaths": ["/etc", "/root", "/var/lib/bruno", "/var/log"],
        "hostileMarkers": ["BRUNO_RUNNER_REGISTRATION_TOKEN", "BRUNO_RUNNER_BEARER_TOKEN", "dop_v1_", "BEGIN OPENSSH PRIVATE KEY"],
        "completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    with open("/run/bruno-snapshot-builder/sanitation-result.json", "w", encoding="utf-8") as output:
        json.dump(result, output, separators=(",", ":"), sort_keys=True)
        output.write("\\n")
    BRUNO_SANITATION_RESULT_PY
    BRUNO_SANITATION_FINALIZER
    chmod 0700 /usr/local/sbin/bruno-finalize-snapshot-sanitation
`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function validateSnapshotBuildInput(input: BuildRunnerSnapshotInput):
  | {
      ok: true;
      runnerDigest: string;
      runnerVersion: string;
      defaultAgentImage: string;
      defaultAgentDigest: string;
      hermesImage: string;
      runnerDiskGiB: number;
    }
  | { ok: false; reason: "authorization_missing" | "input_invalid" } {
  if (input.costAuthorization !== SNAPSHOT_AUTHORIZATION_SENTINEL) {
    return { ok: false, reason: "authorization_missing" };
  }

  const runner = parseImmutableRunnerImageReference(input.runnerImage);
  const defaultAgentImage = input.defaultAgentImage ?? DEFAULT_MANUAL_RUNNER_IMAGE;
  const defaultAgent = parseImmutableRunnerImageReference(defaultAgentImage);
  const hermesImage = input.hermesImage ?? DEFAULT_HERMES_WORKLOAD_IMAGE;
  const runnerProfile = findDigitalOceanRunnerResourceProfile(input.sizeSlug);

  if (
    !runner ||
    !defaultAgent ||
    !runnerProfile ||
    !/^[1-9][0-9]{0,18}$/.test(input.operationId) ||
    !/^[a-f0-9]{40}$/.test(input.sourceRevision) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(input.region) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(input.sizeSlug) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.baseImageId) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(input.baseImageSlug) ||
    !isExplicitControllerCidr(input.controllerSshSourceCidr) ||
    (input.expectedBuilderHostKeySha256 !== undefined &&
      !isSha256SshFingerprint(input.expectedBuilderHostKeySha256)) ||
    input.hermesImage === undefined ||
    hermesImage !== DEFAULT_HERMES_WORKLOAD_IMAGE ||
    !isRunnerSnapshotSigningKeyId(input.signingKeyId)
  ) {
    return { ok: false, reason: "input_invalid" };
  }

  return {
    ok: true,
    runnerDigest: runner.imageDigest,
    runnerVersion: runner.version,
    defaultAgentImage,
    defaultAgentDigest: defaultAgent.imageDigest,
    hermesImage,
    runnerDiskGiB: runnerProfile.diskGiB,
  };
}

function bootFixtureMatches(
  boot: SnapshotBootFixtureResult,
  input: BuildRunnerSnapshotInput,
  builderResourceId: string,
): boolean {
  const expectedPreloads = [
    input.runnerImage,
    input.defaultAgentImage ?? DEFAULT_MANUAL_RUNNER_IMAGE,
    input.hermesImage ?? DEFAULT_HERMES_WORKLOAD_IMAGE,
  ].sort();
  const requiredComponents = [
    "docker",
    "hermesFixture",
    "detailedHealth",
    "modelCanary",
    "telegramConfig",
    "cleanup",
  ];

  return (
    boot.ok &&
    boot.builderResourceId === builderResourceId &&
    boot.runnerImage === input.runnerImage &&
    boot.defaultAgentImage === (input.defaultAgentImage ?? DEFAULT_MANUAL_RUNNER_IMAGE) &&
    boot.hermesImage === (input.hermesImage ?? DEFAULT_HERMES_WORKLOAD_IMAGE) &&
    boot.bootContractVersion === RUNNER_BOOT_CONTRACT_VERSION &&
    requiredComponents.every((component) => boot.components?.[component] === "passed") &&
    Array.isArray(boot.preloadedImages) &&
    [...boot.preloadedImages].sort().join("\n") === expectedPreloads.join("\n")
  );
}

function sanitationPassed(result: SnapshotSanitationResult, builderResourceId: string): boolean {
  const requiredRemovedPaths = [
    "/etc/bruno/runner.env",
    "/root/.docker/config.json",
    "/var/lib/cloud",
    "/root/.ssh/authorized_keys",
    "/root/.ssh/authorized_keys2",
    "/etc/ssh/ssh_host_ed25519_key",
    "/etc/machine-id",
    "/var/log/cloud-init-output.log",
  ];
  const requiredScannedPaths = ["/etc", "/root", "/var/lib/bruno", "/var/log"];
  const requiredHostileMarkers = [
    "BRUNO_RUNNER_REGISTRATION_TOKEN",
    "BRUNO_RUNNER_BEARER_TOKEN",
    "dop_v1_",
    "BEGIN OPENSSH PRIVATE KEY",
  ];

  return (
    result.ok &&
    result.builderResourceId === builderResourceId &&
    result.forbiddenPathsAbsent &&
    result.hostileMarkersAbsent &&
    containsAll(result.removedPaths, requiredRemovedPaths) &&
    containsAll(result.scannedPaths, requiredScannedPaths) &&
    containsAll(result.hostileMarkers, requiredHostileMarkers)
  );
}

function containsAll(values: string[] | undefined, required: string[]): boolean {
  return required.every((value) => values?.includes(value));
}

function isExplicitControllerCidr(value: string): boolean {
  const [address, prefix, extra] = value.trim().split("/");

  if (!address || !prefix || extra !== undefined) {
    return false;
  }

  if (value === "0.0.0.0/0" || value === "::/0" || address === "0.0.0.0" || address === "::") {
    return false;
  }

  return (prefix === "32" && isIP(address) === 4) || (prefix === "128" && isIP(address) === 6);
}

function isSha256SshFingerprint(value: string): boolean {
  return /^SHA256:[A-Za-z0-9+/]{43}$/.test(value.trim());
}
