import "server-only";

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  AGENT_RUNTIME_ERROR_CODES,
  AGENT_RUNTIME_STATES,
  type AgentRuntimeErrorCode,
  type AgentRuntimeState,
  MAX_RUNTIME_COUNTER,
  parseAgentRuntimeErrorCode,
  parseAgentRuntimeState,
} from "@/src/server/agents/agent-runtime-state";
import { validateDeploymentConfigRevision } from "@/src/server/agents/deployment-state";
import { agentRuntimeReconciliations, agents, runners } from "@/src/server/db/schema";
import type * as schema from "@/src/server/db/schema";

type AgentRuntimeTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type AgentRuntimeDatabase = PostgresJsDatabase<typeof schema> | AgentRuntimeTransaction;

export { AGENT_RUNTIME_ERROR_CODES, AGENT_RUNTIME_STATES };
export type AgentRuntimeReconciliationState = AgentRuntimeState;
export type { AgentRuntimeErrorCode };

export const AGENT_RUNTIME_LEASE_MS = 90_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEASE_OWNER_PATTERN =
  /^reconcile:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type AgentRuntimeClaimTarget =
  | { kind: "global" }
  | { kind: "runner"; runnerId: string }
  | { kind: "agent"; agentId: string };

export type ClaimedAgentRuntimeReconciliation = {
  agentId: string;
  userId: string;
  state: AgentRuntimeReconciliationState;
  generation: number;
  configRevision: string;
  operationId: string | null;
  attemptCount: number;
  recoveryCount: number;
  recoveryWindowStartedAt: Date | string | null;
  stableSince: Date | string | null;
  telegramNonConnectedSince: Date | string | null;
  lastRestartCount: number | null;
  lastObservedAt: Date | string | null;
  lastReadyAt: Date | string | null;
  errorCode: AgentRuntimeErrorCode | null;
  nextAttemptAt: Date | string | null;
  leaseOwner: string;
  leaseExpiresAt: Date | string;
  circuitOpenedAt: Date | string | null;
  runnerId: string;
  desiredStatus: "running" | "stopped";
  latestDeploymentId: string;
};

export type RuntimeResultMutation = {
  state: AgentRuntimeReconciliationState;
  generation?: number;
  attemptCount?: number;
  operationId?: string | null;
  recoveryCount?: number;
  recoveryWindowStartedAt?: Date | null;
  stableSince?: Date | null;
  telegramNonConnectedSince?: Date | null;
  lastRestartCount?: number | null;
  lastObservedAt?: Date | null;
  lastReadyAt?: Date | null;
  errorCode?: AgentRuntimeErrorCode | null;
  nextAttemptAt: Date | null;
  circuitOpenedAt?: Date | null;
};

export class AgentRuntimePersistenceError extends Error {
  constructor(cause?: unknown) {
    super("Agent runtime persistence failed.");
    this.name = "AgentRuntimePersistenceError";
    this.cause = cause;
  }
}

