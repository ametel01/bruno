import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentLogs,
  agents,
  dockerRunnerContainers,
  runners,
  type agentStatusEnum,
} from "@/src/server/db/schema";
import {
  recordAgentEventInTransaction,
  recordAgentEventsInTransaction,
} from "@/src/server/events/agent-events";
import {
  DockerRunnerMaintenanceAdapter,
  type DockerRunnerCleanupResult,
  type DockerRunnerStatusResult as DockerRunnerMaintenanceStatusResult,
} from "@/src/server/runners/docker-runner-maintenance";
import {
  DOCKER_RUNNER_LOG_SOURCE,
  type DockerRunnerContainerDto,
} from "@/src/server/runners/docker-runner-state";
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
  type DockerRunnerStatusResult as DockerRunnerLifecycleStatusResult,
  type DockerRunnerStopResult,
} from "@/src/server/runners/docker-runner-adapter";
import {
  ManualRunnerAdapter,
  type ManualRunnerRestartResult,
  type ManualRunnerStartResult,
  type ManualRunnerStatusResult,
  type ManualRunnerStopResult,
} from "@/src/server/runners/manual-runner-adapter";
import {
  ACTIVE_RUNNER_STATUS,
  MANUAL_RUNNER_KIND,
  type ManualRunnerRecord,
} from "@/src/server/runners/manual-runner-persistence";
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
const DOCKER_RECONCILABLE_AGENT_STATUSES = ["starting", "running", "restarting"] as const;
const DOCKER_TERMINAL_CONTAINER_STATUSES = ["dead", "exited"] as const;
export const LOCAL_RUNNER_UNEXPECTED_EXIT_STATUS_REASON =
  "Local runner exited unexpectedly. Check captured process logs for details.";
export const DOCKER_RUNNER_UNEXPECTED_EXIT_STATUS_REASON =
  "Docker runner container exited unexpectedly. Check captured Docker logs for details.";
export const SIMULATED_ERROR_STATUS_REASON = "Simulated error requested for development testing.";

type LifecycleClock = () => Date;
type LifecycleRunnerStartResult =
  | LocalRunnerStartResult
  | DockerRunnerStartResult
  | ManualRunnerStartResult;
type LifecycleRunnerStopResult =
  | LocalRunnerStopResult
  | DockerRunnerStopResult
  | ManualRunnerStopResult;
type LifecycleRunnerRestartResult =
  | LocalRunnerRestartResult
  | DockerRunnerRestartResult
  | ManualRunnerRestartResult;
type LifecycleRunnerStatusResult =
  | LocalRunnerStatusResult
  | DockerRunnerLifecycleStatusResult
  | ManualRunnerStatusResult;
type LifecycleRunnerAdapter = RunnerAdapterContract<
  LifecycleRunnerStartResult,
  LifecycleRunnerStopResult,
  LifecycleRunnerRestartResult,
  LifecycleRunnerStatusResult
>;

type DockerRunnerStatusAdapter = {
  status(agentId: string): Promise<DockerRunnerMaintenanceStatusResult>;
};
type DockerRunnerCleanupAdapter = {
  cleanup(agentId: string): Promise<DockerRunnerCleanupResult>;
};

export type AgentLifecycleDependencies = {
  createConnection?: () => DatabaseConnection;
  dockerRunnerAdapter?: DockerRunnerCleanupAdapter;
  manualRunnerAdapter?: (runner: ManualRunnerRecord) => LifecycleRunnerAdapter;
  now?: LifecycleClock;
  runnerAdapter?: LifecycleRunnerAdapter;
};

