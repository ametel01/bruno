import { describe, expect, it, vi } from "vitest";
import { DEFAULT_HERMES_WORKLOAD_IMAGE } from "@/src/runner-service/constants";
import type { RunnerDurableStatusSnapshot } from "@/src/runner-service/runner-contracts";
import { MANAGED_AGENT_LAUNCH_SPEC_VERSION } from "@/src/server/agents/agent-launch-spec";
import type { AgentLaunchSpecBuildResult } from "@/src/server/agents/agent-launch-builder";
import {
  AGENT_RUNTIME_RECONCILE_ACTION_DEADLINE_MS,
  type AgentRuntimeReconcilerDependencies,
  reconcileNextAgentRuntime,
  reconcileTargetAgentRuntime,
  reconcileTargetRunnerRuntime,
  mapRunnerSnapshotToRuntimeObservation,
  type RuntimeLoadedContext,
  type RuntimeRunnerAdapter,
  type RuntimeTransition,
} from "@/src/server/agents/agent-runtime-reconciler";
import {
  AgentRuntimePersistenceError,
  type ClaimedAgentRuntimeReconciliation,
} from "@/src/server/agents/agent-runtime-store";
import type { DatabaseConnection } from "@/src/server/db/client";
import type { ManualRunnerRecord } from "@/src/server/runners/manual-runner-persistence";

const NOW = new Date("2026-08-03T08:00:00.000Z");
const USER_ID = "00000000-0000-4000-8000-000000009001";
const RUNNER_ID = "00000000-0000-4000-8000-000000009101";
const AGENT_ID = "00000000-0000-4000-8000-000000009201";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000009301";
const OPERATION_ID = "00000000-0000-4000-8000-000000009401";
const REVISION = "cfg-runtime-9";
const CUSTOM_HERMES_IMAGE =
  "ghcr.io/ametel01/agentbay-hermes@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const runner: ManualRunnerRecord = {
  id: RUNNER_ID,
  userId: USER_ID,
  name: "Fake runner",
  kind: "manual_vps",
  endpointUrl: "http://127.0.0.1:8787",
  status: "online",
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  deletedAt: null,
};

function claim(
  overrides: Partial<ClaimedAgentRuntimeReconciliation> = {},
): ClaimedAgentRuntimeReconciliation {
  return {
    agentId: AGENT_ID,
    userId: USER_ID,
    state: "observing",
    generation: 2,
    configRevision: REVISION,
    operationId: OPERATION_ID,
    attemptCount: 1,
    recoveryCount: 0,
    recoveryWindowStartedAt: null,
    stableSince: NOW,
    telegramNonConnectedSince: null,
    lastRestartCount: 0,
    lastObservedAt: NOW,
    lastReadyAt: NOW,
    errorCode: null,
    nextAttemptAt: NOW,
    leaseOwner: "reconcile:11111111-1111-4111-8111-111111111111",
    leaseExpiresAt: new Date(NOW.getTime() + 90_000),
    circuitOpenedAt: null,
    runnerId: RUNNER_ID,
    desiredStatus: "running",
    latestDeploymentId: DEPLOYMENT_ID,
    ...overrides,
  };
}

