import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { RunnerAgentStatusSnapshot } from "@/src/runner-service/runner-contracts";
import { replaceDeploymentWakeupInTransaction } from "@/src/server/agents/agent-deployment-dispatch";
import { quarantineAgentDeploymentForSafety } from "@/src/server/agents/agent-deployments";
import {
  applyAgentDeploymentChoices,
  parseAgentDeploymentChoices,
  recoverAgentDeploymentProviderConfig,
  runnerCompatibilityRequirementForAgentDeploymentChoices,
  type AgentDeploymentChoices,
} from "@/src/server/agents/agent-deployment-choices";
import { buildHermesAgentLaunchSpecForUser } from "@/src/server/agents/agent-launch-builder";
import { logAgentDeploymentTerminalCompletion } from "@/src/server/agents/agent-deployment-latency";
import { initializeAgentRuntimeAfterDeploymentReady } from "@/src/server/agents/agent-runtime-store";
import { scheduleAgentRuntimeReconcileAfterResponse } from "@/src/server/agents/agent-runtime-triggers";
import { getAssistantProfileForManagedModel } from "@/src/server/agents/assistant-profiles";
import { COLD_DEPLOYMENT_SLO_OBJECTIVE_MS } from "@/src/server/agents/cold-deployment-slo-objective";
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
  runnerHeartbeats,
  runnerReplacements,
  runners,
} from "@/src/server/db/schema";
import {
  type DigitalOceanProviderConfig,
  readDigitalOceanProviderCredentials,
  readHermesWorkloadImage,
} from "@/src/server/env";
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
import { requiredRunnerImageDigestForProvider } from "@/src/server/runners/runner-compatibility";
import { RUNNER_HEARTBEAT_STALE_THRESHOLD_MS } from "@/src/server/runners/runner-heartbeat";
import {
  lockRunnerPlacementCapacityInTransaction,
  selectRunnerPlacementForUserInTransaction,
} from "@/src/server/runners/runner-placement";
import {
  advanceAutomaticDigitalOceanRunnerProvisioning,
  createConfiguredDigitalOceanProvider,
} from "@/src/server/runners/runner-provisioning";
import type { RunnerReplacementReason } from "@/src/server/runners/runner-replacement-state";
import { createOrGetRunnerReplacement } from "@/src/server/runners/runner-replacement-store";
import { scheduleRunnerReplacementReconcileAfterResponse } from "@/src/server/runners/runner-replacement-triggers";
import { createAppLogger, serializeLogError } from "@/src/server/logging/logger";

const agentDeploymentLogger = createAppLogger("agent.deployment");

export const DEPLOYMENT_RECONCILE_LEASE_MS = 90_000;
export const DEPLOYMENT_RECONCILE_ACTION_DEADLINE_MS = 45_000;
export const DEPLOYMENT_DRAIN_MAX_ITERATIONS = 8;
export const GATEWAY_START_DEADLINE_MS = COLD_DEPLOYMENT_SLO_OBJECTIVE_MS;

const MAX_REPLACEMENTS_PER_DEPLOYMENT = 2;
const REPLACEMENT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const STAGE_RETRY_LIMITS: Readonly<Record<AgentDeploymentStage, number>> = {
  pending: 16,
  provisioning_runner: 32,
  configuring_hermes: 3,
  starting_gateway: Number.MAX_SAFE_INTEGER,
  verifying_model: 2,
  connecting_telegram: 8,
  ready: 0,
  failed: 0,
};

const STARTING_STATUS_REASON = "Automatic deployment is in progress.";
const RUNNING_STATUS_REASON = "Hermes gateway is ready.";
const ERROR_STATUS_REASON =
  "Automatic deployment failed. Retry, Stop, or Delete this agent from the deployment controls.";

class LostDeploymentLeaseError extends Error {}
class DeploymentActionDeadlineExceededError extends Error {}

export type AgentDeploymentReconcileOutcome =
  | "idle"
  | "advanced"
  | "retry_scheduled"
  | "failed"
  | "recovering"
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
  | {
      ok: true;
      state: "pending";
      disposition?: "immediate" | "external_wait" | "observation_wait";
    }
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

export type AgentDeploymentReconcileBudget = {
  deadlineAt: Date;
  signal: AbortSignal;
};

export type AgentDeploymentReconcilerDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  readHermesWorkloadImage?: () => string;
  launchSpec?: typeof buildHermesAgentLaunchSpecForUser;
  manualRunnerAdapter?: (
    runner: ManualRunnerRecord,
    options: { signal: AbortSignal; timeoutMs: number },
  ) => ReconcilerRunnerAdapter;
  provisioner?: DeploymentProvisioner;
  digitalOceanProvider?: DigitalOceanProvider;
  readDigitalOceanConfig?: () => DigitalOceanProviderConfig | null;
  randomUUID?: () => string;
  modelCanaryEnabled?: boolean;
  triggerReplacement?: (replacementId: string) => void;
  scheduleRuntimeAfterReady?: typeof scheduleAgentRuntimeReconcileAfterResponse;
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

type CanaryState = "not_started" | "started" | "passed" | "skipped" | "failed" | "outcome_unknown";

type ClaimedDeploymentWork = {
  id: string;
  agentId: string;
  userId: string;
  stage: AgentDeploymentStage;
  configRevision: string;
  attemptCount: number;
  leaseOwner: string;
  runnerOperationId: string | null;
  runnerAcceptedAt: Date | string | null;
  canaryState: CanaryState;
  canaryAttemptedAt: Date | null;
  agentRunnerId: string | null;
  deploymentChoices: AgentDeploymentChoices;
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
  | "replacement_budget_exhausted"
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
  budget?: AgentDeploymentReconcileBudget,
): Promise<AgentDeploymentReconcileResult> {
  const context = budget
    ? deploymentActionContextFromBudget(budget, dependencies.now ?? (() => new Date()))
    : undefined;
  return publicReconcileResult(await reconcileOne({ kind: "global" }, dependencies, context));
}

