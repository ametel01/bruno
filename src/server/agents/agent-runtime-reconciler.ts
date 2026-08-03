import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { DEFAULT_HERMES_WORKLOAD_IMAGE } from "@/src/runner-service/constants";
import type { RunnerDurableStatusSnapshot } from "@/src/runner-service/runner-contracts";
import { MANAGED_AGENT_LAUNCH_SPEC_VERSION } from "@/src/server/agents/agent-launch-spec";
import {
  buildHermesAgentLaunchSpecForUser,
  type AgentLaunchSpecBuildResult,
} from "@/src/server/agents/agent-launch-builder";
import {
  type AgentRuntimeErrorCode,
  type RuntimeObservation,
  type RuntimeObservationDecision,
  type RuntimePolicyState,
  applyRuntimeObservation,
  applyRuntimeStartResult,
  applyRuntimeStopResult,
  planRuntimeEffect,
  requestRuntimeCircuitCleanup,
} from "@/src/server/agents/agent-runtime-state";
import {
  type AgentRuntimeClaimTarget,
  type ClaimedAgentRuntimeReconciliation,
  type RuntimeResultMutation,
  applyClaimedAgentRuntimeResult,
  claimNextAgentRuntimeReconciliation,
} from "@/src/server/agents/agent-runtime-store";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentEvents,
  agents,
  agentUsagePeriods,
  runnerHeartbeats,
  runners,
} from "@/src/server/db/schema";
import { recordAgentEventInTransaction } from "@/src/server/events/agent-events";
import {
  ManualRunnerAdapter,
  type ManualRunnerStartResult,
  type ManualRunnerStatusResult,
  type ManualRunnerStopResult,
} from "@/src/server/runners/manual-runner-adapter";
import type { ManualRunnerRecord } from "@/src/server/runners/manual-runner-persistence";
import { RUNNER_HEARTBEAT_STALE_THRESHOLD_MS } from "@/src/server/runners/runner-heartbeat";
import {
  hasAvailableRunnerCapacity,
  normalizeRunnerCapacitySnapshot,
} from "@/src/server/runners/runner-placement";
import {
  diagnoseTelegramWebhook,
  type TelegramWebhookDiagnosticResult,
} from "@/src/server/telegram/telegram-client";

export const AGENT_RUNTIME_RECONCILE_ACTION_DEADLINE_MS = 45_000;

const HEALTHY_REASON = "Hermes gateway is ready.";
const RECOVERING_REASON = "The managed gateway is recovering.";
const STOPPING_REASON = "The managed gateway is stopping.";
const UNAVAILABLE_REASON = "The managed gateway is unavailable.";

export type AgentRuntimeReconcileOutcome =
  | "idle"
  | "observed"
  | "recovering"
  | "stopped"
  | "circuit_open";

export type AgentRuntimeReconcileResult = {
  processed: 0 | 1;
  outcome: AgentRuntimeReconcileOutcome;
};

export type RuntimeActionContext = {
  deadlineAt: Date;
  signal: AbortSignal;
  remainingMs: () => number;
};

export type RuntimeRunnerAdapter = {
  start(
    agentId: string,
    launchSpec: Parameters<ManualRunnerAdapter["start"]>[1],
  ): Promise<ManualRunnerStartResult>;
  status(agentId: string): Promise<ManualRunnerStatusResult>;
  stop(agentId: string): Promise<ManualRunnerStopResult>;
};

export type RuntimeLoadedContext = {
  agentStatus: "idle" | "starting" | "running" | "stopped" | "restarting" | "error" | "deleting";
  runner: ManualRunnerRecord | null;
  runnerAvailability: "eligible" | "unavailable" | "capacity_blocked";
};

type RuntimeLaunchSpecBuilder = (
  userId: string,
  agentId: string,
  dependencies?: { createConnection?: () => DatabaseConnection; trustedConfigRevision?: string },
) => Promise<AgentLaunchSpecBuildResult>;

export type AgentRuntimeReconcilerDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  randomUUID?: () => string;
  loadContext?: (
    connection: DatabaseConnection,
    claim: ClaimedAgentRuntimeReconciliation,
    now: Date,
  ) => Promise<RuntimeLoadedContext>;
  launchSpec?: RuntimeLaunchSpecBuilder;
  manualRunnerAdapter?: (
    runner: ManualRunnerRecord,
    options: { signal: AbortSignal; timeoutMs: number },
  ) => RuntimeRunnerAdapter;
  telegramWebhookDiagnostic?: (
    token: string,
    context: RuntimeActionContext,
  ) => Promise<TelegramWebhookDiagnosticResult>;
  claimRuntime?: (input: {
    connection: DatabaseConnection;
    target: AgentRuntimeClaimTarget;
    leaseOwner: string;
    now: Date;
  }) => Promise<ClaimedAgentRuntimeReconciliation | null>;
  persistTransition?: (
    connection: DatabaseConnection,
    claim: ClaimedAgentRuntimeReconciliation,
    transition: RuntimeTransition,
    now: Date,
  ) => Promise<boolean>;
};

