import { describe, expect, it } from "vitest";
import {
  HERMES_STAGING_ACCEPTANCE_BACKOFF_MS,
  HERMES_STAGING_ACCEPTANCE_ERROR_CODES,
  HERMES_STAGING_ACCEPTANCE_PHASES,
  HERMES_STAGING_DEPLOYMENT_STAGES,
  HERMES_STAGING_HUMAN_CHALLENGE_MAX_TTL_MS,
  HERMES_STAGING_STOP_STABILITY_MS,
  parseHermesStagingAcceptanceErrorCode,
  parseHermesStagingAcceptancePhase,
  planHermesStagingAcceptance,
  type HermesStagingAcceptanceEffectKind,
  type HermesStagingAcceptanceEffectResult,
  type HermesStagingAcceptanceInput,
  type HermesStagingAcceptancePlan,
  type HermesStagingAcceptanceState,
} from "@/src/server/staging/hermes-staging-acceptance-state";

const NOW = Date.parse("2026-08-03T10:00:00.000Z");
const DEADLINE = NOW + 60 * 60_000;
const CLEANUP_DEADLINE = DEADLINE + 60 * 60_000;
const GENERATION = 7;
const INITIAL_CHALLENGE = `sha256:${"1".repeat(64)}`;
const INITIAL_ATTESTATION = `sha256:${"2".repeat(64)}`;
const RESTART_CHALLENGE = `sha256:${"3".repeat(64)}`;
const RESTART_ATTESTATION = `sha256:${"4".repeat(64)}`;

function begin(nowMs = NOW): HermesStagingAcceptancePlan {
  return planHermesStagingAcceptance({
    state: null,
    input: {
      kind: "begin",
      generation: GENERATION,
      nowMs,
      deadlineAtMs: DEADLINE,
      cleanupDeadlineAtMs: CLEANUP_DEADLINE,
    },
  });
}

function apply(
  plan: HermesStagingAcceptancePlan,
  result: HermesStagingAcceptanceEffectResult,
  nowMs = NOW,
): HermesStagingAcceptancePlan {
  expect(plan.state).not.toBeNull();
  return planHermesStagingAcceptance({
    state: plan.state,
    input: { kind: "effect_result", generation: GENERATION, nowMs, result },
  });
}

function command(
  plan: HermesStagingAcceptancePlan,
  input: Exclude<HermesStagingAcceptanceInput, { kind: "begin" | "effect_result" }>,
): HermesStagingAcceptancePlan {
  expect(plan.state).not.toBeNull();
  return planHermesStagingAcceptance({ state: plan.state, input });
}

function expectEffect(
  plan: HermesStagingAcceptancePlan,
  effect: HermesStagingAcceptanceEffectKind,
): void {
  expect(plan.decision).toEqual({ kind: "effect", effect: { kind: effect } });
  expect(plan.state?.pendingEffect).toBe(effect);
}

function stateAt(
  phase: HermesStagingAcceptanceState["phase"],
  pendingEffect: HermesStagingAcceptanceEffectKind | null = null,
): HermesStagingAcceptanceState {
  const initial = begin().state;
  if (initial === null) {
    throw new Error("Expected a valid initial policy state.");
  }
  return {
    ...initial,
    phase,
    pendingEffect,
    nextAttemptAtMs: pendingEffect === null ? null : NOW + 15_000,
    attemptCount: pendingEffect === null ? 0 : 1,
  };
}

function effectResult(
  state: HermesStagingAcceptanceState,
  result: HermesStagingAcceptanceEffectResult,
  nowMs = NOW,
): HermesStagingAcceptancePlan {
  return planHermesStagingAcceptance({
    state,
    input: { kind: "effect_result", generation: GENERATION, nowMs, result },
  });
}

function advanceToInitialChallenge(): HermesStagingAcceptancePlan {
  let plan = begin();
  plan = apply(plan, { effect: "preflight", outcome: "confirmed" });
  plan = apply(plan, { effect: "attest_published_image", outcome: "confirmed" });
  plan = apply(plan, { effect: "create_ready_agent", outcome: "accepted" });
  for (const stage of HERMES_STAGING_DEPLOYMENT_STAGES) {
    plan = apply(plan, {
      effect: "observe_next_deployment_stage",
      outcome: "observed",
      stage,
    });
  }
  return apply(plan, { effect: "verify_strict_host_image", outcome: "exact_ready" });
}

