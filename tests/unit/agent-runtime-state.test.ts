import { describe, expect, it } from "vitest";
import {
  AGENT_RUNTIME_ERROR_CODES,
  AGENT_RUNTIME_STATES,
  MAX_DOCKER_POLICY_RESTARTS,
  RUNTIME_OBSERVATION_INTERVAL_MS,
  RUNTIME_RECOVERY_WINDOW_MS,
  RUNTIME_STABILITY_RESET_MS,
  RUNTIME_TELEGRAM_GRACE_MS,
  applyRuntimeObservation,
  applyRuntimeStartResult,
  applyRuntimeStopResult,
  parseAgentRuntimeErrorCode,
  parseAgentRuntimeState,
  parseRuntimeRestartCount,
  planRuntimeEffect,
  resetRuntimeForOwnerAction,
  requestRuntimeCircuitCleanup,
  runtimeBackoffMs,
  runtimePublicPresentation,
  runtimeRestartCountDelta,
  type RuntimePolicyState,
} from "@/src/server/agents/agent-runtime-state";

const NOW = Date.parse("2026-08-03T08:00:00.000Z");

function policy(overrides: Partial<RuntimePolicyState> = {}): RuntimePolicyState {
  return {
    state: "observing",
    generation: 2,
    attemptCount: 1,
    recoveryCount: 0,
    recoveryWindowStartedAtMs: null,
    stableSinceMs: NOW,
    telegramNonConnectedSinceMs: null,
    lastRestartCount: 0,
    errorCode: null,
    circuitOpenedAtMs: null,
    ...overrides,
  };
}

function plan(overrides: Partial<Parameters<typeof planRuntimeEffect>[0]> = {}) {
  return planRuntimeEffect({
    policy: policy(),
    nowMs: NOW,
    desiredStatus: "running",
    deleted: false,
    latestDeployment: "ready",
    runner: "eligible",
    secrets: "available",
    ...overrides,
  });
}

