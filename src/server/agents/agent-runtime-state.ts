import "server-only";

export const AGENT_RUNTIME_STATES = [
  "observing",
  "recovering_stop",
  "recovering_start",
  "verifying",
  "stopping",
  "stopped",
  "circuit_open",
] as const;

export type AgentRuntimeState = (typeof AGENT_RUNTIME_STATES)[number];

export const AGENT_RUNTIME_ERROR_CODES = [
  "runtime_runner_unavailable",
  "runtime_container_absent",
  "runtime_container_terminal",
  "runtime_revision_mismatch",
  "runtime_restart_policy_mismatch",
  "runtime_gateway_unhealthy",
  "runtime_api_server_unhealthy",
  "runtime_telegram_unhealthy",
  "telegram_webhook_conflict",
  "telegram_polling_conflict_or_unavailable",
  "runtime_secret_unavailable",
  "runtime_capacity_blocked",
  "runtime_recovery_exhausted",
  "runtime_stop_unconfirmed",
  "runtime_internal_failure",
] as const;

export type AgentRuntimeErrorCode = (typeof AGENT_RUNTIME_ERROR_CODES)[number];

export const RUNTIME_OBSERVATION_INTERVAL_MS = 60_000;
export const RUNTIME_TRANSIENT_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
export const RUNTIME_RECOVERY_WINDOW_MS = 15 * 60_000;
export const RUNTIME_STABILITY_RESET_MS = 15 * 60_000;
export const RUNTIME_TELEGRAM_GRACE_MS = 2 * 60_000;
export const MAX_AUTOMATIC_RUNTIME_RECOVERIES = 3;
export const MAX_DOCKER_POLICY_RESTARTS = 3;
export const MAX_RUNTIME_COUNTER = 2_147_483_647;

const RUNTIME_STATE_SET = new Set<string>(AGENT_RUNTIME_STATES);
const RUNTIME_ERROR_CODE_SET = new Set<string>(AGENT_RUNTIME_ERROR_CODES);

export type RuntimeTelegramState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "retrying"
  | "fatal"
  | "paused"
  | "disabled"
  | "unknown";

export type RuntimePolicyState = {
  state: AgentRuntimeState;
  generation: number;
  attemptCount: number;
  recoveryCount: number;
  recoveryWindowStartedAtMs: number | null;
  stableSinceMs: number | null;
  telegramNonConnectedSinceMs: number | null;
  lastRestartCount: number | null;
  errorCode: AgentRuntimeErrorCode | null;
  circuitOpenedAtMs: number | null;
};

export type RuntimeExternalEffect = "none" | "observe" | "stop" | "start";

export type RuntimeEffectPlan = {
  policy: RuntimePolicyState;
  effect: RuntimeExternalEffect;
  nextAttemptAtMs: number | null;
  reason:
    | "due"
    | "desired_stopped"
    | "deleted"
    | "latest_deployment_not_ready"
    | "runner_unavailable"
    | "capacity_blocked"
    | "secret_unavailable"
    | "circuit_open"
    | "intentionally_stopped"
    | "explicit_start_required";
};

export type RuntimeObservation =
  | { kind: "exact_ready"; restartCount: number | null }
  | { kind: "starting" }
  | { kind: "container_absent" }
  | { kind: "container_terminal" }
  | { kind: "revision_mismatch" }
  | { kind: "restart_policy_mismatch" }
  | { kind: "gateway_unhealthy" }
  | { kind: "api_server_unhealthy" }
  | { kind: "telegram_unhealthy"; telegramState: RuntimeTelegramState }
  | { kind: "runner_unavailable"; heartbeatStale: boolean }
  | { kind: "unknown" };

export type RuntimeObservationDecision = {
  policy: RuntimePolicyState;
  nextAttemptAtMs: number | null;
  closeUsage: boolean;
  openUsage: boolean;
  recoveryRequested: boolean;
  recovered: boolean;
  circuitRequested: boolean;
};

export type RuntimeStopDecision = {
  policy: RuntimePolicyState;
  nextAttemptAtMs: number | null;
  closeUsage: boolean;
  circuitOpened: boolean;
};

