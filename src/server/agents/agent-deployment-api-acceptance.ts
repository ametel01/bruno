import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentDeploymentApiAttemptEvents } from "@/src/server/db/schema";

export type AgentDeploymentApiAttemptKind = "create_ready" | "start";
export type AgentDeploymentApiAttemptTerminalPhase = "accepted" | "rejected" | "outcome_unknown";

export type AgentDeploymentApiAcceptanceSummary = {
  sampleSize: number;
  accepted: number;
  rejected: number;
  outcomeUnknown: number;
  pending: number;
  availability: number;
};

export type AgentDeploymentApiAttemptRecorder = {
  begin(kind: AgentDeploymentApiAttemptKind): Promise<string>;
  finish(input: {
    attemptId: string;
    kind: AgentDeploymentApiAttemptKind;
    phase: AgentDeploymentApiAttemptTerminalPhase;
    safeCode?: string;
  }): Promise<void>;
};

export function createAgentDeploymentApiAttemptRecorder(): AgentDeploymentApiAttemptRecorder {
  return {
    async begin(kind) {
      const attemptId = randomUUID();
      await insertEvent({ attemptId, kind, phase: "started" });
      return attemptId;
    },
    async finish(input) {
      await insertEvent(input);
    },
  };
}

export async function buildAgentDeploymentApiAcceptanceSummary(
  connection: DatabaseConnection,
  input: { generatedAt: Date; limit?: number },
): Promise<AgentDeploymentApiAcceptanceSummary> {
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Agent Deployment API-acceptance sample limit is invalid.");
  }
  const [summary] = await connection.db.execute<{
    sampleSize: number;
    accepted: number;
    rejected: number;
    outcomeUnknown: number;
    pending: number;
  }>(sql`
    with latest_attempts as (
      select ${agentDeploymentApiAttemptEvents.attemptId} as attempt_id
      from ${agentDeploymentApiAttemptEvents}
      where ${agentDeploymentApiAttemptEvents.phase} = 'started'
        and ${agentDeploymentApiAttemptEvents.createdAt} <= ${input.generatedAt.toISOString()}
      order by ${agentDeploymentApiAttemptEvents.createdAt} desc,
        ${agentDeploymentApiAttemptEvents.attemptId} desc
      limit ${limit}
    ), terminal as (
      select
        latest_attempts.attempt_id,
        max(${agentDeploymentApiAttemptEvents.phase}) filter (
          where ${agentDeploymentApiAttemptEvents.phase} <> 'started'
            and ${agentDeploymentApiAttemptEvents.createdAt} <= ${input.generatedAt.toISOString()}
        ) as phase
      from latest_attempts
      left join ${agentDeploymentApiAttemptEvents}
        on ${agentDeploymentApiAttemptEvents.attemptId} = latest_attempts.attempt_id
      group by latest_attempts.attempt_id
    )
    select
      count(*)::int as "sampleSize",
      count(*) filter (where phase = 'accepted')::int as accepted,
      count(*) filter (where phase = 'rejected')::int as rejected,
      count(*) filter (where phase = 'outcome_unknown')::int as "outcomeUnknown",
      count(*) filter (where phase is null)::int as pending
    from terminal
  `);
  const counts = summary ?? {
    sampleSize: 0,
    accepted: 0,
    rejected: 0,
    outcomeUnknown: 0,
    pending: 0,
  };
  return {
    ...counts,
    availability: counts.sampleSize === 0 ? 0 : counts.accepted / counts.sampleSize,
  };
}

async function insertEvent(input: {
  attemptId: string;
  kind: AgentDeploymentApiAttemptKind;
  phase: "started" | AgentDeploymentApiAttemptTerminalPhase;
  safeCode?: string;
}): Promise<void> {
  const safeCode =
    input.phase === "rejected" || input.phase === "outcome_unknown"
      ? normalizeSafeCode(input.safeCode)
      : null;
  const connection = createDatabaseConnection();
  try {
    await connection.db.insert(agentDeploymentApiAttemptEvents).values({
      attemptId: input.attemptId,
      requestKind: input.kind,
      phase: input.phase,
      safeCode,
    });
  } finally {
    await connection.close();
  }
}

function normalizeSafeCode(value: string | undefined): string {
  return value && /^[a-z0-9_.:-]{1,64}$/.test(value) ? value : "request_failed";
}
