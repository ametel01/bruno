import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { MAX_RUNTIME_COUNTER } from "@/src/server/agents/agent-runtime-state";
import { agentDeployments, agentRuntimeReconciliations, agents } from "@/src/server/db/schema";
import type * as schema from "@/src/server/db/schema";

type RuntimeLifecycleTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type ManagedRuntimeClassification =
  | {
      kind: "managed_ready";
      runtime: typeof agentRuntimeReconciliations.$inferSelect;
    }
  | { kind: "active_deployment" }
  | { kind: "latest_failed" }
  | { kind: "managed_unavailable" }
  | { kind: "manual_or_missing" };

export async function classifyManagedRuntimeForUpdate(
  tx: RuntimeLifecycleTransaction,
  input: { agentId: string; userId: string },
): Promise<ManagedRuntimeClassification> {
  const [latestDeployment] = await tx
    .select({ stage: agentDeployments.stage })
    .from(agentDeployments)
    .where(
      and(eq(agentDeployments.agentId, input.agentId), eq(agentDeployments.userId, input.userId)),
    )
    .orderBy(desc(agentDeployments.createdAt), desc(agentDeployments.id))
    .limit(1)
    .for("update");

  if (!latestDeployment) {
    return { kind: "manual_or_missing" };
  }

  if (latestDeployment.stage !== "ready" && latestDeployment.stage !== "failed") {
    return { kind: "active_deployment" };
  }

  if (latestDeployment.stage === "failed") {
    return { kind: "latest_failed" };
  }

  const [runtime] = await tx
    .select()
    .from(agentRuntimeReconciliations)
    .where(
      and(
        eq(agentRuntimeReconciliations.agentId, input.agentId),
        eq(agentRuntimeReconciliations.userId, input.userId),
      ),
    )
    .limit(1)
    .for("update");

  return runtime ? { kind: "managed_ready", runtime } : { kind: "managed_unavailable" };
}

export type RuntimeOwnerIntent = "start" | "restart" | "stop" | "delete";

export async function persistManagedRuntimeOwnerIntent(
  tx: RuntimeLifecycleTransaction,
  input: {
    agentId: string;
    userId: string;
    expectedGeneration: number;
    intent: RuntimeOwnerIntent;
    now: Date;
  },
): Promise<number | null> {
  if (input.expectedGeneration >= MAX_RUNTIME_COUNTER) {
    return null;
  }

  const state =
    input.intent === "start"
      ? "recovering_start"
      : input.intent === "restart"
        ? "recovering_stop"
        : input.intent === "stop"
          ? "stopping"
          : "stopped";
  const due = input.intent === "delete" ? null : input.now;
  const [updated] = await tx
    .update(agentRuntimeReconciliations)
    .set({
      state,
      generation: input.expectedGeneration + 1,
      operationId: null,
      attemptCount: 0,
      recoveryCount: 0,
      recoveryWindowStartedAt: null,
      stableSince: null,
      telegramNonConnectedSince: null,
      lastRestartCount: null,
      errorCode: input.intent === "stop" ? "runtime_stop_unconfirmed" : null,
      nextAttemptAt: due,
      leaseOwner: null,
      leaseExpiresAt: null,
      circuitOpenedAt: null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(agentRuntimeReconciliations.agentId, input.agentId),
        eq(agentRuntimeReconciliations.userId, input.userId),
        eq(agentRuntimeReconciliations.generation, input.expectedGeneration),
      ),
    )
    .returning({ generation: agentRuntimeReconciliations.generation });

  return updated?.generation ?? null;
}