export type RuntimeStartDecision = {
  policy: RuntimePolicyState;
  nextAttemptAtMs: number | null;
};

export type RuntimePublicPresentation = {
  state:
    | "healthy"
    | "recovering"
    | "stopping"
    | "intentionally_stopped"
    | "attention_required"
    | "unavailable";
  label: string;
  message: string;
  action: "none" | "wait" | "start" | "restart";
};

export const RUNTIME_ERROR_MESSAGES: Readonly<Record<AgentRuntimeErrorCode, string>> = {
  runtime_runner_unavailable: "The assigned runner is unavailable. Observation will retry.",
  runtime_container_absent: "The managed gateway was not found and recovery is scheduled.",
  runtime_container_terminal: "The managed gateway stopped unexpectedly and recovery is scheduled.",
  runtime_revision_mismatch: "The managed gateway configuration is stale and will be replaced.",
  runtime_restart_policy_mismatch:
    "The managed gateway durability policy is stale and will be replaced.",
  runtime_gateway_unhealthy: "The Hermes gateway is unavailable and bounded recovery is active.",
  runtime_api_server_unhealthy:
    "The agent API server is unavailable and bounded recovery is active.",
  runtime_telegram_unhealthy: "Telegram is unavailable and bounded recovery is active.",
  telegram_webhook_conflict:
    "Telegram has another webhook configured. Remove it, then restart this agent.",
  telegram_polling_conflict_or_unavailable:
    "Telegram polling remains unavailable. Check other integrations, then restart this agent.",
  runtime_secret_unavailable: "A required credential is unavailable. Replace it, then restart.",
  runtime_capacity_blocked: "The assigned runner does not currently have capacity to recover.",
  runtime_recovery_exhausted: "Automatic recovery was paused after repeated failures.",
  runtime_stop_unconfirmed: "The gateway stop has not yet been confirmed.",
  runtime_internal_failure: "Runtime state could not be verified safely.",
};

export function parseAgentRuntimeState(value: unknown): AgentRuntimeState | null {
  return typeof value === "string" && RUNTIME_STATE_SET.has(value)
    ? (value as AgentRuntimeState)
    : null;
}

export function parseAgentRuntimeErrorCode(value: unknown): AgentRuntimeErrorCode | null {
  return typeof value === "string" && RUNTIME_ERROR_CODE_SET.has(value)
    ? (value as AgentRuntimeErrorCode)
    : null;
}

export function runtimeBackoffMs(attemptCount: number): number {
  const boundedAttempt = Number.isSafeInteger(attemptCount) && attemptCount > 0 ? attemptCount : 1;
  const index = Math.min(boundedAttempt - 1, RUNTIME_TRANSIENT_BACKOFF_MS.length - 1);
  return RUNTIME_TRANSIENT_BACKOFF_MS[index] ?? 300_000;
}

export function parseRuntimeRestartCount(value: unknown): number | null {
  return Number.isInteger(value) &&
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_RUNTIME_COUNTER
    ? value
    : null;
}

export function runtimeRestartCountDelta(input: {
  baseline: number | null;
  observed: number | null;
}): { baseline: number | null; delta: number | null } {
  const baseline = parseRuntimeRestartCount(input.baseline);
  const observed = parseRuntimeRestartCount(input.observed);

  if (observed === null) {
    return { baseline, delta: null };
  }

  if (baseline === null || observed < baseline) {
    return { baseline: observed, delta: 0 };
  }

  return { baseline: observed, delta: observed - baseline };
}

