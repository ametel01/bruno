import { describe, expect, it } from "vitest";
import type { DatabaseConnection } from "@/src/server/db/client";
import {
  createHermesStagingAcceptanceService,
  type HermesStagingAcceptanceBeginInput,
  type HermesStagingAcceptanceDependencies,
} from "@/src/server/staging/hermes-staging-acceptance";
import type {
  HermesStagingAcceptanceEffectContext,
  HermesStagingAcceptanceEffectExecution,
  HermesStagingAcceptanceEffectExecutor,
} from "@/src/server/staging/hermes-staging-acceptance-effects";
import {
  HERMES_STAGING_DEPLOYMENT_STAGES,
  type HermesStagingAcceptanceEffectKind,
  planHermesStagingAcceptance,
} from "@/src/server/staging/hermes-staging-acceptance-state";
import type {
  ClaimedHermesStagingAcceptanceRun,
  HermesStagingAcceptanceEvidenceMutation,
  HermesStagingAcceptanceRun,
} from "@/src/server/staging/hermes-staging-acceptance-store";
import {
  createHermesStagingAttestationChallenge,
  createHermesStagingAttestationToken,
} from "@/src/shared/hermes-staging-attestation-protocol";

const RUN_ID = "00000000-0000-4000-8000-00000000a001";
const OWNER_ID = "00000000-0000-4000-8000-00000000a002";
const AGENT_ID = "00000000-0000-4000-8000-00000000a003";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-00000000a004";
const RUNNER_ID = "00000000-0000-4000-8000-00000000a005";
const DIGEST = `sha256:${"a".repeat(64)}`;
const SOURCE_REVISION = "b".repeat(40);
const BEARER = "staging-acceptance-dedicated-secret-1234567890";
const START_MS = Date.parse("2026-08-03T10:00:00.000Z");

