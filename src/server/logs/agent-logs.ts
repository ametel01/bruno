import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import { agentApprovals, agentLogs, agents } from "@/src/server/db/schema";
import {
  recordAgentEventInTransaction,
  type AgentEventWrite,
} from "@/src/server/events/agent-events";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

const DEFAULT_AGENT_LOG_LIMIT = 100;
const MAX_AGENT_LOG_LIMIT = 100;
export const SIMULATED_RUNTIME_LOG_CYCLE_INTERVAL_MS = 10_000;
export const SIMULATED_RUNTIME_LOG_MESSAGES = [
  "Checking task queue...",
  "No pending tasks.",
  "Heartbeat OK.",
  "Memory loaded.",
] as const;
export const FAKE_RUNNER_APPROVAL_REQUESTED_EVENT_TYPE = "approval.requested";
export const FAKE_RUNNER_APPROVAL_REQUESTED_BY = "fake_runner";
export const FAKE_RUNNER_APPROVAL_SOURCE = "fake_runner";

const FAKE_APPROVAL_ACTIONS = [
  {
    actionType: "telegram.send_message",
    title: "Approve Telegram message",
    description: "Review a fake outbound Telegram message before it is sent.",
    preview: {
      destination: "Demo Telegram channel",
      summary: "Daily operations summary is ready for review.",
    },
  },
  {
    actionType: "research.run_task",
    title: "Approve research task",
    description: "Review a fake research task before the agent starts collecting public notes.",
    preview: {
      topic: "Market signal scan",
      summary: "Collect three public-source bullet points for operator review.",
    },
  },
  {
    actionType: "gmail.access_inbox",
    title: "Approve Gmail inbox access",
    description: "Review a fake inbox access request before the agent reads mailbox metadata.",
    preview: {
      mailbox: "Demo Gmail inbox",
      summary: "Scan unread message subjects for triage candidates.",
    },
  },
] as const;

export type AgentLogDto = {
  id: string;
  agentId: string;
  runnerId: string | null;
  localRunnerProcessId: string | null;
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

export type LatestAgentProcessLogDto = AgentLogDto & {
  agentName: string;
  agentHref: string;
};

export type AgentLogQueryExecutor = Pick<PostgresJsDatabase<typeof schema>, "select">;
export type AgentLogGenerationExecutor = Pick<PostgresJsDatabase<typeof schema>, "transaction">;
type AgentLogRow = typeof agentLogs.$inferSelect;
type AgentLogTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];
type LockedRunningAgentRow = {
  id: string;
  user_id: string;
  name: string;
  updated_at: Date | string;
};
type FakeApprovalAction = (typeof FAKE_APPROVAL_ACTIONS)[number];
type InsertGeneratedApprovalRequest = (
  tx: AgentLogTransaction,
  values: typeof agentApprovals.$inferInsert,
) => Promise<typeof agentApprovals.$inferSelect>;
type RecordApprovalRequestedEvent = (
  tx: AgentLogTransaction,
  event: AgentEventWrite,
) => Promise<void>;

