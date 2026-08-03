import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { RunnerAgentStatusSnapshot } from "@/src/runner-service/runner-contracts";
import { buildHermesAgentLaunchSpecForUser } from "@/src/server/agents/agent-launch-builder";
import {
  type AgentDeploymentStage,
  normalizeDeploymentErrorDetail,
  validateDeploymentErrorCode,
} from "@/src/server/agents/deployment-state";
import { getApprovedOpenRouterModel } from "@/src/server/agents/openrouter-models";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentConfigs,
  agentDeployments,
  agents,
  agentUsagePeriods,
  runners,
} from "@/src/server/db/schema";
import { type DigitalOceanProviderConfig, readDigitalOceanProviderConfig } from "@/src/server/env";
import { recordAgentEventsInTransaction } from "@/src/server/events/agent-events";
import type { DigitalOceanProvider } from "@/src/server/runners/digitalocean-provider";
import {
  DIGITALOCEAN_PROVIDER,
  DIGITALOCEAN_RUNNER_KIND,
} from "@/src/server/runners/digitalocean-provider";
import {
  ManualRunnerAdapter,
  type ManualRunnerCanaryResult,
} from "@/src/server/runners/manual-runner-adapter";
import type { ManualRunnerRecord } from "@/src/server/runners/manual-runner-persistence";
import {
  lockRunnerPlacementCapacityInTransaction,
  selectRunnerPlacementForUserInTransaction,
} from "@/src/server/runners/runner-placement";
import {
  advanceAutomaticDigitalOceanRunnerProvisioning,
  createConfiguredDigitalOceanProvider,
} from "@/src/server/runners/runner-provisioning";

export const DEPLOYMENT_RECONCILE_LEASE_MS = 90_000;
export const DEPLOYMENT_RECONCILE_ACTION_DEADLINE_MS = 45_000;
export const MAX_AUTOMATIC_DEPLOYMENT_ATTEMPTS = 64;

const STARTING_STATUS_REASON = "Automatic deployment is in progress.";
const RUNNING_STATUS_REASON = "Hermes gateway is ready.";
const ERROR_STATUS_REASON =
  "Automatic deployment failed. Retry, Stop, or Delete this agent from the deployment controls.";

class LostDeploymentLeaseError extends Error {}

export type AgentDeploymentReconcileOutcome =
  | "idle"
  | "advanced"
  | "retry_scheduled"
  | "failed"
  | "ready";

export type AgentDeploymentReconcileResult = {
  processed: 0 | 1;
  outcome: AgentDeploymentReconcileOutcome;
};

export type DeploymentProvisioner = (
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  now: Date,
  context: DeploymentActionContext,
) => Promise<ProvisionerResult>;

export type ProvisionerResult =
  | { ok: true; state: "pending" }
  | { ok: true; state: "ready" }
  | {
      ok: false;
      cleanupRequired?: boolean;
      terminalCode: DeploymentTerminalErrorCode;
    };

export type DeploymentActionContext = {
  deadlineAt: Date;
  signal: AbortSignal;
  remainingMs: () => number;
};

export type AgentDeploymentReconcilerDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  launchSpec?: typeof buildHermesAgentLaunchSpecForUser;
  manualRunnerAdapter?: (
    runner: ManualRunnerRecord,
    options: { signal: AbortSignal; timeoutMs: number },
  ) => ReconcilerRunnerAdapter;
  provisioner?: DeploymentProvisioner;
  digitalOceanProvider?: DigitalOceanProvider;
  readDigitalOceanConfig?: () => DigitalOceanProviderConfig | null;
};

type ReconcilerRunnerAdapter = {
  start: ManualRunnerAdapter["start"];
  status: ManualRunnerAdapter["status"];
  stop: ManualRunnerAdapter["stop"];
  streamLogs: ManualRunnerAdapter["streamLogs"];
  canary(
    agentId: string,
    request: { operationId: string; configRevision: string; model: string },
  ): Promise<ManualRunnerCanaryResult>;
};

type ReconcileTarget =
  | { kind: "global" }
  | { kind: "deployment"; deploymentId: string }
  | { kind: "runner"; runnerId: string };

type CanaryState = "not_started" | "started" | "passed" | "failed" | "outcome_unknown";

type ClaimedDeploymentWork = {
  id: string;
  agentId: string;
  userId: string;
  stage: AgentDeploymentStage;
  configRevision: string;
  attemptCount: number;
  leaseOwner: string;
  runnerOperationId: string | null;
  runnerAcceptedAt: Date | null;
  canaryState: CanaryState;
  canaryAttemptedAt: Date | null;
  agentRunnerId: string | null;
};

type DeploymentTerminalErrorCode =
  | "deployment_attempts_exhausted"
  | "deployment_cancelled"
  | "deployment_internal_failure"
  | "managed_configuration_invalid"
  | "model_canary_failed"
  | "model_canary_outcome_unknown"
  | "runner_provisioning_unavailable"
  | "runner_provisioning_outcome_unknown"
  | "runner_start_failed"
  | "telegram_connection_failed";

const RETRYABLE_DETAILS = {
  runner_capacity_wait: "Runner capacity is not ready yet.",
  runner_not_ready: "Runner is not ready yet.",
  runner_transport_unavailable: "Runner transport is temporarily unavailable.",
  gateway_starting: "Hermes gateway is still starting.",
} as const;

export function computeDeploymentBackoffMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 5);

  return Math.min(60_000, 2_000 * 2 ** exponent);
}

export async function reconcileNextAgentDeployment(
  dependencies: AgentDeploymentReconcilerDependencies = {},
): Promise<AgentDeploymentReconcileResult> {
  return reconcileOne({ kind: "global" }, dependencies);
}

export async function reconcileTargetAgentDeployment(
  deploymentId: string,
  dependencies: AgentDeploymentReconcilerDependencies = {},
): Promise<AgentDeploymentReconcileResult> {
  return reconcileOne({ kind: "deployment", deploymentId }, dependencies);
}

export async function reconcileTargetRunnerDeployment(
  runnerId: string,
  dependencies: AgentDeploymentReconcilerDependencies = {},
): Promise<AgentDeploymentReconcileResult> {
  return reconcileOne({ kind: "runner", runnerId }, dependencies);
}

