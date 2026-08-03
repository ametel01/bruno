import { and, desc, eq, exists, gte, inArray, isNull, lt, not, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { HermesReadinessReason } from "@/src/runner-service/docker";
import type {
  RunnerAgentStatusSnapshot,
  RunnerOperation,
} from "@/src/runner-service/runner-contracts";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import {
  type AgentLaunchSpecBuilderDependencies,
  buildHermesAgentLaunchSpecForUser,
} from "@/src/server/agents/agent-launch-builder";
import type { AgentLaunchSpec } from "@/src/server/agents/agent-launch-spec";
import {
  classifyManagedRuntimeForUpdate,
  persistManagedRuntimeOwnerIntent,
} from "@/src/server/agents/agent-runtime-lifecycle";
import { scheduleAgentRuntimeReconcileAfterResponse } from "@/src/server/agents/agent-runtime-triggers";
import { revokeActiveAgentSecretsInTransaction } from "@/src/server/agents/agent-secrets";
import { hermesConfigurationBlocker } from "@/src/server/agents/hermes-readiness";
import { getApprovedOpenRouterModel } from "@/src/server/agents/openrouter-models";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  agentConfigs,
  agentDeployments,
  agentLogs,
  agentRuntimeReconciliations,
  agentSecrets,
  type agentStatusEnum,
  agents,
  agentUsagePeriods,
  dockerRunnerContainers,
  runnerHeartbeats,
  runners,
} from "@/src/server/db/schema";
import {
  recordAgentEventInTransaction,
  recordAgentEventsInTransaction,
} from "@/src/server/events/agent-events";
import { DIGITALOCEAN_RUNNER_KIND } from "@/src/server/runners/digitalocean-provider";
import {
  DockerRunnerAdapter,
  type DockerRunnerStatusResult as DockerRunnerLifecycleStatusResult,
  type DockerRunnerRestartResult,
  type DockerRunnerStartResult,
  type DockerRunnerStopResult,
} from "@/src/server/runners/docker-runner-adapter";
import {
  type DockerRunnerCleanupResult,
  DockerRunnerMaintenanceAdapter,
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
import { reconcileStaleRunnerHeartbeatsInTransaction } from "@/src/server/runners/runner-heartbeat";
import {
  lockRunnerPlacementCapacityInTransaction,
  selectRunnerPlacementForUserInTransaction,
} from "@/src/server/runners/runner-placement";

export type AgentLifecycleStatus = (typeof agentStatusEnum.enumValues)[number];

export const STARTABLE_AGENT_STATUSES = ["idle", "stopped", "error"] as const;
export const STOPPABLE_AGENT_STATUSES = ["starting", "running", "restarting"] as const;
export const RESTARTABLE_AGENT_STATUSES = ["running"] as const;
export const SIMULATE_ERROR_AGENT_STATUSES = [
  "idle",
  "stopped",
  "starting",
  "running",
  "restarting",
] as const;
export const DELETABLE_AGENT_STATUSES = [
  "idle",
  "starting",
  "running",
  "restarting",
  "stopped",
  "error",
] as const;
const ASSIGNABLE_LIFECYCLE_RUNNER_KINDS = [MANUAL_RUNNER_KIND, DIGITALOCEAN_RUNNER_KIND] as const;
const ASSIGNABLE_LIFECYCLE_RUNNER_STATUSES = [ACTIVE_RUNNER_STATUS, "online"] as const;
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
const START_FINALIZATION_CLEANUP_FAILED_STATUS_REASON =
  "Runner start succeeded, but lifecycle finalization and runner cleanup failed.";
const HERMES_READINESS_FAILED_STATUS_REASON =
  "Hermes container started, but readiness did not complete. Check captured runner logs for details.";
const DOCKER_RECONCILABLE_AGENT_STATUSES = ["starting", "running", "restarting"] as const;
const DOCKER_TERMINAL_CONTAINER_STATUSES = ["dead", "exited"] as const;
export const LOCAL_RUNNER_UNEXPECTED_EXIT_STATUS_REASON =
  "Local runner exited unexpectedly. Check captured process logs for details.";
export const DOCKER_RUNNER_UNEXPECTED_EXIT_STATUS_REASON =
  "Docker runner container exited unexpectedly. Check captured Docker logs for details.";
export const SIMULATED_ERROR_STATUS_REASON = "Simulated error requested for development testing.";
const DEPLOYMENT_CANCELLED_ERROR_DETAIL = "Automatic deployment was cancelled.";
const AGENT_DELETED_DEPLOYMENT_ERROR_DETAIL =
  "Automatic deployment was cancelled because the agent was deleted.";

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

type AgentLifecycleTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

type StartRunnerReservationResult =
  | {
      ok: true;
      assignedRunner: ManualRunnerRecord | null;
      reserved: boolean;
    }
  | {
      ok: false;
      reason: "invalid_status";
      status: AgentLifecycleStatus;
    }
  | {
      ok: false;
      reason: "plan_limit_reached";
      currentAgents: number;
      maxAgents: number;
    }
  | {
      ok: false;
      reason: "runner_capacity_reached";
    }
  | {
      ok: false;
      reason: "no_online_runner";
    };

type AgentStartRunnerSnapshot = {
  id: string;
  kind: string;
  status: string;
  provider: string | null;
  providerResourceId: string | null;
  provisioningStatus: string | null;
  provisioningError: string | null;
  hasEndpointUrl: boolean;
  deleted: boolean;
  latestHeartbeatAt: string | null;
  latestHeartbeatStatus: string | null;
};

export type AgentLifecycleDependencies = {
  createConnection?: () => DatabaseConnection;
  dockerRunnerAdapter?: DockerRunnerCleanupAdapter;
  launchSpec?: Pick<
    AgentLaunchSpecBuilderDependencies,
    "env" | "hermesWorkloadImage" | "requestId"
  >;
  manualRunnerAdapter?: (runner: ManualRunnerRecord) => LifecycleRunnerAdapter;
  now?: LifecycleClock;
  planMaxAgents?: number | null;
  runnerAdapter?: LifecycleRunnerAdapter;
  scheduleRuntimeReconcile?: typeof scheduleAgentRuntimeReconcileAfterResponse;
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
      state: "ready";
      agent: StartedAgent;
      event: {
        type: typeof START_REQUESTED_EVENT_TYPE;
      };
      events: Array<
        { type: typeof START_REQUESTED_EVENT_TYPE } | { type: typeof START_COMPLETED_EVENT_TYPE }
      >;
    }
  | {
      ok: true;
      state: "accepted";
      agent: StartedAgent;
      event: { type: typeof START_REQUESTED_EVENT_TYPE };
      events: [{ type: typeof START_REQUESTED_EVENT_TYPE }];
      operation?: RunnerOperation;
      snapshot?: RunnerAgentStatusSnapshot;
    }
  | {
      ok: false;
      reason:
        | "missing_agent_id"
        | "malformed_agent_id"
        | "agent_not_found"
        | "invalid_status"
        | "plan_limit_reached"
        | "runner_capacity_reached"
        | "no_online_runner"
        | "hermes_setup_incomplete"
        | "runner_start_failed";
      status?: AgentLifecycleStatus;
      message?: string;
      currentAgents?: number;
      maxAgents?: number;
    };

export type StartedAgent = {
  id: string;
  userId: string;
  name: string;
  templateKey: string;
  status: "starting" | "running";
  statusReason: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: null;
};

export type StopAgentResult =
  | {
      ok: true;
      agent: StoppedAgent | StoppingAgent;
      events: Array<
        { type: typeof STOP_REQUESTED_EVENT_TYPE } | { type: typeof STOP_COMPLETED_EVENT_TYPE }
      >;
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

export type StoppingAgent = Omit<StoppedAgent, "status" | "statusReason"> & {
  status: "restarting";
  statusReason: string;
};

export type RestartAgentResult =
  | {
      ok: true;
      state: "ready";
      agent: RestartedAgent;
      event: {
        type: typeof RESTART_REQUESTED_EVENT_TYPE;
      };
      events: Array<
        | { type: typeof RESTART_REQUESTED_EVENT_TYPE }
        | { type: typeof RESTART_COMPLETED_EVENT_TYPE }
      >;
    }
  | {
      ok: true;
      state: "accepted";
      agent: RestartedAgent;
      event: { type: typeof RESTART_REQUESTED_EVENT_TYPE };
      events: [{ type: typeof RESTART_REQUESTED_EVENT_TYPE }];
      operation?: RunnerOperation;
      snapshot?: RunnerAgentStatusSnapshot;
    }
  | {
      ok: false;
      reason:
        | "missing_agent_id"
        | "malformed_agent_id"
        | "agent_not_found"
        | "invalid_status"
        | "hermes_setup_incomplete"
        | "runner_restart_failed";
      status?: AgentLifecycleStatus;
      message?: string;
    };

export type RestartedAgent = {
  id: string;
  userId: string;
  name: string;
  templateKey: string;
  status: "restarting" | "running";
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

const agentStartRunnerSnapshotSelection = {
  id: runners.id,
  kind: runners.kind,
  status: runners.status,
  provider: runners.provider,
  providerResourceId: runners.providerResourceId,
  provisioningStatus: runners.provisioningStatus,
  provisioningError: runners.provisioningError,
  endpointUrl: runners.endpointUrl,
  deletedAt: runners.deletedAt,
};

export function getLifecycleRunnerAdapter(): LifecycleRunnerAdapter {
  lifecycleRunnerAdapter ??= new DockerRunnerAdapter();

  return lifecycleRunnerAdapter;
}

export function getLifecycleRunnerAdapterForUser(
  userId: string,
  dependencies: Pick<AgentLifecycleDependencies, "createConnection"> = {},
): LifecycleRunnerAdapter {
  return new DockerRunnerAdapter({
    userId,
    ...(dependencies.createConnection ? { createConnection: dependencies.createConnection } : {}),
  });
}

export function getLifecycleLocalRunnerAdapter(): LifecycleRunnerAdapter {
  lifecycleLocalRunnerAdapter ??= new LocalRunnerAdapter({
    onUnexpectedExit: async (event) => {
      await recordUnexpectedLocalRunnerExitForDevelopmentUser(event);
    },
  });

  return lifecycleLocalRunnerAdapter;
}

export function getLifecycleLocalRunnerAdapterForUser(
  userId: string,
  dependencies: Pick<AgentLifecycleDependencies, "createConnection"> = {},
): LifecycleRunnerAdapter {
  return new LocalRunnerAdapter({
    userId,
    ...(dependencies.createConnection ? { createConnection: dependencies.createConnection } : {}),
    onUnexpectedExit: async (event) => {
      await recordUnexpectedLocalRunnerExitForUser(userId, event, dependencies);
    },
  });
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

async function reserveRunnerForAgentStart(input: {
  agentId: string;
  userId: string;
  assignedRunnerId: string | null;
  assignedRunner: ManualRunnerRecord | null;
  connection: DatabaseConnection;
  now: Date;
  planMaxAgents?: number | null | undefined;
}): Promise<StartRunnerReservationResult> {
  if (input.assignedRunnerId && !input.assignedRunner) {
    return { ok: false, reason: "no_online_runner" } as const;
  }

  if (input.assignedRunner && input.assignedRunner.status !== "online") {
    return { ok: true, assignedRunner: input.assignedRunner, reserved: false };
  }

  return await input.connection.db.transaction(async (tx) => {
    const placement = await selectStartRunnerPlacement(tx, {
      userId: input.userId,
      assignedRunner: input.assignedRunner,
      now: input.now,
      planMaxAgents: input.planMaxAgents,
    });

    if (!placement.ok) {
      return placement;
    }

    if (!placement.runnerId) {
      return { ok: true, assignedRunner: null, reserved: false } as const;
    }

    const [runnerRow] = await tx
      .select(assignedRunnerSelection)
      .from(runners)
      .where(
        and(
          eq(runners.id, placement.runnerId),
          eq(runners.userId, input.userId),
          isNull(runners.deletedAt),
        ),
      )
      .limit(1);
    const assignedRunner = toManualRunnerRecordOrNull(runnerRow ?? null);

    if (!assignedRunner) {
      return { ok: false, reason: "runner_capacity_reached" } as const;
    }

    const [reservedAgent] = await tx
      .update(agents)
      .set({
        runnerId: placement.runnerId,
        status: "starting",
        statusReason: "Start requested.",
        updatedAt: input.now,
      })
      .where(
        and(
          eq(agents.id, input.agentId),
          eq(agents.userId, input.userId),
          isNull(agents.deletedAt),
          inArray(agents.status, [...STARTABLE_AGENT_STATUSES]),
        ),
      )
      .returning({ id: agents.id, status: agents.status });

    if (!reservedAgent) {
      return { ok: false, reason: "invalid_status", status: "starting" } as const;
    }

    return { ok: true, assignedRunner, reserved: true } as const;
  });
}

async function selectStartRunnerPlacement(
  tx: AgentLifecycleTransaction,
  input: {
    userId: string;
    assignedRunner: ManualRunnerRecord | null;
    now: Date;
    planMaxAgents?: number | null | undefined;
  },
): Promise<
  | {
      ok: true;
      runnerId: string | null;
    }
  | Exclude<StartRunnerReservationResult, { ok: true }>
> {
  if (input.assignedRunner) {
    await lockRunnerPlacementCapacityInTransaction(tx, input.assignedRunner.id);
    const placement = await selectRunnerPlacementForUserInTransaction(
      tx,
      input.userId,
      {
        planMaxAgents: input.planMaxAgents,
        runnerId: input.assignedRunner.id,
      },
      { now: input.now },
    );

    if (placement.ok) {
      return { ok: true, runnerId: placement.runner.id } as const;
    }

    if (placement.reason === "plan_limit_reached") {
      return {
        ok: false,
        reason: "plan_limit_reached",
        currentAgents: placement.currentAgents,
        maxAgents: placement.maxAgents,
      } as const;
    }

    if (placement.reason === "runner_capacity_reached") {
      return { ok: false, reason: "runner_capacity_reached" } as const;
    }

    return { ok: false, reason: "no_online_runner" } as const;
  }

  const placement = await selectRunnerPlacementForUserInTransaction(
    tx,
    input.userId,
    {
      planMaxAgents: input.planMaxAgents,
    },
    { now: input.now },
  );

  if (placement.ok) {
    await lockRunnerPlacementCapacityInTransaction(tx, placement.runner.id);
    const confirmedPlacement = await selectRunnerPlacementForUserInTransaction(
      tx,
      input.userId,
      {
        planMaxAgents: input.planMaxAgents,
        runnerId: placement.runner.id,
      },
      { now: input.now },
    );

    if (!confirmedPlacement.ok && confirmedPlacement.reason === "plan_limit_reached") {
      return {
        ok: false,
        reason: "plan_limit_reached",
        currentAgents: confirmedPlacement.currentAgents,
        maxAgents: confirmedPlacement.maxAgents,
      } as const;
    }

    if (!confirmedPlacement.ok) {
      return { ok: false, reason: "runner_capacity_reached" } as const;
    }

    return { ok: true, runnerId: confirmedPlacement.runner.id } as const;
  }

  if (placement.reason === "no_online_runner" && shouldRequireOnlineRunnerForStart()) {
    return { ok: false, reason: "no_online_runner" } as const;
  }

  if (placement.reason === "no_online_runner") {
    return { ok: true, runnerId: null } as const;
  }

  if (placement.reason === "plan_limit_reached") {
    return {
      ok: false,
      reason: "plan_limit_reached",
      currentAgents: placement.currentAgents,
      maxAgents: placement.maxAgents,
    } as const;
  }

  if (placement.reason === "runner_capacity_reached") {
    return { ok: false, reason: "runner_capacity_reached" } as const;
  }

  return { ok: false, reason: "runner_capacity_reached" } as const;
}

async function restoreAgentStartReservation(input: {
  agentId: string;
  userId: string;
  connection: DatabaseConnection;
  previousStatus: AgentLifecycleStatus;
  previousStatusReason: string | null;
  now: Date;
  expectedUpdatedAt: Date;
}): Promise<void> {
  await input.connection.db
    .update(agents)
    .set({
      status: input.previousStatus,
      statusReason: input.previousStatusReason,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(agents.id, input.agentId),
        eq(agents.userId, input.userId),
        eq(agents.status, "starting"),
        agentUpdatedAtMatches(input.expectedUpdatedAt),
      ),
    );
}

async function markAgentStartFinalizationCleanupFailed(input: {
  agentId: string;
  userId: string;
  connection: DatabaseConnection;
  now: Date;
  expectedStatus: AgentLifecycleStatus;
  expectedUpdatedAt: Date;
}): Promise<void> {
  await input.connection.db
    .update(agents)
    .set({
      status: "error",
      statusReason: START_FINALIZATION_CLEANUP_FAILED_STATUS_REASON,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(agents.id, input.agentId),
        eq(agents.userId, input.userId),
        eq(agents.status, input.expectedStatus),
        agentUpdatedAtMatches(input.expectedUpdatedAt),
        isNull(agents.deletedAt),
      ),
    );
}

async function restoreAgentRestartReservation(input: {
  agentId: string;
  userId: string;
  connection: DatabaseConnection;
  previousStatusReason: string | null;
  expectedUpdatedAt: Date;
}): Promise<void> {
  await input.connection.db
    .update(agents)
    .set({
      status: "running",
      statusReason: input.previousStatusReason,
      updatedAt: input.expectedUpdatedAt,
    })
    .where(
      and(
        eq(agents.id, input.agentId),
        eq(agents.userId, input.userId),
        eq(agents.status, "restarting"),
        agentUpdatedAtMatches(input.expectedUpdatedAt),
        isNull(agents.deletedAt),
      ),
    );
}

async function readAgentStartRunnerSnapshot(
  tx: AgentLifecycleTransaction,
  input: { runnerId: string; userId: string },
): Promise<AgentStartRunnerSnapshot | null> {
  const [runner] = await tx
    .select(agentStartRunnerSnapshotSelection)
    .from(runners)
    .where(and(eq(runners.id, input.runnerId), eq(runners.userId, input.userId)))
    .limit(1);

  if (!runner) {
    return null;
  }

  const [latestHeartbeat] = await tx
    .select({
      status: runnerHeartbeats.status,
      observedAt: runnerHeartbeats.observedAt,
    })
    .from(runnerHeartbeats)
    .where(eq(runnerHeartbeats.runnerId, runner.id))
    .orderBy(desc(runnerHeartbeats.observedAt))
    .limit(1);

  return {
    id: runner.id,
    kind: runner.kind,
    status: runner.status,
    provider: runner.provider,
    providerResourceId: runner.providerResourceId,
    provisioningStatus: runner.provisioningStatus,
    provisioningError: runner.provisioningError,
    hasEndpointUrl: Boolean(runner.endpointUrl),
    deleted: Boolean(runner.deletedAt),
    latestHeartbeatAt: latestHeartbeat?.observedAt.toISOString() ?? null,
    latestHeartbeatStatus: latestHeartbeat?.status ?? null,
  };
}

async function readHermesConfigurationBlocker(
  tx: AgentLifecycleTransaction,
  agentId: string,
): Promise<string | null> {
  const [config] = await tx
    .select({
      modelProvider: agentConfigs.modelProvider,
      modelName: agentConfigs.modelName,
    })
    .from(agentConfigs)
    .where(eq(agentConfigs.agentId, agentId))
    .limit(1);
  const activeSecretRows = await tx
    .select({ kind: agentSecrets.kind })
    .from(agentSecrets)
    .where(and(eq(agentSecrets.agentId, agentId), eq(agentSecrets.status, "active")));
  const [latestDeployment] = await tx
    .select({ id: agentDeployments.id })
    .from(agentDeployments)
    .where(and(eq(agentDeployments.agentId, agentId)))
    .orderBy(desc(agentDeployments.createdAt), desc(agentDeployments.id))
    .limit(1);
  const isManaged =
    latestDeployment !== undefined &&
    config?.modelProvider === "openrouter" &&
    getApprovedOpenRouterModel(config.modelName) !== null;

  if (isManaged) {
    const secretKinds = new Set(activeSecretRows.map((secret) => secret.kind));

    const requiredManagedSecretKinds = [
      "openrouter_api_key",
      "telegram_bot_token",
      "telegram_allowed_users",
      "api_server_key",
    ] as const;

    for (const kind of requiredManagedSecretKinds) {
      if (!secretKinds.has(kind)) {
        return "Managed Hermes credentials are incomplete.";
      }
    }

    return null;
  }

  return hermesConfigurationBlocker({
    modelProvider: config?.modelProvider ?? "not_configured",
    modelName: config?.modelName ?? "not_configured",
    secretKinds: new Set(activeSecretRows.map((secret) => secret.kind)),
  });
}

function isHermesLifecycleReadyRunnerSnapshot(
  runner: AgentStartRunnerSnapshot | null,
): runner is AgentStartRunnerSnapshot {
  return (
    runner?.kind === DIGITALOCEAN_RUNNER_KIND &&
    runner.status === "online" &&
    runner.provisioningStatus === "ready" &&
    runner.hasEndpointUrl &&
    !runner.deleted
  );
}

async function buildLifecycleHermesLaunchSpec(input: {
  agentId: string;
  userId: string;
  connection: DatabaseConnection;
  dependencies: AgentLifecycleDependencies;
}): Promise<{ ok: true; spec: AgentLaunchSpec } | { ok: false; message: string }> {
  const result = await buildHermesAgentLaunchSpecForUser(input.userId, input.agentId, {
    createConnection: () => input.connection,
    ...(input.dependencies.launchSpec ?? {}),
  });

  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  return result;
}

async function runLegacyAgentLifecycleOperation<Result>(
  agentId: string,
  dependencies: AgentLifecycleDependencies,
  notFound: Result,
  operation: (
    userId: string,
    agentId: string,
    dependencies: AgentLifecycleDependencies,
  ) => Promise<Result>,
): Promise<Result> {
  const normalizedAgentId = agentId.trim();

  if (normalizedAgentId.length === 0 || !isValidAgentId(normalizedAgentId)) {
    return operation("", agentId, dependencies);
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const [agent] = await connection.db
      .select({ userId: agents.userId })
      .from(agents)
      .where(and(eq(agents.id, normalizedAgentId), isNull(agents.deletedAt)))
      .limit(1);

    if (!agent) {
      return notFound;
    }

    return await operation(agent.userId, normalizedAgentId, {
      ...dependencies,
      createConnection: () => connection,
    });
  } catch (error) {
    if (error instanceof AgentLifecyclePersistenceError) {
      throw error;
    }

    throw new AgentLifecyclePersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function startAgentForDevelopmentUser(
  agentId: string,
  dependencies: AgentLifecycleDependencies = {},
): Promise<StartAgentResult> {
  return runLegacyAgentLifecycleOperation(
    agentId,
    dependencies,
    { ok: false, reason: "agent_not_found" },
    startAgentForUser,
  );
}

export async function startAgentForUser(
  userId: string,
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
      const [ownedAgent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            eq(agents.userId, userId),
            isNull(agents.deletedAt),
          ),
        )
        .limit(1);

      if (!ownedAgent) {
        return { ok: false, reason: "agent_not_found" } as const;
      }

      await reconcileStaleRunnerHeartbeatsInTransaction(tx, { now, userId });

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
            inArray(runners.kind, [...ASSIGNABLE_LIFECYCLE_RUNNER_KINDS]),
            inArray(runners.status, [...ASSIGNABLE_LIFECYCLE_RUNNER_STATUSES]),
            isNull(runners.deletedAt),
          ),
        )
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            eq(agents.userId, userId),
            isNull(agents.deletedAt),
          ),
        )
        .limit(1);

      if (!currentAgent) {
        return { ok: false, reason: "agent_not_found" } as const;
      }

      if (!canStartAgentStatus(currentAgent.agent.status)) {
        return { ok: false, reason: "invalid_status", status: currentAgent.agent.status } as const;
      }

      const runtimeClassification = await classifyManagedRuntimeForUpdate(tx, {
        agentId: normalizedAgentId,
        userId,
      });

      if (
        runtimeClassification.kind === "latest_failed" ||
        runtimeClassification.kind === "managed_unavailable"
      ) {
        return { ok: false, reason: "invalid_status", status: currentAgent.agent.status } as const;
      }

      if (runtimeClassification.kind === "managed_ready") {
        const generation = await persistManagedRuntimeOwnerIntent(tx, {
          agentId: normalizedAgentId,
          userId,
          expectedGeneration: runtimeClassification.runtime.generation,
          intent: "start",
          now,
        });

        if (generation === null) {
          throw new Error("Managed start lost its runtime generation fence.");
        }

        const [startedAgent] = await tx
          .update(agents)
          .set({
            desiredStatus: "running",
            status: "starting",
            statusReason: "Start requested; runtime convergence scheduled.",
            updatedAt: now,
          })
          .where(
            and(
              eq(agents.id, normalizedAgentId),
              eq(agents.userId, userId),
              isNull(agents.deletedAt),
              eq(agents.status, currentAgent.agent.status),
              agentUpdatedAtMatches(currentAgent.agent.updatedAt),
            ),
          )
          .returning();

        if (!startedAgent) {
          throw new Error("Managed start lost its agent fence.");
        }

        await recordAgentEventInTransaction(tx, {
          agentId: normalizedAgentId,
          actorUserId: userId,
          type: START_REQUESTED_EVENT_TYPE,
          message: `Start requested for agent "${startedAgent.name}".`,
          metadata: {
            fromStatus: currentAgent.agent.status,
            toStatus: "starting",
          },
        });

        return { ok: true, managed: true, agent: startedAgent } as const;
      }

      const assignedRunnerSnapshot = currentAgent.agent.runnerId
        ? await readAgentStartRunnerSnapshot(tx, {
            runnerId: currentAgent.agent.runnerId,
            userId,
          })
        : null;
      const setupBlocker = isHermesLifecycleReadyRunnerSnapshot(assignedRunnerSnapshot)
        ? await readHermesConfigurationBlocker(tx, currentAgent.agent.id)
        : null;

      if (setupBlocker) {
        return {
          ok: false,
          reason: "hermes_setup_incomplete",
          message: setupBlocker,
        } as const;
      }

      return {
        ok: true,
        agent: currentAgent.agent,
        assignedRunner: toManualRunnerRecordOrNull(currentAgent.runner),
        assignedRunnerSnapshot,
        requiresHermesLaunchSpec: isHermesLifecycleReadyRunnerSnapshot(assignedRunnerSnapshot),
      } as const;
    });

    if (!validation.ok) {
      logAgentStart("validation_blocked", {
        agentId: normalizedAgentId,
        reason: validation.reason,
        status: "status" in validation ? validation.status : undefined,
      });
      return validation;
    }

    if ("managed" in validation && validation.managed) {
      (dependencies.scheduleRuntimeReconcile ?? scheduleAgentRuntimeReconcileAfterResponse)(
        normalizedAgentId,
      );
      return {
        ok: true,
        state: "accepted",
        agent: toStartedAgent(validation.agent),
        event: { type: START_REQUESTED_EVENT_TYPE },
        events: [{ type: START_REQUESTED_EVENT_TYPE }],
      };
    }

    logAgentStart("agent_loaded", {
      agentId: normalizedAgentId,
      agentStatus: validation.agent.status,
      assignedRunnerId: validation.agent.runnerId,
      assignedRunnerUsable: Boolean(validation.assignedRunner),
      assignedRunner: validation.assignedRunnerSnapshot,
    });

    const reservation = await reserveRunnerForAgentStart({
      agentId: normalizedAgentId,
      userId,
      assignedRunnerId: validation.agent.runnerId,
      assignedRunner: validation.assignedRunner,
      connection,
      now,
      planMaxAgents: dependencies.planMaxAgents,
    });

    if (!reservation.ok) {
      logAgentStart("reservation_blocked", {
        agentId: normalizedAgentId,
        reason: reservation.reason,
        currentAgents: "currentAgents" in reservation ? reservation.currentAgents : undefined,
        maxAgents: "maxAgents" in reservation ? reservation.maxAgents : undefined,
        assignedRunnerId: validation.agent.runnerId,
        assignedRunner: validation.assignedRunnerSnapshot,
      });
      return reservation;
    }

    logAgentStart("reservation_succeeded", {
      agentId: normalizedAgentId,
      assignedRunnerId: reservation.assignedRunner?.id ?? null,
      assignedRunnerKind: reservation.assignedRunner?.kind ?? null,
      assignedRunnerStatus: reservation.assignedRunner?.status ?? null,
      reserved: reservation.reserved,
    });

    const runnerAdapter = selectLifecycleRunnerAdapter(reservation.assignedRunner, {
      userId,
      createConnection: () => connection,
      ...(dependencies.manualRunnerAdapter
        ? { manualRunnerAdapter: dependencies.manualRunnerAdapter }
        : {}),
      ...(dependencies.runnerAdapter ? { runnerAdapter: dependencies.runnerAdapter } : {}),
    });
    logAgentStart("runner_start_requested", {
      agentId: normalizedAgentId,
      assignedRunnerId: reservation.assignedRunner?.id ?? null,
      assignedRunnerKind: reservation.assignedRunner?.kind ?? null,
      assignedRunnerStatus: reservation.assignedRunner?.status ?? null,
    });
    const launchSpec = validation.requiresHermesLaunchSpec
      ? await buildLifecycleHermesLaunchSpec({
          agentId: normalizedAgentId,
          userId,
          connection,
          dependencies,
        })
      : ({ ok: true, spec: null } as const);

    if (!launchSpec.ok) {
      return {
        ok: false,
        reason: "hermes_setup_incomplete",
        message: launchSpec.message,
      } as const;
    }

    const runnerStart = await runnerAdapter.start(normalizedAgentId, launchSpec.spec);

    if (!runnerStart.ok) {
      if (isHermesSetupRunnerFailure(runnerStart)) {
        if (reservation.reserved) {
          await restoreAgentStartReservation({
            agentId: normalizedAgentId,
            userId,
            connection,
            previousStatus: validation.agent.status,
            previousStatusReason: validation.agent.statusReason,
            now,
            expectedUpdatedAt: now,
          });
        }

        return {
          ok: false,
          reason: "hermes_setup_incomplete",
          message: "Run Hermes setup before starting this agent.",
        } as const;
      }

      if (isHermesReadinessRunnerFailure(runnerStart)) {
        await recordHermesReadinessFailure({
          agentId: normalizedAgentId,
          userId,
          connection,
          now,
          expectedStatus: reservation.reserved ? "starting" : validation.agent.status,
          expectedUpdatedAt: reservation.reserved ? now : validation.agent.updatedAt,
          ...(runnerStart.readinessReason ? { readinessReason: runnerStart.readinessReason } : {}),
        });

        logAgentStart("runner_start_failed", {
          agentId: normalizedAgentId,
          reason: runnerStart.reason,
          assignedRunnerId: reservation.assignedRunner?.id ?? null,
          assignedRunnerKind: reservation.assignedRunner?.kind ?? null,
        });

        return { ok: false, reason: "runner_start_failed" } as const;
      }

      if (reservation.reserved) {
        await restoreAgentStartReservation({
          agentId: normalizedAgentId,
          userId,
          connection,
          previousStatus: validation.agent.status,
          previousStatusReason: validation.agent.statusReason,
          now,
          expectedUpdatedAt: now,
        });
      }

      logAgentStart("runner_start_failed", {
        agentId: normalizedAgentId,
        reason: runnerStart.reason,
        assignedRunnerId: reservation.assignedRunner?.id ?? null,
        assignedRunnerKind: reservation.assignedRunner?.kind ?? null,
      });

      return { ok: false, reason: "runner_start_failed" } as const;
    }

    logAgentStart("runner_start_succeeded", {
      agentId: normalizedAgentId,
      ...runnerLifecycleEventMetadata(runnerStart),
    });

    await captureLifecycleRunnerLogs(runnerAdapter, normalizedAgentId);

    try {
      return await connection.db.transaction(async (tx) => {
        const accepted = isAcceptedRunnerSuccess(runnerStart);
        const targetStatus = accepted ? "starting" : "running";
        const statusReason = accepted ? "Start accepted by runner." : RUNNING_STATUS_REASON;
        const [startedAgent] = await tx
          .update(agents)
          .set({
            status: targetStatus,
            statusReason,
            updatedAt: now,
          })
          .where(
            and(
              eq(agents.id, normalizedAgentId),
              eq(agents.userId, userId),
              isNull(agents.deletedAt),
              inArray(
                agents.status,
                reservation.reserved ? ["starting"] : [...STARTABLE_AGENT_STATUSES],
              ),
              agentUpdatedAtMatches(reservation.reserved ? now : validation.agent.updatedAt),
            ),
          )
          .returning();

        if (!startedAgent) {
          throw new Error("Agent start update returned no rows.");
        }

        if (!accepted) {
          await tx.insert(agentUsagePeriods).values({
            agentId: startedAgent.id,
            runnerId: startedAgent.runnerId,
            source: "lifecycle",
            startedAt: now,
            createdAt: now,
            updatedAt: now,
          });
        }

        const eventsToRecord = [
          {
            agentId: startedAgent.id,
            actorUserId: userId,
            type: START_REQUESTED_EVENT_TYPE,
            message: `Start requested for agent "${startedAgent.name}".`,
            metadata: {
              fromStatus: validation.agent.status,
              toStatus: targetStatus,
              ...runnerLifecycleEventMetadata(runnerStart),
            },
          },
        ];

        if (!accepted) {
          eventsToRecord.push({
            agentId: startedAgent.id,
            actorUserId: userId,
            type: START_COMPLETED_EVENT_TYPE,
            message: `Start completed for agent "${startedAgent.name}".`,
            metadata: {
              fromStatus: validation.agent.status,
              toStatus: "running",
              ...runnerLifecycleEventMetadata(runnerStart),
            },
          });
        }

        await recordAgentEventsInTransaction(tx, eventsToRecord);

        logAgentStart(accepted ? "start_accepted" : "start_completed", {
          agentId: normalizedAgentId,
          fromStatus: validation.agent.status,
          toStatus: targetStatus,
          ...runnerLifecycleEventMetadata(runnerStart),
        });

        const agent = toStartedAgent(startedAgent);

        if (accepted) {
          return {
            ok: true,
            state: "accepted",
            agent,
            event: { type: START_REQUESTED_EVENT_TYPE },
            events: [{ type: START_REQUESTED_EVENT_TYPE }],
            operation: runnerStart.operation,
            snapshot: runnerStart.snapshot,
          };
        }

        return {
          ok: true,
          state: "ready",
          agent,
          event: { type: START_REQUESTED_EVENT_TYPE },
          events: [{ type: START_REQUESTED_EVENT_TYPE }, { type: START_COMPLETED_EVENT_TYPE }],
        };
      });
    } catch (error) {
      const cleanup = await runnerAdapter.stop(normalizedAgentId).catch(() => null);

      if (cleanup?.ok) {
        if (reservation.reserved) {
          await restoreAgentStartReservation({
            agentId: normalizedAgentId,
            userId,
            connection,
            previousStatus: validation.agent.status,
            previousStatusReason: validation.agent.statusReason,
            now,
            expectedUpdatedAt: now,
          });
        }
      } else {
        await markAgentStartFinalizationCleanupFailed({
          agentId: normalizedAgentId,
          userId,
          connection,
          now,
          expectedStatus: reservation.reserved ? "starting" : validation.agent.status,
          expectedUpdatedAt: reservation.reserved ? now : validation.agent.updatedAt,
        }).catch(() => undefined);
      }

      logAgentStart("start_finalization_failed", {
        agentId: normalizedAgentId,
        assignedRunnerId: reservation.assignedRunner?.id ?? null,
        runnerCleanupSucceeded: cleanup?.ok === true,
        reservationRestored: cleanup?.ok === true && reservation.reserved,
      });

      throw error;
    }
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
  return runLegacyAgentLifecycleOperation(
    agentId,
    dependencies,
    { ok: false, reason: "agent_not_found" },
    stopAgentForUser,
  );
}