export function planRuntimeEffect(input: {
  policy: RuntimePolicyState;
  nowMs: number;
  desiredStatus: "running" | "stopped";
  deleted: boolean;
  latestDeployment: "ready" | "active" | "failed" | "missing";
  runner: "eligible" | "unavailable" | "capacity_blocked";
  secrets: "available" | "unavailable";
}): RuntimeEffectPlan {
  const policy = normalizePolicy(input.policy);

  if (input.deleted) {
    return noEffect(policy, "deleted");
  }

  if (input.desiredStatus === "stopped") {
    if (policy.state === "stopped") {
      return noEffect(clearStoppedPolicy(policy), "intentionally_stopped");
    }

    const stopping =
      policy.state === "stopping" && policy.circuitOpenedAtMs === null
        ? policy
        : enterDesiredStop(policy);
    if (input.runner === "unavailable") {
      return retryWithoutEffect(stopping, input.nowMs, "runner_unavailable");
    }

    return {
      policy: stopping,
      effect: "stop",
      nextAttemptAtMs: null,
      reason: "desired_stopped",
    };
  }

  if (input.latestDeployment !== "ready") {
    return noEffect(policy, "latest_deployment_not_ready");
  }

  if (policy.state === "circuit_open") {
    return noEffect(policy, "circuit_open");
  }

  if (
    input.secrets === "unavailable" &&
    policy.state !== "stopping" &&
    policy.state !== "recovering_stop" &&
    policy.state !== "stopped"
  ) {
    const circuit = requestCircuitCleanup(policy, input.nowMs, "runtime_secret_unavailable");
    return {
      policy: circuit.policy,
      effect: "none",
      nextAttemptAtMs: circuit.nextAttemptAtMs,
      reason: "secret_unavailable",
    };
  }

  if (policy.state === "stopping" || policy.state === "recovering_stop") {
    if (input.runner === "unavailable") {
      if (policy.circuitOpenedAtMs !== null) {
        return {
          policy,
          effect: "none",
          nextAttemptAtMs: input.nowMs + runtimeBackoffMs(policy.attemptCount),
          reason: "runner_unavailable",
        };
      }
      return retryWithoutEffect(policy, input.nowMs, "runner_unavailable");
    }

    return {
      policy,
      effect: "stop",
      nextAttemptAtMs: null,
      reason: "due",
    };
  }

  if (policy.state === "stopped") {
    return noEffect(policy, "explicit_start_required");
  }

  if (policy.state === "recovering_start") {
    if (input.runner === "capacity_blocked") {
      return {
        ...retryWithoutEffect(
          { ...policy, state: "recovering_start", errorCode: "runtime_capacity_blocked" },
          input.nowMs,
          "capacity_blocked",
        ),
      };
    }

    if (input.runner === "unavailable") {
      return retryWithoutEffect(
        { ...policy, state: "recovering_start" },
        input.nowMs,
        "runner_unavailable",
      );
    }

    return {
      policy: { ...policy, state: "recovering_start", errorCode: null },
      effect: "start",
      nextAttemptAtMs: null,
      reason: "due",
    };
  }

  if (input.runner === "unavailable") {
    return retryWithoutEffect(policy, input.nowMs, "runner_unavailable");
  }

  return {
    policy,
    effect: "observe",
    nextAttemptAtMs: null,
    reason: "due",
  };
}

export function applyRuntimeObservation(input: {
  policy: RuntimePolicyState;
  observation: RuntimeObservation;
  nowMs: number;
}): RuntimeObservationDecision {
  const policy = normalizePolicy(input.policy);
  const { observation, nowMs } = input;

  if (policy.state === "circuit_open") {
    return {
      policy,
      nextAttemptAtMs: null,
      closeUsage: true,
      openUsage: false,
      recoveryRequested: false,
      recovered: false,
      circuitRequested: false,
    };
  }

  if (observation.kind === "exact_ready") {
    return exactReadyDecision(policy, nowMs, observation.restartCount);
  }

  if (observation.kind === "runner_unavailable") {
    return transientDecision(
      { ...policy, errorCode: "runtime_runner_unavailable", stableSinceMs: null },
      nowMs,
      observation.heartbeatStale,
    );
  }

  if (observation.kind === "starting" || observation.kind === "unknown") {
    return transientDecision(
      {
        ...policy,
        errorCode: observation.kind === "unknown" ? "runtime_internal_failure" : null,
        stableSinceMs: null,
      },
      nowMs,
      true,
    );
  }

  if (observation.kind === "telegram_unhealthy") {
    return telegramDecision(policy, nowMs, observation.telegramState);
  }

  const failure = failureFromObservation(observation.kind);
  const recoveryState =
    observation.kind === "container_absent" || observation.kind === "container_terminal"
      ? "recovering_start"
      : "recovering_stop";
  return requestAutomaticRecovery(policy, nowMs, recoveryState, failure);
}

