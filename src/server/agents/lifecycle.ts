import { and, eq, inArray, isNull } from "drizzle-orm";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agents, type agentStatusEnum } from "@/src/server/db/schema";
import {
  recordAgentEventInTransaction,
  recordAgentEventsInTransaction,
} from "@/src/server/events/agent-events";
import {
  LocalRunnerAdapter,
  type LocalRunnerRestartResult,
  type LocalRunnerStartResult,
  type LocalRunnerStatusResult,
  type LocalRunnerStopResult,
  type LocalRunnerUnexpectedExitEvent,
} from "@/src/server/runners/local-runner-adapter";
import {
  DockerRunnerAdapter,
  type DockerRunnerRestartResult,
  type DockerRunnerStartResult,
  type DockerRunnerStatusResult,
  type DockerRunnerStopResult,
} from "@/src/server/runners/docker-runner-adapter";
import type { DockerRunnerContainerDto } from "@/src/server/runners/docker-runner-state";
import type { RunnerAdapter as RunnerAdapterContract } from "@/src/server/runners/runner-adapter";

export type AgentLifecycleStatus = (typeof agentStatusEnum.enumValues)[number];

export const STARTABLE_AGENT_STATUSES = ["idle", "stopped", "error"] as const;
export const STOPPABLE_AGENT_STATUSES = ["running"] as const;
export const RESTARTABLE_AGENT_STATUSES = ["running"] as const;
export const SIMULATE_ERROR_AGENT_STATUSES = [
  "idle",
  "stopped",
  "starting",
  "running",
  "restarting",
] as const;
export const DELETABLE_AGENT_STATUSES = ["idle", "running", "stopped", "error"] as const;
export const START_REQUESTED_EVENT_TYPE = "agent.start_requested";
export const START_COMPLETED_EVENT_TYPE = "agent.start_completed";
export const STOP_REQUESTED_EVENT_TYPE = "agent.stop_requested";
export const STOP_COMPLETED_EVENT_TYPE = "agent.stop_completed";
export const RESTART_REQUESTED_EVENT_TYPE = "agent.restart_requested";
export const RESTART_COMPLETED_EVENT_TYPE = "agent.restart_completed";
export const SIMULATED_ERROR_EVENT_TYPE = "agent.error";
export const DELETE_EVENT_TYPE = "agent.deleted";
export const FAKE_RUNNER_START_DELAY_MS = 400;

const RUNNING_STATUS_REASON = "Docker runner container is running.";
export const LOCAL_RUNNER_UNEXPECTED_EXIT_STATUS_REASON =
  "Local runner exited unexpectedly. Check captured process logs for details.";
export const SIMULATED_ERROR_STATUS_REASON = "Simulated error requested for development testing.";

type LifecycleClock = () => Date;
type LifecycleRunnerStartResult = LocalRunnerStartResult | DockerRunnerStartResult;
type LifecycleRunnerStopResult = LocalRunnerStopResult | DockerRunnerStopResult;
type LifecycleRunnerRestartResult = LocalRunnerRestartResult | DockerRunnerRestartResult;
type LifecycleRunnerStatusResult = LocalRunnerStatusResult | DockerRunnerStatusResult;
type LifecycleRunnerAdapter = RunnerAdapterContract<
  LifecycleRunnerStartResult,
  LifecycleRunnerStopResult,
  LifecycleRunnerRestartResult,
  LifecycleRunnerStatusResult
>;

export type AgentLifecycleDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: LifecycleClock;
  runnerAdapter?: LifecycleRunnerAdapter;
};

export type StartAgentResult =
  | {
      ok: true;
      agent: StartedAgent;
      event: {
        type: typeof START_REQUESTED_EVENT_TYPE;
      };
      events: [
        {
          type: typeof START_REQUESTED_EVENT_TYPE;
        },
        {
          type: typeof START_COMPLETED_EVENT_TYPE;
        },
      ];
    }
  | {
      ok: false;
      reason:
        | "missing_agent_id"
        | "malformed_agent_id"
        | "agent_not_found"
        | "invalid_status"
        | "runner_start_failed";
      status?: AgentLifecycleStatus;
    };

export type StartedAgent = {
  id: string;
  userId: string;
  name: string;
  templateKey: string;
  status: "running";
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
      reason:
        | "missing_agent_id"
        | "malformed_agent_id"
        | "agent_not_found"
        | "invalid_status"
        | "runner_stop_failed";
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
      events: [
        {
          type: typeof RESTART_REQUESTED_EVENT_TYPE;
        },
        {
          type: typeof RESTART_COMPLETED_EVENT_TYPE;
        },
      ];
    }
  | {
      ok: false;
      reason:
        | "missing_agent_id"
        | "malformed_agent_id"
        | "agent_not_found"
        | "invalid_status"
        | "runner_restart_failed";
      status?: AgentLifecycleStatus;
    };