export type RuntimeTransition = {
  mutation: RuntimeResultMutation;
  outcome: Exclude<AgentRuntimeReconcileOutcome, "idle">;
  agentStatus?: RuntimeLoadedContext["agentStatus"];
  statusReason?: string;
  closeUsage?: boolean;
  openUsage?: boolean;
  event?: RuntimeEvent;
};

type RuntimeEvent = {
  type:
    | "agent.runtime_recovery_requested"
    | "agent.runtime_recovered"
    | "agent.runtime_circuit_opened";
  fromStatus: RuntimeLoadedContext["agentStatus"];
  toStatus: RuntimeLoadedContext["agentStatus"];
  reasonCode: AgentRuntimeErrorCode;
  recoveryCount: number;
  cleanupRequired: boolean;
  telegramRequired: boolean;
};

export async function reconcileNextAgentRuntime(
  dependencies: AgentRuntimeReconcilerDependencies = {},
): Promise<AgentRuntimeReconcileResult> {
  return reconcileOne({ kind: "global" }, dependencies);
}

export async function reconcileTargetAgentRuntime(
  agentId: string,
  dependencies: AgentRuntimeReconcilerDependencies = {},
): Promise<AgentRuntimeReconcileResult> {
  return reconcileOne({ kind: "agent", agentId }, dependencies);
}

export async function reconcileTargetRunnerRuntime(
  runnerId: string,
  dependencies: AgentRuntimeReconcilerDependencies = {},
): Promise<AgentRuntimeReconcileResult> {
  return reconcileOne({ kind: "runner", runnerId }, dependencies);
}

async function reconcileOne(
  target: AgentRuntimeClaimTarget,
  dependencies: AgentRuntimeReconcilerDependencies,
): Promise<AgentRuntimeReconcileResult> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const leaseOwner = `reconcile:${(dependencies.randomUUID ?? randomUUID)()}`;

  try {
    const claim = dependencies.claimRuntime
      ? await dependencies.claimRuntime({ connection, target, leaseOwner, now: now() })
      : await connection.db.transaction((tx) =>
          claimNextAgentRuntimeReconciliation({ db: tx, target, leaseOwner, now: now() }),
        );

    if (!claim) {
      return { processed: 0, outcome: "idle" };
    }

    const actionStartedAt = now();
    const context =
      (await dependencies.loadContext?.(connection, claim, actionStartedAt)) ??
      (await loadRuntimeContext(connection, claim, actionStartedAt));
    const action = createRuntimeActionContext(now, actionStartedAt);

    try {
      const transition = await runClaimedRuntime(
        connection,
        claim,
        context,
        action,
        dependencies,
        now,
      );
      await (dependencies.persistTransition ?? persistRuntimeTransition)(
        connection,
        claim,
        transition,
        now(),
      );
      return { processed: 1, outcome: transition.outcome };
    } finally {
      action.dispose();
    }
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

function createRuntimeActionContext(
  now: () => Date,
  startedAt: Date,
): RuntimeActionContext & {
  dispose: () => void;
} {
  const deadlineAt = new Date(startedAt.getTime() + AGENT_RUNTIME_RECONCILE_ACTION_DEADLINE_MS);
  const controller = new AbortController();
  const remainingAtCreation = Math.max(0, deadlineAt.getTime() - now().getTime());
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Runtime action deadline exceeded.", "TimeoutError")),
    remainingAtCreation,
  );

  return {
    deadlineAt,
    signal: controller.signal,
    remainingMs: () =>
      Math.max(
        0,
        Math.min(
          AGENT_RUNTIME_RECONCILE_ACTION_DEADLINE_MS,
          deadlineAt.getTime() - now().getTime(),
        ),
      ),
    dispose: () => clearTimeout(timeout),
  };
}