describe("agent runtime state policy", () => {
  it("parses only the closed persisted states and safe codes", () => {
    for (const state of AGENT_RUNTIME_STATES) {
      expect(parseAgentRuntimeState(state)).toBe(state);
    }
    for (const code of AGENT_RUNTIME_ERROR_CODES) {
      expect(parseAgentRuntimeErrorCode(code)).toBe(code);
    }

    expect(parseAgentRuntimeState("ready")).toBeNull();
    expect(parseAgentRuntimeErrorCode("UPSTREAM token=secret")).toBeNull();
    expect(parseAgentRuntimeErrorCode(null)).toBeNull();
  });

  it("uses deterministic 15/30/60/120/300 second backoff and caps it", () => {
    expect([0, 2, 3, 4, 5, 99].map(runtimeBackoffMs)).toEqual([
      15_000, 30_000, 60_000, 120_000, 300_000, 300_000,
    ]);
  });

  it("schedules healthy exact observations every 60 seconds", () => {
    const result = applyRuntimeObservation({
      policy: policy({ stableSinceMs: NOW - 1_000 }),
      observation: { kind: "exact_ready", restartCount: 0 },
      nowMs: NOW,
    });

    expect(result.policy.state).toBe("observing");
    expect(result.nextAttemptAtMs).toBe(NOW + RUNTIME_OBSERVATION_INTERVAL_MS);
    expect(result.openUsage).toBe(true);
    expect(result.closeUsage).toBe(false);
  });

  it("keeps every claim to one external effect", () => {
    expect(plan().effect).toBe("observe");
    expect(plan({ policy: policy({ state: "recovering_stop" }) }).effect).toBe("stop");
    expect(plan({ policy: policy({ state: "recovering_start" }) }).effect).toBe("start");
    expect(plan({ policy: policy({ state: "verifying" }) }).effect).toBe("observe");
    expect(plan({ policy: policy({ state: "circuit_open" }) }).effect).toBe("none");
  });

  it("requires the authenticated owner transition before a stopped row can start", () => {
    const result = plan({ policy: policy({ state: "stopped" }) });
    expect(result).toMatchObject({ effect: "none", reason: "explicit_start_required" });

    const reset = resetRuntimeForOwnerAction({ policy: result.policy, action: "start" });
    expect(plan({ policy: reset })).toMatchObject({ effect: "start" });
  });

  it("gives desired stop precedence and never plans a start", () => {
    for (const state of AGENT_RUNTIME_STATES.filter((candidate) => candidate !== "stopped")) {
      const result = plan({
        policy: policy({ state }),
        desiredStatus: "stopped",
      });
      expect(result.effect).not.toBe("start");
      expect(result.policy.state).toBe("stopping");
      expect(result.policy.recoveryCount).toBe(0);
      expect(result.policy.circuitOpenedAtMs).toBeNull();
    }

    expect(plan({ policy: policy({ state: "stopped" }), desiredStatus: "stopped" })).toMatchObject({
      effect: "none",
      reason: "intentionally_stopped",
    });

    const pendingCircuit = policy({
      state: "stopping",
      recoveryCount: 3,
      recoveryWindowStartedAtMs: NOW - 1,
      errorCode: "runtime_recovery_exhausted",
      circuitOpenedAtMs: NOW - 1,
    });
    const stoppedByOwner = plan({ policy: pendingCircuit, desiredStatus: "stopped" });
    expect(stoppedByOwner.policy).toMatchObject({
      state: "stopping",
      generation: 3,
      recoveryCount: 0,
      errorCode: null,
      circuitOpenedAtMs: null,
    });
    expect(
      applyRuntimeStopResult({
        policy: pendingCircuit,
        nowMs: NOW,
        desiredStatus: "stopped",
        result: "confirmed",
      }),
    ).toMatchObject({
      circuitOpened: false,
      policy: { state: "stopped", errorCode: null, circuitOpenedAtMs: null },
    });
  });

  it("excludes deleted, active/failed deployments, unavailable secrets, capacity, and runners", () => {
    expect(plan({ deleted: true }).effect).toBe("none");
    expect(plan({ latestDeployment: "active" }).effect).toBe("none");
    expect(plan({ latestDeployment: "failed" }).effect).toBe("none");

    const secret = plan({
      policy: policy({ state: "recovering_start" }),
      secrets: "unavailable",
    });
    expect(secret).toMatchObject({ effect: "none", reason: "secret_unavailable" });
    expect(secret.policy).toMatchObject({
      state: "stopping",
      errorCode: "runtime_secret_unavailable",
      circuitOpenedAtMs: NOW,
    });
    expect(plan({ policy: secret.policy })).toMatchObject({ effect: "stop" });

    const capacity = plan({
      policy: policy({ state: "recovering_start" }),
      runner: "capacity_blocked",
    });
    expect(capacity).toMatchObject({ effect: "none", reason: "capacity_blocked" });
    expect(capacity.policy.state).toBe("recovering_start");

    const runner = plan({ runner: "unavailable" });
    expect(runner).toMatchObject({ effect: "none", reason: "runner_unavailable" });
  });

  it("counts a recovery once on entry, not on recovery retries", () => {
    const first = applyRuntimeObservation({
      policy: policy(),
      observation: { kind: "container_absent" },
      nowMs: NOW,
    });
    expect(first.policy).toMatchObject({ state: "recovering_start", recoveryCount: 1 });
    expect(first.recoveryRequested).toBe(true);

    const retry = applyRuntimeObservation({
      policy: first.policy,
      observation: { kind: "container_absent" },
      nowMs: NOW + 15_000,
    });
    expect(retry.policy.recoveryCount).toBe(1);
    expect(retry.recoveryRequested).toBe(false);
  });

  it("opens cleanup-only circuit state when a fourth recovery is required", () => {
    const result = applyRuntimeObservation({
      policy: policy({
        state: "verifying",
        recoveryCount: 3,
        recoveryWindowStartedAtMs: NOW - RUNTIME_RECOVERY_WINDOW_MS + 1,
      }),
      observation: { kind: "container_terminal" },
      nowMs: NOW,
    });

    expect(result).toMatchObject({
      circuitRequested: true,
      closeUsage: true,
      nextAttemptAtMs: NOW,
      policy: {
        state: "stopping",
        recoveryCount: 3,
        errorCode: "runtime_recovery_exhausted",
        circuitOpenedAtMs: NOW,
      },
    });
    expect(plan({ policy: result.policy })).toMatchObject({ effect: "stop" });

    const terminal = applyRuntimeStopResult({
      policy: result.policy,
      nowMs: NOW,
      desiredStatus: "running",
      result: "confirmed",
    });
    expect(terminal).toMatchObject({
      circuitOpened: true,
      nextAttemptAtMs: null,
      policy: { state: "circuit_open" },
    });
  });

  it("preserves the circuit reason while cleanup is unavailable or unconfirmed", () => {
    const pending = requestRuntimeCircuitCleanup({
      policy: policy(),
      nowMs: NOW,
      errorCode: "telegram_webhook_conflict",
    }).policy;

    expect(plan({ policy: pending, runner: "unavailable" }).policy.errorCode).toBe(
      "telegram_webhook_conflict",
    );
    expect(
      applyRuntimeStopResult({
        policy: pending,
        nowMs: NOW,
        desiredStatus: "running",
        result: "unconfirmed",
      }).policy.errorCode,
    ).toBe("telegram_webhook_conflict");
  });

  it("starts a new recovery window at the exact 15-minute boundary", () => {
    const result = applyRuntimeObservation({
      policy: policy({
        state: "verifying",
        recoveryCount: 3,
        recoveryWindowStartedAtMs: NOW - RUNTIME_RECOVERY_WINDOW_MS,
      }),
      observation: { kind: "container_absent" },
      nowMs: NOW,
    });

    expect(result.policy).toMatchObject({
      state: "recovering_start",
      recoveryCount: 1,
      recoveryWindowStartedAtMs: NOW,
    });
  });

  it("resets recovery history only after 15 continuous exact-ready minutes", () => {
    const before = applyRuntimeObservation({
      policy: policy({
        recoveryCount: 2,
        recoveryWindowStartedAtMs: NOW - 100,
        stableSinceMs: NOW - RUNTIME_STABILITY_RESET_MS + 1,
        lastRestartCount: 4,
      }),
      observation: { kind: "exact_ready", restartCount: 4 },
      nowMs: NOW,
    });
    expect(before.policy.recoveryCount).toBe(2);
    expect(before.policy.lastRestartCount).toBe(4);

    const boundary = applyRuntimeObservation({
      policy: policy({
        recoveryCount: 2,
        recoveryWindowStartedAtMs: NOW - 100,
        stableSinceMs: NOW - RUNTIME_STABILITY_RESET_MS,
        lastRestartCount: 4,
      }),
      observation: { kind: "exact_ready", restartCount: 4 },
      nowMs: NOW,
    });
    expect(boundary.policy).toMatchObject({
      recoveryCount: 0,
      recoveryWindowStartedAtMs: null,
      lastRestartCount: 4,
    });
  });

  it("bounds restart counts and handles replacement-container baseline resets", () => {
    expect(parseRuntimeRestartCount(0)).toBe(0);
    expect(parseRuntimeRestartCount(-1)).toBeNull();
    expect(parseRuntimeRestartCount(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(parseRuntimeRestartCount("3")).toBeNull();
    expect(runtimeRestartCountDelta({ baseline: 5, observed: 2 })).toEqual({
      baseline: 2,
      delta: 0,
    });
    expect(runtimeRestartCountDelta({ baseline: 2, observed: 5 })).toEqual({
      baseline: 5,
      delta: MAX_DOCKER_POLICY_RESTARTS,
    });
    expect(runtimeRestartCountDelta({ baseline: 2, observed: null })).toEqual({
      baseline: 2,
      delta: null,
    });
  });

  it("never treats missing or malformed restart evidence as exact ready", () => {
    const result = applyRuntimeObservation({
      policy: policy(),
      observation: { kind: "exact_ready", restartCount: null },
      nowMs: NOW,
    });

    expect(result).toMatchObject({
      closeUsage: true,
      openUsage: false,
      policy: { state: "observing", errorCode: "runtime_internal_failure", stableSinceMs: null },
    });
  });

  it("requests cleanup immediately after three daemon-policy restarts", () => {
    const result = applyRuntimeObservation({
      policy: policy({ stableSinceMs: NOW - RUNTIME_STABILITY_RESET_MS + 1 }),
      observation: { kind: "exact_ready", restartCount: MAX_DOCKER_POLICY_RESTARTS },
      nowMs: NOW,
    });
    expect(result).toMatchObject({
      circuitRequested: true,
      policy: { state: "stopping", errorCode: "runtime_recovery_exhausted" },
    });
  });

  it("requires 15 uninterrupted ready minutes after the latest policy restart", () => {
    const almostStable = policy({
      stableSinceMs: NOW - RUNTIME_STABILITY_RESET_MS + 1_000,
      recoveryCount: 0,
      recoveryWindowStartedAtMs: null,
      lastRestartCount: 0,
    });
    const firstRestartAt = NOW;
    const firstRestart = applyRuntimeObservation({
      policy: almostStable,
      observation: { kind: "exact_ready", restartCount: 1 },
      nowMs: firstRestartAt,
    });
    expect(firstRestart.policy).toMatchObject({
      state: "observing",
      stableSinceMs: firstRestartAt,
      recoveryCount: 1,
      recoveryWindowStartedAtMs: firstRestartAt,
      lastRestartCount: 1,
    });

    const unchanged = applyRuntimeObservation({
      policy: firstRestart.policy,
      observation: { kind: "exact_ready", restartCount: 1 },
      nowMs: firstRestartAt + 60_000,
    });
    expect(unchanged.policy).toMatchObject({
      stableSinceMs: firstRestartAt,
      recoveryCount: 1,
      lastRestartCount: 1,
    });

    const secondRestartAt = firstRestartAt + 14 * 60_000;
    const secondRestart = applyRuntimeObservation({
      policy: unchanged.policy,
      observation: { kind: "exact_ready", restartCount: 2 },
      nowMs: secondRestartAt,
    });
    expect(secondRestart.policy).toMatchObject({
      stableSinceMs: secondRestartAt,
      recoveryCount: 2,
      lastRestartCount: 2,
    });

    const circuit = applyRuntimeObservation({
      policy: secondRestart.policy,
      observation: { kind: "exact_ready", restartCount: 3 },
      nowMs: secondRestartAt + 14 * 60_000,
    });
    expect(circuit).toMatchObject({
      circuitRequested: true,
      policy: {
        state: "stopping",
        recoveryCount: 3,
        lastRestartCount: 3,
        errorCode: "runtime_recovery_exhausted",
      },
    });

    const oneRestart = applyRuntimeObservation({
      policy: almostStable,
      observation: { kind: "exact_ready", restartCount: 1 },
      nowMs: firstRestartAt,
    });
    const stableAfterLatestRestart = applyRuntimeObservation({
      policy: oneRestart.policy,
      observation: { kind: "exact_ready", restartCount: 1 },
      nowMs: firstRestartAt + RUNTIME_STABILITY_RESET_MS,
    });
    expect(stableAfterLatestRestart.policy).toMatchObject({
      state: "observing",
      recoveryCount: 0,
      recoveryWindowStartedAtMs: null,
      stableSinceMs: firstRestartAt,
      lastRestartCount: 1,
    });
  });

  it("does not double-count unchanged restart evidence or underflow on replacement", () => {
    const first = applyRuntimeObservation({
      policy: policy({ recoveryCount: 1, lastRestartCount: 4 }),
      observation: { kind: "exact_ready", restartCount: 5 },
      nowMs: NOW,
    });
    expect(first.policy).toMatchObject({ recoveryCount: 2, lastRestartCount: 5 });

    const repeated = applyRuntimeObservation({
      policy: first.policy,
      observation: { kind: "exact_ready", restartCount: 5 },
      nowMs: NOW + 60_000,
    });
    expect(repeated.policy).toMatchObject({ recoveryCount: 2, lastRestartCount: 5 });

    const replacement = applyRuntimeObservation({
      policy: repeated.policy,
      observation: { kind: "exact_ready", restartCount: 0 },
      nowMs: NOW + 120_000,
    });
    expect(replacement.policy).toMatchObject({ recoveryCount: 2, lastRestartCount: 0 });
  });

  it("applies Telegram grace durably and recovers at the exact two-minute boundary", () => {
    const first = applyRuntimeObservation({
      policy: policy(),
      observation: { kind: "telegram_unhealthy", telegramState: "retrying" },
      nowMs: NOW,
    });
    expect(first.policy).toMatchObject({
      state: "observing",
      telegramNonConnectedSinceMs: NOW,
    });
    expect(first.recoveryRequested).toBe(false);

    const before = applyRuntimeObservation({
      policy: first.policy,
      observation: { kind: "telegram_unhealthy", telegramState: "unknown" },
      nowMs: NOW + RUNTIME_TELEGRAM_GRACE_MS - 1,
    });
    expect(before.policy.state).toBe("observing");

    const boundary = applyRuntimeObservation({
      policy: first.policy,
      observation: { kind: "telegram_unhealthy", telegramState: "disconnected" },
      nowMs: NOW + RUNTIME_TELEGRAM_GRACE_MS,
    });
    expect(boundary).toMatchObject({
      recoveryRequested: true,
      policy: { state: "recovering_stop", recoveryCount: 1 },
    });
  });

  it.each([
    "fatal",
    "paused",
    "disabled",
  ] as const)("treats Telegram %s as immediately recoverable", (telegramState) => {
    const result = applyRuntimeObservation({
      policy: policy(),
      observation: { kind: "telegram_unhealthy", telegramState },
      nowMs: NOW,
    });
    expect(result).toMatchObject({
      recoveryRequested: true,
      policy: { state: "recovering_stop" },
    });
  });

  it("uses the fixed Telegram circuit code after three bounded recoveries", () => {
    const result = applyRuntimeObservation({
      policy: policy({
        state: "verifying",
        recoveryCount: 3,
        recoveryWindowStartedAtMs: NOW - 1,
      }),
      observation: { kind: "telegram_unhealthy", telegramState: "fatal" },
      nowMs: NOW,
    });
    expect(result.policy).toMatchObject({
      state: "stopping",
      errorCode: "telegram_polling_conflict_or_unavailable",
      circuitOpenedAtMs: NOW,
    });
  });

  it("clears the Telegram timer only on full exact readiness", () => {
    const degraded = policy({ telegramNonConnectedSinceMs: NOW - 10_000 });
    expect(
      applyRuntimeObservation({
        policy: degraded,
        observation: { kind: "gateway_unhealthy" },
        nowMs: NOW,
      }).policy.telegramNonConnectedSinceMs,
    ).toBe(NOW - 10_000);
    expect(
      applyRuntimeObservation({
        policy: degraded,
        observation: { kind: "exact_ready", restartCount: 0 },
        nowMs: NOW,
      }).policy.telegramNonConnectedSinceMs,
    ).toBeNull();
  });

  it("splits stop then start and keeps unconfirmed cleanup from auto-starting", () => {
    const recovering = policy({ state: "recovering_stop", recoveryCount: 1 });
    const unconfirmed = applyRuntimeStopResult({
      policy: recovering,
      nowMs: NOW,
      desiredStatus: "running",
      result: "unconfirmed",
    });
    expect(unconfirmed.policy).toMatchObject({
      state: "recovering_stop",
      errorCode: "runtime_stop_unconfirmed",
    });
    expect(plan({ policy: unconfirmed.policy }).effect).toBe("stop");

    const confirmed = applyRuntimeStopResult({
      policy: recovering,
      nowMs: NOW,
      desiredStatus: "running",
      result: "confirmed",
    });
    expect(confirmed.policy.state).toBe("recovering_start");
    expect(plan({ policy: confirmed.policy }).effect).toBe("start");
  });

  it("moves accepted starts to verifying without declaring ready", () => {
    const accepted = applyRuntimeStartResult({
      policy: policy({ state: "recovering_start" }),
      nowMs: NOW,
      result: "accepted",
    });
    expect(accepted.policy).toMatchObject({ state: "verifying", stableSinceMs: null });
    expect(accepted.nextAttemptAtMs).toBe(NOW + 15_000);

    const ready = applyRuntimeObservation({
      policy: accepted.policy,
      observation: { kind: "exact_ready", restartCount: 0 },
      nowMs: NOW + 15_000,
    });
    expect(ready).toMatchObject({ recovered: true, openUsage: true });
    expect(ready.policy.state).toBe("observing");
  });

  it("keeps runner uncertainty non-recovering and closes usage only when heartbeat is stale", () => {
    const fresh = applyRuntimeObservation({
      policy: policy(),
      observation: { kind: "runner_unavailable", heartbeatStale: false },
      nowMs: NOW,
    });
    expect(fresh).toMatchObject({ recoveryRequested: false, closeUsage: false });

    const stale = applyRuntimeObservation({
      policy: policy(),
      observation: { kind: "runner_unavailable", heartbeatStale: true },
      nowMs: NOW,
    });
    expect(stale).toMatchObject({ recoveryRequested: false, closeUsage: true });
  });

  it("resets a circuit only for an explicit owner action and preserves restart evidence", () => {
    const circuit = policy({
      state: "circuit_open",
      recoveryCount: 3,
      recoveryWindowStartedAtMs: NOW - 1,
      lastRestartCount: 7,
      errorCode: "telegram_webhook_conflict",
      circuitOpenedAtMs: NOW,
    });

    expect(plan({ policy: circuit }).effect).toBe("none");
    expect(resetRuntimeForOwnerAction({ policy: circuit, action: "start" })).toMatchObject({
      state: "recovering_start",
      generation: 3,
      recoveryCount: 0,
      recoveryWindowStartedAtMs: null,
      lastRestartCount: 7,
      errorCode: null,
      circuitOpenedAtMs: null,
    });
    expect(resetRuntimeForOwnerAction({ policy: circuit, action: "restart" }).state).toBe(
      "recovering_stop",
    );
    expect(() =>
      resetRuntimeForOwnerAction({
        policy: { ...circuit, generation: 2_147_483_647 },
        action: "restart",
      }),
    ).toThrow("Runtime generation is exhausted.");
  });

  it("never lets an observation reset an open circuit", () => {
    const circuit = policy({
      state: "circuit_open",
      errorCode: "runtime_recovery_exhausted",
      circuitOpenedAtMs: NOW - 1,
    });
    const result = applyRuntimeObservation({
      policy: circuit,
      observation: { kind: "exact_ready", restartCount: 0 },
      nowMs: NOW,
    });
    expect(result).toMatchObject({
      nextAttemptAtMs: null,
      openUsage: false,
      policy: { state: "circuit_open", errorCode: "runtime_recovery_exhausted" },
    });
  });

  it("maps runtime state to closed, fixed public presentation without internals", () => {
    const presentations = [
      runtimePublicPresentation({ policy: policy(), desiredStatus: "running" }),
      runtimePublicPresentation({
        policy: policy({ state: "recovering_start", errorCode: "runtime_container_absent" }),
        desiredStatus: "running",
      }),
      runtimePublicPresentation({
        policy: policy({ state: "circuit_open", errorCode: "telegram_webhook_conflict" }),
        desiredStatus: "running",
      }),
      runtimePublicPresentation({
        policy: policy({ state: "stopped" }),
        desiredStatus: "stopped",
      }),
    ];

    expect(presentations.map((value) => value.state)).toEqual([
      "healthy",
      "recovering",
      "attention_required",
      "intentionally_stopped",
    ]);
    expect(JSON.stringify(presentations)).not.toMatch(
      /generation|attempt|recoveryCount|restartCount|runner|operation|lease|secret-value/i,
    );
  });

  it("keeps desired Stop truthful until runtime stop is authoritative", () => {
    expect(runtimePublicPresentation({ policy: policy(), desiredStatus: "stopped" })).toMatchObject(
      {
        state: "stopping",
        label: "Stopping",
        action: "wait",
      },
    );
    expect(
      runtimePublicPresentation({
        policy: policy({ state: "stopping" }),
        desiredStatus: "stopped",
      }),
    ).toMatchObject({ state: "stopping" });
    expect(
      runtimePublicPresentation({
        policy: policy({ state: "stopped" }),
        desiredStatus: "stopped",
      }),
    ).toMatchObject({ state: "intentionally_stopped", action: "start" });
    expect(
      runtimePublicPresentation({
        policy: policy({ state: "stopped" }),
        desiredStatus: "running",
      }),
    ).toMatchObject({ state: "unavailable", action: "wait" });
  });
});