function advanceToRestartChallenge(): HermesStagingAcceptancePlan {
  let plan = advanceToInitialChallenge();
  plan = apply(plan, {
    effect: "issue_initial_human_challenge",
    outcome: "issued",
    challengeDigest: INITIAL_CHALLENGE,
    expiresAtMs: NOW + HERMES_STAGING_HUMAN_CHALLENGE_MAX_TTL_MS,
  });
  plan = command(plan, {
    kind: "human_attestation",
    generation: GENERATION,
    nowMs: NOW,
    proof: "initial",
    challengeDigest: INITIAL_CHALLENGE,
    attestationDigest: INITIAL_ATTESTATION,
  });
  plan = apply(plan, { effect: "restart_agent", outcome: "accepted" });
  return apply(plan, {
    effect: "verify_restarted_image_and_telegram",
    outcome: "exact_ready",
  });
}

describe("Hermes staging acceptance state policy", () => {
  it("parses only the closed persisted phases and safe error codes", () => {
    for (const phase of HERMES_STAGING_ACCEPTANCE_PHASES) {
      expect(parseHermesStagingAcceptancePhase(phase)).toBe(phase);
    }
    for (const code of HERMES_STAGING_ACCEPTANCE_ERROR_CODES) {
      expect(parseHermesStagingAcceptanceErrorCode(code)).toBe(code);
    }

    expect(parseHermesStagingAcceptancePhase("READY")).toBeNull();
    expect(parseHermesStagingAcceptancePhase(null)).toBeNull();
    expect(parseHermesStagingAcceptanceErrorCode("failed token=secret")).toBeNull();
    expect(parseHermesStagingAcceptanceErrorCode({})).toBeNull();
  });

  it("rejects invalid initialization without creating state or planning an effect", () => {
    for (const input of [
      {
        generation: -1,
        nowMs: NOW,
        deadlineAtMs: DEADLINE,
        cleanupDeadlineAtMs: CLEANUP_DEADLINE,
      },
      {
        generation: GENERATION,
        nowMs: NOW,
        deadlineAtMs: NOW,
        cleanupDeadlineAtMs: CLEANUP_DEADLINE,
      },
      {
        generation: GENERATION,
        nowMs: NOW,
        deadlineAtMs: NOW + 2 * 60 * 60_000 + 1,
        cleanupDeadlineAtMs: NOW + 3 * 60 * 60_000,
      },
      {
        generation: GENERATION,
        nowMs: NOW,
        deadlineAtMs: DEADLINE,
        cleanupDeadlineAtMs: DEADLINE,
      },
      {
        generation: GENERATION,
        nowMs: NOW,
        deadlineAtMs: DEADLINE,
        cleanupDeadlineAtMs: DEADLINE + 2 * 60 * 60_000 + 1,
      },
    ]) {
      expect(
        planHermesStagingAcceptance({ state: null, input: { kind: "begin", ...input } }),
      ).toEqual({ state: null, decision: { kind: "rejected", code: "invalid_begin" } });
    }

    expect(
      planHermesStagingAcceptance({
        state: null,
        input: { kind: "tick", generation: GENERATION, nowMs: NOW },
      }),
    ).toEqual({ state: null, decision: { kind: "ignored", reason: "no_state" } });
  });

  it("walks every forward phase, exact deployment stage, cleanup effect, and absence check", () => {
    let plan = begin();
    expectEffect(plan, "preflight");
    plan = apply(plan, { effect: "preflight", outcome: "confirmed" });
    expectEffect(plan, "attest_published_image");
    plan = apply(plan, { effect: "attest_published_image", outcome: "confirmed" });
    expectEffect(plan, "create_ready_agent");
    plan = apply(plan, { effect: "create_ready_agent", outcome: "accepted" });

    for (const stage of HERMES_STAGING_DEPLOYMENT_STAGES) {
      expectEffect(plan, "observe_next_deployment_stage");
      plan = apply(plan, {
        effect: "observe_next_deployment_stage",
        outcome: "observed",
        stage,
      });
    }

    expect(plan.state?.deploymentStageIndex).toBe(HERMES_STAGING_DEPLOYMENT_STAGES.length - 1);
    expectEffect(plan, "verify_strict_host_image");
    plan = apply(plan, { effect: "verify_strict_host_image", outcome: "exact_ready" });
    expectEffect(plan, "issue_initial_human_challenge");
    plan = apply(plan, {
      effect: "issue_initial_human_challenge",
      outcome: "issued",
      challengeDigest: INITIAL_CHALLENGE,
      expiresAtMs: NOW + HERMES_STAGING_HUMAN_CHALLENGE_MAX_TTL_MS,
    });
    expect(plan.decision).toMatchObject({ kind: "wait", reason: "human_proof" });
    plan = command(plan, {
      kind: "human_attestation",
      generation: GENERATION,
      nowMs: NOW,
      proof: "initial",
      challengeDigest: INITIAL_CHALLENGE,
      attestationDigest: INITIAL_ATTESTATION,
    });
    expectEffect(plan, "restart_agent");
    plan = apply(plan, { effect: "restart_agent", outcome: "accepted" });
    expectEffect(plan, "verify_restarted_image_and_telegram");
    plan = apply(plan, {
      effect: "verify_restarted_image_and_telegram",
      outcome: "exact_ready",
    });
    expectEffect(plan, "issue_post_restart_human_challenge");
    plan = apply(plan, {
      effect: "issue_post_restart_human_challenge",
      outcome: "issued",
      challengeDigest: RESTART_CHALLENGE,
      expiresAtMs: NOW + HERMES_STAGING_HUMAN_CHALLENGE_MAX_TTL_MS,
    });
    plan = command(plan, {
      kind: "human_attestation",
      generation: GENERATION,
      nowMs: NOW,
      proof: "post_restart",
      challengeDigest: RESTART_CHALLENGE,
      attestationDigest: RESTART_ATTESTATION,
    });
    expectEffect(plan, "audit_safe_diagnostics");
    plan = apply(plan, { effect: "audit_safe_diagnostics", outcome: "safe" });
    expectEffect(plan, "stop_agent_db_first");
    plan = apply(plan, { effect: "stop_agent_db_first", outcome: "accepted" });
    expectEffect(plan, "observe_stop_stability");
    plan = apply(plan, { effect: "observe_stop_stability", outcome: "stopped" });
    expect(plan.decision).toMatchObject({ kind: "wait", reason: "stop_stability" });
    plan = command(plan, {
      kind: "tick",
      generation: GENERATION,
      nowMs: NOW + HERMES_STAGING_STOP_STABILITY_MS,
    });
    expectEffect(plan, "observe_stop_stability");
    plan = apply(
      plan,
      { effect: "observe_stop_stability", outcome: "stopped" },
      NOW + HERMES_STAGING_STOP_STABILITY_MS,
    );
    expectEffect(plan, "verify_manual_rollback");
    plan = apply(plan, { effect: "verify_manual_rollback", outcome: "passed" });

    for (const [cleanup, observe] of [
      ["cleanup_workload", "observe_workload_absence"],
      ["cleanup_secrets", "observe_secrets_absence"],
      ["cleanup_firewall", "observe_firewall_absence"],
      ["cleanup_droplet", "observe_droplet_absence"],
      ["cleanup_runner", "observe_runner_absence"],
    ] as const) {
      expectEffect(plan, cleanup);
      plan = apply(plan, { effect: cleanup, outcome: "accepted" });
      expectEffect(plan, observe);
      plan = apply(plan, { effect: observe, outcome: "absent" });
    }

    expect(plan.decision).toEqual({ kind: "complete", outcome: "succeeded", errorCode: null });
    expect(plan.state).toMatchObject({
      phase: "complete",
      desiredOutcome: "cleanup",
      terminalOutcome: "succeeded",
      cleanupConfirmed: {
        workload: true,
        secrets: true,
        firewall: true,
        droplet: true,
        runner: true,
      },
    });
  });

  it("accepts only the exact next persisted deployment stage", () => {
    const pending = stateAt("observing_deployment", "observe_next_deployment_stage");
    const repeated = effectResult(
      { ...pending, deploymentStageIndex: 0 },
      { effect: "observe_next_deployment_stage", outcome: "observed", stage: "pending" },
    );
    expect(repeated.decision).toMatchObject({ kind: "wait", reason: "retry_backoff" });

    for (const stage of ["provisioning_runner", "ready"] as const) {
      const skipped = effectResult(pending, {
        effect: "observe_next_deployment_stage",
        outcome: "observed",
        stage,
      });
      expect(skipped.state).toMatchObject({
        phase: "cleaning_workload",
        errorCode: "deployment_stage_invalid",
      });
      expectEffect(skipped, "cleanup_workload");
    }
  });

  it("turns every closed forward failure into cleanup before another forward effect", () => {
    const cases: ReadonlyArray<{
      phase: HermesStagingAcceptanceState["phase"];
      result: HermesStagingAcceptanceEffectResult;
      errorCode: string;
    }> = [
      {
        phase: "preflight",
        result: { effect: "preflight", outcome: "failed" },
        errorCode: "preflight_failed",
      },
      {
        phase: "attesting_image",
        result: { effect: "attest_published_image", outcome: "failed" },
        errorCode: "image_attestation_failed",
      },
      {
        phase: "creating_ready_agent",
        result: { effect: "create_ready_agent", outcome: "failed" },
        errorCode: "agent_creation_failed",
      },
      {
        phase: "creating_ready_agent",
        result: { effect: "observe_agent_creation", outcome: "conflict" },
        errorCode: "agent_creation_failed",
      },
      {
        phase: "observing_deployment",
        result: { effect: "observe_next_deployment_stage", outcome: "failed" },
        errorCode: "deployment_failed",
      },
      {
        phase: "verifying_host_image",
        result: { effect: "verify_strict_host_image", outcome: "mismatch" },
        errorCode: "host_image_unverified",
      },
      {
        phase: "awaiting_initial_human_proof",
        result: { effect: "issue_initial_human_challenge", outcome: "failed" },
        errorCode: "initial_human_proof_failed",
      },
      {
        phase: "awaiting_initial_human_proof",
        result: { effect: "observe_initial_human_challenge", outcome: "conflict" },
        errorCode: "initial_human_proof_failed",
      },
      {
        phase: "restarting",
        result: { effect: "restart_agent", outcome: "failed" },
        errorCode: "restart_failed",
      },
      {
        phase: "restarting",
        result: { effect: "observe_agent_restart", outcome: "conflict" },
        errorCode: "restart_failed",
      },
      {
        phase: "reverifying_runtime",
        result: { effect: "verify_restarted_image_and_telegram", outcome: "mismatch" },
        errorCode: "runtime_reverification_failed",
      },
      {
        phase: "awaiting_post_restart_human_proof",
        result: { effect: "issue_post_restart_human_challenge", outcome: "conflict" },
        errorCode: "post_restart_human_proof_failed",
      },
      {
        phase: "awaiting_post_restart_human_proof",
        result: { effect: "observe_post_restart_human_challenge", outcome: "conflict" },
        errorCode: "post_restart_human_proof_failed",
      },
      {
        phase: "auditing_diagnostics",
        result: { effect: "audit_safe_diagnostics", outcome: "unsafe" },
        errorCode: "diagnostics_unsafe",
      },
      {
        phase: "stopping_agent",
        result: { effect: "stop_agent_db_first", outcome: "failed" },
        errorCode: "stop_failed",
      },
      {
        phase: "stopping_agent",
        result: { effect: "observe_stop_intent", outcome: "conflict" },
        errorCode: "stop_failed",
      },
      {
        phase: "checking_rollback",
        result: { effect: "verify_manual_rollback", outcome: "failed" },
        errorCode: "rollback_failed",
      },
    ];

    for (const testCase of cases) {
      const failed = effectResult(stateAt(testCase.phase, testCase.result.effect), testCase.result);
      expectEffect(failed, "cleanup_workload");
      expect(failed.state).toMatchObject({
        phase: "cleaning_workload",
        desiredOutcome: "cleanup",
        terminalOutcome: "failed",
        errorCode: testCase.errorCode,
      });
    }
  });

  it("gives cancellation and deadline cleanup precedence from every forward phase", () => {
    const forwardPhases = HERMES_STAGING_ACCEPTANCE_PHASES.slice(
      0,
      HERMES_STAGING_ACCEPTANCE_PHASES.indexOf("cleaning_workload"),
    );

    for (const phase of forwardPhases) {
      const state = stateAt(phase, "restart_agent");
      const cancelled = planHermesStagingAcceptance({
        state,
        input: { kind: "cancel", generation: GENERATION, nowMs: NOW },
      });
      expectEffect(cancelled, "cleanup_workload");
      expect(cancelled.state).toMatchObject({
        desiredOutcome: "cleanup",
        terminalOutcome: "cancelled",
        errorCode: "acceptance_cancelled",
      });

      const timedOut = planHermesStagingAcceptance({
        state: { ...state, deadlineAtMs: NOW },
        input: { kind: "tick", generation: GENERATION, nowMs: NOW },
      });
      expectEffect(timedOut, "cleanup_workload");
      expect(timedOut.state).toMatchObject({
        desiredOutcome: "cleanup",
        terminalOutcome: "failed",
        errorCode: "acceptance_deadline_exceeded",
      });
    }
  });

  it("ignores stale generations and out-of-order results without changing durable state", () => {
    const plan = begin();
    const stale = planHermesStagingAcceptance({
      state: plan.state,
      input: { kind: "tick", generation: GENERATION - 1, nowMs: DEADLINE + 1 },
    });
    expect(stale).toEqual({
      state: plan.state,
      decision: { kind: "ignored", reason: "stale_generation" },
    });

    const outOfOrder = apply(plan, { effect: "attest_published_image", outcome: "confirmed" });
    expect(outOfOrder).toEqual({
      state: plan.state,
      decision: { kind: "ignored", reason: "unexpected_effect_result" },
    });

    const duplicate = planHermesStagingAcceptance({
      state: plan.state,
      input: {
        kind: "begin",
        generation: GENERATION,
        nowMs: NOW,
        deadlineAtMs: DEADLINE,
        cleanupDeadlineAtMs: CLEANUP_DEADLINE,
      },
    });
    expect(duplicate.decision).toEqual({ kind: "ignored", reason: "duplicate_begin" });
  });

  it("observes every uncertain mutation before it may repeat or advance", () => {
    const cases: ReadonlyArray<{
      phase: HermesStagingAcceptanceState["phase"];
      mutation: HermesStagingAcceptanceEffectResult;
      observer: HermesStagingAcceptanceEffectKind;
    }> = [
      {
        phase: "creating_ready_agent",
        mutation: { effect: "create_ready_agent", outcome: "unknown" },
        observer: "observe_agent_creation",
      },
      {
        phase: "awaiting_initial_human_proof",
        mutation: { effect: "issue_initial_human_challenge", outcome: "unknown" },
        observer: "observe_initial_human_challenge",
      },
      {
        phase: "restarting",
        mutation: { effect: "restart_agent", outcome: "unknown" },
        observer: "observe_agent_restart",
      },
      {
        phase: "awaiting_post_restart_human_proof",
        mutation: { effect: "issue_post_restart_human_challenge", outcome: "unknown" },
        observer: "observe_post_restart_human_challenge",
      },
      {
        phase: "stopping_agent",
        mutation: { effect: "stop_agent_db_first", outcome: "unknown" },
        observer: "observe_stop_intent",
      },
      {
        phase: "cleaning_workload",
        mutation: { effect: "cleanup_workload", outcome: "unknown" },
        observer: "observe_workload_absence",
      },
      {
        phase: "cleaning_secrets",
        mutation: { effect: "cleanup_secrets", outcome: "unknown" },
        observer: "observe_secrets_absence",
      },
      {
        phase: "cleaning_firewall",
        mutation: { effect: "cleanup_firewall", outcome: "unknown" },
        observer: "observe_firewall_absence",
      },
      {
        phase: "cleaning_droplet",
        mutation: { effect: "cleanup_droplet", outcome: "unknown" },
        observer: "observe_droplet_absence",
      },
      {
        phase: "cleaning_runner",
        mutation: { effect: "cleanup_runner", outcome: "unknown" },
        observer: "observe_runner_absence",
      },
    ];

    for (const testCase of cases) {
      let state = stateAt(testCase.phase, testCase.mutation.effect);
      if (testCase.phase.startsWith("cleaning_")) {
        state = {
          ...state,
          desiredOutcome: "cleanup",
          terminalOutcome: "failed",
          errorCode: "preflight_failed",
        };
      }
      const unknown = effectResult(state, testCase.mutation);
      expect(unknown.decision).toMatchObject({ kind: "wait", reason: "retry_backoff" });
      expect(unknown.state?.pendingEffect).toBe(testCase.mutation.effect);

      const observed = command(unknown, {
        kind: "tick",
        generation: GENERATION,
        nowMs: unknown.state?.nextAttemptAtMs ?? NOW,
      });
      expectEffect(observed, testCase.observer);
    }
  });

  it("also observes a mutation whose response was lost after its response deadline", () => {
    const pending = begin();
    const beforeDue = command(pending, {
      kind: "tick",
      generation: GENERATION,
      nowMs: NOW + 14_999,
    });
    expect(beforeDue.decision).toMatchObject({ kind: "wait", reason: "effect_pending" });

    let create = stateAt("creating_ready_agent", "create_ready_agent");
    create = { ...create, nextAttemptAtMs: NOW };
    const recovered = planHermesStagingAcceptance({
      state: create,
      input: { kind: "tick", generation: GENERATION, nowMs: NOW },
    });
    expectEffect(recovered, "observe_agent_creation");
  });

  it("advances only from confirmed observations of uncertain mutations", () => {
    const created = effectResult(stateAt("creating_ready_agent", "observe_agent_creation"), {
      effect: "observe_agent_creation",
      outcome: "found",
    });
    expectEffect(created, "observe_next_deployment_stage");

    const initialChallenge = effectResult(
      stateAt("awaiting_initial_human_proof", "observe_initial_human_challenge"),
      {
        effect: "observe_initial_human_challenge",
        outcome: "found",
        challengeDigest: INITIAL_CHALLENGE,
        expiresAtMs: NOW + 60_000,
      },
    );
    expect(initialChallenge.decision).toMatchObject({ kind: "wait", reason: "human_proof" });
    expect(initialChallenge.state?.initialChallengeDigest).toBe(INITIAL_CHALLENGE);

    const restarted = effectResult(stateAt("restarting", "observe_agent_restart"), {
      effect: "observe_agent_restart",
      outcome: "completed",
    });
    expectEffect(restarted, "verify_restarted_image_and_telegram");

    const postChallengeState = {
      ...stateAt("awaiting_post_restart_human_proof", "observe_post_restart_human_challenge"),
      initialChallengeDigest: INITIAL_CHALLENGE,
      initialAttestationDigest: INITIAL_ATTESTATION,
    };
    const postChallenge = effectResult(postChallengeState, {
      effect: "observe_post_restart_human_challenge",
      outcome: "found",
      challengeDigest: RESTART_CHALLENGE,
      expiresAtMs: NOW + 60_000,
    });
    expect(postChallenge.decision).toMatchObject({ kind: "wait", reason: "human_proof" });
    expect(postChallenge.state?.postRestartChallengeDigest).toBe(RESTART_CHALLENGE);

    const stopped = effectResult(stateAt("stopping_agent", "observe_stop_intent"), {
      effect: "observe_stop_intent",
      outcome: "desired_stopped",
    });
    expectEffect(stopped, "observe_stop_stability");
  });

  it("repeats an idempotent mutation only after observation confirms it was not applied", () => {
    const cases: ReadonlyArray<{
      state: HermesStagingAcceptanceState;
      observation: HermesStagingAcceptanceEffectResult;
      retry: HermesStagingAcceptanceEffectKind;
    }> = [
      {
        state: stateAt("creating_ready_agent", "observe_agent_creation"),
        observation: { effect: "observe_agent_creation", outcome: "absent" },
        retry: "create_ready_agent",
      },
      {
        state: stateAt("awaiting_initial_human_proof", "observe_initial_human_challenge"),
        observation: { effect: "observe_initial_human_challenge", outcome: "missing" },
        retry: "issue_initial_human_challenge",
      },
      {
        state: stateAt("restarting", "observe_agent_restart"),
        observation: { effect: "observe_agent_restart", outcome: "not_applied" },
        retry: "restart_agent",
      },
      {
        state: stateAt("stopping_agent", "observe_stop_intent"),
        observation: { effect: "observe_stop_intent", outcome: "desired_running" },
        retry: "stop_agent_db_first",
      },
    ];

    for (const testCase of cases) {
      const observed = effectResult(testCase.state, testCase.observation);
      expect(observed.decision).toMatchObject({ kind: "wait", reason: "retry_backoff" });
      const retried = command(observed, {
        kind: "tick",
        generation: GENERATION,
        nowMs: observed.state?.nextAttemptAtMs ?? NOW,
      });
      expectEffect(retried, testCase.retry);
    }
  });

  it("uses capped 15/30/60/120/300 second retry backoff", () => {
    let plan = stateAt("verifying_host_image", "verify_strict_host_image");
    const delays: number[] = [];

    for (let index = 0; index < 7; index += 1) {
      const result = effectResult(
        plan,
        {
          effect: "verify_strict_host_image",
          outcome: "unknown",
        },
        NOW,
      );
      if (result.decision.kind !== "wait") {
        throw new Error("Expected retry wait.");
      }
      delays.push(result.decision.untilMs - NOW);
      const retried = planHermesStagingAcceptance({
        state: result.state,
        input: { kind: "tick", generation: GENERATION, nowMs: result.decision.untilMs },
      });
      expectEffect(retried, "verify_strict_host_image");
      plan = retried.state as HermesStagingAcceptanceState;
    }

    expect(delays).toEqual([15_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
    expect(HERMES_STAGING_ACCEPTANCE_BACKOFF_MS).toEqual([
      15_000, 30_000, 60_000, 120_000, 300_000,
    ]);
  });

  it("requires valid, matching, unexpired, unique human attestation digests", () => {
    const issued = apply(advanceToInitialChallenge(), {
      effect: "issue_initial_human_challenge",
      outcome: "issued",
      challengeDigest: INITIAL_CHALLENGE,
      expiresAtMs: NOW + HERMES_STAGING_HUMAN_CHALLENGE_MAX_TTL_MS,
    });

    for (const [challengeDigest, attestationDigest] of [
      [`sha256:${"9".repeat(64)}`, INITIAL_ATTESTATION],
      [INITIAL_CHALLENGE, "not-a-digest"],
      [INITIAL_CHALLENGE, INITIAL_CHALLENGE],
    ] satisfies ReadonlyArray<readonly [string, string]>) {
      const rejected = command(issued, {
        kind: "human_attestation",
        generation: GENERATION,
        nowMs: NOW,
        proof: "initial",
        challengeDigest,
        attestationDigest,
      });
      expectEffect(rejected, "cleanup_workload");
      expect(rejected.state?.errorCode).toBe("initial_human_proof_failed");
    }

    const wrongProof = command(issued, {
      kind: "human_attestation",
      generation: GENERATION,
      nowMs: NOW,
      proof: "post_restart",
      challengeDigest: INITIAL_CHALLENGE,
      attestationDigest: INITIAL_ATTESTATION,
    });
    expect(wrongProof.decision).toEqual({ kind: "ignored", reason: "unexpected_input" });

    const restartIssued = apply(advanceToRestartChallenge(), {
      effect: "issue_post_restart_human_challenge",
      outcome: "issued",
      challengeDigest: RESTART_CHALLENGE,
      expiresAtMs: NOW + HERMES_STAGING_HUMAN_CHALLENGE_MAX_TTL_MS,
    });
    const reusedAttestation = command(restartIssued, {
      kind: "human_attestation",
      generation: GENERATION,
      nowMs: NOW,
      proof: "post_restart",
      challengeDigest: RESTART_CHALLENGE,
      attestationDigest: INITIAL_ATTESTATION,
    });
    expectEffect(reusedAttestation, "cleanup_workload");
    expect(reusedAttestation.state?.errorCode).toBe("post_restart_human_proof_failed");
  });

  it("fails closed on malformed, reused, overlong, or expired challenges", () => {
    for (const challenge of [
      { digest: "raw-human-message", expiresAtMs: NOW + 60_000 },
      { digest: INITIAL_CHALLENGE, expiresAtMs: NOW },
      {
        digest: INITIAL_CHALLENGE,
        expiresAtMs: NOW + HERMES_STAGING_HUMAN_CHALLENGE_MAX_TTL_MS + 1,
      },
    ]) {
      const rejected = apply(advanceToInitialChallenge(), {
        effect: "issue_initial_human_challenge",
        outcome: "issued",
        challengeDigest: challenge.digest,
        expiresAtMs: challenge.expiresAtMs,
      });
      expectEffect(rejected, "cleanup_workload");
      expect(rejected.state?.errorCode).toBe("initial_human_proof_failed");
    }

    const restart = advanceToRestartChallenge();
    const reusedChallenge = apply(restart, {
      effect: "issue_post_restart_human_challenge",
      outcome: "issued",
      challengeDigest: INITIAL_CHALLENGE,
      expiresAtMs: NOW + 60_000,
    });
    expectEffect(reusedChallenge, "cleanup_workload");
    expect(reusedChallenge.state?.errorCode).toBe("post_restart_human_proof_failed");

    const expiring = apply(advanceToInitialChallenge(), {
      effect: "issue_initial_human_challenge",
      outcome: "issued",
      challengeDigest: INITIAL_CHALLENGE,
      expiresAtMs: NOW + 60_000,
    });
    const expired = command(expiring, {
      kind: "human_attestation",
      generation: GENERATION,
      nowMs: NOW + 60_000,
      proof: "initial",
      challengeDigest: INITIAL_CHALLENGE,
      attestationDigest: INITIAL_ATTESTATION,
    });
    expectEffect(expired, "cleanup_workload");
    expect(expired.state?.errorCode).toBe("human_proof_expired");
  });

  it("requires a continuous Stop stability window and resets on active or unknown evidence", () => {
    let plan: HermesStagingAcceptancePlan = {
      state: stateAt("observing_stop_stability", "observe_stop_stability"),
      decision: { kind: "effect", effect: { kind: "observe_stop_stability" } },
    };
    plan = apply(plan, { effect: "observe_stop_stability", outcome: "stopped" });
    expect(plan.state?.stopStableSinceMs).toBe(NOW);

    plan = command(plan, {
      kind: "tick",
      generation: GENERATION,
      nowMs: NOW + 30_000,
    });
    expectEffect(plan, "observe_stop_stability");
    plan = apply(plan, { effect: "observe_stop_stability", outcome: "active" }, NOW + 30_000);
    expect(plan.state?.stopStableSinceMs).toBeNull();
    expect(plan.decision.kind).toBe("wait");

    plan = command(plan, {
      kind: "tick",
      generation: GENERATION,
      nowMs: plan.state?.nextAttemptAtMs ?? NOW,
    });
    plan = apply(plan, { effect: "observe_stop_stability", outcome: "unknown" }, NOW + 45_000);
    expect(plan.state?.stopStableSinceMs).toBeNull();
    expect(plan.decision).toMatchObject({ kind: "wait", reason: "retry_backoff" });
  });

  it("never completes cleanup while any absence is present or uncertain", () => {
    const base = {
      ...stateAt("cleaning_runner", "observe_runner_absence"),
      desiredOutcome: "cleanup" as const,
      terminalOutcome: "succeeded" as const,
      cleanupConfirmed: {
        workload: true,
        secrets: true,
        firewall: true,
        droplet: true,
        runner: false,
      },
    };

    const uncertain = effectResult(base, {
      effect: "observe_runner_absence",
      outcome: "unknown",
    });
    expect(uncertain.decision).toMatchObject({ kind: "wait", reason: "retry_backoff" });
    expect(uncertain.state?.phase).toBe("cleaning_runner");

    const present = effectResult(base, {
      effect: "observe_runner_absence",
      outcome: "present",
    });
    expect(present.decision).toMatchObject({ kind: "wait", reason: "retry_backoff" });
    expect(present.state).toMatchObject({
      phase: "cleaning_runner",
      terminalOutcome: "succeeded",
      errorCode: null,
      cleanupConfirmed: { runner: false },
    });

    const inconsistent = effectResult(
      {
        ...base,
        cleanupConfirmed: {
          workload: false,
          secrets: true,
          firewall: true,
          droplet: true,
          runner: false,
        },
      },
      { effect: "observe_runner_absence", outcome: "absent" },
    );
    expectEffect(inconsistent, "cleanup_workload");
    expect(inconsistent.state?.phase).toBe("cleaning_workload");
  });

  it("preserves cleanup ordering and retries failures with capped backoff", () => {
    let state: HermesStagingAcceptanceState = {
      ...stateAt("cleaning_workload", "cleanup_workload"),
      desiredOutcome: "cleanup" as const,
      terminalOutcome: "failed" as const,
      errorCode: "preflight_failed" as const,
    };
    const delays: number[] = [];

    for (let index = 0; index < 6; index += 1) {
      const failed = effectResult(state, { effect: "cleanup_workload", outcome: "failed" });
      expect(failed.state?.phase).toBe("cleaning_workload");
      expect(failed.decision.kind).toBe("wait");
      if (failed.decision.kind === "wait") {
        delays.push(failed.decision.untilMs - NOW);
        const retried = command(failed, {
          kind: "tick",
          generation: GENERATION,
          nowMs: failed.decision.untilMs,
        });
        expectEffect(retried, "cleanup_workload");
        state = retried.state as HermesStagingAcceptanceState;
      }
    }

    expect(delays).toEqual([15_000, 30_000, 60_000, 120_000, 300_000, 300_000]);
  });

  it("blocks an invocation at the cleanup deadline without erasing durable obligations", () => {
    const cleaning: HermesStagingAcceptanceState = {
      ...stateAt("cleaning_firewall", "cleanup_firewall"),
      desiredOutcome: "cleanup",
      terminalOutcome: "failed",
      errorCode: "preflight_failed",
      cleanupConfirmed: {
        workload: true,
        secrets: true,
        firewall: false,
        droplet: false,
        runner: false,
      },
    };

    const blocked = planHermesStagingAcceptance({
      state: cleaning,
      input: { kind: "tick", generation: GENERATION, nowMs: CLEANUP_DEADLINE },
    });

    expect(blocked.decision).toEqual({ kind: "blocked", code: "cleanup_failed" });
    expect(blocked.state).toMatchObject({
      phase: "cleaning_firewall",
      desiredOutcome: "cleanup",
      terminalOutcome: "failed",
      errorCode: "preflight_failed",
      pendingEffect: null,
      nextAttemptAtMs: null,
      cleanupConfirmed: {
        workload: true,
        secrets: true,
        firewall: false,
        droplet: false,
        runner: false,
      },
    });
    expect(blocked.decision.kind).not.toBe("complete");
  });

  it("does not rewrite an existing cleanup outcome or reason when cancelled again", () => {
    const failedCleaning: HermesStagingAcceptanceState = {
      ...stateAt("cleaning_secrets"),
      desiredOutcome: "cleanup",
      terminalOutcome: "failed",
      errorCode: "image_attestation_failed",
      cleanupConfirmed: {
        workload: true,
        secrets: false,
        firewall: false,
        droplet: false,
        runner: false,
      },
    };
    const cancelled = planHermesStagingAcceptance({
      state: failedCleaning,
      input: { kind: "cancel", generation: GENERATION, nowMs: NOW },
    });
    expectEffect(cancelled, "cleanup_secrets");
    expect(cancelled.state).toMatchObject({
      terminalOutcome: "failed",
      errorCode: "image_attestation_failed",
    });

    const userCancelled: HermesStagingAcceptanceState = {
      ...failedCleaning,
      terminalOutcome: "cancelled",
      errorCode: "acceptance_cancelled",
    };
    const repeated = planHermesStagingAcceptance({
      state: userCancelled,
      input: { kind: "cancel", generation: GENERATION, nowMs: NOW },
    });
    expect(repeated.state).toMatchObject({
      terminalOutcome: "cancelled",
      errorCode: "acceptance_cancelled",
    });
  });

  it("keeps the policy surface code-only and never retains free text, identifiers, or PII", () => {
    const serialized = JSON.stringify(advanceToRestartChallenge());
    for (const forbidden of [
      "123456789",
      "-1001234567890",
      "dop_v1_secret",
      "sk-or-v1-secret",
      "private.example.internal",
      "human message contents",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain(INITIAL_CHALLENGE);
    expect(serialized).toContain(INITIAL_ATTESTATION);
  });
});