async function runClaimedRuntime(
  connection: DatabaseConnection,
  claim: ClaimedAgentRuntimeReconciliation,
  context: RuntimeLoadedContext,
  action: RuntimeActionContext,
  dependencies: AgentRuntimeReconcilerDependencies,
  now: () => Date,
): Promise<RuntimeTransition> {
  const policy = policyFromClaim(claim);
  const plan = planRuntimeEffect({
    policy,
    nowMs: now().getTime(),
    desiredStatus: claim.desiredStatus,
    deleted: false,
    latestDeployment: "ready",
    runner: context.runnerAvailability,
    secrets: "available",
  });

  // A desired-stop observation must durably fence the old generation before
  // any runner request. The next due claim performs the idempotent Stop.
  if (plan.policy.generation !== claim.generation) {
    return transitionFromPlannedNoEffect(claim, context, plan.policy, now().getTime());
  }

  if (plan.effect === "none") {
    return transitionFromPlannedNoEffect(claim, context, plan.policy, plan.nextAttemptAtMs);
  }

  if (!context.runner || action.remainingMs() <= 0) {
    const unavailable = applyRuntimeObservation({
      policy: plan.policy,
      observation: { kind: "runner_unavailable", heartbeatStale: true },
      nowMs: now().getTime(),
    });
    return transitionFromObservation(claim, context, unavailable, now(), false);
  }

  const adapter = (dependencies.manualRunnerAdapter ?? createRuntimeRunnerAdapter)(context.runner, {
    signal: action.signal,
    timeoutMs: action.remainingMs(),
  });

  if (plan.effect === "observe") {
    return observeRuntime(claim, context, adapter, now);
  }

  if (plan.effect === "stop") {
    if (
      claim.desiredStatus === "running" &&
      plan.policy.state === "recovering_stop" &&
      plan.policy.telegramNonConnectedSinceMs !== null
    ) {
      return diagnoseTelegramBeforeRecovery(
        connection,
        claim,
        context,
        plan.policy,
        action,
        dependencies,
        now,
      );
    }
    return stopRuntime(claim, adapter, plan.policy, now);
  }

  return startRuntime(connection, claim, context, adapter, plan.policy, dependencies, now);
}

async function observeRuntime(
  claim: ClaimedAgentRuntimeReconciliation,
  context: RuntimeLoadedContext,
  adapter: RuntimeRunnerAdapter,
  now: () => Date,
): Promise<RuntimeTransition> {
  let result: ManualRunnerStatusResult;
  try {
    result = await adapter.status(claim.agentId);
  } catch {
    result = { ok: false, reason: "runner_request_failed" };
  }

  const observedAt = now();
  const observation =
    result.ok && "snapshot" in result
      ? mapRunnerSnapshotToRuntimeObservation(result.snapshot, claim)
      : !result.ok && result.reason === "runner_request_failed"
        ? ({ kind: "runner_unavailable", heartbeatStale: false } as const)
        : ({ kind: "unknown" } as const);
  if (observation.kind === "unknown" && claim.attemptCount >= 5) {
    return transitionFromObservation(
      claim,
      context,
      requestRuntimeCircuitCleanup({
        policy: policyFromClaim(claim),
        nowMs: observedAt.getTime(),
        errorCode: "runtime_internal_failure",
      }),
      observedAt,
      false,
    );
  }
  const decision = applyRuntimeObservation({
    policy: policyFromClaim(claim),
    observation,
    nowMs: observedAt.getTime(),
  });
  const adoptedOperationId =
    observation.kind === "exact_ready" &&
    claim.operationId === null &&
    result.ok &&
    "snapshot" in result
      ? result.snapshot.operation?.id
      : undefined;
  return transitionFromObservation(
    claim,
    context,
    decision,
    observedAt,
    observation.kind === "exact_ready",
    adoptedOperationId,
  );
}

async function stopRuntime(
  claim: ClaimedAgentRuntimeReconciliation,
  adapter: RuntimeRunnerAdapter,
  policy: RuntimePolicyState,
  now: () => Date,
): Promise<RuntimeTransition> {
  let result: ManualRunnerStopResult;
  try {
    result = await adapter.stop(claim.agentId);
  } catch {
    result = { ok: false, reason: "runner_request_failed" };
  }

  const observedAt = now();
  const confirmed =
    result.ok && result.containers.every((container) => !isActiveContainer(container.status));
  const decision = applyRuntimeStopResult({
    policy,
    nowMs: observedAt.getTime(),
    desiredStatus: claim.desiredStatus,
    result: confirmed ? "confirmed" : "unconfirmed",
  });
  const mutation = mutationFromPolicy(decision.policy, decision.nextAttemptAtMs, {
    ...(confirmed ? { attemptCount: 0, lastObservedAt: observedAt } : {}),
  });

  if (decision.policy.state === "stopped") {
    return {
      mutation,
      outcome: "stopped",
      agentStatus: "stopped",
      statusReason: "Stopped by owner request.",
      closeUsage: true,
    };
  }

  if (decision.policy.state === "circuit_open") {
    return {
      mutation,
      outcome: "circuit_open",
      agentStatus: "error",
      statusReason: UNAVAILABLE_REASON,
      closeUsage: true,
    };
  }

  return {
    mutation,
    outcome: "recovering",
    agentStatus: "restarting",
    statusReason: claim.desiredStatus === "stopped" ? STOPPING_REASON : RECOVERING_REASON,
    closeUsage: decision.closeUsage,
  };
}