export type RestartedAgent = {
  id: string;
  userId: string;
  name: string;
  templateKey: string;
  status: "running";
  statusReason: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: null;
};

export type SimulateErrorAgentResult =
  | {
      ok: true;
      agent: SimulatedErrorAgent;
      event: {
        type: typeof SIMULATED_ERROR_EVENT_TYPE;
      };
    }
  | {
      ok: false;
      reason: "missing_agent_id" | "malformed_agent_id" | "agent_not_found" | "invalid_status";
      status?: AgentLifecycleStatus;
    };

export type SimulatedErrorAgent = {
  id: string;
  userId: string;
  name: string;
  templateKey: string;
  status: "error";
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

let lifecycleRunnerAdapter: LifecycleRunnerAdapter | null = null;
let lifecycleLocalRunnerAdapter: LifecycleRunnerAdapter | null = null;

export function getLifecycleRunnerAdapter(): LifecycleRunnerAdapter {
  lifecycleRunnerAdapter ??= new DockerRunnerAdapter();

  return lifecycleRunnerAdapter;
}

export function getLifecycleLocalRunnerAdapter(): LifecycleRunnerAdapter {
  lifecycleLocalRunnerAdapter ??= new LocalRunnerAdapter({
    onUnexpectedExit: async (event) => {
      await recordUnexpectedLocalRunnerExitForDevelopmentUser(event);
    },
  });

  return lifecycleLocalRunnerAdapter;
}

export { isValidAgentId };

export function canStartAgentStatus(status: AgentLifecycleStatus): boolean {
  return STARTABLE_AGENT_STATUSES.includes(status as (typeof STARTABLE_AGENT_STATUSES)[number]);
}

export function canStopAgentStatus(status: AgentLifecycleStatus): boolean {
  return STOPPABLE_AGENT_STATUSES.includes(status as (typeof STOPPABLE_AGENT_STATUSES)[number]);
}

export function canRestartAgentStatus(status: AgentLifecycleStatus): boolean {
  return RESTARTABLE_AGENT_STATUSES.includes(status as (typeof RESTARTABLE_AGENT_STATUSES)[number]);
}

export function canSimulateErrorAgentStatus(status: AgentLifecycleStatus): boolean {
  return SIMULATE_ERROR_AGENT_STATUSES.includes(
    status as (typeof SIMULATE_ERROR_AGENT_STATUSES)[number],
  );
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
  const runnerAdapter = dependencies.runnerAdapter ?? getLifecycleRunnerAdapter();

  try {
    const validation = await connection.db.transaction(async (tx) => {
      const [currentAgent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, normalizedAgentId), isNull(agents.deletedAt)))
        .limit(1);

      if (!currentAgent) {
        return { ok: false, reason: "agent_not_found" } as const;
      }

      if (!canStartAgentStatus(currentAgent.status)) {
        return { ok: false, reason: "invalid_status", status: currentAgent.status } as const;
      }

      return { ok: true, agent: currentAgent } as const;
    });

    if (!validation.ok) {
      return validation;
    }

    const runnerStart = await runnerAdapter.start(normalizedAgentId);

    if (!runnerStart.ok) {
      return { ok: false, reason: "runner_start_failed" } as const;
    }

    await captureLifecycleRunnerLogs(runnerAdapter, normalizedAgentId);

    return await connection.db.transaction(async (tx) => {
      const [startedAgent] = await tx
        .update(agents)
        .set({
          status: "running",
          statusReason: RUNNING_STATUS_REASON,
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
        await runnerAdapter.stop(normalizedAgentId);
        throw new Error("Agent start update returned no rows.");
      }

      await recordAgentEventsInTransaction(tx, [
        {
          agentId: startedAgent.id,
          actorUserId: startedAgent.userId,
          type: START_REQUESTED_EVENT_TYPE,
          message: `Start requested for agent "${startedAgent.name}".`,
          metadata: {
            fromStatus: validation.agent.status,
            toStatus: "running",
            ...runnerLifecycleEventMetadata(runnerStart),
          },
        },
        {
          agentId: startedAgent.id,
          actorUserId: startedAgent.userId,
          type: START_COMPLETED_EVENT_TYPE,
          message: `Start completed for agent "${startedAgent.name}".`,
          metadata: {
            fromStatus: validation.agent.status,
            toStatus: "running",
            ...runnerLifecycleEventMetadata(runnerStart),
          },
        },
      ]);

      return {
        ok: true,
        agent: toStartedAgent(startedAgent),
        event: {
          type: START_REQUESTED_EVENT_TYPE,
        },
        events: [
          {
            type: START_REQUESTED_EVENT_TYPE,
          },
          {
            type: START_COMPLETED_EVENT_TYPE,
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
  const runnerAdapter = dependencies.runnerAdapter ?? getLifecycleRunnerAdapter();

  try {
    const validation = await connection.db.transaction(async (tx) => {
      const [currentAgent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, normalizedAgentId), isNull(agents.deletedAt)))
        .limit(1);

      if (!currentAgent) {
        return { ok: false, reason: "agent_not_found" } as const;
      }

      if (!canStopAgentStatus(currentAgent.status)) {
        return { ok: false, reason: "invalid_status", status: currentAgent.status } as const;
      }

      return { ok: true, agent: currentAgent } as const;
    });

    if (!validation.ok) {
      return validation;
    }

    const runnerStop = await runnerAdapter.stop(normalizedAgentId);

    if (!runnerStop.ok) {
      return { ok: false, reason: "runner_stop_failed" } as const;
    }

    await captureLifecycleRunnerLogs(runnerAdapter, normalizedAgentId);

    return await connection.db.transaction(async (tx) => {
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

      await recordAgentEventsInTransaction(tx, [
        {
          agentId: stoppedAgent.id,
          actorUserId: stoppedAgent.userId,
          type: STOP_REQUESTED_EVENT_TYPE,
          message: `Stop requested for agent "${stoppedAgent.name}".`,
          metadata: {
            fromStatus: validation.agent.status,
            toStatus: "stopped",
            ...runnerLifecycleEventMetadata(runnerStop),
          },
        },
        {
          agentId: stoppedAgent.id,
          actorUserId: stoppedAgent.userId,
          type: STOP_COMPLETED_EVENT_TYPE,
          message: `Stop completed for agent "${stoppedAgent.name}".`,
          metadata: {
            fromStatus: validation.agent.status,
            toStatus: "stopped",
            ...runnerLifecycleEventMetadata(runnerStop),
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
  const runnerAdapter = dependencies.runnerAdapter ?? getLifecycleRunnerAdapter();

  try {
    const validation = await connection.db.transaction(async (tx) => {
      const [currentAgent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, normalizedAgentId), isNull(agents.deletedAt)))
        .limit(1);

      if (!currentAgent) {
        return { ok: false, reason: "agent_not_found" } as const;
      }

      if (!canRestartAgentStatus(currentAgent.status)) {
        return { ok: false, reason: "invalid_status", status: currentAgent.status } as const;
      }

      return { ok: true, agent: currentAgent } as const;
    });

    if (!validation.ok) {
      return validation;
    }

    const runnerRestart = await runnerAdapter.restart(normalizedAgentId);

    if (!runnerRestart.ok) {
      if (isDockerReplacementStartFailure(runnerRestart)) {
        await connection.db
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
              inArray(agents.status, [...RESTARTABLE_AGENT_STATUSES]),
            ),
          );
      }

      return { ok: false, reason: "runner_restart_failed" } as const;
    }

    await captureLifecycleRunnerLogs(runnerAdapter, normalizedAgentId);

    return await connection.db.transaction(async (tx) => {
      const [restartedAgent] = await tx
        .update(agents)
        .set({
          status: "running",
          statusReason: RUNNING_STATUS_REASON,
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
        await runnerAdapter.stop(normalizedAgentId);
        throw new Error("Agent restart update returned no rows.");
      }

      await recordAgentEventsInTransaction(tx, [
        {
          agentId: restartedAgent.id,
          actorUserId: restartedAgent.userId,
          type: RESTART_REQUESTED_EVENT_TYPE,
          message: `Restart requested for agent "${restartedAgent.name}".`,
          metadata: {
            fromStatus: validation.agent.status,
            toStatus: "running",
            ...runnerLifecycleEventMetadata(runnerRestart),
          },
        },
        {
          agentId: restartedAgent.id,
          actorUserId: restartedAgent.userId,
          type: RESTART_COMPLETED_EVENT_TYPE,
          message: `Restart completed for agent "${restartedAgent.name}".`,
          metadata: {
            fromStatus: validation.agent.status,
            toStatus: "running",
            ...runnerLifecycleEventMetadata(runnerRestart),
          },
        },
      ]);

      return {
        ok: true,
        agent: toRestartedAgent(restartedAgent),
        event: {
          type: RESTART_REQUESTED_EVENT_TYPE,
        },
        events: [
          {
            type: RESTART_REQUESTED_EVENT_TYPE,
          },
          {
            type: RESTART_COMPLETED_EVENT_TYPE,
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

export async function simulateErrorAgentForDevelopmentUser(
  agentId: string,
  dependencies: AgentLifecycleDependencies = {},
): Promise<SimulateErrorAgentResult> {
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

      if (!canSimulateErrorAgentStatus(currentAgent.status)) {
        return { ok: false, reason: "invalid_status", status: currentAgent.status };
      }

      const [erroredAgent] = await tx
        .update(agents)
        .set({
          status: "error",
          statusReason: SIMULATED_ERROR_STATUS_REASON,
          updatedAt: now,
        })
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            isNull(agents.deletedAt),
            inArray(agents.status, [...SIMULATE_ERROR_AGENT_STATUSES]),
          ),
        )
        .returning();

      if (!erroredAgent) {
        throw new Error("Agent simulated error update returned no rows.");
      }

      await recordAgentEventInTransaction(tx, {
        agentId: erroredAgent.id,
        actorUserId: erroredAgent.userId,
        type: SIMULATED_ERROR_EVENT_TYPE,
        message: `Simulated error requested for agent "${erroredAgent.name}".`,
        metadata: {
          fromStatus: currentAgent.status,
          toStatus: "error",
          source: "development_simulator",
        },
      });

      return {
        ok: true,
        agent: toSimulatedErrorAgent(erroredAgent),
        event: {
          type: SIMULATED_ERROR_EVENT_TYPE,
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

export async function recordUnexpectedLocalRunnerExitForDevelopmentUser(
  event: LocalRunnerUnexpectedExitEvent,
  dependencies: Pick<AgentLifecycleDependencies, "createConnection" | "now"> = {},
): Promise<boolean> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction(async (tx) => {
      const [currentAgent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, event.agentId), isNull(agents.deletedAt)))
        .limit(1);

      if (!currentAgent || !["starting", "running", "restarting"].includes(currentAgent.status)) {
        return false;
      }

      const [erroredAgent] = await tx
        .update(agents)
        .set({
          status: "error",
          statusReason: LOCAL_RUNNER_UNEXPECTED_EXIT_STATUS_REASON,
          updatedAt: now,
        })
        .where(
          and(
            eq(agents.id, event.agentId),
            isNull(agents.deletedAt),
            inArray(agents.status, ["starting", "running", "restarting"]),
          ),
        )
        .returning();

      if (!erroredAgent) {
        return false;
      }

      await recordAgentEventInTransaction(tx, {
        agentId: erroredAgent.id,
        actorUserId: erroredAgent.userId,
        type: SIMULATED_ERROR_EVENT_TYPE,
        message: `Local runner exited unexpectedly for agent "${erroredAgent.name}".`,
        metadata: {
          fromStatus: currentAgent.status,
          toStatus: "error",
          source: "local_runner",
          localRunnerProcessId: event.process.id,
          localRunnerProcessStatus: event.process.status,
          exitCode: event.exitCode,
          signal: event.signal,
        },
      });

      return true;
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

      await recordAgentEventInTransaction(tx, {
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
  _dependencies: AgentLifecycleDependencies = {},
): Promise<number> {
  return 0;
}

function isDockerReplacementStartFailure(result: LifecycleRunnerRestartResult): result is Extract<
  DockerRunnerRestartResult,
  { ok: false }
> & {
  replacementStartFailed: true;
} {
  return !result.ok && "replacementStartFailed" in result && result.replacementStartFailed === true;
}

function toStartedAgent(agent: typeof agents.$inferSelect): StartedAgent {
  return {
    id: agent.id,
    userId: agent.userId,
    name: agent.name,
    templateKey: agent.templateKey,
    status: "running",
    statusReason: RUNNING_STATUS_REASON,
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
    status: "running",
    statusReason: RUNNING_STATUS_REASON,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    deletedAt: null,
  };
}

function toSimulatedErrorAgent(agent: typeof agents.$inferSelect): SimulatedErrorAgent {
  return {
    id: agent.id,
    userId: agent.userId,
    name: agent.name,
    templateKey: agent.templateKey,
    status: "error",
    statusReason: SIMULATED_ERROR_STATUS_REASON,
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

async function captureLifecycleRunnerLogs(
  runnerAdapter: LifecycleRunnerAdapter,
  agentId: string,
): Promise<void> {
  try {
    await runnerAdapter.streamLogs({ agentId });
  } catch {
    // Lifecycle state should reflect the successful runner transition even if log capture fails.
  }
}

function runnerLifecycleEventMetadata(
  result: LifecycleRunnerStartResult | LifecycleRunnerStopResult | LifecycleRunnerRestartResult,
): Record<string, unknown> {
  if (!result.ok) {
    return {};
  }

  if ("container" in result) {
    return dockerRunnerLifecycleMetadata(result.container);
  }

  return {
    localRunnerProcessId: result.process.id,
  };
}

function dockerRunnerLifecycleMetadata(
  container: DockerRunnerContainerDto,
): Record<string, unknown> {
  return {
    dockerRunnerContainerId: container.id,
    dockerContainerId: container.containerId,
    dockerContainerName: container.containerName,
    dockerImage: container.image,
    dockerObservedStatus: container.observedStatus,
  };
}
