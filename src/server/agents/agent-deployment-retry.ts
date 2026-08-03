import "server-only";

import { sql } from "drizzle-orm";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import {
  normalizeDeploymentIdempotencyKey,
  validateDeploymentConfigRevision,
} from "@/src/server/agents/deployment-state";
import {
  mapAgentDeploymentRowToDto,
  type AgentDeploymentDto,
} from "@/src/server/agents/deployment-dto";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentDeployments, agentEvents, agents } from "@/src/server/db/schema";

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
      const [agent] = await tx.execute<{ id: string; desiredStatus: string }>(sql`
        select id, desired_status as "desiredStatus"
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

      const [latest] = await tx.execute<{ configRevision: string; stage: string }>(sql`
        select config_revision as "configRevision", stage
        from ${agentDeployments}
        where agent_id = ${agentId}
          and user_id = ${input.userId}
        order by created_at desc, id desc
        limit 1
      `);

      if (latest?.stage !== "failed" || !validateDeploymentConfigRevision(latest.configRevision)) {
        return { kind: "deployment_not_retryable" as const };
      }

      const [created] = await tx.execute<RetryDeploymentRow>(sql`
        insert into ${agentDeployments} (
          agent_id,
          user_id,
          config_revision,
          idempotency_key,
          created_at,
          updated_at
        )
        values (
          ${agentId},
          ${input.userId},
          ${latest.configRevision},
          ${normalizedKey.value},
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
          created_at as "createdAt",
          updated_at as "updatedAt"
      `);

      if (!created) {
        return { kind: "deployment_not_retryable" as const };
      }

      insertedDeploymentId = created.id;

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
