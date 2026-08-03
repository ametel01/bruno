import "server-only";

export const HERMES_STAGING_ACCEPTANCE_PHASES = [
  "preflight",
  "attesting_image",
  "creating_ready_agent",
  "observing_deployment",
  "verifying_host_image",
  "awaiting_initial_human_proof",
  "restarting",
  "reverifying_runtime",
  "awaiting_post_restart_human_proof",
  "auditing_diagnostics",
  "stopping_agent",
  "observing_stop_stability",
  "checking_rollback",
  "cleaning_workload",
  "cleaning_secrets",
  "cleaning_firewall",
  "cleaning_droplet",
  "cleaning_runner",
  "complete",
] as const;

export type HermesStagingAcceptancePhase = (typeof HERMES_STAGING_ACCEPTANCE_PHASES)[number];

export const HERMES_STAGING_ACCEPTANCE_ERROR_CODES = [
  "invalid_begin",
  "preflight_failed",
  "image_attestation_failed",
  "agent_creation_failed",
  "deployment_failed",
  "deployment_stage_invalid",
  "host_image_unverified",
  "initial_human_proof_failed",
  "post_restart_human_proof_failed",
  "human_proof_expired",
  "restart_failed",
  "runtime_reverification_failed",
  "diagnostics_unsafe",
  "stop_failed",
  "rollback_failed",
  "acceptance_deadline_exceeded",
  "acceptance_cancelled",
  "cleanup_failed",
  "internal_state_invalid",
] as const;

export type HermesStagingAcceptanceErrorCode =
  (typeof HERMES_STAGING_ACCEPTANCE_ERROR_CODES)[number];

const HERMES_STAGING_ACCEPTANCE_PHASE_SET = new Set<string>(HERMES_STAGING_ACCEPTANCE_PHASES);
const HERMES_STAGING_ACCEPTANCE_ERROR_CODE_SET = new Set<string>(
  HERMES_STAGING_ACCEPTANCE_ERROR_CODES,
);

export const HERMES_STAGING_ACCEPTANCE_BACKOFF_MS = [
  15_000, 30_000, 60_000, 120_000, 300_000,
] as const;
export const HERMES_STAGING_HUMAN_CHALLENGE_MAX_TTL_MS = 5 * 60_000;
export const HERMES_STAGING_STOP_STABILITY_MS = 60_000;
export const HERMES_STAGING_MAX_DURATION_MS = 2 * 60 * 60_000;
export const HERMES_STAGING_MAX_CLEANUP_DURATION_MS = 2 * 60 * 60_000;
export const HERMES_STAGING_MAX_COUNTER = 2_147_483_647;

export const HERMES_STAGING_DEPLOYMENT_STAGES = [
  "pending",
  "provisioning_runner",
  "configuring_hermes",
  "starting_gateway",
  "verifying_model",
  "connecting_telegram",
  "ready",
] as const;

export type HermesStagingDeploymentStage = (typeof HERMES_STAGING_DEPLOYMENT_STAGES)[number];

export type HermesStagingCleanupResource =
  | "workload"
  | "secrets"
  | "firewall"
  | "droplet"
  | "runner";

export type HermesStagingAcceptanceEffectKind =
  | "preflight"
  | "attest_published_image"
  | "create_ready_agent"
  | "observe_agent_creation"
  | "observe_next_deployment_stage"
  | "verify_strict_host_image"
  | "issue_initial_human_challenge"
  | "observe_initial_human_challenge"
  | "restart_agent"
  | "observe_agent_restart"
  | "verify_restarted_image_and_telegram"
  | "issue_post_restart_human_challenge"
  | "observe_post_restart_human_challenge"
  | "audit_safe_diagnostics"
  | "stop_agent_db_first"
  | "observe_stop_intent"
  | "observe_stop_stability"
  | "verify_manual_rollback"
  | "cleanup_workload"
  | "observe_workload_absence"
  | "cleanup_secrets"
  | "observe_secrets_absence"
  | "cleanup_firewall"
  | "observe_firewall_absence"
  | "cleanup_droplet"
  | "observe_droplet_absence"
  | "cleanup_runner"
  | "observe_runner_absence";

export type HermesStagingAcceptanceEffect = {
  kind: HermesStagingAcceptanceEffectKind;
};

type ConfirmationResult<Effect extends HermesStagingAcceptanceEffectKind> = {
  effect: Effect;
  outcome: "confirmed" | "failed" | "unknown";
};

type ChallengeIssueResult<
  Effect extends
    | "issue_initial_human_challenge"
    | "issue_post_restart_human_challenge"
    | "observe_initial_human_challenge"
    | "observe_post_restart_human_challenge",
  Success extends "issued" | "found",
> =
  | {
      effect: Effect;
      outcome: Success;
      challengeDigest: string;
      expiresAtMs: number;
    }
  | { effect: Effect; outcome: "failed" | "missing" | "conflict" | "unknown" };

type CleanupResult<Effect extends HermesStagingAcceptanceEffectKind> = {
  effect: Effect;
  outcome: "accepted" | "failed" | "unknown";
};

type AbsenceResult<Effect extends HermesStagingAcceptanceEffectKind> = {
  effect: Effect;
  outcome: "absent" | "present" | "unknown";
};