export type DockerRunnerReconciliationDependencies = {
  createConnection?: () => DatabaseConnection;
  dockerRunnerAdapter?: DockerRunnerStatusAdapter;
  limit?: number;
  now?: LifecycleClock;
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
      reason:
        | "missing_agent_id"
        | "malformed_agent_id"
        | "agent_not_found"
        | "invalid_status"
        | "runner_cleanup_failed";
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

const assignedRunnerSelection = {
  id: runners.id,
  userId: runners.userId,
  name: runners.name,
  kind: runners.kind,
  endpointUrl: runners.endpointUrl,
  status: runners.status,
  createdAt: runners.createdAt,
  updatedAt: runners.updatedAt,
  deletedAt: runners.deletedAt,
};

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

export function getLifecycleManualRunnerAdapter(
  runner: ManualRunnerRecord,
  dependencies: Pick<AgentLifecycleDependencies, "createConnection"> = {},
): LifecycleRunnerAdapter {
  return new ManualRunnerAdapter(runner, dependencies);
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

  try {
    const validation = await connection.db.transaction(async (tx) => {
      const [currentAgent] = await tx
        .select({
          agent: agents,
          runner: assignedRunnerSelection,
        })
        .from(agents)
        .leftJoin(
          runners,
          and(
            eq(runners.id, agents.runnerId),
            eq(runners.userId, agents.userId),
            eq(runners.kind, MANUAL_RUNNER_KIND),
            eq(runners.status, ACTIVE_RUNNER_STATUS),
            isNull(runners.deletedAt),
          ),
        )
        .where(and(eq(agents.id, normalizedAgentId), isNull(agents.deletedAt)))
        .limit(1);

      if (!currentAgent) {
        return { ok: false, reason: "agent_not_found" } as const;
      }

      if (!canStartAgentStatus(currentAgent.agent.status)) {
        return { ok: false, reason: "invalid_status", status: currentAgent.agent.status } as const;
      }

      return {
        ok: true,
        agent: currentAgent.agent,
        assignedRunner: toManualRunnerRecordOrNull(currentAgent.runner),
      } as const;
    });

    if (!validation.ok) {
      return validation;
    }

    const runnerAdapter = selectLifecycleRunnerAdapter(validation.assignedRunner, {
      createConnection: () => connection,
      ...(dependencies.manualRunnerAdapter
        ? { manualRunnerAdapter: dependencies.manualRunnerAdapter }
        : {}),
      ...(dependencies.runnerAdapter ? { runnerAdapter: dependencies.runnerAdapter } : {}),
    });
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

  try {
    const validation = await connection.db.transaction(async (tx) => {
      const [currentAgent] = await tx
        .select({
          agent: agents,
          runner: assignedRunnerSelection,
        })
        .from(agents)
        .leftJoin(
          runners,
          and(
            eq(runners.id, agents.runnerId),
            eq(runners.userId, agents.userId),
            eq(runners.kind, MANUAL_RUNNER_KIND),
            eq(runners.status, ACTIVE_RUNNER_STATUS),
            isNull(runners.deletedAt),
          ),
        )
        .where(and(eq(agents.id, normalizedAgentId), isNull(agents.deletedAt)))
        .limit(1);

      if (!currentAgent) {
        return { ok: false, reason: "agent_not_found" } as const;
      }

      if (!canStopAgentStatus(currentAgent.agent.status)) {
        return { ok: false, reason: "invalid_status", status: currentAgent.agent.status } as const;
      }

      return {
        ok: true,
        agent: currentAgent.agent,
        assignedRunner: toManualRunnerRecordOrNull(currentAgent.runner),
      } as const;
    });

    if (!validation.ok) {
      return validation;
    }

    const runnerAdapter = selectLifecycleRunnerAdapter(validation.assignedRunner, {
      createConnection: () => connection,
      ...(dependencies.manualRunnerAdapter
        ? { manualRunnerAdapter: dependencies.manualRunnerAdapter }
        : {}),
      ...(dependencies.runnerAdapter ? { runnerAdapter: dependencies.runnerAdapter } : {}),
    });
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

  try {
    const validation = await connection.db.transaction(async (tx) => {
      const [currentAgent] = await tx
        .select({
          agent: agents,
          runner: assignedRunnerSelection,
        })
        .from(agents)
        .leftJoin(
          runners,
          and(
            eq(runners.id, agents.runnerId),
            eq(runners.userId, agents.userId),
            eq(runners.kind, MANUAL_RUNNER_KIND),
            eq(runners.status, ACTIVE_RUNNER_STATUS),
            isNull(runners.deletedAt),
          ),
        )
        .where(and(eq(agents.id, normalizedAgentId), isNull(agents.deletedAt)))
        .limit(1);

      if (!currentAgent) {
        return { ok: false, reason: "agent_not_found" } as const;
      }

      if (!canRestartAgentStatus(currentAgent.agent.status)) {
        return {
          ok: false,
          reason: "invalid_status",
          status: currentAgent.agent.status,
        } as const;
      }

      return {
        ok: true,
        agent: currentAgent.agent,
        assignedRunner: toManualRunnerRecordOrNull(currentAgent.runner),
      } as const;
    });

    if (!validation.ok) {
      return validation;
    }

    const runnerAdapter = selectLifecycleRunnerAdapter(validation.assignedRunner, {
      createConnection: () => connection,
      ...(dependencies.manualRunnerAdapter
        ? { manualRunnerAdapter: dependencies.manualRunnerAdapter }
        : {}),
      ...(dependencies.runnerAdapter ? { runnerAdapter: dependencies.runnerAdapter } : {}),
    });
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

export async function reconcileDockerRunnerAgentsForDevelopmentUser(
  dependencies: DockerRunnerReconciliationDependencies = {},
): Promise<number> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const limit =
    typeof dependencies.limit === "number" && Number.isInteger(dependencies.limit)
      ? Math.min(Math.max(dependencies.limit, 1), 25)
      : 10;
  const dockerRunnerAdapter =
    dependencies.dockerRunnerAdapter ?? (await createDefaultDockerRunnerAdapter(connection));

  try {
    const candidateRows = await connection.db
      .select({ agentId: agents.id })
      .from(dockerRunnerContainers)
      .innerJoin(agents, eq(agents.id, dockerRunnerContainers.agentId))
      .where(
        and(
          isNull(agents.deletedAt),
          inArray(agents.status, [...DOCKER_RECONCILABLE_AGENT_STATUSES]),
        ),
      )
      .orderBy(desc(dockerRunnerContainers.observedAt), desc(dockerRunnerContainers.createdAt))
      .limit(limit);
    const candidateAgentIds = [...new Set(candidateRows.map((row) => row.agentId))];
    let reconciled = 0;

    for (const candidateAgentId of candidateAgentIds) {
      const didReconcile = await reconcileDockerRunnerAgentForDevelopmentUser(candidateAgentId, {
        createConnection: () => connection,
        dockerRunnerAdapter,
        ...(dependencies.now ? { now: dependencies.now } : {}),
      });

      if (didReconcile) {
        reconciled += 1;
      }
    }

    return reconciled;
  } catch {
    throw new AgentLifecyclePersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function reconcileDockerRunnerAgentForDevelopmentUser(
  agentId: string,
  dependencies: DockerRunnerReconciliationDependencies = {},
): Promise<boolean> {
  const normalizedAgentId = agentId.trim();

  if (!isValidAgentId(normalizedAgentId)) {
    return false;
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  const dockerRunnerAdapter =
    dependencies.dockerRunnerAdapter ?? (await createDefaultDockerRunnerAdapter(connection));

  try {
    const status = await dockerRunnerAdapter.status(normalizedAgentId);

    if (!status.ok || !status.container || !isUnexpectedDockerExit(status.container)) {
      return false;
    }

    const reconciledContainer = status.container;

    return await connection.db.transaction(async (tx) => {
      const [currentAgent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, normalizedAgentId), isNull(agents.deletedAt)))
        .limit(1);

      if (
        !currentAgent ||
        !DOCKER_RECONCILABLE_AGENT_STATUSES.includes(
          currentAgent.status as (typeof DOCKER_RECONCILABLE_AGENT_STATUSES)[number],
        )
      ) {
        return false;
      }

      const [storedContainer] = await tx
        .select({ id: dockerRunnerContainers.id })
        .from(dockerRunnerContainers)
        .where(
          and(
            eq(dockerRunnerContainers.id, reconciledContainer.id),
            eq(dockerRunnerContainers.agentId, normalizedAgentId),
            eq(dockerRunnerContainers.containerId, reconciledContainer.containerId),
          ),
        )
        .limit(1);

      if (!storedContainer) {
        return false;
      }

      const [erroredAgent] = await tx
        .update(agents)
        .set({
          status: "error",
          statusReason: DOCKER_RUNNER_UNEXPECTED_EXIT_STATUS_REASON,
          updatedAt: now,
        })
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            isNull(agents.deletedAt),
            inArray(agents.status, [...DOCKER_RECONCILABLE_AGENT_STATUSES]),
          ),
        )
        .returning();

      if (!erroredAgent) {
        return false;
      }

      const metadata = dockerCrashMetadata(reconciledContainer, currentAgent.status);
      const [latestAgentLog] = await tx
        .select({ sequence: agentLogs.sequence })
        .from(agentLogs)
        .where(eq(agentLogs.agentId, normalizedAgentId))
        .orderBy(desc(agentLogs.sequence))
        .limit(1);

      await tx.insert(agentLogs).values({
        agentId: normalizedAgentId,
        runnerId: null,
        localRunnerProcessId: null,
        dockerRunnerContainerId: reconciledContainer.id,
        source: DOCKER_RUNNER_LOG_SOURCE,
        stream: "stderr",
        level: "error",
        message: dockerCrashLogMessage(reconciledContainer),
        metadata,
        sequence: (latestAgentLog?.sequence ?? 0) + 1,
        createdAt: now,
      });

      await recordAgentEventInTransaction(tx, {
        agentId: erroredAgent.id,
        actorUserId: erroredAgent.userId,
        type: SIMULATED_ERROR_EVENT_TYPE,
        message: `Docker runner container exited unexpectedly for agent "${erroredAgent.name}".`,
        metadata,
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
  const dockerRunnerAdapter =
    dependencies.dockerRunnerAdapter ?? (await createDefaultDockerRunnerAdapter(connection));

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

      if (!canDeleteAgentStatus(currentAgent.status)) {
        return { ok: false, reason: "invalid_status", status: currentAgent.status } as const;
      }

      return { ok: true, agent: currentAgent } as const;
    });

    if (!validation.ok) {
      return validation;
    }

    const cleanup = await dockerRunnerAdapter.cleanup(normalizedAgentId);

    if (!cleanup.ok) {
      return {
        ok: false,
        reason: "runner_cleanup_failed",
        status: validation.agent.status,
      };
    }

    return await connection.db.transaction(async (tx) => {
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
          fromStatus: validation.agent.status,
          toStatus: "deleted",
          deletedAt: now.toISOString(),
          ...(cleanup.container
            ? {
                dockerContainerId: cleanup.container.containerId,
                dockerContainerStatus: cleanup.container.observedStatus,
              }
            : {}),
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

function selectLifecycleRunnerAdapter(
  assignedRunner: ManualRunnerRecord | null,
  dependencies: {
    createConnection: () => DatabaseConnection;
    manualRunnerAdapter?: (runner: ManualRunnerRecord) => LifecycleRunnerAdapter;
    runnerAdapter?: LifecycleRunnerAdapter;
  },
): LifecycleRunnerAdapter {
  if (assignedRunner) {
    return (
      dependencies.manualRunnerAdapter?.(assignedRunner) ??
      getLifecycleManualRunnerAdapter(assignedRunner, {
        createConnection: dependencies.createConnection,
      })
    );
  }

  return dependencies.runnerAdapter ?? getLifecycleRunnerAdapter();
}

function toManualRunnerRecordOrNull(
  row: {
    id: string | null;
    userId: string | null;
    name: string | null;
    kind: string | null;
    endpointUrl: string | null;
    status: string | null;
    createdAt: Date | null;
    updatedAt: Date | null;
    deletedAt: Date | null;
  } | null,
): ManualRunnerRecord | null {
  if (
    !row?.id ||
    !row.userId ||
    !row.name ||
    row.kind !== MANUAL_RUNNER_KIND ||
    !row.endpointUrl ||
    row.status !== ACTIVE_RUNNER_STATUS ||
    !row.createdAt ||
    !row.updatedAt
  ) {
    return null;
  }

  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    kind: MANUAL_RUNNER_KIND,
    endpointUrl: row.endpointUrl,
    status: ACTIVE_RUNNER_STATUS,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
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

  if ("runner" in result) {
    return {
      runnerId: result.runner.id,
      runnerKind: result.runner.kind,
      runnerSource: "manual_runner",
    };
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

function isUnexpectedDockerExit(container: DockerRunnerContainerDto): boolean {
  const state = readDockerStateMetadata(container);
  const observedStatus = container.observedStatus.toLowerCase();

  if (typeof state.exitCode === "number") {
    return state.exitCode !== 0;
  }

  if (
    DOCKER_TERMINAL_CONTAINER_STATUSES.includes(
      observedStatus as (typeof DOCKER_TERMINAL_CONTAINER_STATUSES)[number],
    )
  ) {
    return true;
  }

  return false;
}

function dockerCrashMetadata(
  container: DockerRunnerContainerDto,
  fromStatus: AgentLifecycleStatus,
): Record<string, unknown> {
  const state = readDockerStateMetadata(container);

  return {
    fromStatus,
    toStatus: "error",
    source: "docker_runner",
    dockerContainerId: container.containerId,
    dockerContainerStatus: container.observedStatus,
    ...(typeof state.exitCode === "number" ? { dockerExitCode: state.exitCode } : {}),
    ...(typeof state.oomKilled === "boolean" ? { dockerOomKilled: state.oomKilled } : {}),
    ...(typeof state.finishedAt === "string" ? { dockerFinishedAt: state.finishedAt } : {}),
  };
}

function dockerCrashLogMessage(container: DockerRunnerContainerDto): string {
  const state = readDockerStateMetadata(container);
  const exitCode = typeof state.exitCode === "number" ? `, exit code: ${state.exitCode}` : "";

  return `Docker runner container exited unexpectedly (status: ${container.observedStatus}${exitCode}).`;
}

function readDockerStateMetadata(container: DockerRunnerContainerDto): {
  exitCode?: number;
  finishedAt?: string;
  oomKilled?: boolean;
} {
  const state = container.metadata.dockerState;

  if (!isRecord(state)) {
    return {};
  }

  return {
    ...(typeof state.exitCode === "number" ? { exitCode: state.exitCode } : {}),
    ...(typeof state.finishedAt === "string" ? { finishedAt: state.finishedAt } : {}),
    ...(typeof state.oomKilled === "boolean" ? { oomKilled: state.oomKilled } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function createDefaultDockerRunnerAdapter(
  connection: DatabaseConnection,
): Promise<DockerRunnerCleanupAdapter & DockerRunnerStatusAdapter> {
  return new DockerRunnerMaintenanceAdapter({
    createConnection: () => connection,
  });
}