export async function initializeAgentRuntimeAfterDeploymentReady(input: {
  db: AgentRuntimeDatabase;
  deploymentId: string;
  agentId: string;
  userId: string;
  configRevision: string;
  operationId: string;
  now: Date;
}): Promise<{ inserted: boolean }> {
  if (
    !isUuid(input.agentId) ||
    !isUuid(input.userId) ||
    !isUuid(input.deploymentId) ||
    !isUuid(input.operationId) ||
    !validateDeploymentConfigRevision(input.configRevision) ||
    !isValidDate(input.now)
  ) {
    throw new AgentRuntimePersistenceError(new Error("Invalid ready runtime initialization."));
  }

  try {
    const persisted = await input.db.execute<{ inserted: boolean }>(sql`
      insert into ${agentRuntimeReconciliations} (
        agent_id,
        user_id,
        state,
        generation,
        config_revision,
        operation_id,
        attempt_count,
        recovery_count,
        stable_since,
        last_observed_at,
        last_ready_at,
        next_attempt_at,
        created_at,
        updated_at
      )
      select
        ${input.agentId},
        ${input.userId},
        'observing',
        0,
        ${input.configRevision},
        ${input.operationId},
        0,
        0,
        ${input.now.toISOString()},
        ${input.now.toISOString()},
        ${input.now.toISOString()},
        ${input.now.toISOString()},
        ${input.now.toISOString()},
        ${input.now.toISOString()}
      where exists (
        select 1
        from ${agents}
        where ${agents.id} = ${input.agentId}
          and ${agents.userId} = ${input.userId}
          and ${agents.deletedAt} is null
          and ${agents.desiredStatus} = 'running'
          and ${agents.runnerId} is not null
          and exists (
            select 1
            from ${runners}
            where ${runners.id} = ${agents.runnerId}
              and ${runners.userId} = ${input.userId}
              and ${runners.deletedAt} is null
          )
      )
        and exists (
          select 1
          from agent_deployments as finalized_deployment
          where finalized_deployment.id = ${input.deploymentId}
            and finalized_deployment.agent_id = ${input.agentId}
            and finalized_deployment.user_id = ${input.userId}
            and finalized_deployment.stage = 'ready'
            and finalized_deployment.config_revision = ${input.configRevision}
            and finalized_deployment.runner_operation_id = ${input.operationId}
            and finalized_deployment.runner_accepted_at is not null
            and finalized_deployment.completed_at is not null
            and finalized_deployment.canary_state in ('passed', 'skipped')
            and (
              (
                finalized_deployment.canary_state = 'passed'
                and finalized_deployment.canary_attempted_at is not null
                and finalized_deployment.canary_completed_at is not null
                and finalized_deployment.canary_completed_at >= finalized_deployment.canary_attempted_at
              )
              or (
                finalized_deployment.canary_state = 'skipped'
                and finalized_deployment.canary_attempted_at is null
                and finalized_deployment.canary_completed_at is null
              )
            )
            and finalized_deployment.completed_at >= finalized_deployment.runner_accepted_at
            and (
              finalized_deployment.canary_completed_at is null
              or finalized_deployment.completed_at >= finalized_deployment.canary_completed_at
            )
            and not exists (
              select 1
              from agent_deployments as newer_deployment
              where newer_deployment.agent_id = finalized_deployment.agent_id
                and newer_deployment.user_id = finalized_deployment.user_id
                and (
                  newer_deployment.created_at > finalized_deployment.created_at
                  or (
                    newer_deployment.created_at = finalized_deployment.created_at
                    and newer_deployment.id > finalized_deployment.id
                  )
                )
            )
        )
      on conflict (agent_id) do update
      set user_id = excluded.user_id,
          state = 'observing',
          config_revision = excluded.config_revision,
          operation_id = excluded.operation_id,
          attempt_count = 0,
          recovery_count = 0,
          recovery_window_started_at = null,
          stable_since = excluded.stable_since,
          telegram_non_connected_since = null,
          last_restart_count = null,
          last_observed_at = excluded.last_observed_at,
          last_ready_at = excluded.last_ready_at,
          error_code = null,
          next_attempt_at = excluded.next_attempt_at,
          lease_owner = null,
          lease_expires_at = null,
          circuit_opened_at = null,
          updated_at = excluded.updated_at
      where ${agentRuntimeReconciliations.generation} = 0
        and ${agentRuntimeReconciliations.state} = 'observing'
        and ${agentRuntimeReconciliations.leaseOwner} is null
        and ${agentRuntimeReconciliations.leaseExpiresAt} is null
        and ${agentRuntimeReconciliations.recoveryCount} = 0
        and ${agentRuntimeReconciliations.recoveryWindowStartedAt} is null
        and ${agentRuntimeReconciliations.stableSince} is not null
        and ${agentRuntimeReconciliations.telegramNonConnectedSince} is null
        and ${agentRuntimeReconciliations.lastObservedAt} is not null
        and ${agentRuntimeReconciliations.lastReadyAt} is not null
        and ${agentRuntimeReconciliations.errorCode} is null
        and ${agentRuntimeReconciliations.circuitOpenedAt} is null
        and (
          ${agentRuntimeReconciliations.configRevision} is distinct from excluded.config_revision
          or ${agentRuntimeReconciliations.operationId} is distinct from excluded.operation_id
        )
      returning (xmax = 0) as inserted
    `);

    return { inserted: persisted[0]?.inserted === true };
  } catch (error) {
    throw new AgentRuntimePersistenceError(error);
  }
}