async function startRuntime(
  connection: DatabaseConnection,
  claim: ClaimedAgentRuntimeReconciliation,
  context: RuntimeLoadedContext,
  adapter: RuntimeRunnerAdapter,
  policy: RuntimePolicyState,
  dependencies: AgentRuntimeReconcilerDependencies,
  now: () => Date,
): Promise<RuntimeTransition> {
  const launch = await (dependencies.launchSpec ?? buildHermesAgentLaunchSpecForUser)(
    claim.userId,
    claim.agentId,
    { createConnection: () => connection, trustedConfigRevision: claim.configRevision },
  );

  if (
    !launch.ok ||
    launch.spec.version !== MANAGED_AGENT_LAUNCH_SPEC_VERSION ||
    launch.spec.agent.configRevision !== claim.configRevision
  ) {
    const errorCode =
      !launch.ok && isSecretLaunchFailure(launch.reason)
        ? "runtime_secret_unavailable"
        : "runtime_internal_failure";
    const circuit = requestRuntimeCircuitCleanup({
      policy,
      nowMs: now().getTime(),
      errorCode,
    });
    return transitionFromObservation(claim, context, circuit, now(), false);
  }

  let result: ManualRunnerStartResult;
  try {
    result = await adapter.start(claim.agentId, launch.spec);
  } catch {
    result = { ok: false, reason: "runner_request_failed" };
  }

  const completedAt = now();
  const acceptedResult =
    result.ok &&
    "state" in result &&
    result.state === "accepted" &&
    result.operation.action === "start" &&
    result.operation.target.image === launch.spec.image.ref &&
    result.operation.target.launchSpecVersion === MANAGED_AGENT_LAUNCH_SPEC_VERSION &&
    result.operation.target.configRevision === claim.configRevision
      ? result
      : null;
  const compatibleReady =
    result.ok &&
    "state" in result &&
    result.state === "ready" &&
    result.container?.status === "running" &&
    result.target?.image === launch.spec.image.ref &&
    result.target?.launchSpecVersion === MANAGED_AGENT_LAUNCH_SPEC_VERSION &&
    result.target.configRevision === claim.configRevision;

  if (compatibleReady) {
    return {
      mutation: mutationFromPolicy(
        { ...policy, state: "observing", errorCode: null },
        completedAt.getTime(),
        {
          attemptCount: 0,
          ...(claim.operationId ? { operationId: claim.operationId } : {}),
        },
      ),
      outcome: "recovering",
      agentStatus: "restarting",
      statusReason: RECOVERING_REASON,
      closeUsage: true,
    };
  }
  if (!acceptedResult && claim.attemptCount >= 5) {
    const circuit = requestRuntimeCircuitCleanup({
      policy,
      nowMs: completedAt.getTime(),
      errorCode: "runtime_recovery_exhausted",
    });
    return transitionFromObservation(claim, context, circuit, completedAt, false);
  }
  const decision = applyRuntimeStartResult({
    policy,
    nowMs: completedAt.getTime(),
    result: acceptedResult ? "accepted" : "transient_failure",
  });
  return transitionFromStartDecision(
    claim,
    context,
    decision.policy,
    decision.nextAttemptAtMs,
    acceptedResult?.operation.id,
  );
}

async function diagnoseTelegramBeforeRecovery(
  connection: DatabaseConnection,
  claim: ClaimedAgentRuntimeReconciliation,
  context: RuntimeLoadedContext,
  policy: RuntimePolicyState,
  action: RuntimeActionContext,
  dependencies: AgentRuntimeReconcilerDependencies,
  now: () => Date,
): Promise<RuntimeTransition> {
  const launch = await (dependencies.launchSpec ?? buildHermesAgentLaunchSpecForUser)(
    claim.userId,
    claim.agentId,
    { createConnection: () => connection, trustedConfigRevision: claim.configRevision },
  );
  if (
    !launch.ok ||
    launch.spec.version !== MANAGED_AGENT_LAUNCH_SPEC_VERSION ||
    launch.spec.agent.configRevision !== claim.configRevision
  ) {
    const circuit = requestRuntimeCircuitCleanup({
      policy,
      nowMs: now().getTime(),
      errorCode:
        !launch.ok && isSecretLaunchFailure(launch.reason)
          ? "runtime_secret_unavailable"
          : "runtime_internal_failure",
    });
    return transitionFromObservation(claim, context, circuit, now(), false);
  }

  let diagnostic: TelegramWebhookDiagnosticResult;
  try {
    diagnostic = await (dependencies.telegramWebhookDiagnostic ?? defaultTelegramWebhookDiagnostic)(
      launch.spec.secrets.telegramBotToken,
      action,
    );
  } catch {
    diagnostic = "uncertain";
  }

  const completedAt = now();
  if (diagnostic === "nonempty") {
    const circuit = requestRuntimeCircuitCleanup({
      policy,
      nowMs: completedAt.getTime(),
      errorCode: "telegram_webhook_conflict",
    });
    return transitionFromObservation(claim, context, circuit, completedAt, false);
  }

  if (diagnostic === "uncertain") {
    if (claim.attemptCount >= 5) {
      const circuit = requestRuntimeCircuitCleanup({
        policy,
        nowMs: completedAt.getTime(),
        errorCode: "telegram_polling_conflict_or_unavailable",
      });
      return transitionFromObservation(claim, context, circuit, completedAt, false);
    }
    return {
      mutation: mutationFromPolicy(
        policy,
        completedAt.getTime() + runtimeRetryDelay(claim.attemptCount),
      ),
      outcome: "recovering",
      agentStatus: "restarting",
      statusReason: RECOVERING_REASON,
      closeUsage: true,
    };
  }

  return {
    mutation: mutationFromPolicy(
      { ...policy, telegramNonConnectedSinceMs: null },
      completedAt.getTime(),
      { attemptCount: 0 },
    ),
    outcome: "recovering",
    agentStatus: "restarting",
    statusReason: RECOVERING_REASON,
    closeUsage: true,
  };
}

