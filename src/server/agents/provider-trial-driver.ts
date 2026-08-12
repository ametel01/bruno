import "server-only";

import { createHash, randomUUID, sign, verify } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  type AgentDeploymentChoices,
  parseAgentDeploymentChoices,
} from "@/src/server/agents/agent-deployment-choices";
import {
  type AgentDeploymentLatencyStageSummary,
  buildAgentDeploymentLatencyReportForDatabase,
  summarizeAgentDeploymentLatencyStages,
} from "@/src/server/agents/agent-deployment-latency";
import {
  beginOrResumeProviderTrialSlot,
  buildProviderTrialCohortReport,
  isValidProviderTrialCohortReport,
  PROVIDER_TRIAL_SLOT_COUNT,
  type ProviderTrialSafeCode,
  type ProviderTrialSlotAttempt,
  providerTrialDeploymentIdempotencyKey,
  recordProviderTrialRequestOutcome,
  recordProviderTrialTerminalOutcome,
} from "@/src/server/agents/provider-trial-cohort";
import type { DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agentSecrets,
  providerTrialAuthorizationEvents,
  providerTrialCohorts,
  providerTrialRuns,
  providerTrialSlotCleanupEvents,
  providerTrialSlots,
} from "@/src/server/db/schema";

export const PROVIDER_TRIAL_DRIVER_REPORT_SCHEMA_VERSION = "bruno.provider-trial-driver.v3";
const PROVIDER_TRIAL_CHECKPOINT_SCHEMA_VERSION = "bruno.provider-trial-checkpoint.v1";
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODES = new Set<ProviderTrialSafeCode>([
  "deployment_failed",
  "ready_timeout",
  "request_failed",
  "request_outcome_unknown",
  "request_rejected",
  "request_validation_failed",
  "safety_failure",
]);
const LEASE_GRACE_MS = 30_000;

export type ProviderTrialDriverConfiguration = {
  providerMode: "digitalocean" | "local_docker";
  perSlotTimeoutMs: number;
  cleanupTimeoutMs: number;
  maxSpendCents: number;
  maxSlotCostCents: number;
  maxProviderResources: number;
  deploymentChoicesDigest: string;
  authorizedRegion: string;
  authorizedRunnerSizeSlug: string;
  benchmarkOwnerIdentityHash: string;
  benchmarkTelegramIdentityHash: string;
  digitalOceanAccountIdentityHash: string;
  telegramBotIdentityHash: string;
  telegramChatIdentityHash: string;
  telegramUserIdentityHash: string;
  prerequisiteGateEvidenceDigest: string;
  evidenceRetentionDays: number;
};

type Authorization = { id: string; generation: number };
type AuthorizationEvidence = {
  prerequisiteGateEvidenceDigest: string;
  deploymentChoicesDigest: string;
};
type CleanupEvidence = { ok: boolean; authoritative: boolean; remainingResourceIds: string[] };
type SlotCleanupEvidence = {
  slotNumber: number;
  costCents: number;
  activeProviderResources: number;
  attempts: Array<{
    cleanupAttemptNumber: number;
    ok: boolean;
    authoritative: boolean;
    remainingResourceCount: number;
  }>;
};
type CommittedExecution = {
  outcome: "committed";
  deploymentId: string;
  costCents: number;
  activeProviderResources: number;
};
type PreCommitExecution = {
  outcome: "pre_commit_failure";
  safeCode: ProviderTrialSafeCode;
  costCents: number;
  activeProviderResources: number;
};
type SafetyExecution = {
  outcome: "safety_pause";
  safeCode: "safety_failure";
  costCents: number;
  activeProviderResources: number;
};
type ProviderTrialExecution = CommittedExecution | PreCommitExecution | SafetyExecution;
type ProviderTrialCheckpoint = {
  schemaVersion: typeof PROVIDER_TRIAL_CHECKPOINT_SCHEMA_VERSION;
  slotNumber: number;
  requestAttemptId: string;
  execution: ProviderTrialExecution | { outcome: "request_outcome_unknown" };
};

type ProviderExecutionContext = {
  idempotencyKey: string;
  signal: AbortSignal;
  deadlineAt: string;
  timeoutMs: number;
  maxCostCents: number;
  maxProviderResources: number;
  authorizationScope: {
    cohortId: string;
    region: string;
    runnerSizeSlug: string;
    deploymentChoicesDigest: string;
    benchmarkOwnerIdentityHash: string;
    benchmarkTelegramIdentityHash: string;
  };
};

export type ProviderTrialDriverDependencies = {
  executeSlot(
    attempt: ProviderTrialSlotAttempt,
    context: ProviderExecutionContext,
  ): Promise<ProviderTrialExecution>;
  reconcileRequest?(
    attempt: ProviderTrialSlotAttempt,
    context: ProviderExecutionContext,
  ): Promise<ProviderTrialExecution | { outcome: "request_outcome_unknown" }>;
  observeCommittedSlot?(
    attempt: ProviderTrialSlotAttempt,
    context: { signal: AbortSignal; deadlineAt: string; timeoutMs: number },
  ): Promise<"observe_deployment" | "timed_out" | "safety_failure">;
  cleanup?(context: {
    cohortId: string;
    signal: AbortSignal;
    deadlineAt: string;
    timeoutMs: number;
  }): Promise<CleanupEvidence>;
  signing?: { keyId: string; privateKeyPem: string };
  now?: () => Date;
  leaseOwner?: () => string;
};

type ProviderTrialCleanupDependencies = Pick<
  ProviderTrialDriverDependencies,
  "cleanup" | "leaseOwner" | "now"
>;

