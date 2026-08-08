import "server-only";

import { randomUUID } from "node:crypto";
import {
  getAssistantProfile,
  isAssistantChoice,
  validateAssistantApiKey,
} from "@/src/server/agents/assistant-profiles";
import type { DatabaseConnection } from "@/src/server/db/client";
import { createDatabaseConnection } from "@/src/server/db/client";
import { readHermesStagingAcceptanceConfig, readHermesWorkloadImage } from "@/src/server/env";
import type {
  HermesStagingAcceptanceEffectContext,
  HermesStagingAcceptanceEffectExecution,
  HermesStagingAcceptanceEffectExecutor,
  HermesStagingAcceptanceHumanChallenge,
} from "@/src/server/staging/hermes-staging-acceptance-effects";
import {
  HERMES_STAGING_MAX_CLEANUP_DURATION_MS,
  HERMES_STAGING_MAX_DURATION_MS,
  type HermesStagingAcceptanceDecision,
  type HermesStagingAcceptanceEffectKind,
  type HermesStagingAcceptanceEffectResult,
  type HermesStagingAcceptancePlan,
  type HermesStagingAcceptanceState,
  planHermesStagingAcceptance,
} from "@/src/server/staging/hermes-staging-acceptance-state";
import {
  applyClaimedHermesStagingAcceptanceResult,
  attestHermesStagingAcceptanceChallenge,
  type BeginHermesStagingAcceptanceResult,
  beginHermesStagingAcceptanceRun,
  type ClaimedHermesStagingAcceptanceRun,
  claimNextHermesStagingAcceptanceRun,
  type HermesStagingAcceptanceClaimTarget,
  type HermesStagingAcceptanceEvidenceMutation,
  type HermesStagingAcceptanceRun,
  type HermesStagingAcceptanceWorkflowState,
  persistClaimedHermesStagingAcceptanceDecision,
  readActiveHermesStagingAcceptanceRun,
  readHermesStagingAcceptanceRun,
  requestHermesStagingAcceptanceCleanup,
  toHermesStagingAcceptanceWorkflowState,
} from "@/src/server/staging/hermes-staging-acceptance-store";
import type {
  HermesStagingAcceptanceCommand,
  HermesStagingAcceptanceReconcileProjection,
  HermesStagingAcceptanceSafeProjection,
} from "@/src/server/staging/hermes-staging-acceptance-transport";
import {
  checkHermesStagingOwnerIsolation,
  resolveHermesStagingOwner,
} from "@/src/server/staging/hermes-staging-product-observer";
import { createProductionHermesStagingAcceptanceEffectExecutor } from "@/src/server/staging/hermes-staging-production-effects";
import {
  createHermesStagingAttestationChallenge,
  createHermesStagingAttestationDigest,
  createHermesStagingAttestationToken,
  verifyHermesStagingAttestationToken,
} from "@/src/shared/hermes-staging-attestation-protocol";

export const HERMES_STAGING_ACCEPTANCE_EFFECT_TIMEOUT_MS = 45_000;

const IMAGE_REF_PATTERN = /^ghcr\.io\/ametel01\/bruno-hermes@(sha256:[a-f0-9]{64})$/;
const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const WORKFLOW_RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const OPAQUE_SECRET_PATTERN = /^[^\s]{20,4096}$/;
const TELEGRAM_TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;
const NUMERIC_USER_PATTERN = /^[1-9][0-9]*$/;
const NUMERIC_CHAT_PATTERN = /^-?[1-9][0-9]*$/;
const BUDGET_SENTINEL = "authorize-basic-4usd-digitalocean-staging";
const LIVE_SENTINEL = "send-telegram-and-spend-digitalocean-staging";

export type HermesStagingAcceptanceBeginInput = {
  ownerUserId: string;
  idempotencyKey: string;
  expectedSourceRevision: string;
  expectedPublishWorkflowRunId: string;
  expectedImageDigest: string;
  deadlineAt: Date;
  cleanupDeadlineAt: Date;
};

type StorePort = {
  begin: typeof beginHermesStagingAcceptanceRun;
  requestCleanup: typeof requestHermesStagingAcceptanceCleanup;
  attestChallenge: typeof attestHermesStagingAcceptanceChallenge;
  claimNext: typeof claimNextHermesStagingAcceptanceRun;
  persistDecision: typeof persistClaimedHermesStagingAcceptanceDecision;
  applyResult: typeof applyClaimedHermesStagingAcceptanceResult;
  read: typeof readHermesStagingAcceptanceRun;
  readActive: typeof readActiveHermesStagingAcceptanceRun;
  toWorkflowState: typeof toHermesStagingAcceptanceWorkflowState;
};

export type HermesStagingAcceptanceDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  resolveBeginInput?: (
    connection: DatabaseConnection,
    now: Date,
  ) => Promise<HermesStagingAcceptanceBeginInput | null>;
  readAttestationBearer?: () => string | null;
  effectExecutor?: HermesStagingAcceptanceEffectExecutor;
  effectTimeoutMs?: number;
  store?: Partial<StorePort>;
};

export type HermesStagingAcceptanceService = {
  command(command: HermesStagingAcceptanceCommand): Promise<HermesStagingAcceptanceSafeProjection>;
  read(runId: string): Promise<HermesStagingAcceptanceSafeProjection | null>;
  reconcileTarget(runId: string): Promise<HermesStagingAcceptanceReconcileProjection>;
  reconcileNext(options?: {
    allowForward: boolean;
  }): Promise<HermesStagingAcceptanceReconcileProjection>;
};

const defaultStore: StorePort = {
  begin: beginHermesStagingAcceptanceRun,
  requestCleanup: requestHermesStagingAcceptanceCleanup,
  attestChallenge: attestHermesStagingAcceptanceChallenge,
  claimNext: claimNextHermesStagingAcceptanceRun,
  persistDecision: persistClaimedHermesStagingAcceptanceDecision,
  applyResult: applyClaimedHermesStagingAcceptanceResult,
  read: readHermesStagingAcceptanceRun,
  readActive: readActiveHermesStagingAcceptanceRun,
  toWorkflowState: toHermesStagingAcceptanceWorkflowState,
};

export function createHermesStagingAcceptanceService(
  dependencies: HermesStagingAcceptanceDependencies = {},
): HermesStagingAcceptanceService {
  const createConnection = dependencies.createConnection ?? createDatabaseConnection;
  const now = dependencies.now ?? (() => new Date());
  const resolveBeginInput = dependencies.resolveBeginInput ?? resolveProductionBeginInput;
  const readAttestationBearer =
    dependencies.readAttestationBearer ?? readProductionAttestationBearer;
  const effectExecutor =
    dependencies.effectExecutor ?? createProductionHermesStagingAcceptanceEffectExecutor();
  const effectTimeoutMs =
    dependencies.effectTimeoutMs ?? HERMES_STAGING_ACCEPTANCE_EFFECT_TIMEOUT_MS;
  const store: StorePort = { ...defaultStore, ...dependencies.store };

  if (
    !Number.isInteger(effectTimeoutMs) ||
    effectTimeoutMs < 1 ||
    effectTimeoutMs > HERMES_STAGING_ACCEPTANCE_EFFECT_TIMEOUT_MS
  ) {
    throw new Error("Hermes staging acceptance effect timeout is invalid.");
  }

  async function withConnection<T>(
    work: (connection: DatabaseConnection) => Promise<T>,
  ): Promise<T> {
    const connection = createConnection();
    try {
      return await work(connection);
    } finally {
      await connection.close();
    }
  }

  async function read(runId: string): Promise<HermesStagingAcceptanceSafeProjection | null> {
    return await withConnection(async (connection) => {
      const run = await store.read({ db: connection.db, runId });
      return run ? toSafeProjection(run) : null;
    });
  }

  async function command(
    commandInput: HermesStagingAcceptanceCommand,
  ): Promise<HermesStagingAcceptanceSafeProjection> {
    return await withConnection(async (connection) => {
      const commandNow = now();

      if (commandInput.command === "begin") {
        const active = await store.readActive({ db: connection.db });
        if (active) return toSafeProjection(active);

        const input = await resolveBeginInput(connection, commandNow);
        if (!input) throw new Error("Hermes staging acceptance preflight failed safely.");

        const result = await store.begin({ db: connection.db, ...input, now: commandNow });
        return toSafeProjection(result.run);
      }

      const current = await store.read({ db: connection.db, runId: commandInput.runId });
      if (!current) throw new Error("Hermes staging acceptance run was not found.");

      if (commandInput.command === "read") return toSafeProjection(current);

      if (commandInput.command === "request_cleanup") {
        const requested = await store.requestCleanup({
          db: connection.db,
          runId: current.id,
          expectedGeneration: current.generation,
          now: commandNow,
        });
        if (!requested) throw new Error("Hermes staging acceptance run was not found.");
        return toSafeProjection(requested.run);
      }

      if (commandInput.command !== "attest_telegram_reply") {
        throw new Error("Unsupported Hermes staging acceptance command.");
      }

      return await attestHumanReply(connection, current, commandInput, commandNow, {
        readAttestationBearer,
        store,
      });
    });
  }

  async function reconcileTarget(
    runId: string,
  ): Promise<HermesStagingAcceptanceReconcileProjection> {
    return await withConnection((connection) =>
      reconcileOne(connection, { kind: "run", runId }, true, {
        now,
        effectExecutor,
        effectTimeoutMs,
        store,
      }),
    );
  }

  async function reconcileNext(options?: {
    allowForward: boolean;
  }): Promise<HermesStagingAcceptanceReconcileProjection> {
    const allowForward = options?.allowForward ?? true;
    return await withConnection(async (connection) => {
      if (!allowForward) {
        const active = await store.readActive({ db: connection.db });
        if (!active) return idleReconcile();

        if (active.desiredOutcome === "acceptance") {
          const requested = await store.requestCleanup({
            db: connection.db,
            runId: active.id,
            expectedGeneration: active.generation,
            now: now(),
          });
          if (!requested) return idleReconcile();
        }

        return await reconcileOne(connection, { kind: "run", runId: active.id }, false, {
          now,
          effectExecutor,
          effectTimeoutMs,
          store,
        });
      }

      return await reconcileOne(connection, { kind: "global" }, true, {
        now,
        effectExecutor,
        effectTimeoutMs,
        store,
      });
    });
  }

  return { command, read, reconcileTarget, reconcileNext };
}

