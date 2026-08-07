import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import {
  agentDeployments,
  agentEvents,
  agentRuntimeReconciliations,
  agentSecrets,
  agents,
  agentUsagePeriods,
  appMetadata,
  dockerRunnerContainers,
  localRunnerProcesses,
  runnerCredentials,
  runners,
  users,
} from "@/src/server/db/schema";
import {
  DEVELOPMENT_USER_METADATA_KEY,
  HERMES_STAGING_OWNER_METADATA_KEY,
} from "@/src/server/users/development-user";

export { HERMES_STAGING_OWNER_METADATA_KEY };

export const HERMES_READY_DEPLOYMENT_STAGES = [
  "pending",
  "provisioning_runner",
  "configuring_hermes",
  "starting_gateway",
  "verifying_model",
  "connecting_telegram",
  "ready",
] as const;

type HermesReadyDeploymentStage = (typeof HERMES_READY_DEPLOYMENT_STAGES)[number];
type AgentStatus = typeof agents.$inferSelect.status;
type AgentDesiredStatus = typeof agents.$inferSelect.desiredStatus;
type RuntimeState = typeof agentRuntimeReconciliations.$inferSelect.state;
type AgentSecretKind = typeof agentSecrets.$inferSelect.kind;

type StagingTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

type StagingReadDatabase = Pick<StagingTransaction, "select">;

export type HermesStagingOwnerResolution =
  | { ok: true; userId: string; created: boolean }
  | {
      ok: false;
      reason:
        | "staging_owner_pointer_missing_user"
        | "staging_owner_has_clerk_identity"
        | "staging_owner_shared_with_development";
    };

