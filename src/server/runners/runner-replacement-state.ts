export const RUNNER_REPLACEMENT_STATES = [
  "pending",
  "provisioning_target",
  "validating_target",
  "fencing_source",
  "reassigning",
  "converging_agents",
  "cleaning_source",
  "complete",
  "failed",
] as const;

export const RUNNER_REPLACEMENT_REASONS = [
  "release_mismatch",
  "boot_failure",
  "provider_resource_missing",
  "stale_heartbeat",
  "endpoint_failure",
  "gateway_deadline",
] as const;

export const RUNNER_REPLACEMENT_TERMINAL_CODES = [
  "replacement_budget_exhausted",
  "target_provisioning_failed",
  "target_validation_failed",
  "source_fence_failed",
  "reassignment_failed",
  "agent_convergence_failed",
  "source_cleanup_failed",
  "state_invalid",
] as const;

export type RunnerReplacementState = (typeof RUNNER_REPLACEMENT_STATES)[number];
export type RunnerReplacementReason = (typeof RUNNER_REPLACEMENT_REASONS)[number];
export type RunnerReplacementTerminalCode = (typeof RUNNER_REPLACEMENT_TERMINAL_CODES)[number];

export type RunnerReplacementTransitionSource = {
  sourceRunnerId: string;
  state: RunnerReplacementState;
  generation: number;
  targetRunnerId: string | null;
};

export type RunnerReplacementTransition = {
  sourceRunnerId: string;
  state: RunnerReplacementState;
  generation: number;
  targetRunnerId: string | null;
  nextAttemptAt: Date | null;
  terminalCode: RunnerReplacementTerminalCode | null;
  terminalSummary: string | null;
  completedAt: Date | null;
  failedAt: Date | null;
};

export type RunnerReplacementAction =
  | { kind: "advance"; targetRunnerId?: string }
  | { kind: "retry"; nextAttemptAt: Date }
  | { kind: "fail"; code: RunnerReplacementTerminalCode };

export type SafeRunnerReplacementDto = {
  id: string;
  sourceRunnerId: string;
  targetRunnerId: string | null;
  reason: RunnerReplacementReason;
  state: RunnerReplacementState;
  terminalCode: RunnerReplacementTerminalCode | null;
  terminalSummary: string | null;
  startedAt: string;
  completedAt: string | null;
  failedAt: string | null;
};

const MAX_COUNTER = 2_147_483_647;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const NEXT_STATE: Readonly<Partial<Record<RunnerReplacementState, RunnerReplacementState>>> = {
  pending: "provisioning_target",
  provisioning_target: "validating_target",
  validating_target: "fencing_source",
  fencing_source: "reassigning",
  reassigning: "converging_agents",
  converging_agents: "cleaning_source",
  cleaning_source: "complete",
};

const SAFE_TERMINAL_SUMMARIES: Readonly<Record<RunnerReplacementTerminalCode, string>> = {
  replacement_budget_exhausted: "Automatic runner replacement budget was exhausted.",
  target_provisioning_failed: "Replacement runner provisioning did not complete.",
  target_validation_failed: "Replacement runner validation did not pass.",
  source_fence_failed: "The source runner could not be fenced safely.",
  reassignment_failed: "Agent reassignment did not complete safely.",
  agent_convergence_failed: "Agents did not converge on the replacement runner.",
  source_cleanup_failed: "The obsolete source runner could not be cleaned up safely.",
  state_invalid: "The replacement workflow reached an invalid state.",
};