export type HermesStagingAcceptanceEffectResult =
  | ConfirmationResult<"preflight">
  | ConfirmationResult<"attest_published_image">
  | {
      effect: "create_ready_agent";
      outcome: "accepted" | "failed" | "unknown";
    }
  | {
      effect: "observe_agent_creation";
      outcome: "found" | "absent" | "conflict" | "unknown";
    }
  | (
      | {
          effect: "observe_next_deployment_stage";
          outcome: "observed";
          stage: HermesStagingDeploymentStage;
        }
      | {
          effect: "observe_next_deployment_stage";
          outcome: "failed" | "unknown";
        }
    )
  | {
      effect: "verify_strict_host_image";
      outcome: "exact_ready" | "not_ready" | "mismatch" | "unknown";
    }
  | ChallengeIssueResult<"issue_initial_human_challenge", "issued">
  | ChallengeIssueResult<"observe_initial_human_challenge", "found">
  | {
      effect: "restart_agent";
      outcome: "accepted" | "failed" | "unknown";
    }
  | {
      effect: "observe_agent_restart";
      outcome: "completed" | "not_applied" | "conflict" | "unknown";
    }
  | {
      effect: "verify_restarted_image_and_telegram";
      outcome: "exact_ready" | "not_ready" | "mismatch" | "unknown";
    }
  | ChallengeIssueResult<"issue_post_restart_human_challenge", "issued">
  | ChallengeIssueResult<"observe_post_restart_human_challenge", "found">
  | {
      effect: "audit_safe_diagnostics";
      outcome: "safe" | "unsafe" | "unknown";
    }
  | {
      effect: "stop_agent_db_first";
      outcome: "accepted" | "failed" | "unknown";
    }
  | {
      effect: "observe_stop_intent";
      outcome: "desired_stopped" | "desired_running" | "conflict" | "unknown";
    }
  | {
      effect: "observe_stop_stability";
      outcome: "stopped" | "active" | "unknown";
    }
  | {
      effect: "verify_manual_rollback";
      outcome: "passed" | "failed" | "unknown";
    }
  | CleanupResult<
      | "cleanup_workload"
      | "cleanup_secrets"
      | "cleanup_firewall"
      | "cleanup_droplet"
      | "cleanup_runner"
    >
  | AbsenceResult<
      | "observe_workload_absence"
      | "observe_secrets_absence"
      | "observe_firewall_absence"
      | "observe_droplet_absence"
      | "observe_runner_absence"
    >;

export type HermesStagingAcceptanceInput =
  | {
      kind: "begin";
      generation: number;
      nowMs: number;
      deadlineAtMs: number;
      cleanupDeadlineAtMs: number;
    }
  | { kind: "tick"; generation: number; nowMs: number }
  | { kind: "cancel"; generation: number; nowMs: number }
  | {
      kind: "effect_result";
      generation: number;
      nowMs: number;
      result: HermesStagingAcceptanceEffectResult;
    }
  | {
      kind: "human_attestation";
      generation: number;
      nowMs: number;
      proof: "initial" | "post_restart";
      challengeDigest: string;
      attestationDigest: string;
    };

export type HermesStagingAcceptanceTerminalOutcome = "succeeded" | "failed" | "cancelled";

export type HermesStagingAcceptanceState = {
  phase: HermesStagingAcceptancePhase;
  generation: number;
  desiredOutcome: "acceptance" | "cleanup";
  terminalOutcome: HermesStagingAcceptanceTerminalOutcome | null;
  errorCode: HermesStagingAcceptanceErrorCode | null;
  deadlineAtMs: number;
  cleanupDeadlineAtMs: number;
  attemptCount: number;
  nextAttemptAtMs: number | null;
  pendingEffect: HermesStagingAcceptanceEffectKind | null;
  deploymentStageIndex: number;
  initialChallengeDigest: string | null;
  initialChallengeExpiresAtMs: number | null;
  initialAttestationDigest: string | null;
  postRestartChallengeDigest: string | null;
  postRestartChallengeExpiresAtMs: number | null;
  postRestartAttestationDigest: string | null;
  stopStableSinceMs: number | null;
  cleanupConfirmed: Readonly<Record<HermesStagingCleanupResource, boolean>>;
};

export type HermesStagingAcceptanceDecision =
  | { kind: "effect"; effect: HermesStagingAcceptanceEffect }
  | {
      kind: "wait";
      untilMs: number;
      reason: "effect_pending" | "retry_backoff" | "human_proof" | "stop_stability";
    }
  | {
      kind: "ignored";
      reason:
        | "no_state"
        | "duplicate_begin"
        | "stale_generation"
        | "unexpected_input"
        | "unexpected_effect_result";
    }
  | { kind: "rejected"; code: "invalid_begin" }
  | { kind: "blocked"; code: "cleanup_failed" }
  | {
      kind: "complete";
      outcome: HermesStagingAcceptanceTerminalOutcome;
      errorCode: HermesStagingAcceptanceErrorCode | null;
    };

export type HermesStagingAcceptancePlan = {
  state: HermesStagingAcceptanceState | null;
  decision: HermesStagingAcceptanceDecision;
};

export function parseHermesStagingAcceptancePhase(
  value: unknown,
): HermesStagingAcceptancePhase | null {
  return typeof value === "string" && HERMES_STAGING_ACCEPTANCE_PHASE_SET.has(value)
    ? (value as HermesStagingAcceptancePhase)
    : null;
}

export function parseHermesStagingAcceptanceErrorCode(
  value: unknown,
): HermesStagingAcceptanceErrorCode | null {
  return typeof value === "string" && HERMES_STAGING_ACCEPTANCE_ERROR_CODE_SET.has(value)
    ? (value as HermesStagingAcceptanceErrorCode)
    : null;
}