function loaded(overrides: Partial<RuntimeLoadedContext> = {}): RuntimeLoadedContext {
  return {
    agentStatus: "running",
    runner,
    runnerAvailability: "eligible",
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<RunnerDurableStatusSnapshot> = {},
): RunnerDurableStatusSnapshot {
  return {
    phase: "ready",
    operation: {
      id: OPERATION_ID,
      action: "start",
      target: {
        image: DEFAULT_HERMES_WORKLOAD_IMAGE,
        launchSpecVersion: MANAGED_AGENT_LAUNCH_SPEC_VERSION,
        configRevision: REVISION,
      },
      acceptedAt: NOW.toISOString(),
    },
    container: {
      id: "container-internal",
      name: "agent-internal",
      image: DEFAULT_HERMES_WORKLOAD_IMAGE,
      state: "running",
      startedAt: NOW.toISOString(),
      finishedAt: null,
      observedAt: NOW.toISOString(),
      restartPolicy: { name: "unless-stopped", maximumRetryCount: 0 },
      restartCount: 0,
    },
    revision: {
      state: "match",
      requested: REVISION,
      containerLabel: REVISION,
      projectionMarker: REVISION,
      observedAt: NOW.toISOString(),
    },
    gateway: { state: "running", observedAt: NOW.toISOString() },
    apiServer: { required: true, state: "connected", observedAt: NOW.toISOString() },
    telegram: { required: true, state: "connected", observedAt: NOW.toISOString() },
    readinessReason: null,
    observedAt: NOW.toISOString(),
    ...overrides,
  };
}

function harness(input: {
  claim: ClaimedAgentRuntimeReconciliation;
  context?: RuntimeLoadedContext;
  status?: ReturnType<typeof vi.fn>;
  stop?: ReturnType<typeof vi.fn>;
  start?: ReturnType<typeof vi.fn>;
  diagnostic?: NonNullable<AgentRuntimeReconcilerDependencies["telegramWebhookDiagnostic"]>;
  launch?: NonNullable<AgentRuntimeReconcilerDependencies["launchSpec"]>;
  workloadImage?: string;
}) {
  const transition = vi.fn(
    async (
      _connection: DatabaseConnection,
      _claim: ClaimedAgentRuntimeReconciliation,
      value: RuntimeTransition,
    ) => {
      return Boolean(value);
    },
  );
  const status = input.status ?? vi.fn(async () => ({ ok: true, runner, snapshot: snapshot() }));
  const stop = input.stop ?? vi.fn(async () => ({ ok: true, runner, containers: [] }));
  const start = input.start ?? vi.fn();
  const connection = {} as DatabaseConnection;
  const manualRunnerAdapter = vi.fn(() => ({
    status: status as RuntimeRunnerAdapter["status"],
    stop: stop as RuntimeRunnerAdapter["stop"],
    start: start as RuntimeRunnerAdapter["start"],
  }));
  const readHermesWorkloadImage = vi.fn(() => input.workloadImage ?? DEFAULT_HERMES_WORKLOAD_IMAGE);

  const dependencies: AgentRuntimeReconcilerDependencies = {
    createConnection: () => connection,
    now: () => NOW,
    randomUUID: () => "22222222-2222-4222-8222-222222222222",
    readHermesWorkloadImage,
    claimRuntime: vi.fn(async () => input.claim),
    loadContext: vi.fn(async () => input.context ?? loaded()),
    persistTransition: transition,
    manualRunnerAdapter,
    ...(input.diagnostic ? { telegramWebhookDiagnostic: input.diagnostic } : {}),
    ...(input.launch ? { launchSpec: input.launch } : {}),
  };

  return {
    transition,
    status,
    stop,
    start,
    manualRunnerAdapter,
    readHermesWorkloadImage,
    dependencies,
  };
}

function managedLaunch(image = DEFAULT_HERMES_WORKLOAD_IMAGE): AgentLaunchSpecBuildResult {
  return {
    ok: true,
    spec: {
      version: MANAGED_AGENT_LAUNCH_SPEC_VERSION,
      agent: { id: AGENT_ID, configRevision: REVISION },
      image: { ref: image },
      secrets: { telegramBotToken: "123456:abcdefghijklmnopqrstuvwxyz" },
    },
  } as unknown as AgentLaunchSpecBuildResult;
}

describe("agent runtime reconciler", () => {
  it("derives global, agent, and runner claim targets without accepting ownership input", async () => {
    const targets: unknown[] = [];
    const dependencies: AgentRuntimeReconcilerDependencies = {
      createConnection: () => ({}) as DatabaseConnection,
      randomUUID: () => "22222222-2222-4222-8222-222222222222",
      claimRuntime: vi.fn(async (input) => {
        targets.push(input.target);
        return null;
      }),
    };

    await reconcileNextAgentRuntime(dependencies);
    await reconcileTargetAgentRuntime(AGENT_ID, dependencies);
    await reconcileTargetRunnerRuntime(RUNNER_ID, dependencies);

    expect(targets).toEqual([
      { kind: "global" },
      { kind: "agent", agentId: AGENT_ID },
      { kind: "runner", runnerId: RUNNER_ID },
    ]);
  });

  it("claims globally, performs one exact status observation, and preserves safe persistence only", async () => {
    const test = harness({ claim: claim() });

    await expect(reconcileNextAgentRuntime(test.dependencies)).resolves.toEqual({
      processed: 1,
      outcome: "observed",
    });

    expect(test.status).toHaveBeenCalledOnce();
    expect(test.stop).not.toHaveBeenCalled();
    expect(test.start).not.toHaveBeenCalled();
    expect(test.manualRunnerAdapter).toHaveBeenCalledWith(
      runner,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeoutMs: AGENT_RUNTIME_RECONCILE_ACTION_DEADLINE_MS,
      }),
    );
    const persisted = test.transition.mock.calls[0]?.[2] as RuntimeTransition;
    expect(persisted).toMatchObject({
      agentStatus: "running",
      statusReason: "Hermes gateway is ready.",
      openUsage: true,
      closeUsage: false,
      mutation: {
        state: "observing",
        attemptCount: 0,
        operationId: OPERATION_ID,
        lastObservedAt: NOW,
        lastReadyAt: NOW,
        nextAttemptAt: new Date(NOW.getTime() + 60_000),
      },
    });
    expect(JSON.stringify(persisted)).not.toContain("container-internal");
    expect(JSON.stringify(persisted)).not.toContain(DEFAULT_HERMES_WORKLOAD_IMAGE);
  });

  it("uses the configured workload image for live status observations", async () => {
    const base = snapshot();

    if (!base.operation) {
      throw new Error("Expected an operation in the strict runtime fixture.");
    }

    const customSnapshot = snapshot({
      operation: {
        ...base.operation,
        target: { ...base.operation.target, image: CUSTOM_HERMES_IMAGE },
      },
      container: { ...base.container, image: CUSTOM_HERMES_IMAGE },
    });
    const test = harness({
      claim: claim(),
      status: vi.fn(async () => ({ ok: true, runner, snapshot: customSnapshot })),
      workloadImage: CUSTOM_HERMES_IMAGE,
    });

    await expect(reconcileNextAgentRuntime(test.dependencies)).resolves.toEqual({
      processed: 1,
      outcome: "observed",
    });

    expect(test.readHermesWorkloadImage).toHaveBeenCalledOnce();
    expect(test.transition.mock.calls[0]?.[2]).toMatchObject({
      mutation: { state: "observing", lastReadyAt: NOW },
    });
  });

  it("fences a newly observed desired Stop before making any runner request", async () => {
    const test = harness({ claim: claim({ desiredStatus: "stopped" }) });

    await expect(reconcileTargetAgentRuntime(AGENT_ID, test.dependencies)).resolves.toEqual({
      processed: 1,
      outcome: "recovering",
    });

    expect(test.status).not.toHaveBeenCalled();
    expect(test.stop).not.toHaveBeenCalled();
    expect(test.start).not.toHaveBeenCalled();
    expect(test.transition.mock.calls[0]?.[2]).toMatchObject({
      agentStatus: "restarting",
      statusReason: "The managed gateway is stopping.",
      mutation: { state: "stopping", generation: 3, nextAttemptAt: NOW },
    });
  });

  it("closes usage on stale runner evidence without treating it as workload absence", async () => {
    const test = harness({
      claim: claim(),
      context: loaded({ runnerAvailability: "unavailable" }),
    });

    await expect(reconcileNextAgentRuntime(test.dependencies)).resolves.toEqual({
      processed: 1,
      outcome: "recovering",
    });
    expect(test.status).not.toHaveBeenCalled();
    expect(test.transition.mock.calls[0]?.[2]).toMatchObject({
      closeUsage: true,
      mutation: {
        state: "observing",
        errorCode: "runtime_runner_unavailable",
        nextAttemptAt: new Date(NOW.getTime() + 15_000),
      },
    });
  });

  it("uses a webhook diagnostic as its own effect before Telegram-driven Stop", async () => {
    const diagnostic = vi.fn(async () => "empty" as const);
    const launch = vi.fn(async () => managedLaunch(CUSTOM_HERMES_IMAGE));
    const test = harness({
      claim: claim({
        state: "recovering_stop",
        operationId: null,
        recoveryCount: 1,
        telegramNonConnectedSince: new Date(NOW.getTime() - 120_000),
        errorCode: "runtime_telegram_unhealthy",
      }),
      diagnostic,
      launch,
      workloadImage: CUSTOM_HERMES_IMAGE,
    });

    await expect(reconcileNextAgentRuntime(test.dependencies)).resolves.toEqual({
      processed: 1,
      outcome: "recovering",
    });
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(USER_ID, AGENT_ID, {
      createConnection: expect.any(Function),
      hermesWorkloadImage: CUSTOM_HERMES_IMAGE,
      trustedConfigRevision: REVISION,
    });
    expect(test.stop).not.toHaveBeenCalled();
    expect(test.start).not.toHaveBeenCalled();
    expect(test.transition.mock.calls[0]?.[2]).toMatchObject({
      closeUsage: true,
      mutation: {
        state: "recovering_stop",
        attemptCount: 0,
        telegramNonConnectedSince: null,
        nextAttemptAt: NOW,
      },
    });
    expect(JSON.stringify(test.transition.mock.calls)).not.toContain("123456");
  });

  it("splits confirmed Stop and accepted Start across separate one-effect claims", async () => {
    const stopClaim = harness({
      claim: claim({ state: "recovering_stop", operationId: null }),
    });

    await reconcileNextAgentRuntime(stopClaim.dependencies);
    expect(stopClaim.stop).toHaveBeenCalledOnce();
    expect(stopClaim.start).not.toHaveBeenCalled();
    expect(stopClaim.status).not.toHaveBeenCalled();
    expect(stopClaim.transition.mock.calls[0]?.[2]).toMatchObject({
      closeUsage: true,
      mutation: {
        state: "recovering_start",
        attemptCount: 0,
        operationId: null,
        nextAttemptAt: NOW,
      },
    });

    const acceptedOperationId = "00000000-0000-4000-8000-000000009499";
    const launch = vi.fn(async () => managedLaunch(CUSTOM_HERMES_IMAGE));
    const start = vi.fn(async () => ({
      ok: true,
      state: "accepted" as const,
      runner,
      operation: {
        id: acceptedOperationId,
        action: "start" as const,
        target: {
          image: CUSTOM_HERMES_IMAGE,
          launchSpecVersion: MANAGED_AGENT_LAUNCH_SPEC_VERSION,
          configRevision: REVISION,
        },
        acceptedAt: NOW.toISOString(),
      },
      snapshot: snapshot({ phase: "accepted", readinessReason: "launch_accepted" }),
    }));
    const startClaim = harness({
      claim: claim({ state: "recovering_start", operationId: null }),
      start,
      launch,
      workloadImage: CUSTOM_HERMES_IMAGE,
    });

    await reconcileNextAgentRuntime(startClaim.dependencies);
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({ image: { ref: CUSTOM_HERMES_IMAGE } }),
    );
    expect(startClaim.readHermesWorkloadImage).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(USER_ID, AGENT_ID, {
      createConnection: expect.any(Function),
      hermesWorkloadImage: CUSTOM_HERMES_IMAGE,
      trustedConfigRevision: REVISION,
    });
    expect(startClaim.stop).not.toHaveBeenCalled();
    expect(startClaim.status).not.toHaveBeenCalled();
    expect(startClaim.transition.mock.calls[0]?.[2]).toMatchObject({
      mutation: {
        state: "verifying",
        attemptCount: 0,
        operationId: acceptedOperationId,
        nextAttemptAt: new Date(NOW.getTime() + 15_000),
      },
    });
  });

  it("does not persist an immediate restart step before its transaction timestamp", async () => {
    const test = harness({
      claim: claim({ state: "recovering_stop", operationId: null }),
    });
    let tick = 0;
    test.dependencies.now = () => new Date(NOW.getTime() + tick++);
    test.dependencies.persistTransition = vi.fn(
      async (
        _connection: DatabaseConnection,
        _claim: ClaimedAgentRuntimeReconciliation,
        transition: RuntimeTransition,
        persistedAt: Date,
      ) => {
        if (transition.mutation.nextAttemptAt && transition.mutation.nextAttemptAt < persistedAt) {
          throw new AgentRuntimePersistenceError(new Error("Invalid runtime result mutation."));
        }
        return true;
      },
    );

    await expect(reconcileNextAgentRuntime(test.dependencies)).resolves.toEqual({
      processed: 1,
      outcome: "recovering",
    });
  });

  it("bounds uncertain webhook diagnostics and opens cleanup-only circuit without recycling", async () => {
    const diagnostic = vi.fn(async () => "uncertain" as const);
    const test = harness({
      claim: claim({
        state: "recovering_stop",
        operationId: null,
        attemptCount: 5,
        recoveryCount: 1,
        telegramNonConnectedSince: new Date(NOW.getTime() - 120_000),
        errorCode: "runtime_telegram_unhealthy",
      }),
      diagnostic,
      launch: vi.fn(async () => managedLaunch()),
    });

    await reconcileNextAgentRuntime(test.dependencies);

    expect(diagnostic).toHaveBeenCalledOnce();
    expect(test.stop).not.toHaveBeenCalled();
    expect(test.start).not.toHaveBeenCalled();
    expect(test.transition.mock.calls[0]?.[2]).toMatchObject({
      closeUsage: true,
      event: {
        type: "agent.runtime_circuit_opened",
        reasonCode: "telegram_polling_conflict_or_unavailable",
        cleanupRequired: true,
        telegramRequired: true,
      },
      mutation: {
        state: "stopping",
        errorCode: "telegram_polling_conflict_or_unavailable",
        circuitOpenedAt: NOW,
        nextAttemptAt: NOW,
      },
    });
  });

  it("accepts strict synchronous compatibility-ready once and schedules observation instead of another start", async () => {
    const start = vi.fn(async () => ({
      ok: true,
      state: "ready" as const,
      runner,
      container: { status: "running" },
      target: {
        image: DEFAULT_HERMES_WORKLOAD_IMAGE,
        launchSpecVersion: MANAGED_AGENT_LAUNCH_SPEC_VERSION,
        configRevision: REVISION,
      },
    }));
    const test = harness({
      claim: claim({ state: "recovering_start", operationId: null }),
      start,
      launch: vi.fn(async () => managedLaunch()),
    });

    await reconcileNextAgentRuntime(test.dependencies);

    expect(start).toHaveBeenCalledOnce();
    expect(test.status).not.toHaveBeenCalled();
    expect(test.stop).not.toHaveBeenCalled();
    expect(test.transition.mock.calls[0]?.[2]).toMatchObject({
      closeUsage: true,
      mutation: { state: "observing", attemptCount: 0, operationId: null, nextAttemptAt: NOW },
    });
  });

  it("adopts the first strict v3 operation after compatibility-ready and rejects later operation drift", async () => {
    const adoption = harness({ claim: claim({ operationId: null }) });

    await reconcileNextAgentRuntime(adoption.dependencies);

    expect(adoption.transition.mock.calls[0]?.[2]).toMatchObject({
      agentStatus: "running",
      openUsage: true,
      mutation: {
        state: "observing",
        operationId: OPERATION_ID,
        lastReadyAt: NOW,
      },
    });

    const differentOperationId = "00000000-0000-4000-8000-000000009498";
    const driftSnapshot = snapshot();
    if (!driftSnapshot.operation) {
      throw new Error("Expected an operation in the strict runtime fixture.");
    }
    const driftOperation = driftSnapshot.operation;
    const drift = harness({
      claim: claim({ operationId: OPERATION_ID }),
      status: vi.fn(async () => ({
        ok: true,
        runner,
        snapshot: snapshot({
          operation: {
            ...driftOperation,
            id: differentOperationId,
          },
        }),
      })),
    });

    await reconcileNextAgentRuntime(drift.dependencies);

    expect(drift.transition.mock.calls[0]?.[2]).toMatchObject({
      agentStatus: "restarting",
      closeUsage: true,
      openUsage: false,
      mutation: {
        state: "recovering_stop",
        operationId: null,
        errorCode: "runtime_revision_mismatch",
      },
    });
  });

  it("emits recovery completion independent of recovery count and without internal metadata", async () => {
    const test = harness({
      claim: claim({
        state: "verifying",
        recoveryCount: 2,
        errorCode: "runtime_gateway_unhealthy",
      }),
    });

    await reconcileNextAgentRuntime(test.dependencies);

    const transition = test.transition.mock.calls[0]?.[2] as RuntimeTransition;
    expect(transition.event).toEqual({
      type: "agent.runtime_recovered",
      fromStatus: "running",
      toStatus: "running",
      reasonCode: "runtime_gateway_unhealthy",
      recoveryCount: 2,
      cleanupRequired: false,
      telegramRequired: false,
    });
    for (const forbidden of [
      "generation",
      "lease",
      "operation",
      "container",
      "revision",
      "runnerId",
      "endpoint",
    ]) {
      expect(JSON.stringify(transition.event)).not.toContain(forbidden);
    }
  });
});