async function reconcileOne(
  connection: DatabaseConnection,
  target: HermesStagingAcceptanceClaimTarget,
  allowForward: boolean,
  dependencies: {
    now: () => Date;
    effectExecutor: HermesStagingAcceptanceEffectExecutor;
    effectTimeoutMs: number;
    store: StorePort;
  },
): Promise<HermesStagingAcceptanceReconcileProjection> {
  const claimNow = dependencies.now();
  const claim = await dependencies.store.claimNext({
    db: connection.db,
    target,
    leaseOwner: `staging-acceptance:${randomUUID()}`,
    now: claimNow,
  });

  if (!claim) return idleReconcile();

  if (!allowForward && claim.desiredOutcome !== "cleanup") {
    const requested = await dependencies.store.requestCleanup({
      db: connection.db,
      runId: claim.id,
      expectedGeneration: claim.generation,
      now: claimNow,
    });
    if (!requested) return await staleCasProjection(connection, claim.id, dependencies.store);
    return { processed: 1, outcome: "cleanup_pending", run: toSafeProjection(requested.run) };
  }

  const tick = planHermesStagingAcceptance({
    state: dependencies.store.toWorkflowState(claim),
    input: { kind: "tick", generation: claim.generation, nowMs: claimNow.getTime() },
  });

  if (!tick.state) throw new Error("Hermes staging acceptance state is invalid.");

  if (tick.decision.kind !== "effect") {
    const applied = await dependencies.store.applyResult({
      db: connection.db,
      claim,
      now: claimNow,
      mutation: mutationForPlan(tick, claimNow),
    });
    if (!applied) return await staleCasProjection(connection, claim.id, dependencies.store);
    const run = await requireRun(connection, claim.id, dependencies.store);
    return reconcileProjection(tick.decision, run);
  }

  if (!allowForward && !isCleanupEffect(tick.decision.effect.kind)) {
    throw new Error("Cleanup-only reconciliation refused forward work.");
  }

  const persisted = await dependencies.store.persistDecision({
    db: connection.db,
    claim,
    now: claimNow,
    workflowState: tick.state,
  });
  if (!persisted) return await staleCasProjection(connection, claim.id, dependencies.store);

  const execution = await executeBoundedEffect(
    tick.decision.effect.kind,
    effectContext(persisted, claimNow),
    dependencies.effectExecutor,
    dependencies.effectTimeoutMs,
  );
  const resultNow = dependencies.now();
  const afterEffect = planHermesStagingAcceptance({
    state: dependencies.store.toWorkflowState(persisted),
    input: {
      kind: "effect_result",
      generation: persisted.generation,
      nowMs: resultNow.getTime(),
      result: execution.result,
    },
  });
  if (!afterEffect.state) throw new Error("Hermes staging acceptance effect state is invalid.");

  const normalized = normalizePostEffectPlan(afterEffect, resultNow);
  const evidence = sanitizeEffectEvidence(
    tick.decision.effect.kind,
    execution.result,
    execution.evidence,
  );
  const applied = await dependencies.store.applyResult({
    db: connection.db,
    claim: persisted,
    now: resultNow,
    mutation: {
      ...mutationForPlan(normalized, resultNow),
      ...(evidence ? { evidence } : {}),
    },
  });
  if (!applied) return await staleCasProjection(connection, claim.id, dependencies.store);

  const run = await requireRun(connection, claim.id, dependencies.store);
  return reconcileProjection(normalized.decision, run);
}