export function verifyProviderTrialDriverReport(input: {
  canonicalBytes: string;
  digest: string;
  keyId: string;
  signature: string;
  trustedPublicKeys: Readonly<Record<string, string>>;
}): boolean {
  const publicKey = Object.hasOwn(input.trustedPublicKeys, input.keyId)
    ? input.trustedPublicKeys[input.keyId]
    : undefined;
  if (
    `sha256:${createHash("sha256").update(input.canonicalBytes).digest("hex")}` !== input.digest ||
    !publicKey
  ) {
    return false;
  }
  try {
    const parsed = JSON.parse(input.canonicalBytes) as unknown;
    if (
      !isRecord(parsed) ||
      !isValidProviderTrialDriverReport(parsed) ||
      canonicalJson(parsed) !== input.canonicalBytes
    ) {
      return false;
    }
    return verify(
      null,
      Buffer.from(input.canonicalBytes),
      publicKey,
      Buffer.from(input.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

function isValidProviderTrialDriverReport(value: Record<string, unknown>): boolean {
  if (
    Object.keys(value).sort().join("\0") !==
      [
        "cleanup",
        "cohort",
        "configuration",
        "authorization",
        "authorizationEvidence",
        "generatedAt",
        "schemaVersion",
        "slotCleanup",
        "stageDistributions",
        "stages",
      ]
        .sort()
        .join("\0") ||
    value.schemaVersion !== PROVIDER_TRIAL_DRIVER_REPORT_SCHEMA_VERSION ||
    typeof value.generatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.generatedAt) ||
    !isValidProviderTrialCohortReport(value.cohort) ||
    value.cohort.generatedAt !== value.generatedAt ||
    !isRecord(value.authorization) ||
    Object.keys(value.authorization).sort().join("\0") !==
      ["generation", "idHash"].sort().join("\0") ||
    !Number.isSafeInteger(value.authorization.generation) ||
    Number(value.authorization.generation) < 1 ||
    !SHA256_HEX.test(String(value.authorization.idHash)) ||
    !isValidAuthorizationEvidence(value.authorizationEvidence, value.authorization) ||
    !isRecord(value.cleanup) ||
    Object.keys(value.cleanup).sort().join("\0") !==
      ["authoritative", "ok", "remainingResourceCount"].sort().join("\0") ||
    value.cleanup.ok !== true ||
    value.cleanup.authoritative !== true ||
    value.cleanup.remainingResourceCount !== 0 ||
    !isValidSlotCleanupEvidence(value.slotCleanup) ||
    !isValidStageDistributions(value.stageDistributions, value.cohort.readiness.committed) ||
    !isRecord(value.stages) ||
    Object.keys(value.stages)
      .sort((left, right) => Number(left) - Number(right))
      .join("\0") !==
      Array.from({ length: PROVIDER_TRIAL_SLOT_COUNT }, (_, index) => String(index + 1)).join(
        "\0",
      ) ||
    value.cohort.slots.some(
      (slot) =>
        (value.stages as Record<string, unknown>)[String(slot.slotNumber)] !== slot.terminalOutcome,
    ) ||
    value.cohort.apiAcceptance.pending !== 0 ||
    value.cohort.readiness.pending !== 0 ||
    value.cohort.slots.some((slot) => slot.terminalOutcome === null)
  ) {
    return false;
  }
  try {
    const configuration = parseConfiguration(value.configuration);
    const latestAuthorizationEvidence = Array.isArray(value.authorizationEvidence)
      ? value.authorizationEvidence.at(-1)
      : null;
    return (
      configuration.authorizedRegion === value.cohort.cohort.region &&
      configuration.authorizedRunnerSizeSlug === value.cohort.cohort.runnerSizeSlug &&
      isRecord(latestAuthorizationEvidence) &&
      latestAuthorizationEvidence.prerequisiteGateEvidenceDigest ===
        configuration.prerequisiteGateEvidenceDigest &&
      latestAuthorizationEvidence.deploymentChoicesDigest === configuration.deploymentChoicesDigest
    );
  } catch {
    return false;
  }
}

function isValidAuthorizationEvidence(value: unknown, authorization: Record<string, unknown>) {
  if (!Array.isArray(value) || value.length < 1) return false;
  let previousGeneration = 0;
  for (const event of value) {
    if (
      !isRecord(event) ||
      Object.keys(event).sort().join("\0") !==
        [
          "authorizationIdHash",
          "authorizedAt",
          "deploymentChoicesDigest",
          "generation",
          "prerequisiteGateEvidenceDigest",
          "renewedFromPauseReason",
          "renewedFromPausedAt",
        ]
          .sort()
          .join("\0") ||
      !Number.isSafeInteger(event.generation) ||
      Number(event.generation) <= previousGeneration ||
      !SHA256_HEX.test(String(event.authorizationIdHash)) ||
      !SHA256_DIGEST.test(String(event.prerequisiteGateEvidenceDigest)) ||
      !SHA256_DIGEST.test(String(event.deploymentChoicesDigest)) ||
      !(
        (event.renewedFromPausedAt === null && event.renewedFromPauseReason === null) ||
        (typeof event.renewedFromPausedAt === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(event.renewedFromPausedAt) &&
          typeof event.renewedFromPauseReason === "string" &&
          event.renewedFromPauseReason.length > 0)
      ) ||
      typeof event.authorizedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(event.authorizedAt)
    ) {
      return false;
    }
    previousGeneration = Number(event.generation);
  }
  const latest = value.at(-1);
  return (
    isRecord(latest) &&
    latest.generation === authorization.generation &&
    latest.authorizationIdHash === authorization.idHash
  );
}

function isValidStageDistributions(
  value: unknown,
  committedDeployments: number,
): value is AgentDeploymentLatencyStageSummary[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  let previousKey = "";
  for (const stage of value) {
    if (
      !isRecord(stage) ||
      Object.keys(stage).sort().join("\0") !==
        [
          "duplicateEvidenceCount",
          "invalidCount",
          "maxMs",
          "missingCount",
          "name",
          "p50Ms",
          "p95Ms",
          "sampleCount",
          "source",
        ]
          .sort()
          .join("\0") ||
      typeof stage.name !== "string" ||
      !/^[a-z0-9][a-z0-9:_-]{0,159}$/.test(stage.name) ||
      !["agent_event", "runner_provisioning_event"].includes(String(stage.source)) ||
      ![
        stage.sampleCount,
        stage.missingCount,
        stage.invalidCount,
        stage.duplicateEvidenceCount,
      ].every(
        (count) =>
          Number.isSafeInteger(count) &&
          Number(count) >= 0 &&
          Number(count) <= committedDeployments,
      ) ||
      !validStageDurations(stage.sampleCount, stage.p50Ms, stage.p95Ms, stage.maxMs)
    ) {
      return false;
    }
    if (
      Number(stage.missingCount) > Number(stage.invalidCount) ||
      Number(stage.duplicateEvidenceCount) > Number(stage.invalidCount) ||
      (stage.source === "agent_event" && !stage.name.startsWith("agent:")) ||
      (stage.source === "runner_provisioning_event" &&
        !stage.name.startsWith("runner:") &&
        !stage.name.startsWith("bootstrap:"))
    ) {
      return false;
    }
    const key = `${stage.name}\0${stage.source}`;
    if (key <= previousKey) return false;
    previousKey = key;
  }
  return true;
}

function validStageDurations(
  sampleCount: unknown,
  p50Ms: unknown,
  p95Ms: unknown,
  maxMs: unknown,
): boolean {
  const values = [p50Ms, p95Ms, maxMs];
  if (sampleCount === 0) return values.every((value) => value === null);
  if (!values.every((value) => Number.isSafeInteger(value) && Number(value) >= 0)) {
    return false;
  }
  return Number(p50Ms) <= Number(p95Ms) && Number(p95Ms) <= Number(maxMs);
}

function isValidSlotCleanupEvidence(value: unknown): value is SlotCleanupEvidence[] {
  return (
    Array.isArray(value) &&
    value.length === PROVIDER_TRIAL_SLOT_COUNT &&
    value.every((slot, index) => {
      if (
        !isRecord(slot) ||
        Object.keys(slot).sort().join("\0") !==
          ["activeProviderResources", "attempts", "costCents", "slotNumber"].sort().join("\0") ||
        slot.slotNumber !== index + 1 ||
        !Number.isSafeInteger(slot.costCents) ||
        Number(slot.costCents) < 0 ||
        !Number.isSafeInteger(slot.activeProviderResources) ||
        Number(slot.activeProviderResources) < 0 ||
        !Array.isArray(slot.attempts) ||
        slot.attempts.length < 1
      ) {
        return false;
      }
      const attemptsValid = slot.attempts.every(
        (attempt, attemptIndex) =>
          isRecord(attempt) &&
          Object.keys(attempt).sort().join("\0") ===
            ["authoritative", "cleanupAttemptNumber", "ok", "remainingResourceCount"]
              .sort()
              .join("\0") &&
          attempt.cleanupAttemptNumber === attemptIndex + 1 &&
          typeof attempt.ok === "boolean" &&
          typeof attempt.authoritative === "boolean" &&
          Number.isSafeInteger(attempt.remainingResourceCount) &&
          Number(attempt.remainingResourceCount) >= 0,
      );
      const finalAttempt = slot.attempts.at(-1);
      return (
        attemptsValid &&
        isRecord(finalAttempt) &&
        finalAttempt.ok === true &&
        finalAttempt.authoritative === true &&
        finalAttempt.remainingResourceCount === 0
      );
    })
  );
}

export async function initializeProviderTrialDriver(
  connection: DatabaseConnection,
  input: {
    cohortId: string;
    authorization: Authorization;
    configuration: ProviderTrialDriverConfiguration;
  },
): Promise<void> {
  assertAuthorization(input.authorization);
  assertConfiguration(input.configuration);
  const [cohort] = await connection.db
    .select({
      region: providerTrialCohorts.region,
      runnerSizeSlug: providerTrialCohorts.runnerSizeSlug,
    })
    .from(providerTrialCohorts)
    .where(eq(providerTrialCohorts.id, input.cohortId))
    .limit(1);
  if (
    !cohort ||
    cohort.region !== input.configuration.authorizedRegion ||
    cohort.runnerSizeSlug !== input.configuration.authorizedRunnerSizeSlug
  ) {
    throw new Error("Provider Trial authorization scope does not match the immutable cohort.");
  }
  await connection.db.transaction(async (tx) => {
    const authorizationIdHash = authorizationHash(input.authorization.id);
    await tx.insert(providerTrialRuns).values({
      cohortId: input.cohortId,
      configuration: input.configuration,
      authorizationGeneration: input.authorization.generation,
      authorizationIdHash,
    });
    await tx.insert(providerTrialAuthorizationEvents).values({
      cohortId: input.cohortId,
      generation: input.authorization.generation,
      authorizationIdHash,
      prerequisiteGateEvidenceDigest: input.configuration.prerequisiteGateEvidenceDigest,
      deploymentChoicesDigest: input.configuration.deploymentChoicesDigest,
    });
  });
}

export async function resumeProviderTrialDriver(
  connection: DatabaseConnection,
  input: {
    cohortId: string;
    authorization: Authorization;
    authorizationEvidence?: AuthorizationEvidence;
  },
  dependencies: ProviderTrialDriverDependencies,
): Promise<{
  state: "running" | "paused" | "ready_to_finalize" | "complete";
  nextSlotNumber: number;
  spentCents: number;
  signedReportDigest?: string;
}> {
  assertAuthorization(input.authorization);
  if (input.authorizationEvidence) assertAuthorizationEvidence(input.authorizationEvidence);
  const startedAt = dependencies.now?.() ?? new Date();
  const leaseOwner = `provider-trial:${dependencies.leaseOwner?.() ?? randomUUID()}`;
  const leased = await acquireRunLease(connection, input, startedAt, leaseOwner);
  const run = leased.run;
  const configuration = {
    ...parseConfiguration(run.configuration),
    prerequisiteGateEvidenceDigest: leased.authorizationEvidence.prerequisiteGateEvidenceDigest,
    deploymentChoicesDigest: leased.authorizationEvidence.deploymentChoicesDigest,
  };
  if (run.state === "complete") {
    return {
      state: "complete",
      nextSlotNumber: run.nextSlotNumber,
      spentCents: run.spentCents,
      ...(run.signedReportDigest ? { signedReportDigest: run.signedReportDigest } : {}),
    };
  }
  if (run.nextSlotNumber > PROVIDER_TRIAL_SLOT_COUNT) {
    return await finalizeRun(connection, run, configuration, dependencies, startedAt, leaseOwner);
  }

  const remainingBudget = configuration.maxSpendCents - run.spentCents;
  if (remainingBudget < configuration.maxSlotCostCents) {
    return await pauseRun(connection, run, leaseOwner, startedAt, "budget_exhausted");
  }
  const attempt = await beginOrResumeProviderTrialSlot(connection, {
    cohortId: input.cohortId,
    slotNumber: run.nextSlotNumber,
  });
  const executionDeadlineAt = new Date(
    new Date(attempt.requestStartedAt).getTime() + configuration.perSlotTimeoutMs,
  );
  const context = executionContext(attempt, configuration, executionDeadlineAt);
  let checkpoint = parseCheckpoint(run.activeSlotCheckpoint, attempt);

  if (!checkpoint || checkpoint.execution.outcome === "request_outcome_unknown") {
    const recoveringUnknown = checkpoint?.execution.outcome === "request_outcome_unknown";
    if (!checkpoint) {
      checkpoint = {
        schemaVersion: PROVIDER_TRIAL_CHECKPOINT_SCHEMA_VERSION,
        slotNumber: attempt.slotNumber,
        requestAttemptId: attempt.requestAttemptId,
        execution: { outcome: "request_outcome_unknown" },
      };
      await retainCheckpoint(connection, run.cohortId, leaseOwner, checkpoint, startedAt);
    }
    let execution: ProviderTrialExecution | { outcome: "request_outcome_unknown" };
    try {
      const requestOperationDeadlineAt = recoveringUnknown
        ? new Date(startedAt.getTime() + configuration.cleanupTimeoutMs)
        : executionDeadlineAt;
      execution = recoveringUnknown
        ? dependencies.reconcileRequest
          ? await runBeforeDeadline(
              (signal, timeoutMs) =>
                dependencies.reconcileRequest?.(attempt, { ...context, signal, timeoutMs }) ??
                Promise.resolve({ outcome: "request_outcome_unknown" as const }),
              requestOperationDeadlineAt,
            )
          : { outcome: "request_outcome_unknown" }
        : await runBeforeDeadline(
            (signal, timeoutMs) =>
              dependencies.executeSlot(attempt, { ...context, signal, timeoutMs }),
            executionDeadlineAt,
          );
    } catch {
      execution = { outcome: "request_outcome_unknown" };
    }
    execution = normalizeExecution(execution);
    checkpoint = {
      schemaVersion: PROVIDER_TRIAL_CHECKPOINT_SCHEMA_VERSION,
      slotNumber: attempt.slotNumber,
      requestAttemptId: attempt.requestAttemptId,
      execution,
    };
    await retainCheckpoint(connection, run.cohortId, leaseOwner, checkpoint, startedAt);
    if (execution.outcome === "request_outcome_unknown") {
      return await pauseRun(connection, run, leaseOwner, startedAt, "request_outcome_unknown");
    }
  }

  const execution = parseExecution(checkpoint.execution);
  const activeResources = execution.activeProviderResources;
  let unsafe =
    execution.outcome === "safety_pause" ||
    execution.costCents > configuration.maxSlotCostCents ||
    run.spentCents + execution.costCents > configuration.maxSpendCents ||
    activeResources > configuration.maxProviderResources;
  if (execution.outcome === "committed") {
    unsafe ||= !(await committedBenchmarkIdentityMatches(
      connection,
      execution.deploymentId,
      configuration,
    ));
  }
  const slot = await readSlotState(connection, attempt);

  if (!slot.requestOutcome) {
    if (execution.outcome === "committed") {
      await recordProviderTrialRequestOutcome(connection, {
        ...attempt,
        outcome: "committed",
        deploymentId: execution.deploymentId,
      });
    } else {
      await recordProviderTrialRequestOutcome(connection, {
        ...attempt,
        outcome: "pre_commit_failure",
        safeCode: unsafe ? "safety_failure" : execution.safeCode,
      });
    }
  } else {
    assertRecordedRequestMatches(slot, execution, unsafe);
  }

  const refreshed = await readSlotState(connection, attempt);
  let observationIncomplete = false;
  if (execution.outcome === "committed" && !refreshed.terminalOutcome) {
    let observed: "observe_deployment" | "timed_out" | "safety_failure" = "safety_failure";
    if (!unsafe) {
      try {
        observed = dependencies.observeCommittedSlot
          ? await runBeforeDeadline(
              (signal, timeoutMs) =>
                dependencies.observeCommittedSlot?.(attempt, {
                  signal,
                  deadlineAt: executionDeadlineAt.toISOString(),
                  timeoutMs,
                }) ?? Promise.resolve("observe_deployment" as const),
              executionDeadlineAt,
            )
          : "observe_deployment";
      } catch {
        observed = "timed_out";
      }
    }
    try {
      await recordProviderTrialTerminalOutcome(connection, { ...attempt, outcome: observed });
    } catch {
      observationIncomplete = true;
    }
  }

  const cleanupDeadlineAt = new Date(Date.now() + configuration.cleanupTimeoutMs);
  const cleanup = await performCleanup(dependencies, run.cohortId, cleanupDeadlineAt);
  const cleanupPause = await recordSlotCleanupEvent(connection, {
    cohortId: run.cohortId,
    leaseOwner,
    slotId: attempt.slotId,
    costCents: execution.costCents,
    activeProviderResources: activeResources,
    cleanup,
    pauseReason: observationIncomplete ? "observation_incomplete" : null,
    createdAt: dependencies.now?.() ?? new Date(),
  });
  if (!cleanup.ok || !cleanup.authoritative || cleanup.remainingResourceIds.length > 0) {
    if (!cleanupPause) {
      throw new Error("Provider Trial failed cleanup did not produce an atomic safety pause.");
    }
    return {
      state: "paused" as const,
      nextSlotNumber: cleanupPause.nextSlotNumber,
      spentCents: cleanupPause.spentCents,
    };
  }
  if (observationIncomplete) {
    if (!cleanupPause) {
      throw new Error("Provider Trial incomplete observation did not produce an atomic pause.");
    }
    return {
      state: "paused" as const,
      nextSlotNumber: cleanupPause.nextSlotNumber,
      spentCents: cleanupPause.spentCents,
    };
  }

  const nextSlotNumber = run.nextSlotNumber + 1;
  const paused = unsafe;
  const state = paused
    ? "paused"
    : nextSlotNumber > PROVIDER_TRIAL_SLOT_COUNT
      ? "ready_to_finalize"
      : "running";
  const now = dependencies.now?.() ?? new Date();
  const [advanced] = await connection.db
    .update(providerTrialRuns)
    .set({
      state,
      nextSlotNumber,
      spentCents: run.spentCents + execution.costCents,
      activeSlotCheckpoint: null,
      cleanupEvidence: cleanup,
      pausedAt: paused ? now : null,
      pauseReason: paused ? "safety_pause" : null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(providerTrialRuns.cohortId, input.cohortId),
        eq(providerTrialRuns.leaseOwner, leaseOwner),
      ),
    )
    .returning();
  if (!advanced) throw new Error("Provider Trial lease was lost before slot checkpointing.");
  return {
    state,
    nextSlotNumber,
    spentCents: run.spentCents + execution.costCents,
  };
}

export async function reconcileProviderTrialCleanup(
  connection: DatabaseConnection,
  input: { cohortId: string; authorization: Authorization },
  dependencies: ProviderTrialCleanupDependencies,
): Promise<{
  state: "running" | "paused" | "ready_to_finalize";
  nextSlotNumber: number;
  spentCents: number;
}> {
  assertAuthorization(input.authorization);
  const startedAt = dependencies.now?.() ?? new Date();
  const leaseOwner = `provider-trial-cleanup:${dependencies.leaseOwner?.() ?? randomUUID()}`;
  const leased = await acquireCleanupLease(connection, input, startedAt, leaseOwner);
  const configuration = parseConfiguration(leased.run.configuration);
  const checkpoint = parseCheckpoint(leased.run.activeSlotCheckpoint, leased.attempt);
  if (!checkpoint) throw new Error("Provider Trial cleanup checkpoint is missing.");
  const execution = parseExecution(checkpoint.execution);
  let unsafe =
    execution.outcome === "safety_pause" ||
    execution.costCents > configuration.maxSlotCostCents ||
    leased.run.spentCents + execution.costCents > configuration.maxSpendCents ||
    execution.activeProviderResources > configuration.maxProviderResources;
  if (execution.outcome === "committed") {
    unsafe ||= !(await committedBenchmarkIdentityMatches(
      connection,
      execution.deploymentId,
      configuration,
    ));
  }

  const cleanupDeadlineAt = new Date(Date.now() + configuration.cleanupTimeoutMs);
  const cleanup = await performCleanup(dependencies, leased.run.cohortId, cleanupDeadlineAt);
  const cleanupPause = await recordSlotCleanupEvent(connection, {
    cohortId: leased.run.cohortId,
    leaseOwner,
    slotId: leased.attempt.slotId,
    costCents: execution.costCents,
    activeProviderResources: execution.activeProviderResources,
    cleanup,
    pauseReason: null,
    createdAt: dependencies.now?.() ?? new Date(),
  });
  if (!cleanup.ok || !cleanup.authoritative || cleanup.remainingResourceIds.length > 0) {
    if (!cleanupPause) {
      throw new Error("Provider Trial cleanup reconciliation did not produce a safety pause.");
    }
    return { state: "paused", ...cleanupPause };
  }

  const nextSlotNumber = leased.run.nextSlotNumber + 1;
  const gateImpossible = await isProviderTrialGateImpossible(connection, leased.run.cohortId);
  const pauseReason = unsafe ? "safety_pause" : gateImpossible ? "gate_impossible" : null;
  const state = pauseReason
    ? "paused"
    : nextSlotNumber > PROVIDER_TRIAL_SLOT_COUNT
      ? "ready_to_finalize"
      : "running";
  const now = dependencies.now?.() ?? new Date();
  const [advanced] = await connection.db
    .update(providerTrialRuns)
    .set({
      state,
      nextSlotNumber,
      spentCents: leased.run.spentCents + execution.costCents,
      activeSlotCheckpoint: null,
      cleanupEvidence: cleanup,
      pausedAt: pauseReason ? now : null,
      pauseReason,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(providerTrialRuns.cohortId, leased.run.cohortId),
        eq(providerTrialRuns.leaseOwner, leaseOwner),
      ),
    )
    .returning();
  if (!advanced) throw new Error("Provider Trial cleanup reconciliation lost its lease.");
  return {
    state,
    nextSlotNumber,
    spentCents: leased.run.spentCents + execution.costCents,
  };
}

async function recordSlotCleanupEvent(
  connection: DatabaseConnection,
  input: {
    cohortId: string;
    leaseOwner: string;
    slotId: string;
    costCents: number;
    activeProviderResources: number;
    cleanup: CleanupEvidence;
    pauseReason: "observation_incomplete" | null;
    createdAt: Date;
  },
): Promise<Pick<typeof providerTrialRuns.$inferSelect, "nextSlotNumber" | "spentCents"> | null> {
  return await connection.db.transaction(async (tx) => {
    const [slot] = await tx
      .select({ id: providerTrialSlots.id })
      .from(providerTrialSlots)
      .where(eq(providerTrialSlots.id, input.slotId))
      .for("update")
      .limit(1);
    if (!slot) throw new Error("Provider Trial cleanup slot was not found.");
    const [previous] = await tx
      .select({ cleanupAttemptNumber: providerTrialSlotCleanupEvents.cleanupAttemptNumber })
      .from(providerTrialSlotCleanupEvents)
      .where(eq(providerTrialSlotCleanupEvents.slotId, input.slotId))
      .orderBy(desc(providerTrialSlotCleanupEvents.cleanupAttemptNumber))
      .limit(1);
    await tx.insert(providerTrialSlotCleanupEvents).values({
      slotId: input.slotId,
      cleanupAttemptNumber: (previous?.cleanupAttemptNumber ?? 0) + 1,
      costCents: input.costCents,
      activeProviderResources: input.activeProviderResources,
      ok: input.cleanup.ok,
      authoritative: input.cleanup.authoritative,
      remainingResourceCount: input.cleanup.remainingResourceIds.length,
      createdAt: input.createdAt,
    });
    const cleanupSucceeded =
      input.cleanup.ok &&
      input.cleanup.authoritative &&
      input.cleanup.remainingResourceIds.length === 0;
    if (cleanupSucceeded && input.pauseReason === null) {
      return null;
    }
    const [paused] = await tx
      .update(providerTrialRuns)
      .set({
        state: "paused",
        cleanupEvidence: input.cleanup,
        pausedAt: input.createdAt,
        pauseReason: cleanupSucceeded ? input.pauseReason : "cleanup_failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: input.createdAt,
      })
      .where(
        and(
          eq(providerTrialRuns.cohortId, input.cohortId),
          eq(providerTrialRuns.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({
        nextSlotNumber: providerTrialRuns.nextSlotNumber,
        spentCents: providerTrialRuns.spentCents,
      });
    if (!paused) throw new Error("Provider Trial lease was lost before the cleanup safety pause.");
    return paused;
  });
}

async function buildSlotCleanupEvidence(
  connection: DatabaseConnection,
  cohortId: string,
): Promise<SlotCleanupEvidence[]> {
  const rows = await connection.db
    .select({
      slotNumber: providerTrialSlots.slotNumber,
      cleanupAttemptNumber: providerTrialSlotCleanupEvents.cleanupAttemptNumber,
      costCents: providerTrialSlotCleanupEvents.costCents,
      activeProviderResources: providerTrialSlotCleanupEvents.activeProviderResources,
      ok: providerTrialSlotCleanupEvents.ok,
      authoritative: providerTrialSlotCleanupEvents.authoritative,
      remainingResourceCount: providerTrialSlotCleanupEvents.remainingResourceCount,
    })
    .from(providerTrialSlots)
    .innerJoin(
      providerTrialSlotCleanupEvents,
      eq(providerTrialSlotCleanupEvents.slotId, providerTrialSlots.id),
    )
    .where(eq(providerTrialSlots.cohortId, cohortId))
    .orderBy(
      asc(providerTrialSlots.slotNumber),
      asc(providerTrialSlotCleanupEvents.cleanupAttemptNumber),
    );
  const bySlot = new Map<number, SlotCleanupEvidence>();
  for (const row of rows) {
    const evidence = bySlot.get(row.slotNumber) ?? {
      slotNumber: row.slotNumber,
      costCents: row.costCents,
      activeProviderResources: row.activeProviderResources,
      attempts: [],
    };
    if (
      evidence.costCents !== row.costCents ||
      evidence.activeProviderResources !== row.activeProviderResources
    ) {
      throw new Error("Provider Trial cleanup attempts disagree on immutable slot resource use.");
    }
    evidence.attempts.push({
      cleanupAttemptNumber: row.cleanupAttemptNumber,
      ok: row.ok,
      authoritative: row.authoritative,
      remainingResourceCount: row.remainingResourceCount,
    });
    bySlot.set(row.slotNumber, evidence);
  }
  const evidence = Array.from({ length: PROVIDER_TRIAL_SLOT_COUNT }, (_, index) =>
    bySlot.get(index + 1),
  );
  if (evidence.some((slot) => !slot) || !isValidSlotCleanupEvidence(evidence)) {
    throw new Error("Provider Trial per-slot cleanup evidence is incomplete.");
  }
  return evidence as SlotCleanupEvidence[];
}

async function acquireRunLease(
  connection: DatabaseConnection,
  input: {
    cohortId: string;
    authorization: Authorization;
    authorizationEvidence?: AuthorizationEvidence;
  },
  now: Date,
  leaseOwner: string,
) {
  return await connection.db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(providerTrialRuns)
      .where(eq(providerTrialRuns.cohortId, input.cohortId))
      .for("update")
      .limit(1);
    if (!run) throw new Error("Provider Trial driver was not initialized.");
    const configuration = parseConfiguration(run.configuration);
    const [currentEvidence] = await tx
      .select()
      .from(providerTrialAuthorizationEvents)
      .where(eq(providerTrialAuthorizationEvents.cohortId, input.cohortId))
      .orderBy(desc(providerTrialAuthorizationEvents.generation))
      .limit(1);
    if (!currentEvidence) throw new Error("Provider Trial authorization evidence is missing.");
    if (run.state === "complete") return { run, authorizationEvidence: currentEvidence };
    if (run.leaseOwner && run.leaseExpiresAt && run.leaseExpiresAt.getTime() > now.getTime()) {
      throw new Error("Provider Trial run already has an active lease.");
    }
    const incomingHash = authorizationHash(input.authorization.id);
    const renewing = run.state === "paused";
    if (renewing) {
      if (input.authorization.generation <= run.authorizationGeneration) {
        throw new Error("Provider Trial safety pause requires renewed authorization.");
      }
      if (!input.authorizationEvidence) {
        throw new Error("Provider Trial renewed authorization evidence is required.");
      }
    } else if (
      input.authorization.generation !== run.authorizationGeneration ||
      incomingHash !== run.authorizationIdHash
    ) {
      throw new Error("Provider Trial authorization does not match the active run.");
    }
    if (
      !renewing &&
      input.authorizationEvidence &&
      (input.authorizationEvidence.prerequisiteGateEvidenceDigest !==
        currentEvidence.prerequisiteGateEvidenceDigest ||
        input.authorizationEvidence.deploymentChoicesDigest !==
          currentEvidence.deploymentChoicesDigest)
    ) {
      throw new Error("Provider Trial authorization evidence does not match the active run.");
    }
    const activeEvidence = renewing
      ? {
          prerequisiteGateEvidenceDigest:
            input.authorizationEvidence?.prerequisiteGateEvidenceDigest ?? "",
          deploymentChoicesDigest: input.authorizationEvidence?.deploymentChoicesDigest ?? "",
        }
      : currentEvidence;
    if (renewing) {
      await tx.insert(providerTrialAuthorizationEvents).values({
        cohortId: input.cohortId,
        generation: input.authorization.generation,
        authorizationIdHash: incomingHash,
        prerequisiteGateEvidenceDigest: activeEvidence.prerequisiteGateEvidenceDigest,
        deploymentChoicesDigest: activeEvidence.deploymentChoicesDigest,
        renewedFromPausedAt: run.pausedAt,
        renewedFromPauseReason: run.pauseReason,
        authorizedAt: now,
      });
    }
    const [leased] = await tx
      .update(providerTrialRuns)
      .set({
        state: "running",
        authorizationGeneration: renewing
          ? input.authorization.generation
          : run.authorizationGeneration,
        authorizationIdHash: renewing ? incomingHash : run.authorizationIdHash,
        authorizedAt: renewing ? now : run.authorizedAt,
        pausedAt: null,
        pauseReason: null,
        leaseOwner,
        leaseExpiresAt: new Date(
          now.getTime() +
            configuration.perSlotTimeoutMs +
            configuration.cleanupTimeoutMs +
            LEASE_GRACE_MS,
        ),
        updatedAt: now,
      })
      .where(eq(providerTrialRuns.cohortId, input.cohortId))
      .returning();
    if (!leased) throw new Error("Provider Trial lease acquisition failed.");
    return { run: leased, authorizationEvidence: activeEvidence };
  });
}

async function acquireCleanupLease(
  connection: DatabaseConnection,
  input: { cohortId: string; authorization: Authorization },
  now: Date,
  leaseOwner: string,
): Promise<{
  run: typeof providerTrialRuns.$inferSelect;
  attempt: ProviderTrialSlotAttempt;
}> {
  return await connection.db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(providerTrialRuns)
      .where(eq(providerTrialRuns.cohortId, input.cohortId))
      .for("update")
      .limit(1);
    if (!run) throw new Error("Provider Trial driver was not initialized.");
    if (run.state !== "paused" || run.pauseReason !== "cleanup_failed") {
      throw new Error("Provider Trial is not paused for cleanup reconciliation.");
    }
    if (run.leaseOwner && run.leaseExpiresAt && run.leaseExpiresAt.getTime() > now.getTime()) {
      throw new Error("Provider Trial run already has an active lease.");
    }
    if (
      input.authorization.generation !== run.authorizationGeneration ||
      authorizationHash(input.authorization.id) !== run.authorizationIdHash
    ) {
      throw new Error("Provider Trial cleanup authorization does not match the active run.");
    }
    const [slot] = await tx
      .select()
      .from(providerTrialSlots)
      .where(
        and(
          eq(providerTrialSlots.cohortId, input.cohortId),
          eq(providerTrialSlots.slotNumber, run.nextSlotNumber),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !slot?.requestAttemptId ||
      !slot.requestStartedAt ||
      !slot.requestOutcome ||
      !slot.terminalOutcome
    ) {
      throw new Error("Provider Trial cleanup slot is not terminal.");
    }
    const attempt = {
      cohortId: slot.cohortId,
      slotId: slot.id,
      slotNumber: slot.slotNumber,
      requestAttemptId: slot.requestAttemptId,
      requestStartedAt: slot.requestStartedAt.toISOString(),
    };
    if (!parseCheckpoint(run.activeSlotCheckpoint, attempt)) {
      throw new Error("Provider Trial cleanup checkpoint is missing.");
    }
    const configuration = parseConfiguration(run.configuration);
    const [leased] = await tx
      .update(providerTrialRuns)
      .set({
        state: "running",
        pausedAt: null,
        pauseReason: null,
        leaseOwner,
        leaseExpiresAt: new Date(now.getTime() + configuration.cleanupTimeoutMs + LEASE_GRACE_MS),
        updatedAt: now,
      })
      .where(eq(providerTrialRuns.cohortId, input.cohortId))
      .returning();
    if (!leased) throw new Error("Provider Trial cleanup lease acquisition failed.");
    return { run: leased, attempt };
  });
}

async function finalizeRun(
  connection: DatabaseConnection,
  run: typeof providerTrialRuns.$inferSelect,
  configuration: ProviderTrialDriverConfiguration,
  dependencies: ProviderTrialDriverDependencies,
  now: Date,
  leaseOwner: string,
) {
  if (!dependencies.signing) throw new Error("Provider Trial signing configuration is required.");
  const cleanup = await performCleanup(
    dependencies,
    run.cohortId,
    new Date(Date.now() + configuration.cleanupTimeoutMs),
  );
  if (!cleanup.ok || !cleanup.authoritative || cleanup.remainingResourceIds.length > 0) {
    await retainCleanupEvidence(connection, run.cohortId, leaseOwner, cleanup, now);
    return await pauseRun(connection, run, leaseOwner, now, "cleanup_failed");
  }
  const cohortReport = await buildProviderTrialCohortReport(connection, run.cohortId, {
    generatedAt: now,
  });
  const deploymentIds = cohortReport.slots.flatMap((slot) =>
    slot.deploymentId ? [slot.deploymentId] : [],
  );
  const stageRuns = await Promise.all(
    deploymentIds.map(async (deploymentId) => {
      const latency = await buildAgentDeploymentLatencyReportForDatabase(connection, {
        deploymentId,
        limit: 1,
        generatedAt: now,
      });
      const exactRun = latency.runs[0];
      if (latency.runs.length !== 1 || exactRun?.deploymentId !== deploymentId) {
        throw new Error("Provider Trial stage evidence is missing its exact Agent Deployment.");
      }
      return exactRun;
    }),
  );
  const slotCleanup = await buildSlotCleanupEvidence(connection, run.cohortId);
  const authorizationEvidence = await connection.db
    .select({
      generation: providerTrialAuthorizationEvents.generation,
      authorizationIdHash: providerTrialAuthorizationEvents.authorizationIdHash,
      prerequisiteGateEvidenceDigest:
        providerTrialAuthorizationEvents.prerequisiteGateEvidenceDigest,
      deploymentChoicesDigest: providerTrialAuthorizationEvents.deploymentChoicesDigest,
      renewedFromPausedAt: providerTrialAuthorizationEvents.renewedFromPausedAt,
      renewedFromPauseReason: providerTrialAuthorizationEvents.renewedFromPauseReason,
      authorizedAt: providerTrialAuthorizationEvents.authorizedAt,
    })
    .from(providerTrialAuthorizationEvents)
    .where(eq(providerTrialAuthorizationEvents.cohortId, run.cohortId))
    .orderBy(providerTrialAuthorizationEvents.generation);
  const report = {
    schemaVersion: PROVIDER_TRIAL_DRIVER_REPORT_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    authorization: {
      idHash: run.authorizationIdHash,
      generation: run.authorizationGeneration,
    },
    authorizationEvidence: authorizationEvidence.map((event) => ({
      ...event,
      authorizedAt: event.authorizedAt.toISOString(),
      renewedFromPausedAt: event.renewedFromPausedAt?.toISOString() ?? null,
    })),
    configuration,
    cohort: cohortReport,
    stages: Object.fromEntries(
      cohortReport.slots.map((slot) => [String(slot.slotNumber), slot.terminalOutcome]),
    ),
    stageDistributions: summarizeAgentDeploymentLatencyStages(stageRuns),
    slotCleanup,
    cleanup: {
      ok: cleanup.ok,
      authoritative: cleanup.authoritative,
      remainingResourceCount: cleanup.remainingResourceIds.length,
    },
  };
  const canonicalBytes = canonicalJson(report);
  const digest = `sha256:${createHash("sha256").update(canonicalBytes).digest("hex")}`;
  const signature = sign(
    null,
    Buffer.from(canonicalBytes),
    dependencies.signing.privateKeyPem,
  ).toString("base64url");
  const [completed] = await connection.db
    .update(providerTrialRuns)
    .set({
      state: "complete",
      cleanupEvidence: cleanup,
      signedReportBytes: canonicalBytes,
      signedReportDigest: digest,
      signedReportKeyId: dependencies.signing.keyId,
      signedReportSignature: signature,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(providerTrialRuns.cohortId, run.cohortId),
        eq(providerTrialRuns.leaseOwner, leaseOwner),
      ),
    )
    .returning();
  if (!completed) throw new Error("Provider Trial lease was lost before report publication.");
  return {
    state: "complete" as const,
    nextSlotNumber: run.nextSlotNumber,
    spentCents: run.spentCents,
    signedReportDigest: digest,
  };
}

async function pauseRun(
  connection: DatabaseConnection,
  run: Pick<typeof providerTrialRuns.$inferSelect, "cohortId" | "nextSlotNumber" | "spentCents">,
  leaseOwner: string,
  now: Date,
  reason: string,
) {
  const [paused] = await connection.db
    .update(providerTrialRuns)
    .set({
      state: "paused",
      pausedAt: now,
      pauseReason: reason,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(providerTrialRuns.cohortId, run.cohortId),
        eq(providerTrialRuns.leaseOwner, leaseOwner),
      ),
    )
    .returning();
  if (!paused) throw new Error("Provider Trial lease was lost before the safety pause.");
  return {
    state: "paused" as const,
    nextSlotNumber: paused.nextSlotNumber,
    spentCents: paused.spentCents,
  };
}

async function retainCheckpoint(
  connection: DatabaseConnection,
  cohortId: string,
  leaseOwner: string,
  checkpoint: ProviderTrialCheckpoint,
  now: Date,
): Promise<void> {
  const [updated] = await connection.db
    .update(providerTrialRuns)
    .set({ activeSlotCheckpoint: checkpoint, updatedAt: now })
    .where(
      and(eq(providerTrialRuns.cohortId, cohortId), eq(providerTrialRuns.leaseOwner, leaseOwner)),
    )
    .returning({ cohortId: providerTrialRuns.cohortId });
  if (!updated) throw new Error("Provider Trial lease was lost before execution checkpointing.");
}

async function retainCleanupEvidence(
  connection: DatabaseConnection,
  cohortId: string,
  leaseOwner: string,
  cleanup: CleanupEvidence,
  now: Date,
): Promise<void> {
  await connection.db
    .update(providerTrialRuns)
    .set({ cleanupEvidence: cleanup, updatedAt: now })
    .where(
      and(eq(providerTrialRuns.cohortId, cohortId), eq(providerTrialRuns.leaseOwner, leaseOwner)),
    );
}

async function readSlotState(connection: DatabaseConnection, attempt: ProviderTrialSlotAttempt) {
  const [slot] = await connection.db
    .select({
      requestOutcome: providerTrialSlots.requestOutcome,
      requestSafeCode: providerTrialSlots.requestSafeCode,
      deploymentId: providerTrialSlots.deploymentId,
      terminalOutcome: providerTrialSlots.terminalOutcome,
    })
    .from(providerTrialSlots)
    .where(eq(providerTrialSlots.id, attempt.slotId))
    .limit(1);
  if (!slot) throw new Error("Provider Trial active slot was not found.");
  return slot;
}

async function isProviderTrialGateImpossible(
  connection: DatabaseConnection,
  cohortId: string,
): Promise<boolean> {
  const slots = await connection.db
    .select({
      requestOutcome: providerTrialSlots.requestOutcome,
      terminalOutcome: providerTrialSlots.terminalOutcome,
    })
    .from(providerTrialSlots)
    .where(eq(providerTrialSlots.cohortId, cohortId));
  const completed = slots.filter((slot) => slot.terminalOutcome !== null).length;
  const remaining = PROVIDER_TRIAL_SLOT_COUNT - completed;
  const committed = slots.filter((slot) => slot.requestOutcome === "committed").length;
  const readyWithin60 = slots.filter((slot) => slot.terminalOutcome === "ready_within_60").length;
  return committed + remaining < 29 || readyWithin60 + remaining < 29;
}

function assertRecordedRequestMatches(
  slot: Awaited<ReturnType<typeof readSlotState>>,
  execution: ProviderTrialExecution,
  unsafe: boolean,
): void {
  if (execution.outcome === "committed") {
    if (slot.requestOutcome !== "committed" || slot.deploymentId !== execution.deploymentId) {
      throw new Error("Provider Trial committed checkpoint disagrees with its immutable slot.");
    }
    return;
  }
  const expectedCode = unsafe ? "safety_failure" : execution.safeCode;
  if (slot.requestOutcome !== "pre_commit_failure" || slot.requestSafeCode !== expectedCode) {
    throw new Error("Provider Trial failure checkpoint disagrees with its immutable slot.");
  }
}

async function performCleanup(
  dependencies: Pick<ProviderTrialDriverDependencies, "cleanup">,
  cohortId: string,
  deadlineAt: Date,
): Promise<CleanupEvidence> {
  if (!dependencies.cleanup) {
    return { ok: false, authoritative: false, remainingResourceIds: [] };
  }
  try {
    const cleanup = await runBeforeDeadline(
      (signal, timeoutMs) =>
        dependencies.cleanup?.({
          cohortId,
          signal,
          deadlineAt: deadlineAt.toISOString(),
          timeoutMs,
        }) ?? Promise.resolve({ ok: false, authoritative: false, remainingResourceIds: [] }),
      deadlineAt,
    );
    return validCleanup(cleanup)
      ? {
          ok: cleanup.ok,
          authoritative: cleanup.authoritative,
          remainingResourceIds: [...cleanup.remainingResourceIds],
        }
      : { ok: false, authoritative: false, remainingResourceIds: [] };
  } catch {
    return { ok: false, authoritative: false, remainingResourceIds: [] };
  }
}

async function runBeforeDeadline<T>(
  operation: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
  deadlineAt: Date,
): Promise<T> {
  const timeoutMs = Math.max(0, deadlineAt.getTime() - Date.now());
  if (timeoutMs === 0) throw new Error("Provider Trial slot deadline elapsed.");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal, timeoutMs),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Provider Trial slot deadline elapsed."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function executionContext(
  attempt: ProviderTrialSlotAttempt,
  configuration: ProviderTrialDriverConfiguration,
  deadlineAt: Date,
): Omit<ProviderExecutionContext, "signal" | "timeoutMs"> {
  return {
    idempotencyKey: providerTrialDeploymentIdempotencyKey(attempt.requestAttemptId),
    deadlineAt: deadlineAt.toISOString(),
    maxCostCents: configuration.maxSlotCostCents,
    maxProviderResources: configuration.maxProviderResources,
    authorizationScope: {
      cohortId: attempt.cohortId,
      region: configuration.authorizedRegion,
      runnerSizeSlug: configuration.authorizedRunnerSizeSlug,
      deploymentChoicesDigest: configuration.deploymentChoicesDigest,
      benchmarkOwnerIdentityHash: configuration.benchmarkOwnerIdentityHash,
      benchmarkTelegramIdentityHash: configuration.benchmarkTelegramIdentityHash,
    },
  };
}

function parseCheckpoint(
  value: unknown,
  attempt: ProviderTrialSlotAttempt,
): ProviderTrialCheckpoint | null {
  if (value === null || value === undefined) return null;
  if (
    !isRecord(value) ||
    value.schemaVersion !== PROVIDER_TRIAL_CHECKPOINT_SCHEMA_VERSION ||
    value.slotNumber !== attempt.slotNumber ||
    value.requestAttemptId !== attempt.requestAttemptId ||
    !isRecord(value.execution)
  ) {
    throw new Error("Provider Trial active checkpoint is invalid.");
  }
  return value as ProviderTrialCheckpoint;
}

function parseExecution(value: ProviderTrialCheckpoint["execution"]): ProviderTrialExecution {
  if (
    value.outcome === "request_outcome_unknown" ||
    !["committed", "pre_commit_failure", "safety_pause"].includes(value.outcome) ||
    !Number.isSafeInteger("costCents" in value ? value.costCents : Number.NaN) ||
    !("costCents" in value) ||
    value.costCents < 0 ||
    !("activeProviderResources" in value) ||
    !Number.isSafeInteger(value.activeProviderResources) ||
    value.activeProviderResources < 0
  ) {
    throw new Error("Provider Trial execution checkpoint is invalid.");
  }
  if (
    (value.outcome === "committed" && !UUID.test(value.deploymentId)) ||
    (value.outcome === "pre_commit_failure" && !SAFE_CODES.has(value.safeCode)) ||
    (value.outcome === "safety_pause" && value.safeCode !== "safety_failure")
  ) {
    throw new Error("Provider Trial execution checkpoint is invalid.");
  }
  return value;
}

function normalizeExecution(
  value: ProviderTrialExecution | { outcome: "request_outcome_unknown" },
): ProviderTrialExecution | { outcome: "request_outcome_unknown" } {
  if (value.outcome === "request_outcome_unknown") return value;
  try {
    const parsed = parseExecution(value);
    if (parsed.outcome === "committed") {
      return {
        outcome: "committed",
        deploymentId: parsed.deploymentId,
        costCents: parsed.costCents,
        activeProviderResources: parsed.activeProviderResources,
      };
    }
    return parsed.outcome === "safety_pause"
      ? {
          outcome: "safety_pause",
          safeCode: "safety_failure",
          costCents: parsed.costCents,
          activeProviderResources: parsed.activeProviderResources,
        }
      : {
          outcome: "pre_commit_failure",
          safeCode: parsed.safeCode,
          costCents: parsed.costCents,
          activeProviderResources: parsed.activeProviderResources,
        };
  } catch {
    return { outcome: "request_outcome_unknown" };
  }
}

function assertConfiguration(value: ProviderTrialDriverConfiguration): void {
  if (
    !["digitalocean", "local_docker"].includes(value.providerMode) ||
    !Number.isInteger(value.perSlotTimeoutMs) ||
    value.perSlotTimeoutMs < 1_000 ||
    value.perSlotTimeoutMs > 900_000 ||
    !Number.isInteger(value.cleanupTimeoutMs) ||
    value.cleanupTimeoutMs < 1_000 ||
    value.cleanupTimeoutMs > 300_000 ||
    !Number.isInteger(value.maxSpendCents) ||
    value.maxSpendCents < 0 ||
    !Number.isInteger(value.maxSlotCostCents) ||
    value.maxSlotCostCents < 0 ||
    value.maxSpendCents < value.maxSlotCostCents * PROVIDER_TRIAL_SLOT_COUNT ||
    !Number.isInteger(value.maxProviderResources) ||
    value.maxProviderResources < 1 ||
    !SHA256_DIGEST.test(value.deploymentChoicesDigest) ||
    !SHA256_DIGEST.test(value.benchmarkOwnerIdentityHash) ||
    !SHA256_DIGEST.test(value.benchmarkTelegramIdentityHash) ||
    !SHA256_DIGEST.test(value.digitalOceanAccountIdentityHash) ||
    !SHA256_DIGEST.test(value.telegramBotIdentityHash) ||
    !SHA256_DIGEST.test(value.telegramChatIdentityHash) ||
    !SHA256_DIGEST.test(value.telegramUserIdentityHash) ||
    !SHA256_DIGEST.test(value.prerequisiteGateEvidenceDigest) ||
    !SAFE_SLUG.test(value.authorizedRegion) ||
    !SAFE_SLUG.test(value.authorizedRunnerSizeSlug) ||
    !Number.isInteger(value.evidenceRetentionDays) ||
    value.evidenceRetentionDays < 90
  ) {
    throw new Error("Provider Trial driver configuration is invalid.");
  }
}

function parseConfiguration(value: unknown): ProviderTrialDriverConfiguration {
  if (!isRecord(value)) throw new Error("Provider Trial driver configuration is invalid.");
  const configuration = value as ProviderTrialDriverConfiguration;
  assertConfiguration(configuration);
  if (
    Object.keys(value).sort().join("\0") !==
    [
      "authorizedRegion",
      "authorizedRunnerSizeSlug",
      "benchmarkOwnerIdentityHash",
      "benchmarkTelegramIdentityHash",
      "digitalOceanAccountIdentityHash",
      "telegramBotIdentityHash",
      "telegramChatIdentityHash",
      "telegramUserIdentityHash",
      "prerequisiteGateEvidenceDigest",
      "cleanupTimeoutMs",
      "deploymentChoicesDigest",
      "evidenceRetentionDays",
      "maxProviderResources",
      "maxSlotCostCents",
      "maxSpendCents",
      "perSlotTimeoutMs",
      "providerMode",
    ]
      .sort()
      .join("\0")
  ) {
    throw new Error("Provider Trial driver configuration is invalid.");
  }
  return configuration;
}

function assertAuthorization(value: Authorization): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value.id) ||
    !Number.isInteger(value.generation) ||
    value.generation < 1
  ) {
    throw new Error("Provider Trial authorization is invalid.");
  }
}