const CLEANUP_ORDER: readonly HermesStagingCleanupResource[] = [
  "workload",
  "secrets",
  "firewall",
  "droplet",
  "runner",
];

const CLEANUP_PHASE: Readonly<Record<HermesStagingCleanupResource, HermesStagingAcceptancePhase>> =
  {
    workload: "cleaning_workload",
    secrets: "cleaning_secrets",
    firewall: "cleaning_firewall",
    droplet: "cleaning_droplet",
    runner: "cleaning_runner",
  };

const CLEANUP_EFFECT: Readonly<
  Record<HermesStagingCleanupResource, HermesStagingAcceptanceEffectKind>
> = {
  workload: "cleanup_workload",
  secrets: "cleanup_secrets",
  firewall: "cleanup_firewall",
  droplet: "cleanup_droplet",
  runner: "cleanup_runner",
};

const ABSENCE_EFFECT: Readonly<
  Record<HermesStagingCleanupResource, HermesStagingAcceptanceEffectKind>
> = {
  workload: "observe_workload_absence",
  secrets: "observe_secrets_absence",
  firewall: "observe_firewall_absence",
  droplet: "observe_droplet_absence",
  runner: "observe_runner_absence",
};

const MUTATION_OBSERVER: Partial<
  Readonly<Record<HermesStagingAcceptanceEffectKind, HermesStagingAcceptanceEffectKind>>
> = {
  create_ready_agent: "observe_agent_creation",
  issue_initial_human_challenge: "observe_initial_human_challenge",
  restart_agent: "observe_agent_restart",
  issue_post_restart_human_challenge: "observe_post_restart_human_challenge",
  stop_agent_db_first: "observe_stop_intent",
  cleanup_workload: "observe_workload_absence",
  cleanup_secrets: "observe_secrets_absence",
  cleanup_firewall: "observe_firewall_absence",
  cleanup_droplet: "observe_droplet_absence",
  cleanup_runner: "observe_runner_absence",
};

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function planHermesStagingAcceptance(input: {
  state: HermesStagingAcceptanceState | null;
  input: HermesStagingAcceptanceInput;
}): HermesStagingAcceptancePlan {
  if (input.state === null) {
    return beginAcceptance(input.input);
  }

  let state = input.state;
  const command = input.input;

  if (command.kind === "begin") {
    return ignored(state, "duplicate_begin");
  }

  if (command.generation !== state.generation) {
    return ignored(state, "stale_generation");
  }

  if (state.phase === "complete") {
    return completed(state);
  }

  if (state.desiredOutcome === "cleanup" && !isCleanupPhase(state.phase)) {
    state = enterCleanup(
      state,
      state.terminalOutcome ?? "failed",
      state.errorCode ?? "internal_state_invalid",
    );
  }

  if (
    state.desiredOutcome === "cleanup" &&
    command.nowMs >= state.cleanupDeadlineAtMs &&
    CLEANUP_ORDER.some((resource) => !state.cleanupConfirmed[resource])
  ) {
    return {
      state: { ...state, pendingEffect: null, nextAttemptAtMs: null },
      decision: { kind: "blocked", code: "cleanup_failed" },
    };
  }

  if (command.kind === "cancel") {
    state = enterCleanup(state, "cancelled", "acceptance_cancelled");
    return issueForCurrentPhase(state, command.nowMs);
  }

  if (state.desiredOutcome === "acceptance" && command.nowMs >= state.deadlineAtMs) {
    state = enterCleanup(state, "failed", "acceptance_deadline_exceeded");
    return issueForCurrentPhase(state, command.nowMs);
  }

  const expiredProof = expiredHumanProof(state, command.nowMs);
  if (expiredProof !== null) {
    state = enterCleanup(state, "failed", expiredProof);
    return issueForCurrentPhase(state, command.nowMs);
  }

  if (command.kind === "human_attestation") {
    return applyHumanAttestation(state, command);
  }

  if (command.kind === "effect_result") {
    if (state.pendingEffect !== command.result.effect) {
      return ignored(state, "unexpected_effect_result");
    }

    state = { ...state, pendingEffect: null, nextAttemptAtMs: null };
    return applyEffectResult(state, command.result, command.nowMs);
  }

  return planTick(state, command.nowMs);
}

function beginAcceptance(input: HermesStagingAcceptanceInput): HermesStagingAcceptancePlan {
  if (input.kind !== "begin") {
    return { state: null, decision: { kind: "ignored", reason: "no_state" } };
  }

  if (
    !isCounter(input.generation) ||
    !isTimestamp(input.nowMs) ||
    !isTimestamp(input.deadlineAtMs) ||
    !isTimestamp(input.cleanupDeadlineAtMs) ||
    input.deadlineAtMs <= input.nowMs ||
    input.deadlineAtMs - input.nowMs > HERMES_STAGING_MAX_DURATION_MS ||
    input.cleanupDeadlineAtMs <= input.deadlineAtMs ||
    input.cleanupDeadlineAtMs - input.deadlineAtMs > HERMES_STAGING_MAX_CLEANUP_DURATION_MS
  ) {
    return { state: null, decision: { kind: "rejected", code: "invalid_begin" } };
  }

  const state: HermesStagingAcceptanceState = {
    phase: "preflight",
    generation: input.generation,
    desiredOutcome: "acceptance",
    terminalOutcome: null,
    errorCode: null,
    deadlineAtMs: input.deadlineAtMs,
    cleanupDeadlineAtMs: input.cleanupDeadlineAtMs,
    attemptCount: 0,
    nextAttemptAtMs: null,
    pendingEffect: null,
    deploymentStageIndex: -1,
    initialChallengeDigest: null,
    initialChallengeExpiresAtMs: null,
    initialAttestationDigest: null,
    postRestartChallengeDigest: null,
    postRestartChallengeExpiresAtMs: null,
    postRestartAttestationDigest: null,
    stopStableSinceMs: null,
    cleanupConfirmed: {
      workload: false,
      secrets: false,
      firewall: false,
      droplet: false,
      runner: false,
    },
  };

  return issueEffect(state, "preflight", input.nowMs);
}

