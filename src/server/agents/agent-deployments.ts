import "server-only";

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import {
  assertTransactionHandle,
  replaceDeploymentWakeupInTransaction,
} from "@/src/server/agents/agent-deployment-dispatch";
import {
  mapAgentDeploymentRowToDto,
  type AgentDeploymentDto,
  type AgentDeploymentRowForDto,
} from "@/src/server/agents/deployment-dto";
import {
  checkAgentDeploymentTransition,
  type AgentDeploymentStage,
  isTerminalAgentDeploymentStage,
  normalizeDeploymentErrorDetail,
  normalizeDeploymentIdempotencyKey,
  validateDeploymentConfigRevision,
  validateDeploymentErrorCode,
  validateDeploymentLeaseDurationMs,
  validateDeploymentLeaseOwner,
} from "@/src/server/agents/deployment-state";
import {
  type AgentDeploymentEnvironment,
  deploymentEnvironmentForRuntime,
  initialCohortForAssignedRunner,
} from "@/src/server/agents/deployment-slo-identity";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentDeployments, agents } from "@/src/server/db/schema";
import type * as schema from "@/src/server/db/schema";

export type AgentDeploymentTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type AgentDeploymentDatabase =
  | PostgresJsDatabase<typeof schema>
  | AgentDeploymentTransaction;

type AgentDeploymentSqlRow = AgentDeploymentRowForDto & {
  userId: string;
  idempotencyKey: string;
  leaseOwner: string | null;
  leaseExpiresAt: Date | string | null;
};

export type AgentDeploymentDependencies = {
  createConnection?: () => DatabaseConnection;
};

export class AgentDeploymentPersistenceError extends Error {
  constructor(cause?: unknown) {
    super("Agent deployment persistence failed.");
    this.name = "AgentDeploymentPersistenceError";
    this.cause = cause;
  }
}

export type CreateAgentDeploymentResult =
  | {
      ok: true;
      deployment: AgentDeploymentDto;
      inserted: boolean;
    }
  | {
      ok: false;
      reason:
        | "agent_not_found"
        | "active_deployment_exists"
        | "invalid_agent_id"
        | "invalid_config_revision"
        | "invalid_idempotency_key";
    };

export type LatestAgentDeploymentResult =
  | {
      ok: true;
      deployment: AgentDeploymentDto | null;
    }
  | {
      ok: false;
      reason: "agent_not_found" | "invalid_agent_id";
    };

export type LeaseMutationResult =
  | {
      ok: true;
      deployment: AgentDeploymentDto;
    }
  | {
      ok: false;
      reason: "invalid_lease" | "lease_not_held";
    };

export type DeploymentTransitionResult =
  | {
      ok: true;
      deployment: AgentDeploymentDto;
      noop: boolean;
    }
  | {
      ok: false;
      reason:
        | "invalid_transition"
        | "invalid_error"
        | "lease_not_held"
        | "stale_deployment"
        | "terminal_deployment";
    };