export async function stopAgentForUser(
  userId: string,
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
            inArray(runners.kind, [...ASSIGNABLE_LIFECYCLE_RUNNER_KINDS]),
            inArray(runners.status, [...ASSIGNABLE_LIFECYCLE_RUNNER_STATUSES]),
            isNull(runners.deletedAt),
          ),
        )
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            eq(agents.userId, userId),
            isNull(agents.deletedAt),
          ),
        )
        .limit(1);

      if (!currentAgent) {
        return { ok: false, reason: "agent_not_found" } as const;
      }

      const activeDeployment = await lockActiveAutomaticDeploymentInTransaction(
        tx,
        normalizedAgentId,
        userId,
      );

      if (
        !canStopAgentStatus(currentAgent.agent.status) &&
        !(activeDeployment && currentAgent.agent.status === "stopped")
      ) {
        return { ok: false, reason: "invalid_status", status: currentAgent.agent.status } as const;
      }

      if (activeDeployment) {
        await cancelActiveAutomaticDeploymentInTransaction(tx, {
          agentId: normalizedAgentId,
          userId,
          deployment: activeDeployment,
          code: "deployment_cancelled",
          detail: DEPLOYMENT_CANCELLED_ERROR_DETAIL,
          now,
        });
      }

      const runtimeClassification = activeDeployment
        ? ({ kind: "active_deployment" } as const)
        : await classifyManagedRuntimeForUpdate(tx, {
            agentId: normalizedAgentId,
            userId,
          });

      if (runtimeClassification.kind === "managed_ready") {
        const generation = await persistManagedRuntimeOwnerIntent(tx, {
          agentId: normalizedAgentId,
          userId,
          expectedGeneration: runtimeClassification.runtime.generation,
          intent: "stop",
          now,
        });

        if (generation === null) {
          throw new Error("Managed stop lost its runtime generation fence.");
        }

        const [stoppingAgent] = await tx
          .update(agents)
          .set({
            desiredStatus: "stopped",
            status: "restarting",
            statusReason: "Stop requested; waiting for runner confirmation.",
            updatedAt: now,
          })
          .where(
            and(
              eq(agents.id, normalizedAgentId),
              eq(agents.userId, userId),
              isNull(agents.deletedAt),
              eq(agents.status, currentAgent.agent.status),
              agentUpdatedAtMatches(currentAgent.agent.updatedAt),
            ),
          )
          .returning();

        if (!stoppingAgent) {
          throw new Error("Managed stop lost its agent fence.");
        }

        await recordAgentEventInTransaction(tx, {
          agentId: normalizedAgentId,
          actorUserId: userId,
          type: STOP_REQUESTED_EVENT_TYPE,
          message: `Stop requested for agent "${stoppingAgent.name}".`,
          metadata: { fromStatus: currentAgent.agent.status, toStatus: "restarting" },
        });

        return {
          ok: true,
          managed: true,
          scheduleRuntime: true,
          agent: stoppingAgent,
          assignedRunner: toManualRunnerRecordOrNull(currentAgent.runner),
        } as const;
      }

      if (runtimeClassification.kind === "managed_unavailable") {
        const [stoppingAgent] = await tx
          .update(agents)
          .set({
            desiredStatus: "stopped",
            status: "restarting",
            statusReason: "Stop requested; runtime controller state is unavailable.",
            updatedAt: now,
          })
          .where(
            and(
              eq(agents.id, normalizedAgentId),
              eq(agents.userId, userId),
              isNull(agents.deletedAt),
              eq(agents.status, currentAgent.agent.status),
              agentUpdatedAtMatches(currentAgent.agent.updatedAt),
            ),
          )
          .returning();

        if (!stoppingAgent) {
          throw new Error("Managed-unavailable stop lost its agent fence.");
        }

        await recordAgentEventInTransaction(tx, {
          agentId: normalizedAgentId,
          actorUserId: userId,
          type: STOP_REQUESTED_EVENT_TYPE,
          message: `Stop requested for agent "${stoppingAgent.name}".`,
          metadata: { fromStatus: currentAgent.agent.status, toStatus: "restarting" },
        });

        return {
          ok: true,
          managed: true,
          scheduleRuntime: false,
          agent: stoppingAgent,
          assignedRunner: toManualRunnerRecordOrNull(currentAgent.runner),
        } as const;
      }

      return {
        ok: true,
        agent: currentAgent.agent,
        assignedRunner: toManualRunnerRecordOrNull(currentAgent.runner),
        requiresHermesLaunchSpec: currentAgent.runner?.kind === DIGITALOCEAN_RUNNER_KIND,
        cancelledAutomaticDeployment: activeDeployment !== null,
      } as const;
    });

    if (!validation.ok) {
      return validation;
    }

    if ("managed" in validation && validation.managed) {
      if (validation.scheduleRuntime) {
        (dependencies.scheduleRuntimeReconcile ?? scheduleAgentRuntimeReconcileAfterResponse)(
          normalizedAgentId,
        );
      }

      if (!validation.assignedRunner) {
        return { ok: false, reason: "runner_stop_failed" };
      }

      const runnerAdapter = selectLifecycleRunnerAdapter(validation.assignedRunner, {
        userId,
        createConnection: () => connection,
        ...(dependencies.manualRunnerAdapter
          ? { manualRunnerAdapter: dependencies.manualRunnerAdapter }
          : {}),
        ...(dependencies.runnerAdapter ? { runnerAdapter: dependencies.runnerAdapter } : {}),
      });
      const runnerStop = await runnerAdapter.stop(normalizedAgentId);

      if (!runnerStop.ok) {
        return { ok: false, reason: "runner_stop_failed" };
      }

      await captureLifecycleRunnerLogs(runnerAdapter, normalizedAgentId);
      return {
        ok: true,
        agent: toStoppingAgent(validation.agent),
        events: [{ type: STOP_REQUESTED_EVENT_TYPE }],
      };
    }

    const runnerAdapter = selectLifecycleRunnerAdapter(validation.assignedRunner, {
      userId,
      createConnection: () => connection,
      ...(dependencies.manualRunnerAdapter
        ? { manualRunnerAdapter: dependencies.manualRunnerAdapter }
        : {}),
      ...(dependencies.runnerAdapter ? { runnerAdapter: dependencies.runnerAdapter } : {}),
    });
    const runnerStop =
      validation.agent.status === "stopped" ? null : await runnerAdapter.stop(normalizedAgentId);

    if (runnerStop && !runnerStop.ok) {
      return { ok: false, reason: "runner_stop_failed" } as const;
    }

    if (runnerStop) {
      await captureLifecycleRunnerLogs(runnerAdapter, normalizedAgentId);
    }

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
            eq(agents.userId, userId),
            isNull(agents.deletedAt),
            inArray(agents.status, [
              ...STOPPABLE_AGENT_STATUSES,
              ...(validation.cancelledAutomaticDeployment ? (["stopped"] as const) : []),
            ]),
          ),
        )
        .returning();

      if (!stoppedAgent) {
        throw new Error("Agent stop update returned no rows.");
      }

      await closeLatestOpenAgentUsagePeriodInTransaction(tx, {
        agentId: stoppedAgent.id,
        userId,
        stoppedAt: now,
      });

      await recordAgentEventsInTransaction(tx, [
        {
          agentId: stoppedAgent.id,
          actorUserId: userId,
          type: STOP_REQUESTED_EVENT_TYPE,
          message: `Stop requested for agent "${stoppedAgent.name}".`,
          metadata: {
            fromStatus: validation.agent.status,
            toStatus: "stopped",
            ...(runnerStop ? runnerLifecycleEventMetadata(runnerStop) : {}),
          },
        },
        {
          agentId: stoppedAgent.id,
          actorUserId: userId,
          type: STOP_COMPLETED_EVENT_TYPE,
          message: `Stop completed for agent "${stoppedAgent.name}".`,
          metadata: {
            fromStatus: validation.agent.status,
            toStatus: "stopped",
            ...(runnerStop ? runnerLifecycleEventMetadata(runnerStop) : {}),
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
  return runLegacyAgentLifecycleOperation(
    agentId,
    dependencies,
    { ok: false, reason: "agent_not_found" },
    restartAgentForUser,
  );
}

export async function restartAgentForUser(
  userId: string,
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
            inArray(runners.kind, [...ASSIGNABLE_LIFECYCLE_RUNNER_KINDS]),
            inArray(runners.status, [...ASSIGNABLE_LIFECYCLE_RUNNER_STATUSES]),
            isNull(runners.deletedAt),
          ),
        )
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            eq(agents.userId, userId),
            isNull(agents.deletedAt),
          ),
        )
        .limit(1);

      if (!currentAgent) {
        return { ok: false, reason: "agent_not_found" } as const;
      }

      const runtimeClassification = await classifyManagedRuntimeForUpdate(tx, {
        agentId: normalizedAgentId,
        userId,
      });
      const managedRestartable =
        runtimeClassification.kind === "managed_ready" &&
        (currentAgent.agent.status === "running" || currentAgent.agent.status === "error");

      if (!managedRestartable && !canRestartAgentStatus(currentAgent.agent.status)) {
        return {
          ok: false,
          reason: "invalid_status",
          status: currentAgent.agent.status,
        } as const;
      }

      if (
        runtimeClassification.kind === "latest_failed" ||
        runtimeClassification.kind === "managed_unavailable"
      ) {
        return {
          ok: false,
          reason: "invalid_status",
          status: currentAgent.agent.status,
        } as const;
      }

      if (runtimeClassification.kind === "managed_ready") {
        const generation = await persistManagedRuntimeOwnerIntent(tx, {
          agentId: normalizedAgentId,
          userId,
          expectedGeneration: runtimeClassification.runtime.generation,
          intent: "restart",
          now,
        });

        if (generation === null) {
          throw new Error("Managed restart lost its runtime generation fence.");
        }

        const [restartingAgent] = await tx
          .update(agents)
          .set({
            desiredStatus: "running",
            status: "restarting",
            statusReason: "Restart requested; runtime convergence scheduled.",
            updatedAt: now,
          })
          .where(
            and(
              eq(agents.id, normalizedAgentId),
              eq(agents.userId, userId),
              isNull(agents.deletedAt),
              eq(agents.status, currentAgent.agent.status),
              agentUpdatedAtMatches(currentAgent.agent.updatedAt),
            ),
          )
          .returning();

        if (!restartingAgent) {
          throw new Error("Managed restart lost its agent fence.");
        }

        await recordAgentEventInTransaction(tx, {
          agentId: normalizedAgentId,
          actorUserId: userId,
          type: RESTART_REQUESTED_EVENT_TYPE,
          message: `Restart requested for agent "${restartingAgent.name}".`,
          metadata: { fromStatus: currentAgent.agent.status, toStatus: "restarting" },
        });

        return { ok: true, managed: true, agent: restartingAgent } as const;
      }

      const assignedRunnerSnapshot = currentAgent.agent.runnerId
        ? await readAgentStartRunnerSnapshot(tx, {
            runnerId: currentAgent.agent.runnerId,
            userId,
          })
        : null;
      const requiresHermesLaunchSpec = isHermesLifecycleReadyRunnerSnapshot(assignedRunnerSnapshot);
      const setupBlocker = requiresHermesLaunchSpec
        ? await readHermesConfigurationBlocker(tx, currentAgent.agent.id)
        : null;

      if (setupBlocker) {
        return {
          ok: false,
          reason: "hermes_setup_incomplete",
          message: setupBlocker,
        } as const;
      }

      return {
        ok: true,
        agent: currentAgent.agent,
        assignedRunner: toManualRunnerRecordOrNull(currentAgent.runner),
        requiresHermesLaunchSpec,
      } as const;
    });

    if (!validation.ok) {
      return validation;
    }

    if ("managed" in validation && validation.managed) {
      (dependencies.scheduleRuntimeReconcile ?? scheduleAgentRuntimeReconcileAfterResponse)(
        normalizedAgentId,
      );
      return {
        ok: true,
        state: "accepted",
        agent: toRestartedAgent(validation.agent),
        event: { type: RESTART_REQUESTED_EVENT_TYPE },
        events: [{ type: RESTART_REQUESTED_EVENT_TYPE }],
      };
    }

    const [restartReservation] = await connection.db
      .update(agents)
      .set({
        status: "restarting",
        statusReason: "Restart requested.",
        updatedAt: now,
      })
      .where(
        and(
          eq(agents.id, normalizedAgentId),
          eq(agents.userId, userId),
          eq(agents.status, "running"),
          agentUpdatedAtMatches(validation.agent.updatedAt),
          isNull(agents.deletedAt),
        ),
      )
      .returning({ id: agents.id });

    if (!restartReservation) {
      return { ok: false, reason: "invalid_status", status: "restarting" } as const;
    }

    const runnerAdapter = selectLifecycleRunnerAdapter(validation.assignedRunner, {
      userId,
      createConnection: () => connection,
      ...(dependencies.manualRunnerAdapter
        ? { manualRunnerAdapter: dependencies.manualRunnerAdapter }
        : {}),
      ...(dependencies.runnerAdapter ? { runnerAdapter: dependencies.runnerAdapter } : {}),
    });
    const launchSpec =
      "requiresHermesLaunchSpec" in validation && validation.requiresHermesLaunchSpec
        ? await buildLifecycleHermesLaunchSpec({
            agentId: normalizedAgentId,
            userId,
            connection,
            dependencies,
          })
        : ({ ok: true, spec: null } as const);

    if (!launchSpec.ok) {
      await restoreAgentRestartReservation({
        agentId: normalizedAgentId,
        userId,
        connection,
        previousStatusReason: validation.agent.statusReason,
        expectedUpdatedAt: now,
      });
      return {
        ok: false,
        reason: "hermes_setup_incomplete",
        message: launchSpec.message,
      } as const;
    }

    const runnerRestart = await runnerAdapter.restart(normalizedAgentId, launchSpec.spec);

    if (!runnerRestart.ok) {
      if (isHermesSetupRunnerFailure(runnerRestart)) {
        await restoreAgentRestartReservation({
          agentId: normalizedAgentId,
          userId,
          connection,
          previousStatusReason: validation.agent.statusReason,
          expectedUpdatedAt: now,
        });
        return {
          ok: false,
          reason: "hermes_setup_incomplete",
          message: "Run Hermes setup before restarting this agent.",
        } as const;
      }

      if (isHermesReadinessRunnerFailure(runnerRestart)) {
        await recordHermesReadinessFailure({
          agentId: normalizedAgentId,
          userId,
          connection,
          now,
          expectedStatus: "restarting",
          expectedUpdatedAt: now,
          ...(runnerRestart.readinessReason
            ? { readinessReason: runnerRestart.readinessReason }
            : {}),
        });

        return { ok: false, reason: "runner_restart_failed" } as const;
      }

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
              eq(agents.userId, userId),
              isNull(agents.deletedAt),
              eq(agents.status, "restarting"),
              agentUpdatedAtMatches(now),
            ),
          );
      } else {
        await restoreAgentRestartReservation({
          agentId: normalizedAgentId,
          userId,
          connection,
          previousStatusReason: validation.agent.statusReason,
          expectedUpdatedAt: now,
        });
      }

      return { ok: false, reason: "runner_restart_failed" } as const;
    }

    await captureLifecycleRunnerLogs(runnerAdapter, normalizedAgentId);

    return await connection.db.transaction(async (tx) => {
      const accepted = isAcceptedRunnerSuccess(runnerRestart);
      const targetStatus = accepted ? "restarting" : "running";
      const statusReason = accepted ? "Restart accepted by runner." : RUNNING_STATUS_REASON;
      const [restartedAgent] = await tx
        .update(agents)
        .set({
          status: targetStatus,
          statusReason,
          updatedAt: now,
        })
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            eq(agents.userId, userId),
            isNull(agents.deletedAt),
            eq(agents.status, "restarting"),
            agentUpdatedAtMatches(now),
          ),
        )
        .returning();

      if (!restartedAgent) {
        await runnerAdapter.stop(normalizedAgentId);
        throw new Error("Agent restart update returned no rows.");
      }

      const eventsToRecord = [
        {
          agentId: restartedAgent.id,
          actorUserId: userId,
          type: RESTART_REQUESTED_EVENT_TYPE,
          message: `Restart requested for agent "${restartedAgent.name}".`,
          metadata: {
            fromStatus: validation.agent.status,
            toStatus: targetStatus,
            ...runnerLifecycleEventMetadata(runnerRestart),
          },
        },
      ];

      if (!accepted) {
        eventsToRecord.push({
          agentId: restartedAgent.id,
          actorUserId: userId,
          type: RESTART_COMPLETED_EVENT_TYPE,
          message: `Restart completed for agent "${restartedAgent.name}".`,
          metadata: {
            fromStatus: validation.agent.status,
            toStatus: "running",
            ...runnerLifecycleEventMetadata(runnerRestart),
          },
        });
      }

      await recordAgentEventsInTransaction(tx, eventsToRecord);

      const agent = toRestartedAgent(restartedAgent);

      if (accepted) {
        return {
          ok: true,
          state: "accepted",
          agent,
          event: { type: RESTART_REQUESTED_EVENT_TYPE },
          events: [{ type: RESTART_REQUESTED_EVENT_TYPE }],
          operation: runnerRestart.operation,
          snapshot: runnerRestart.snapshot,
        };
      }

      return {
        ok: true,
        state: "ready",
        agent,
        event: { type: RESTART_REQUESTED_EVENT_TYPE },
        events: [{ type: RESTART_REQUESTED_EVENT_TYPE }, { type: RESTART_COMPLETED_EVENT_TYPE }],
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

async function closeLatestOpenAgentUsagePeriodInTransaction(
  tx: AgentLifecycleTransaction,
  input: { agentId: string; userId: string; stoppedAt: Date },
): Promise<void> {
  const ownedAgentExists = exists(
    tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, agentUsagePeriods.agentId),
          eq(agents.userId, input.userId),
          isNull(agents.deletedAt),
        ),
      ),
  );
  const [openPeriod] = await tx
    .select({ id: agentUsagePeriods.id })
    .from(agentUsagePeriods)
    .where(
      and(
        eq(agentUsagePeriods.agentId, input.agentId),
        isNull(agentUsagePeriods.stoppedAt),
        ownedAgentExists,
      ),
    )
    .orderBy(desc(agentUsagePeriods.startedAt), desc(agentUsagePeriods.createdAt))
    .limit(1);

  if (!openPeriod) {
    return;
  }

  await tx
    .update(agentUsagePeriods)
    .set({
      stoppedAt: input.stoppedAt,
      updatedAt: input.stoppedAt,
    })
    .where(and(eq(agentUsagePeriods.id, openPeriod.id), ownedAgentExists));
}