export async function reviseManagedRuntimeConfiguration(
  tx: RuntimeLifecycleTransaction,
  input: { agentId: string; userId: string; now: Date },
): Promise<{ changed: boolean; schedule: boolean }> {
  const classification = await classifyManagedRuntimeForUpdate(tx, input);

  if (classification.kind !== "managed_ready") {
    return { changed: false, schedule: false };
  }

  const [agent] = await tx
    .select({ desiredStatus: agents.desiredStatus, status: agents.status })
    .from(agents)
    .where(
      and(eq(agents.id, input.agentId), eq(agents.userId, input.userId), isNull(agents.deletedAt)),
    )
    .limit(1)
    .for("update");

  if (!agent) {
    return { changed: false, schedule: false };
  }

  const runtime = classification.runtime;
  if (runtime.generation >= MAX_RUNTIME_COUNTER) {
    return { changed: false, schedule: false };
  }

  const circuitOpen = runtime.circuitOpenedAt !== null;
  const cleanupOnlyCircuit = circuitOpen && runtime.state === "stopping";
  const stopped = agent.desiredStatus === "stopped";
  const generation = runtime.generation + 1;
  const [updated] = await tx
    .update(agentRuntimeReconciliations)
    .set({
      generation,
      configRevision: runtimeConfigRevision(generation, input.now),
      state: stopped
        ? "stopped"
        : cleanupOnlyCircuit
          ? "stopping"
          : circuitOpen
            ? "circuit_open"
            : "recovering_stop",
      operationId: null,
      attemptCount: 0,
      recoveryCount: circuitOpen ? runtime.recoveryCount : 0,
      recoveryWindowStartedAt: circuitOpen ? runtime.recoveryWindowStartedAt : null,
      stableSince: null,
      telegramNonConnectedSince: null,
      lastRestartCount: null,
      errorCode: stopped ? null : circuitOpen ? runtime.errorCode : null,
      nextAttemptAt: stopped || (circuitOpen && !cleanupOnlyCircuit) ? null : input.now,
      leaseOwner: null,
      leaseExpiresAt: null,
      circuitOpenedAt: circuitOpen ? runtime.circuitOpenedAt : null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(agentRuntimeReconciliations.agentId, input.agentId),
        eq(agentRuntimeReconciliations.userId, input.userId),
        eq(agentRuntimeReconciliations.generation, runtime.generation),
      ),
    )
    .returning({ agentId: agentRuntimeReconciliations.agentId });

  if (!updated) {
    return { changed: false, schedule: false };
  }

  if (!stopped && !circuitOpen) {
    await tx
      .update(agents)
      .set({
        status: "restarting",
        statusReason: "Configuration changed; runtime recovery scheduled.",
        updatedAt: input.now,
      })
      .where(
        and(
          eq(agents.id, input.agentId),
          eq(agents.userId, input.userId),
          isNull(agents.deletedAt),
        ),
      );
  }

  return { changed: true, schedule: !stopped && (!circuitOpen || cleanupOnlyCircuit) };
}

export async function openManagedRuntimeSecretCircuit(
  tx: RuntimeLifecycleTransaction,
  input: { agentId: string; userId: string; now: Date },
): Promise<boolean> {
  const classification = await classifyManagedRuntimeForUpdate(tx, input);

  if (classification.kind !== "managed_ready") {
    return false;
  }

  const runtime = classification.runtime;
  if (runtime.generation >= MAX_RUNTIME_COUNTER) {
    return false;
  }

  const agentIsAuthoritativelyStopped = runtime.state === "stopped";
  const [updated] = await tx
    .update(agentRuntimeReconciliations)
    .set({
      state: agentIsAuthoritativelyStopped ? "circuit_open" : "stopping",
      generation: runtime.generation + 1,
      operationId: null,
      attemptCount: 0,
      stableSince: null,
      telegramNonConnectedSince: null,
      errorCode: "runtime_secret_unavailable",
      nextAttemptAt: agentIsAuthoritativelyStopped ? null : input.now,
      leaseOwner: null,
      leaseExpiresAt: null,
      circuitOpenedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(agentRuntimeReconciliations.agentId, input.agentId),
        eq(agentRuntimeReconciliations.userId, input.userId),
        eq(agentRuntimeReconciliations.generation, runtime.generation),
      ),
    )
    .returning({ agentId: agentRuntimeReconciliations.agentId });

  if (!updated) {
    return false;
  }

  await tx
    .update(agents)
    .set({
      status: "error",
      statusReason: "A required credential is unavailable. Replace it, then restart.",
      updatedAt: input.now,
    })
    .where(
      and(eq(agents.id, input.agentId), eq(agents.userId, input.userId), isNull(agents.deletedAt)),
    );
  return true;
}

export function runtimeConfigRevision(generation: number, now: Date): string {
  return `cfg-runtime-${generation}-${now.getTime()}`;
}