describe("Hermes staging acceptance orchestration", () => {
  it("runs the full saga with two human attestations and ordered cleanup", async () => {
    const harness = createHarness();
    const begun = await harness.service.command({ command: "begin" });
    expect(begun.phase).toBe("preflight");

    let lastPhase = begun.phase;
    for (let guard = 0; guard < 100; guard += 1) {
      const current = await harness.service.read(RUN_ID);
      if (!current) throw new Error("run disappeared");
      lastPhase = current.phase;

      if (current.nextAction.kind === "operator_telegram") {
        const challenge = createHermesStagingAttestationChallenge({
          runId: RUN_ID,
          purpose: current.nextAction.purpose,
          now: harness.now(),
          deadlineAt: new Date(START_MS + 60 * 60_000),
        });
        expect(challenge?.challengeId).toBe(current.nextAction.challengeId);
        const token = challenge
          ? createHermesStagingAttestationToken({
              bearerSecret: BEARER,
              runId: RUN_ID,
              challenge,
            })
          : null;
        if (!token) throw new Error("token generation failed");

        await harness.service.command({
          command: "attest_telegram_reply",
          runId: RUN_ID,
          challengeId: current.nextAction.challengeId,
          attestationToken: token,
        });
        continue;
      }

      if (current.phase === "complete") break;
      await harness.service.reconcileTarget(RUN_ID);
      harness.advance(16_000);
    }

    const complete = await harness.service.read(RUN_ID);
    expect(lastPhase).toBe("complete");
    expect(complete).toMatchObject({
      phase: "complete",
      errorCode: null,
      checks: {
        imageAttested: true,
        deploymentStagesObserved: true,
        initialReplyAttested: true,
        restartReady: true,
        restartImageAttested: true,
        postRestartReplyAttested: true,
        diagnosticsRedacted: true,
        intentionalStopStable: true,
        rollbackVerified: true,
      },
      cleanup: {
        agent: "absent",
        workload: "absent",
        firewall: "absent",
        droplet: "absent",
        runner: "deleted",
        secretsRevoked: true,
      },
    });
    expect(harness.executed.filter((effect) => effect === "create_ready_agent")).toHaveLength(1);
    expect(harness.executed.indexOf("attest_published_image")).toBeLessThan(
      harness.executed.indexOf("create_ready_agent"),
    );
    expect(harness.executed.slice(0, harness.executed.indexOf("create_ready_agent"))).not.toContain(
      "observe_agent_creation",
    );
    expect(harness.executed.indexOf("cleanup_workload")).toBeLessThan(
      harness.executed.indexOf("cleanup_secrets"),
    );
    expect(harness.executed.indexOf("cleanup_secrets")).toBeLessThan(
      harness.executed.indexOf("cleanup_firewall"),
    );
    expect(harness.executed.indexOf("cleanup_firewall")).toBeLessThan(
      harness.executed.indexOf("cleanup_droplet"),
    );
    expect(harness.executed.indexOf("cleanup_droplet")).toBeLessThan(
      harness.executed.indexOf("cleanup_runner"),
    );
    expect(harness.maxConcurrentEffects()).toBe(1);
    expect(harness.closeCount()).toBeGreaterThan(0);
  });

  it("returns the active run for duplicate begin without resolving new owner input", async () => {
    let resolutions = 0;
    const harness = createHarness({
      resolveBeginInput: async () => {
        resolutions += 1;
        return beginInput();
      },
    });

    const first = await harness.service.command({ command: "begin" });
    const second = await harness.service.command({ command: "begin" });
    expect(second.runId).toBe(first.runId);
    expect(resolutions).toBe(1);
    expect(harness.executed).toEqual([]);
  });

  it("does not execute an effect after a stale decision CAS", async () => {
    const harness = createHarness({ stalePersistOnce: true });
    await harness.service.command({ command: "begin" });
    const result = await harness.service.reconcileTarget(RUN_ID);

    expect(result).toMatchObject({ processed: 1, outcome: "waiting" });
    expect(harness.executed).toEqual([]);
    expect(harness.closeCount()).toBe(2);
  });

  it("uses a mutation observer after process death instead of repeating create", async () => {
    const harness = createHarness();
    harness.seed(
      makeRun({
        phase: "creating_ready_agent",
        state: "pending",
        pendingEffect: "create_ready_agent",
        attemptCount: 1,
        nextAttemptAt: new Date(START_MS),
      }),
    );

    await harness.service.reconcileTarget(RUN_ID);
    expect(harness.executed).toEqual(["observe_agent_creation"]);
  });

  it("turns a cleanup-only invocation into cleanup before any forward effect", async () => {
    const harness = createHarness();
    await harness.service.command({ command: "begin" });

    const result = await harness.service.reconcileNext({ allowForward: false });
    expect(result.outcome).toBe("cleanup_pending");
    expect(result.run?.desiredOutcome).toBe("cleanup");
    expect(harness.executed).toEqual(["cleanup_workload"]);
  });

  it("releases a forward lease as cleanup when the initial cleanup CAS races", async () => {
    const harness = createHarness({ loseInitialCleanupRequestOnce: true });
    await harness.service.command({ command: "begin" });

    const result = await harness.service.reconcileNext({ allowForward: false });
    expect(result).toMatchObject({ processed: 1, outcome: "cleanup_pending" });
    expect(result.run?.desiredOutcome).toBe("cleanup");
    expect(harness.run()?.leaseOwner).toBeNull();
    expect(harness.executed).toEqual([]);
  });

  it("fails closed before persistence when trusted begin inputs are unavailable", async () => {
    const harness = createHarness({ resolveBeginInput: async () => null });
    await expect(harness.service.command({ command: "begin" })).rejects.toThrow(
      "preflight failed safely",
    );
    expect(harness.run()).toBeNull();
    expect(harness.executed).toEqual([]);
    expect(harness.closeCount()).toBe(1);
  });

  it("times out and safely schedules an observer without leaking thrown details", async () => {
    const harness = createHarness({
      effectTimeoutMs: 1,
      executor: {
        async execute() {
          await new Promise(() => undefined);
          throw new Error("secret-provider-body");
        },
      },
    });
    await harness.service.command({ command: "begin" });

    const result = await harness.service.reconcileTarget(RUN_ID);
    expect(result.outcome).toBe("waiting");
    expect(JSON.stringify(result)).not.toContain("secret-provider-body");
    expect(harness.run()?.pendingEffect).toBe("preflight");
  });

  it("maps an executor throw to a safe retry and closes the connection", async () => {
    const harness = createHarness({
      executor: {
        async execute() {
          throw new Error("raw-secret-error");
        },
      },
    });
    await harness.service.command({ command: "begin" });
    const result = await harness.service.reconcileTarget(RUN_ID);

    expect(result.outcome).toBe("waiting");
    expect(JSON.stringify(result)).not.toContain("raw-secret-error");
    expect(harness.closeCount()).toBe(2);
  });

  it("keeps the shared challenge and HMAC protocol deterministic", () => {
    const challenge = createHermesStagingAttestationChallenge({
      runId: RUN_ID,
      purpose: "initial",
      now: new Date(START_MS),
      deadlineAt: new Date(START_MS + 60 * 60_000),
    });
    expect(challenge).toEqual({
      purpose: "initial",
      challengeId: "c6ccc7b9-fd04-5a53-8bbd-6e345d65e891",
      text: "plingpling Hermes initial acceptance c6ccc7b9-fd04-5a53-8bbd-6e345d65e891",
      digest: "sha256:e1f07e4317992d295897c2b6e225f6c834aa946472b6b2cf305db784c94cefd3",
      expiresAt: new Date("2026-08-03T10:05:00.000Z"),
    });
    expect(
      challenge &&
        createHermesStagingAttestationToken({
          bearerSecret: BEARER,
          runId: RUN_ID,
          challenge,
        }),
    ).toBe("b215271b3a1549fa3e7f68cf2cb221426db450f6381e9edf86f416f76e3be098");
  });

  it("drops unrelated or premature evidence from an effect result", async () => {
    const harness = createHarness({
      executor: {
        async execute(_effect) {
          return {
            result: { effect: "preflight", outcome: "confirmed" },
            evidence: {
              hostImageVerifiedAt: new Date(START_MS),
              runnerCleanupConfirmedAt: new Date(START_MS),
            },
          } as HermesStagingAcceptanceEffectExecution;
        },
      },
    });
    await harness.service.command({ command: "begin" });
    await harness.service.reconcileTarget(RUN_ID);

    expect(harness.run()).toMatchObject({
      hostImageVerified: false,
      runnerCleanupConfirmed: false,
    });
  });

  it("returns only the transport whitelist and never internal identifiers", async () => {
    const harness = createHarness();
    harness.seed(
      makeRun({
        agentId: AGENT_ID,
        deploymentId: DEPLOYMENT_ID,
        runnerId: RUNNER_ID,
        providerResourceId: "do-secret-resource",
        providerFirewallId: "do-secret-firewall",
      }),
    );

    const projection = await harness.service.read(RUN_ID);
    const serialized = JSON.stringify(projection);
    expect(Object.keys(projection ?? {}).sort()).toEqual([
      "checks",
      "cleanup",
      "completedAt",
      "desiredOutcome",
      "errorCode",
      "nextAction",
      "nextAttemptAt",
      "phase",
      "runId",
    ]);
    for (const internal of [
      AGENT_ID,
      DEPLOYMENT_ID,
      RUNNER_ID,
      "do-secret-resource",
      "do-secret-firewall",
    ]) {
      expect(serialized).not.toContain(internal);
    }
  });
});