export async function claimNextAgentRuntimeReconciliation(input: {
  db: AgentRuntimeDatabase;
  target: AgentRuntimeClaimTarget;
  leaseOwner: string;
  now: Date;
}): Promise<ClaimedAgentRuntimeReconciliation | null> {
  if (!validateClaimInput(input)) {
    throw new AgentRuntimePersistenceError(new Error("Invalid runtime claim input."));
  }

  const nowIso = input.now.toISOString();
  const leaseExpiresAt = new Date(input.now.getTime() + AGENT_RUNTIME_LEASE_MS).toISOString();
  const targetSql =
    input.target.kind === "runner"
      ? sql`and ${agents.runnerId} = ${input.target.runnerId}`
      : input.target.kind === "agent"
        ? sql`and ${agentRuntimeReconciliations.agentId} = ${input.target.agentId}`
        : sql``;

  try {
    const [claimed] = await input.db.execute<ClaimedAgentRuntimeReconciliation>(sql`
      with next_runtime as (
        select
          ${agentRuntimeReconciliations.agentId} as agent_id,
          ${agentRuntimeReconciliations.generation} as generation,
          ${agents.runnerId} as runner_id,
          ${agents.desiredStatus} as desired_status,
          latest_deployment.id as latest_deployment_id
        from ${agentRuntimeReconciliations}
        inner join ${agents}
          on ${agents.id} = ${agentRuntimeReconciliations.agentId}
         and ${agents.userId} = ${agentRuntimeReconciliations.userId}
        inner join ${runners}
          on ${runners.id} = ${agents.runnerId}
         and ${runners.userId} = ${agentRuntimeReconciliations.userId}
         and ${runners.deletedAt} is null
        inner join lateral (
          select deployment.id, deployment.stage
          from agent_deployments as deployment
          where deployment.agent_id = ${agentRuntimeReconciliations.agentId}
            and deployment.user_id = ${agentRuntimeReconciliations.userId}
          order by deployment.created_at desc, deployment.id desc
          limit 1
        ) as latest_deployment on true
        where ${agentRuntimeReconciliations.state} not in ('stopped', 'circuit_open')
          and ${agentRuntimeReconciliations.nextAttemptAt} <= ${nowIso}
          and (${agentRuntimeReconciliations.leaseExpiresAt} is null or ${agentRuntimeReconciliations.leaseExpiresAt} <= ${nowIso})
          and ${agentRuntimeReconciliations.attemptCount} < ${MAX_RUNTIME_COUNTER}
          and ${agents.deletedAt} is null
          and ${agents.runnerId} is not null
          and latest_deployment.stage = 'ready'
          ${targetSql}
        order by ${agentRuntimeReconciliations.nextAttemptAt}, ${agentRuntimeReconciliations.updatedAt}, ${agentRuntimeReconciliations.agentId}
        for update of ${agentRuntimeReconciliations} skip locked
        limit 1
      )
      update ${agentRuntimeReconciliations}
      set lease_owner = ${input.leaseOwner},
          lease_expires_at = ${leaseExpiresAt},
          attempt_count = ${agentRuntimeReconciliations.attemptCount} + 1,
          updated_at = ${nowIso}
      from next_runtime
      where ${agentRuntimeReconciliations.agentId} = next_runtime.agent_id
        and ${agentRuntimeReconciliations.generation} = next_runtime.generation
      returning
        ${agentRuntimeReconciliations.agentId} as "agentId",
        ${agentRuntimeReconciliations.userId} as "userId",
        ${agentRuntimeReconciliations.state} as state,
        ${agentRuntimeReconciliations.generation} as generation,
        ${agentRuntimeReconciliations.configRevision} as "configRevision",
        ${agentRuntimeReconciliations.operationId} as "operationId",
        ${agentRuntimeReconciliations.attemptCount} as "attemptCount",
        ${agentRuntimeReconciliations.recoveryCount} as "recoveryCount",
        ${agentRuntimeReconciliations.recoveryWindowStartedAt} as "recoveryWindowStartedAt",
        ${agentRuntimeReconciliations.stableSince} as "stableSince",
        ${agentRuntimeReconciliations.telegramNonConnectedSince} as "telegramNonConnectedSince",
        ${agentRuntimeReconciliations.lastRestartCount} as "lastRestartCount",
        ${agentRuntimeReconciliations.lastObservedAt} as "lastObservedAt",
        ${agentRuntimeReconciliations.lastReadyAt} as "lastReadyAt",
        ${agentRuntimeReconciliations.errorCode} as "errorCode",
        ${agentRuntimeReconciliations.nextAttemptAt} as "nextAttemptAt",
        ${agentRuntimeReconciliations.leaseOwner} as "leaseOwner",
        ${agentRuntimeReconciliations.leaseExpiresAt} as "leaseExpiresAt",
        ${agentRuntimeReconciliations.circuitOpenedAt} as "circuitOpenedAt",
        next_runtime.runner_id as "runnerId",
        next_runtime.desired_status as "desiredStatus",
        next_runtime.latest_deployment_id as "latestDeploymentId"
    `);

    return claimed ?? null;
  } catch (error) {
    throw new AgentRuntimePersistenceError(error);
  }
}