async function reconcileOne(
  target: ReconcileTarget,
  dependencies: AgentDeploymentReconcilerDependencies,
): Promise<AgentDeploymentReconcileResult> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const leaseOwner = `reconcile:${randomUUID()}`;

  try {
    const claimed = await connection.db.transaction((tx) =>
      claimOneDeploymentForReconcile(tx, {
        target,
        leaseOwner,
        now: now(),
      }),
    );

    if (!claimed) {
      return { processed: 0, outcome: "idle" };
    }

    if (claimed.attemptCount > MAX_AUTOMATIC_DEPLOYMENT_ATTEMPTS) {
      await terminallyFailDeployment(connection, claimed, {
        code: "deployment_attempts_exhausted",
        now: now(),
      });
      return { processed: 1, outcome: "failed" };
    }

    return {
      processed: 1,
      outcome: await runClaimedStage(connection, claimed, dependencies, now),
    };
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

async function runClaimedStage(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  dependencies: AgentDeploymentReconcilerDependencies,
  now: () => Date,
): Promise<AgentDeploymentReconcileOutcome> {
  const actionDeadlineAt = new Date(now().getTime() + DEPLOYMENT_RECONCILE_ACTION_DEADLINE_MS);
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(new DOMException("Deployment action deadline exceeded.", "TimeoutError")),
    DEPLOYMENT_RECONCILE_ACTION_DEADLINE_MS,
  );
  const context: DeploymentActionContext = {
    deadlineAt: actionDeadlineAt,
    signal: controller.signal,
    remainingMs: () =>
      Math.max(
        0,
        Math.min(
          DEPLOYMENT_RECONCILE_ACTION_DEADLINE_MS,
          actionDeadlineAt.getTime() - now().getTime(),
        ),
      ),
  };

  try {
    switch (work.stage) {
      case "pending":
        return reconcilePending(connection, work, dependencies, now);
      case "provisioning_runner":
        return reconcileProvisioningRunner(connection, work, dependencies, now, context);
      case "configuring_hermes":
        return reconcileConfiguringHermes(connection, work, dependencies, now, context);
      case "starting_gateway":
        return reconcileStartingGateway(connection, work, dependencies, now, context);
      case "verifying_model":
        return reconcileVerifyingModel(connection, work, dependencies, now, context);
      case "connecting_telegram":
        return reconcileConnectingTelegram(connection, work, dependencies, now, context);
      case "ready":
      case "failed":
        return "idle";
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function reconcilePending(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  dependencies: AgentDeploymentReconcilerDependencies,
  now: () => Date,
): Promise<AgentDeploymentReconcileOutcome> {
  let transitioned:
    | { kind: "advanced" }
    | { kind: "fail"; code: DeploymentTerminalErrorCode }
    | { kind: "retry" }
    | { kind: "stale" };

  try {
    transitioned = await connection.db.transaction(async (tx) => {
      const owned = await lockOwnedAgentForDeployment(tx, work, now());

      if (!owned.ok) {
        return { kind: "fail" as const, code: owned.code };
      }

      if (owned.agent.runnerId) {
        await lockRunnerPlacementCapacityInTransaction(tx, owned.agent.runnerId);
        const assigned = await selectRunnerPlacementForUserInTransaction(
          tx,
          work.userId,
          { runnerId: owned.agent.runnerId },
          { now: now() },
        );

        if (!assigned.ok) {
          return { kind: "retry" as const };
        }

        const updated = await markDeploymentStage(tx, work, {
          nextStage: "configuring_hermes",
          now: now(),
          agentStatus: "starting",
          statusReason: STARTING_STATUS_REASON,
          events: ["agent.start_requested", "agent.deployment_stage_changed"],
        });

        if (!updated) {
          throw new LostDeploymentLeaseError();
        }

        return { kind: "advanced" as const };
      }

      const placement = await selectRunnerPlacementForUserInTransaction(
        tx,
        work.userId,
        { runnerId: null },
        { now: now() },
      );

      if (placement.ok) {
        await lockRunnerPlacementCapacityInTransaction(tx, placement.runner.id);
        const confirmed = await selectRunnerPlacementForUserInTransaction(
          tx,
          work.userId,
          { runnerId: placement.runner.id },
          { now: now() },
        );

        if (confirmed.ok) {
          const updated = await markDeploymentStage(tx, work, {
            nextStage: "configuring_hermes",
            now: now(),
            events: ["agent.start_requested", "agent.deployment_stage_changed"],
          });

          if (!updated) {
            throw new LostDeploymentLeaseError();
          }

          await tx
            .update(agents)
            .set({
              runnerId: placement.runner.id,
              status: "starting",
              statusReason: STARTING_STATUS_REASON,
              updatedAt: now(),
            })
            .where(
              sql`${agents.id} = ${work.agentId} and ${agents.userId} = ${work.userId} and ${agents.deletedAt} is null and ${agents.desiredStatus} = 'running'`,
            );
          return { kind: "advanced" as const };
        }
      }

      const provisioning = await initializeProvisioningRunner(tx, work, now(), dependencies);

      if (!provisioning.ok) {
        return { kind: "fail" as const, code: provisioning.code };
      }

      return { kind: "advanced" as const };
    });
  } catch (error) {
    if (error instanceof LostDeploymentLeaseError) {
      transitioned = { kind: "stale" };
    } else {
      throw error;
    }
  }

  if (transitioned.kind === "stale") {
    return "retry_scheduled";
  }

  if (transitioned.kind === "fail") {
    await terminallyFailDeployment(connection, work, { code: transitioned.code, now: now() });
    return "failed";
  }

  if (transitioned.kind === "retry") {
    return scheduleRetry(connection, work, "runner_capacity_wait", now());
  }

  return "advanced";
}

async function reconcileProvisioningRunner(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  dependencies: AgentDeploymentReconcilerDependencies,
  now: () => Date,
  context: DeploymentActionContext,
): Promise<AgentDeploymentReconcileOutcome> {
  const placementState = await connection.db.transaction(async (tx) => {
    const [runner] = await tx
      .select({
        id: runners.id,
        status: runners.status,
        kind: runners.kind,
        provider: runners.provider,
        provisioningStatus: runners.provisioningStatus,
        endpointUrl: runners.endpointUrl,
      })
      .from(agents)
      .innerJoin(runners, sql`${runners.id} = ${agents.runnerId}`)
      .where(
        sql`${agents.id} = ${work.agentId} and ${agents.userId} = ${work.userId} and ${agents.deletedAt} is null and ${agents.desiredStatus} = 'running' and ${runners.userId} = ${work.userId} and ${runners.deletedAt} is null`,
      )
      .limit(1);

    if (!runner) {
      return "missing" as const;
    }

    await lockRunnerPlacementCapacityInTransaction(tx, runner.id);
    const placement = await selectRunnerPlacementForUserInTransaction(
      tx,
      work.userId,
      { excludeAgentId: work.agentId, runnerId: runner.id },
      { now: now() },
    );

    if (placement.ok) {
      const advanced = await markDeploymentStage(tx, work, {
        nextStage: "configuring_hermes",
        now: now(),
        events: ["agent.deployment_stage_changed"],
      });

      return advanced ? ("ready" as const) : ("stale" as const);
    }

    return runner.kind === DIGITALOCEAN_RUNNER_KIND && runner.provisioningStatus !== "ready"
      ? ("provider_pending" as const)
      : ("capacity_wait" as const);
  });

  if (placementState === "ready") {
    return "advanced";
  }

  if (placementState === "stale") {
    return "retry_scheduled";
  }

  if (placementState === "capacity_wait") {
    return scheduleRetry(connection, work, "runner_capacity_wait", now());
  }

  if (placementState === "missing") {
    await terminallyFailDeployment(connection, work, {
      code: "runner_provisioning_unavailable",
      now: now(),
    });
    return "failed";
  }

  const provisioner =
    dependencies.provisioner ??
    ((connection, work, currentNow, context) =>
      defaultProvisioner(connection, work, currentNow, context, dependencies));
  const result = await provisioner(connection, work, now(), context);

  if (!result.ok) {
    await terminallyFailDeployment(connection, work, {
      code: result.terminalCode,
      now: now(),
      ...(result.cleanupRequired === undefined ? {} : { cleanupRequired: result.cleanupRequired }),
    });
    return "failed";
  }

  if (result.state === "ready") {
    return (await transitionStage(connection, work, "configuring_hermes", now()))
      ? "advanced"
      : "retry_scheduled";
  }

  return scheduleRetry(connection, work, "runner_not_ready", now());
}

async function reconcileConfiguringHermes(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  dependencies: AgentDeploymentReconcilerDependencies,
  now: () => Date,
  context: DeploymentActionContext,
): Promise<AgentDeploymentReconcileOutcome> {
  const launch = await (dependencies.launchSpec ?? buildHermesAgentLaunchSpecForUser)(
    work.userId,
    work.agentId,
  );

  if (!launch.ok) {
    await terminallyFailDeployment(connection, work, {
      code:
        launch.reason === "managed_configuration_invalid"
          ? "managed_configuration_invalid"
          : "deployment_internal_failure",
      now: now(),
    });
    return "failed";
  }

  if (launch.spec.agent.configRevision !== work.configRevision) {
    await terminallyFailDeployment(connection, work, {
      code: "managed_configuration_invalid",
      now: now(),
    });
    return "failed";
  }

  const runner = await getAssignedRunner(connection, work);

  if (!runner) {
    return scheduleRetry(connection, work, "runner_not_ready", now());
  }

  const adapter = createRunnerAdapter(runner, dependencies, context);
  const started = await adapter.start(work.agentId, launch.spec);

  if (!started.ok) {
    return scheduleRetry(connection, work, "runner_transport_unavailable", now());
  }

  if (!("state" in started)) {
    await terminallyFailDeployment(connection, work, {
      code: "runner_start_failed",
      now: now(),
      cleanup: { dependencies, context },
    });
    return "failed";
  }

  if (started.state === "ready") {
    if (
      !started.target ||
      started.target.configRevision !== work.configRevision ||
      started.target.image !== launch.spec.image.ref ||
      started.target.launchSpecVersion !== launch.spec.version
    ) {
      await terminallyFailDeployment(connection, work, {
        code: "runner_start_failed",
        now: now(),
        cleanup: { dependencies, context },
      });
      return "failed";
    }

    const persisted = await connection.db.transaction((tx) =>
      persistRunnerAcceptedAndStage(tx, work, {
        operationId: randomUUID(),
        acceptedAt: now(),
        nextStage: "starting_gateway",
        now: now(),
      }),
    );
    return persisted ? "advanced" : "retry_scheduled";
  }

  if (started.state !== "accepted") {
    await terminallyFailDeployment(connection, work, {
      code: "runner_start_failed",
      now: now(),
      cleanup: { dependencies, context },
    });
    return "failed";
  }

  if (
    started.operation.target.configRevision !== work.configRevision ||
    started.operation.target.image !== launch.spec.image.ref ||
    started.operation.target.launchSpecVersion !== launch.spec.version
  ) {
    await terminallyFailDeployment(connection, work, {
      code: "runner_start_failed",
      now: now(),
      cleanup: { dependencies, context },
    });
    return "failed";
  }

  const persisted = await connection.db.transaction((tx) =>
    persistRunnerAcceptedAndStage(tx, work, {
      operationId: started.operation.id,
      acceptedAt: new Date(started.operation.acceptedAt),
      nextStage: "starting_gateway",
      now: now(),
    }),
  );
  return persisted ? "advanced" : "retry_scheduled";
}

async function reconcileStartingGateway(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  dependencies: AgentDeploymentReconcilerDependencies,
  now: () => Date,
  context: DeploymentActionContext,
): Promise<AgentDeploymentReconcileOutcome> {
  const runner = await getAssignedRunner(connection, work);

  if (!runner || !work.runnerOperationId) {
    await terminallyFailDeployment(connection, work, {
      code: "runner_start_failed",
      now: now(),
      cleanup: { dependencies, context },
    });
    return "failed";
  }

  const adapter = createRunnerAdapter(runner, dependencies, context);
  const status = await adapter.status(work.agentId);

  if (!status.ok || !("snapshot" in status)) {
    return retryStartConvergence(connection, work, dependencies, now, context, runner);
  }

  if (isReadySnapshot(status.snapshot, work)) {
    return (await transitionStage(connection, work, "verifying_model", now()))
      ? "advanced"
      : "retry_scheduled";
  }

  if (requiresStartConvergence(status.snapshot, work)) {
    return retryStartConvergence(connection, work, dependencies, now, context, runner);
  }

  if (isRetryableSnapshot(status.snapshot)) {
    return scheduleRetry(connection, work, "gateway_starting", now());
  }

  return retryStartConvergence(connection, work, dependencies, now, context, runner);
}

async function retryStartConvergence(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  dependencies: AgentDeploymentReconcilerDependencies,
  now: () => Date,
  context: DeploymentActionContext,
  runner: ManualRunnerRecord,
): Promise<AgentDeploymentReconcileOutcome> {
  const launch = await (dependencies.launchSpec ?? buildHermesAgentLaunchSpecForUser)(
    work.userId,
    work.agentId,
  );

  if (!launch.ok || launch.spec.agent.configRevision !== work.configRevision) {
    await terminallyFailDeployment(connection, work, {
      code: "managed_configuration_invalid",
      now: now(),
      cleanup: { dependencies, context },
    });
    return "failed";
  }

  const started = await createRunnerAdapter(runner, dependencies, context).start(
    work.agentId,
    launch.spec,
  );

  if (!started.ok) {
    return scheduleRetry(connection, work, "runner_transport_unavailable", now());
  }

  if (!("state" in started)) {
    return scheduleRetry(connection, work, "gateway_starting", now());
  }

  if (started.state === "ready") {
    if (
      !started.target ||
      started.target.configRevision !== work.configRevision ||
      started.target.image !== launch.spec.image.ref ||
      started.target.launchSpecVersion !== launch.spec.version
    ) {
      await terminallyFailDeployment(connection, work, {
        code: "runner_start_failed",
        now: now(),
        cleanup: { dependencies, context },
      });
      return "failed";
    }

    const persisted = await connection.db.transaction((tx) =>
      persistRunnerAcceptedAndStage(tx, work, {
        operationId: randomUUID(),
        acceptedAt: now(),
        nextStage: "starting_gateway",
        now: now(),
      }),
    );
    return persisted ? "advanced" : "retry_scheduled";
  }

  if (
    started.state !== "accepted" ||
    started.operation.target.configRevision !== work.configRevision ||
    started.operation.target.image !== launch.spec.image.ref ||
    started.operation.target.launchSpecVersion !== launch.spec.version
  ) {
    await terminallyFailDeployment(connection, work, {
      code: "runner_start_failed",
      now: now(),
      cleanup: { dependencies, context },
    });
    return "failed";
  }

  const persisted = await connection.db.transaction((tx) =>
    persistRunnerAcceptedAndStage(tx, work, {
      operationId: started.operation.id,
      acceptedAt: new Date(started.operation.acceptedAt),
      nextStage: "starting_gateway",
      now: now(),
    }),
  );

  return persisted ? "advanced" : "retry_scheduled";
}

async function reconcileVerifyingModel(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  dependencies: AgentDeploymentReconcilerDependencies,
  now: () => Date,
  context: DeploymentActionContext,
): Promise<AgentDeploymentReconcileOutcome> {
  if (!work.runnerOperationId) {
    await terminallyFailDeployment(connection, work, {
      code: "runner_start_failed",
      now: now(),
      cleanup: { dependencies, context },
    });
    return "failed";
  }

  if (work.canaryState === "started") {
    await markCanaryOutcomeUnknown(connection, work, now());
    await terminallyFailDeployment(connection, work, {
      code: "model_canary_outcome_unknown",
      now: now(),
      cleanup: { dependencies, context },
    });
    return "failed";
  }

  if (work.canaryState !== "not_started") {
    await terminallyFailDeployment(connection, work, {
      code: "model_canary_failed",
      now: now(),
      cleanup: { dependencies, context },
    });
    return "failed";
  }

  const model = await readApprovedModel(connection, work);

  if (!model) {
    await terminallyFailDeployment(connection, work, {
      code: "managed_configuration_invalid",
      now: now(),
      cleanup: { dependencies, context },
    });
    return "failed";
  }

  const runner = await getAssignedRunner(connection, work);

  if (!runner) {
    await terminallyFailDeployment(connection, work, {
      code: "runner_start_failed",
      now: now(),
      cleanup: { dependencies, context },
    });
    return "failed";
  }

  const canDispatch = await markCanaryStarted(connection, work, now());

  if (!canDispatch) {
    return "retry_scheduled";
  }

  const result = await createRunnerAdapter(runner, dependencies, context).canary(work.agentId, {
    operationId: work.runnerOperationId,
    configRevision: work.configRevision,
    model,
  });

  if (!result.ok) {
    if (result.reason === "canary_not_dispatched") {
      await resetCanaryAfterNoDispatch(connection, work, now());
      return scheduleRetry(connection, work, "gateway_starting", now());
    }

    await markCanaryOutcomeUnknown(connection, work, now());
    await terminallyFailDeployment(connection, work, {
      code: "model_canary_outcome_unknown",
      now: now(),
      cleanup: { dependencies, context },
    });
    return "failed";
  }

  if (result.response.observation.state !== "passed") {
    await markCanaryFailed(connection, work, now());
    await terminallyFailDeployment(connection, work, {
      code: "model_canary_failed",
      now: now(),
      cleanup: { dependencies, context },
    });
    return "failed";
  }

  const passed = await connection.db.transaction((tx) =>
    markCanaryPassedAndStage(tx, work, { nextStage: "connecting_telegram", now: now() }),
  );
  return passed ? "advanced" : "retry_scheduled";
}

async function reconcileConnectingTelegram(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  dependencies: AgentDeploymentReconcilerDependencies,
  now: () => Date,
  context: DeploymentActionContext,
): Promise<AgentDeploymentReconcileOutcome> {
  const runner = await getAssignedRunner(connection, work);

  if (!runner) {
    await terminallyFailDeployment(connection, work, {
      code: "telegram_connection_failed",
      now: now(),
      cleanup: { dependencies, context },
    });
    return "failed";
  }

  const status = await createRunnerAdapter(runner, dependencies, context).status(work.agentId);

  if (!status.ok || !("snapshot" in status)) {
    return scheduleRetry(connection, work, "runner_transport_unavailable", now());
  }

  if (!isReadySnapshot(status.snapshot, work)) {
    if (isRetryableSnapshot(status.snapshot)) {
      return scheduleRetry(connection, work, "gateway_starting", now());
    }

    await terminallyFailDeployment(connection, work, {
      code: "telegram_connection_failed",
      now: now(),
      cleanup: { dependencies, context },
    });
    return "failed";
  }

  return (await finalizeReady(connection, work, now())) ? "ready" : "retry_scheduled";
}

async function claimOneDeploymentForReconcile(
  tx: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  input: {
    target: ReconcileTarget;
    leaseOwner: string;
    now: Date;
  },
): Promise<ClaimedDeploymentWork | null> {
  const nowIso = input.now.toISOString();
  const leaseExpiresAt = new Date(
    input.now.getTime() + DEPLOYMENT_RECONCILE_LEASE_MS,
  ).toISOString();
  const targetSql =
    input.target.kind === "deployment"
      ? sql`and ${agentDeployments.id} = ${input.target.deploymentId}`
      : input.target.kind === "runner"
        ? sql`and ${agents.runnerId} = ${input.target.runnerId}
            and exists (
              select 1 from ${runners}
              where ${runners.id} = ${input.target.runnerId}
                and ${runners.userId} = ${agentDeployments.userId}
                and ${runners.deletedAt} is null
            )`
        : sql``;

  const [row] = await tx.execute<ClaimedDeploymentWork>(sql`
    with next_deployment as (
      select ${agentDeployments.id} as id
      from ${agentDeployments}
      inner join ${agents}
        on ${agents.id} = ${agentDeployments.agentId}
       and ${agents.userId} = ${agentDeployments.userId}
      where ${agentDeployments.stage} not in ('ready', 'failed')
        and ${agents.deletedAt} is null
        and ${agents.desiredStatus} = 'running'
        and (${agentDeployments.nextAttemptAt} is null or ${agentDeployments.nextAttemptAt} <= ${nowIso})
        and (${agentDeployments.leaseExpiresAt} is null or ${agentDeployments.leaseExpiresAt} <= ${nowIso})
        ${targetSql}
      order by ${agentDeployments.createdAt}, ${agentDeployments.id}
      for update of ${agentDeployments} skip locked
      limit 1
    )
    update ${agentDeployments}
    set lease_owner = ${input.leaseOwner},
        lease_expires_at = ${leaseExpiresAt},
        attempt_count = ${agentDeployments.attemptCount} + 1,
        started_at = coalesce(${agentDeployments.startedAt}, ${nowIso}),
        updated_at = ${nowIso}
    from ${agents}
    where ${agentDeployments.id} = (select id from next_deployment)
      and ${agents.id} = ${agentDeployments.agentId}
      and ${agents.userId} = ${agentDeployments.userId}
    returning
      ${agentDeployments.id} as id,
      ${agentDeployments.agentId} as "agentId",
      ${agentDeployments.userId} as "userId",
      ${agentDeployments.stage} as stage,
      ${agentDeployments.configRevision} as "configRevision",
      ${agentDeployments.attemptCount} as "attemptCount",
      ${agentDeployments.leaseOwner} as "leaseOwner",
      ${agentDeployments.runnerOperationId} as "runnerOperationId",
      ${agentDeployments.runnerAcceptedAt} as "runnerAcceptedAt",
      ${agentDeployments.canaryState} as "canaryState",
      ${agentDeployments.canaryAttemptedAt} as "canaryAttemptedAt",
      ${agents.runnerId} as "agentRunnerId"
  `);

  return row ?? null;
}

async function lockOwnedAgentForDeployment(
  tx: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  work: ClaimedDeploymentWork,
  now: Date,
): Promise<
  | { ok: true; agent: { runnerId: string | null } }
  | { ok: false; code: DeploymentTerminalErrorCode }
> {
  const [agent] = await tx
    .select({ runnerId: agents.runnerId })
    .from(agents)
    .where(sql`${agents.id} = ${work.agentId} and ${agents.userId} = ${work.userId}`)
    .for("update")
    .limit(1);

  if (!agent) {
    return { ok: false, code: "deployment_cancelled" };
  }

  const [active] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      sql`${agents.id} = ${work.agentId} and ${agents.userId} = ${work.userId} and ${agents.deletedAt} is null and ${agents.desiredStatus} = 'running'`,
    )
    .limit(1);

  if (!active) {
    await markDeploymentFailedInTransaction(tx, work, {
      code: "deployment_cancelled",
      now,
      cleanupRequired: false,
    });
    return { ok: false, code: "deployment_cancelled" };
  }

  return { ok: true, agent };
}

async function initializeProvisioningRunner(
  tx: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  work: ClaimedDeploymentWork,
  now: Date,
  dependencies: AgentDeploymentReconcilerDependencies,
): Promise<{ ok: true } | { ok: false; code: DeploymentTerminalErrorCode }> {
  const config = dependencies.readDigitalOceanConfig
    ? dependencies.readDigitalOceanConfig()
    : readDigitalOceanProviderConfig();

  if (!config) {
    return { ok: false, code: "runner_provisioning_unavailable" };
  }

  const operationKey = provisioningOperationKeyForDeployment(work.id);
  const [runner] = await tx
    .insert(runners)
    .values({
      userId: work.userId,
      name: "plingpling Deployment Runner",
      kind: DIGITALOCEAN_RUNNER_KIND,
      status: "provisioning",
      provider: DIGITALOCEAN_PROVIDER,
      region: config.region,
      sizeSlug: config.sizeSlug,
      image: config.image,
      provisioningStatus: "pending",
      provisioningOperationKey: operationKey,
      provisioningStartedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: runners.provisioningOperationKey,
      targetWhere: sql`${runners.provisioningOperationKey} is not null`,
      set: { updatedAt: now },
      setWhere: sql`${runners.userId} = ${work.userId}
        and ${runners.kind} = ${DIGITALOCEAN_RUNNER_KIND}
        and ${runners.provider} = ${DIGITALOCEAN_PROVIDER}
        and ${runners.status} = 'provisioning'
        and ${runners.provisioningStatus} = 'pending'
        and ${runners.deletedAt} is null`,
    })
    .returning({ id: runners.id });

  const runnerId = runner?.id;

  if (!runnerId) {
    return { ok: false, code: "runner_provisioning_unavailable" };
  }

  await tx
    .update(agents)
    .set({
      runnerId,
      status: "starting",
      statusReason: STARTING_STATUS_REASON,
      updatedAt: now,
    })
    .where(
      sql`${agents.id} = ${work.agentId} and ${agents.userId} = ${work.userId} and ${agents.deletedAt} is null and ${agents.desiredStatus} = 'running'`,
    );

  const transitioned = await markDeploymentStage(tx, work, {
    nextStage: "provisioning_runner",
    now,
    events: ["agent.start_requested", "agent.deployment_stage_changed"],
  });

  if (!transitioned) {
    throw new LostDeploymentLeaseError();
  }

  return { ok: true };
}

async function markDeploymentStage(
  tx: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  work: ClaimedDeploymentWork,
  input: {
    nextStage: AgentDeploymentStage;
    now: Date;
    agentStatus?: "starting";
    statusReason?: string;
    events: string[];
  },
): Promise<boolean> {
  const [updated] = await tx.execute<{ id: string }>(sql`
    update ${agentDeployments}
    set stage = ${input.nextStage},
        error_code = null,
        error_detail = null,
        next_attempt_at = null,
        lease_owner = null,
        lease_expires_at = null,
        updated_at = ${input.now.toISOString()}
    where id = ${work.id}
      and stage = ${work.stage}
      and lease_owner = ${work.leaseOwner}
      and lease_expires_at > ${input.now.toISOString()}
      and config_revision = ${work.configRevision}
      and exists (
        select 1 from ${agents}
        where ${agents.id} = ${work.agentId}
          and ${agents.userId} = ${work.userId}
          and ${agents.deletedAt} is null
          and ${agents.desiredStatus} = 'running'
      )
    returning id
  `);

  if (!updated) {
    return false;
  }

  if (input.agentStatus) {
    await tx
      .update(agents)
      .set({
        status: input.agentStatus,
        statusReason: input.statusReason ?? null,
        updatedAt: input.now,
      })
      .where(sql`${agents.id} = ${work.agentId} and ${agents.userId} = ${work.userId}`);
  }

  await writeDeploymentEvents(tx, work, {
    events: input.events,
    fromStage: work.stage,
    toStage: input.nextStage,
    now: input.now,
  });
  return true;
}

async function persistRunnerAcceptedAndStage(
  tx: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  work: ClaimedDeploymentWork,
  input: {
    operationId: string;
    acceptedAt: Date;
    nextStage: AgentDeploymentStage;
    now: Date;
  },
): Promise<boolean> {
  const [updated] = await tx.execute<{ id: string }>(sql`
    update ${agentDeployments}
    set stage = ${input.nextStage},
        runner_operation_id = ${input.operationId},
        runner_accepted_at = ${input.acceptedAt.toISOString()},
        error_code = null,
        error_detail = null,
        next_attempt_at = null,
        lease_owner = null,
        lease_expires_at = null,
        updated_at = ${input.now.toISOString()}
    where id = ${work.id}
      and stage = ${work.stage}
      and config_revision = ${work.configRevision}
      and lease_owner = ${work.leaseOwner}
      and lease_expires_at > ${input.now.toISOString()}
      and exists (
        select 1 from ${agents}
        where ${agents.id} = ${work.agentId}
          and ${agents.userId} = ${work.userId}
          and ${agents.deletedAt} is null
          and ${agents.desiredStatus} = 'running'
      )
    returning id
  `);

  if (!updated) {
    return false;
  }

  await writeDeploymentEvents(tx, work, {
    events: ["agent.deployment_stage_changed"],
    fromStage: work.stage,
    toStage: input.nextStage,
    now: input.now,
  });
  return true;
}

async function transitionStage(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  nextStage: AgentDeploymentStage,
  now: Date,
): Promise<boolean> {
  return connection.db.transaction((tx) =>
    markDeploymentStage(tx, work, {
      nextStage,
      now,
      events: ["agent.deployment_stage_changed"],
    }),
  );
}

async function scheduleRetry(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  reason: keyof typeof RETRYABLE_DETAILS,
  now: Date,
): Promise<"failed" | "retry_scheduled"> {
  if (work.attemptCount >= MAX_AUTOMATIC_DEPLOYMENT_ATTEMPTS) {
    await terminallyFailDeployment(connection, work, {
      code: "deployment_attempts_exhausted",
      now,
    });
    return "failed";
  }

  const detail = RETRYABLE_DETAILS[reason];
  const backoffMs = computeDeploymentBackoffMs(work.attemptCount);

  await connection.db.execute(sql`
    update ${agentDeployments}
    set error_code = ${reason},
        error_detail = ${detail},
        next_attempt_at = ${new Date(now.getTime() + backoffMs).toISOString()},
        lease_owner = null,
        lease_expires_at = null,
        updated_at = ${now.toISOString()}
    where id = ${work.id}
      and stage = ${work.stage}
      and config_revision = ${work.configRevision}
      and lease_owner = ${work.leaseOwner}
      and lease_expires_at > ${now.toISOString()}
      and exists (
        select 1 from ${agents}
        where ${agents.id} = ${work.agentId}
          and ${agents.userId} = ${work.userId}
          and ${agents.deletedAt} is null
          and ${agents.desiredStatus} = 'running'
      )
  `);
  return "retry_scheduled";
}

async function markCanaryStarted(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  now: Date,
): Promise<boolean> {
  const [updated] = await connection.db.execute<{ id: string }>(sql`
    update ${agentDeployments}
    set canary_state = 'started',
        canary_attempted_at = ${now.toISOString()},
        canary_completed_at = null,
        updated_at = ${now.toISOString()}
    where id = ${work.id}
      and stage = 'verifying_model'
      and canary_state = 'not_started'
      and config_revision = ${work.configRevision}
      and lease_owner = ${work.leaseOwner}
      and lease_expires_at > ${now.toISOString()}
      and exists (
        select 1 from ${agents}
        where ${agents.id} = ${work.agentId}
          and ${agents.userId} = ${work.userId}
          and ${agents.deletedAt} is null
          and ${agents.desiredStatus} = 'running'
      )
    returning id
  `);

  return Boolean(updated);
}

async function resetCanaryAfterNoDispatch(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  now: Date,
): Promise<boolean> {
  const [updated] = await connection.db.execute<{ id: string }>(sql`
    update ${agentDeployments}
    set canary_state = 'not_started',
        canary_attempted_at = null,
        canary_completed_at = null,
        updated_at = ${now.toISOString()}
    where id = ${work.id}
      and stage = 'verifying_model'
      and canary_state = 'started'
      and config_revision = ${work.configRevision}
      and lease_owner = ${work.leaseOwner}
      and lease_expires_at > ${now.toISOString()}
      and exists (
        select 1 from ${agents}
        where ${agents.id} = ${work.agentId}
          and ${agents.userId} = ${work.userId}
          and ${agents.deletedAt} is null
          and ${agents.desiredStatus} = 'running'
      )
    returning id
  `);

  return Boolean(updated);
}

async function markCanaryOutcomeUnknown(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  now: Date,
): Promise<void> {
  await connection.db.execute(sql`
    update ${agentDeployments}
    set canary_state = 'outcome_unknown',
        canary_attempted_at = coalesce(canary_attempted_at, ${now.toISOString()}),
        canary_completed_at = null,
        updated_at = ${now.toISOString()}
    where id = ${work.id}
      and stage = 'verifying_model'
      and config_revision = ${work.configRevision}
      and lease_owner = ${work.leaseOwner}
      and lease_expires_at > ${now.toISOString()}
      and exists (
        select 1 from ${agents}
        where ${agents.id} = ${work.agentId}
          and ${agents.userId} = ${work.userId}
          and ${agents.deletedAt} is null
          and ${agents.desiredStatus} = 'running'
      )
  `);
}

async function markCanaryFailed(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  now: Date,
): Promise<void> {
  await connection.db.execute(sql`
    update ${agentDeployments}
    set canary_state = 'failed',
        canary_completed_at = ${now.toISOString()},
        updated_at = ${now.toISOString()}
    where id = ${work.id}
      and stage = 'verifying_model'
      and config_revision = ${work.configRevision}
      and lease_owner = ${work.leaseOwner}
      and lease_expires_at > ${now.toISOString()}
      and exists (
        select 1 from ${agents}
        where ${agents.id} = ${work.agentId}
          and ${agents.userId} = ${work.userId}
          and ${agents.deletedAt} is null
          and ${agents.desiredStatus} = 'running'
      )
  `);
}

async function markCanaryPassedAndStage(
  tx: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  work: ClaimedDeploymentWork,
  input: { nextStage: AgentDeploymentStage; now: Date },
): Promise<boolean> {
  const [updated] = await tx.execute<{ id: string }>(sql`
    update ${agentDeployments}
    set stage = ${input.nextStage},
        canary_state = 'passed',
        canary_completed_at = ${input.now.toISOString()},
        error_code = null,
        error_detail = null,
        next_attempt_at = null,
        lease_owner = null,
        lease_expires_at = null,
        updated_at = ${input.now.toISOString()}
    where id = ${work.id}
      and stage = 'verifying_model'
      and canary_state = 'started'
      and lease_owner = ${work.leaseOwner}
      and lease_expires_at > ${input.now.toISOString()}
      and config_revision = ${work.configRevision}
      and exists (
        select 1 from ${agents}
        where ${agents.id} = ${work.agentId}
          and ${agents.userId} = ${work.userId}
          and ${agents.deletedAt} is null
          and ${agents.desiredStatus} = 'running'
      )
    returning id
  `);

  if (!updated) {
    return false;
  }

  await writeDeploymentEvents(tx, work, {
    events: ["agent.deployment_stage_changed"],
    fromStage: work.stage,
    toStage: input.nextStage,
    now: input.now,
  });
  return true;
}

async function finalizeReady(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  now: Date,
): Promise<boolean> {
  return connection.db.transaction(async (tx) => {
    const [ownedAgent] = await tx
      .select({ id: agents.id, runnerId: agents.runnerId })
      .from(agents)
      .where(
        sql`${agents.id} = ${work.agentId} and ${agents.userId} = ${work.userId} and ${agents.deletedAt} is null and ${agents.desiredStatus} = 'running' and ${agents.runnerId} = ${work.agentRunnerId}`,
      )
      .for("update")
      .limit(1);

    if (!ownedAgent?.runnerId) {
      return false;
    }

    const [updated] = await tx.execute<{ id: string }>(sql`
      update ${agentDeployments}
      set stage = 'ready',
          completed_at = ${now.toISOString()},
          error_code = null,
          error_detail = null,
          next_attempt_at = null,
          lease_owner = null,
          lease_expires_at = null,
          updated_at = ${now.toISOString()}
      where id = ${work.id}
        and stage = 'connecting_telegram'
        and canary_state = 'passed'
        and runner_operation_id = ${work.runnerOperationId}
        and config_revision = ${work.configRevision}
        and lease_owner = ${work.leaseOwner}
        and lease_expires_at > ${now.toISOString()}
      returning id
    `);

    if (!updated) {
      return false;
    }

    const [agent] = await tx
      .update(agents)
      .set({
        status: "running",
        statusReason: RUNNING_STATUS_REASON,
        updatedAt: now,
      })
      .where(
        sql`${agents.id} = ${work.agentId} and ${agents.userId} = ${work.userId} and ${agents.deletedAt} is null and ${agents.desiredStatus} = 'running' and ${agents.runnerId} = ${work.agentRunnerId} and ${agents.status} in ('starting', 'restarting')`,
      )
      .returning({ runnerId: agents.runnerId });

    if (!agent?.runnerId) {
      throw new LostDeploymentLeaseError();
    }

    await tx
      .insert(agentUsagePeriods)
      .values({
        agentId: work.agentId,
        runnerId: agent?.runnerId ?? null,
        source: "lifecycle",
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    await writeDeploymentEvents(tx, work, {
      events: ["agent.deployment_stage_changed", "agent.start_completed"],
      fromStage: "connecting_telegram",
      toStage: "ready",
      now,
    });
    return true;
  });
}

async function terminallyFailDeployment(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  input: {
    code: DeploymentTerminalErrorCode;
    now: Date;
    cleanupRequired?: boolean;
    cleanup?: {
      context: DeploymentActionContext;
      dependencies: AgentDeploymentReconcilerDependencies;
    };
  },
): Promise<boolean> {
  let cleanupRequired = input.cleanupRequired ?? false;

  if (input.cleanup) {
    const runner = await getAssignedRunner(connection, work);

    if (!runner) {
      cleanupRequired = true;
    } else {
      const adapter = createRunnerAdapter(
        runner,
        input.cleanup.dependencies,
        input.cleanup.context,
      );

      try {
        await adapter.streamLogs({ agentId: work.agentId, limit: 100 });
      } catch {
        // Log capture is best-effort and the adapter redacts before persistence.
      }

      try {
        const stopped = await adapter.stop(work.agentId);
        cleanupRequired = !stopped.ok;
      } catch {
        cleanupRequired = true;
      }
    }
  }

  return connection.db.transaction((tx) =>
    markDeploymentFailedInTransaction(tx, work, {
      code: input.code,
      now: input.now,
      cleanupRequired,
    }),
  );
}

async function markDeploymentFailedInTransaction(
  tx: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  work: ClaimedDeploymentWork,
  input: { code: DeploymentTerminalErrorCode; now: Date; cleanupRequired: boolean },
): Promise<boolean> {
  const detail = safeTerminalDetail(input.code);

  const [updated] = await tx.execute<{ id: string }>(sql`
    update ${agentDeployments}
    set stage = 'failed',
        error_code = ${input.code},
        error_detail = ${detail},
        next_attempt_at = null,
        lease_owner = null,
        lease_expires_at = null,
        failed_at = ${input.now.toISOString()},
        updated_at = ${input.now.toISOString()}
    where id = ${work.id}
      and stage not in ('ready', 'failed')
      and config_revision = ${work.configRevision}
      and lease_owner = ${work.leaseOwner}
      and lease_expires_at > ${input.now.toISOString()}
      and exists (
        select 1 from ${agents}
        where ${agents.id} = ${work.agentId}
          and ${agents.userId} = ${work.userId}
          and ${agents.deletedAt} is null
          and ${agents.desiredStatus} = 'running'
      )
    returning id
  `);

  if (!updated) {
    return false;
  }

  await tx
    .update(agents)
    .set({
      status: "error",
      statusReason: ERROR_STATUS_REASON,
      updatedAt: input.now,
    })
    .where(
      sql`${agents.id} = ${work.agentId} and ${agents.userId} = ${work.userId} and ${agents.deletedAt} is null and ${agents.desiredStatus} = 'running'`,
    );

  await tx
    .update(agentUsagePeriods)
    .set({ stoppedAt: input.now, updatedAt: input.now })
    .where(
      sql`${agentUsagePeriods.agentId} = ${work.agentId} and ${agentUsagePeriods.stoppedAt} is null`,
    );

  await writeDeploymentEvents(tx, work, {
    events: ["agent.error"],
    fromStage: work.stage,
    toStage: "failed",
    now: input.now,
    errorCode: input.code,
    cleanupRequired: input.cleanupRequired,
  });
  return true;
}

async function writeDeploymentEvents(
  tx: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  work: ClaimedDeploymentWork,
  input: {
    events: string[];
    fromStage: string;
    toStage: string;
    now: Date;
    errorCode?: string;
    cleanupRequired?: boolean;
  },
): Promise<void> {
  await recordAgentEventsInTransaction(
    tx,
    input.events.map((event) => ({
      agentId: work.agentId,
      actorUserId: work.userId,
      type: event,
      message: eventMessage(event),
      metadata: {
        deploymentId: work.id,
        fromStage: input.fromStage,
        toStage: input.toStage,
        attemptCount: work.attemptCount,
        launchMode: "ready",
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        ...(input.cleanupRequired === undefined ? {} : { cleanupRequired: input.cleanupRequired }),
      },
      createdAt: input.now,
    })),
  );
}

async function getAssignedRunner(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
): Promise<ManualRunnerRecord | null> {
  const [runner] = await connection.db
    .select({
      id: runners.id,
      userId: runners.userId,
      name: runners.name,
      kind: runners.kind,
      endpointUrl: runners.endpointUrl,
      status: runners.status,
      createdAt: runners.createdAt,
      updatedAt: runners.updatedAt,
      deletedAt: runners.deletedAt,
    })
    .from(agents)
    .innerJoin(runners, sql`${runners.id} = ${agents.runnerId}`)
    .where(
      sql`${agents.id} = ${work.agentId} and ${agents.userId} = ${work.userId} and ${agents.deletedAt} is null and ${agents.desiredStatus} = 'running' and ${runners.userId} = ${work.userId} and ${runners.endpointUrl} is not null and ${runners.deletedAt} is null`,
    )
    .limit(1);

  return runner?.endpointUrl
    ? {
        id: runner.id,
        userId: runner.userId,
        name: runner.name,
        kind: runner.kind as ManualRunnerRecord["kind"],
        endpointUrl: runner.endpointUrl,
        status: runner.status as ManualRunnerRecord["status"],
        createdAt: runner.createdAt.toISOString(),
        updatedAt: runner.updatedAt.toISOString(),
        deletedAt: runner.deletedAt?.toISOString() ?? null,
      }
    : null;
}

async function readApprovedModel(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
): Promise<string | null> {
  const [config] = await connection.db
    .select({
      modelProvider: agentConfigs.modelProvider,
      modelName: agentConfigs.modelName,
    })
    .from(agentConfigs)
    .where(sql`${agentConfigs.agentId} = ${work.agentId}`)
    .limit(1);

  return config?.modelProvider === "openrouter" && getApprovedOpenRouterModel(config.modelName)
    ? config.modelName
    : null;
}

function createRunnerAdapter(
  runner: ManualRunnerRecord,
  dependencies: AgentDeploymentReconcilerDependencies,
  context: DeploymentActionContext,
): ReconcilerRunnerAdapter {
  const timeoutMs = Math.max(1, context.remainingMs());

  return (
    dependencies.manualRunnerAdapter?.(runner, { signal: context.signal, timeoutMs }) ??
    new ManualRunnerAdapter(runner, { signal: context.signal, timeoutMs })
  );
}

function isReadySnapshot(
  snapshot: RunnerAgentStatusSnapshot,
  work: ClaimedDeploymentWork,
): boolean {
  return (
    snapshot.phase === "ready" &&
    snapshot.operation?.id === work.runnerOperationId &&
    snapshot.operation.target.configRevision === work.configRevision &&
    snapshot.gateway.state === "running" &&
    snapshot.apiServer.required &&
    snapshot.apiServer.state === "connected" &&
    snapshot.telegram.required &&
    snapshot.telegram.state === "connected" &&
    snapshot.revision.state === "match"
  );
}

function isRetryableSnapshot(snapshot: RunnerAgentStatusSnapshot): boolean {
  return (
    snapshot.phase === "accepted" ||
    snapshot.phase === "starting" ||
    snapshot.gateway.state === "starting" ||
    snapshot.apiServer.state === "connecting" ||
    snapshot.apiServer.state === "disconnected" ||
    snapshot.telegram.state === "connecting" ||
    snapshot.telegram.state === "disconnected"
  );
}

function requiresStartConvergence(
  snapshot: RunnerAgentStatusSnapshot,
  work: ClaimedDeploymentWork,
): boolean {
  return (
    snapshot.operation?.id !== work.runnerOperationId ||
    snapshot.operation?.target.configRevision !== work.configRevision ||
    snapshot.revision.state === "mismatch" ||
    snapshot.revision.state === "missing" ||
    snapshot.container.state === "absent" ||
    snapshot.container.state === "exited" ||
    snapshot.container.state === "dead" ||
    snapshot.phase === "failed" ||
    snapshot.phase === "stopped" ||
    snapshot.phase === "cancelled"
  );
}

function provisioningOperationKeyForDeployment(deploymentId: string): string {
  return `agentbay-deploy-${deploymentId.replaceAll("-", "").toLowerCase()}`;
}

async function defaultProvisioner(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  currentNow: Date,
  context: DeploymentActionContext,
  dependencies: AgentDeploymentReconcilerDependencies,
): Promise<ProvisionerResult> {
  const config = dependencies.readDigitalOceanConfig
    ? dependencies.readDigitalOceanConfig()
    : readDigitalOceanProviderConfig();

  if (!config || !work.agentRunnerId) {
    return { ok: false, terminalCode: "runner_provisioning_unavailable" };
  }

  const operationKey = provisioningOperationKeyForDeployment(work.id);
  const provider =
    dependencies.digitalOceanProvider ?? createConfiguredDigitalOceanProvider(config);

  return advanceAutomaticDigitalOceanRunnerProvisioning({
    connection,
    userId: work.userId,
    runnerId: work.agentRunnerId,
    operationKey,
    attemptCount: work.attemptCount,
    maxAttempts: MAX_AUTOMATIC_DEPLOYMENT_ATTEMPTS,
    config,
    provider,
    context,
    now: () => currentNow,
  });
}

function eventMessage(event: string): string {
  if (event === "agent.start_requested") {
    return "Automatic deployment requested agent start.";
  }

  if (event === "agent.start_completed") {
    return "Automatic deployment completed agent start.";
  }

  if (event === "agent.error") {
    return "Automatic deployment failed.";
  }

  return "Automatic deployment stage changed.";
}

function safeTerminalDetail(code: DeploymentTerminalErrorCode): string {
  const detail = (
    {
      deployment_attempts_exhausted: "Automatic deployment reached the retry limit.",
      deployment_cancelled: "Automatic deployment was cancelled.",
      deployment_internal_failure: "Automatic deployment failed safely.",
      managed_configuration_invalid: "Managed Hermes configuration is invalid.",
      model_canary_failed: "The configured model canary failed.",
      model_canary_outcome_unknown: "The configured model canary outcome is unknown.",
      runner_provisioning_unavailable: "Runner provisioning is not configured safely.",
      runner_provisioning_outcome_unknown:
        "Runner provisioning outcome is unknown and requires operator confirmation.",
      runner_start_failed: "Hermes runner start could not be confirmed.",
      telegram_connection_failed: "Telegram connection could not be confirmed.",
    } satisfies Record<DeploymentTerminalErrorCode, string>
  )[code];
  const normalized = normalizeDeploymentErrorDetail(detail);

  if (!validateDeploymentErrorCode(code) || !normalized.ok || !normalized.value) {
    return "Automatic deployment failed safely.";
  }

  return normalized.value;
}