type HarnessOptions = {
  stalePersistOnce?: boolean;
  loseInitialCleanupRequestOnce?: boolean;
  effectTimeoutMs?: number;
  executor?: HermesStagingAcceptanceEffectExecutor;
  resolveBeginInput?: HermesStagingAcceptanceDependencies["resolveBeginInput"];
};

function createHarness(options: HarnessOptions = {}) {
  let currentMs = START_MS;
  let currentRun: HermesStagingAcceptanceRun | null = null;
  let closed = 0;
  let stalePersist = options.stalePersistOnce ?? false;
  let loseCleanupRequest = options.loseInitialCleanupRequestOnce ?? false;
  let activeEffects = 0;
  let maximumEffects = 0;
  const executed: HermesStagingAcceptanceEffectKind[] = [];

  const defaultExecutor: HermesStagingAcceptanceEffectExecutor = {
    async execute(effect, context) {
      executed.push(effect);
      activeEffects += 1;
      maximumEffects = Math.max(maximumEffects, activeEffects);
      try {
        return successfulExecution(effect, context, new Date(currentMs));
      } finally {
        activeEffects -= 1;
      }
    },
  };

  const suppliedExecutor = options.executor;
  const executor: HermesStagingAcceptanceEffectExecutor = suppliedExecutor
    ? {
        async execute(effect, context, signal) {
          executed.push(effect);
          activeEffects += 1;
          maximumEffects = Math.max(maximumEffects, activeEffects);
          try {
            return await suppliedExecutor.execute(effect, context, signal);
          } finally {
            activeEffects -= 1;
          }
        },
      }
    : defaultExecutor;

  const store: NonNullable<HermesStagingAcceptanceDependencies["store"]> = {
    async begin(input) {
      if (currentRun) return { run: currentRun, disposition: "idempotent" };
      currentRun = makeRun({
        ownerUserId: input.ownerUserId,
        idempotencyKey: input.idempotencyKey,
        expectedSourceRevision: input.expectedSourceRevision,
        expectedPublishWorkflowRunId: input.expectedPublishWorkflowRunId,
        expectedImageDigest: input.expectedImageDigest,
        deadlineAt: input.deadlineAt,
        cleanupDeadlineAt: input.cleanupDeadlineAt,
        nextAttemptAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      });
      return { run: currentRun, disposition: "created" };
    },
    async read(input) {
      return currentRun?.id === input.runId ? currentRun : null;
    },
    async readActive() {
      return currentRun?.state === "complete" ? null : currentRun;
    },
    async requestCleanup(input) {
      if (
        !currentRun ||
        currentRun.id !== input.runId ||
        currentRun.generation !== input.expectedGeneration
      ) {
        return currentRun ? { run: currentRun, changed: false } : null;
      }
      if (loseCleanupRequest) {
        loseCleanupRequest = false;
        return { run: currentRun, changed: false };
      }
      const planned = planHermesStagingAcceptance({
        state: toWorkflow(currentRun),
        input: { kind: "cancel", generation: currentRun.generation, nowMs: input.now.getTime() },
      });
      if (!planned.state) throw new Error("cleanup planning failed");
      currentRun = applyWorkflow(
        currentRun,
        {
          ...planned.state,
          pendingEffect: null,
          nextAttemptAtMs: input.now.getTime(),
        },
        input.now,
        "pending",
      );
      return { run: currentRun, changed: true };
    },
    async attestChallenge(input) {
      if (!currentRun || currentRun.generation !== input.expectedGeneration) {
        return currentRun ? { run: currentRun, accepted: false } : null;
      }
      const planned = planHermesStagingAcceptance({
        state: toWorkflow(currentRun),
        input: {
          kind: "human_attestation",
          generation: currentRun.generation,
          nowMs: input.now.getTime(),
          proof: input.purpose,
          challengeDigest: input.challengeDigest,
          attestationDigest: input.attestationDigest,
        },
      });
      if (!planned.state) throw new Error("attestation planning failed");
      currentRun = applyWorkflow(
        currentRun,
        { ...planned.state, pendingEffect: null, nextAttemptAtMs: input.now.getTime() },
        input.now,
        "pending",
      );
      currentRun = {
        ...currentRun,
        ...(input.purpose === "initial"
          ? { initialHumanProofVerified: true, initialChallengeAttestedAt: input.now }
          : { postRestartHumanProofVerified: true, postRestartChallengeAttestedAt: input.now }),
      };
      return { run: currentRun, accepted: true };
    },
    async claimNext(input) {
      if (
        !currentRun ||
        currentRun.state === "complete" ||
        currentRun.state === "blocked" ||
        (input.target.kind === "run" && input.target.runId !== currentRun.id) ||
        (currentRun.nextAttemptAt?.getTime() ?? Number.POSITIVE_INFINITY) > input.now.getTime()
      ) {
        return null;
      }
      currentRun = {
        ...currentRun,
        state: "executing",
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: new Date(input.now.getTime() + 90_000),
        leaseAttempt: currentRun.leaseAttempt + 1,
        updatedAt: input.now,
      };
      return currentRun as ClaimedHermesStagingAcceptanceRun;
    },
    async persistDecision(input) {
      if (stalePersist) {
        stalePersist = false;
        return null;
      }
      if (!currentRun || currentRun.generation !== input.claim.generation) return null;
      currentRun = applyWorkflow(currentRun, input.workflowState, input.now, "executing", true);
      return currentRun as ClaimedHermesStagingAcceptanceRun;
    },
    async applyResult(input) {
      if (!currentRun || currentRun.generation !== input.claim.generation) return false;
      currentRun = applyWorkflow(
        currentRun,
        input.mutation.workflowState,
        input.now,
        input.mutation.queueState,
      );
      currentRun = applyEvidence(currentRun, input.mutation.evidence, input.mutation.completedAt);
      return true;
    },
  };

  const service = createHermesStagingAcceptanceService({
    createConnection: () =>
      ({
        db: {} as DatabaseConnection["db"],
        client: {} as DatabaseConnection["client"],
        close: async () => {
          closed += 1;
        },
      }) satisfies DatabaseConnection,
    now: () => new Date(currentMs),
    resolveBeginInput: options.resolveBeginInput ?? (async () => beginInput()),
    readAttestationBearer: () => BEARER,
    effectExecutor: executor,
    effectTimeoutMs: options.effectTimeoutMs ?? 100,
    store,
  });

  return {
    service,
    executed,
    now: () => new Date(currentMs),
    advance: (milliseconds: number) => {
      currentMs += milliseconds;
    },
    seed: (run: HermesStagingAcceptanceRun) => {
      currentRun = run;
    },
    run: () => currentRun,
    closeCount: () => closed,
    maxConcurrentEffects: () => maximumEffects,
  };
}