function transitionFromPlannedNoEffect(
  claim: ClaimedAgentRuntimeReconciliation,
  context: RuntimeLoadedContext,
  policy: RuntimePolicyState,
  nextAttemptAtMs: number | null,
): RuntimeTransition {
  const circuitRequested = claim.circuitOpenedAt === null && policy.circuitOpenedAtMs !== null;
  const desiredStopping = claim.desiredStatus === "stopped" && policy.state !== "stopped";
  return {
    mutation: mutationFromPolicy(policy, nextAttemptAtMs, {
      ...(policy.generation !== claim.generation ? { generation: policy.generation } : {}),
      ...(["observing", "verifying"].includes(policy.state) && claim.operationId
        ? { operationId: claim.operationId }
        : {}),
    }),
    outcome: policy.state === "circuit_open" ? "circuit_open" : "recovering",
    agentStatus: policy.state === "circuit_open" ? "error" : "restarting",
    statusReason: desiredStopping ? STOPPING_REASON : UNAVAILABLE_REASON,
    closeUsage: policy.errorCode === "runtime_runner_unavailable" || circuitRequested,
    ...(circuitRequested
      ? { event: runtimeEvent(claim, context, "agent.runtime_circuit_opened", policy, true) }
      : {}),
  };
}

function transitionFromObservation(
  claim: ClaimedAgentRuntimeReconciliation,
  context: RuntimeLoadedContext,
  decision: RuntimeObservationDecision,
  observedAt: Date,
  exactReady: boolean,
  adoptedOperationId?: string,
): RuntimeTransition {
  const status = exactReady
    ? "running"
    : decision.policy.state === "circuit_open" || decision.policy.circuitOpenedAtMs !== null
      ? "error"
      : "restarting";
  const reason = exactReady
    ? HEALTHY_REASON
    : status === "error"
      ? UNAVAILABLE_REASON
      : RECOVERING_REASON;
  const event = decision.circuitRequested
    ? runtimeEvent(claim, context, "agent.runtime_circuit_opened", decision.policy, true)
    : decision.recoveryRequested
      ? runtimeEvent(claim, context, "agent.runtime_recovery_requested", decision.policy, false)
      : decision.recovered
        ? runtimeEvent(claim, context, "agent.runtime_recovered", decision.policy, false)
        : undefined;
  const correlatedOperationId = claim.operationId ?? adoptedOperationId;

  return {
    mutation: mutationFromPolicy(decision.policy, decision.nextAttemptAtMs, {
      ...(exactReady ? { attemptCount: 0, lastReadyAt: observedAt } : {}),
      ...(["observing", "verifying"].includes(decision.policy.state) && correlatedOperationId
        ? { operationId: correlatedOperationId }
        : {}),
      lastObservedAt: observedAt,
    }),
    outcome:
      decision.policy.state === "circuit_open"
        ? "circuit_open"
        : exactReady
          ? "observed"
          : "recovering",
    agentStatus: status,
    statusReason: reason,
    closeUsage: decision.closeUsage,
    openUsage: decision.openUsage,
    ...(event ? { event } : {}),
  };
}

