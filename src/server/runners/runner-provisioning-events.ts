import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { runnerProvisioningEvents, runners } from "@/src/server/db/schema";
import type * as schema from "@/src/server/db/schema";
import { DIGITALOCEAN_PROVIDER } from "@/src/server/runners/digitalocean-provider";
import type {
  RunnerBootFailureReason,
  RunnerBootSnapshot,
} from "@/src/runner-service/runner-contracts";

export type RunnerProvisioningPhase =
  | "pending"
  | "creating"
  | "tagging"
  | "firewall_configuring"
  | "bootstrapping"
  | "waiting_for_runner"
  | "ready"
  | "failed"
  | "cleaning_up"
  | "deleted";

export type RunnerProvisioningEventStatus = "started" | "completed" | "failed";

type RunnerProvisioningTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export async function recordRunnerProvisioningEvent(
  tx: RunnerProvisioningTransaction,
  input: {
    runnerId: string;
    phase: RunnerProvisioningPhase;
    status: RunnerProvisioningEventStatus;
    message: string;
    metadata?: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await tx.insert(runnerProvisioningEvents).values({
    runnerId: input.runnerId,
    phase: input.phase,
    status: input.status,
    message: input.message,
    metadata: input.metadata ?? {},
    createdAt: input.now,
  });
}

export async function markCloudRunnerBootstrapInjected(
  tx: RunnerProvisioningTransaction,
  input: {
    runnerId: string;
    now: Date;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx
    .update(runners)
    .set({
      status: "provisioning",
      provisioningStatus: "bootstrapping",
      updatedAt: input.now,
    })
    .where(eq(runners.id, input.runnerId));

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "bootstrapping",
    status: "started",
    message: "Cloud runner bootstrap content was injected.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      registrationToken: "injected",
      ...(input.metadata ?? {}),
    },
    now: input.now,
  });
}

export async function markCloudRunnerRegistered(
  tx: RunnerProvisioningTransaction,
  input: {
    runnerId: string;
    now: Date;
  },
): Promise<void> {
  await tx
    .update(runners)
    .set({
      status: "registering",
      provisioningStatus: "waiting_for_runner",
      updatedAt: input.now,
    })
    .where(eq(runners.id, input.runnerId));

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "bootstrapping",
    status: "completed",
    message: "Cloud runner bootstrap completed registration handoff.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
    },
    now: input.now,
  });

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "bootstrapping",
    status: "completed",
    message: "Cloud runner bootstrap startup boundary completed.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      step: "bootstrap_started",
    },
    now: input.now,
  });

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "waiting_for_runner",
    status: "completed",
    message: "Cloud runner exchanged its one-time registration token.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      registration: "completed",
    },
    now: input.now,
  });

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "waiting_for_runner",
    status: "completed",
    message: "Cloud runner exchanged its one-time registration token.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      step: "runner_registration",
      registration: "completed",
    },
    now: input.now,
  });
}