export async function applyClaimedAgentRuntimeResult(input: {
  db: AgentRuntimeDatabase;
  claim: ClaimedAgentRuntimeReconciliation;
  expectedDesiredStatus: "running" | "stopped";
  now: Date;
  mutation: RuntimeResultMutation;
}): Promise<boolean> {
  if (!validateResultMutation(input)) {
    throw new AgentRuntimePersistenceError(new Error("Invalid runtime result mutation."));
  }

  const mutation = normalizeResultMutation(input.mutation);

  try {
    const [updated] = await input.db
      .update(agentRuntimeReconciliations)
      .set({
        state: mutation.state,
        generation: mutation.generation,
        attemptCount: mutation.attemptCount,
        operationId: mutation.operationId,
        recoveryCount: mutation.recoveryCount,
        recoveryWindowStartedAt: mutation.recoveryWindowStartedAt,
        stableSince: mutation.stableSince,
        telegramNonConnectedSince: mutation.telegramNonConnectedSince,
        lastRestartCount: mutation.lastRestartCount,
        lastObservedAt: mutation.lastObservedAt,
        lastReadyAt: mutation.lastReadyAt,
        errorCode: mutation.errorCode,
        nextAttemptAt: mutation.nextAttemptAt,
        circuitOpenedAt: mutation.circuitOpenedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      })
      .where(sql`
        ${agentRuntimeReconciliations.agentId} = ${input.claim.agentId}
        and ${agentRuntimeReconciliations.userId} = ${input.claim.userId}
        and ${agentRuntimeReconciliations.generation} = ${input.claim.generation}
        and ${agentRuntimeReconciliations.state} = ${input.claim.state}
        and ${agentRuntimeReconciliations.configRevision} = ${input.claim.configRevision}
        and ${agentRuntimeReconciliations.operationId} is not distinct from ${input.claim.operationId}
        and ${agentRuntimeReconciliations.leaseOwner} = ${input.claim.leaseOwner}
        and ${agentRuntimeReconciliations.leaseExpiresAt} > ${input.now.toISOString()}
        and exists (
          select 1
          from ${agents}
          where ${agents.id} = ${input.claim.agentId}
            and ${agents.userId} = ${input.claim.userId}
            and ${agents.deletedAt} is null
            and ${agents.desiredStatus} = ${input.expectedDesiredStatus}
            and ${agents.runnerId} = ${input.claim.runnerId}
            and exists (
              select 1
              from ${runners}
              where ${runners.id} = ${input.claim.runnerId}
                and ${runners.userId} = ${input.claim.userId}
                and ${runners.deletedAt} is null
            )
        )
        and exists (
          select 1
          from agent_deployments as expected_deployment
          where expected_deployment.id = ${input.claim.latestDeploymentId}
            and expected_deployment.agent_id = ${input.claim.agentId}
            and expected_deployment.user_id = ${input.claim.userId}
            and expected_deployment.stage = 'ready'
            and not exists (
              select 1
              from agent_deployments as newer_deployment
              where newer_deployment.agent_id = expected_deployment.agent_id
                and newer_deployment.user_id = expected_deployment.user_id
                and (
                  newer_deployment.created_at > expected_deployment.created_at
                  or (
                    newer_deployment.created_at = expected_deployment.created_at
                    and newer_deployment.id > expected_deployment.id
                  )
                )
            )
        )
      `)
      .returning({ agentId: agentRuntimeReconciliations.agentId });

    return updated !== undefined;
  } catch (error) {
    throw new AgentRuntimePersistenceError(error);
  }
}

export async function invalidateAgentRuntimeLease(input: {
  db: AgentRuntimeDatabase;
  agentId: string;
  userId: string;
  expectedGeneration: number;
  now: Date;
}): Promise<number | null> {
  if (
    !isUuid(input.agentId) ||
    !isUuid(input.userId) ||
    !isBoundedCounter(input.expectedGeneration) ||
    input.expectedGeneration === MAX_RUNTIME_COUNTER ||
    !isValidDate(input.now)
  ) {
    throw new AgentRuntimePersistenceError(new Error("Invalid runtime generation fence."));
  }

  try {
    const [updated] = await input.db
      .update(agentRuntimeReconciliations)
      .set({
        generation: input.expectedGeneration + 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        updatedAt: input.now,
      })
      .where(sql`
        ${agentRuntimeReconciliations.agentId} = ${input.agentId}
        and ${agentRuntimeReconciliations.userId} = ${input.userId}
        and ${agentRuntimeReconciliations.generation} = ${input.expectedGeneration}
      `)
      .returning({ generation: agentRuntimeReconciliations.generation });

    return updated?.generation ?? null;
  } catch (error) {
    throw new AgentRuntimePersistenceError(error);
  }
}

