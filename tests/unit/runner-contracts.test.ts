import { describe, expect, it } from "vitest";
import {
  hasExactRunnerDurabilityEvidence,
  isRunnerStatusExactReady,
  parseRunnerCanary,
  parseRunnerCanaryRequest,
  parseRunnerLaunchAccepted,
  parseRunnerStatus,
  type RunnerAgentStatusSnapshot,
  type RunnerDurableStatusSnapshot,
} from "@/src/runner-service/runner-contracts";

const AGENT_ID = "00000000-0000-4000-8000-000000000123";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const OBSERVED_AT = "2026-08-03T04:30:00.000Z";

describe("runner contract parsers", () => {
  it("accepts exact launch/status/canary contracts", () => {
    const launch = {
      ok: true,
      contractVersion: "agentbay.runner.launch.v2",
      agentId: AGENT_ID,
      action: "start",
      operation: {
        id: OPERATION_ID,
        state: "accepted",
        disposition: "created",
        target: target(),
        acceptedAt: OBSERVED_AT,
      },
      snapshot: snapshot("accepted", "launch_accepted"),
    };

    expect(parseRunnerLaunchAccepted(launch).ok).toBe(true);
    expect(
      parseRunnerStatus({
        ok: true,
        contractVersion: "agentbay.runner.status.v3",
        agentId: AGENT_ID,
        action: "status",
        snapshot: durableSnapshot("ready", null),
      }).ok,
    ).toBe(true);
    expect(
      parseRunnerCanary({
        ok: true,
        contractVersion: "agentbay.runner.canary.v1",
        agentId: AGENT_ID,
        action: "canary",
        operationId: OPERATION_ID,
        configRevision: "cfg-1",
        observation: {
          state: "passed",
          reason: null,
          observedAt: OBSERVED_AT,
          latencyMs: 12,
        },
      }).ok,
    ).toBe(true);
  });

  it("rejects extra keys and invalid phase/reason invariants", () => {
    expect(
      parseRunnerStatus({
        ok: true,
        contractVersion: "agentbay.runner.status.v3",
        agentId: AGENT_ID,
        action: "status",
        snapshot: { ...durableSnapshot("ready", null), extra: true },
      }).ok,
    ).toBe(false);
    expect(
      parseRunnerStatus({
        ok: true,
        contractVersion: "agentbay.runner.status.v3",
        agentId: AGENT_ID,
        action: "status",
        snapshot: durableSnapshot("ready", "launch_accepted"),
      }).ok,
    ).toBe(false);
    expect(
      parseRunnerCanary({
        ok: true,
        contractVersion: "agentbay.runner.canary.v1",
        agentId: AGENT_ID,
        action: "canary",
        operationId: OPERATION_ID,
        configRevision: "cfg-1",
        observation: {
          state: "passed",
          reason: "canary_model_failed",
          observedAt: OBSERVED_AT,
          latencyMs: 12,
        },
      }).ok,
    ).toBe(false);
  });

  it("rejects canary requests with unsafe models, bad UUIDs, or extra keys", () => {
    expect(
      parseRunnerCanaryRequest({
        operationId: OPERATION_ID,
        configRevision: "cfg-1",
        model: "openrouter/auto",
      }).ok,
    ).toBe(true);
    expect(
      parseRunnerCanaryRequest({
        operationId: OPERATION_ID,
        configRevision: "cfg-1",
        model: "openrouter/auto",
        prompt: "override",
      }).ok,
    ).toBe(false);
    expect(
      parseRunnerCanaryRequest({
        operationId: "not-a-uuid",
        configRevision: "cfg-1",
        model: "openrouter/auto",
      }).ok,
    ).toBe(false);
    expect(
      parseRunnerCanaryRequest({
        operationId: OPERATION_ID,
        configRevision: "cfg-1",
        model: "bad model with spaces",
      }).ok,
    ).toBe(false);
  });

  it("rejects accessor records, invalid nested timestamps, and mismatched launch snapshots", () => {
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "operationId", {
      enumerable: true,
      get() {
        throw new Error("must not execute parser accessors");
      },
    });
    Object.defineProperties(accessor, {
      configRevision: { enumerable: true, value: "cfg-1" },
      model: { enumerable: true, value: "openrouter/auto" },
    });

    expect(() => parseRunnerCanaryRequest(accessor)).not.toThrow();
    expect(parseRunnerCanaryRequest(accessor).ok).toBe(false);

    const invalidTimestamp = durableSnapshot("starting", "gateway_starting");
    invalidTimestamp.container.startedAt = "not-a-timestamp";
    expect(
      parseRunnerStatus({
        ok: true,
        contractVersion: "agentbay.runner.status.v3",
        agentId: AGENT_ID,
        action: "status",
        snapshot: invalidTimestamp,
      }).ok,
    ).toBe(false);

    const mismatched = snapshot("accepted", "launch_accepted");
    if (!mismatched.operation) {
      throw new Error("accepted fixture requires an operation");
    }
    mismatched.operation = { ...mismatched.operation, id: AGENT_ID };
    expect(
      parseRunnerLaunchAccepted({
        ok: true,
        contractVersion: "agentbay.runner.launch.v2",
        agentId: AGENT_ID,
        action: "start",
        operation: {
          id: OPERATION_ID,
          state: "accepted",
          disposition: "created",
          target: target(),
          acceptedAt: OBSERVED_AT,
        },
        snapshot: mismatched,
      }).ok,
    ).toBe(false);
  });

  it("normalizes old v2 status as explicit unknown durability evidence", () => {
    const parsed = parseRunnerStatus({
      ok: true,
      contractVersion: "agentbay.runner.status.v2",
      agentId: AGENT_ID,
      action: "status",
      snapshot: snapshot("ready", null),
    });

    expect(parsed).toEqual({
      ok: true,
      response: {
        ok: true,
        contractVersion: "agentbay.runner.status.v2",
        agentId: AGENT_ID,
        action: "status",
        snapshot: {
          ...snapshot("ready", null),
          container: {
            ...snapshot("ready", null).container,
            restartPolicy: { name: "unknown", maximumRetryCount: null },
            restartCount: null,
          },
        },
      },
    });
    if (!parsed.ok) {
      throw new Error("legacy status should remain parseable");
    }
    expect(hasExactRunnerDurabilityEvidence(parsed.response.snapshot)).toBe(false);
    expect(isRunnerStatusExactReady(parsed.response)).toBe(false);
  });

  it("parses wrong policies for replacement but requires exact v3 durability for ready", () => {
    const wrongPolicy = durableSnapshot("ready", null);
    wrongPolicy.container.restartPolicy = { name: "always", maximumRetryCount: 0 };
    const parsedWrong = parseRunnerStatus({
      ok: true,
      contractVersion: "agentbay.runner.status.v3",
      agentId: AGENT_ID,
      action: "status",
      snapshot: wrongPolicy,
    });

    expect(parsedWrong.ok).toBe(true);
    if (!parsedWrong.ok) {
      throw new Error("wrong policy should be observable rather than a transport failure");
    }
    expect(isRunnerStatusExactReady(parsedWrong.response)).toBe(false);

    const exact = parseRunnerStatus({
      ok: true,
      contractVersion: "agentbay.runner.status.v3",
      agentId: AGENT_ID,
      action: "status",
      snapshot: durableSnapshot("ready", null),
    });
    expect(exact.ok).toBe(true);
    if (!exact.ok) {
      throw new Error("exact status should parse");
    }
    expect(isRunnerStatusExactReady(exact.response)).toBe(true);
  });

  it.each([
    ["connecting", "starting", "telegram_not_connected"],
    ["connected", "ready", null],
    ["disconnected", "starting", "telegram_not_connected"],
    ["retrying", "starting", "telegram_retrying"],
    ["fatal", "failed", "telegram_fatal"],
    ["paused", "failed", "telegram_paused"],
    ["disabled", "starting", "telegram_not_connected"],
    ["unknown", "starting", "telegram_not_connected"],
  ] as const)("accepts exact Telegram state %s", (state, phase, reason) => {
    const candidate = durableSnapshot(phase, reason);
    candidate.telegram.state = state;

    expect(
      parseRunnerStatus({
        ok: true,
        contractVersion: "agentbay.runner.status.v3",
        agentId: AGENT_ID,
        action: "status",
        snapshot: candidate,
      }).ok,
    ).toBe(true);
  });

  it("rejects the collapsed legacy failed Telegram state in v3", () => {
    const candidate = durableSnapshot("failed", "telegram_not_connected") as unknown as Record<
      string,
      unknown
    >;
    (candidate.telegram as Record<string, unknown>).state = "failed";

    expect(
      parseRunnerStatus({
        ok: true,
        contractVersion: "agentbay.runner.status.v3",
        agentId: AGENT_ID,
        action: "status",
        snapshot: candidate,
      }).ok,
    ).toBe(false);
  });

  it.each([
    -1, 2_147_483_648, 1.5,
  ])("rejects invalid v3 restart count evidence: %s", (restartCount) => {
    const candidate = durableSnapshot("ready", null) as unknown as Record<string, unknown>;
    (candidate.container as Record<string, unknown>).restartCount = restartCount;

    expect(
      parseRunnerStatus({
        ok: true,
        contractVersion: "agentbay.runner.status.v3",
        agentId: AGENT_ID,
        action: "status",
        snapshot: candidate,
      }).ok,
    ).toBe(false);
  });
});