export async function simulateErrorAgentForDevelopmentUser(
  agentId: string,
  dependencies: AgentLifecycleDependencies = {},
): Promise<SimulateErrorAgentResult> {
  return runLegacyAgentLifecycleOperation(
    agentId,
    dependencies,
    { ok: false, reason: "agent_not_found" },
    simulateErrorAgentForUser,
  );
}

export async function simulateErrorAgentForUser(
  userId: string,
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
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            eq(agents.userId, userId),
            isNull(agents.deletedAt),
          ),
        )
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
            eq(agents.userId, userId),
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
        actorUserId: userId,
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
  return recordUnexpectedLocalRunnerExit(null, event, dependencies);
}

export async function recordUnexpectedLocalRunnerExitForUser(
  userId: string,
  event: LocalRunnerUnexpectedExitEvent,
  dependencies: Pick<AgentLifecycleDependencies, "createConnection" | "now"> = {},
): Promise<boolean> {
  return recordUnexpectedLocalRunnerExit(userId, event, dependencies);
}

async function recordUnexpectedLocalRunnerExit(
  userId: string | null,
  event: LocalRunnerUnexpectedExitEvent,
  dependencies: Pick<AgentLifecycleDependencies, "createConnection" | "now">,
): Promise<boolean> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction(async (tx) => {
      const [currentAgent] = await tx
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.id, event.agentId),
            isNull(agents.deletedAt),
            not(
              exists(
                tx
                  .select({ agentId: agentRuntimeReconciliations.agentId })
                  .from(agentRuntimeReconciliations)
                  .where(eq(agentRuntimeReconciliations.agentId, agents.id)),
              ),
            ),
            not(
              exists(
                tx
                  .select({ agentId: agentDeployments.agentId })
                  .from(agentDeployments)
                  .where(eq(agentDeployments.agentId, agents.id)),
              ),
            ),
            ...(userId === null ? [] : [eq(agents.userId, userId)]),
          ),
        )
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
            not(
              exists(
                tx
                  .select({ agentId: agentRuntimeReconciliations.agentId })
                  .from(agentRuntimeReconciliations)
                  .where(eq(agentRuntimeReconciliations.agentId, agents.id)),
              ),
            ),
            not(
              exists(
                tx
                  .select({ agentId: agentDeployments.agentId })
                  .from(agentDeployments)
                  .where(eq(agentDeployments.agentId, agents.id)),
              ),
            ),
            ...(userId === null ? [] : [eq(agents.userId, userId)]),
          ),
        )
        .returning();

      if (!erroredAgent) {
        return false;
      }

      await recordAgentEventInTransaction(tx, {
        agentId: erroredAgent.id,
        actorUserId: userId ?? erroredAgent.userId,
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
  return reconcileDockerRunnerAgents(null, dependencies);
}

export async function reconcileDockerRunnerAgentsForUser(
  userId: string,
  dependencies: DockerRunnerReconciliationDependencies = {},
): Promise<number> {
  return reconcileDockerRunnerAgents(userId, dependencies);
}

async function reconcileDockerRunnerAgents(
  userId: string | null,
  dependencies: DockerRunnerReconciliationDependencies,
): Promise<number> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const limit =
    typeof dependencies.limit === "number" && Number.isInteger(dependencies.limit)
      ? Math.min(Math.max(dependencies.limit, 1), 25)
      : 10;
  const dockerRunnerAdapter =
    dependencies.dockerRunnerAdapter ??
    (await createDefaultDockerRunnerAdapter(connection, userId));

  try {
    const candidateRows = await connection.db
      .select({ agentId: agents.id })
      .from(dockerRunnerContainers)
      .innerJoin(agents, eq(agents.id, dockerRunnerContainers.agentId))
      .where(
        and(
          isNull(agents.deletedAt),
          inArray(agents.status, [...DOCKER_RECONCILABLE_AGENT_STATUSES]),
          not(
            exists(
              connection.db
                .select({ agentId: agentRuntimeReconciliations.agentId })
                .from(agentRuntimeReconciliations)
                .where(eq(agentRuntimeReconciliations.agentId, agents.id)),
            ),
          ),
          not(
            exists(
              connection.db
                .select({ agentId: agentDeployments.agentId })
                .from(agentDeployments)
                .where(eq(agentDeployments.agentId, agents.id)),
            ),
          ),
          ...(userId !== null ? [eq(agents.userId, userId)] : []),
        ),
      )
      .orderBy(desc(dockerRunnerContainers.observedAt), desc(dockerRunnerContainers.createdAt))
      .limit(limit);
    const candidateAgentIds = [...new Set(candidateRows.map((row) => row.agentId))];
    let reconciled = 0;

    for (const candidateAgentId of candidateAgentIds) {
      const didReconcile = await reconcileDockerRunnerAgent(userId, candidateAgentId, {
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
  return reconcileDockerRunnerAgent(null, agentId, dependencies);
}

export async function reconcileDockerRunnerAgentForUser(
  userId: string,
  agentId: string,
  dependencies: DockerRunnerReconciliationDependencies = {},
): Promise<boolean> {
  return reconcileDockerRunnerAgent(userId, agentId, dependencies);
}

async function reconcileDockerRunnerAgent(
  userId: string | null,
  agentId: string,
  dependencies: DockerRunnerReconciliationDependencies,
): Promise<boolean> {
  const normalizedAgentId = agentId.trim();

  if (!isValidAgentId(normalizedAgentId)) {
    return false;
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    const [ownedAgent] = await connection.db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, normalizedAgentId),
          isNull(agents.deletedAt),
          inArray(agents.status, [...DOCKER_RECONCILABLE_AGENT_STATUSES]),
          not(
            exists(
              connection.db
                .select({ agentId: agentRuntimeReconciliations.agentId })
                .from(agentRuntimeReconciliations)
                .where(eq(agentRuntimeReconciliations.agentId, agents.id)),
            ),
          ),
          not(
            exists(
              connection.db
                .select({ agentId: agentDeployments.agentId })
                .from(agentDeployments)
                .where(eq(agentDeployments.agentId, agents.id)),
            ),
          ),
          ...(userId !== null ? [eq(agents.userId, userId)] : []),
        ),
      )
      .limit(1);

    if (!ownedAgent) {
      return false;
    }

    const dockerRunnerAdapter =
      dependencies.dockerRunnerAdapter ??
      (await createDefaultDockerRunnerAdapter(connection, userId));
    const status = await dockerRunnerAdapter.status(normalizedAgentId);

    if (!status.ok || !status.container || !isUnexpectedDockerExit(status.container)) {
      return false;
    }

    const reconciledContainer = status.container;

    return await connection.db.transaction(async (tx) => {
      const [currentAgent] = await tx
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            isNull(agents.deletedAt),
            not(
              exists(
                tx
                  .select({ agentId: agentRuntimeReconciliations.agentId })
                  .from(agentRuntimeReconciliations)
                  .where(eq(agentRuntimeReconciliations.agentId, agents.id)),
              ),
            ),
            not(
              exists(
                tx
                  .select({ agentId: agentDeployments.agentId })
                  .from(agentDeployments)
                  .where(eq(agentDeployments.agentId, agents.id)),
              ),
            ),
            ...(userId !== null ? [eq(agents.userId, userId)] : []),
          ),
        )
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
            not(
              exists(
                tx
                  .select({ agentId: agentRuntimeReconciliations.agentId })
                  .from(agentRuntimeReconciliations)
                  .where(eq(agentRuntimeReconciliations.agentId, agents.id)),
              ),
            ),
            not(
              exists(
                tx
                  .select({ agentId: agentDeployments.agentId })
                  .from(agentDeployments)
                  .where(eq(agentDeployments.agentId, agents.id)),
              ),
            ),
            ...(userId !== null ? [eq(agents.userId, userId)] : []),
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
        actorUserId: userId ?? erroredAgent.userId,
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
  return runLegacyAgentLifecycleOperation(
    agentId,
    dependencies,
    { ok: false, reason: "agent_not_found" },
    deleteAgentForUser,
  );
}

export async function deleteAgentForUser(
  userId: string,
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
    const validation = await connection.db.transaction(async (tx) => {
      const [currentAgent] = await tx
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            eq(agents.userId, userId),
            isNull(agents.deletedAt),
          ),
        )
        .limit(1);

      if (!currentAgent) {
        return { ok: false, reason: "agent_not_found" } as const;
      }

      if (!canDeleteAgentStatus(currentAgent.status)) {
        return { ok: false, reason: "invalid_status", status: currentAgent.status } as const;
      }

      const activeDeployment = await lockActiveAutomaticDeploymentInTransaction(
        tx,
        normalizedAgentId,
        userId,
      );

      if (activeDeployment) {
        await cancelActiveAutomaticDeploymentInTransaction(tx, {
          agentId: normalizedAgentId,
          userId,
          deployment: activeDeployment,
          code: "agent_deleted",
          detail: AGENT_DELETED_DEPLOYMENT_ERROR_DETAIL,
          now,
        });
      }

      const runtimeClassification = activeDeployment
        ? ({ kind: "active_deployment" } as const)
        : await classifyManagedRuntimeForUpdate(tx, {
            agentId: normalizedAgentId,
            userId,
          });

      if (runtimeClassification.kind === "managed_ready") {
        const generation = await persistManagedRuntimeOwnerIntent(tx, {
          agentId: normalizedAgentId,
          userId,
          expectedGeneration: runtimeClassification.runtime.generation,
          intent: "delete",
          now,
        });

        if (generation === null) {
          throw new Error("Managed delete lost its runtime generation fence.");
        }

        await closeLatestOpenAgentUsagePeriodInTransaction(tx, {
          agentId: normalizedAgentId,
          userId,
          stoppedAt: now,
        });

        const [deletedAgent] = await tx
          .update(agents)
          .set({ desiredStatus: "stopped", updatedAt: now, deletedAt: now })
          .where(
            and(
              eq(agents.id, normalizedAgentId),
              eq(agents.userId, userId),
              isNull(agents.deletedAt),
              eq(agents.status, currentAgent.status),
              agentUpdatedAtMatches(currentAgent.updatedAt),
            ),
          )
          .returning();

        if (!deletedAgent) {
          throw new Error("Managed delete lost its agent fence.");
        }

        await revokeActiveAgentSecretsInTransaction(tx, { agentId: deletedAgent.id, now });
        await recordAgentEventInTransaction(tx, {
          agentId: deletedAgent.id,
          actorUserId: userId,
          type: DELETE_EVENT_TYPE,
          message: `Agent "${deletedAgent.name}" deleted from active views.`,
          metadata: { fromStatus: currentAgent.status, toStatus: "deleted" },
        });

        return { ok: true, managed: true, agent: deletedAgent } as const;
      }

      if (runtimeClassification.kind === "managed_unavailable") {
        await closeLatestOpenAgentUsagePeriodInTransaction(tx, {
          agentId: normalizedAgentId,
          userId,
          stoppedAt: now,
        });
        const [deletedAgent] = await tx
          .update(agents)
          .set({ desiredStatus: "stopped", updatedAt: now, deletedAt: now })
          .where(
            and(
              eq(agents.id, normalizedAgentId),
              eq(agents.userId, userId),
              isNull(agents.deletedAt),
              eq(agents.status, currentAgent.status),
              agentUpdatedAtMatches(currentAgent.updatedAt),
            ),
          )
          .returning();

        if (!deletedAgent) {
          throw new Error("Managed-unavailable delete lost its agent fence.");
        }

        await revokeActiveAgentSecretsInTransaction(tx, { agentId: deletedAgent.id, now });
        await recordAgentEventInTransaction(tx, {
          agentId: deletedAgent.id,
          actorUserId: userId,
          type: DELETE_EVENT_TYPE,
          message: `Agent "${deletedAgent.name}" deleted from active views.`,
          metadata: { fromStatus: currentAgent.status, toStatus: "deleted" },
        });
        return { ok: true, managed: true, agent: deletedAgent } as const;
      }

      return { ok: true, agent: currentAgent } as const;
    });

    if (!validation.ok) {
      return validation;
    }

    const dockerRunnerAdapter =
      dependencies.dockerRunnerAdapter ??
      (await createDefaultDockerRunnerAdapter(connection, userId));
    const cleanup = await dockerRunnerAdapter.cleanup(normalizedAgentId);

    if (!cleanup.ok) {
      return {
        ok: false,
        reason: "runner_cleanup_failed",
        status: validation.agent.status,
      };
    }

    const assignedRunner = validation.agent.runnerId
      ? await readDeleteCleanupRunner(connection, {
          runnerId: validation.agent.runnerId,
          userId,
        })
      : null;

    if (assignedRunner) {
      const manualCleanup = await cleanupAssignedManualRunnerAgent({
        agentId: normalizedAgentId,
        runner: assignedRunner,
        connection,
        dependencies,
      });

      if (!manualCleanup.ok) {
        return {
          ok: false,
          reason: "runner_cleanup_failed",
          status: validation.agent.status,
        };
      }
    }

    if ("managed" in validation && validation.managed) {
      return {
        ok: true,
        agent: toDeletedAgent(validation.agent),
        event: { type: DELETE_EVENT_TYPE },
      };
    }

    return await connection.db.transaction(async (tx) => {
      await closeLatestOpenAgentUsagePeriodInTransaction(tx, {
        agentId: normalizedAgentId,
        userId,
        stoppedAt: now,
      });

      const [deletedAgent] = await tx
        .update(agents)
        .set({
          updatedAt: now,
          deletedAt: now,
        })
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            eq(agents.userId, userId),
            isNull(agents.deletedAt),
            inArray(agents.status, [...DELETABLE_AGENT_STATUSES]),
          ),
        )
        .returning();

      if (!deletedAgent) {
        throw new Error("Agent delete update returned no rows.");
      }

      await revokeActiveAgentSecretsInTransaction(tx, { agentId: deletedAgent.id, now });

      await recordAgentEventInTransaction(tx, {
        agentId: deletedAgent.id,
        actorUserId: userId,
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

type ActiveAutomaticDeployment = {
  id: string;
  stage: string;
};

async function lockActiveAutomaticDeploymentInTransaction(
  tx: AgentLifecycleTransaction,
  agentId: string,
  userId: string,
): Promise<ActiveAutomaticDeployment | null> {
  const [deployment] = await tx.execute<ActiveAutomaticDeployment>(sql`
    select id, stage
    from ${agentDeployments}
    where agent_id = ${agentId}
      and user_id = ${userId}
      and stage not in ('ready', 'failed')
    order by created_at desc, id desc
    for update
    limit 1
  `);

  return deployment ?? null;
}

async function cancelActiveAutomaticDeploymentInTransaction(
  tx: AgentLifecycleTransaction,
  input: {
    agentId: string;
    userId: string;
    deployment: ActiveAutomaticDeployment;
    code: "deployment_cancelled" | "agent_deleted";
    detail: string;
    now: Date;
  },
): Promise<void> {
  await tx
    .update(agents)
    .set({ desiredStatus: "stopped", updatedAt: input.now })
    .where(
      and(eq(agents.id, input.agentId), eq(agents.userId, input.userId), isNull(agents.deletedAt)),
    );

  const [cancelled] = await tx.execute<{ id: string }>(sql`
    update ${agentDeployments}
    set stage = 'failed',
        error_code = ${input.code},
        error_detail = ${input.detail},
        next_attempt_at = null,
        lease_owner = null,
        lease_expires_at = null,
        completed_at = null,
        failed_at = ${input.now.toISOString()},
        updated_at = ${input.now.toISOString()}
    where id = ${input.deployment.id}
      and agent_id = ${input.agentId}
      and user_id = ${input.userId}
      and stage = ${input.deployment.stage}
      and stage not in ('ready', 'failed')
    returning id
  `);

  if (!cancelled) {
    throw new Error("Automatic deployment cancellation lost its locked row.");
  }

  await closeLatestOpenAgentUsagePeriodInTransaction(tx, {
    agentId: input.agentId,
    userId: input.userId,
    stoppedAt: input.now,
  });

  await recordAgentEventInTransaction(tx, {
    agentId: input.agentId,
    actorUserId: input.userId,
    type: "agent.deployment_stage_changed",
    message: "Automatic deployment moved to a terminal stage.",
    metadata: {
      deploymentId: input.deployment.id,
      fromStage: input.deployment.stage,
      toStage: "failed",
      errorCode: input.code,
    },
    createdAt: input.now,
  });
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

async function readDeleteCleanupRunner(
  connection: DatabaseConnection,
  input: { runnerId: string; userId: string },
): Promise<ManualRunnerRecord | null> {
  const [runner] = await connection.db
    .select(assignedRunnerSelection)
    .from(runners)
    .where(
      and(
        eq(runners.id, input.runnerId),
        eq(runners.userId, input.userId),
        inArray(runners.kind, [...ASSIGNABLE_LIFECYCLE_RUNNER_KINDS]),
        inArray(runners.status, [...ASSIGNABLE_LIFECYCLE_RUNNER_STATUSES]),
        isNull(runners.deletedAt),
      ),
    )
    .limit(1);

  return toManualRunnerRecordOrNull(runner ?? null);
}

async function cleanupAssignedManualRunnerAgent(input: {
  agentId: string;
  runner: ManualRunnerRecord;
  connection: DatabaseConnection;
  dependencies: AgentLifecycleDependencies;
}): Promise<{ ok: true } | { ok: false }> {
  const adapter = selectLifecycleRunnerAdapter(input.runner, {
    userId: input.runner.userId,
    createConnection: () => input.connection,
    ...(input.dependencies.manualRunnerAdapter
      ? { manualRunnerAdapter: input.dependencies.manualRunnerAdapter }
      : {}),
  }) as LifecycleRunnerAdapter & {
    cleanup?: (agentId: string) => Promise<{ ok: boolean }>;
  };
  const cleanup = adapter.cleanup
    ? await adapter.cleanup(input.agentId)
    : await adapter.stop(input.agentId);

  return cleanup.ok ? { ok: true } : { ok: false };
}

function isHermesReadinessRunnerFailure(
  result: LifecycleRunnerStartResult | LifecycleRunnerRestartResult,
): result is (LifecycleRunnerStartResult | LifecycleRunnerRestartResult) & {
  ok: false;
  reason: "runner_readiness_failed";
  readinessReason?: HermesReadinessReason;
} {
  return !result.ok && "reason" in result && result.reason === "runner_readiness_failed";
}

function isHermesSetupRunnerFailure(
  result: LifecycleRunnerStartResult | LifecycleRunnerRestartResult,
): result is (LifecycleRunnerStartResult | LifecycleRunnerRestartResult) & {
  ok: false;
  reason: "hermes_setup_incomplete";
} {
  return !result.ok && "reason" in result && result.reason === "hermes_setup_incomplete";
}

function isAcceptedRunnerSuccess(
  result: LifecycleRunnerStartResult | LifecycleRunnerRestartResult,
): result is Extract<
  ManualRunnerStartResult | ManualRunnerRestartResult,
  { ok: true; state: "accepted" }
> {
  return result.ok && "state" in result && result.state === "accepted";
}

function agentUpdatedAtMatches(expected: Date) {
  return and(
    gte(agents.updatedAt, expected),
    lt(agents.updatedAt, new Date(expected.getTime() + 1)),
  );
}

async function recordHermesReadinessFailure(input: {
  agentId: string;
  userId: string;
  connection: DatabaseConnection;
  now: Date;
  expectedStatus: AgentLifecycleStatus;
  expectedUpdatedAt: Date;
  readinessReason?: HermesReadinessReason;
}): Promise<void> {
  await input.connection.db.transaction(async (tx) => {
    const [agent] = await tx
      .update(agents)
      .set({
        status: "error",
        statusReason: HERMES_READINESS_FAILED_STATUS_REASON,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(agents.id, input.agentId),
          eq(agents.userId, input.userId),
          isNull(agents.deletedAt),
          eq(agents.status, input.expectedStatus),
          agentUpdatedAtMatches(input.expectedUpdatedAt),
        ),
      )
      .returning();

    if (!agent) {
      return;
    }

    await recordAgentEventInTransaction(tx, {
      agentId: input.agentId,
      actorUserId: input.userId,
      type: SIMULATED_ERROR_EVENT_TYPE,
      message: "Hermes readiness failed before the agent was marked running.",
      metadata: {
        reason: "hermes_readiness_failed",
        ...(input.readinessReason ? { readinessReason: input.readinessReason } : {}),
      },
    });
  });
}

function selectLifecycleRunnerAdapter(
  assignedRunner: ManualRunnerRecord | null,
  dependencies: {
    userId: string;
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

  return (
    dependencies.runnerAdapter ??
    getLifecycleRunnerAdapterForUser(dependencies.userId, {
      createConnection: dependencies.createConnection,
    })
  );
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
    !isAssignableRunnerKind(row.kind) ||
    !row.endpointUrl ||
    !isAssignableRunnerStatus(row.status) ||
    !row.createdAt ||
    !row.updatedAt
  ) {
    return null;
  }

  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    kind: row.kind,
    endpointUrl: row.endpointUrl,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

function isAssignableRunnerKind(
  kind: string | null,
): kind is typeof MANUAL_RUNNER_KIND | typeof DIGITALOCEAN_RUNNER_KIND {
  return kind === MANUAL_RUNNER_KIND || kind === DIGITALOCEAN_RUNNER_KIND;
}

function isAssignableRunnerStatus(
  status: string | null,
): status is typeof ACTIVE_RUNNER_STATUS | "online" {
  return status === ACTIVE_RUNNER_STATUS || status === "online";
}

function toStartedAgent(agent: typeof agents.$inferSelect): StartedAgent {
  return {
    id: agent.id,
    userId: agent.userId,
    name: agent.name,
    templateKey: agent.templateKey,
    status: agent.status === "starting" ? "starting" : "running",
    statusReason:
      agent.statusReason ??
      (agent.status === "starting" ? "Start accepted by runner." : RUNNING_STATUS_REASON),
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

function toStoppingAgent(agent: typeof agents.$inferSelect): StoppingAgent {
  return {
    id: agent.id,
    userId: agent.userId,
    name: agent.name,
    templateKey: agent.templateKey,
    status: "restarting",
    statusReason: agent.statusReason ?? "Stop requested; waiting for runner confirmation.",
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
    status: agent.status === "restarting" ? "restarting" : "running",
    statusReason:
      agent.statusReason ??
      (agent.status === "restarting" ? "Restart accepted by runner." : RUNNING_STATUS_REASON),
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

function logAgentStart(event: string, metadata: Record<string, unknown>): void {
  console.info("[agentbay] agent.start", { event, ...metadata });
}

function shouldRequireOnlineRunnerForStart(): boolean {
  return process.env.VERCEL === "1" || process.env.VERCEL_ENV === "production";
}

async function createDefaultDockerRunnerAdapter(
  connection: DatabaseConnection,
  userId: string | null,
): Promise<DockerRunnerCleanupAdapter & DockerRunnerStatusAdapter> {
  return new DockerRunnerMaintenanceAdapter({
    createConnection: () => connection,
    ...(userId === null ? {} : { userId }),
  });
}