describe("runtime observation mapping", () => {
  it("matches the exact configured workload image instead of the source-image default", () => {
    const base = snapshot();

    if (!base.operation) {
      throw new Error("Expected an operation in the strict runtime fixture.");
    }

    const customSnapshot = snapshot({
      operation: {
        ...base.operation,
        target: { ...base.operation.target, image: CUSTOM_HERMES_IMAGE },
      },
      container: { ...base.container, image: CUSTOM_HERMES_IMAGE },
    });

    expect(
      mapRunnerSnapshotToRuntimeObservation(customSnapshot, claim(), CUSTOM_HERMES_IMAGE),
    ).toEqual({ kind: "exact_ready", restartCount: 0 });
    expect(mapRunnerSnapshotToRuntimeObservation(snapshot(), claim(), CUSTOM_HERMES_IMAGE)).toEqual(
      { kind: "revision_mismatch" },
    );
  });

  it("requires operation, revision, durability policy, API, and Telegram evidence", () => {
    expect(
      mapRunnerSnapshotToRuntimeObservation(snapshot(), claim(), DEFAULT_HERMES_WORKLOAD_IMAGE),
    ).toEqual({
      kind: "exact_ready",
      restartCount: 0,
    });

    const cases: Array<[RunnerDurableStatusSnapshot, string]> = [
      [snapshot({ operation: null }), "revision_mismatch"],
      [
        snapshot({
          revision: { ...snapshot().revision, projectionMarker: "cfg-other" },
        }),
        "revision_mismatch",
      ],
      [
        snapshot({
          container: {
            ...snapshot().container,
            restartPolicy: { name: "always", maximumRetryCount: 0 },
          },
        }),
        "restart_policy_mismatch",
      ],
      [
        snapshot({ gateway: { state: "failed", observedAt: NOW.toISOString() } }),
        "gateway_unhealthy",
      ],
      [
        snapshot({
          apiServer: { required: true, state: "disconnected", observedAt: NOW.toISOString() },
        }),
        "api_server_unhealthy",
      ],
    ];

    for (const [value, kind] of cases) {
      expect(
        mapRunnerSnapshotToRuntimeObservation(value, claim(), DEFAULT_HERMES_WORKLOAD_IMAGE).kind,
      ).toBe(kind);
    }

    expect(
      mapRunnerSnapshotToRuntimeObservation(
        snapshot({
          telegram: { required: true, state: "fatal", observedAt: NOW.toISOString() },
        }),
        claim(),
        DEFAULT_HERMES_WORKLOAD_IMAGE,
      ),
    ).toEqual({ kind: "telegram_unhealthy", telegramState: "fatal" });
  });

  it("permits rolling compatibility correlation only after strict v3 durability evidence", () => {
    expect(
      mapRunnerSnapshotToRuntimeObservation(
        snapshot(),
        {
          configRevision: REVISION,
          operationId: null,
        },
        DEFAULT_HERMES_WORKLOAD_IMAGE,
      ),
    ).toEqual({ kind: "exact_ready", restartCount: 0 });

    expect(
      mapRunnerSnapshotToRuntimeObservation(
        snapshot({
          container: {
            ...snapshot().container,
            restartPolicy: { name: "unknown", maximumRetryCount: null },
            restartCount: null,
          },
        }),
        { configRevision: REVISION, operationId: null },
        DEFAULT_HERMES_WORKLOAD_IMAGE,
      ),
    ).toEqual({ kind: "restart_policy_mismatch" });
  });
});