const logSelection = {
  id: agentLogs.id,
  agentId: agentLogs.agentId,
  runnerId: agentLogs.runnerId,
  localRunnerProcessId: agentLogs.localRunnerProcessId,
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

export async function listLatestActiveAgentProcessLogs(input: {
  db: AgentLogQueryExecutor;
  limit?: number;
}): Promise<LatestAgentProcessLogDto[]> {
  const limit = normalizeAgentLogLimit(input.limit);
  const rows = await input.db
    .select({
      ...logSelection,
      agentName: agents.name,
    })
    .from(agentLogs)
    .innerJoin(agents, eq(agentLogs.agentId, agents.id))
    .where(and(isNull(agents.deletedAt), isNotNull(agentLogs.localRunnerProcessId)))
    .orderBy(desc(agentLogs.createdAt), desc(agentLogs.sequence), desc(agentLogs.id))
    .limit(limit);

  return rows.map((row) => ({
    ...mapAgentLogToDto(row),
    agentName: row.agentName,
    agentHref: `/agents/${row.agentId}`,
  }));
}

export async function generateSimulatedRuntimeLogsForRunningAgent(input: {
  db: AgentLogGenerationExecutor;
  agentId: string;
  now?: Date;
  insertGeneratedApprovalRequest?: InsertGeneratedApprovalRequest;
  recordApprovalRequestedEvent?: RecordApprovalRequestedEvent;
}): Promise<{ inserted: number }> {
  const now = input.now ?? new Date();
  const insertGeneratedApprovalRequest =
    input.insertGeneratedApprovalRequest ?? insertGeneratedApprovalRequestInTransaction;
  const recordApprovalRequestedEvent =
    input.recordApprovalRequestedEvent ?? recordAgentEventInTransaction;

  return input.db.transaction(async (tx) => {
    const developmentUserId = await getDevelopmentUserId(tx);

    if (!developmentUserId) {
      return { inserted: 0 };
    }

    const [lockedAgent] = await lockRunningAgentInTransaction(tx, input.agentId, developmentUserId);
    const runningSegmentStartedAt = lockedAgent ? coerceTimestamp(lockedAgent.updated_at) : null;

    if (!lockedAgent || !runningSegmentStartedAt || now < runningSegmentStartedAt) {
      return { inserted: 0 };
    }

    await createFakeApprovalRequestForRunningSegment({
      tx,
      agent: lockedAgent,
      runningSegmentStartedAt,
      now,
      insertGeneratedApprovalRequest,
      recordApprovalRequestedEvent,
    });

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
        localRunnerProcessId: null,
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
    localRunnerProcessId: log.localRunnerProcessId,
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
  developmentUserId: string,
): Promise<LockedRunningAgentRow[]> {
  return tx.execute<LockedRunningAgentRow>(sql`
    select ${agents.id} as id,
           ${agents.userId} as user_id,
           ${agents.name} as name,
           ${agents.updatedAt} as updated_at
    from ${agents}
    where ${agents.id} = ${agentId}
      and ${agents.userId} = ${developmentUserId}
      and ${agents.status} = 'running'
      and ${agents.deletedAt} is null
    for update
  `);
}

function coerceTimestamp(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

async function createFakeApprovalRequestForRunningSegment(input: {
  tx: AgentLogTransaction;
  agent: LockedRunningAgentRow;
  runningSegmentStartedAt: Date;
  now: Date;
  insertGeneratedApprovalRequest: InsertGeneratedApprovalRequest;
  recordApprovalRequestedEvent: RecordApprovalRequestedEvent;
}): Promise<void> {
  const action = selectFakeApprovalAction(
    input.agent.id,
    input.runningSegmentStartedAt.toISOString(),
  );
  const runningSegmentStartedAt = input.runningSegmentStartedAt.toISOString();
  const [existingApproval] = await input.tx
    .select({ id: agentApprovals.id })
    .from(agentApprovals)
    .where(
      and(
        eq(agentApprovals.agentId, input.agent.id),
        eq(agentApprovals.requestedBy, FAKE_RUNNER_APPROVAL_REQUESTED_BY),
        sql`${agentApprovals.payloadJson}->>'source' = ${FAKE_RUNNER_APPROVAL_SOURCE}`,
        sql`${agentApprovals.payloadJson}->>'actionType' = ${action.actionType}`,
        sql`${agentApprovals.payloadJson}->>'runningSegmentStartedAt' = ${runningSegmentStartedAt}`,
      ),
    )
    .limit(1);

  if (existingApproval) {
    return;
  }

  const approval = await input.insertGeneratedApprovalRequest(input.tx, {
    agentId: input.agent.id,
    title: action.title,
    description: action.description,
    status: "pending",
    payloadJson: {
      source: FAKE_RUNNER_APPROVAL_SOURCE,
      actionType: action.actionType,
      preview: action.preview,
      runningSegmentStartedAt,
    },
    requestedBy: FAKE_RUNNER_APPROVAL_REQUESTED_BY,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: input.now,
    expiresAt: new Date(input.now.getTime() + 30 * 60 * 1000),
  });

  await input.recordApprovalRequestedEvent(input.tx, {
    agentId: input.agent.id,
    actorUserId: input.agent.user_id,
    type: FAKE_RUNNER_APPROVAL_REQUESTED_EVENT_TYPE,
    message: `Approval requested for fake action "${action.actionType}" on agent "${input.agent.name}".`,
    metadata: {
      approvalId: approval.id,
      agentId: input.agent.id,
      actionType: action.actionType,
      source: FAKE_RUNNER_APPROVAL_SOURCE,
      runningSegmentStartedAt,
    },
  });
}

async function insertGeneratedApprovalRequestInTransaction(
  tx: AgentLogTransaction,
  values: typeof agentApprovals.$inferInsert,
): Promise<typeof agentApprovals.$inferSelect> {
  const [approval] = await tx.insert(agentApprovals).values(values).returning();

  if (!approval) {
    throw new Error("Generated approval insert returned no rows.");
  }

  return approval;
}

function selectFakeApprovalAction(
  agentId: string,
  runningSegmentStartedAt: string,
): FakeApprovalAction {
  let hash = 0;

  for (const char of `${agentId}:${runningSegmentStartedAt}`) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  const action = FAKE_APPROVAL_ACTIONS[hash % FAKE_APPROVAL_ACTIONS.length];

  if (!action) {
    return FAKE_APPROVAL_ACTIONS[0];
  }

  return action;
}