function planTick(state: HermesStagingAcceptanceState, nowMs: number): HermesStagingAcceptancePlan {
  if (state.nextAttemptAtMs !== null && nowMs < state.nextAttemptAtMs) {
    return {
      state,
      decision: {
        kind: "wait",
        untilMs: state.nextAttemptAtMs,
        reason: state.pendingEffect === null ? waitReason(state) : "effect_pending",
      },
    };
  }

  if (state.pendingEffect !== null) {
    const observer = MUTATION_OBSERVER[state.pendingEffect];
    return issueEffect(
      { ...state, pendingEffect: null, nextAttemptAtMs: null },
      observer ?? state.pendingEffect,
      nowMs,
    );
  }

  return issueForCurrentPhase(state, nowMs);
}

function issueForCurrentPhase(
  state: HermesStagingAcceptanceState,
  nowMs: number,
): HermesStagingAcceptancePlan {
  switch (state.phase) {
    case "preflight":
      return issueEffect(state, "preflight", nowMs);
    case "attesting_image":
      return issueEffect(state, "attest_published_image", nowMs);
    case "creating_ready_agent":
      return issueEffect(state, "create_ready_agent", nowMs);
    case "observing_deployment":
      return issueEffect(state, "observe_next_deployment_stage", nowMs);
    case "verifying_host_image":
      return issueEffect(state, "verify_strict_host_image", nowMs);
    case "awaiting_initial_human_proof":
      if (state.initialChallengeDigest === null) {
        return issueEffect(state, "issue_initial_human_challenge", nowMs);
      }
      return humanProofWait(state, nowMs, state.initialChallengeExpiresAtMs);
    case "restarting":
      return issueEffect(state, "restart_agent", nowMs);
    case "reverifying_runtime":
      return issueEffect(state, "verify_restarted_image_and_telegram", nowMs);
    case "awaiting_post_restart_human_proof":
      if (state.postRestartChallengeDigest === null) {
        return issueEffect(state, "issue_post_restart_human_challenge", nowMs);
      }
      return humanProofWait(state, nowMs, state.postRestartChallengeExpiresAtMs);
    case "auditing_diagnostics":
      return issueEffect(state, "audit_safe_diagnostics", nowMs);
    case "stopping_agent":
      return issueEffect(state, "stop_agent_db_first", nowMs);
    case "observing_stop_stability":
      return issueEffect(state, "observe_stop_stability", nowMs);
    case "checking_rollback":
      return issueEffect(state, "verify_manual_rollback", nowMs);
    case "cleaning_workload":
    case "cleaning_secrets":
    case "cleaning_firewall":
    case "cleaning_droplet":
    case "cleaning_runner": {
      const resource = cleanupResourceForPhase(state.phase);
      if (resource === null) {
        return issueForCurrentPhase(enterCleanup(state, "failed", "internal_state_invalid"), nowMs);
      }
      return issueEffect(state, CLEANUP_EFFECT[resource], nowMs);
    }
    case "complete":
      return completed(state);
  }
}

