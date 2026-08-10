import "server-only";

import { isIP } from "node:net";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
  DEFAULT_MANUAL_RUNNER_IMAGE,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import { parseImmutableRunnerImageReference } from "@/src/runner-service/release-identity";
import type {
  RunnerBootFailureReason,
  RunnerBootSnapshotStatus,
} from "@/src/runner-service/runner-contracts";
import type {
  DigitalOceanAction,
  DigitalOceanOwnedSetDeleteResult,
  DigitalOceanOwnedSetExpectation,
  DigitalOceanOwnedSetProvider,
  DigitalOceanOwnedSetResult,
  DigitalOceanProvider,
  DigitalOceanProviderRequestContext,
  DigitalOceanProviderResult,
  DigitalOceanReadSnapshotBuilderEvidenceInput,
  DigitalOceanResource,
  DigitalOceanSnapshotBuilderEvidence,
} from "@/src/server/runners/digitalocean-provider";
import { findDigitalOceanRunnerResourceProfile } from "@/src/server/runners/runner-resource-profiles";
import {
  createRunnerSnapshotAttestation,
  isRunnerSnapshotSigningKeyId,
  type RunnerSnapshotBundle,
  type RunnerSnapshotManifest,
} from "./runner-snapshot-manifest";
import {
  SNAPSHOT_BUILDER_DIAGNOSTICS_CONTRACT_VERSION,
  SNAPSHOT_BUILDER_EVIDENCE_COMMENT_MARKER,
  SNAPSHOT_BUILDER_EVIDENCE_CONTRACT_VERSION,
  type SnapshotBuilderEvidenceDiagnostics,
  type SnapshotBuilderEvidencePublisher,
} from "./snapshot-builder-evidence-channel";

const SNAPSHOT_AUTHORIZATION_SENTINEL = "I_UNDERSTAND_THIS_CREATES_A_BILLABLE_SNAPSHOT_BUILDER";
const SNAPSHOT_OPERATION_TAG_PREFIX = "bruno-snapshot-build";
const SNAPSHOT_BUILDER_NAME_PREFIX = "bruno-snapshot-builder";
const SNAPSHOT_MIN_DISK_GB = 25;
const SNAPSHOT_BUILDER_EVIDENCE_POLL_ATTEMPTS = 63;
const SNAPSHOT_BUILDER_EVIDENCE_DEADLINE_MS = 35 * 60 * 1_000;
const SNAPSHOT_BUILDER_EVIDENCE_POLL_INTERVAL_MS = 35_000;
const SNAPSHOT_CLEANUP_DEADLINE_MS = 2 * 60 * 1_000;
const SNAPSHOT_CLEANUP_POLL_ATTEMPTS = 24;
const SNAPSHOT_CLEANUP_POLL_INTERVAL_MS = 5_000;

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
  builderEvidencePublisher?: SnapshotBuilderEvidencePublisher;
  readBuilderEvidence?: (
    input: DigitalOceanReadSnapshotBuilderEvidenceInput,
    context?: DigitalOceanProviderRequestContext,
  ) => Promise<DigitalOceanProviderResult<DigitalOceanSnapshotBuilderEvidence>>;
  readBuilderDiagnostics?: (
    input: DigitalOceanReadSnapshotBuilderEvidenceInput,
    context?: DigitalOceanProviderRequestContext,
  ) => Promise<SnapshotBuilderEvidenceDiagnostics>;
  privateKeyPem: string;
  signingKeyId: string;
  provider: DigitalOceanProvider;
  context: DigitalOceanProviderRequestContext;
  now?: () => Date;
  actionPollAttempts?: number;
  actionPollIntervalMs?: number;
  builderEvidencePollIntervalMs?: number;
  cleanupPollIntervalMs?: number;
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
  fixtureStatus?: RunnerBootSnapshotStatus;
  failureReason?: RunnerBootFailureReason;
  fixtureExitCode?: number;
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
      bootResult?: SnapshotBootFixtureResult;
      sanitationResult?: SnapshotSanitationResult;
      diagnostics?: SnapshotBuilderEvidenceDiagnostics;
      cleanup: SnapshotCleanupEvidence;
    };