export async function reconcileTargetAgentDeployment(
  deploymentId: string,
  dependencies: AgentDeploymentReconcilerDependencies = {},
): Promise<AgentDeploymentReconcileResult> {
  return publicReconcileResult(
    await reconcileOne({ kind: "deployment", deploymentId }, dependencies),
  );
}

export async function reconcileTargetRunnerDeployment(
  runnerId: string,
  dependencies: AgentDeploymentReconcilerDependencies = {},
): Promise<AgentDeploymentReconcileResult> {
  return publicReconcileResult(await reconcileOne({ kind: "runner", runnerId }, dependencies));
}

export async function drainTargetAgentDeployment(
  deploymentId: string,
  dependencies: AgentDeploymentReconcilerDependencies = {},
): Promise<AgentDeploymentReconcileResult> {
  return drainDeployment({ kind: "deployment", deploymentId }, dependencies);
}

export async function drainTargetRunnerDeployment(
  runnerId: string,
  dependencies: AgentDeploymentReconcilerDependencies = {},
): Promise<AgentDeploymentReconcileResult> {
  return drainDeployment(
    { kind: "runner", runnerId },
    { ...dependencies, scheduleRuntimeAfterReady: () => undefined },
  );
}

type InternalAgentDeploymentReconcileResult = AgentDeploymentReconcileResult & {
  deploymentId: string | null;
};

async function drainDeployment(
  initialTarget: Extract<ReconcileTarget, { kind: "deployment" | "runner" }>,
  dependencies: AgentDeploymentReconcilerDependencies,
): Promise<AgentDeploymentReconcileResult> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const action = createDeploymentActionContext(now);
  let target: ReconcileTarget = initialTarget;
  let result: AgentDeploymentReconcileResult = { processed: 0, outcome: "idle" };

  try {
    for (let iteration = 0; iteration < DEPLOYMENT_DRAIN_MAX_ITERATIONS; iteration += 1) {
      if (action.context.signal.aborted || action.context.remainingMs() <= 0) {
        break;
      }

      const current = await reconcileOne(
        target,
        { ...dependencies, createConnection: () => connection, now },
        action.context,
      );
      result = publicReconcileResult(current);

      if (current.processed !== 1 || current.outcome !== "advanced" || !current.deploymentId) {
        break;
      }

      target = { kind: "deployment", deploymentId: current.deploymentId };
    }

    return result;
  } finally {
    action.dispose();
    if (ownsConnection) {
      await connection.close();
    }
  }
}

function publicReconcileResult(
  result: InternalAgentDeploymentReconcileResult,
): AgentDeploymentReconcileResult {
  return { processed: result.processed, outcome: result.outcome };
}

function createDeploymentActionContext(now: () => Date): {
  context: DeploymentActionContext;
  dispose: () => void;
} {
  const deadlineAt = new Date(now().getTime() + DEPLOYMENT_RECONCILE_ACTION_DEADLINE_MS);
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(new DOMException("Deployment action deadline exceeded.", "TimeoutError")),
    DEPLOYMENT_RECONCILE_ACTION_DEADLINE_MS,
  );
  const context: DeploymentActionContext = {
    deadlineAt,
    signal: controller.signal,
    remainingMs: () =>
      Math.max(
        0,
        Math.min(DEPLOYMENT_RECONCILE_ACTION_DEADLINE_MS, deadlineAt.getTime() - now().getTime()),
      ),
  };

  return { context, dispose: () => clearTimeout(timeout) };
}

function deploymentActionContextFromBudget(
  budget: AgentDeploymentReconcileBudget,
  now: () => Date,
): DeploymentActionContext {
  return {
    deadlineAt: budget.deadlineAt,
    signal: budget.signal,
    remainingMs: () => Math.max(0, budget.deadlineAt.getTime() - now().getTime()),
  };
}

