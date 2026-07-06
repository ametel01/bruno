import "server-only";

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { runnerProvisioningEvents, runners } from "@/src/server/db/schema";
import type * as schema from "@/src/server/db/schema";
import { DIGITALOCEAN_PROVIDER } from "@/src/server/runners/digitalocean-provider";

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
    phase: "waiting_for_runner",
    status: "completed",
    message: "Cloud runner exchanged its one-time registration token.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      registration: "completed",
    },
    now: input.now,
  });
}

export async function markCloudRunnerReadyAfterFirstHeartbeat(
  tx: RunnerProvisioningTransaction,
  input: {
    runnerId: string;
    now: Date;
    heartbeatStatus: "online" | "degraded";
  },
): Promise<void> {
  await tx
    .update(runners)
    .set({
      status: input.heartbeatStatus,
      provisioningStatus: "ready",
      provisioningCompletedAt: input.now,
      updatedAt: input.now,
    })
    .where(eq(runners.id, input.runnerId));

  await recordRunnerProvisioningEvent(tx, {
    runnerId: input.runnerId,
    phase: "ready",
    status: "completed",
    message: "First cloud runner heartbeat was observed.",
    metadata: {
      provider: DIGITALOCEAN_PROVIDER,
      heartbeatStatus: input.heartbeatStatus,
    },
    now: input.now,
  });
}