export type BuildRunnerSnapshotFailureReason =
  | "authorization_missing"
  | "input_invalid"
  | "provider_contract_missing"
  | "builder_create_failed"
  | "builder_evidence_timeout"
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

  return {
    ok: false,
    reason: "cleanup_failed",
    ...(!result.ok && result.bootResult ? { bootResult: result.bootResult } : {}),
    ...(!result.ok && result.sanitationResult ? { sanitationResult: result.sanitationResult } : {}),
    ...(!result.ok && result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    cleanup: result.cleanup,
  };
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
          ...(input.builderEvidencePublisher
            ? { evidencePublisher: input.builderEvidencePublisher }
            : {}),
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
      readEvidence:
        input.readBuilderEvidence ??
        input.provider.readSnapshotBuilderEvidence.bind(input.provider),
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
      if (evidence.reason !== "builder_evidence_not_ready" || input.context.signal.aborted) {
        return { ok: false, reason: "boot_fixture_failed", cleanup };
      }
      const diagnostics = await readFailureDiagnostics({
        readDiagnostics: input.readBuilderDiagnostics,
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
      });
      return { ok: false, reason: "builder_evidence_timeout", diagnostics, cleanup };
    }

    const bootResult = evidence.value.bootResult as SnapshotBootFixtureResult;
    const sanitationResult = evidence.value.sanitationResult as SnapshotSanitationResult;

    if (!bootFixtureMatches(bootResult, input, builder.providerResourceId)) {
      return {
        ok: false,
        reason: "boot_fixture_failed",
        bootResult,
        sanitationResult,
        cleanup,
      };
    }

    if (
      !sanitationPassed(
        sanitationResult,
        builder.providerResourceId,
        input.builderEvidencePublisher !== undefined,
      )
    ) {
      return { ok: false, reason: "sanitation_failed", bootResult, sanitationResult, cleanup };
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
            intervalMs: input.cleanupPollIntervalMs ?? SNAPSHOT_CLEANUP_POLL_INTERVAL_MS,
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

async function readFailureDiagnostics(input: {
  readDiagnostics: BuildRunnerSnapshotInput["readBuilderDiagnostics"];
  evidenceInput: DigitalOceanReadSnapshotBuilderEvidenceInput;
  context: DigitalOceanProviderRequestContext;
}): Promise<SnapshotBuilderEvidenceDiagnostics> {
  if (!input.readDiagnostics) return unavailableBuilderDiagnostics();

  try {
    return await input.readDiagnostics(input.evidenceInput, input.context);
  } catch {
    return unavailableBuilderDiagnostics();
  }
}

function unavailableBuilderDiagnostics(): SnapshotBuilderEvidenceDiagnostics {
  return {
    schemaVersion: SNAPSHOT_BUILDER_DIAGNOSTICS_CONTRACT_VERSION,
    status: "unavailable",
    lastStage: null,
  };
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
  intervalMs: number;
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

  const firewall = await retryOwnedSetDeletion({
    operation: () => ownedSetProvider.deleteFirewall(expectation, input.context),
    context: input.context,
    intervalMs: input.intervalMs,
  });
  input.cleanup.steps.push("delete_firewall");
  if (!firewall.ok) {
    input.cleanup.ambiguousOwnership = true;
    return;
  }
  input.cleanup.deletedFirewallId = firewallId;

  const droplet = await retryOwnedSetDeletion({
    operation: () => ownedSetProvider.deleteDroplet(expectation, input.context),
    context: input.context,
    intervalMs: input.intervalMs,
  });
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

async function retryOwnedSetDeletion(input: {
  operation: () => Promise<DigitalOceanOwnedSetResult<DigitalOceanOwnedSetDeleteResult>>;
  context: DigitalOceanProviderRequestContext;
  intervalMs: number;
}): Promise<DigitalOceanOwnedSetResult<DigitalOceanOwnedSetDeleteResult>> {
  let result = await input.operation();
  let deleteOutcomeUnknown = !result.ok && result.reason === "delete_outcome_unknown";

  for (
    let attempt = 1;
    !result.ok &&
    (result.retryable || (deleteOutcomeUnknown && result.reason === "ownership_ambiguous")) &&
    attempt < SNAPSHOT_CLEANUP_POLL_ATTEMPTS &&
    !input.context.signal.aborted;
    attempt += 1
  ) {
    if (input.intervalMs > 0) await sleep(input.intervalMs, input.context.signal);
    result = await input.operation();
    deleteOutcomeUnknown ||= !result.ok && result.reason === "delete_outcome_unknown";
  }

  return result;
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
  const intervalMs = input.intervalMs ?? SNAPSHOT_BUILDER_EVIDENCE_POLL_INTERVAL_MS;
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
  evidencePublisher?: SnapshotBuilderEvidencePublisher;
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
  const evidencePublisherSetup = buildEvidencePublisherSetup(input.evidencePublisher);
  const sanitationRemovedPaths = [
    "/etc/bruno/runner.env",
    "/root/.docker/config.json",
    "/var/lib/cloud",
    "/root/.ssh/authorized_keys",
    "/root/.ssh/authorized_keys2",
    "/etc/ssh/ssh_host_ed25519_key",
    "/etc/machine-id",
    "/var/log/cloud-init-output.log",
    "/usr/local/sbin/bruno-finalize-snapshot-sanitation",
    ...(input.evidencePublisher
      ? [
          "/run/bruno-snapshot-builder/evidence.env",
          "/etc/systemd/system/bruno-snapshot-finalize.service",
          "/run/bruno-snapshot-builder/publish-evidence.py",
        ]
      : []),
  ];
  const sanitationHostileMarkers = [
    "BRUNO_RUNNER_REGISTRATION_TOKEN",
    "BRUNO_RUNNER_BEARER_TOKEN",
    "dop_v1_",
    "BEGIN OPENSSH PRIVATE KEY",
    ...(input.evidencePublisher
      ? [
          "BRUNO_SNAPSHOT_EVIDENCE_TOKEN_VALUE",
          "BRUNO_SNAPSHOT_EVIDENCE_AUTHENTICATION_SECRET_VALUE",
        ]
      : []),
  ];
  const sanitationInitialOk = input.evidencePublisher ? "False" : "True";
  const sanitationInitialCompletedAt = input.evidencePublisher
    ? "None"
    : 'datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")';
  const evidencePublisherCompletion = input.evidencePublisher
    ? `    /run/bruno-snapshot-builder/publish-evidence.py "complete"
    unset BRUNO_SNAPSHOT_EVIDENCE_TOKEN`
    : "    :";
  const scheduleSanitationFinalizer = input.evidencePublisher
    ? `    declare -p BRUNO_SNAPSHOT_EVIDENCE_TOKEN BRUNO_SNAPSHOT_EVIDENCE_REPOSITORY BRUNO_SNAPSHOT_EVIDENCE_ISSUE_NUMBER BRUNO_SNAPSHOT_EVIDENCE_RUN_ID BRUNO_SNAPSHOT_EVIDENCE_NONCE BRUNO_SNAPSHOT_EVIDENCE_AUTHENTICATION_SECRET BRUNO_SNAPSHOT_EVIDENCE_API_URL > /run/bruno-snapshot-builder/evidence.env
    chmod 0600 /run/bruno-snapshot-builder/evidence.env
    cat > /etc/systemd/system/bruno-snapshot-finalize.service <<'BRUNO_SNAPSHOT_FINALIZE_UNIT'
    [Unit]
    Description=Finalize sanitized Bruno runner snapshot evidence
    After=cloud-final.service network-online.target
    Wants=network-online.target

    [Service]
    Type=oneshot
    ExecStart=/usr/local/sbin/bruno-finalize-snapshot-sanitation
    BRUNO_SNAPSHOT_FINALIZE_UNIT
    systemctl daemon-reload
    systemctl start --no-block bruno-snapshot-finalize.service`
    : "";

  const bootstrapCommand = dedentSnapshotBootstrapCommand(`
    set -euo pipefail
    install -m 0755 -d /etc/apt/keyrings /etc/bruno-snapshot-builder /run/bruno-snapshot-builder
    BRUNO_BUILDER_RESOURCE_ID="$(
      python3 - <<'BRUNO_BUILDER_METADATA_PY'
    import urllib.request

    with urllib.request.urlopen("http://169.254.169.254/metadata/v1/id", timeout=15) as response:
        print(response.read().decode("utf-8").strip())
    BRUNO_BUILDER_METADATA_PY
    )"
    export BRUNO_BUILDER_RESOURCE_ID
    printf '%s\\n' "$BRUNO_BUILDER_RESOURCE_ID" > /run/bruno-snapshot-builder/builder-resource-id
${evidencePublisherSetup}
    publish_builder_evidence "bootstrap_started"
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates curl gnupg
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    . /etc/os-release
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin caddy
    systemctl enable --now docker
    systemctl enable --now caddy
    publish_builder_evidence "docker_installed"
    docker pull ${runnerImageShell}
    docker pull ${defaultAgentImageShell}
    docker pull ${hermesImageShell}
    docker image inspect ${runnerImageShell} ${defaultAgentImageShell} ${hermesImageShell} >/dev/null
    publish_builder_evidence "images_preloaded"
    install -m 0700 -d /var/lib/bruno/boot-self-test
    docker rm --force bruno-snapshot-runner-fixture >/dev/null 2>&1 || true
    set +e
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
    BRUNO_RUNNER_FIXTURE_EXIT_CODE=$?
    set -e
    export BRUNO_RUNNER_FIXTURE_EXIT_CODE
    python3 - <<'BRUNO_BOOT_RESULT_PY'
    import datetime
    import json
    import os

    try:
        with open("/run/bruno-snapshot-builder/runner-boot-self-test.json", encoding="utf-8") as source:
            fixture = json.load(source)
        if not isinstance(fixture, dict) or not isinstance(fixture.get("components"), dict):
            raise TypeError("invalid runner boot fixture evidence")
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        fixture = {
            "status": "failed",
            "components": {
                "docker": "failed",
                "hermesFixture": "pending",
                "detailedHealth": "pending",
                "modelCanary": "pending",
                "telegramConfig": "pending",
                "cleanup": "pending",
            },
            "failureReason": "snapshot_invalid",
        }
    required_components = {
        "docker",
        "hermesFixture",
        "detailedHealth",
        "modelCanary",
        "telegramConfig",
        "cleanup",
    }
    fixture_passed = fixture["status"] == "ready" and not any(
        fixture["components"].get(component) != "passed" for component in required_components
    ) and int(os.environ["BRUNO_RUNNER_FIXTURE_EXIT_CODE"]) == 0
    result = {
        "ok": fixture_passed,
        "builderResourceId": os.environ["BRUNO_BUILDER_RESOURCE_ID"],
        "runnerImage": ${runnerImageJson},
        "defaultAgentImage": ${defaultAgentImageJson},
        "hermesImage": ${hermesImageJson},
        "bootContractVersion": "${RUNNER_BOOT_CONTRACT_VERSION}",
        "preloadedImages": [${runnerImageJson}, ${defaultAgentImageJson}, ${hermesImageJson}],
        "components": fixture["components"],
        "fixtureStatus": fixture["status"],
        "failureReason": fixture["failureReason"],
        "fixtureExitCode": int(os.environ["BRUNO_RUNNER_FIXTURE_EXIT_CODE"]),
        "completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    with open("/run/bruno-snapshot-builder/boot-result.json", "w", encoding="utf-8") as output:
        json.dump(result, output, separators=(",", ":"), sort_keys=True)
        output.write("\\n")
    BRUNO_BOOT_RESULT_PY
    publish_builder_evidence "fixture_complete"
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
    if [ -f /run/bruno-snapshot-builder/evidence.env ]; then
      source /run/bruno-snapshot-builder/evidence.env
    fi
    rm -f /run/bruno-snapshot-builder/evidence.env /etc/systemd/system/bruno-snapshot-finalize.service /usr/local/sbin/bruno-finalize-snapshot-sanitation
    rm -rf /var/lib/cloud /root/.ssh/authorized_keys /root/.ssh/authorized_keys2
    test ! -e /var/lib/cloud
    test ! -e /root/.ssh/authorized_keys
    test ! -e /root/.ssh/authorized_keys2
    test ! -s /etc/machine-id
    if [ -n "\${BRUNO_SNAPSHOT_EVIDENCE_TOKEN:-}" ] && grep -R -I -F -- "$BRUNO_SNAPSHOT_EVIDENCE_TOKEN" /etc /root /var/lib/bruno /var/log >/dev/null 2>&1; then
      echo "snapshot evidence credential remains" >&2
      exit 1
    fi
    if [ -n "\${BRUNO_SNAPSHOT_EVIDENCE_AUTHENTICATION_SECRET:-}" ] && grep -R -I -F -- "$BRUNO_SNAPSHOT_EVIDENCE_AUTHENTICATION_SECRET" /etc /root /var/lib/bruno /var/log >/dev/null 2>&1; then
      echo "snapshot evidence authentication secret remains" >&2
      exit 1
    fi
    for marker in BRUNO_RUNNER_REGISTRATION_TOKEN BRUNO_RUNNER_BEARER_TOKEN dop_v1_ "BEGIN OPENSSH PRIVATE KEY"; do
      if grep -R -I -F -- "$marker" /etc /root /var/lib/bruno /var/log >/dev/null 2>&1; then
        echo "hostile marker remains" >&2
        exit 1
      fi
    done
    BRUNO_BUILDER_RESOURCE_ID="$(cat /run/bruno-snapshot-builder/builder-resource-id)"
    rm -f /run/bruno-snapshot-builder/builder-resource-id
    export BRUNO_BUILDER_RESOURCE_ID
    python3 - <<'BRUNO_SANITATION_RESULT_PY'
    import datetime
    import json
    import os

    result = {
        "ok": ${sanitationInitialOk},
        "builderResourceId": os.environ["BRUNO_BUILDER_RESOURCE_ID"],
        "forbiddenPathsAbsent": True,
        "hostileMarkersAbsent": True,
        "removedPaths": ${JSON.stringify(sanitationRemovedPaths)},
        "scannedPaths": ["/etc", "/root", "/var/lib/bruno", "/var/log"],
        "hostileMarkers": ${JSON.stringify(sanitationHostileMarkers)},
        "completedAt": ${sanitationInitialCompletedAt},
    }
    with open("/run/bruno-snapshot-builder/sanitation-result.json", "w", encoding="utf-8") as output:
        json.dump(result, output, separators=(",", ":"), sort_keys=True)
        output.write("\\n")
    BRUNO_SANITATION_RESULT_PY
${evidencePublisherCompletion}
    BRUNO_SANITATION_FINALIZER
    chmod 0700 /usr/local/sbin/bruno-finalize-snapshot-sanitation
${scheduleSanitationFinalizer}
`);

  return `#!/usr/bin/env bash\n${bootstrapCommand}\n`;
}

function dedentSnapshotBootstrapCommand(command: string): string {
  const lines = command.split("\n");

  if (lines[0] === "") {
    lines.shift();
  }
  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines
    .map((line) => {
      if (line === "") {
        return line;
      }
      if (!line.startsWith("    ")) {
        throw new Error("Snapshot bootstrap command must use four-space template indentation.");
      }
      return line.slice(4);
    })
    .join("\n");
}

function buildEvidencePublisherSetup(
  publisher: SnapshotBuilderEvidencePublisher | undefined,
): string {
  if (!publisher) {
    return `    publish_builder_evidence() {
      :
    }`;
  }

  const token = shellSingleQuote(publisher.token);
  const repository = shellSingleQuote(publisher.repository);
  const issueNumber = shellSingleQuote(String(publisher.issueNumber));
  const runId = shellSingleQuote(publisher.runId);
  const nonce = shellSingleQuote(publisher.nonce);
  const authenticationSecret = shellSingleQuote(publisher.authenticationSecret);
  const apiUrl = shellSingleQuote(publisher.apiUrl);
  const marker = JSON.stringify(SNAPSHOT_BUILDER_EVIDENCE_COMMENT_MARKER);
  const contractVersion = JSON.stringify(SNAPSHOT_BUILDER_EVIDENCE_CONTRACT_VERSION);

  return `    export BRUNO_SNAPSHOT_EVIDENCE_TOKEN=${token}
    export BRUNO_SNAPSHOT_EVIDENCE_REPOSITORY=${repository}
    export BRUNO_SNAPSHOT_EVIDENCE_ISSUE_NUMBER=${issueNumber}
    export BRUNO_SNAPSHOT_EVIDENCE_RUN_ID=${runId}
    export BRUNO_SNAPSHOT_EVIDENCE_NONCE=${nonce}
    export BRUNO_SNAPSHOT_EVIDENCE_AUTHENTICATION_SECRET=${authenticationSecret}
    export BRUNO_SNAPSHOT_EVIDENCE_API_URL=${apiUrl}
    cat > /run/bruno-snapshot-builder/publish-evidence.py <<'BRUNO_EVIDENCE_PUBLISHER_PY'
    #!/usr/bin/env python3
    import datetime
    import hashlib
    import hmac
    import json
    import os
    import sys
    import time
    import urllib.error
    import urllib.request

    stage = sys.argv[1]
    if stage not in {"bootstrap_started", "docker_installed", "images_preloaded", "fixture_complete", "complete"}:
        raise ValueError("invalid snapshot builder evidence stage")
    runtime_directory = "/run/bruno-snapshot-builder"
    publisher_path = f"{runtime_directory}/publish-evidence.py"
    state_path = f"{runtime_directory}/evidence-comment-id"
    payload = {
        "contractVersion": ${contractVersion},
        "repository": os.environ["BRUNO_SNAPSHOT_EVIDENCE_REPOSITORY"],
        "issueNumber": int(os.environ["BRUNO_SNAPSHOT_EVIDENCE_ISSUE_NUMBER"]),
        "runId": os.environ["BRUNO_SNAPSHOT_EVIDENCE_RUN_ID"],
        "stage": stage,
        "builderResourceId": os.environ["BRUNO_BUILDER_RESOURCE_ID"],
    }
    if stage in {"fixture_complete", "complete"}:
        with open(f"{runtime_directory}/boot-result.json", encoding="utf-8") as source:
            payload["bootResult"] = json.load(source)
    if stage == "complete":
        payload["nonce"] = os.environ["BRUNO_SNAPSHOT_EVIDENCE_NONCE"]
    comment_id = None
    try:
        with open(state_path, encoding="utf-8") as source:
            comment_id = int(source.read().strip())
    except (OSError, TypeError, ValueError):
        pass
    repository = os.environ["BRUNO_SNAPSHOT_EVIDENCE_REPOSITORY"]
    issue_number = os.environ["BRUNO_SNAPSHOT_EVIDENCE_ISSUE_NUMBER"]
    api_url = os.environ["BRUNO_SNAPSHOT_EVIDENCE_API_URL"]
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {os.environ['BRUNO_SNAPSHOT_EVIDENCE_TOKEN']}",
        "Content-Type": "application/json",
        "User-Agent": "bruno-snapshot-builder-evidence",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    def discover_comment_id():
        request = urllib.request.Request(
            f"{api_url}/repos/{repository}/issues/{issue_number}/comments?per_page=100&sort=created&direction=desc",
            headers=headers,
            method="GET",
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            comments = json.load(response)
        matches = []
        for comment in comments:
            comment_body = comment.get("body", "")
            if not comment_body.startswith(${marker} + "\\n"):
                continue
            try:
                existing = json.loads(comment_body.split("\\n", 1)[1])
            except (IndexError, json.JSONDecodeError, TypeError, ValueError):
                continue
            if (
                existing.get("contractVersion") == ${contractVersion}
                and existing.get("repository") == repository
                and str(existing.get("issueNumber")) == issue_number
                and existing.get("runId") == os.environ["BRUNO_SNAPSHOT_EVIDENCE_RUN_ID"]
                and existing.get("builderResourceId") == os.environ["BRUNO_BUILDER_RESOURCE_ID"]
                and comment.get("user", {}).get("login") == "github-actions[bot]"
            ):
                matches.append(int(comment["id"]))
        if len(matches) > 1:
            raise RuntimeError("duplicate snapshot builder evidence comments")
        return matches[0] if matches else None
    if stage == "complete":
        for path in (publisher_path, state_path):
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
        with open(f"{runtime_directory}/sanitation-result.json", encoding="utf-8") as source:
            sanitation_result = json.load(source)
        sanitation_result["ok"] = True
        sanitation_result["completedAt"] = datetime.datetime.now(
            datetime.timezone.utc
        ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with open(f"{runtime_directory}/sanitation-result.json", "w", encoding="utf-8") as output:
            json.dump(sanitation_result, output, separators=(",", ":"), sort_keys=True)
            output.write("\\n")
        payload["sanitationResult"] = sanitation_result
        payload["authenticationTag"] = hmac.new(
            bytes.fromhex(os.environ["BRUNO_SNAPSHOT_EVIDENCE_AUTHENTICATION_SECRET"]),
            json.dumps(
                payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True
            ).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
    body = ${marker} + "\\n" + json.dumps(payload, separators=(",", ":"), sort_keys=True)
    last_error = None
    for delay in (0, 2, 4, 8, 16):
        if delay:
            time.sleep(delay)
        try:
            if comment_id is None:
                comment_id = discover_comment_id()
            if comment_id is None:
                url = f"{api_url}/repos/{repository}/issues/{issue_number}/comments"
                method = "POST"
            else:
                url = f"{api_url}/repos/{repository}/issues/comments/{comment_id}"
                method = "PATCH"
            request = urllib.request.Request(
                url,
                data=json.dumps({"body": body}, separators=(",", ":")).encode("utf-8"),
                headers=headers,
                method=method,
            )
            with urllib.request.urlopen(request, timeout=15) as response:
                result = json.load(response)
            comment_id = int(result["id"])
            if stage != "complete":
                with open(state_path, "w", encoding="utf-8") as output:
                    output.write(str(comment_id))
            sys.exit(0)
        except (OSError, TypeError, ValueError, urllib.error.HTTPError) as error:
            last_error = error
            if isinstance(error, urllib.error.HTTPError) and error.code == 404:
                comment_id = None
    raise RuntimeError("snapshot builder evidence publication failed") from last_error
    BRUNO_EVIDENCE_PUBLISHER_PY
    chmod 0700 /run/bruno-snapshot-builder/publish-evidence.py
    publish_builder_evidence() {
      /run/bruno-snapshot-builder/publish-evidence.py "$1"
    }`;
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
    !isRunnerSnapshotSigningKeyId(input.signingKeyId) ||
    (input.builderEvidencePublisher === undefined) !== (input.readBuilderEvidence === undefined) ||
    (input.builderEvidencePublisher !== undefined &&
      !evidencePublisherMatchesBuild(input.builderEvidencePublisher, input.operationId))
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

function evidencePublisherMatchesBuild(
  publisher: SnapshotBuilderEvidencePublisher,
  operationId: string,
): boolean {
  try {
    const apiUrl = new URL(publisher.apiUrl);
    return (
      publisher.token.trim().length > 0 &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(publisher.repository) &&
      Number.isSafeInteger(publisher.issueNumber) &&
      publisher.issueNumber > 0 &&
      publisher.runId === operationId &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        publisher.nonce,
      ) &&
      /^[a-f0-9]{64}$/.test(publisher.authenticationSecret) &&
      apiUrl.protocol === "https:" &&
      !apiUrl.username &&
      !apiUrl.password &&
      !apiUrl.search &&
      !apiUrl.hash
    );
  } catch {
    return false;
  }
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

function sanitationPassed(
  result: SnapshotSanitationResult,
  builderResourceId: string,
  outboundEvidenceEnabled: boolean,
): boolean {
  const requiredRemovedPaths = [
    "/etc/bruno/runner.env",
    "/root/.docker/config.json",
    "/var/lib/cloud",
    "/root/.ssh/authorized_keys",
    "/root/.ssh/authorized_keys2",
    "/etc/ssh/ssh_host_ed25519_key",
    "/etc/machine-id",
    "/var/log/cloud-init-output.log",
    ...(outboundEvidenceEnabled
      ? [
          "/run/bruno-snapshot-builder/evidence.env",
          "/etc/systemd/system/bruno-snapshot-finalize.service",
          "/usr/local/sbin/bruno-finalize-snapshot-sanitation",
          "/run/bruno-snapshot-builder/publish-evidence.py",
        ]
      : []),
  ];
  const requiredScannedPaths = ["/etc", "/root", "/var/lib/bruno", "/var/log"];
  const requiredHostileMarkers = [
    "BRUNO_RUNNER_REGISTRATION_TOKEN",
    "BRUNO_RUNNER_BEARER_TOKEN",
    "dop_v1_",
    "BEGIN OPENSSH PRIVATE KEY",
    ...(outboundEvidenceEnabled
      ? [
          "BRUNO_SNAPSHOT_EVIDENCE_TOKEN_VALUE",
          "BRUNO_SNAPSHOT_EVIDENCE_AUTHENTICATION_SECRET_VALUE",
        ]
      : []),
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