async function reconcileOne(
  target: ReconcileTarget,
  dependencies: AgentDeploymentReconcilerDependencies,
  sharedContext?: DeploymentActionContext,
): Promise<InternalAgentDeploymentReconcileResult> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const leaseOwner = `reconcile:${randomUUID()}`;
  const lifecycleId = leaseOwner.slice("reconcile:".length);
  const startedAt = Date.now();

  try {
    const claimed = await connection.db.transaction((tx) =>
      claimOneDeploymentForReconcile(tx, {
        target,
        leaseOwner,
        now: now(),
      }),
    );

    if (!claimed) {
      logAgentDeployment(
        "reconcile_idle",
        {
          lifecycle: "agent_deployment",
          lifecycleId,
          targetKind: target.kind,
          durationMs: Date.now() - startedAt,
        },
        "debug",
      );
      return { processed: 0, outcome: "idle", deploymentId: null };
    }

    const hermesWorkloadImage =
      claimed.deploymentChoices.provider.hermesWorkloadImage ??
      (dependencies.readHermesWorkloadImage ?? readHermesWorkloadImage)();

    const lifecycleMetadata = {
      lifecycle: "agent_deployment",
      lifecycleId,
      agentId: claimed.agentId,
      deploymentId: claimed.id,
      runnerId: claimed.agentRunnerId,
      stage: claimed.stage,
      attemptCount: claimed.attemptCount,
    };
    logAgentDeployment("stage_started", lifecycleMetadata);
    const action = sharedContext ? null : createDeploymentActionContext(now);
    const context = sharedContext ?? action?.context;
    if (!context) {
      throw new Error("Deployment action context was not initialized.");
    }
    let outcome: AgentDeploymentReconcileOutcome;
    try {
      assertDeploymentActionActive(context);
      outcome = await runClaimedStage(
        connection,
        claimed,
        dependencies,
        hermesWorkloadImage,
        now,
        context,
      );
    } catch (error) {
      if (
        !(error instanceof DeploymentActionDeadlineExceededError) &&
        !context.signal.aborted &&
        context.remainingMs() > 0
      ) {
        throw error;
      }
      await releaseClaimAfterDeadline(connection, claimed, now());
      return { processed: 0, outcome: "idle", deploymentId: claimed.id };
    } finally {
      action?.dispose();
    }
    logAgentDeployment(
      "stage_completed",
      { ...lifecycleMetadata, outcome, durationMs: Date.now() - startedAt },
      outcome === "failed" ? "error" : outcome === "retry_scheduled" ? "warn" : "info",
    );

    return {
      processed: 1,
      outcome,
      deploymentId: claimed.id,
    };
  } catch (error) {
    logAgentDeploymentError("reconcile_failed", error, {
      lifecycle: "agent_deployment",
      lifecycleId,
      targetKind: target.kind,
      ...(target.kind === "deployment" ? { deploymentId: target.deploymentId } : {}),
      ...(target.kind === "runner" ? { runnerId: target.runnerId } : {}),
      durationMs: Date.now() - startedAt,
    });
    throw error;
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
  hermesWorkloadImage: string,
  now: () => Date,
  context: DeploymentActionContext,
): Promise<AgentDeploymentReconcileOutcome> {
  switch (work.stage) {
    case "pending":
      return reconcilePending(connection, work, dependencies, now);
    case "provisioning_runner":
      return reconcileProvisioningRunner(connection, work, dependencies, now, context);
    case "configuring_hermes":
      return reconcileConfiguringHermes(
        connection,
        work,
        dependencies,
        hermesWorkloadImage,
        now,
        context,
      );
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
}

async function reconcilePending(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  dependencies: AgentDeploymentReconcilerDependencies,
  now: () => Date,
): Promise<AgentDeploymentReconcileOutcome> {
  const compatibilityRequirement = runnerCompatibilityRequirementForAgentDeploymentChoices(
    work.deploymentChoices,
  );
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
        const locked = await lockRunnerPlacementCapacityInTransaction(tx, {
          userId: work.userId,
          runnerId: owned.agent.runnerId,
        });
        if (!locked) {
          return { kind: "retry" as const };
        }
        const assigned = await selectRunnerPlacementForUserInTransaction(
          tx,
          work.userId,
          { excludeAgentId: work.agentId, runnerId: owned.agent.runnerId },
          { now: now(), compatibilityRequirement },
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
        { now: now(), compatibilityRequirement },
      );

      if (placement.ok) {
        const locked = await lockRunnerPlacementCapacityInTransaction(tx, {
          userId: work.userId,
          runnerId: placement.runner.id,
        });
        if (!locked) {
          return { kind: "retry" as const };
        }
        const confirmed = await selectRunnerPlacementForUserInTransaction(
          tx,
          work.userId,
          { runnerId: placement.runner.id },
          { now: now(), compatibilityRequirement },
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

      if (provisioning.state === "waiting") {
        return { kind: "retry" as const };
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
  const compatibilityRequirement = runnerCompatibilityRequirementForAgentDeploymentChoices(
    work.deploymentChoices,
  );
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

    const locked = await lockRunnerPlacementCapacityInTransaction(tx, {
      userId: work.userId,
      runnerId: runner.id,
    });
    if (!locked) {
      return "missing" as const;
    }
    const placement = await selectRunnerPlacementForUserInTransaction(
      tx,
      work.userId,
      { excludeAgentId: work.agentId, runnerId: runner.id },
      { now: now(), compatibilityRequirement },
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
  assertDeploymentActionActive(context);
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

  return result.disposition === "immediate"
    ? scheduleImmediateRetry(connection, work, "runner_not_ready", now())
    : scheduleRetry(connection, work, "runner_not_ready", now());
}

async function reconcileConfiguringHermes(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  dependencies: AgentDeploymentReconcilerDependencies,
  hermesWorkloadImage: string,
  now: () => Date,
  context: DeploymentActionContext,
): Promise<AgentDeploymentReconcileOutcome> {
  const launch = await (dependencies.launchSpec ?? buildHermesAgentLaunchSpecForUser)(
    work.userId,
    work.agentId,
    { hermesWorkloadImage },
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
    return maybeRecoverManagedTransport(connection, work, dependencies, context, now());
  }

  const adapter = createRunnerAdapter(runner, dependencies, context);
  const started = await adapter.start(work.agentId, launch.spec);

  if (!started.ok) {
    return maybeRecoverManagedTransport(connection, work, dependencies, context, now());
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
  const observedAt = now();
  if (!work.runnerAcceptedAt || !work.runnerOperationId) {
    await terminallyFailDeployment(connection, work, {
      code: "runner_start_failed",
      now: observedAt,
      cleanup: { dependencies, context },
    });
    return "failed";
  }

  const acceptedAt = toDate(work.runnerAcceptedAt);
  if (!acceptedAt) {
    await terminallyFailDeployment(connection, work, {
      code: "runner_start_failed",
      now: observedAt,
      cleanup: { dependencies, context },
    });
    return "failed";
  }
  const deadlineAt = new Date(acceptedAt.getTime() + GATEWAY_START_DEADLINE_MS);
  if (observedAt.getTime() >= deadlineAt.getTime()) {
    return beginManagedRunnerRecovery(connection, work, dependencies, context, {
      reason: "gateway_deadline",
      now: observedAt,
    });
  }

  const runner = await getAssignedRunner(connection, work);

  if (!runner) {
    return maybeRecoverManagedTransport(connection, work, dependencies, context, observedAt);
  }

  const adapter = createRunnerAdapter(runner, dependencies, context);
  const status = await adapter.status(work.agentId);

  if (!status.ok || !("snapshot" in status)) {
    return maybeRecoverManagedTransport(connection, work, dependencies, context, observedAt);
  }

  logAgentDeployment("starting_gateway_status", {
    agentId: work.agentId,
    deploymentId: work.id,
    phase: status.snapshot.phase,
    readinessReason: status.snapshot.readinessReason,
    operationMatches: status.snapshot.operation?.id === work.runnerOperationId,
    configRevisionMatches: status.snapshot.operation?.target.configRevision === work.configRevision,
    revisionState: status.snapshot.revision.state,
    containerState: status.snapshot.container.state,
    gatewayState: status.snapshot.gateway.state,
    apiServerState: status.snapshot.apiServer.state,
    telegramState: status.snapshot.telegram.state,
  });

  if (status.snapshot.readinessReason === "readiness_timeout") {
    return beginManagedRunnerRecovery(connection, work, dependencies, context, {
      reason: "gateway_deadline",
      now: observedAt,
    });
  }

  if (isReadySnapshot(status.snapshot, work)) {
    if (!modelCanaryEnabled(dependencies)) {
      return (await markCanarySkippedAndStage(connection, work, now()))
        ? "advanced"
        : "retry_scheduled";
    }
    return (await transitionStage(connection, work, "verifying_model", now()))
      ? "advanced"
      : "retry_scheduled";
  }

  return scheduleRetry(
    connection,
    work,
    requiresStartConvergence(status.snapshot, work)
      ? "runner_transport_unavailable"
      : "gateway_starting",
    observedAt,
  );
}

async function maybeRecoverManagedTransport(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  dependencies: AgentDeploymentReconcilerDependencies,
  context: DeploymentActionContext,
  now: Date,
): Promise<AgentDeploymentReconcileOutcome> {
  const reason = await readManagedRunnerRecoveryReason(connection, work, "endpoint_failure", now);
  if (!reason) {
    await terminallyFailDeployment(connection, work, {
      code: "runner_start_failed",
      now,
      cleanup: { dependencies, context },
    });
    return "failed";
  }
  if (reason === "endpoint_failure" && work.attemptCount < STAGE_RETRY_LIMITS.configuring_hermes) {
    return scheduleRetry(connection, work, "runner_transport_unavailable", now);
  }
  return beginManagedRunnerRecovery(connection, work, dependencies, context, { reason, now });
}

async function beginManagedRunnerRecovery(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  dependencies: AgentDeploymentReconcilerDependencies,
  context: DeploymentActionContext,
  input: { reason: RunnerReplacementReason; now: Date },
): Promise<AgentDeploymentReconcileOutcome> {
  const verifiedReason = await readManagedRunnerRecoveryReason(
    connection,
    work,
    input.reason,
    input.now,
  );
  if (!verifiedReason || !work.agentRunnerId) {
    await terminallyFailDeployment(connection, work, {
      code: "runner_start_failed",
      now: input.now,
      cleanup: { dependencies, context },
    });
    return "failed";
  }
  const sourceRunnerId = work.agentRunnerId;

  const prepared = await connection.db.transaction(async (tx) => {
    const [locked] = await tx.execute<{ id: string }>(sql`
      select ${agentDeployments.id} as id
      from ${agentDeployments}
      where ${agentDeployments.id} = ${work.id}
        and ${agentDeployments.stage} = ${work.stage}
        and ${agentDeployments.configRevision} = ${work.configRevision}
        and ${agentDeployments.leaseOwner} = ${work.leaseOwner}
        and ${agentDeployments.leaseExpiresAt} > ${input.now.toISOString()}
      for update
    `);
    if (!locked) return { kind: "stale" as const };

    const windowFloor = new Date(input.now.getTime() - REPLACEMENT_WINDOW_MS);
    const [history] = await tx.execute<{
      count: number;
      budgetExhausted: boolean;
    }>(sql`
      select
        count(*)::int as count,
        coalesce(bool_or(${runnerReplacements.terminalCode} = 'replacement_budget_exhausted'), false) as "budgetExhausted"
      from ${runnerReplacements}
      where ${runnerReplacements.triggerDeploymentId} = ${work.id}
        and ${runnerReplacements.startedAt} > ${windowFloor.toISOString()}
    `);
    if (history?.budgetExhausted || (history?.count ?? 0) >= MAX_REPLACEMENTS_PER_DEPLOYMENT) {
      const failed = await markDeploymentFailedInTransaction(tx, work, {
        code: "replacement_budget_exhausted",
        now: input.now,
        cleanupRequired: false,
      });
      return failed ? { kind: "failed" as const } : { kind: "stale" as const };
    }

    const [created, [paused]] = await Promise.all([
      createOrGetRunnerReplacement({
        db: tx,
        sourceRunnerId,
        triggerDeploymentId: work.id,
        reason: verifiedReason,
        operationKey: `bruno-replace-${(dependencies.randomUUID?.() ?? randomUUID()).replaceAll(
          "-",
          "",
        )}`,
        now: input.now,
      }),
      tx.execute<{ id: string }>(sql`
        update ${agentDeployments}
        set error_code = 'runner_recovery_in_progress',
            error_detail = 'Automatic runner recovery is preparing validated capacity.',
            next_attempt_at = null,
            lease_owner = null,
            lease_expires_at = null,
            updated_at = ${input.now.toISOString()}
        where ${agentDeployments.id} = ${work.id}
          and ${agentDeployments.stage} = ${work.stage}
          and ${agentDeployments.configRevision} = ${work.configRevision}
          and ${agentDeployments.leaseOwner} = ${work.leaseOwner}
          and ${agentDeployments.leaseExpiresAt} > ${input.now.toISOString()}
        returning id
      `),
    ]);
    if (!paused) throw new LostDeploymentLeaseError();
    await replaceDeploymentWakeupInTransaction(tx, {
      deploymentId: work.id,
      dueAt: null,
      now: input.now,
    });
    await tx.execute(sql`
      update ${runners}
      set status = 'degraded', updated_at = ${input.now.toISOString()}
      where ${runners.id} = ${sourceRunnerId}
        and ${runners.userId} = ${work.userId}
        and ${runners.kind} = ${DIGITALOCEAN_RUNNER_KIND}
        and ${runners.provider} = ${DIGITALOCEAN_PROVIDER}
        and ${runners.deletedAt} is null
    `);
    await recordAgentEventsInTransaction(tx, [
      {
        agentId: work.agentId,
        actorUserId: work.userId,
        type: "agent.runner_recovery_started",
        message: "Automatic runner recovery started.",
        metadata: {
          deploymentId: work.id,
          replacementId: created.replacement.id,
          reason: verifiedReason,
        },
        createdAt: input.now,
      },
    ]);
    return {
      kind: "recovering" as const,
      replacementId: created.replacement.id,
      captureDiagnostics: created.created && (history?.count ?? 0) === 0,
    };
  });

  if (prepared.kind === "failed") return "failed";
  if (prepared.kind === "stale") return "retry_scheduled";

  if (prepared.captureDiagnostics) {
    const runner = await getAssignedRunner(connection, work);
    if (runner) {
      const adapter = createRunnerAdapter(runner, dependencies, context);
      try {
        await adapter.streamLogs({ agentId: work.agentId, limit: 100 });
      } catch (error) {
        logAgentDeploymentError(
          "recovery_log_capture_failed",
          error,
          {
            agentId: work.agentId,
            deploymentId: work.id,
            runnerId: work.agentRunnerId,
            stage: work.stage,
          },
          "warn",
        );
      }
      try {
        await adapter.stop(work.agentId);
      } catch (error) {
        logAgentDeploymentError(
          "recovery_stop_failed",
          error,
          {
            agentId: work.agentId,
            deploymentId: work.id,
            runnerId: work.agentRunnerId,
            stage: work.stage,
          },
          "warn",
        );
      }
    }
  }

  (dependencies.triggerReplacement ?? scheduleRunnerReplacementReconcileAfterResponse)(
    prepared.replacementId,
  );
  return "recovering";
}

async function readManagedRunnerRecoveryReason(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  fallback: RunnerReplacementReason,
  now: Date,
): Promise<RunnerReplacementReason | null> {
  if (!work.agentRunnerId) return null;
  const [runner] = await connection.db
    .select({
      kind: runners.kind,
      provider: runners.provider,
      providerResourceId: runners.providerResourceId,
      provisioningStatus: runners.provisioningStatus,
      compatibilityState: runners.compatibilityState,
      status: runners.status,
      endpointUrl: runners.endpointUrl,
    })
    .from(runners)
    .where(
      sql`${runners.id} = ${work.agentRunnerId} and ${runners.userId} = ${work.userId} and ${runners.deletedAt} is null`,
    )
    .limit(1);
  if (
    !runner ||
    runner.kind !== DIGITALOCEAN_RUNNER_KIND ||
    runner.provider !== DIGITALOCEAN_PROVIDER
  ) {
    return null;
  }
  if (!runner.providerResourceId) return "provider_resource_missing";
  if (runner.provisioningStatus === "failed") return "boot_failure";
  if (runner.compatibilityState !== "compatible") return "release_mismatch";
  if (fallback === "gateway_deadline") return fallback;
  const [heartbeat] = await connection.db
    .select({ status: runnerHeartbeats.status, observedAt: runnerHeartbeats.observedAt })
    .from(runnerHeartbeats)
    .where(sql`${runnerHeartbeats.runnerId} = ${work.agentRunnerId}`)
    .orderBy(sql`${runnerHeartbeats.observedAt} desc, ${runnerHeartbeats.createdAt} desc`)
    .limit(1);
  const heartbeatAt = toDate(heartbeat?.observedAt ?? null);
  if (
    ["offline", "degraded"].includes(runner.status) ||
    heartbeat?.status !== "online" ||
    !heartbeatAt ||
    now.getTime() - heartbeatAt.getTime() >= RUNNER_HEARTBEAT_STALE_THRESHOLD_MS
  ) {
    return "stale_heartbeat";
  }
  if (!runner.endpointUrl) return "endpoint_failure";
  return fallback;
}

async function reconcileVerifyingModel(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  dependencies: AgentDeploymentReconcilerDependencies,
  now: () => Date,
  context: DeploymentActionContext,
): Promise<AgentDeploymentReconcileOutcome> {
  if (!modelCanaryEnabled(dependencies)) {
    return (await markCanarySkippedAndStage(connection, work, now()))
      ? "advanced"
      : "retry_scheduled";
  }

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
    return maybeRecoverManagedTransport(connection, work, dependencies, context, now());
  }

  const status = await createRunnerAdapter(runner, dependencies, context).status(work.agentId);

  if (!status.ok || !("snapshot" in status)) {
    return maybeRecoverManagedTransport(connection, work, dependencies, context, now());
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

  return (await finalizeReady(connection, work, now(), dependencies)) ? "ready" : "retry_scheduled";
}

async function releaseClaimAfterDeadline(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  now: Date,
): Promise<void> {
  await connection.db.transaction(async (tx) => {
    const [updated] = await tx.execute<{ id: string }>(sql`
      update ${agentDeployments}
      set lease_owner = null,
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
      returning id
    `);

    if (updated) {
      await replaceDeploymentWakeupInTransaction(tx, {
        deploymentId: work.id,
        dueAt: now,
        now,
      });
    }
  });
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
        and ${agentDeployments.safetyQuarantinedAt} is null
        and ${agents.deletedAt} is null
        and ${agents.desiredStatus} = 'running'
        and (${agentDeployments.nextAttemptAt} is null or ${agentDeployments.nextAttemptAt} <= ${nowIso})
        and (${agentDeployments.leaseExpiresAt} is null or ${agentDeployments.leaseExpiresAt} <= ${nowIso})
        and not exists (
          select 1 from ${runnerReplacements}
          where ${runnerReplacements.triggerDeploymentId} = ${agentDeployments.id}
            and ${runnerReplacements.state} not in ('complete', 'failed')
        )
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
      ${agentDeployments.deploymentChoices} as "deploymentChoices",
      ${agents.runnerId} as "agentRunnerId"
  `);

  if (!row) return null;
  const deploymentChoices = parseAgentDeploymentChoices(row.deploymentChoices);
  if (deploymentChoices) return { ...row, deploymentChoices };

  await quarantineAgentDeploymentForSafety({
    db: tx,
    userId: row.userId,
    deploymentId: row.id,
    reason: "Invalid recorded deployment choices",
    now: input.now,
  });
  return null;
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
): Promise<
  { ok: true; state: "created" | "waiting" } | { ok: false; code: DeploymentTerminalErrorCode }
> {
  const config = recoverDeploymentProviderConfig(work, dependencies);

  if (!config) {
    return { ok: false, code: "runner_provisioning_unavailable" };
  }

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`automatic-runner-provisioning:${work.userId}`}))`,
  );
  const [blockingRunner] = await tx.execute<{ id: string }>(sql`
    select ${runners.id} as id
    from ${runners}
    where ${runners.userId} = ${work.userId}
      and ${runners.kind} = ${DIGITALOCEAN_RUNNER_KIND}
      and ${runners.provider} = ${DIGITALOCEAN_PROVIDER}
      and ${runners.deletedAt} is null
      and (
        ${runners.provisioningStatus} in (
          'pending',
          'creating',
          'tagging',
          'firewall_configuring',
          'bootstrapping',
          'waiting_for_runner',
          'cleaning_up'
        )
        or (
          ${runners.provisioningStatus} = 'failed'
          and ${runners.providerResourceId} is not null
        )
      )
    order by ${runners.createdAt}, ${runners.id}
    limit 1
    for update
  `);

  if (blockingRunner) {
    return { ok: true, state: "waiting" };
  }

  const operationKey = provisioningOperationKeyForDeployment(work.id);
  const [runner] = await tx
    .insert(runners)
    .values({
      userId: work.userId,
      name: "Bruno Deployment Runner",
      kind: DIGITALOCEAN_RUNNER_KIND,
      status: "provisioning",
      provider: DIGITALOCEAN_PROVIDER,
      region: config.region,
      sizeSlug: config.sizeSlug,
      image: config.image,
      requiredRunnerImageDigest: requiredRunnerImageDigestForProvider(config),
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

  return { ok: true, state: "created" };
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
        attempt_count = 0,
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

  await replaceDeploymentWakeupInTransaction(tx, {
    deploymentId: work.id,
    dueAt: input.now,
    now: input.now,
  });

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
        attempt_count = 0,
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

  await replaceDeploymentWakeupInTransaction(tx, {
    deploymentId: work.id,
    dueAt: input.now,
    now: input.now,
  });

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
  if (work.attemptCount >= STAGE_RETRY_LIMITS[work.stage]) {
    await terminallyFailDeployment(connection, work, {
      code: terminalCodeForRetryExhaustion(work.stage),
      now,
    });
    return "failed";
  }

  const detail = RETRYABLE_DETAILS[reason];
  const backoffMs = computeDeploymentBackoffMs(work.attemptCount);
  const proposedAttemptAt = new Date(now.getTime() + backoffMs);
  const gatewayAcceptedAt =
    work.stage === "starting_gateway" ? toDate(work.runnerAcceptedAt) : null;
  const nextAttemptAt = gatewayAcceptedAt
    ? new Date(
        Math.min(
          proposedAttemptAt.getTime(),
          gatewayAcceptedAt.getTime() + GATEWAY_START_DEADLINE_MS,
        ),
      )
    : proposedAttemptAt;

  await connection.db.transaction(async (tx) => {
    const [updated] = await tx.execute<{ id: string }>(sql`
      update ${agentDeployments}
      set error_code = ${reason},
          error_detail = ${detail},
          next_attempt_at = ${nextAttemptAt.toISOString()},
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
      returning id
    `);

    if (updated) {
      await replaceDeploymentWakeupInTransaction(tx, {
        deploymentId: work.id,
        dueAt: nextAttemptAt,
        now,
        safeErrorCode: reason,
      });
    }
  });
  logAgentDeployment(
    "retry_scheduled",
    {
      agentId: work.agentId,
      deploymentId: work.id,
      runnerId: work.agentRunnerId,
      stage: work.stage,
      attemptCount: work.attemptCount,
      reason,
      backoffMs,
      nextAttemptAt,
    },
    "warn",
  );
  return "retry_scheduled";
}

async function scheduleImmediateRetry(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  reason: keyof typeof RETRYABLE_DETAILS,
  now: Date,
): Promise<"failed" | "retry_scheduled"> {
  if (work.attemptCount >= STAGE_RETRY_LIMITS[work.stage]) {
    await terminallyFailDeployment(connection, work, {
      code: terminalCodeForRetryExhaustion(work.stage),
      now,
    });
    return "failed";
  }

  const detail = RETRYABLE_DETAILS[reason];

  await connection.db.transaction(async (tx) => {
    const [updated] = await tx.execute<{ id: string }>(sql`
      update ${agentDeployments}
      set error_code = ${reason},
          error_detail = ${detail},
          next_attempt_at = ${now.toISOString()},
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
      returning id
    `);

    if (updated) {
      await replaceDeploymentWakeupInTransaction(tx, {
        deploymentId: work.id,
        dueAt: now,
        now,
        safeErrorCode: reason,
      });
    }
  });

  logAgentDeployment(
    "retry_scheduled",
    {
      agentId: work.agentId,
      deploymentId: work.id,
      runnerId: work.agentRunnerId,
      stage: work.stage,
      attemptCount: work.attemptCount,
      reason,
      backoffMs: 0,
      nextAttemptAt: now,
    },
    "warn",
  );
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
        attempt_count = 0,
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

  await replaceDeploymentWakeupInTransaction(tx, {
    deploymentId: work.id,
    dueAt: input.now,
    now: input.now,
  });

  await writeDeploymentEvents(tx, work, {
    events: ["agent.deployment_stage_changed"],
    fromStage: work.stage,
    toStage: input.nextStage,
    now: input.now,
  });
  return true;
}

async function markCanarySkippedAndStage(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  now: Date,
): Promise<boolean> {
  return connection.db.transaction(async (tx) => {
    const [updated] = await tx.execute<{ id: string }>(sql`
      update ${agentDeployments}
      set stage = 'connecting_telegram',
          attempt_count = 0,
          canary_state = 'skipped',
          canary_attempted_at = null,
          canary_completed_at = null,
          error_code = null,
          error_detail = null,
          next_attempt_at = null,
          lease_owner = null,
          lease_expires_at = null,
          updated_at = ${now.toISOString()}
      where id = ${work.id}
        and stage = ${work.stage}
        and stage in ('starting_gateway', 'verifying_model')
        and lease_owner = ${work.leaseOwner}
        and lease_expires_at > ${now.toISOString()}
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

    await replaceDeploymentWakeupInTransaction(tx, {
      deploymentId: work.id,
      dueAt: now,
      now,
    });

    await writeDeploymentEvents(tx, work, {
      events: ["agent.deployment_stage_changed"],
      fromStage: work.stage,
      toStage: "connecting_telegram",
      now,
    });
    return true;
  });
}

async function finalizeReady(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  now: Date,
  dependencies: AgentDeploymentReconcilerDependencies,
): Promise<boolean> {
  const finalized = await connection.db.transaction(async (tx) => {
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
        and canary_state in ('passed', 'skipped')
        and runner_operation_id = ${work.runnerOperationId}
        and config_revision = ${work.configRevision}
        and lease_owner = ${work.leaseOwner}
        and lease_expires_at > ${now.toISOString()}
      returning id
    `);

    if (!updated) {
      return false;
    }

    await replaceDeploymentWakeupInTransaction(tx, {
      deploymentId: work.id,
      dueAt: null,
      now,
    });

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

    if (!work.runnerOperationId) {
      throw new LostDeploymentLeaseError();
    }

    await initializeAgentRuntimeAfterDeploymentReady({
      db: tx,
      deploymentId: work.id,
      agentId: work.agentId,
      userId: work.userId,
      configRevision: work.configRevision,
      operationId: work.runnerOperationId,
      now,
    });

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

  if (finalized) {
    (dependencies.scheduleRuntimeAfterReady ?? scheduleAgentRuntimeReconcileAfterResponse)(
      work.agentId,
    );
    await logAgentDeploymentTerminalCompletion(connection, work.id).catch((error: unknown) => {
      logAgentDeployment(
        "terminal_completion_log_failed",
        {
          deploymentId: work.id,
          runnerId: work.agentRunnerId,
          error: serializeLogError(error),
        },
        "warn",
      );
    });
  }

  return finalized;
}

function modelCanaryEnabled(dependencies: AgentDeploymentReconcilerDependencies): boolean {
  return dependencies.modelCanaryEnabled ?? process.env.NODE_ENV !== "production";
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
      } catch (error) {
        logAgentDeploymentError(
          "failure_log_capture_failed",
          error,
          {
            agentId: work.agentId,
            deploymentId: work.id,
            runnerId: work.agentRunnerId,
            stage: work.stage,
          },
          "warn",
        );
      }

      try {
        const stopped = await adapter.stop(work.agentId);
        cleanupRequired = !stopped.ok;
      } catch (error) {
        logAgentDeploymentError(
          "failure_cleanup_stop_failed",
          error,
          {
            agentId: work.agentId,
            deploymentId: work.id,
            runnerId: work.agentRunnerId,
            stage: work.stage,
          },
          "warn",
        );
        cleanupRequired = true;
      }
    }
  }

  const failed = await connection.db.transaction((tx) =>
    markDeploymentFailedInTransaction(tx, work, {
      code: input.code,
      now: input.now,
      cleanupRequired,
    }),
  );

  logAgentDeployment(
    "terminal_failure_recorded",
    {
      agentId: work.agentId,
      deploymentId: work.id,
      runnerId: work.agentRunnerId,
      stage: work.stage,
      attemptCount: work.attemptCount,
      errorCode: input.code,
      cleanupRequired,
      persisted: failed,
    },
    "error",
  );
  return failed;
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

  await replaceDeploymentWakeupInTransaction(tx, {
    deploymentId: work.id,
    dueAt: null,
    now: input.now,
  });

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

  if (!config) {
    return null;
  }

  if (
    (config.modelProvider === "openrouter" && getApprovedOpenRouterModel(config.modelName)) ||
    getAssistantProfileForManagedModel(config.modelProvider, config.modelName)
  ) {
    return config.modelName;
  }

  return null;
}

function createRunnerAdapter(
  runner: ManualRunnerRecord,
  dependencies: AgentDeploymentReconcilerDependencies,
  context: DeploymentActionContext,
): ReconcilerRunnerAdapter {
  assertDeploymentActionActive(context);
  const timeoutMs = Math.max(1, context.remainingMs());

  return (
    dependencies.manualRunnerAdapter?.(runner, { signal: context.signal, timeoutMs }) ??
    new ManualRunnerAdapter(runner, { signal: context.signal, timeoutMs })
  );
}

function assertDeploymentActionActive(context: DeploymentActionContext): void {
  if (context.signal.aborted || context.remainingMs() <= 0) {
    throw new DeploymentActionDeadlineExceededError();
  }
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
  return `bruno-deploy-${deploymentId.replaceAll("-", "").toLowerCase()}`;
}

async function defaultProvisioner(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  currentNow: Date,
  context: DeploymentActionContext,
  dependencies: AgentDeploymentReconcilerDependencies,
): Promise<ProvisionerResult> {
  const config = recoverDeploymentProviderConfig(work, dependencies);

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
    maxAttempts: STAGE_RETRY_LIMITS.provisioning_runner,
    config,
    provider,
    context,
    now: () => currentNow,
    canContinue: () => deploymentProvisioningAuthorityStillHeld(connection, work, currentNow),
  });
}

function recoverDeploymentProviderConfig(
  work: ClaimedDeploymentWork,
  dependencies: AgentDeploymentReconcilerDependencies,
): DigitalOceanProviderConfig | null {
  const choices = parseAgentDeploymentChoices(work.deploymentChoices);
  if (!choices) return null;

  try {
    const injectedConfig = dependencies.readDigitalOceanConfig?.();
    if (injectedConfig) return applyAgentDeploymentChoices(injectedConfig, choices);
    const credentials = readDigitalOceanProviderCredentials();
    return credentials ? recoverAgentDeploymentProviderConfig(credentials, choices) : null;
  } catch {
    return null;
  }
}

async function deploymentProvisioningAuthorityStillHeld(
  connection: DatabaseConnection,
  work: ClaimedDeploymentWork,
  now: Date,
): Promise<boolean> {
  const [held] = await connection.db.execute<{ id: string }>(sql`
    select ${agentDeployments.id} as id
    from ${agentDeployments}
    inner join ${agents} on ${agents.id} = ${agentDeployments.agentId}
    where ${agentDeployments.id} = ${work.id}
      and ${agentDeployments.stage} = 'provisioning_runner'
      and ${agentDeployments.configRevision} = ${work.configRevision}
      and ${agentDeployments.leaseOwner} = ${work.leaseOwner}
      and ${agentDeployments.leaseExpiresAt} > ${now.toISOString()}
      and ${agentDeployments.safetyQuarantinedAt} is null
      and ${agents.id} = ${work.agentId}
      and ${agents.userId} = ${work.userId}
      and ${agents.deletedAt} is null
      and ${agents.desiredStatus} = 'running'
    limit 1
  `);

  return Boolean(held);
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

function logAgentDeployment(
  event: string,
  metadata: Record<string, unknown>,
  level: "debug" | "info" | "warn" | "error" = "info",
): void {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  if (level === "error") {
    agentDeploymentLogger.errorEvent(event, metadata);
    return;
  }

  agentDeploymentLogger[level](event, metadata);
}

function logAgentDeploymentError(
  event: string,
  error: unknown,
  metadata: Record<string, unknown>,
  level: "warn" | "error" = "error",
): void {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  if (level === "warn") {
    agentDeploymentLogger.warn(event, { ...metadata, error: serializeLogError(error) });
    return;
  }

  agentDeploymentLogger.error(event, error, metadata);
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
      replacement_budget_exhausted: "Automatic runner recovery reached its safe limit.",
      telegram_connection_failed: "Telegram connection could not be confirmed.",
    } satisfies Record<DeploymentTerminalErrorCode, string>
  )[code];
  const normalized = normalizeDeploymentErrorDetail(detail);

  if (!validateDeploymentErrorCode(code) || !normalized.ok || !normalized.value) {
    return "Automatic deployment failed safely.";
  }

  return normalized.value;
}

function terminalCodeForRetryExhaustion(stage: AgentDeploymentStage): DeploymentTerminalErrorCode {
  if (stage === "provisioning_runner" || stage === "pending") {
    return "runner_provisioning_outcome_unknown";
  }
  if (stage === "verifying_model") return "model_canary_outcome_unknown";
  if (stage === "connecting_telegram") return "telegram_connection_failed";
  return "deployment_attempts_exhausted";
}

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