function transitionFromStartDecision(
  claim: ClaimedAgentRuntimeReconciliation,
  context: RuntimeLoadedContext,
  policy: RuntimePolicyState,
  nextAttemptAtMs: number | null,
  operationId?: string,
): RuntimeTransition {
  const circuitRequested = claim.circuitOpenedAt === null && policy.circuitOpenedAtMs !== null;
  const accepted = policy.state === "verifying" && operationId !== undefined;
  return {
    mutation: mutationFromPolicy(policy, nextAttemptAtMs, {
      ...(accepted ? { attemptCount: 0, operationId } : {}),
    }),
    outcome: circuitRequested ? "circuit_open" : "recovering",
    agentStatus: circuitRequested ? "error" : "restarting",
    statusReason: circuitRequested ? UNAVAILABLE_REASON : RECOVERING_REASON,
    closeUsage: true,
    ...(circuitRequested
      ? { event: runtimeEvent(claim, context, "agent.runtime_circuit_opened", policy, true) }
      : {}),
  };
}

function mutationFromPolicy(
  policy: RuntimePolicyState,
  nextAttemptAtMs: number | null,
  options: {
    attemptCount?: number;
    generation?: number;
    operationId?: string;
    lastObservedAt?: Date;
    lastReadyAt?: Date;
  } = {},
): RuntimeResultMutation {
  return {
    state: policy.state,
    ...(options.attemptCount === undefined ? {} : { attemptCount: options.attemptCount }),
    ...(options.generation === undefined ? {} : { generation: options.generation }),
    operationId: options.operationId ?? null,
    recoveryCount: policy.recoveryCount,
    recoveryWindowStartedAt: dateFromMs(policy.recoveryWindowStartedAtMs),
    stableSince: dateFromMs(policy.stableSinceMs),
    telegramNonConnectedSince: dateFromMs(policy.telegramNonConnectedSinceMs),
    lastRestartCount: policy.lastRestartCount,
    ...(options.lastObservedAt ? { lastObservedAt: options.lastObservedAt } : {}),
    ...(options.lastReadyAt ? { lastReadyAt: options.lastReadyAt } : {}),
    errorCode: policy.errorCode,
    nextAttemptAt: dateFromMs(nextAttemptAtMs),
    circuitOpenedAt: dateFromMs(policy.circuitOpenedAtMs),
  };
}

export function mapRunnerSnapshotToRuntimeObservation(
  snapshot: RunnerDurableStatusSnapshot,
  expected: Pick<ClaimedAgentRuntimeReconciliation, "configRevision" | "operationId">,
): RuntimeObservation {
  if (snapshot.container.state === "absent" || snapshot.phase === "idle") {
    return { kind: "container_absent" };
  }
  if (
    ["exited", "dead", "removing"].includes(snapshot.container.state) ||
    ["failed", "stopped", "cancelled"].includes(snapshot.phase)
  ) {
    return { kind: "container_terminal" };
  }
  if (
    snapshot.operation === null ||
    (expected.operationId !== null && snapshot.operation.id !== expected.operationId) ||
    snapshot.operation.target.configRevision !== expected.configRevision ||
    snapshot.operation.target.launchSpecVersion !== MANAGED_AGENT_LAUNCH_SPEC_VERSION ||
    snapshot.operation.target.image !== DEFAULT_HERMES_WORKLOAD_IMAGE ||
    snapshot.container.image !== snapshot.operation.target.image ||
    snapshot.revision.state !== "match" ||
    snapshot.revision.requested !== expected.configRevision ||
    snapshot.revision.containerLabel !== expected.configRevision ||
    snapshot.revision.projectionMarker !== expected.configRevision
  ) {
    return { kind: "revision_mismatch" };
  }
  if (
    snapshot.container.restartPolicy.name !== "unless-stopped" ||
    snapshot.container.restartPolicy.maximumRetryCount !== 0 ||
    snapshot.container.restartCount === null
  ) {
    return { kind: "restart_policy_mismatch" };
  }
  if (
    snapshot.phase === "accepted" ||
    snapshot.phase === "starting" ||
    snapshot.container.state === "created" ||
    snapshot.container.state === "restarting" ||
    snapshot.gateway.state === "starting"
  ) {
    return { kind: "starting" };
  }
  if (snapshot.container.state !== "running" || snapshot.gateway.state !== "running") {
    return { kind: "gateway_unhealthy" };
  }
  if (!snapshot.apiServer.required || snapshot.apiServer.state !== "connected") {
    return { kind: "api_server_unhealthy" };
  }
  if (!snapshot.telegram.required || snapshot.telegram.state !== "connected") {
    return { kind: "telegram_unhealthy", telegramState: snapshot.telegram.state };
  }
  if (snapshot.phase !== "ready") {
    return { kind: "unknown" };
  }
  return { kind: "exact_ready", restartCount: snapshot.container.restartCount };
}

