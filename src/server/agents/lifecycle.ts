import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import { agentEvents, agents, type agentStatusEnum } from "@/src/server/db/schema";

export type AgentLifecycleStatus = (typeof agentStatusEnum.enumValues)[number];

export const STARTABLE_AGENT_STATUSES = ["idle", "stopped", "error"] as const;
export const STOPPABLE_AGENT_STATUSES = ["running"] as const;
export const RESTARTABLE_AGENT_STATUSES = ["running"] as const;
export const DELETABLE_AGENT_STATUSES = ["idle", "running", "stopped", "error"] as const;
export const START_REQUESTED_EVENT_TYPE = "agent.start_requested";
export const START_COMPLETED_EVENT_TYPE = "agent.start_completed";
export const STOP_REQUESTED_EVENT_TYPE = "agent.stop_requested";
export const STOP_COMPLETED_EVENT_TYPE = "agent.stop_completed";
export const RESTART_REQUESTED_EVENT_TYPE = "agent.restart_requested";
export const RESTART_COMPLETED_EVENT_TYPE = "agent.restart_completed";
export const DELETE_EVENT_TYPE = "agent.deleted";
export const FAKE_RUNNER_START_DELAY_MS = 400;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STARTING_STATUS_REASON = "Start requested.";
const RESTARTING_STATUS_REASON = "Restart requested.";
const RUNNING_STATUS_REASON = "Fake runner is running.";

type AgentTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

type LifecycleClock = () => Date;

export type AgentLifecycleDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: LifecycleClock;
};

export type StartAgentResult =
  | {
      ok: true;
      agent: StartedAgent;
      event: {
        type: typeof START_REQUESTED_EVENT_TYPE;
      };
    }
  | {
      ok: false;
      reason: "missing_agent_id" | "malformed_agent_id" | "agent_not_found" | "invalid_status";
      status?: AgentLifecycleStatus;
    };

export type StartedAgent = {
  id: string;
  userId: string;
  name: string;
  templateKey: string;
  status: "starting";
  statusReason: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: null;
};

export type StopAgentResult =
  | {
      ok: true;
      agent: StoppedAgent;
      events: [
        {
          type: typeof STOP_REQUESTED_EVENT_TYPE;
        },
        {
          type: typeof STOP_COMPLETED_EVENT_TYPE;
        },
      ];
    }
  | {
      ok: false;
      reason: "missing_agent_id" | "malformed_agent_id" | "agent_not_found" | "invalid_status";
      status?: AgentLifecycleStatus;
    };

export type StoppedAgent = {
  id: string;
  userId: string;
  name: string;
  templateKey: string;
  status: "stopped";
  statusReason: null;
  createdAt: string;
  updatedAt: string;
  deletedAt: null;
};

export type RestartAgentResult =
  | {
      ok: true;
      agent: RestartedAgent;
      event: {
        type: typeof RESTART_REQUESTED_EVENT_TYPE;
      };
    }
  | {
      ok: false;
      reason: "missing_agent_id" | "malformed_agent_id" | "agent_not_found" | "invalid_status";
      status?: AgentLifecycleStatus;
    };

export type RestartedAgent = {
  id: string;
  userId: string;
  name: string;
  templateKey: string;
  status: "restarting";
  statusReason: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: null;
};

export type DeleteAgentResult =
  | {
      ok: true;
      agent: DeletedAgent;
      event: {
        type: typeof DELETE_EVENT_TYPE;
      };
    }
  | {
      ok: false;
      reason: "missing_agent_id" | "malformed_agent_id" | "agent_not_found" | "invalid_status";
      status?: AgentLifecycleStatus;
    };

export type DeletedAgent = {
  id: string;
  userId: string;
  name: string;
  templateKey: string;
  status: AgentLifecycleStatus;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string;
};

export class AgentLifecyclePersistenceError extends Error {
  constructor() {
    super("Agent lifecycle update failed.");
    this.name = "AgentLifecyclePersistenceError";
  }
}

export function isValidAgentId(agentId: string): boolean {
  return UUID_PATTERN.test(agentId);
}

export function canStartAgentStatus(status: AgentLifecycleStatus): boolean {
  return STARTABLE_AGENT_STATUSES.includes(status as (typeof STARTABLE_AGENT_STATUSES)[number]);
}