function applyEffectResult(
  state: HermesStagingAcceptanceState,
  result: HermesStagingAcceptanceEffectResult,
  nowMs: number,
): HermesStagingAcceptancePlan {
  switch (result.effect) {
    case "preflight":
      return applyConfirmation(state, result.outcome, nowMs, "attesting_image", "preflight_failed");
    case "attest_published_image":
      return applyConfirmation(
        state,
        result.outcome,
        nowMs,
        "creating_ready_agent",
        "image_attestation_failed",
      );
    case "create_ready_agent":
      if (result.outcome === "accepted") {
        return transition(state, "observing_deployment", nowMs);
      }
      if (result.outcome === "failed") {
        return failAcceptance(state, nowMs, "agent_creation_failed");
      }
      return retryUnknown(state, result.effect, nowMs);
    case "observe_agent_creation":
      if (result.outcome === "found") {
        return transition(state, "observing_deployment", nowMs);
      }
      if (result.outcome === "absent") {
        return retryPhase(state, nowMs);
      }
      if (result.outcome === "conflict") {
        return failAcceptance(state, nowMs, "agent_creation_failed");
      }
      return retryUnknown(state, result.effect, nowMs);
    case "observe_next_deployment_stage":
      return applyDeploymentObservation(state, result, nowMs);
    case "verify_strict_host_image":
      if (result.outcome === "exact_ready") {
        return transition(state, "awaiting_initial_human_proof", nowMs);
      }
      if (result.outcome === "mismatch") {
        return failAcceptance(state, nowMs, "host_image_unverified");
      }
      return retryUnknown(state, result.effect, nowMs);
    case "issue_initial_human_challenge":
    case "observe_initial_human_challenge":
      return applyChallengeResult(state, result, nowMs, "initial");
    case "restart_agent":
      if (result.outcome === "accepted") {
        return transition(state, "reverifying_runtime", nowMs);
      }
      if (result.outcome === "failed") {
        return failAcceptance(state, nowMs, "restart_failed");
      }
      return retryUnknown(state, result.effect, nowMs);
    case "observe_agent_restart":
      if (result.outcome === "completed") {
        return transition(state, "reverifying_runtime", nowMs);
      }
      if (result.outcome === "not_applied") {
        return retryPhase(state, nowMs);
      }
      if (result.outcome === "conflict") {
        return failAcceptance(state, nowMs, "restart_failed");
      }
      return retryUnknown(state, result.effect, nowMs);
    case "verify_restarted_image_and_telegram":
      if (result.outcome === "exact_ready") {
        return transition(state, "awaiting_post_restart_human_proof", nowMs);
      }
      if (result.outcome === "mismatch") {
        return failAcceptance(state, nowMs, "runtime_reverification_failed");
      }
      return retryUnknown(state, result.effect, nowMs);
    case "issue_post_restart_human_challenge":
    case "observe_post_restart_human_challenge":
      return applyChallengeResult(state, result, nowMs, "post_restart");
    case "audit_safe_diagnostics":
      if (result.outcome === "safe") {
        return transition(state, "stopping_agent", nowMs);
      }
      if (result.outcome === "unsafe") {
        return failAcceptance(state, nowMs, "diagnostics_unsafe");
      }
      return retryUnknown(state, result.effect, nowMs);
    case "stop_agent_db_first":
      if (result.outcome === "accepted") {
        return transition(state, "observing_stop_stability", nowMs);
      }
      if (result.outcome === "failed") {
        return failAcceptance(state, nowMs, "stop_failed");
      }
      return retryUnknown(state, result.effect, nowMs);
    case "observe_stop_intent":
      if (result.outcome === "desired_stopped") {
        return transition(state, "observing_stop_stability", nowMs);
      }
      if (result.outcome === "desired_running") {
        return retryPhase(state, nowMs);
      }
      if (result.outcome === "conflict") {
        return failAcceptance(state, nowMs, "stop_failed");
      }
      return retryUnknown(state, result.effect, nowMs);
    case "observe_stop_stability":
      return applyStopObservation(state, result.outcome, nowMs);
    case "verify_manual_rollback":
      if (result.outcome === "passed") {
        return issueForCurrentPhase(enterCleanup(state, "succeeded", null), nowMs);
      }
      if (result.outcome === "failed") {
        return failAcceptance(state, nowMs, "rollback_failed");
      }
      return retryUnknown(state, result.effect, nowMs);
    case "cleanup_workload":
    case "cleanup_secrets":
    case "cleanup_firewall":
    case "cleanup_droplet":
    case "cleanup_runner":
      return applyCleanupResult(state, result.effect, result.outcome, nowMs);
    case "observe_workload_absence":
    case "observe_secrets_absence":
    case "observe_firewall_absence":
    case "observe_droplet_absence":
    case "observe_runner_absence":
      return applyAbsenceResult(state, result.effect, result.outcome, nowMs);
  }
}

function applyConfirmation(
  state: HermesStagingAcceptanceState,
  outcome: "confirmed" | "failed" | "unknown",
  nowMs: number,
  nextPhase: HermesStagingAcceptancePhase,
  errorCode: HermesStagingAcceptanceErrorCode,
): HermesStagingAcceptancePlan {
  if (outcome === "confirmed") {
    return transition(state, nextPhase, nowMs);
  }
  if (outcome === "failed") {
    return failAcceptance(state, nowMs, errorCode);
  }
  return retryUnknown(state, effectForPhase(state.phase), nowMs);
}

function applyDeploymentObservation(
  state: HermesStagingAcceptanceState,
  result: Extract<HermesStagingAcceptanceEffectResult, { effect: "observe_next_deployment_stage" }>,
  nowMs: number,
): HermesStagingAcceptancePlan {
  if (result.outcome !== "observed") {
    return result.outcome === "failed"
      ? failAcceptance(state, nowMs, "deployment_failed")
      : retryUnknown(state, result.effect, nowMs);
  }

  const observedIndex = HERMES_STAGING_DEPLOYMENT_STAGES.indexOf(result.stage);
  const expectedIndex = state.deploymentStageIndex + 1;

  if (observedIndex === state.deploymentStageIndex) {
    return retryPhase(state, nowMs);
  }
  if (observedIndex !== expectedIndex) {
    return failAcceptance(state, nowMs, "deployment_stage_invalid");
  }

  const advanced = { ...state, deploymentStageIndex: observedIndex };
  if (result.stage === "ready") {
    return transition(advanced, "verifying_host_image", nowMs);
  }
  return transition(advanced, "observing_deployment", nowMs);
}