export function applyRuntimeStopResult(input: {
  policy: RuntimePolicyState;
  nowMs: number;
  desiredStatus: "running" | "stopped";
  result: "confirmed" | "unconfirmed";
}): RuntimeStopDecision {
  const policy = normalizePolicy(input.policy);

  if (input.desiredStatus === "stopped") {
    const stopping =
      policy.state === "stopping" && policy.circuitOpenedAtMs === null
        ? policy
        : enterDesiredStop(policy);
    if (input.result === "unconfirmed") {
      const retryPolicy = { ...stopping, errorCode: "runtime_stop_unconfirmed" as const };
      return {
        policy: retryPolicy,
        nextAttemptAtMs: input.nowMs + runtimeBackoffMs(retryPolicy.attemptCount),
        closeUsage: true,
        circuitOpened: false,
      };
    }

    return {
      policy: clearStoppedPolicy(stopping),
      nextAttemptAtMs: null,
      closeUsage: true,
      circuitOpened: false,
    };
  }

  if (input.result === "unconfirmed") {
    const retryPolicy = {
      ...policy,
      errorCode:
        policy.circuitOpenedAtMs === null
          ? ("runtime_stop_unconfirmed" as const)
          : policy.errorCode,
    };
    return {
      policy: retryPolicy,
      nextAttemptAtMs: input.nowMs + runtimeBackoffMs(retryPolicy.attemptCount),
      closeUsage: true,
      circuitOpened: false,
    };
  }

  if (policy.circuitOpenedAtMs !== null) {
    return {
      policy: {
        ...policy,
        state: "circuit_open",
        stableSinceMs: null,
        telegramNonConnectedSinceMs: null,
      },
      nextAttemptAtMs: null,
      closeUsage: true,
      circuitOpened: true,
    };
  }

  return {
    policy: {
      ...policy,
      state: "recovering_start",
      stableSinceMs: null,
      telegramNonConnectedSinceMs: null,
      errorCode: null,
    },
    nextAttemptAtMs: input.nowMs,
    closeUsage: true,
    circuitOpened: false,
  };
}

export function applyRuntimeStartResult(input: {
  policy: RuntimePolicyState;
  nowMs: number;
  result: "accepted" | "transient_failure" | "capacity_blocked" | "secret_unavailable";
}): RuntimeStartDecision {
  const policy = normalizePolicy(input.policy);

  if (input.result === "accepted") {
    return {
      policy: {
        ...policy,
        state: "verifying",
        stableSinceMs: null,
        telegramNonConnectedSinceMs: null,
        errorCode: null,
      },
      nextAttemptAtMs: input.nowMs + runtimeBackoffMs(1),
    };
  }

  if (input.result === "secret_unavailable") {
    const circuit = requestCircuitCleanup(policy, input.nowMs, "runtime_secret_unavailable");
    return {
      policy: circuit.policy,
      nextAttemptAtMs: circuit.nextAttemptAtMs,
    };
  }

  const errorCode =
    input.result === "capacity_blocked" ? "runtime_capacity_blocked" : "runtime_runner_unavailable";
  return {
    policy: { ...policy, state: "recovering_start", errorCode },
    nextAttemptAtMs: input.nowMs + runtimeBackoffMs(policy.attemptCount),
  };
}

export function resetRuntimeForOwnerAction(input: {
  policy: RuntimePolicyState;
  action: "start" | "restart";
}): RuntimePolicyState {
  const policy = normalizePolicy(input.policy);
  return {
    ...policy,
    state: input.action === "restart" ? "recovering_stop" : "recovering_start",
    generation: incrementBounded(policy.generation),
    attemptCount: 0,
    recoveryCount: 0,
    recoveryWindowStartedAtMs: null,
    stableSinceMs: null,
    telegramNonConnectedSinceMs: null,
    errorCode: null,
    circuitOpenedAtMs: null,
  };
}