export function canStopAgentStatus(status: AgentLifecycleStatus): boolean {
  return STOPPABLE_AGENT_STATUSES.includes(status as (typeof STOPPABLE_AGENT_STATUSES)[number]);
}

export function canRestartAgentStatus(status: AgentLifecycleStatus): boolean {
  return RESTARTABLE_AGENT_STATUSES.includes(status as (typeof RESTARTABLE_AGENT_STATUSES)[number]);
}

export function canDeleteAgentStatus(status: AgentLifecycleStatus): boolean {
  return DELETABLE_AGENT_STATUSES.includes(status as (typeof DELETABLE_AGENT_STATUSES)[number]);
}

export async function startAgentForDevelopmentUser(
  agentId: string,
  dependencies: AgentLifecycleDependencies = {},
): Promise<StartAgentResult> {
  const normalizedAgentId = agentId.trim();

  if (normalizedAgentId.length === 0) {
    return { ok: false, reason: "missing_agent_id" };
  }

  if (!isValidAgentId(normalizedAgentId)) {
    return { ok: false, reason: "malformed_agent_id" };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction(async (tx) => {
      const [currentAgent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, normalizedAgentId), isNull(agents.deletedAt)))
        .limit(1);

      if (!currentAgent) {
        return { ok: false, reason: "agent_not_found" };
      }

      if (!canStartAgentStatus(currentAgent.status)) {
        return { ok: false, reason: "invalid_status", status: currentAgent.status };
      }

      const [startedAgent] = await tx
        .update(agents)
        .set({
          status: "starting",
          statusReason: STARTING_STATUS_REASON,
          updatedAt: now,
        })
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            isNull(agents.deletedAt),
            inArray(agents.status, [...STARTABLE_AGENT_STATUSES]),
          ),
        )
        .returning();

      if (!startedAgent) {
        throw new Error("Agent start update returned no rows.");
      }

      await tx.insert(agentEvents).values({
        agentId: startedAgent.id,
        actorUserId: startedAgent.userId,
        type: START_REQUESTED_EVENT_TYPE,
        message: `Start requested for agent "${startedAgent.name}".`,
        metadata: {
          fromStatus: currentAgent.status,
          toStatus: "starting",
        },
      });

      return {
        ok: true,
        agent: toStartedAgent(startedAgent),
        event: {
          type: START_REQUESTED_EVENT_TYPE,
        },
      };
    });
  } catch {
    throw new AgentLifecyclePersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function stopAgentForDevelopmentUser(
  agentId: string,
  dependencies: AgentLifecycleDependencies = {},
): Promise<StopAgentResult> {
  const normalizedAgentId = agentId.trim();

  if (normalizedAgentId.length === 0) {
    return { ok: false, reason: "missing_agent_id" };
  }

  if (!isValidAgentId(normalizedAgentId)) {
    return { ok: false, reason: "malformed_agent_id" };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  const dueBefore = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS);

  try {
    return await connection.db.transaction(async (tx) => {
      await settleDueFakeRunnerTransitionsInTransaction(tx, now, dueBefore);

      const [currentAgent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, normalizedAgentId), isNull(agents.deletedAt)))
        .limit(1);

      if (!currentAgent) {
        return { ok: false, reason: "agent_not_found" };
      }

      if (!canStopAgentStatus(currentAgent.status)) {
        return { ok: false, reason: "invalid_status", status: currentAgent.status };
      }

      const [stoppedAgent] = await tx
        .update(agents)
        .set({
          status: "stopped",
          statusReason: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            isNull(agents.deletedAt),
            inArray(agents.status, [...STOPPABLE_AGENT_STATUSES]),
          ),
        )
        .returning();

      if (!stoppedAgent) {
        throw new Error("Agent stop update returned no rows.");
      }

      await tx.insert(agentEvents).values([
        {
          agentId: stoppedAgent.id,
          actorUserId: stoppedAgent.userId,
          type: STOP_REQUESTED_EVENT_TYPE,
          message: `Stop requested for agent "${stoppedAgent.name}".`,
          metadata: {
            fromStatus: currentAgent.status,
            toStatus: "stopped",
          },
        },
        {
          agentId: stoppedAgent.id,
          actorUserId: stoppedAgent.userId,
          type: STOP_COMPLETED_EVENT_TYPE,
          message: `Stop completed for agent "${stoppedAgent.name}".`,
          metadata: {
            fromStatus: currentAgent.status,
            toStatus: "stopped",
          },
        },
      ]);

      return {
        ok: true,
        agent: toStoppedAgent(stoppedAgent),
        events: [
          {
            type: STOP_REQUESTED_EVENT_TYPE,
          },
          {
            type: STOP_COMPLETED_EVENT_TYPE,
          },
        ],
      };
    });
  } catch {
    throw new AgentLifecyclePersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function restartAgentForDevelopmentUser(
  agentId: string,
  dependencies: AgentLifecycleDependencies = {},
): Promise<RestartAgentResult> {
  const normalizedAgentId = agentId.trim();

  if (normalizedAgentId.length === 0) {
    return { ok: false, reason: "missing_agent_id" };
  }

  if (!isValidAgentId(normalizedAgentId)) {
    return { ok: false, reason: "malformed_agent_id" };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  const dueBefore = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS);

  try {
    return await connection.db.transaction(async (tx) => {
      await settleDueFakeRunnerTransitionsInTransaction(tx, now, dueBefore);

      const [currentAgent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, normalizedAgentId), isNull(agents.deletedAt)))
        .limit(1);

      if (!currentAgent) {
        return { ok: false, reason: "agent_not_found" };
      }

      if (!canRestartAgentStatus(currentAgent.status)) {
        return { ok: false, reason: "invalid_status", status: currentAgent.status };
      }

      const [restartedAgent] = await tx
        .update(agents)
        .set({
          status: "restarting",
          statusReason: RESTARTING_STATUS_REASON,
          updatedAt: now,
        })
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            isNull(agents.deletedAt),
            inArray(agents.status, [...RESTARTABLE_AGENT_STATUSES]),
          ),
        )
        .returning();

      if (!restartedAgent) {
        throw new Error("Agent restart update returned no rows.");
      }

      await tx.insert(agentEvents).values({
        agentId: restartedAgent.id,
        actorUserId: restartedAgent.userId,
        type: RESTART_REQUESTED_EVENT_TYPE,
        message: `Restart requested for agent "${restartedAgent.name}".`,
        metadata: {
          fromStatus: currentAgent.status,
          toStatus: "restarting",
        },
      });

      return {
        ok: true,
        agent: toRestartedAgent(restartedAgent),
        event: {
          type: RESTART_REQUESTED_EVENT_TYPE,
        },
      };
    });
  } catch {
    throw new AgentLifecyclePersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function deleteAgentForDevelopmentUser(
  agentId: string,
  dependencies: AgentLifecycleDependencies = {},
): Promise<DeleteAgentResult> {
  const normalizedAgentId = agentId.trim();

  if (normalizedAgentId.length === 0) {
    return { ok: false, reason: "missing_agent_id" };
  }

  if (!isValidAgentId(normalizedAgentId)) {
    return { ok: false, reason: "malformed_agent_id" };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  const dueBefore = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS);

  try {
    return await connection.db.transaction(async (tx) => {
      await settleDueFakeRunnerTransitionsInTransaction(tx, now, dueBefore);

      const [currentAgent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, normalizedAgentId), isNull(agents.deletedAt)))
        .limit(1);

      if (!currentAgent) {
        return { ok: false, reason: "agent_not_found" };
      }

      if (!canDeleteAgentStatus(currentAgent.status)) {
        return { ok: false, reason: "invalid_status", status: currentAgent.status };
      }

      const [deletedAgent] = await tx
        .update(agents)
        .set({
          updatedAt: now,
          deletedAt: now,
        })
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            isNull(agents.deletedAt),
            inArray(agents.status, [...DELETABLE_AGENT_STATUSES]),
          ),
        )
        .returning();

      if (!deletedAgent) {
        throw new Error("Agent delete update returned no rows.");
      }

      await tx.insert(agentEvents).values({
        agentId: deletedAgent.id,
        actorUserId: deletedAgent.userId,
        type: DELETE_EVENT_TYPE,
        message: `Agent "${deletedAgent.name}" deleted from active views.`,
        metadata: {
          fromStatus: currentAgent.status,
          toStatus: "deleted",
          deletedAt: now.toISOString(),
        },
      });

      return {
        ok: true,
        agent: toDeletedAgent(deletedAgent),
        event: {
          type: DELETE_EVENT_TYPE,
        },
      };
    });
  } catch {
    throw new AgentLifecyclePersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function settleDueStartingAgents(
  dependencies: AgentLifecycleDependencies = {},
): Promise<number> {
  return settleDueFakeRunnerTransitions(dependencies);
}

export async function settleDueFakeRunnerTransitions(
  dependencies: AgentLifecycleDependencies = {},
): Promise<number> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  const dueBefore = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS);

  try {
    return await connection.db.transaction(async (tx) =>
      settleDueFakeRunnerTransitionsInTransaction(tx, now, dueBefore),
    );
  } catch {
    throw new AgentLifecyclePersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

async function settleDueFakeRunnerTransitionsInTransaction(
  tx: AgentTransaction,
  now: Date,
  dueBefore: Date,
): Promise<number> {
  const settledStartingAgents = await settleDueStatusInTransaction({
    tx,
    now,
    dueBefore,
    fromStatus: "starting",
    eventType: START_COMPLETED_EVENT_TYPE,
    messageAction: "Start",
  });
  const settledRestartingAgents = await settleDueStatusInTransaction({
    tx,
    now,
    dueBefore,
    fromStatus: "restarting",
    eventType: RESTART_COMPLETED_EVENT_TYPE,
    messageAction: "Restart",
  });

  return settledStartingAgents + settledRestartingAgents;
}

async function settleDueStatusInTransaction(input: {
  tx: AgentTransaction;
  now: Date;
  dueBefore: Date;
  fromStatus: "starting" | "restarting";
  eventType: typeof START_COMPLETED_EVENT_TYPE | typeof RESTART_COMPLETED_EVENT_TYPE;
  messageAction: "Start" | "Restart";
}): Promise<number> {
  const { tx, now, dueBefore, fromStatus, eventType, messageAction } = input;
  const settledAgents = await tx
    .update(agents)
    .set({
      status: "running",
      statusReason: RUNNING_STATUS_REASON,
      updatedAt: now,
    })
    .where(
      and(
        eq(agents.status, fromStatus),
        isNull(agents.deletedAt),
        lte(agents.updatedAt, dueBefore),
      ),
    )
    .returning({
      id: agents.id,
      userId: agents.userId,
      name: agents.name,
    });

  if (settledAgents.length === 0) {
    return 0;
  }

  await tx.insert(agentEvents).values(
    settledAgents.map((agent) => ({
      agentId: agent.id,
      actorUserId: agent.userId,
      type: eventType,
      message: `${messageAction} completed for agent "${agent.name}".`,
      metadata: {
        fromStatus,
        toStatus: "running",
      },
    })),
  );

  return settledAgents.length;
}

function toStartedAgent(agent: typeof agents.$inferSelect): StartedAgent {
  return {
    id: agent.id,
    userId: agent.userId,
    name: agent.name,
    templateKey: agent.templateKey,
    status: "starting",
    statusReason: STARTING_STATUS_REASON,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    deletedAt: null,
  };
}

function toStoppedAgent(agent: typeof agents.$inferSelect): StoppedAgent {
  return {
    id: agent.id,
    userId: agent.userId,
    name: agent.name,
    templateKey: agent.templateKey,
    status: "stopped",
    statusReason: null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    deletedAt: null,
  };
}

function toRestartedAgent(agent: typeof agents.$inferSelect): RestartedAgent {
  return {
    id: agent.id,
    userId: agent.userId,
    name: agent.name,
    templateKey: agent.templateKey,
    status: "restarting",
    statusReason: RESTARTING_STATUS_REASON,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    deletedAt: null,
  };
}

function toDeletedAgent(agent: typeof agents.$inferSelect): DeletedAgent {
  if (!agent.deletedAt) {
    throw new Error("Deleted agent row is missing deletedAt.");
  }

  return {
    id: agent.id,
    userId: agent.userId,
    name: agent.name,
    templateKey: agent.templateKey,
    status: agent.status,
    statusReason: agent.statusReason,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    deletedAt: agent.deletedAt.toISOString(),
  };
}