export async function markCloudRunnerReadyAfterAuthenticatedProbe(
  tx: RunnerProvisioningTransaction,
  input: {
    runnerId: string;
    now: Date;
    bootSnapshot: RunnerBootSnapshot;
    readinessProbeStartedAt: Date;
    readinessProbeCompletedAt: Date;
  },
): Promise<boolean> {
  const bootCompletedAt = bootSnapshotCompletedAt(input.bootSnapshot, input.now);
  const transitionedRows = await tx
    .update(runners)
    .set({
      status: "online",
      provisioningStatus: "ready",
      provisioningCompletedAt: input.readinessProbeCompletedAt,
      updatedAt: input.readinessProbeCompletedAt,
    })
    .where(
      and(
        eq(runners.id, input.runnerId),
        eq(runners.kind, "digitalocean"),
        eq(runners.provider, DIGITALOCEAN_PROVIDER),
        eq(runners.status, "online"),
        eq(runners.provisioningStatus, "waiting_for_runner"),
        isNull(runners.deletedAt),
      ),
    )
    .returning({ id: runners.id });

  if (transitionedRows.length === 0) {
    return false;
  }

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "bootstrapping",
    status: "started",
    message: "Runner boot validation started.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      step: "boot_validation",
      bootContractVersion: input.bootSnapshot.contractVersion,
      bootStatus: input.bootSnapshot.status,
    },
    now: new Date(input.bootSnapshot.startedAt),
  });

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "bootstrapping",
    status: "completed",
    message: "Runner boot validation succeeded.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      step: "boot_validation",
      bootContractVersion: input.bootSnapshot.contractVersion,
      bootStatus: input.bootSnapshot.status,
      bootObservedChecks: input.bootSnapshot.observedChecks,
      bootAttestedChecks: input.bootSnapshot.attestedChecks,
      bootEvidence: input.bootSnapshot.evidence,
    },
    now: bootCompletedAt,
  });

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "ready",
    status: "started",
    message: "Runner readiness transition started.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      readinessProbe: "authenticated_endpoint",
    },
    now: input.readinessProbeStartedAt,
  });

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "ready",
    status: "started",
    message: "Authenticated runner readiness probe started.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      step: "authenticated_readiness",
      heartbeatStatus: "online",
      readinessProbe: "authenticated_endpoint",
    },
    now: input.readinessProbeStartedAt,
  });

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "ready",
    status: "completed",
    message: "Runner readiness transition completed.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      heartbeatStatus: "online",
      readinessProbe: "authenticated_endpoint",
    },
    now: input.readinessProbeCompletedAt,
  });

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "ready",
    status: "completed",
    message: "Authenticated runner readiness probe succeeded.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      step: "authenticated_readiness",
      heartbeatStatus: "online",
      readinessProbe: "authenticated_endpoint",
      bootContractVersion: input.bootSnapshot.contractVersion,
      bootStatus: input.bootSnapshot.status,
      bootObservedChecks: input.bootSnapshot.observedChecks,
      bootAttestedChecks: input.bootSnapshot.attestedChecks,
      bootEvidence: input.bootSnapshot.evidence,
    },
    now: input.readinessProbeCompletedAt,
  });

  return true;
}

export async function markCloudRunnerFailedAfterAuthenticatedProbe(
  tx: RunnerProvisioningTransaction,
  input: {
    runnerId: string;
    now: Date;
    bootSnapshot: RunnerBootSnapshot;
    readinessProbeStartedAt: Date;
    readinessProbeCompletedAt: Date;
  },
): Promise<boolean> {
  const failureReason = input.bootSnapshot.failureReason;
  if (input.bootSnapshot.status !== "failed" || failureReason === null) return false;
  const bootCompletedAt = bootSnapshotCompletedAt(input.bootSnapshot, input.now);

  const transitionedRows = await tx
    .update(runners)
    .set({
      status: "provision_failed",
      provisioningStatus: "failed",
      provisioningError: runnerBootFailureMessage(failureReason),
      provisioningCompletedAt: input.readinessProbeCompletedAt,
      updatedAt: input.readinessProbeCompletedAt,
    })
    .where(
      and(
        eq(runners.id, input.runnerId),
        eq(runners.kind, "digitalocean"),
        eq(runners.provider, DIGITALOCEAN_PROVIDER),
        eq(runners.status, "online"),
        eq(runners.provisioningStatus, "waiting_for_runner"),
        isNull(runners.deletedAt),
      ),
    )
    .returning({ id: runners.id });

  if (transitionedRows.length === 0) return false;

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "bootstrapping",
    status: "started",
    message: "Runner boot validation started.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      step: "boot_validation",
      bootContractVersion: input.bootSnapshot.contractVersion,
      bootStatus: input.bootSnapshot.status,
    },
    now: new Date(input.bootSnapshot.startedAt),
  });

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "bootstrapping",
    status: "failed",
    message: "Runner boot validation failed.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      step: "boot_validation",
      bootContractVersion: input.bootSnapshot.contractVersion,
      bootStatus: input.bootSnapshot.status,
      bootObservedChecks: input.bootSnapshot.observedChecks,
      bootAttestedChecks: input.bootSnapshot.attestedChecks,
      bootEvidence: input.bootSnapshot.evidence,
      bootFailureReason: failureReason,
    },
    now: bootCompletedAt,
  });

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "ready",
    status: "started",
    message: "Runner readiness transition started.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      readinessProbe: "authenticated_endpoint",
    },
    now: input.readinessProbeStartedAt,
  });

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "ready",
    status: "started",
    message: "Authenticated runner readiness probe started.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      step: "authenticated_readiness",
      readinessProbe: "authenticated_endpoint",
    },
    now: input.readinessProbeStartedAt,
  });

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "ready",
    status: "failed",
    message: "Runner readiness transition failed.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      readinessProbe: "authenticated_endpoint",
      bootContractVersion: input.bootSnapshot.contractVersion,
      bootStatus: input.bootSnapshot.status,
      bootFailureReason: failureReason,
    },
    now: input.readinessProbeCompletedAt,
  });

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "ready",
    status: "failed",
    message: "Authenticated runner readiness probe failed.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      step: "authenticated_readiness",
      readinessProbe: "authenticated_endpoint",
      bootContractVersion: input.bootSnapshot.contractVersion,
      bootStatus: input.bootSnapshot.status,
      bootObservedChecks: input.bootSnapshot.observedChecks,
      bootAttestedChecks: input.bootSnapshot.attestedChecks,
      bootEvidence: input.bootSnapshot.evidence,
      bootFailureReason: failureReason,
    },
    now: input.readinessProbeCompletedAt,
  });

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "failed",
    status: "failed",
    message: "Authenticated runner boot self-test failed.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      readinessProbe: "authenticated_endpoint",
      bootContractVersion: input.bootSnapshot.contractVersion,
      bootStatus: input.bootSnapshot.status,
      bootObservedChecks: input.bootSnapshot.observedChecks,
      bootAttestedChecks: input.bootSnapshot.attestedChecks,
      bootEvidence: input.bootSnapshot.evidence,
      bootFailureReason: failureReason,
    },
    now: input.readinessProbeCompletedAt,
  });

  return true;
}