function validateClaimInput(input: {
  target: AgentRuntimeClaimTarget;
  leaseOwner: string;
  now: Date;
}): boolean {
  if (!LEASE_OWNER_PATTERN.test(input.leaseOwner) || !isValidDate(input.now)) {
    return false;
  }

  if (input.target.kind === "runner") {
    return isUuid(input.target.runnerId);
  }

  if (input.target.kind === "agent") {
    return isUuid(input.target.agentId);
  }

  return input.target.kind === "global";
}

function validateResultMutation(input: {
  claim: ClaimedAgentRuntimeReconciliation;
  expectedDesiredStatus: "running" | "stopped";
  now: Date;
  mutation: RuntimeResultMutation;
}): boolean {
  const { claim, mutation } = input;

  if (
    !isUuid(claim.agentId) ||
    !isUuid(claim.userId) ||
    !isUuid(claim.runnerId) ||
    !isUuid(claim.latestDeploymentId) ||
    !LEASE_OWNER_PATTERN.test(claim.leaseOwner) ||
    !isBoundedCounter(claim.generation) ||
    parseAgentRuntimeState(claim.state) === null ||
    parseAgentRuntimeState(mutation.state) === null ||
    !validateDeploymentConfigRevision(claim.configRevision) ||
    !isValidDate(input.now)
  ) {
    return false;
  }

  if (mutation.operationId !== undefined && mutation.operationId !== null) {
    if (!isUuid(mutation.operationId) || !["observing", "verifying"].includes(mutation.state)) {
      return false;
    }
  }

  if (
    mutation.errorCode !== undefined &&
    mutation.errorCode !== null &&
    parseAgentRuntimeErrorCode(mutation.errorCode) === null
  ) {
    return false;
  }

  if (mutation.recoveryCount !== undefined && !isBoundedCounter(mutation.recoveryCount)) {
    return false;
  }

  if (mutation.attemptCount !== undefined && !isBoundedCounter(mutation.attemptCount)) {
    return false;
  }

  if (mutation.generation !== undefined) {
    if (
      !isBoundedCounter(mutation.generation) ||
      (mutation.generation !== claim.generation && mutation.generation !== claim.generation + 1)
    ) {
      return false;
    }

    if (
      mutation.generation === claim.generation + 1 &&
      (claim.generation === MAX_RUNTIME_COUNTER ||
        input.expectedDesiredStatus !== "stopped" ||
        mutation.state !== "stopping")
    ) {
      return false;
    }
  }

  if (mutation.lastRestartCount !== undefined && mutation.lastRestartCount !== null) {
    if (!isBoundedCounter(mutation.lastRestartCount)) {
      return false;
    }
  }

  if (mutation.nextAttemptAt !== null && mutation.nextAttemptAt < input.now) {
    return false;
  }

  const dates = [
    mutation.recoveryWindowStartedAt,
    mutation.stableSince,
    mutation.telegramNonConnectedSince,
    mutation.lastObservedAt,
    mutation.lastReadyAt,
    mutation.nextAttemptAt,
    mutation.circuitOpenedAt,
  ];

  return dates.every((date) => date === undefined || date === null || isValidDate(date));
}

function normalizeResultMutation(mutation: RuntimeResultMutation): RuntimeResultMutation {
  if (mutation.state === "stopped") {
    return {
      ...mutation,
      attemptCount: 0,
      operationId: null,
      recoveryCount: 0,
      recoveryWindowStartedAt: null,
      stableSince: null,
      telegramNonConnectedSince: null,
      errorCode: null,
      nextAttemptAt: null,
      circuitOpenedAt: null,
    };
  }

  if (mutation.state === "circuit_open") {
    return {
      ...mutation,
      operationId: null,
      stableSince: null,
      telegramNonConnectedSince: null,
      nextAttemptAt: null,
    };
  }

  if (mutation.state !== "observing" && mutation.state !== "verifying") {
    return { ...mutation, operationId: null };
  }

  return mutation;
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isBoundedCounter(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_RUNTIME_COUNTER;
}

function isValidDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}