async function persistRuntimeTransition(
  connection: DatabaseConnection,
  claim: ClaimedAgentRuntimeReconciliation,
  transition: RuntimeTransition,
  now: Date,
): Promise<boolean> {
  return connection.db.transaction(async (tx) => {
    const applied = await applyClaimedAgentRuntimeResult({
      db: tx,
      claim,
      expectedDesiredStatus: claim.desiredStatus,
      now,
      mutation: transition.mutation,
    });
    if (!applied) {
      return false;
    }

    if (transition.agentStatus) {
      await tx
        .update(agents)
        .set({
          status: transition.agentStatus,
          statusReason: transition.statusReason ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agents.id, claim.agentId),
            eq(agents.userId, claim.userId),
            isNull(agents.deletedAt),
            eq(agents.desiredStatus, claim.desiredStatus),
            eq(agents.runnerId, claim.runnerId),
          ),
        );
    }

    if (transition.closeUsage) {
      await tx
        .update(agentUsagePeriods)
        .set({ stoppedAt: now, updatedAt: now })
        .where(
          and(eq(agentUsagePeriods.agentId, claim.agentId), isNull(agentUsagePeriods.stoppedAt)),
        );
    }
    if (transition.openUsage) {
      await tx
        .insert(agentUsagePeriods)
        .values({
          agentId: claim.agentId,
          runnerId: claim.runnerId,
          source: "lifecycle",
          startedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }
    if (transition.event) {
      await writeRuntimeEventOnceInGeneration(tx, claim, transition.event, now);
    }
    return true;
  });
}

async function writeRuntimeEventOnceInGeneration(
  tx: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  claim: ClaimedAgentRuntimeReconciliation,
  event: RuntimeEvent,
  now: Date,
): Promise<void> {
  const [boundary] = await tx
    .select({ createdAt: agentEvents.createdAt })
    .from(agentEvents)
    .where(
      and(
        eq(agentEvents.agentId, claim.agentId),
        inArray(agentEvents.type, [
          "agent.start_requested",
          "agent.restart_requested",
          "agent.stop_requested",
          "config.updated",
          "agent.credentials_updated",
        ]),
      ),
    )
    .orderBy(desc(agentEvents.createdAt), desc(agentEvents.id))
    .limit(1);
  const [existing] = await tx
    .select({ id: agentEvents.id })
    .from(agentEvents)
    .where(
      and(
        eq(agentEvents.agentId, claim.agentId),
        eq(agentEvents.type, event.type),
        ...(boundary ? [gte(agentEvents.createdAt, boundary.createdAt)] : []),
      ),
    )
    .orderBy(desc(agentEvents.createdAt), desc(agentEvents.id))
    .limit(1);

  if (existing) {
    return;
  }

  await recordAgentEventInTransaction(tx, {
    agentId: claim.agentId,
    actorUserId: claim.userId,
    type: event.type,
    message: runtimeEventMessage(event.type),
    metadata: {
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      reasonCode: event.reasonCode,
      recoveryCount: event.recoveryCount,
      desiredStatus: claim.desiredStatus,
      cleanupRequired: event.cleanupRequired,
      telegramRequired: event.telegramRequired,
    },
    createdAt: now,
  });
}

async function loadRuntimeContext(
  connection: DatabaseConnection,
  claim: ClaimedAgentRuntimeReconciliation,
  now: Date,
): Promise<RuntimeLoadedContext> {
  const [row] = await connection.db
    .select({
      agentStatus: agents.status,
      runnerId: runners.id,
      runnerUserId: runners.userId,
      runnerName: runners.name,
      runnerKind: runners.kind,
      endpointUrl: runners.endpointUrl,
      runnerStatus: runners.status,
      runnerCreatedAt: runners.createdAt,
      runnerUpdatedAt: runners.updatedAt,
      runnerDeletedAt: runners.deletedAt,
    })
    .from(agents)
    .innerJoin(runners, eq(runners.id, agents.runnerId))
    .where(
      and(
        eq(agents.id, claim.agentId),
        eq(agents.userId, claim.userId),
        isNull(agents.deletedAt),
        eq(agents.runnerId, claim.runnerId),
        eq(runners.id, claim.runnerId),
        eq(runners.userId, claim.userId),
        isNull(runners.deletedAt),
      ),
    )
    .limit(1);

  if (!row?.endpointUrl) {
    return {
      agentStatus: row?.agentStatus ?? "error",
      runner: null,
      runnerAvailability: "unavailable",
    };
  }

  const [heartbeat] = await connection.db
    .select({
      status: runnerHeartbeats.status,
      metadata: runnerHeartbeats.metadata,
      observedAt: runnerHeartbeats.observedAt,
    })
    .from(runnerHeartbeats)
    .where(eq(runnerHeartbeats.runnerId, claim.runnerId))
    .orderBy(desc(runnerHeartbeats.observedAt), desc(runnerHeartbeats.createdAt))
    .limit(1);
  const runner: ManualRunnerRecord = {
    id: row.runnerId,
    userId: row.runnerUserId,
    name: row.runnerName,
    kind: row.runnerKind as ManualRunnerRecord["kind"],
    endpointUrl: row.endpointUrl,
    status: row.runnerStatus as ManualRunnerRecord["status"],
    createdAt: row.runnerCreatedAt.toISOString(),
    updatedAt: row.runnerUpdatedAt.toISOString(),
    deletedAt: row.runnerDeletedAt?.toISOString() ?? null,
  };
  const heartbeatFresh =
    heartbeat?.status === "online" &&
    now.getTime() - heartbeat.observedAt.getTime() < RUNNER_HEARTBEAT_STALE_THRESHOLD_MS;
  const stale = !heartbeatFresh || row.runnerStatus !== "online";

  if (stale) {
    return { agentStatus: row.agentStatus, runner, runnerAvailability: "unavailable" };
  }

  const assigned = await connection.db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.runnerId, claim.runnerId),
        eq(agents.userId, claim.userId),
        isNull(agents.deletedAt),
        inArray(agents.status, ["starting", "running", "restarting"]),
        ne(agents.id, claim.agentId),
      ),
    );
  const capacity = normalizeRunnerCapacitySnapshot(heartbeat.metadata, assigned.length);
  return {
    agentStatus: row.agentStatus,
    runner,
    runnerAvailability: hasAvailableRunnerCapacity(capacity) ? "eligible" : "capacity_blocked",
  };
}

