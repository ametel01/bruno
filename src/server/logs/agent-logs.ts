import { and, asc, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import { agentLogs, agents } from "@/src/server/db/schema";

const DEFAULT_AGENT_LOG_LIMIT = 100;
const MAX_AGENT_LOG_LIMIT = 100;
export const SIMULATED_RUNTIME_LOG_CYCLE_INTERVAL_MS = 10_000;
export const SIMULATED_RUNTIME_LOG_MESSAGES = [
  "Checking task queue...",
  "No pending tasks.",
  "Heartbeat OK.",
  "Memory loaded.",
] as const;

export type AgentLogDto = {
  id: string;
  agentId: string;
  runnerId: string | null;
  stream: string;
  level: string;
  message: string;
  sequence: number;
  createdAt: string;
};

export type AgentLogPage = {
  logs: AgentLogDto[];
  nextAfter: number | null;
};

export type AgentLogQueryExecutor = Pick<PostgresJsDatabase<typeof schema>, "select">;
export type AgentLogGenerationExecutor = Pick<PostgresJsDatabase<typeof schema>, "transaction">;
type AgentLogRow = typeof agentLogs.$inferSelect;
type AgentLogTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];
type LockedRunningAgentRow = {
  updated_at: Date | string;
};

const logSelection = {
  id: agentLogs.id,
  agentId: agentLogs.agentId,
  runnerId: agentLogs.runnerId,
  stream: agentLogs.stream,
  level: agentLogs.level,
  message: agentLogs.message,
  sequence: agentLogs.sequence,
  createdAt: agentLogs.createdAt,
};

export async function listAgentLogs(input: {
  db: AgentLogQueryExecutor;
  agentId: string;
  after?: number | null;
  limit?: number;
}): Promise<AgentLogPage> {
  const limit = normalizeAgentLogLimit(input.limit);
  const after = input.after ?? null;
  const predicates = [eq(agentLogs.agentId, input.agentId)];

  if (after !== null) {
    predicates.push(gt(agentLogs.sequence, after));
  }

  const rows = await input.db
    .select(logSelection)
    .from(agentLogs)
    .where(and(...predicates))
    .orderBy(asc(agentLogs.sequence))
    .limit(limit);

  return toAgentLogPage(rows, after);
}

export async function generateSimulatedRuntimeLogsForRunningAgent(input: {
  db: AgentLogGenerationExecutor;
  agentId: string;
  now?: Date;
}): Promise<{ inserted: number }> {
  const now = input.now ?? new Date();

  return input.db.transaction(async (tx) => {
    const [lockedAgent] = await lockRunningAgentInTransaction(tx, input.agentId);
    const runningSegmentStartedAt = lockedAgent ? coerceTimestamp(lockedAgent.updated_at) : null;

    if (!runningSegmentStartedAt || now < runningSegmentStartedAt) {
      return { inserted: 0 };
    }

    const [latestGeneratedLog] = await tx
      .select({
        createdAt: agentLogs.createdAt,
      })
      .from(agentLogs)
      .where(
        and(
          eq(agentLogs.agentId, input.agentId),
          isNull(agentLogs.runnerId),
          eq(agentLogs.stream, "stdout"),
          eq(agentLogs.level, "info"),
          inArray(agentLogs.message, [...SIMULATED_RUNTIME_LOG_MESSAGES]),
          gte(agentLogs.createdAt, runningSegmentStartedAt),
        ),
      )
      .orderBy(desc(agentLogs.createdAt), desc(agentLogs.sequence))
      .limit(1);

    if (
      latestGeneratedLog &&
      now.getTime() - latestGeneratedLog.createdAt.getTime() <
        SIMULATED_RUNTIME_LOG_CYCLE_INTERVAL_MS
    ) {
      return { inserted: 0 };
    }

    const [latestAgentLog] = await tx
      .select({
        sequence: agentLogs.sequence,
      })
      .from(agentLogs)
      .where(eq(agentLogs.agentId, input.agentId))
      .orderBy(desc(agentLogs.sequence))
      .limit(1);

    const nextSequence = (latestAgentLog?.sequence ?? 0) + 1;

    await tx.insert(agentLogs).values(
      SIMULATED_RUNTIME_LOG_MESSAGES.map((message, index) => ({
        agentId: input.agentId,
        runnerId: null,
        stream: "stdout",
        level: "info",
        message,
        sequence: nextSequence + index,
        createdAt: now,
      })),
    );

    return { inserted: SIMULATED_RUNTIME_LOG_MESSAGES.length };
  });
}

export function mapAgentLogToDto(log: AgentLogRow): AgentLogDto {
  return {
    id: log.id,
    agentId: log.agentId,
    runnerId: log.runnerId,
    stream: log.stream,
    level: log.level,
    message: log.message,
    sequence: log.sequence,
    createdAt: log.createdAt.toISOString(),
  };
}

function toAgentLogPage(rows: AgentLogRow[], after: number | null): AgentLogPage {
  const lastLog = rows.at(-1);

  return {
    logs: rows.map((row) => mapAgentLogToDto(row)),
    nextAfter: lastLog?.sequence ?? after,
  };
}

function normalizeAgentLogLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isInteger(limit)) {
    return DEFAULT_AGENT_LOG_LIMIT;
  }

  if (limit < 1) {
    return 1;
  }

  return Math.min(limit, MAX_AGENT_LOG_LIMIT);
}

function lockRunningAgentInTransaction(
  tx: AgentLogTransaction,
  agentId: string,
): Promise<LockedRunningAgentRow[]> {
  return tx.execute<LockedRunningAgentRow>(sql`
    select ${agents.updatedAt} as updated_at
    from ${agents}
    where ${agents.id} = ${agentId}
      and ${agents.status} = 'running'
      and ${agents.deletedAt} is null
    for update
  `);
}

function coerceTimestamp(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