const DEPLOYMENT_RETURNING_SQL = sql`
  id,
  agent_id as "agentId",
  user_id as "userId",
  stage,
  config_revision as "configRevision",
  idempotency_key as "idempotencyKey",
  attempt_count as "attemptCount",
  error_code as "errorCode",
  error_detail as "errorDetail",
  next_attempt_at as "nextAttemptAt",
  lease_owner as "leaseOwner",
  lease_expires_at as "leaseExpiresAt",
  started_at as "startedAt",
  completed_at as "completedAt",
  failed_at as "failedAt",
  accepted_at as "acceptedAt",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

export async function createAgentDeploymentForUser(input: {
  db: AgentDeploymentTransaction;
  userId: string;
  agentId: string;
  configRevision: string;
  idempotencyKey: string;
  deploymentEnvironment?: AgentDeploymentEnvironment;
  now?: Date;
}): Promise<CreateAgentDeploymentResult> {
  assertTransactionHandle(input.db);

  const normalizedAgentId = input.agentId.trim();

  if (!isValidAgentId(normalizedAgentId)) {
    return { ok: false, reason: "invalid_agent_id" };
  }

  if (!validateDeploymentConfigRevision(input.configRevision)) {
    return { ok: false, reason: "invalid_config_revision" };
  }

  const normalizedKey = normalizeDeploymentIdempotencyKey(input.idempotencyKey);

  if (!normalizedKey.ok) {
    return normalizedKey;
  }

  const now = input.now ?? new Date();
  const nowIso = toTimestampParameter(now);

  try {
    const ownedAgent = await input.db.execute<{ id: string; runnerId: string | null }>(sql`
      select ${agents.id} as id, ${agents.runnerId} as "runnerId"
      from ${agents}
      where ${agents.id} = ${normalizedAgentId}
        and ${agents.userId} = ${input.userId}
        and ${agents.deletedAt} is null
      limit 1
      for update
    `);

    if (!ownedAgent[0]) {
      return { ok: false, reason: "agent_not_found" };
    }

    const existing = await selectDeploymentByIdempotencyKey(
      input.db,
      input.userId,
      normalizedKey.value,
    );

    if (existing) {
      return {
        ok: true,
        deployment: mapAgentDeploymentRowToDto(existing),
        inserted: false,
      };
    }

    const activeDeployment = await input.db.execute<{ id: string }>(sql`
      select ${agentDeployments.id} as id
      from ${agentDeployments}
      where ${agentDeployments.agentId} = ${normalizedAgentId}
        and ${agentDeployments.stage} not in ('ready', 'failed')
      limit 1
    `);

    if (activeDeployment[0]) {
      return { ok: false, reason: "active_deployment_exists" };
    }

    const insertedRows = await input.db.execute<AgentDeploymentSqlRow>(sql`
      insert into ${agentDeployments} (
        agent_id,
        user_id,
        config_revision,
        idempotency_key,
        accepted_at,
        origin,
        initial_cohort,
        deployment_environment,
        created_at,
        updated_at
      )
      values (
        ${normalizedAgentId},
        ${input.userId},
        ${input.configRevision},
        ${normalizedKey.value},
        clock_timestamp(),
        'owner_request',
        ${initialCohortForAssignedRunner(ownedAgent[0].runnerId)},
        ${input.deploymentEnvironment ?? deploymentEnvironmentForRuntime()},
        ${nowIso},
        ${nowIso}
      )
      on conflict (user_id, idempotency_key) do nothing
      returning ${DEPLOYMENT_RETURNING_SQL}
    `);

    const inserted = insertedRows[0];

    if (inserted) {
      await replaceDeploymentWakeupInTransaction(input.db, {
        deploymentId: inserted.id,
        dueAt: now,
        now,
      });

      return {
        ok: true,
        deployment: mapAgentDeploymentRowToDto(inserted),
        inserted: true,
      };
    }

    return { ok: false, reason: "active_deployment_exists" };
  } catch (error) {
    if (isPostgresConstraintViolation(error, "agent_deployments_active_agent_idx")) {
      return { ok: false, reason: "active_deployment_exists" };
    }

    throw new AgentDeploymentPersistenceError(error);
  }
}

export async function getLatestAgentDeploymentForUser(input: {
  db: AgentDeploymentDatabase;
  userId: string;
  agentId: string;
}): Promise<LatestAgentDeploymentResult> {
  const normalizedAgentId = input.agentId.trim();

  if (!isValidAgentId(normalizedAgentId)) {
    return { ok: false, reason: "invalid_agent_id" };
  }

  try {
    const ownedAgent = await input.db.execute<{ id: string }>(sql`
      select ${agents.id} as id
      from ${agents}
      where ${agents.id} = ${normalizedAgentId}
        and ${agents.userId} = ${input.userId}
        and ${agents.deletedAt} is null
      limit 1
    `);

    if (!ownedAgent[0]) {
      return { ok: false, reason: "agent_not_found" };
    }

    const [deployment] = await input.db.execute<AgentDeploymentSqlRow>(sql`
      select ${DEPLOYMENT_RETURNING_SQL}
      from ${agentDeployments}
      where ${agentDeployments.agentId} = ${normalizedAgentId}
        and ${agentDeployments.userId} = ${input.userId}
      order by ${agentDeployments.createdAt} desc, ${agentDeployments.id} desc
      limit 1
    `);

    return {
      ok: true,
      deployment: deployment ? mapAgentDeploymentRowToDto(deployment) : null,
    };
  } catch (error) {
    throw new AgentDeploymentPersistenceError(error);
  }
}

export async function getAgentDeploymentByIdempotencyKeyForUser(input: {
  db: AgentDeploymentDatabase;
  userId: string;
  idempotencyKey: string;
}): Promise<AgentDeploymentDto | null> {
  const normalizedKey = normalizeDeploymentIdempotencyKey(input.idempotencyKey);

  if (!normalizedKey.ok) {
    return null;
  }

  try {
    const existing = await selectDeploymentByIdempotencyKey(
      input.db,
      input.userId,
      normalizedKey.value,
    );

    return existing ? mapAgentDeploymentRowToDto(existing) : null;
  } catch (error) {
    throw new AgentDeploymentPersistenceError(error);
  }
}

export async function getLatestAgentDeploymentForUserWithConnection(
  userId: string,
  agentId: string,
  dependencies: AgentDeploymentDependencies = {},
): Promise<LatestAgentDeploymentResult> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    return await connection.db.transaction((tx) =>
      getLatestAgentDeploymentForUser({ db: tx, userId, agentId }),
    );
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function claimNextAgentDeployment(input: {
  db: AgentDeploymentDatabase;
  leaseOwner: string;
  leaseDurationMs: number;
  now: Date;
}): Promise<AgentDeploymentDto | null> {
  if (
    !validateDeploymentLeaseOwner(input.leaseOwner) ||
    !validateDeploymentLeaseDurationMs(input.leaseDurationMs)
  ) {
    throw new AgentDeploymentPersistenceError(new Error("Invalid deployment lease input."));
  }

  const nowIso = toTimestampParameter(input.now);
  const leaseExpiresAt = toTimestampParameter(
    new Date(input.now.getTime() + input.leaseDurationMs),
  );

  try {
    const [claimed] = await input.db.execute<AgentDeploymentSqlRow>(sql`
      with next_deployment as (
        select ${agentDeployments.id} as id
        from ${agentDeployments}
        where ${agentDeployments.stage} not in ('ready', 'failed')
          and (${agentDeployments.nextAttemptAt} is null or ${agentDeployments.nextAttemptAt} <= ${nowIso})
          and (${agentDeployments.leaseExpiresAt} is null or ${agentDeployments.leaseExpiresAt} <= ${nowIso})
        order by ${agentDeployments.createdAt}, ${agentDeployments.id}
        for update skip locked
        limit 1
      )
      update ${agentDeployments}
      set lease_owner = ${input.leaseOwner},
          lease_expires_at = ${leaseExpiresAt},
          attempt_count = ${agentDeployments.attemptCount} + 1,
          started_at = coalesce(${agentDeployments.startedAt}, ${nowIso}),
          updated_at = ${nowIso}
      where ${agentDeployments.id} = (select id from next_deployment)
      returning ${DEPLOYMENT_RETURNING_SQL}
    `);

    return claimed ? mapAgentDeploymentRowToDto(claimed) : null;
  } catch (error) {
    throw new AgentDeploymentPersistenceError(error);
  }
}

export async function releaseAgentDeploymentLease(input: {
  db: AgentDeploymentTransaction;
  deploymentId: string;
  leaseOwner: string;
  now: Date;
  nextAttemptAt?: Date | null;
}): Promise<LeaseMutationResult> {
  assertTransactionHandle(input.db);

  if (!validateDeploymentLeaseOwner(input.leaseOwner)) {
    return { ok: false, reason: "invalid_lease" };
  }

  if (
    input.nextAttemptAt !== undefined &&
    input.nextAttemptAt !== null &&
    input.nextAttemptAt <= input.now
  ) {
    return { ok: false, reason: "invalid_lease" };
  }

  try {
    const nowIso = toTimestampParameter(input.now);
    const nextAttemptAt = input.nextAttemptAt ? toTimestampParameter(input.nextAttemptAt) : null;
    const [released] = await input.db.execute<AgentDeploymentSqlRow>(sql`
      update ${agentDeployments}
      set lease_owner = null,
          lease_expires_at = null,
          next_attempt_at = ${nextAttemptAt},
          updated_at = ${nowIso}
      where ${agentDeployments.id} = ${input.deploymentId}
        and ${agentDeployments.stage} not in ('ready', 'failed')
        and ${agentDeployments.leaseOwner} = ${input.leaseOwner}
        and ${agentDeployments.leaseExpiresAt} > ${nowIso}
      returning ${DEPLOYMENT_RETURNING_SQL}
    `);

    if (released) {
      await replaceDeploymentWakeupInTransaction(input.db, {
        deploymentId: released.id,
        dueAt: input.nextAttemptAt ?? input.now,
        now: input.now,
      });
    }

    return released
      ? { ok: true, deployment: mapAgentDeploymentRowToDto(released) }
      : { ok: false, reason: "lease_not_held" };
  } catch (error) {
    throw new AgentDeploymentPersistenceError(error);
  }
}

export async function renewAgentDeploymentLease(input: {
  db: AgentDeploymentDatabase;
  deploymentId: string;
  leaseOwner: string;
  leaseDurationMs: number;
  now: Date;
}): Promise<LeaseMutationResult> {
  if (
    !validateDeploymentLeaseOwner(input.leaseOwner) ||
    !validateDeploymentLeaseDurationMs(input.leaseDurationMs)
  ) {
    return { ok: false, reason: "invalid_lease" };
  }

  const nowIso = toTimestampParameter(input.now);
  const leaseExpiresAt = toTimestampParameter(
    new Date(input.now.getTime() + input.leaseDurationMs),
  );

  try {
    const [renewed] = await input.db.execute<AgentDeploymentSqlRow>(sql`
      update ${agentDeployments}
      set lease_expires_at = ${leaseExpiresAt},
          updated_at = ${nowIso}
      where ${agentDeployments.id} = ${input.deploymentId}
        and ${agentDeployments.stage} not in ('ready', 'failed')
        and ${agentDeployments.leaseOwner} = ${input.leaseOwner}
        and ${agentDeployments.leaseExpiresAt} > ${nowIso}
      returning ${DEPLOYMENT_RETURNING_SQL}
    `);

    return renewed
      ? { ok: true, deployment: mapAgentDeploymentRowToDto(renewed) }
      : { ok: false, reason: "lease_not_held" };
  } catch (error) {
    throw new AgentDeploymentPersistenceError(error);
  }
}

export async function transitionAgentDeploymentStage(input: {
  db: AgentDeploymentTransaction;
  deploymentId: string;
  leaseOwner: string;
  expectedStage: AgentDeploymentStage;
  nextStage: AgentDeploymentStage;
  now: Date;
  errorCode?: string;
  errorDetail?: string | null;
}): Promise<DeploymentTransitionResult> {
  assertTransactionHandle(input.db);

  const transition = checkAgentDeploymentTransition(input.expectedStage, input.nextStage);

  if (!transition.ok) {
    return transition;
  }

  if (!validateDeploymentLeaseOwner(input.leaseOwner)) {
    return { ok: false, reason: "lease_not_held" };
  }

  if (input.nextStage === "failed") {
    if (!input.errorCode || !validateDeploymentErrorCode(input.errorCode)) {
      return { ok: false, reason: "invalid_error" };
    }
  }

  const errorDetail = normalizeDeploymentErrorDetail(input.errorDetail);

  if (!errorDetail.ok) {
    return { ok: false, reason: "invalid_error" };
  }

  try {
    if (transition.kind === "same_stage") {
      const current = await selectDeploymentForLease(
        input.db,
        input.deploymentId,
        input.expectedStage,
        input.leaseOwner,
        input.now,
      );

      if (current) {
        return {
          ok: true,
          deployment: mapAgentDeploymentRowToDto(current),
          noop: true,
        };
      }

      return await classifyFailedTransition(input.db, input.deploymentId, input.expectedStage);
    }

    const nowIso = toTimestampParameter(input.now);
    const completedAt = input.nextStage === "ready" ? nowIso : null;
    const failedAt = input.nextStage === "failed" ? nowIso : null;
    const errorCode = input.nextStage === "failed" ? (input.errorCode ?? null) : null;
    const detail = input.nextStage === "failed" ? errorDetail.value : null;

    const [transitioned] = await input.db.execute<AgentDeploymentSqlRow>(sql`
      update ${agentDeployments}
      set stage = ${input.nextStage},
          error_code = ${errorCode},
          error_detail = ${detail},
          next_attempt_at = null,
          lease_owner = null,
          lease_expires_at = null,
          completed_at = ${completedAt},
          failed_at = ${failedAt},
          updated_at = ${nowIso}
      where ${agentDeployments.id} = ${input.deploymentId}
        and ${agentDeployments.stage} = ${input.expectedStage}
        and ${agentDeployments.stage} not in ('ready', 'failed')
        and ${agentDeployments.leaseOwner} = ${input.leaseOwner}
        and ${agentDeployments.leaseExpiresAt} > ${nowIso}
      returning ${DEPLOYMENT_RETURNING_SQL}
    `);

    if (transitioned) {
      await replaceDeploymentWakeupInTransaction(input.db, {
        deploymentId: transitioned.id,
        dueAt: isTerminalAgentDeploymentStage(input.nextStage) ? null : input.now,
        now: input.now,
      });

      return {
        ok: true,
        deployment: mapAgentDeploymentRowToDto(transitioned),
        noop: false,
      };
    }

    return await classifyFailedTransition(input.db, input.deploymentId, input.expectedStage);
  } catch (error) {
    throw new AgentDeploymentPersistenceError(error);
  }
}

async function selectDeploymentByIdempotencyKey(
  db: AgentDeploymentDatabase,
  userId: string,
  idempotencyKey: string,
): Promise<AgentDeploymentSqlRow | null> {
  const [row] = await db.execute<AgentDeploymentSqlRow>(sql`
    select ${DEPLOYMENT_RETURNING_SQL}
    from ${agentDeployments}
    where ${agentDeployments.userId} = ${userId}
      and ${agentDeployments.idempotencyKey} = ${idempotencyKey}
    limit 1
  `);

  return row ?? null;
}

async function selectDeploymentForLease(
  db: AgentDeploymentDatabase,
  deploymentId: string,
  expectedStage: AgentDeploymentStage,
  leaseOwner: string,
  now: Date,
): Promise<AgentDeploymentSqlRow | null> {
  const nowIso = toTimestampParameter(now);
  const [row] = await db.execute<AgentDeploymentSqlRow>(sql`
    select ${DEPLOYMENT_RETURNING_SQL}
    from ${agentDeployments}
    where ${agentDeployments.id} = ${deploymentId}
      and ${agentDeployments.stage} = ${expectedStage}
      and ${agentDeployments.stage} not in ('ready', 'failed')
      and ${agentDeployments.leaseOwner} = ${leaseOwner}
      and ${agentDeployments.leaseExpiresAt} > ${nowIso}
    limit 1
  `);

  return row ?? null;
}

async function classifyFailedTransition(
  db: AgentDeploymentDatabase,
  deploymentId: string,
  expectedStage: AgentDeploymentStage,
): Promise<Extract<DeploymentTransitionResult, { ok: false }>> {
  const [current] = await db.execute<{ stage: AgentDeploymentStage }>(sql`
    select ${agentDeployments.stage} as stage
    from ${agentDeployments}
    where ${agentDeployments.id} = ${deploymentId}
    limit 1
  `);

  if (current && isTerminalAgentDeploymentStage(current.stage)) {
    return { ok: false, reason: "terminal_deployment" };
  }

  if (!current || current.stage === expectedStage) {
    return { ok: false, reason: "lease_not_held" };
  }

  return { ok: false, reason: "stale_deployment" };
}

function isPostgresConstraintViolation(error: unknown, constraint: string, depth = 0): boolean {
  if (depth > 4) {
    return false;
  }

  if (typeof error !== "object" || error === null) {
    return false;
  }

  const code = "code" in error ? error.code : undefined;
  const message = "message" in error ? error.message : undefined;
  const constraintName =
    "constraint_name" in error
      ? error.constraint_name
      : "constraint" in error
        ? error.constraint
        : undefined;

  if (
    code === "23505" &&
    (constraintName === constraint ||
      (typeof message === "string" && message.includes(`"${constraint}"`)))
  ) {
    return true;
  }

  const cause = "cause" in error ? error.cause : undefined;

  return isPostgresConstraintViolation(cause, constraint, depth + 1);
}

function toTimestampParameter(value: Date): string {
  return value.toISOString();
}