function policyFromClaim(claim: ClaimedAgentRuntimeReconciliation): RuntimePolicyState {
  return {
    state: claim.state,
    generation: claim.generation,
    attemptCount: claim.attemptCount,
    recoveryCount: claim.recoveryCount,
    recoveryWindowStartedAtMs: timestampMs(claim.recoveryWindowStartedAt),
    stableSinceMs: timestampMs(claim.stableSince),
    telegramNonConnectedSinceMs: timestampMs(claim.telegramNonConnectedSince),
    lastRestartCount: claim.lastRestartCount,
    errorCode: claim.errorCode,
    circuitOpenedAtMs: timestampMs(claim.circuitOpenedAt),
  };
}

function runtimeEvent(
  claim: ClaimedAgentRuntimeReconciliation,
  context: RuntimeLoadedContext,
  type: RuntimeEvent["type"],
  policy: RuntimePolicyState,
  cleanupRequired: boolean,
): RuntimeEvent {
  return {
    type,
    fromStatus: context.agentStatus,
    toStatus:
      type === "agent.runtime_circuit_opened"
        ? "error"
        : type === "agent.runtime_recovered"
          ? "running"
          : "restarting",
    reasonCode: policy.errorCode ?? claim.errorCode ?? "runtime_internal_failure",
    recoveryCount: policy.recoveryCount,
    cleanupRequired,
    telegramRequired:
      policy.errorCode === "runtime_telegram_unhealthy" ||
      policy.errorCode === "telegram_webhook_conflict" ||
      policy.errorCode === "telegram_polling_conflict_or_unavailable",
  };
}

function runtimeEventMessage(type: RuntimeEvent["type"]): string {
  switch (type) {
    case "agent.runtime_recovery_requested":
      return "Managed gateway recovery requested.";
    case "agent.runtime_recovered":
      return "Managed gateway recovery completed.";
    case "agent.runtime_circuit_opened":
      return "Managed gateway automatic recovery paused.";
  }
}

function transitionFromStartFailureCode(reason: string): AgentRuntimeErrorCode {
  return reason === "required_secret_missing" ||
    reason === "required_secret_revoked" ||
    reason === "secret_decryption_failed" ||
    reason === "secret_storage_unavailable"
    ? "runtime_secret_unavailable"
    : "runtime_internal_failure";
}

function isSecretLaunchFailure(reason: string): boolean {
  return transitionFromStartFailureCode(reason) === "runtime_secret_unavailable";
}

function isActiveContainer(status: string): boolean {
  return ["created", "running", "restarting", "paused", "removing"].includes(status);
}

function timestampMs(value: Date | string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateFromMs(value: number | null): Date | null {
  return value === null ? null : new Date(value);
}

function runtimeRetryDelay(attemptCount: number): number {
  const delays = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
  return delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)] ?? 300_000;
}

function createRuntimeRunnerAdapter(
  runner: ManualRunnerRecord,
  options: { signal: AbortSignal; timeoutMs: number },
): RuntimeRunnerAdapter {
  return new ManualRunnerAdapter(runner, options);
}

async function defaultTelegramWebhookDiagnostic(
  token: string,
  context: RuntimeActionContext,
): Promise<TelegramWebhookDiagnosticResult> {
  if (context.signal.aborted || context.remainingMs() <= 0) {
    return "uncertain";
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  context.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await diagnoseTelegramWebhook(token, { createAbortController: () => controller });
  } finally {
    context.signal.removeEventListener("abort", onAbort);
  }
}