function applyChallengeResult(
  state: HermesStagingAcceptanceState,
  result:
    | ChallengeIssueResult<"issue_initial_human_challenge", "issued">
    | ChallengeIssueResult<"observe_initial_human_challenge", "found">
    | ChallengeIssueResult<"issue_post_restart_human_challenge", "issued">
    | ChallengeIssueResult<"observe_post_restart_human_challenge", "found">,
  nowMs: number,
  proof: "initial" | "post_restart",
): HermesStagingAcceptancePlan {
  if (result.outcome !== "issued" && result.outcome !== "found") {
    if (result.outcome === "failed" || result.outcome === "conflict") {
      return failAcceptance(
        state,
        nowMs,
        proof === "initial" ? "initial_human_proof_failed" : "post_restart_human_proof_failed",
      );
    }
    if (result.outcome === "missing") {
      return retryPhase(state, nowMs);
    }
    return retryUnknown(state, result.effect, nowMs);
  }

  if (
    !isDigest(result.challengeDigest) ||
    !isTimestamp(result.expiresAtMs) ||
    result.expiresAtMs <= nowMs ||
    result.expiresAtMs > nowMs + HERMES_STAGING_HUMAN_CHALLENGE_MAX_TTL_MS ||
    result.expiresAtMs > state.deadlineAtMs ||
    (proof === "post_restart" && result.challengeDigest === state.initialChallengeDigest)
  ) {
    return failAcceptance(
      state,
      nowMs,
      proof === "initial" ? "initial_human_proof_failed" : "post_restart_human_proof_failed",
    );
  }

  const challenged =
    proof === "initial"
      ? {
          ...state,
          initialChallengeDigest: result.challengeDigest,
          initialChallengeExpiresAtMs: result.expiresAtMs,
        }
      : {
          ...state,
          postRestartChallengeDigest: result.challengeDigest,
          postRestartChallengeExpiresAtMs: result.expiresAtMs,
        };

  return humanProofWait(challenged, nowMs, result.expiresAtMs);
}

function applyHumanAttestation(
  state: HermesStagingAcceptanceState,
  input: Extract<HermesStagingAcceptanceInput, { kind: "human_attestation" }>,
): HermesStagingAcceptancePlan {
  const initial = input.proof === "initial";
  const expectedPhase = initial
    ? "awaiting_initial_human_proof"
    : "awaiting_post_restart_human_proof";
  if (state.phase !== expectedPhase || state.pendingEffect !== null) {
    return ignored(state, "unexpected_input");
  }

  const expectedChallenge = initial
    ? state.initialChallengeDigest
    : state.postRestartChallengeDigest;
  const expiresAtMs = initial
    ? state.initialChallengeExpiresAtMs
    : state.postRestartChallengeExpiresAtMs;
  const priorAttestation = initial ? null : state.initialAttestationDigest;

  if (
    expectedChallenge === null ||
    expiresAtMs === null ||
    input.nowMs >= expiresAtMs ||
    input.challengeDigest !== expectedChallenge ||
    !isDigest(input.attestationDigest) ||
    input.attestationDigest === expectedChallenge ||
    input.attestationDigest === priorAttestation
  ) {
    return failAcceptance(
      state,
      input.nowMs,
      initial ? "initial_human_proof_failed" : "post_restart_human_proof_failed",
    );
  }

  if (initial) {
    return transition(
      { ...state, initialAttestationDigest: input.attestationDigest },
      "restarting",
      input.nowMs,
    );
  }

  return transition(
    { ...state, postRestartAttestationDigest: input.attestationDigest },
    "auditing_diagnostics",
    input.nowMs,
  );
}

function applyStopObservation(
  state: HermesStagingAcceptanceState,
  outcome: "stopped" | "active" | "unknown",
  nowMs: number,
): HermesStagingAcceptancePlan {
  if (outcome === "unknown") {
    return retryUnknown({ ...state, stopStableSinceMs: null }, "observe_stop_stability", nowMs);
  }
  if (outcome === "active") {
    return retryPhase({ ...state, stopStableSinceMs: null }, nowMs);
  }

  if (state.stopStableSinceMs === null) {
    const stable = { ...state, stopStableSinceMs: nowMs };
    return wait(stable, nowMs, "stop_stability");
  }

  if (nowMs - state.stopStableSinceMs < HERMES_STAGING_STOP_STABILITY_MS) {
    return wait(state, nowMs, "stop_stability");
  }

  return transition(state, "checking_rollback", nowMs);
}

function applyCleanupResult(
  state: HermesStagingAcceptanceState,
  effect: Extract<
    HermesStagingAcceptanceEffectKind,
    | "cleanup_workload"
    | "cleanup_secrets"
    | "cleanup_firewall"
    | "cleanup_droplet"
    | "cleanup_runner"
  >,
  outcome: "accepted" | "failed" | "unknown",
  nowMs: number,
): HermesStagingAcceptancePlan {
  const resource = resourceForCleanupEffect(effect);
  if (resource === null || CLEANUP_PHASE[resource] !== state.phase) {
    return failCleanupState(state, nowMs);
  }

  if (outcome === "accepted") {
    return issueEffect(state, ABSENCE_EFFECT[resource], nowMs);
  }
  if (outcome === "unknown") {
    return retryUnknown(state, effect, nowMs);
  }
  return retryCleanupFailure(state, nowMs);
}