function beginInput(): HermesStagingAcceptanceBeginInput {
  return {
    ownerUserId: OWNER_ID,
    idempotencyKey: "hermes-staging-test-0001",
    expectedSourceRevision: SOURCE_REVISION,
    expectedPublishWorkflowRunId: "123456",
    expectedImageDigest: DIGEST,
    deadlineAt: new Date(START_MS + 60 * 60_000),
    cleanupDeadlineAt: new Date(START_MS + 2 * 60 * 60_000),
  };
}

function makeRun(overrides: Partial<HermesStagingAcceptanceRun> = {}): HermesStagingAcceptanceRun {
  const now = new Date(START_MS);
  return {
    id: RUN_ID,
    scopeKey: "global",
    ownerUserId: OWNER_ID,
    idempotencyKey: "hermes-staging-test-0001",
    desiredOutcome: "acceptance",
    phase: "preflight",
    state: "pending",
    terminalOutcome: null,
    generation: 0,
    attemptCount: 0,
    leaseAttempt: 0,
    pendingEffect: null,
    deploymentStageIndex: -1,
    errorCode: null,
    nextAttemptAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    deadlineAt: new Date(START_MS + 60 * 60_000),
    cleanupDeadlineAt: new Date(START_MS + 2 * 60 * 60_000),
    expectedSourceRevision: SOURCE_REVISION,
    expectedPublishWorkflowRunId: "123456",
    expectedImageDigest: DIGEST,
    observedImageDigest: null,
    agentId: null,
    deploymentId: null,
    runnerId: null,
    providerResourceId: null,
    providerFirewallId: null,
    challengePurpose: null,
    initialChallengeDigest: null,
    initialChallengeExpiresAt: null,
    initialAttestationDigest: null,
    initialChallengeAttestedAt: null,
    postRestartChallengeDigest: null,
    postRestartChallengeExpiresAt: null,
    postRestartAttestationDigest: null,
    postRestartChallengeAttestedAt: null,
    stopStableSince: null,
    publishedImageVerified: false,
    publishedImageVerifiedAt: null,
    hostImageVerified: false,
    hostImageVerifiedAt: null,
    agentReadyVerified: false,
    agentReadyVerifiedAt: null,
    initialHumanProofVerified: false,
    restartRequested: false,
    restartRequestedAt: null,
    restartVerified: false,
    restartVerifiedAt: null,
    restartedRuntimeVerified: false,
    restartedRuntimeVerifiedAt: null,
    postRestartHumanProofVerified: false,
    diagnosticsRedactedConfirmed: false,
    diagnosticsRedactedConfirmedAt: null,
    stopVerified: false,
    stopVerifiedAt: null,
    rollbackVerified: false,
    rollbackVerifiedAt: null,
    workloadCleanupConfirmed: false,
    workloadCleanupConfirmedAt: null,
    secretsCleanupConfirmed: false,
    secretsCleanupConfirmedAt: null,
    firewallCleanupConfirmed: false,
    firewallCleanupConfirmedAt: null,
    dropletCleanupConfirmed: false,
    dropletCleanupConfirmedAt: null,
    runnerCleanupConfirmed: false,
    runnerCleanupConfirmedAt: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

function toWorkflow(run: HermesStagingAcceptanceRun) {
  return {
    phase: run.phase,
    generation: run.generation,
    desiredOutcome: run.desiredOutcome,
    terminalOutcome: run.terminalOutcome,
    errorCode: run.errorCode,
    deadlineAtMs: run.deadlineAt.getTime(),
    cleanupDeadlineAtMs: run.cleanupDeadlineAt.getTime(),
    attemptCount: run.attemptCount,
    nextAttemptAtMs: run.nextAttemptAt?.getTime() ?? null,
    pendingEffect: run.pendingEffect,
    deploymentStageIndex: run.deploymentStageIndex,
    initialChallengeDigest: run.initialChallengeDigest,
    initialChallengeExpiresAtMs: run.initialChallengeExpiresAt?.getTime() ?? null,
    initialAttestationDigest: run.initialAttestationDigest,
    postRestartChallengeDigest: run.postRestartChallengeDigest,
    postRestartChallengeExpiresAtMs: run.postRestartChallengeExpiresAt?.getTime() ?? null,
    postRestartAttestationDigest: run.postRestartAttestationDigest,
    stopStableSinceMs: run.stopStableSince?.getTime() ?? null,
    cleanupConfirmed: {
      workload: run.workloadCleanupConfirmed,
      secrets: run.secretsCleanupConfirmed,
      firewall: run.firewallCleanupConfirmed,
      droplet: run.dropletCleanupConfirmed,
      runner: run.runnerCleanupConfirmed,
    },
  };
}

function applyWorkflow(
  run: HermesStagingAcceptanceRun,
  workflow: ReturnType<typeof toWorkflow>,
  now: Date,
  state: HermesStagingAcceptanceRun["state"],
  retainLease = false,
): HermesStagingAcceptanceRun {
  return {
    ...run,
    phase: workflow.phase,
    generation: run.generation + 1,
    desiredOutcome: workflow.desiredOutcome,
    terminalOutcome: workflow.terminalOutcome,
    errorCode: workflow.errorCode,
    attemptCount: workflow.attemptCount,
    pendingEffect: workflow.pendingEffect,
    deploymentStageIndex: workflow.deploymentStageIndex,
    nextAttemptAt: workflow.nextAttemptAtMs === null ? null : new Date(workflow.nextAttemptAtMs),
    initialChallengeDigest: workflow.initialChallengeDigest,
    initialChallengeExpiresAt:
      workflow.initialChallengeExpiresAtMs === null
        ? null
        : new Date(workflow.initialChallengeExpiresAtMs),
    initialAttestationDigest: workflow.initialAttestationDigest,
    postRestartChallengeDigest: workflow.postRestartChallengeDigest,
    postRestartChallengeExpiresAt:
      workflow.postRestartChallengeExpiresAtMs === null
        ? null
        : new Date(workflow.postRestartChallengeExpiresAtMs),
    postRestartAttestationDigest: workflow.postRestartAttestationDigest,
    stopStableSince:
      workflow.stopStableSinceMs === null ? null : new Date(workflow.stopStableSinceMs),
    workloadCleanupConfirmed: workflow.cleanupConfirmed.workload,
    secretsCleanupConfirmed: workflow.cleanupConfirmed.secrets,
    firewallCleanupConfirmed: workflow.cleanupConfirmed.firewall,
    dropletCleanupConfirmed: workflow.cleanupConfirmed.droplet,
    runnerCleanupConfirmed: workflow.cleanupConfirmed.runner,
    state,
    leaseOwner: retainLease ? run.leaseOwner : null,
    leaseExpiresAt: retainLease ? run.leaseExpiresAt : null,
    updatedAt: now,
  };
}

function applyEvidence(
  run: HermesStagingAcceptanceRun,
  evidence: HermesStagingAcceptanceEvidenceMutation | undefined,
  completedAt: Date | undefined,
): HermesStagingAcceptanceRun {
  if (!evidence && !completedAt) return run;
  return {
    ...run,
    observedImageDigest: evidence?.observedImageDigest ?? run.observedImageDigest,
    agentId: evidence?.agentId ?? run.agentId,
    deploymentId: evidence?.deploymentId ?? run.deploymentId,
    runnerId: evidence?.runnerId ?? run.runnerId,
    providerResourceId: evidence?.providerResourceId ?? run.providerResourceId,
    providerFirewallId: evidence?.providerFirewallId ?? run.providerFirewallId,
    publishedImageVerified:
      evidence?.publishedImageVerifiedAt !== undefined || run.publishedImageVerified,
    publishedImageVerifiedAt: evidence?.publishedImageVerifiedAt ?? run.publishedImageVerifiedAt,
    hostImageVerified: evidence?.hostImageVerifiedAt !== undefined || run.hostImageVerified,
    hostImageVerifiedAt: evidence?.hostImageVerifiedAt ?? run.hostImageVerifiedAt,
    agentReadyVerified: evidence?.agentReadyVerifiedAt !== undefined || run.agentReadyVerified,
    agentReadyVerifiedAt: evidence?.agentReadyVerifiedAt ?? run.agentReadyVerifiedAt,
    restartRequested: evidence?.restartRequestedAt !== undefined || run.restartRequested,
    restartRequestedAt: evidence?.restartRequestedAt ?? run.restartRequestedAt,
    restartVerified: evidence?.restartVerifiedAt !== undefined || run.restartVerified,
    restartVerifiedAt: evidence?.restartVerifiedAt ?? run.restartVerifiedAt,
    restartedRuntimeVerified:
      evidence?.restartedRuntimeVerifiedAt !== undefined || run.restartedRuntimeVerified,
    restartedRuntimeVerifiedAt:
      evidence?.restartedRuntimeVerifiedAt ?? run.restartedRuntimeVerifiedAt,
    diagnosticsRedactedConfirmed:
      evidence?.diagnosticsRedactedConfirmedAt !== undefined || run.diagnosticsRedactedConfirmed,
    diagnosticsRedactedConfirmedAt:
      evidence?.diagnosticsRedactedConfirmedAt ?? run.diagnosticsRedactedConfirmedAt,
    stopVerified: evidence?.stopVerifiedAt !== undefined || run.stopVerified,
    stopVerifiedAt: evidence?.stopVerifiedAt ?? run.stopVerifiedAt,
    rollbackVerified: evidence?.rollbackVerifiedAt !== undefined || run.rollbackVerified,
    rollbackVerifiedAt: evidence?.rollbackVerifiedAt ?? run.rollbackVerifiedAt,
    workloadCleanupConfirmedAt:
      evidence?.workloadCleanupConfirmedAt ?? run.workloadCleanupConfirmedAt,
    secretsCleanupConfirmedAt: evidence?.secretsCleanupConfirmedAt ?? run.secretsCleanupConfirmedAt,
    firewallCleanupConfirmedAt:
      evidence?.firewallCleanupConfirmedAt ?? run.firewallCleanupConfirmedAt,
    dropletCleanupConfirmedAt: evidence?.dropletCleanupConfirmedAt ?? run.dropletCleanupConfirmedAt,
    runnerCleanupConfirmedAt: evidence?.runnerCleanupConfirmedAt ?? run.runnerCleanupConfirmedAt,
    completedAt: completedAt ?? run.completedAt,
  };
}

function successfulExecution(
  effect: HermesStagingAcceptanceEffectKind,
  context: HermesStagingAcceptanceEffectContext,
  now: Date,
): HermesStagingAcceptanceEffectExecution {
  switch (effect) {
    case "preflight":
    case "attest_published_image":
      return {
        result: { effect, outcome: "confirmed" },
        ...(effect === "attest_published_image"
          ? { evidence: { observedImageDigest: DIGEST, publishedImageVerifiedAt: now } }
          : {}),
      };
    case "create_ready_agent":
      return {
        result: { effect, outcome: "accepted" },
        evidence: {
          agentId: AGENT_ID,
          deploymentId: DEPLOYMENT_ID,
          runnerId: RUNNER_ID,
          providerResourceId: "droplet-123",
          providerFirewallId: "firewall-123",
        },
      };
    case "observe_agent_creation":
      return { result: { effect, outcome: "found" } };
    case "observe_next_deployment_stage": {
      const stage = HERMES_STAGING_DEPLOYMENT_STAGES[context.deploymentStageIndex + 1];
      if (!stage) return { result: { effect, outcome: "failed" } };
      return {
        result: { effect, outcome: "observed", stage },
        ...(stage === "ready" ? { evidence: { agentReadyVerifiedAt: now } } : {}),
      };
    }
    case "verify_strict_host_image":
      return {
        result: { effect, outcome: "exact_ready" },
        evidence: { hostImageVerifiedAt: now },
      };
    case "issue_initial_human_challenge":
    case "observe_initial_human_challenge":
    case "issue_post_restart_human_challenge":
    case "observe_post_restart_human_challenge":
      if (!context.challenge) return { result: { effect, outcome: "failed" } };
      return {
        result: {
          effect,
          outcome: effect.startsWith("issue_") ? "issued" : "found",
          challengeDigest: context.challenge.digest,
          expiresAtMs: context.challenge.expiresAt.getTime(),
        },
      } as HermesStagingAcceptanceEffectExecution;
    case "restart_agent":
      return {
        result: { effect, outcome: "accepted" },
        evidence: { restartRequestedAt: now },
      };
    case "observe_agent_restart":
      return { result: { effect, outcome: "completed" }, evidence: { restartVerifiedAt: now } };
    case "verify_restarted_image_and_telegram":
      return {
        result: { effect, outcome: "exact_ready" },
        evidence: { restartVerifiedAt: now, restartedRuntimeVerifiedAt: now },
      };
    case "audit_safe_diagnostics":
      return {
        result: { effect, outcome: "safe" },
        evidence: { diagnosticsRedactedConfirmedAt: now },
      };
    case "stop_agent_db_first":
      return { result: { effect, outcome: "accepted" } };
    case "observe_stop_intent":
      return { result: { effect, outcome: "desired_stopped" } };
    case "observe_stop_stability":
      return { result: { effect, outcome: "stopped" }, evidence: { stopVerifiedAt: now } };
    case "verify_manual_rollback":
      return { result: { effect, outcome: "passed" }, evidence: { rollbackVerifiedAt: now } };
    case "cleanup_workload":
    case "cleanup_secrets":
    case "cleanup_firewall":
    case "cleanup_droplet":
    case "cleanup_runner":
      return { result: { effect, outcome: "accepted" } };
    case "observe_workload_absence":
      return {
        result: { effect, outcome: "absent" },
        evidence: { workloadCleanupConfirmedAt: now },
      };
    case "observe_secrets_absence":
      return {
        result: { effect, outcome: "absent" },
        evidence: { secretsCleanupConfirmedAt: now },
      };
    case "observe_firewall_absence":
      return {
        result: { effect, outcome: "absent" },
        evidence: { firewallCleanupConfirmedAt: now },
      };
    case "observe_droplet_absence":
      return {
        result: { effect, outcome: "absent" },
        evidence: { dropletCleanupConfirmedAt: now },
      };
    case "observe_runner_absence":
      return {
        result: { effect, outcome: "absent" },
        evidence: { runnerCleanupConfirmedAt: now },
      };
  }
}