export function requestRuntimeCircuitCleanup(input: {
  policy: RuntimePolicyState;
  nowMs: number;
  errorCode: AgentRuntimeErrorCode;
}): RuntimeObservationDecision {
  return requestCircuitCleanup(normalizePolicy(input.policy), input.nowMs, input.errorCode);
}

export function runtimePublicPresentation(input: {
  policy: RuntimePolicyState;
  desiredStatus: "running" | "stopped";
}): RuntimePublicPresentation {
  const policy = normalizePolicy(input.policy);

  if (input.desiredStatus === "stopped" && policy.state === "stopped") {
    return {
      state: "intentionally_stopped",
      label: "Intentionally stopped",
      message: "This agent will remain stopped until you start it.",
      action: "start",
    };
  }

  if (input.desiredStatus === "stopped") {
    return {
      state: "stopping",
      label: "Stopping",
      message: "The managed gateway is being stopped and verified.",
      action: "wait",
    };
  }

  if (policy.state === "stopped") {
    return {
      state: "unavailable",
      label: "Unavailable",
      message: RUNTIME_ERROR_MESSAGES.runtime_internal_failure,
      action: "wait",
    };
  }

  if (policy.state === "circuit_open" || policy.circuitOpenedAtMs !== null) {
    return {
      state: "attention_required",
      label: "Attention required",
      message:
        policy.errorCode === null
          ? RUNTIME_ERROR_MESSAGES.runtime_internal_failure
          : RUNTIME_ERROR_MESSAGES[policy.errorCode],
      action: "restart",
    };
  }

  if (policy.state === "stopping") {
    return {
      state: "stopping",
      label: "Stopping",
      message: "The managed gateway is being stopped and verified.",
      action: "wait",
    };
  }

  if (
    policy.state === "recovering_stop" ||
    policy.state === "recovering_start" ||
    policy.state === "verifying"
  ) {
    return {
      state: "recovering",
      label: "Recovering",
      message:
        policy.errorCode === null
          ? "The managed gateway is converging to ready."
          : RUNTIME_ERROR_MESSAGES[policy.errorCode],
      action: "wait",
    };
  }

  if (policy.errorCode !== null) {
    return {
      state: "unavailable",
      label: "Unavailable",
      message: RUNTIME_ERROR_MESSAGES[policy.errorCode],
      action: "wait",
    };
  }

  return {
    state: "healthy",
    label: "Ready",
    message: "Hermes gateway is ready.",
    action: "none",
  };
}

function exactReadyDecision(
  policy: RuntimePolicyState,
  nowMs: number,
  restartCount: number | null,
): RuntimeObservationDecision {
  if (parseRuntimeRestartCount(restartCount) === null) {
    return transientDecision(
      { ...policy, stableSinceMs: null, errorCode: "runtime_internal_failure" },
      nowMs,
      true,
    );
  }

  const stableSinceMs = policy.stableSinceMs ?? nowMs;
  const restart = runtimeRestartCountDelta({
    baseline: policy.lastRestartCount,
    observed: restartCount,
  });
  const restartDelta = restart.delta ?? 0;
  const restartIncreased = restartDelta > 0;
  const nextRecoveryCount = Math.min(MAX_RUNTIME_COUNTER, policy.recoveryCount + restartDelta);
  const nextRecoveryWindowStartedAtMs = restartIncreased
    ? (policy.recoveryWindowStartedAtMs ?? nowMs)
    : policy.recoveryWindowStartedAtMs;
  const nextStableSinceMs = restartIncreased ? nowMs : stableSinceMs;
  const stable = !restartIncreased && nowMs - nextStableSinceMs >= RUNTIME_STABILITY_RESET_MS;

  if (restartIncreased && nextRecoveryCount >= MAX_DOCKER_POLICY_RESTARTS) {
    return requestCircuitCleanup(
      {
        ...policy,
        recoveryCount: nextRecoveryCount,
        recoveryWindowStartedAtMs: nextRecoveryWindowStartedAtMs,
        stableSinceMs: null,
        lastRestartCount: restart.baseline,
      },
      nowMs,
      "runtime_recovery_exhausted",
    );
  }

  return {
    policy: {
      ...policy,
      state: "observing",
      recoveryCount: stable ? 0 : nextRecoveryCount,
      recoveryWindowStartedAtMs: stable ? null : nextRecoveryWindowStartedAtMs,
      stableSinceMs: nextStableSinceMs,
      telegramNonConnectedSinceMs: null,
      lastRestartCount: restart.baseline,
      errorCode: null,
      circuitOpenedAtMs: null,
    },
    nextAttemptAtMs: nowMs + RUNTIME_OBSERVATION_INTERVAL_MS,
    closeUsage: false,
    openUsage: true,
    recoveryRequested: false,
    recovered: policy.state === "verifying",
    circuitRequested: false,
  };
}