function applyAbsenceResult(
  state: HermesStagingAcceptanceState,
  effect: Extract<
    HermesStagingAcceptanceEffectKind,
    | "observe_workload_absence"
    | "observe_secrets_absence"
    | "observe_firewall_absence"
    | "observe_droplet_absence"
    | "observe_runner_absence"
  >,
  outcome: "absent" | "present" | "unknown",
  nowMs: number,
): HermesStagingAcceptancePlan {
  const resource = resourceForAbsenceEffect(effect);
  if (resource === null || CLEANUP_PHASE[resource] !== state.phase) {
    return failCleanupState(state, nowMs);
  }

  if (outcome === "unknown") {
    return retryUnknown(state, effect, nowMs);
  }
  if (outcome === "present") {
    return retryPhase(state, nowMs);
  }

  const cleanupConfirmed = { ...state.cleanupConfirmed, [resource]: true };
  const advanced = { ...state, cleanupConfirmed, attemptCount: 0 };
  const nextResource = CLEANUP_ORDER.find((candidate) => !cleanupConfirmed[candidate]);

  if (nextResource !== undefined) {
    return issueForCurrentPhase({ ...advanced, phase: CLEANUP_PHASE[nextResource] }, nowMs);
  }

  const complete = {
    ...advanced,
    phase: "complete" as const,
    pendingEffect: null,
    nextAttemptAtMs: null,
    terminalOutcome: advanced.terminalOutcome ?? "failed",
    errorCode: advanced.terminalOutcome === null ? "internal_state_invalid" : advanced.errorCode,
  };
  return completed(complete);
}

function transition(
  state: HermesStagingAcceptanceState,
  phase: HermesStagingAcceptancePhase,
  nowMs: number,
): HermesStagingAcceptancePlan {
  return issueForCurrentPhase(
    {
      ...state,
      phase,
      attemptCount: 0,
      nextAttemptAtMs: null,
      pendingEffect: null,
      ...(phase === "observing_stop_stability" ? { stopStableSinceMs: null } : {}),
    },
    nowMs,
  );
}

function failAcceptance(
  state: HermesStagingAcceptanceState,
  nowMs: number,
  errorCode: HermesStagingAcceptanceErrorCode,
): HermesStagingAcceptancePlan {
  return issueForCurrentPhase(enterCleanup(state, "failed", errorCode), nowMs);
}

function enterCleanup(
  state: HermesStagingAcceptanceState,
  outcome: HermesStagingAcceptanceTerminalOutcome,
  errorCode: HermesStagingAcceptanceErrorCode | null,
): HermesStagingAcceptanceState {
  const alreadyCleaning = state.desiredOutcome === "cleanup" && isCleanupPhase(state.phase);
  const currentOutcome = state.terminalOutcome;
  const terminalOutcome =
    currentOutcome === "succeeded" && outcome === "failed" ? "failed" : (currentOutcome ?? outcome);
  const preservedError =
    terminalOutcome === "succeeded"
      ? null
      : (state.errorCode ?? errorCode ?? "internal_state_invalid");
  const nextResource = CLEANUP_ORDER.find((resource) => !state.cleanupConfirmed[resource]);

  return {
    ...state,
    phase: nextResource === undefined ? "complete" : CLEANUP_PHASE[nextResource],
    desiredOutcome: "cleanup",
    terminalOutcome,
    errorCode: preservedError,
    attemptCount: alreadyCleaning ? state.attemptCount : 0,
    nextAttemptAtMs: null,
    pendingEffect: null,
    stopStableSinceMs: null,
  };
}

function retryUnknown(
  state: HermesStagingAcceptanceState,
  effect: HermesStagingAcceptanceEffectKind,
  nowMs: number,
): HermesStagingAcceptancePlan {
  const retryState = {
    ...state,
    pendingEffect: effect,
    nextAttemptAtMs: nowMs + backoffMs(state.attemptCount),
  };
  return {
    state: retryState,
    decision: {
      kind: "wait",
      untilMs: retryState.nextAttemptAtMs,
      reason: "retry_backoff",
    },
  };
}

function retryPhase(
  state: HermesStagingAcceptanceState,
  nowMs: number,
): HermesStagingAcceptancePlan {
  const retryState = {
    ...state,
    nextAttemptAtMs: nowMs + backoffMs(state.attemptCount),
    pendingEffect: null,
  };
  return {
    state: retryState,
    decision: {
      kind: "wait",
      untilMs: retryState.nextAttemptAtMs,
      reason: "retry_backoff",
    },
  };
}

function retryCleanupFailure(
  state: HermesStagingAcceptanceState,
  nowMs: number,
): HermesStagingAcceptancePlan {
  const failed = enterCleanup(state, "failed", "cleanup_failed");
  return retryPhase(failed, nowMs);
}

function failCleanupState(
  state: HermesStagingAcceptanceState,
  nowMs: number,
): HermesStagingAcceptancePlan {
  return issueForCurrentPhase(enterCleanup(state, "failed", "internal_state_invalid"), nowMs);
}

function issueEffect(
  state: HermesStagingAcceptanceState,
  effect: HermesStagingAcceptanceEffectKind,
  nowMs: number,
): HermesStagingAcceptancePlan {
  const attemptCount = Math.min(state.attemptCount + 1, HERMES_STAGING_MAX_COUNTER);
  return {
    state: {
      ...state,
      attemptCount,
      pendingEffect: effect,
      nextAttemptAtMs: nowMs + backoffMs(attemptCount),
    },
    decision: { kind: "effect", effect: { kind: effect } },
  };
}

