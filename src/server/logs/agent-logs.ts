import { and, asc, eq, gt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import { agentLogs } from "@/src/server/db/schema";

const DEFAULT_AGENT_LOG_LIMIT = 100;
const MAX_AGENT_LOG_LIMIT = 100;

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
type AgentLogRow = typeof agentLogs.$inferSelect;

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