function telegramDecision(
  policy: RuntimePolicyState,
  nowMs: number,
  telegramState: RuntimeTelegramState,
): RuntimeObservationDecision {
  if (telegramState === "connected") {
    return transientDecision(
      { ...policy, errorCode: "runtime_internal_failure", stableSinceMs: null },
      nowMs,
      true,
    );
  }

  if (telegramState === "fatal" || telegramState === "paused" || telegramState === "disabled") {
    return requestAutomaticRecovery(
      { ...policy, telegramNonConnectedSinceMs: policy.telegramNonConnectedSinceMs ?? nowMs },
      nowMs,
      "recovering_stop",
      "runtime_telegram_unhealthy",
    );
  }

  const startedAt = policy.telegramNonConnectedSinceMs ?? nowMs;
  if (nowMs - startedAt < RUNTIME_TELEGRAM_GRACE_MS) {
    return transientDecision(
      {
        ...policy,
        telegramNonConnectedSinceMs: startedAt,
        stableSinceMs: null,
        errorCode: "runtime_telegram_unhealthy",
      },
      nowMs,
      true,
    );
  }

  return requestAutomaticRecovery(
    { ...policy, telegramNonConnectedSinceMs: startedAt },
    nowMs,
    "recovering_stop",
    "runtime_telegram_unhealthy",
  );
}

function requestAutomaticRecovery(
  policy: RuntimePolicyState,
  nowMs: number,
  state: "recovering_stop" | "recovering_start",
  errorCode: AgentRuntimeErrorCode,
): RuntimeObservationDecision {
  if (policy.state === "recovering_stop" || policy.state === "recovering_start") {
    return {
      policy: { ...policy, errorCode, stableSinceMs: null },
      nextAttemptAtMs: nowMs + runtimeBackoffMs(policy.attemptCount),
      closeUsage: true,
      openUsage: false,
      recoveryRequested: false,
      recovered: false,
      circuitRequested: false,
    };
  }

  const activeWindow =
    policy.recoveryWindowStartedAtMs !== null &&
    nowMs - policy.recoveryWindowStartedAtMs < RUNTIME_RECOVERY_WINDOW_MS;
  const recoveryWindowStartedAtMs = activeWindow ? policy.recoveryWindowStartedAtMs : nowMs;
  const previousCount = activeWindow ? policy.recoveryCount : 0;

  if (previousCount >= MAX_AUTOMATIC_RUNTIME_RECOVERIES) {
    return requestCircuitCleanup(
      policy,
      nowMs,
      errorCode === "runtime_telegram_unhealthy"
        ? "telegram_polling_conflict_or_unavailable"
        : "runtime_recovery_exhausted",
    );
  }

  return {
    policy: {
      ...policy,
      state,
      recoveryCount: previousCount + 1,
      recoveryWindowStartedAtMs,
      stableSinceMs: null,
      errorCode,
      circuitOpenedAtMs: null,
    },
    nextAttemptAtMs: nowMs,
    closeUsage: true,
    openUsage: false,
    recoveryRequested: true,
    recovered: false,
    circuitRequested: false,
  };
}