function wait(
  state: HermesStagingAcceptanceState,
  nowMs: number,
  reason: "human_proof" | "stop_stability",
): HermesStagingAcceptancePlan {
  const fixedLimit =
    reason === "human_proof"
      ? state.phase === "awaiting_initial_human_proof"
        ? state.initialChallengeExpiresAtMs
        : state.postRestartChallengeExpiresAtMs
      : state.stopStableSinceMs === null
        ? null
        : state.stopStableSinceMs + HERMES_STAGING_STOP_STABILITY_MS;
  const untilMs = Math.min(
    nowMs + backoffMs(state.attemptCount + 1),
    fixedLimit ?? nowMs + HERMES_STAGING_ACCEPTANCE_BACKOFF_MS[0],
  );
  const waiting = { ...state, nextAttemptAtMs: untilMs, pendingEffect: null };
  return { state: waiting, decision: { kind: "wait", untilMs, reason } };
}

function humanProofWait(
  state: HermesStagingAcceptanceState,
  nowMs: number,
  expiresAtMs: number | null,
): HermesStagingAcceptancePlan {
  if (expiresAtMs === null || nowMs >= expiresAtMs) {
    return failAcceptance(state, nowMs, "human_proof_expired");
  }
  return wait(state, nowMs, "human_proof");
}

function expiredHumanProof(
  state: HermesStagingAcceptanceState,
  nowMs: number,
): HermesStagingAcceptanceErrorCode | null {
  if (
    state.phase === "awaiting_initial_human_proof" &&
    state.initialChallengeExpiresAtMs !== null &&
    nowMs >= state.initialChallengeExpiresAtMs
  ) {
    return "human_proof_expired";
  }
  if (
    state.phase === "awaiting_post_restart_human_proof" &&
    state.postRestartChallengeExpiresAtMs !== null &&
    nowMs >= state.postRestartChallengeExpiresAtMs
  ) {
    return "human_proof_expired";
  }
  return null;
}

function completed(state: HermesStagingAcceptanceState): HermesStagingAcceptancePlan {
  const outcome = state.terminalOutcome ?? "failed";
  return {
    state,
    decision: {
      kind: "complete",
      outcome,
      errorCode: outcome === "succeeded" ? null : (state.errorCode ?? "internal_state_invalid"),
    },
  };
}

function ignored(
  state: HermesStagingAcceptanceState,
  reason: Extract<HermesStagingAcceptanceDecision, { kind: "ignored" }>["reason"],
): HermesStagingAcceptancePlan {
  return { state, decision: { kind: "ignored", reason } };
}

function backoffMs(attemptCount: number): number {
  const normalized = isCounter(attemptCount) && attemptCount > 0 ? attemptCount : 1;
  const index = Math.min(normalized - 1, HERMES_STAGING_ACCEPTANCE_BACKOFF_MS.length - 1);
  return HERMES_STAGING_ACCEPTANCE_BACKOFF_MS[index] ?? 300_000;
}

function waitReason(
  state: HermesStagingAcceptanceState,
): Extract<HermesStagingAcceptanceDecision, { kind: "wait" }>["reason"] {
  if (
    state.phase === "awaiting_initial_human_proof" ||
    state.phase === "awaiting_post_restart_human_proof"
  ) {
    return "human_proof";
  }
  if (state.phase === "observing_stop_stability" && state.stopStableSinceMs !== null) {
    return "stop_stability";
  }
  return "retry_backoff";
}

function effectForPhase(phase: HermesStagingAcceptancePhase): HermesStagingAcceptanceEffectKind {
  switch (phase) {
    case "preflight":
      return "preflight";
    case "attesting_image":
      return "attest_published_image";
    case "creating_ready_agent":
      return "create_ready_agent";
    case "observing_deployment":
      return "observe_next_deployment_stage";
    case "verifying_host_image":
      return "verify_strict_host_image";
    case "awaiting_initial_human_proof":
      return "issue_initial_human_challenge";
    case "restarting":
      return "restart_agent";
    case "reverifying_runtime":
      return "verify_restarted_image_and_telegram";
    case "awaiting_post_restart_human_proof":
      return "issue_post_restart_human_challenge";
    case "auditing_diagnostics":
      return "audit_safe_diagnostics";
    case "stopping_agent":
      return "stop_agent_db_first";
    case "observing_stop_stability":
      return "observe_stop_stability";
    case "checking_rollback":
      return "verify_manual_rollback";
    case "cleaning_workload":
      return "cleanup_workload";
    case "cleaning_secrets":
      return "cleanup_secrets";
    case "cleaning_firewall":
      return "cleanup_firewall";
    case "cleaning_droplet":
      return "cleanup_droplet";
    case "cleaning_runner":
      return "cleanup_runner";
    case "complete":
      return "observe_runner_absence";
  }
}

function cleanupResourceForPhase(
  phase: HermesStagingAcceptancePhase,
): HermesStagingCleanupResource | null {
  return CLEANUP_ORDER.find((resource) => CLEANUP_PHASE[resource] === phase) ?? null;
}

function resourceForCleanupEffect(
  effect: HermesStagingAcceptanceEffectKind,
): HermesStagingCleanupResource | null {
  return CLEANUP_ORDER.find((resource) => CLEANUP_EFFECT[resource] === effect) ?? null;
}

function resourceForAbsenceEffect(
  effect: HermesStagingAcceptanceEffectKind,
): HermesStagingCleanupResource | null {
  return CLEANUP_ORDER.find((resource) => ABSENCE_EFFECT[resource] === effect) ?? null;
}

function isCleanupPhase(phase: HermesStagingAcceptancePhase): boolean {
  return phase === "complete" || cleanupResourceForPhase(phase) !== null;
}

function isCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= HERMES_STAGING_MAX_COUNTER;
}

function isTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}