async function executeBoundedEffect(
  effect: HermesStagingAcceptanceEffectKind,
  context: HermesStagingAcceptanceEffectContext,
  executor: HermesStagingAcceptanceEffectExecutor,
  timeoutMs: number,
): Promise<HermesStagingAcceptanceEffectExecution> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const execution = await Promise.race([
      executor.execute(effect, context, controller.signal),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Hermes staging acceptance effect timed out."));
        }, timeoutMs);
      }),
    ]);

    return execution.result.effect === effect ? execution : { result: unknownEffectResult(effect) };
  } catch {
    controller.abort();
    return { result: unknownEffectResult(effect) };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function sanitizeEffectEvidence(
  effect: HermesStagingAcceptanceEffectKind,
  result: HermesStagingAcceptanceEffectResult,
  evidence: HermesStagingAcceptanceEvidenceMutation | undefined,
): HermesStagingAcceptanceEvidenceMutation | undefined {
  if (!evidence || result.effect !== effect) return undefined;

  switch (effect) {
    case "attest_published_image":
      return result.outcome === "confirmed"
        ? pickEvidence(evidence, ["observedImageDigest", "publishedImageVerifiedAt"])
        : undefined;
    case "create_ready_agent":
      return result.outcome === "accepted"
        ? pickEvidence(evidence, [
            "agentId",
            "deploymentId",
            "runnerId",
            "providerResourceId",
            "providerFirewallId",
          ])
        : undefined;
    case "observe_agent_creation":
      return result.outcome === "found"
        ? pickEvidence(evidence, [
            "agentId",
            "deploymentId",
            "runnerId",
            "providerResourceId",
            "providerFirewallId",
          ])
        : undefined;
    case "observe_next_deployment_stage":
      return result.outcome === "observed"
        ? pickEvidence(evidence, [
            "agentId",
            "deploymentId",
            "runnerId",
            "providerResourceId",
            "providerFirewallId",
            ...(result.stage === "ready" ? (["agentReadyVerifiedAt"] as const) : []),
          ])
        : undefined;
    case "verify_strict_host_image":
      return result.outcome === "exact_ready"
        ? pickEvidence(evidence, ["hostImageVerifiedAt"])
        : undefined;
    case "restart_agent":
      return result.outcome === "accepted"
        ? pickEvidence(evidence, ["restartRequestedAt"])
        : undefined;
    case "observe_agent_restart":
      return result.outcome === "completed"
        ? pickEvidence(evidence, ["restartVerifiedAt"])
        : undefined;
    case "verify_restarted_image_and_telegram":
      return result.outcome === "exact_ready"
        ? pickEvidence(evidence, ["restartVerifiedAt", "restartedRuntimeVerifiedAt"])
        : undefined;
    case "audit_safe_diagnostics":
      return result.outcome === "safe"
        ? pickEvidence(evidence, ["diagnosticsRedactedConfirmedAt"])
        : undefined;
    case "observe_stop_stability":
      return result.outcome === "stopped" ? pickEvidence(evidence, ["stopVerifiedAt"]) : undefined;
    case "verify_manual_rollback":
      return result.outcome === "passed"
        ? pickEvidence(evidence, ["rollbackVerifiedAt"])
        : undefined;
    case "observe_workload_absence":
      return result.outcome === "absent"
        ? pickEvidence(evidence, ["workloadCleanupConfirmedAt"])
        : undefined;
    case "observe_secrets_absence":
      return result.outcome === "absent"
        ? pickEvidence(evidence, ["secretsCleanupConfirmedAt"])
        : undefined;
    case "observe_firewall_absence":
      return result.outcome === "absent"
        ? pickEvidence(evidence, ["firewallCleanupConfirmedAt"])
        : undefined;
    case "observe_droplet_absence":
      return result.outcome === "absent"
        ? pickEvidence(evidence, ["dropletCleanupConfirmedAt"])
        : undefined;
    case "observe_runner_absence":
      return result.outcome === "absent"
        ? pickEvidence(evidence, ["runnerCleanupConfirmedAt"])
        : undefined;
    case "preflight":
    case "issue_initial_human_challenge":
    case "observe_initial_human_challenge":
    case "issue_post_restart_human_challenge":
    case "observe_post_restart_human_challenge":
    case "stop_agent_db_first":
    case "observe_stop_intent":
    case "cleanup_workload":
    case "cleanup_secrets":
    case "cleanup_firewall":
    case "cleanup_droplet":
    case "cleanup_runner":
      return undefined;
  }
}

function pickEvidence<Key extends keyof HermesStagingAcceptanceEvidenceMutation>(
  evidence: HermesStagingAcceptanceEvidenceMutation,
  keys: readonly Key[],
): HermesStagingAcceptanceEvidenceMutation | undefined {
  const picked: HermesStagingAcceptanceEvidenceMutation = {};
  for (const key of keys) {
    const value = evidence[key];
    if (value !== undefined) Object.assign(picked, { [key]: value });
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

function normalizePostEffectPlan(
  plan: HermesStagingAcceptancePlan,
  now: Date,
): HermesStagingAcceptancePlan {
  if (!plan.state || plan.decision.kind !== "effect") return plan;

  // Absence observation is the second half of a cleanup action while remaining
  // in the same phase. Retaining that read-only effect is safe: the planner's
  // process-death fallback reissues it, never the destructive cleanup action.
  const scheduledObservation = plan.decision.effect.kind.endsWith("_absence")
    ? plan.decision.effect.kind
    : null;

  return {
    state: {
      ...plan.state,
      attemptCount: 0,
      pendingEffect: scheduledObservation,
      nextAttemptAtMs: now.getTime(),
    },
    decision: { kind: "wait", untilMs: now.getTime(), reason: "retry_backoff" },
  };
}

function mutationForPlan(
  plan: HermesStagingAcceptancePlan,
  now: Date,
): {
  workflowState: HermesStagingAcceptanceWorkflowState;
  queueState: "pending" | "waiting" | "blocked" | "complete";
  completedAt?: Date;
} {
  if (!plan.state) throw new Error("Hermes staging acceptance plan has no state.");

  switch (plan.decision.kind) {
    case "complete":
      return { workflowState: plan.state, queueState: "complete", completedAt: now };
    case "blocked":
      return { workflowState: plan.state, queueState: "blocked" };
    case "wait":
      return {
        workflowState: plan.state,
        queueState: plan.decision.untilMs === now.getTime() ? "pending" : "waiting",
      };
    case "effect":
      throw new Error("An effect decision must be fenced before persistence.");
    case "ignored":
    case "rejected":
      throw new Error("Hermes staging acceptance plan was not actionable.");
  }
}

function reconcileProjection(
  decision: HermesStagingAcceptanceDecision,
  run: HermesStagingAcceptanceRun,
): HermesStagingAcceptanceReconcileProjection {
  const projection = toSafeProjection(run);
  if (run.state === "complete" || decision.kind === "complete") {
    return { processed: 1, outcome: "complete", run: projection };
  }
  if (run.desiredOutcome === "cleanup") {
    return { processed: 1, outcome: "cleanup_pending", run: projection };
  }
  if (decision.kind === "wait") {
    return { processed: 1, outcome: "waiting", run: projection };
  }
  return { processed: 1, outcome: "advanced", run: projection };
}

async function staleCasProjection(
  connection: DatabaseConnection,
  runId: string,
  store: StorePort,
): Promise<HermesStagingAcceptanceReconcileProjection> {
  const run = await store.read({ db: connection.db, runId });
  return run
    ? {
        processed: 1,
        outcome: run.desiredOutcome === "cleanup" ? "cleanup_pending" : "waiting",
        run: toSafeProjection(run),
      }
    : idleReconcile();
}

async function requireRun(
  connection: DatabaseConnection,
  runId: string,
  store: StorePort,
): Promise<HermesStagingAcceptanceRun> {
  const run = await store.read({ db: connection.db, runId });
  if (!run) throw new Error("Hermes staging acceptance run disappeared.");
  return run;
}

async function attestHumanReply(
  connection: DatabaseConnection,
  run: HermesStagingAcceptanceRun,
  command: Extract<HermesStagingAcceptanceCommand, { command: "attest_telegram_reply" }>,
  now: Date,
  dependencies: { readAttestationBearer: () => string | null; store: StorePort },
): Promise<HermesStagingAcceptanceSafeProjection> {
  const purpose = challengePurpose(run);
  const bearer = dependencies.readAttestationBearer();
  if (!purpose || !bearer) return toSafeProjection(run);

  const challenge = requireChallenge(
    run,
    purpose,
    new Date(Math.min(now.getTime(), run.deadlineAt.getTime() - 1)),
  );
  const persistedDigest =
    purpose === "initial" ? run.initialChallengeDigest : run.postRestartChallengeDigest;
  const expectedToken = createHermesStagingAttestationToken({
    bearerSecret: bearer,
    runId: run.id,
    challenge,
  });

  if (
    expectedToken === null ||
    command.challengeId !== challenge.challengeId ||
    persistedDigest !== challenge.digest ||
    !verifyHermesStagingAttestationToken({
      bearerSecret: bearer,
      runId: run.id,
      challenge,
      token: command.attestationToken,
    })
  ) {
    return toSafeProjection(run);
  }

  const attestationDigest = createHermesStagingAttestationDigest({
    runId: run.id,
    challenge,
    token: expectedToken,
  });
  if (!attestationDigest) return toSafeProjection(run);
  const planned = planHermesStagingAcceptance({
    state: dependencies.store.toWorkflowState(run),
    input: {
      kind: "human_attestation",
      generation: run.generation,
      nowMs: now.getTime(),
      proof: purpose,
      challengeDigest: challenge.digest,
      attestationDigest,
    },
  });

  const acceptedDigest =
    purpose === "initial"
      ? planned.state?.initialAttestationDigest
      : planned.state?.postRestartAttestationDigest;
  if (planned.state?.desiredOutcome !== "acceptance" || acceptedDigest !== attestationDigest) {
    return toSafeProjection(run);
  }

  const attested = await dependencies.store.attestChallenge({
    db: connection.db,
    runId: run.id,
    expectedGeneration: run.generation,
    purpose,
    challengeDigest: challenge.digest,
    attestationDigest,
    now,
  });
  return toSafeProjection(attested?.run ?? run);
}

function toSafeProjection(run: HermesStagingAcceptanceRun): HermesStagingAcceptanceSafeProjection {
  return {
    runId: run.id,
    phase: run.phase,
    desiredOutcome: run.desiredOutcome,
    nextAction: nextAction(run),
    checks: {
      imageAttested: run.publishedImageVerified && run.hostImageVerified,
      deploymentStagesObserved: run.agentReadyVerified,
      initialReplyAttested: run.initialHumanProofVerified,
      restartReady: run.restartVerified,
      restartImageAttested: run.restartedRuntimeVerified,
      postRestartReplyAttested: run.postRestartHumanProofVerified,
      diagnosticsRedacted: run.diagnosticsRedactedConfirmed,
      intentionalStopStable: run.stopVerified,
      rollbackVerified: run.rollbackVerified,
    },
    cleanup: {
      agent:
        run.agentId === null ? "not_created" : run.workloadCleanupConfirmed ? "absent" : "present",
      workload:
        run.agentId === null ? "not_created" : run.workloadCleanupConfirmed ? "absent" : "present",
      firewall:
        run.providerFirewallId === null
          ? "not_created"
          : run.firewallCleanupConfirmed
            ? "absent"
            : "present",
      droplet:
        run.providerResourceId === null
          ? "not_created"
          : run.dropletCleanupConfirmed
            ? "absent"
            : "present",
      runner:
        run.runnerId === null ? "not_created" : run.runnerCleanupConfirmed ? "deleted" : "present",
      secretsRevoked: run.secretsCleanupConfirmed,
    },
    errorCode: run.errorCode,
    nextAttemptAt: run.nextAttemptAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

function nextAction(
  run: HermesStagingAcceptanceRun,
): HermesStagingAcceptanceSafeProjection["nextAction"] {
  const purpose = challengePurpose(run);
  if (purpose) {
    const expiresAt =
      purpose === "initial" ? run.initialChallengeExpiresAt : run.postRestartChallengeExpiresAt;
    const storedDigest =
      purpose === "initial" ? run.initialChallengeDigest : run.postRestartChallengeDigest;
    if (expiresAt && storedDigest) {
      const challenge = requireChallenge(run, purpose, run.updatedAt);
      if (challenge.digest !== storedDigest) {
        throw new Error("Hermes staging acceptance challenge evidence is invalid.");
      }
      return {
        kind: "operator_telegram",
        challengeId: challenge.challengeId,
        text: challenge.text,
        purpose,
        expiresAt: expiresAt.toISOString(),
      };
    }
  }

  if (run.state === "complete" || run.state === "blocked") return { kind: "none" };
  return { kind: "automatic", retryAt: run.nextAttemptAt?.toISOString() ?? null };
}

function requireChallenge(
  run: Pick<HermesStagingAcceptanceRun, "id" | "deadlineAt">,
  purpose: "initial" | "post_restart",
  now: Date,
): HermesStagingAcceptanceHumanChallenge {
  const challenge = createHermesStagingAttestationChallenge({
    runId: run.id,
    purpose,
    now,
    deadlineAt: run.deadlineAt,
  });
  if (!challenge) throw new Error("Hermes staging acceptance challenge input is invalid.");
  return challenge;
}

function effectContext(
  run: ClaimedHermesStagingAcceptanceRun,
  now: Date,
): HermesStagingAcceptanceEffectContext {
  const purpose = effectChallengePurpose(run.pendingEffect);
  return {
    runId: run.id,
    ownerUserId: run.ownerUserId,
    idempotencyKey: run.idempotencyKey,
    generation: run.generation,
    attemptCount: run.attemptCount,
    deploymentStageIndex: run.deploymentStageIndex,
    expectedSourceRevision: run.expectedSourceRevision,
    expectedPublishWorkflowRunId: run.expectedPublishWorkflowRunId,
    expectedImageDigest: run.expectedImageDigest,
    observedImageDigest: run.observedImageDigest,
    agentId: run.agentId,
    deploymentId: run.deploymentId,
    runnerId: run.runnerId,
    providerResourceId: run.providerResourceId,
    providerFirewallId: run.providerFirewallId,
    restartRequestedAt: run.restartRequestedAt,
    challenge: purpose ? requireChallenge(run, purpose, now) : null,
  };
}

function effectChallengePurpose(
  effect: HermesStagingAcceptanceEffectKind | null,
): "initial" | "post_restart" | null {
  if (effect === "issue_initial_human_challenge" || effect === "observe_initial_human_challenge") {
    return "initial";
  }
  if (
    effect === "issue_post_restart_human_challenge" ||
    effect === "observe_post_restart_human_challenge"
  ) {
    return "post_restart";
  }
  return null;
}

function challengePurpose(run: HermesStagingAcceptanceRun): "initial" | "post_restart" | null {
  if (run.phase === "awaiting_initial_human_proof") return "initial";
  if (run.phase === "awaiting_post_restart_human_proof") return "post_restart";
  return null;
}

function isCleanupEffect(effect: HermesStagingAcceptanceEffectKind): boolean {
  return (
    effect.startsWith("cleanup_") || (effect.startsWith("observe_") && effect.endsWith("_absence"))
  );
}

function idleReconcile(): HermesStagingAcceptanceReconcileProjection {
  return { processed: 0, outcome: "idle", run: null };
}

function unknownEffectResult(
  effect: HermesStagingAcceptanceEffectKind,
): HermesStagingAcceptanceEffectResult {
  switch (effect) {
    case "preflight":
    case "attest_published_image":
      return { effect, outcome: "unknown" };
    case "create_ready_agent":
    case "restart_agent":
    case "stop_agent_db_first":
    case "cleanup_workload":
    case "cleanup_secrets":
    case "cleanup_firewall":
    case "cleanup_droplet":
    case "cleanup_runner":
      return { effect, outcome: "unknown" };
    case "observe_agent_creation":
    case "observe_agent_restart":
    case "observe_next_deployment_stage":
    case "verify_strict_host_image":
    case "issue_initial_human_challenge":
    case "observe_initial_human_challenge":
    case "verify_restarted_image_and_telegram":
    case "issue_post_restart_human_challenge":
    case "observe_post_restart_human_challenge":
    case "audit_safe_diagnostics":
    case "observe_stop_intent":
    case "observe_stop_stability":
    case "verify_manual_rollback":
    case "observe_workload_absence":
    case "observe_secrets_absence":
    case "observe_firewall_absence":
    case "observe_droplet_absence":
    case "observe_runner_absence":
      return { effect, outcome: "unknown" };
  }
}

async function resolveProductionBeginInput(
  connection: DatabaseConnection,
  now: Date,
): Promise<HermesStagingAcceptanceBeginInput | null> {
  const config = readHermesStagingAcceptanceConfig();
  const imageMatch = IMAGE_REF_PATTERN.exec(
    process.env.BRUNO_HERMES_STAGING_PUBLISHED_IMAGE_REF ?? "",
  );
  const publishedImageRef = process.env.BRUNO_HERMES_STAGING_PUBLISHED_IMAGE_REF ?? "";
  const sourceRevision = process.env.BRUNO_HERMES_STAGING_IMAGE_SOURCE_REVISION ?? "";
  const workflowRunId = process.env.BRUNO_HERMES_STAGING_PUBLISH_WORKFLOW_RUN_ID ?? "";
  const numericWorkflowRunId = Number(workflowRunId);
  const assistant = process.env.BRUNO_HERMES_STAGING_ASSISTANT;
  const assistantProfile = isAssistantChoice(assistant) ? getAssistantProfile(assistant) : null;
  const openAiApiKey = process.env.BRUNO_HERMES_STAGING_OPENAI_API_KEY;
  const anthropicApiKey = process.env.BRUNO_HERMES_STAGING_ANTHROPIC_API_KEY;
  const modelApiKey = assistant === "claude" ? anthropicApiKey : openAiApiKey;

  if (
    !config.ok ||
    !config.enabled ||
    !imageMatch ||
    readHermesWorkloadImage() !== publishedImageRef ||
    !SOURCE_REVISION_PATTERN.test(sourceRevision) ||
    !WORKFLOW_RUN_ID_PATTERN.test(workflowRunId) ||
    !Number.isSafeInteger(numericWorkflowRunId) ||
    numericWorkflowRunId <= 0 ||
    process.env.BRUNO_HERMES_STAGING_DIGITALOCEAN_BUDGET_AUTHORIZATION !== BUDGET_SENTINEL ||
    process.env.BRUNO_HERMES_STAGING_LIVE_SIDE_EFFECT_CONFIRMATION !== LIVE_SENTINEL ||
    !OPAQUE_SECRET_PATTERN.test(process.env.BRUNO_DIGITALOCEAN_TOKEN ?? "") ||
    !OPAQUE_SECRET_PATTERN.test(process.env.BRUNO_RUNNER_BEARER_TOKEN ?? "") ||
    !assistantProfile ||
    !validateAssistantApiKey(assistantProfile, modelApiKey).ok ||
    (assistant === "chatgpt" ? Boolean(anthropicApiKey) : Boolean(openAiApiKey)) ||
    !TELEGRAM_TOKEN_PATTERN.test(process.env.BRUNO_HERMES_STAGING_TELEGRAM_BOT_TOKEN ?? "") ||
    !NUMERIC_USER_PATTERN.test(process.env.BRUNO_HERMES_STAGING_TELEGRAM_TEST_USER_ID ?? "") ||
    !NUMERIC_CHAT_PATTERN.test(process.env.BRUNO_HERMES_STAGING_TELEGRAM_TEST_CHAT_ID ?? "")
  ) {
    return null;
  }

  const owner = await connection.db.transaction(resolveHermesStagingOwner);
  if (!owner.ok) return null;
  const isolation = await checkHermesStagingOwnerIsolation(connection.db, owner.userId);
  if (!isolation.isolated) return null;

  const expectedImageDigest = imageMatch[1];
  if (!expectedImageDigest) return null;
  const deadlineAt = new Date(now.getTime() + HERMES_STAGING_MAX_DURATION_MS);

  return {
    ownerUserId: owner.userId,
    idempotencyKey: `hermes-staging:${workflowRunId}:${expectedImageDigest.slice(7, 31)}`,
    expectedSourceRevision: sourceRevision,
    expectedPublishWorkflowRunId: workflowRunId,
    expectedImageDigest,
    deadlineAt,
    cleanupDeadlineAt: new Date(deadlineAt.getTime() + HERMES_STAGING_MAX_CLEANUP_DURATION_MS),
  };
}

function readProductionAttestationBearer(): string | null {
  const config = readHermesStagingAcceptanceConfig();
  return config.ok && config.enabled ? config.bearerSecret : null;
}

const productionService = createHermesStagingAcceptanceService();

export async function commandHermesStagingAcceptance(
  command: HermesStagingAcceptanceCommand,
): Promise<HermesStagingAcceptanceSafeProjection> {
  return await productionService.command(command);
}

export async function readHermesStagingAcceptance(
  runId: string,
): Promise<HermesStagingAcceptanceSafeProjection | null> {
  return await productionService.read(runId);
}

export async function reconcileTargetHermesStagingAcceptance(
  runId: string,
): Promise<HermesStagingAcceptanceReconcileProjection> {
  return await productionService.reconcileTarget(runId);
}

export async function reconcileNextHermesStagingAcceptance(options?: {
  allowForward: boolean;
}): Promise<HermesStagingAcceptanceReconcileProjection> {
  return await productionService.reconcileNext(options);
}

export type {
  BeginHermesStagingAcceptanceResult,
  HermesStagingAcceptanceEvidenceMutation,
  HermesStagingAcceptanceState,
};