export function transitionRunnerReplacement(input: {
  current: RunnerReplacementTransitionSource;
  action: RunnerReplacementAction;
  now: Date;
}): RunnerReplacementTransition | null {
  if (
    !isValidDate(input.now) ||
    !isRunnerReplacementState(input.current.state) ||
    !UUID_PATTERN.test(input.current.sourceRunnerId) ||
    !isCounter(input.current.generation) ||
    input.current.generation === MAX_COUNTER ||
    (input.current.targetRunnerId !== null && !UUID_PATTERN.test(input.current.targetRunnerId)) ||
    input.current.targetRunnerId === input.current.sourceRunnerId ||
    ["complete", "failed"].includes(input.current.state)
  ) {
    return null;
  }

  if (input.action.kind === "fail") {
    if (!isRunnerReplacementTerminalCode(input.action.code)) return null;
    return {
      sourceRunnerId: input.current.sourceRunnerId,
      state: "failed",
      generation: input.current.generation + 1,
      targetRunnerId: input.current.targetRunnerId,
      nextAttemptAt: null,
      terminalCode: input.action.code,
      terminalSummary: SAFE_TERMINAL_SUMMARIES[input.action.code],
      completedAt: null,
      failedAt: input.now,
    };
  }

  if (input.action.kind === "retry") {
    if (!isValidDate(input.action.nextAttemptAt) || input.action.nextAttemptAt < input.now) {
      return null;
    }
    return {
      sourceRunnerId: input.current.sourceRunnerId,
      state: input.current.state,
      generation: input.current.generation + 1,
      targetRunnerId: input.current.targetRunnerId,
      nextAttemptAt: input.action.nextAttemptAt,
      terminalCode: null,
      terminalSummary: null,
      completedAt: null,
      failedAt: null,
    };
  }

  const state = NEXT_STATE[input.current.state];
  if (!state) return null;
  const targetRunnerId = input.action.targetRunnerId ?? input.current.targetRunnerId;
  if (
    input.action.targetRunnerId !== undefined &&
    (!UUID_PATTERN.test(input.action.targetRunnerId) ||
      input.action.targetRunnerId === input.current.sourceRunnerId ||
      input.current.targetRunnerId !== null)
  ) {
    return null;
  }
  if (!["pending", "provisioning_target", "failed"].includes(state) && targetRunnerId === null) {
    return null;
  }

  return {
    sourceRunnerId: input.current.sourceRunnerId,
    state,
    generation: input.current.generation + 1,
    targetRunnerId,
    nextAttemptAt: state === "complete" ? null : input.now,
    terminalCode: null,
    terminalSummary: null,
    completedAt: state === "complete" ? input.now : null,
    failedAt: null,
  };
}

export function toSafeRunnerReplacementDto(value: {
  id: string;
  sourceRunnerId: string;
  targetRunnerId: string | null;
  reason: string;
  state: string;
  terminalCode: string | null;
  terminalSummary: string | null;
  startedAt: Date | string;
  completedAt: Date | string | null;
  failedAt: Date | string | null;
}): SafeRunnerReplacementDto | null {
  if (
    !UUID_PATTERN.test(value.id) ||
    !UUID_PATTERN.test(value.sourceRunnerId) ||
    (value.targetRunnerId !== null && !UUID_PATTERN.test(value.targetRunnerId)) ||
    value.targetRunnerId === value.sourceRunnerId ||
    !isRunnerReplacementReason(value.reason) ||
    !isRunnerReplacementState(value.state) ||
    (value.terminalCode !== null && !isRunnerReplacementTerminalCode(value.terminalCode)) ||
    (value.terminalSummary !== null &&
      (value.terminalCode === null ||
        value.terminalSummary !== SAFE_TERMINAL_SUMMARIES[value.terminalCode]))
  ) {
    return null;
  }
  const startedAt = toIso(value.startedAt);
  const completedAt = value.completedAt === null ? null : toIso(value.completedAt);
  const failedAt = value.failedAt === null ? null : toIso(value.failedAt);
  if (
    !startedAt ||
    (value.completedAt !== null && !completedAt) ||
    (value.failedAt !== null && !failedAt) ||
    (value.state === "complete" &&
      (completedAt === null ||
        failedAt !== null ||
        value.terminalCode !== null ||
        value.terminalSummary !== null)) ||
    (value.state === "failed" &&
      (failedAt === null ||
        completedAt !== null ||
        value.terminalCode === null ||
        value.terminalSummary === null)) ||
    (!["complete", "failed"].includes(value.state) &&
      (completedAt !== null ||
        failedAt !== null ||
        value.terminalCode !== null ||
        value.terminalSummary !== null))
  ) {
    return null;
  }
  return {
    id: value.id,
    sourceRunnerId: value.sourceRunnerId,
    targetRunnerId: value.targetRunnerId,
    reason: value.reason,
    state: value.state,
    terminalCode: value.terminalCode,
    terminalSummary: value.terminalSummary,
    startedAt,
    completedAt,
    failedAt,
  };
}

export function isRunnerReplacementState(value: unknown): value is RunnerReplacementState {
  return RUNNER_REPLACEMENT_STATES.includes(value as RunnerReplacementState);
}

export function isRunnerReplacementReason(value: unknown): value is RunnerReplacementReason {
  return RUNNER_REPLACEMENT_REASONS.includes(value as RunnerReplacementReason);
}

export function isRunnerReplacementTerminalCode(
  value: unknown,
): value is RunnerReplacementTerminalCode {
  return RUNNER_REPLACEMENT_TERMINAL_CODES.includes(value as RunnerReplacementTerminalCode);
}

function isCounter(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= MAX_COUNTER;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function toIso(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