function requestCircuitCleanup(
  policy: RuntimePolicyState,
  nowMs: number,
  errorCode: AgentRuntimeErrorCode,
): RuntimeObservationDecision {
  return {
    policy: {
      ...policy,
      state: "stopping",
      stableSinceMs: null,
      telegramNonConnectedSinceMs: null,
      errorCode,
      circuitOpenedAtMs: policy.circuitOpenedAtMs ?? nowMs,
    },
    nextAttemptAtMs: nowMs,
    closeUsage: true,
    openUsage: false,
    recoveryRequested: false,
    recovered: false,
    circuitRequested: policy.circuitOpenedAtMs === null,
  };
}

function transientDecision(
  policy: RuntimePolicyState,
  nowMs: number,
  closeUsage: boolean,
): RuntimeObservationDecision {
  return {
    policy,
    nextAttemptAtMs: nowMs + runtimeBackoffMs(policy.attemptCount),
    closeUsage,
    openUsage: false,
    recoveryRequested: false,
    recovered: false,
    circuitRequested: false,
  };
}

function failureFromObservation(
  kind: Exclude<
    RuntimeObservation["kind"],
    "exact_ready" | "starting" | "telegram_unhealthy" | "runner_unavailable" | "unknown"
  >,
): AgentRuntimeErrorCode {
  switch (kind) {
    case "container_absent":
      return "runtime_container_absent";
    case "container_terminal":
      return "runtime_container_terminal";
    case "revision_mismatch":
      return "runtime_revision_mismatch";
    case "restart_policy_mismatch":
      return "runtime_restart_policy_mismatch";
    case "gateway_unhealthy":
      return "runtime_gateway_unhealthy";
    case "api_server_unhealthy":
      return "runtime_api_server_unhealthy";
  }
}

function enterDesiredStop(policy: RuntimePolicyState): RuntimePolicyState {
  return {
    ...policy,
    state: "stopping",
    generation: incrementBounded(policy.generation),
    recoveryCount: 0,
    recoveryWindowStartedAtMs: null,
    stableSinceMs: null,
    telegramNonConnectedSinceMs: null,
    errorCode: null,
    circuitOpenedAtMs: null,
  };
}

function clearStoppedPolicy(policy: RuntimePolicyState): RuntimePolicyState {
  return {
    ...policy,
    state: "stopped",
    attemptCount: 0,
    recoveryCount: 0,
    recoveryWindowStartedAtMs: null,
    stableSinceMs: null,
    telegramNonConnectedSinceMs: null,
    errorCode: null,
    circuitOpenedAtMs: null,
  };
}

function retryWithoutEffect(
  policy: RuntimePolicyState,
  nowMs: number,
  reason: "runner_unavailable" | "capacity_blocked",
): RuntimeEffectPlan {
  const errorCode =
    reason === "capacity_blocked" ? "runtime_capacity_blocked" : "runtime_runner_unavailable";
  return {
    policy: { ...policy, errorCode },
    effect: "none",
    nextAttemptAtMs: nowMs + runtimeBackoffMs(policy.attemptCount),
    reason,
  };
}

function noEffect(
  policy: RuntimePolicyState,
  reason:
    | "deleted"
    | "latest_deployment_not_ready"
    | "circuit_open"
    | "intentionally_stopped"
    | "explicit_start_required",
): RuntimeEffectPlan {
  return { policy, effect: "none", nextAttemptAtMs: null, reason };
}

function normalizePolicy(policy: RuntimePolicyState): RuntimePolicyState {
  return {
    ...policy,
    generation: normalizeCounter(policy.generation),
    attemptCount: normalizeCounter(policy.attemptCount),
    recoveryCount: normalizeCounter(policy.recoveryCount),
    lastRestartCount: parseRuntimeRestartCount(policy.lastRestartCount),
    errorCode: parseAgentRuntimeErrorCode(policy.errorCode),
  };
}

function normalizeCounter(value: number): number {
  return Number.isInteger(value) && value >= 0 && value <= MAX_RUNTIME_COUNTER ? value : 0;
}

function incrementBounded(value: number): number {
  const normalized = normalizeCounter(value);
  if (normalized >= MAX_RUNTIME_COUNTER) {
    throw new RangeError("Runtime generation is exhausted.");
  }
  return normalized + 1;
}