function bootSnapshotCompletedAt(snapshot: RunnerBootSnapshot, fallback: Date): Date {
  return snapshot.completedAt ? new Date(snapshot.completedAt) : fallback;
}

function runnerBootFailureMessage(reason: Exclude<RunnerBootFailureReason, null>): string {
  const detail: Record<Exclude<RunnerBootFailureReason, null>, string> = {
    docker_unavailable: "Docker was unavailable.",
    release_mismatch: "Runner release identity did not match.",
    release_validation_failed: "Verified Release evidence was invalid.",
    required_services_unavailable: "Required runner services were unavailable.",
    preloaded_images_mismatch: "Preloaded image identities did not match.",
    fixture_launch_failed: "Hermes fixture launch failed.",
    detailed_health_failed: "Hermes detailed health failed.",
    canary_failed: "The model canary failed.",
    telegram_config_failed: "Telegram configuration validation failed.",
    cleanup_failed: "Boot fixture cleanup failed.",
    deadline_exceeded: "The boot self-test deadline was exceeded.",
    snapshot_invalid: "The boot readiness snapshot was invalid.",
  };
  return `Runner boot self-test failed: ${detail[reason]}`;
}

export async function markCloudRunnerExternallyDeleted(
  tx: RunnerProvisioningTransaction,
  input: {
    runnerId: string;
    userId: string;
    providerResourceId: string;
    now: Date;
  },
): Promise<boolean> {
  const transitionedRows = await tx
    .update(runners)
    .set({
      status: "deleted",
      provisioningStatus: "deleted",
      provisioningError: null,
      provisioningCompletedAt: input.now,
      deletedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(runners.id, input.runnerId),
        eq(runners.userId, input.userId),
        eq(runners.kind, "digitalocean"),
        eq(runners.provider, DIGITALOCEAN_PROVIDER),
        eq(runners.providerResourceId, input.providerResourceId),
        isNull(runners.deletedAt),
      ),
    )
    .returning({ id: runners.id });

  if (transitionedRows.length === 0) {
    return false;
  }

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "deleted",
    status: "completed",
    message: "DigitalOcean Droplet was deleted outside Bruno.Ai.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      deletionSource: "provider_reconciliation",
      providerResourceId: input.providerResourceId,
    },
    now: input.now,
  });

  return true;
}