function assertAuthorizationEvidence(value: AuthorizationEvidence): void {
  if (
    !SHA256_DIGEST.test(value.prerequisiteGateEvidenceDigest) ||
    !SHA256_DIGEST.test(value.deploymentChoicesDigest)
  ) {
    throw new Error("Provider Trial authorization evidence is invalid.");
  }
}

function authorizationHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function providerTrialBenchmarkOwnerIdentityHash(userId: string): string {
  if (!UUID.test(userId)) throw new Error("Provider Trial benchmark Owner identity is invalid.");
  return `sha256:${createHash("sha256").update(`owner:${userId.toLowerCase()}`).digest("hex")}`;
}

export function providerTrialBenchmarkTelegramIdentityHash(uniquenessFingerprint: string): string {
  if (!/^[a-f0-9]{64}$/.test(uniquenessFingerprint)) {
    throw new Error("Provider Trial benchmark Telegram identity is invalid.");
  }
  return `sha256:${createHash("sha256").update(`telegram:${uniquenessFingerprint}`).digest("hex")}`;
}

async function committedBenchmarkIdentityMatches(
  connection: DatabaseConnection,
  deploymentId: string,
  configuration: ProviderTrialDriverConfiguration,
): Promise<boolean> {
  const [identity] = await connection.db
    .select({
      userId: agentDeployments.userId,
      telegramUniquenessFingerprint: agentSecrets.uniquenessFingerprint,
      deploymentChoices: agentDeployments.deploymentChoices,
    })
    .from(agentDeployments)
    .innerJoin(
      agentSecrets,
      and(
        eq(agentSecrets.agentId, agentDeployments.agentId),
        eq(agentSecrets.kind, "telegram_bot_token"),
        eq(agentSecrets.status, "active"),
      ),
    )
    .where(eq(agentDeployments.id, deploymentId))
    .limit(1);
  if (!identity?.telegramUniquenessFingerprint || !identity.deploymentChoices) return false;
  try {
    return (
      providerTrialBenchmarkOwnerIdentityHash(identity.userId) ===
        configuration.benchmarkOwnerIdentityHash &&
      providerTrialBenchmarkTelegramIdentityHash(identity.telegramUniquenessFingerprint) ===
        configuration.benchmarkTelegramIdentityHash &&
      providerTrialDeploymentChoicesDigest(identity.deploymentChoices) ===
        configuration.deploymentChoicesDigest
    );
  } catch {
    return false;
  }
}

export function providerTrialDeploymentChoicesDigest(choices: AgentDeploymentChoices): string {
  const parsed = parseAgentDeploymentChoices(choices);
  if (!parsed) throw new Error("Provider Trial Agent Deployment choices are invalid.");
  return `sha256:${createHash("sha256").update(canonicalJson(parsed)).digest("hex")}`;
}

function validCleanup(value: unknown): value is CleanupEvidence {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    typeof value.authoritative === "boolean" &&
    Array.isArray(value.remainingResourceIds) &&
    value.remainingResourceIds.length <= 100 &&
    value.remainingResourceIds.every(
      (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id),
    )
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
