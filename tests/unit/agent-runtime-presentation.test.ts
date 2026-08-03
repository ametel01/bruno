import { describe, expect, it } from "vitest";
import { buildSafeRuntimePresentation } from "@/src/server/agents/agent-runtime-read";
import type { AgentRuntimeState } from "@/src/server/agents/agent-runtime-state";
import {
  parseSafeRuntimeGetBody,
  parseSafeRuntimePresentation,
  runtimePollDelayMs,
} from "@/src/shared/agent-runtime-presentation";

const SAFE_CONFIG_REVISION = "runtime-v2";

describe("agent runtime public presentation", () => {
  it.each([
    ["observing", "running", "healthy", "none", "Ready"],
    ["recovering_stop", "running", "recovering", "wait", "Recovering"],
    ["recovering_start", "running", "recovering", "wait", "Recovering"],
    ["verifying", "running", "recovering", "wait", "Recovering"],
    ["stopping", "stopped", "stopping", "wait", "Stopping"],
    ["stopped", "stopped", "intentionally_stopped", "start", "Intentionally stopped"],
    ["circuit_open", "running", "attention_required", "restart", "Attention required"],
  ] as const)("maps %s without exposing controller evidence", (state, desiredStatus, kind, action, label) => {
    const runtime = buildSafeRuntimePresentation({
      desiredStatus,
      latestDeploymentStage: "ready",
      runtime: runtimeRow(state),
    });

    expect(runtime).toMatchObject({ kind, action, label });
    expect(Object.keys(runtime ?? {}).sort()).toEqual(["action", "kind", "label", "message"]);
    expect(JSON.stringify(runtime)).not.toMatch(
      /runtime-v2|generation|revision|counter|lease|operation|timestamp/i,
    );
  });

  it("keeps historical setup separate and fails managed-ready evidence closed", () => {
    expect(
      buildSafeRuntimePresentation({
        desiredStatus: "running",
        latestDeploymentStage: "connecting_telegram",
        runtime: runtimeRow("observing"),
      }),
    ).toBeNull();

    for (const runtime of [
      null,
      { ...runtimeRow("observing"), configRevision: " malformed " },
      { ...runtimeRow("observing"), operationId: null },
      { ...runtimeRow("observing"), lastObservedAt: null },
      { ...runtimeRow("observing"), stableSince: "not-a-time" },
      { ...runtimeRow("stopped") },
    ]) {
      expect(
        buildSafeRuntimePresentation({
          desiredStatus: "running",
          latestDeploymentStage: "ready",
          runtime,
        }),
      ).toEqual({
        kind: "unavailable",
        action: "wait",
        label: "Unavailable",
        message: "Runtime state could not be verified safely.",
      });
    }
  });

  it("allows a validated runtime revision that intentionally differs from deployment history", () => {
    const runtime = buildSafeRuntimePresentation({
      desiredStatus: "running",
      latestDeploymentStage: "ready",
      runtime: { ...runtimeRow("observing"), configRevision: "replacement-secret-v3" },
    });

    expect(runtime?.kind).toBe("healthy");
    expect(JSON.stringify(runtime)).not.toContain("replacement-secret-v3");
  });
});

describe("runtime browser DTO parser", () => {
  const safe = {
    kind: "recovering",
    action: "wait",
    label: "Recovering",
    message: "The managed gateway is converging to ready.",
  } as const;

  it("accepts only the exact closed DTO and nullable route envelope", () => {
    expect(parseSafeRuntimePresentation(safe)).toEqual(safe);
    expect(parseSafeRuntimeGetBody({ runtime: safe })).toEqual({ ok: true, runtime: safe });
    expect(parseSafeRuntimeGetBody({ runtime: null })).toEqual({ ok: true, runtime: null });
    expect(parseSafeRuntimeGetBody({ runtime: { ...safe, generation: 7 } })).toEqual({ ok: false });
    expect(parseSafeRuntimeGetBody({ runtime: safe, operationId: "private" })).toEqual({
      ok: false,
    });
  });

  it("rejects hostile accessors without invoking them", () => {
    let reads = 0;
    const hostile = Object.defineProperty(
      {
        action: "wait",
        label: "Recovering",
        message: "Safe copy",
      },
      "kind",
      {
        enumerable: true,
        get() {
          reads += 1;
          return "recovering";
        },
      },
    );

    expect(parseSafeRuntimePresentation(hostile)).toBeNull();
    expect(reads).toBe(0);
  });

  it("uses bounded polling cadence without timestamps in the DTO", () => {
    expect(runtimePollDelayMs(-1)).toBe(5_000);
    expect(runtimePollDelayMs(0)).toBe(5_000);
    expect(runtimePollDelayMs(5 * 60_000)).toBe(15_000);
    expect(runtimePollDelayMs(15 * 60_000)).toBe(30_000);
  });
});

function runtimeRow(state: AgentRuntimeState) {
  const circuit = state === "circuit_open";
  return {
    state,
    configRevision: SAFE_CONFIG_REVISION,
    operationId:
      state === "observing" || state === "verifying"
        ? "00000000-0000-4000-8000-000000009001"
        : null,
    generation: 9,
    attemptCount: 4,
    recoveryCount: 2,
    recoveryWindowStartedAt: null,
    stableSince: state === "observing" ? new Date("2026-08-03T00:00:00.000Z") : null,
    telegramNonConnectedSince: null,
    lastRestartCount: 1,
    lastObservedAt: state === "observing" ? new Date("2026-08-03T00:00:00.000Z") : null,
    lastReadyAt: state === "observing" ? new Date("2026-08-03T00:00:00.000Z") : null,
    errorCode: circuit ? ("runtime_recovery_exhausted" as const) : null,
    circuitOpenedAt: circuit ? new Date("2026-08-03T00:01:00.000Z") : null,
  };
}
