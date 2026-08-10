import "server-only";

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import { parseAgentDeploymentChoices } from "@/src/server/agents/agent-deployment-choices";
import { replaceDeploymentWakeupInTransaction } from "@/src/server/agents/agent-deployment-dispatch";
import {
  type AgentDeploymentDto,
  mapAgentDeploymentRowToDto,
} from "@/src/server/agents/deployment-dto";
import {
  normalizeDeploymentIdempotencyKey,
  validateDeploymentConfigRevision,
} from "@/src/server/agents/deployment-state";
import {
  deploymentEnvironmentForRuntime,
  isRolloutConfigurationGeneration,
  initialCohortForAssignedRunner,
} from "@/src/server/agents/deployment-slo-identity";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import { agentDeployments, agentEvents, agents } from "@/src/server/db/schema";

type AgentDeploymentRetryTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPLACEMENT_INTERRUPTED_CODE = "runner_replaced";
const REPLACEMENT_INTERRUPTED_DETAIL = "Deployment was superseded by automatic runner replacement.";

export type RetryAgentDeploymentResult =
  | { ok: true; deployment: AgentDeploymentDto }
  | {
      ok: false;
      reason:
        | "agent_not_found"
        | "deployment_not_retryable"
        | "invalid_idempotency_key"
        | "persistence_failed";
    };

export type RetryAgentDeploymentDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  onDeploymentCommitted?: (deploymentId: string) => void;
};

export async function createAgentDeploymentForRunnerReplacement(input: {
  tx: AgentDeploymentRetryTransaction;
  replacementId: string;
  agentId: string;
  userId: string;
  now: Date;
}): Promise<{ deploymentId: string; created: boolean } | null> {
  if (
    !UUID_PATTERN.test(input.replacementId) ||
    !UUID_PATTERN.test(input.agentId) ||
    !UUID_PATTERN.test(input.userId) ||
    Number.isNaN(input.now.getTime())
  ) {
    return null;
  }
  const idempotencyKey = replacementDeploymentIdempotencyKey(input.replacementId, input.agentId);
  const [agent] = await input.tx.execute<{ id: string }>(sql`
    select id
    from ${agents}
    where id = ${input.agentId}
      and user_id = ${input.userId}
      and desired_status = 'running'
      and deleted_at is null
    for update
    limit 1
  `);
  if (!agent) return null;

  const [replayed] = await input.tx.execute<{ id: string }>(sql`
    select id
    from ${agentDeployments}
    where user_id = ${input.userId}
      and agent_id = ${input.agentId}
      and idempotency_key = ${idempotencyKey}
    limit 1
  `);
  if (replayed) return { deploymentId: replayed.id, created: false };

  const [latest] = await input.tx.execute<{
    configRevision: string;
    deploymentChoices: unknown;
    rolloutConfigurationGeneration: number | null;
  }>(sql`
    select config_revision as "configRevision",
      deployment_choices as "deploymentChoices",
      rollout_configuration_generation as "rolloutConfigurationGeneration"
    from ${agentDeployments}
    where user_id = ${input.userId}
      and agent_id = ${input.agentId}
    order by created_at desc, id desc
    limit 1
  `);
  const deploymentChoices = latest ? parseAgentDeploymentChoices(latest.deploymentChoices) : null;
  if (
    !latest ||
    !validateDeploymentConfigRevision(latest.configRevision) ||
    !isRolloutConfigurationGeneration(latest.rolloutConfigurationGeneration) ||
    !deploymentChoices ||
    deploymentChoices.rolloutConfigurationGeneration !== latest.rolloutConfigurationGeneration
  ) {
    return null;
  }

  await input.tx.execute(sql`
    update ${agentDeployments}
    set stage = 'failed',
        error_code = ${REPLACEMENT_INTERRUPTED_CODE},
        error_detail = ${REPLACEMENT_INTERRUPTED_DETAIL},
        next_attempt_at = null,
        lease_owner = null,
        lease_expires_at = null,
        failed_at = ${input.now.toISOString()},
        updated_at = ${input.now.toISOString()}
    where user_id = ${input.userId}
      and agent_id = ${input.agentId}
      and stage not in ('ready', 'failed')
  `);

  const [created] = await input.tx
    .insert(agentDeployments)
    .values({
      agentId: input.agentId,
      userId: input.userId,
      configRevision: latest.configRevision,
      idempotencyKey,
      nextAttemptAt: input.now,
      acceptedAt: sql`clock_timestamp()`,
      origin: "runner_replacement",
      initialCohort: "unknown",
      deploymentEnvironment: deploymentEnvironmentForRuntime(),
      rolloutConfigurationGeneration: latest.rolloutConfigurationGeneration,
      deploymentChoices,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: agentDeployments.id });
  if (!created) return null;

  await replaceDeploymentWakeupInTransaction(input.tx, {
    deploymentId: created.id,
    dueAt: input.now,
    now: input.now,
  });

  await input.tx.insert(agentEvents).values({
    agentId: input.agentId,
    actorUserId: input.userId,
    type: "agent.deployment_retry_requested",
    message: "Automatic deployment retry requested after runner replacement.",
    metadata: {
      deploymentId: created.id,
      replacementId: input.replacementId,
      launchMode: "ready",
    },
    createdAt: input.now,
  });
  return { deploymentId: created.id, created: true };
}