export async function resolveHermesStagingOwner(
  tx: StagingTransaction,
): Promise<HermesStagingOwnerResolution> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${HERMES_STAGING_OWNER_METADATA_KEY}, 0))`,
  );

  const [pointer] = await tx
    .select({ value: appMetadata.value })
    .from(appMetadata)
    .where(eq(appMetadata.key, HERMES_STAGING_OWNER_METADATA_KEY))
    .limit(1);

  if (pointer) {
    const validation = await validateExistingOwnerPointer(tx, pointer.value);
    return validation.ok ? { ...validation, created: false } : validation;
  }

  const [createdUser] = await tx
    .insert(users)
    .values({ clerkUserId: null })
    .returning({ id: users.id });

  if (!createdUser) {
    throw new Error("Hermes staging owner insert returned no rows.");
  }

  await tx.insert(appMetadata).values({
    key: HERMES_STAGING_OWNER_METADATA_KEY,
    value: createdUser.id,
  });

  return { ok: true, userId: createdUser.id, created: true };
}

async function validateExistingOwnerPointer(
  db: StagingReadDatabase,
  userId: string,
): Promise<Exclude<HermesStagingOwnerResolution, { created: true }>> {
  const [owner] = await db
    .select({ id: users.id, clerkUserId: users.clerkUserId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!owner) {
    return { ok: false, reason: "staging_owner_pointer_missing_user" };
  }

  if (owner.clerkUserId !== null) {
    return { ok: false, reason: "staging_owner_has_clerk_identity" };
  }

  const [developmentPointer] = await db
    .select({ value: appMetadata.value })
    .from(appMetadata)
    .where(eq(appMetadata.key, DEVELOPMENT_USER_METADATA_KEY))
    .limit(1);

  if (developmentPointer?.value === owner.id) {
    return { ok: false, reason: "staging_owner_shared_with_development" };
  }

  return { ok: true, userId: owner.id, created: false };
}

export type HermesStagingOwnerIsolation =
  | { isolated: true }
  | {
      isolated: false;
      reason: "invalid_owner" | "active_agents_present" | "active_runners_present";
    };

export async function checkHermesStagingOwnerIsolation(
  db: StagingReadDatabase,
  userId: string,
): Promise<HermesStagingOwnerIsolation> {
  if (!isUuid(userId)) {
    return { isolated: false, reason: "invalid_owner" };
  }

  const [pointer] = await db
    .select({ value: appMetadata.value })
    .from(appMetadata)
    .where(eq(appMetadata.key, HERMES_STAGING_OWNER_METADATA_KEY))
    .limit(1);
  if (pointer?.value !== userId) {
    return { isolated: false, reason: "invalid_owner" };
  }

  const validation = await validateExistingOwnerPointer(db, userId);
  if (!validation.ok) {
    return { isolated: false, reason: "invalid_owner" };
  }

  const [activeAgent] = await db
    .select({ present: sql<boolean>`true` })
    .from(agents)
    .where(and(eq(agents.userId, userId), isNull(agents.deletedAt)))
    .limit(1);

  if (activeAgent) {
    return { isolated: false, reason: "active_agents_present" };
  }

  const [activeRunner] = await db
    .select({ present: sql<boolean>`true` })
    .from(runners)
    .where(and(eq(runners.userId, userId), isNull(runners.deletedAt)))
    .limit(1);

  if (activeRunner) {
    return { isolated: false, reason: "active_runners_present" };
  }

  return { isolated: true };
}

export type HermesStagingAcceptanceCorrelation =
  | {
      state: "matched";
      agentStatus: AgentStatus;
      desiredStatus: AgentDesiredStatus;
      deploymentStage: typeof agentDeployments.$inferSelect.stage;
      runnerStatus:
        | "active"
        | "inactive"
        | "registering"
        | "online"
        | "offline"
        | "degraded"
        | "provisioning"
        | "provision_failed"
        | "deleting"
        | "deleted";
      runnerKind: "digitalocean" | "manual_vps";
    }
  | {
      state:
        | "invalid_input"
        | "agent_missing"
        | "agent_not_owned"
        | "agent_deleted"
        | "deployment_mismatch"
        | "runner_mismatch"
        | "runner_deleted"
        | "unexpected_product_state";
    };

export async function observeHermesStagingAcceptanceCorrelation(
  db: StagingReadDatabase,
  input: { userId: string; agentId: string; deploymentId: string; runnerId: string },
): Promise<HermesStagingAcceptanceCorrelation> {
  if (!areUuids(input.userId, input.agentId, input.deploymentId, input.runnerId)) {
    return { state: "invalid_input" };
  }

  const [agent] = await db
    .select({
      userId: agents.userId,
      runnerId: agents.runnerId,
      status: agents.status,
      desiredStatus: agents.desiredStatus,
      deletedAt: agents.deletedAt,
    })
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .limit(1);

  if (!agent) return { state: "agent_missing" };
  if (agent.userId !== input.userId) return { state: "agent_not_owned" };
  if (agent.deletedAt !== null) return { state: "agent_deleted" };
  if (agent.runnerId !== input.runnerId) return { state: "runner_mismatch" };

  const [deployment] = await db
    .select({ stage: agentDeployments.stage })
    .from(agentDeployments)
    .where(
      and(
        eq(agentDeployments.id, input.deploymentId),
        eq(agentDeployments.agentId, input.agentId),
        eq(agentDeployments.userId, input.userId),
      ),
    )
    .limit(1);

  if (!deployment) return { state: "deployment_mismatch" };

  const [runner] = await db
    .select({
      userId: runners.userId,
      kind: runners.kind,
      status: runners.status,
      deletedAt: runners.deletedAt,
    })
    .from(runners)
    .where(eq(runners.id, input.runnerId))
    .limit(1);

  if (!runner || runner.userId !== input.userId) return { state: "runner_mismatch" };
  if (runner.deletedAt !== null) return { state: "runner_deleted" };
  if (!isRunnerKind(runner.kind) || !isRunnerStatus(runner.status)) {
    return { state: "unexpected_product_state" };
  }

  return {
    state: "matched",
    agentStatus: agent.status,
    desiredStatus: agent.desiredStatus,
    deploymentStage: deployment.stage,
    runnerStatus: runner.status,
    runnerKind: runner.kind,
  };
}

export type HermesDeploymentHistoryObservation =
  | { state: "complete"; lastStage: "ready"; nextStage: null }
  | {
      state: "incomplete";
      lastStage: HermesReadyDeploymentStage;
      nextStage: Exclude<HermesReadyDeploymentStage, "pending">;
    }
  | { state: "invalid" };

export async function observeHermesDeploymentStageHistory(
  db: StagingReadDatabase,
  input: { userId: string; agentId: string; deploymentId: string },
): Promise<HermesDeploymentHistoryObservation> {
  if (!areUuids(input.userId, input.agentId, input.deploymentId)) {
    return { state: "invalid" };
  }

  const [deployment] = await db
    .select({ stage: agentDeployments.stage })
    .from(agentDeployments)
    .where(
      and(
        eq(agentDeployments.id, input.deploymentId),
        eq(agentDeployments.agentId, input.agentId),
        eq(agentDeployments.userId, input.userId),
      ),
    )
    .limit(1);

  if (!deployment || deployment.stage === "failed") {
    return { state: "invalid" };
  }

  const events = await db
    .select({
      actorUserId: agentEvents.actorUserId,
      type: agentEvents.type,
      metadata: agentEvents.metadata,
      createdAt: agentEvents.createdAt,
    })
    .from(agentEvents)
    .where(
      and(
        eq(agentEvents.agentId, input.agentId),
        inArray(agentEvents.type, ["agent.created", "agent.deployment_stage_changed"]),
        sql`${agentEvents.metadata} ->> 'deploymentId' = ${input.deploymentId}`,
      ),
    )
    .orderBy(asc(agentEvents.createdAt), asc(agentEvents.id));

  if (events.length === 0 || events.some((event) => event.actorUserId !== input.userId)) {
    return { state: "invalid" };
  }

  const [created, ...transitions] = events;
  if (
    created?.type !== "agent.created" ||
    created.metadata.launchMode !== "ready" ||
    transitions.some((event) => event.type !== "agent.deployment_stage_changed")
  ) {
    return { state: "invalid" };
  }

  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    if (!previous || !current || current.createdAt.getTime() <= previous.createdAt.getTime()) {
      return { state: "invalid" };
    }
  }

  let lastStage: HermesReadyDeploymentStage = "pending";
  for (const transition of transitions) {
    const expectedNext = nextHermesReadyDeploymentStage(lastStage);
    if (
      !expectedNext ||
      transition.metadata.fromStage !== lastStage ||
      transition.metadata.toStage !== expectedNext
    ) {
      return { state: "invalid" };
    }
    lastStage = expectedNext;
  }

  if (deployment.stage !== lastStage) {
    return { state: "invalid" };
  }

  if (lastStage === "ready" && events.length === HERMES_READY_DEPLOYMENT_STAGES.length) {
    return { state: "complete", lastStage: "ready", nextStage: null };
  }

  const nextStage = nextHermesReadyDeploymentStage(lastStage);
  return nextStage ? { state: "incomplete", lastStage, nextStage } : { state: "invalid" };
}

export type HermesStopStabilityObservation =
  | {
      state: "observed";
      agentPresence: "active" | "deleted";
      desiredStatus: AgentDesiredStatus;
      currentStatus: AgentStatus;
      runtimeState: RuntimeState | "missing";
      stableStopped: boolean;
    }
  | { state: "invalid_input" | "agent_missing" | "agent_not_owned" };

export async function observeHermesStopStability(
  db: StagingReadDatabase,
  input: { userId: string; agentId: string },
): Promise<HermesStopStabilityObservation> {
  if (!areUuids(input.userId, input.agentId)) return { state: "invalid_input" };

  const [row] = await db
    .select({
      userId: agents.userId,
      deletedAt: agents.deletedAt,
      desiredStatus: agents.desiredStatus,
      currentStatus: agents.status,
      runtimeState: agentRuntimeReconciliations.state,
      operationId: agentRuntimeReconciliations.operationId,
      errorCode: agentRuntimeReconciliations.errorCode,
      nextAttemptAt: agentRuntimeReconciliations.nextAttemptAt,
      leaseOwner: agentRuntimeReconciliations.leaseOwner,
      leaseExpiresAt: agentRuntimeReconciliations.leaseExpiresAt,
    })
    .from(agents)
    .leftJoin(
      agentRuntimeReconciliations,
      and(
        eq(agentRuntimeReconciliations.agentId, agents.id),
        eq(agentRuntimeReconciliations.userId, input.userId),
      ),
    )
    .where(eq(agents.id, input.agentId))
    .limit(1);

  if (!row) return { state: "agent_missing" };
  if (row.userId !== input.userId) return { state: "agent_not_owned" };

  const runtimeState = row.runtimeState ?? "missing";
  const stableStopped =
    row.deletedAt === null &&
    row.desiredStatus === "stopped" &&
    row.currentStatus === "stopped" &&
    runtimeState === "stopped" &&
    row.operationId === null &&
    row.errorCode === null &&
    row.nextAttemptAt === null &&
    row.leaseOwner === null &&
    row.leaseExpiresAt === null;

  return {
    state: "observed",
    agentPresence: row.deletedAt === null ? "active" : "deleted",
    desiredStatus: row.desiredStatus,
    currentStatus: row.currentStatus,
    runtimeState,
    stableStopped,
  };
}

type SecretStatusCounts = Record<AgentSecretKind, { active: number; revoked: number }>;

export type HermesAgentSecretCountObservation =
  | { state: "observed"; counts: SecretStatusCounts; allRevoked: boolean }
  | { state: "invalid_input" | "agent_missing" | "agent_not_owned" };

export async function observeHermesAgentSecretCounts(
  db: StagingReadDatabase,
  input: { userId: string; agentId: string },
): Promise<HermesAgentSecretCountObservation> {
  if (!areUuids(input.userId, input.agentId)) return { state: "invalid_input" };
  const ownership = await observeAgentOwnership(db, input);
  if (ownership !== "owned") return { state: ownership };

  const rows = await db
    .select({
      kind: agentSecrets.kind,
      status: agentSecrets.status,
      count: sql<number>`count(*)::int`,
    })
    .from(agentSecrets)
    .where(eq(agentSecrets.agentId, input.agentId))
    .groupBy(agentSecrets.kind, agentSecrets.status);

  const counts = emptySecretCounts();
  for (const row of rows) counts[row.kind][row.status] = Number(row.count);

  return {
    state: "observed",
    counts,
    allRevoked: Object.values(counts).every((count) => count.active === 0),
  };
}

export type HermesRunnerCredentialObservation =
  | { state: "observed"; activeCount: number; allRevoked: boolean }
  | { state: "invalid_input" | "runner_missing" | "runner_not_owned" };

export async function observeHermesRunnerCredentialCount(
  db: StagingReadDatabase,
  input: { userId: string; runnerId: string },
): Promise<HermesRunnerCredentialObservation> {
  if (!areUuids(input.userId, input.runnerId)) return { state: "invalid_input" };

  const [runner] = await db
    .select({ userId: runners.userId })
    .from(runners)
    .where(eq(runners.id, input.runnerId))
    .limit(1);
  if (!runner) return { state: "runner_missing" };
  if (runner.userId !== input.userId) return { state: "runner_not_owned" };

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(runnerCredentials)
    .where(
      and(eq(runnerCredentials.runnerId, input.runnerId), eq(runnerCredentials.status, "active")),
    );
  const activeCount = Number(row?.count ?? 0);
  return { state: "observed", activeCount, allRevoked: activeCount === 0 };
}

export type HermesResourceAbsenceObservation =
  | {
      state: "observed";
      workload: "recorded_present" | "recorded_absent";
      agent: "active" | "deleted" | "absent";
      runner: "active" | "deleted" | "absent";
      allAbsent: boolean;
    }
  | { state: "invalid_input" | "ownership_mismatch" };

export async function observeHermesResourceAbsence(
  db: StagingReadDatabase,
  input: { userId: string; agentId: string; runnerId: string },
): Promise<HermesResourceAbsenceObservation> {
  if (!areUuids(input.userId, input.agentId, input.runnerId)) {
    return { state: "invalid_input" };
  }

  const [[agent], [runner]] = await Promise.all([
    db
      .select({ userId: agents.userId, deletedAt: agents.deletedAt })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1),
    db
      .select({ userId: runners.userId, deletedAt: runners.deletedAt })
      .from(runners)
      .where(eq(runners.id, input.runnerId))
      .limit(1),
  ]);

  if ((agent && agent.userId !== input.userId) || (runner && runner.userId !== input.userId)) {
    return { state: "ownership_mismatch" };
  }

  const [[localWorkload], [dockerWorkload]] = await Promise.all([
    db
      .select({ present: sql<boolean>`true` })
      .from(localRunnerProcesses)
      .where(
        and(
          eq(localRunnerProcesses.agentId, input.agentId),
          inArray(localRunnerProcesses.status, ["starting", "running"]),
        ),
      )
      .limit(1),
    db
      .select({ present: sql<boolean>`true` })
      .from(dockerRunnerContainers)
      .where(
        and(
          eq(dockerRunnerContainers.agentId, input.agentId),
          isNull(dockerRunnerContainers.finishedAt),
        ),
      )
      .limit(1),
  ]);

  const workload = localWorkload || dockerWorkload ? "recorded_present" : "recorded_absent";
  const agentPresence = !agent ? "absent" : agent.deletedAt ? "deleted" : "active";
  const runnerPresence = !runner ? "absent" : runner.deletedAt ? "deleted" : "active";

  return {
    state: "observed",
    workload,
    agent: agentPresence,
    runner: runnerPresence,
    allAbsent:
      workload === "recorded_absent" && agentPresence !== "active" && runnerPresence !== "active",
  };
}

export type HermesUsagePeriodObservation =
  | { state: "observed"; openPeriod: "present" | "absent"; openCount: number }
  | { state: "invalid_input" | "agent_missing" | "agent_not_owned" };

export async function observeHermesOpenUsagePeriod(
  db: StagingReadDatabase,
  input: { userId: string; agentId: string },
): Promise<HermesUsagePeriodObservation> {
  if (!areUuids(input.userId, input.agentId)) return { state: "invalid_input" };
  const ownership = await observeAgentOwnership(db, input);
  if (ownership !== "owned") return { state: ownership };

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentUsagePeriods)
    .where(and(eq(agentUsagePeriods.agentId, input.agentId), isNull(agentUsagePeriods.stoppedAt)));
  const openCount = Number(row?.count ?? 0);
  return {
    state: "observed",
    openPeriod: openCount === 0 ? "absent" : "present",
    openCount,
  };
}

async function observeAgentOwnership(
  db: StagingReadDatabase,
  input: { userId: string; agentId: string },
): Promise<"owned" | "agent_missing" | "agent_not_owned"> {
  const [agent] = await db
    .select({ userId: agents.userId })
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .limit(1);
  if (!agent) return "agent_missing";
  return agent.userId === input.userId ? "owned" : "agent_not_owned";
}

function emptySecretCounts(): SecretStatusCounts {
  return {
    openrouter_api_key: { active: 0, revoked: 0 },
    openai_api_key: { active: 0, revoked: 0 },
    anthropic_api_key: { active: 0, revoked: 0 },
    telegram_bot_token: { active: 0, revoked: 0 },
    telegram_allowed_users: { active: 0, revoked: 0 },
    api_server_key: { active: 0, revoked: 0 },
  };
}

function nextHermesReadyDeploymentStage(
  stage: HermesReadyDeploymentStage,
): Exclude<HermesReadyDeploymentStage, "pending"> | null {
  switch (stage) {
    case "pending":
      return "provisioning_runner";
    case "provisioning_runner":
      return "configuring_hermes";
    case "configuring_hermes":
      return "starting_gateway";
    case "starting_gateway":
      return "verifying_model";
    case "verifying_model":
      return "connecting_telegram";
    case "connecting_telegram":
      return "ready";
    case "ready":
      return null;
  }
}

function areUuids(...values: string[]): boolean {
  return values.every(isUuid);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isRunnerKind(value: string): value is "digitalocean" | "manual_vps" {
  return value === "digitalocean" || value === "manual_vps";
}

function isRunnerStatus(value: string): value is HermesStagingAcceptanceCorrelation extends {
  state: "matched";
  runnerStatus: infer Status;
}
  ? Status
  : never {
  return [
    "active",
    "inactive",
    "registering",
    "online",
    "offline",
    "degraded",
    "provisioning",
    "provision_failed",
    "deleting",
    "deleted",
  ].includes(value);
}