function target() {
  return {
    image: "nousresearch/hermes-agent:test@sha256:abc",
    launchSpecVersion: "agentbay.hermes.launch.v3",
    configRevision: "cfg-1",
  };
}

function snapshot(
  phase: RunnerAgentStatusSnapshot["phase"],
  reason: RunnerAgentStatusSnapshot["readinessReason"],
): RunnerAgentStatusSnapshot {
  return {
    phase,
    operation: {
      id: OPERATION_ID,
      action: "start",
      target: target(),
      acceptedAt: OBSERVED_AT,
    },
    container: {
      id: "container-001",
      name: "agentbay-runner",
      image: target().image,
      state: "running",
      startedAt: OBSERVED_AT,
      finishedAt: null,
      observedAt: OBSERVED_AT,
    },
    revision: {
      state: "match",
      requested: "cfg-1",
      containerLabel: "cfg-1",
      projectionMarker: "cfg-1",
      observedAt: OBSERVED_AT,
    },
    gateway: { state: "running", observedAt: OBSERVED_AT },
    apiServer: { required: true, state: "connected", observedAt: OBSERVED_AT },
    telegram: { required: true, state: "connected", observedAt: OBSERVED_AT },
    readinessReason: reason,
    observedAt: OBSERVED_AT,
  };
}

function durableSnapshot(
  phase: RunnerDurableStatusSnapshot["phase"],
  reason: RunnerDurableStatusSnapshot["readinessReason"],
): RunnerDurableStatusSnapshot {
  const base = snapshot(phase, reason);

  return {
    ...base,
    container: {
      ...base.container,
      restartPolicy: { name: "unless-stopped", maximumRetryCount: 0 },
      restartCount: 0,
    },
    telegram: {
      ...base.telegram,
      state: base.telegram.state === "failed" ? "unknown" : base.telegram.state,
    },
  };
}