export function replacementDeploymentIdempotencyKey(
  replacementId: string,
  agentId: string,
): string {
  return `runner-replacement:${replacementId}:${agentId}`;
}

type RetryDeploymentRow = {
  id: string;
  agentId: string;
  stage: string;
  configRevision: string;
  attemptCount: number;
  errorCode: string | null;
  errorDetail: string | null;
  nextAttemptAt: Date | string | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  failedAt: Date | string | null;
  acceptedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export async function retryAgentDeploymentForUser(input: {
  userId: string;
  agentId: string;
  idempotencyKey: string;
  dependencies?: RetryAgentDeploymentDependencies;
}): Promise<RetryAgentDeploymentResult> {
  const agentId = input.agentId.trim();

  if (!isValidAgentId(agentId)) {
    return { ok: false, reason: "agent_not_found" };
  }

  const normalizedKey = normalizeDeploymentIdempotencyKey(input.idempotencyKey);

  if (!normalizedKey.ok) {
    return { ok: false, reason: "invalid_idempotency_key" };
  }

  const connection = input.dependencies?.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.dependencies?.createConnection;
  const now = input.dependencies?.now?.() ?? new Date();
  let insertedDeploymentId: string | null = null;

  try {
    const row = await connection.db.transaction(async (tx) => {
      const [agent] = await tx.execute<{
        id: string;
        desiredStatus: string;
        runnerId: string | null;
      }>(sql`
        select id, desired_status as "desiredStatus", runner_id as "runnerId"
        from ${agents}
        where id = ${agentId}
          and user_id = ${input.userId}
          and deleted_at is null
        for update
        limit 1
      `);

      if (!agent) {
        return { kind: "agent_not_found" as const };
      }

      if (agent.desiredStatus !== "running") {
        return { kind: "deployment_not_retryable" as const };
      }

      const [sameKey] = await tx.execute<RetryDeploymentRow & { retryRequested: boolean }>(sql`
        select
          id,
          agent_id as "agentId",
          stage,
          config_revision as "configRevision",
          attempt_count as "attemptCount",
          error_code as "errorCode",
          error_detail as "errorDetail",
          next_attempt_at as "nextAttemptAt",
          started_at as "startedAt",
          completed_at as "completedAt",
          failed_at as "failedAt",
          accepted_at as "acceptedAt",
          created_at as "createdAt",
          updated_at as "updatedAt",
          exists (
            select 1
            from ${agentEvents}
            where agent_id = ${agentId}
              and type = 'agent.deployment_retry_requested'
              and metadata ->> 'deploymentId' = ${agentDeployments.id}::text
          ) as "retryRequested"
        from ${agentDeployments}
        where user_id = ${input.userId}
          and agent_id = ${agentId}
          and idempotency_key = ${normalizedKey.value}
        limit 1
      `);

      if (sameKey) {
        return sameKey.retryRequested
          ? { kind: "deployment" as const, row: sameKey }
          : { kind: "deployment_not_retryable" as const };
      }

      const [keyUsedByAnotherAgent] = await tx.execute<{ id: string }>(sql`
        select id
        from ${agentDeployments}
        where user_id = ${input.userId}
          and idempotency_key = ${normalizedKey.value}
        limit 1
      `);

      if (keyUsedByAnotherAgent) {
        return { kind: "deployment_not_retryable" as const };
      }

      const [active] = await tx.execute<{ id: string }>(sql`
        select id
        from ${agentDeployments}
        where agent_id = ${agentId}
          and stage not in ('ready', 'failed')
        limit 1
      `);

      if (active) {
        return { kind: "deployment_not_retryable" as const };
      }

      const [latest] = await tx.execute<{
        configRevision: string;
        deploymentChoices: unknown;
        rolloutConfigurationGeneration: number | null;
        stage: string;
      }>(sql`
        select config_revision as "configRevision",
          deployment_choices as "deploymentChoices",
          rollout_configuration_generation as "rolloutConfigurationGeneration",
          stage
        from ${agentDeployments}
        where agent_id = ${agentId}
          and user_id = ${input.userId}
        order by created_at desc, id desc
        limit 1
      `);

      const deploymentChoices = latest
        ? parseAgentDeploymentChoices(latest.deploymentChoices)
        : null;
      if (
        latest?.stage !== "failed" ||
        !validateDeploymentConfigRevision(latest.configRevision) ||
        !isRolloutConfigurationGeneration(latest.rolloutConfigurationGeneration) ||
        !deploymentChoices ||
        deploymentChoices.rolloutConfigurationGeneration !== latest.rolloutConfigurationGeneration
      ) {
        return { kind: "deployment_not_retryable" as const };
      }

      const [created] = await tx.execute<RetryDeploymentRow>(sql`
        insert into ${agentDeployments} (
          agent_id,
          user_id,
          config_revision,
          idempotency_key,
          accepted_at,
          origin,
          initial_cohort,
          deployment_environment,
          rollout_configuration_generation,
          deployment_choices,
          created_at,
          updated_at
        )
        values (
          ${agentId},
          ${input.userId},
          ${latest.configRevision},
          ${normalizedKey.value},
          clock_timestamp(),
          'owner_request',
          ${initialCohortForAssignedRunner(agent.runnerId)},
          ${deploymentEnvironmentForRuntime()},
          ${latest.rolloutConfigurationGeneration},
          ${JSON.stringify(deploymentChoices)}::jsonb,
          ${now.toISOString()},
          ${now.toISOString()}
        )
        returning
          id,
          agent_id as "agentId",
          stage,
          config_revision as "configRevision",
          attempt_count as "attemptCount",
          error_code as "errorCode",
          error_detail as "errorDetail",
          next_attempt_at as "nextAttemptAt",
          started_at as "startedAt",
          completed_at as "completedAt",
          failed_at as "failedAt",
          accepted_at as "acceptedAt",
          created_at as "createdAt",
          updated_at as "updatedAt"
      `);

      if (!created) {
        return { kind: "deployment_not_retryable" as const };
      }

      insertedDeploymentId = created.id;

      await replaceDeploymentWakeupInTransaction(tx, {
        deploymentId: created.id,
        dueAt: now,
        now,
      });

      await tx.insert(agentEvents).values({
        agentId,
        actorUserId: input.userId,
        type: "agent.deployment_retry_requested",
        message: "Automatic deployment retry requested.",
        metadata: {
          deploymentId: created.id,
          launchMode: "ready",
        },
        createdAt: now,
      });

      return { kind: "deployment" as const, row: created };
    });

    if (row.kind === "deployment") {
      if (insertedDeploymentId) {
        try {
          input.dependencies?.onDeploymentCommitted?.(insertedDeploymentId);
        } catch {
          // The committed retry remains due for protected cron reconciliation.
        }
      }

      return { ok: true, deployment: mapAgentDeploymentRowToDto(row.row) };
    }

    return { ok: false, reason: row.kind };
  } catch {
    return { ok: false, reason: "persistence_failed" };
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}
