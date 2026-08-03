import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import { hermesStagingAcceptanceRuns } from "@/src/server/db/schema";
import {
  HERMES_STAGING_ACCEPTANCE_ERROR_CODES,
  HERMES_STAGING_ACCEPTANCE_PHASES,
  HERMES_STAGING_MAX_CLEANUP_DURATION_MS,
  HERMES_STAGING_MAX_COUNTER,
  HERMES_STAGING_MAX_DURATION_MS,
  type HermesStagingAcceptanceEffectKind,
  type HermesStagingAcceptanceErrorCode,
  type HermesStagingAcceptancePhase,
  type HermesStagingAcceptanceTerminalOutcome,
  type HermesStagingAcceptanceState as HermesStagingAcceptanceWorkflowState,
} from "@/src/server/staging/hermes-staging-acceptance-state";

type HermesStagingAcceptanceTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type HermesStagingAcceptanceDatabase =
  | PostgresJsDatabase<typeof schema>
  | HermesStagingAcceptanceTransaction;

export const HERMES_STAGING_ACCEPTANCE_LEASE_MS = 90_000;
export const HERMES_STAGING_ACCEPTANCE_MAX_LEASE_ATTEMPTS = HERMES_STAGING_MAX_COUNTER;
export const HERMES_STAGING_ACCEPTANCE_QUEUE_STATES = [
  "pending",
  "executing",
  "waiting",
  "blocked",
  "complete",
] as const;
export const HERMES_STAGING_ACCEPTANCE_CHALLENGE_PURPOSES = ["initial", "post_restart"] as const;

export type HermesStagingAcceptanceQueueState =
  (typeof HERMES_STAGING_ACCEPTANCE_QUEUE_STATES)[number];
export type HermesStagingAcceptanceChallengePurpose =
  (typeof HERMES_STAGING_ACCEPTANCE_CHALLENGE_PURPOSES)[number];
export type HermesStagingAcceptanceRun = typeof hermesStagingAcceptanceRuns.$inferSelect;
export type ClaimedHermesStagingAcceptanceRun = HermesStagingAcceptanceRun & {
  state: "executing";
  leaseOwner: string;
  leaseExpiresAt: Date;
};

export type HermesStagingAcceptanceClaimTarget =
  | { kind: "global" }
  | { kind: "run"; runId: string };

export type BeginHermesStagingAcceptanceResult = {
  run: HermesStagingAcceptanceRun;
  disposition: "created" | "idempotent" | "active_exists";
};

export type HermesStagingAcceptanceEvidenceMutation = {
  observedImageDigest?: string;
  agentId?: string;
  deploymentId?: string;
  runnerId?: string;
  providerResourceId?: string;
  providerFirewallId?: string;
  initialChallengeAttestedAt?: Date;
  postRestartChallengeAttestedAt?: Date;
  publishedImageVerifiedAt?: Date;
  hostImageVerifiedAt?: Date;
  agentReadyVerifiedAt?: Date;
  restartRequestedAt?: Date;
  restartVerifiedAt?: Date;
  restartedRuntimeVerifiedAt?: Date;
  diagnosticsRedactedConfirmedAt?: Date;
  stopVerifiedAt?: Date;
  rollbackVerifiedAt?: Date;
  workloadCleanupConfirmedAt?: Date;
  secretsCleanupConfirmedAt?: Date;
  firewallCleanupConfirmedAt?: Date;
  dropletCleanupConfirmedAt?: Date;
  runnerCleanupConfirmedAt?: Date;
};

export type HermesStagingAcceptanceResultMutation = {
  workflowState: HermesStagingAcceptanceWorkflowState;
  queueState: Exclude<HermesStagingAcceptanceQueueState, "executing">;
  evidence?: HermesStagingAcceptanceEvidenceMutation;
  completedAt?: Date;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const WORKFLOW_RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const PROVIDER_LOCATOR_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;
const LEASE_OWNER_PATTERN =
  /^staging-acceptance:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PENDING_EFFECTS: readonly HermesStagingAcceptanceEffectKind[] = [
  "preflight",
  "attest_published_image",
  "create_ready_agent",
  "observe_agent_creation",
  "observe_next_deployment_stage",
  "verify_strict_host_image",
  "issue_initial_human_challenge",
  "observe_initial_human_challenge",
  "restart_agent",
  "observe_agent_restart",
  "verify_restarted_image_and_telegram",
  "issue_post_restart_human_challenge",
  "observe_post_restart_human_challenge",
  "audit_safe_diagnostics",
  "stop_agent_db_first",
  "observe_stop_intent",
  "observe_stop_stability",
  "verify_manual_rollback",
  "cleanup_workload",
  "observe_workload_absence",
  "cleanup_secrets",
  "observe_secrets_absence",
  "cleanup_firewall",
  "observe_firewall_absence",
  "cleanup_droplet",
  "observe_droplet_absence",
  "cleanup_runner",
  "observe_runner_absence",
];

export class HermesStagingAcceptancePersistenceError extends Error {
  constructor(cause?: unknown) {
    super("Hermes staging acceptance persistence failed.");
    this.name = "HermesStagingAcceptancePersistenceError";
    this.cause = cause;
  }
}

export async function beginHermesStagingAcceptanceRun(input: {
  db: HermesStagingAcceptanceDatabase;
  ownerUserId: string;
  idempotencyKey: string;
  expectedSourceRevision: string;
  expectedPublishWorkflowRunId: string;
  expectedImageDigest: string;
  deadlineAt: Date;
  cleanupDeadlineAt: Date;
  now: Date;
}): Promise<BeginHermesStagingAcceptanceResult> {
  if (
    !isUuid(input.ownerUserId) ||
    !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
    !SOURCE_REVISION_PATTERN.test(input.expectedSourceRevision) ||
    !WORKFLOW_RUN_ID_PATTERN.test(input.expectedPublishWorkflowRunId) ||
    !DIGEST_PATTERN.test(input.expectedImageDigest) ||
    !isValidDate(input.now) ||
    !isValidDate(input.deadlineAt) ||
    !isValidDate(input.cleanupDeadlineAt) ||
    input.deadlineAt.getTime() <= input.now.getTime() ||
    input.deadlineAt.getTime() - input.now.getTime() > HERMES_STAGING_MAX_DURATION_MS ||
    input.cleanupDeadlineAt.getTime() <= input.deadlineAt.getTime() ||
    input.cleanupDeadlineAt.getTime() - input.deadlineAt.getTime() >
      HERMES_STAGING_MAX_CLEANUP_DURATION_MS
  ) {
    throw new HermesStagingAcceptancePersistenceError(new Error("Invalid begin command."));
  }

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [inserted] = await input.db
        .insert(hermesStagingAcceptanceRuns)
        .values({
          id: randomUUID(),
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
        })
        .onConflictDoNothing()
        .returning();

      if (inserted) {
        return { run: inserted, disposition: "created" };
      }

      const [idempotent] = await input.db
        .select()
        .from(hermesStagingAcceptanceRuns)
        .where(eq(hermesStagingAcceptanceRuns.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (idempotent) {
        if (!sameBeginInput(idempotent, input)) {
          throw new Error("Idempotency key was already used for different immutable input.");
        }
        return { run: idempotent, disposition: "idempotent" };
      }

      const active = await readActiveHermesStagingAcceptanceRun({ db: input.db });
      if (active) {
        return { run: active, disposition: "active_exists" };
      }
    }
    throw new Error("Active-run conflict did not resolve to a durable row.");
  } catch (error) {
    if (error instanceof HermesStagingAcceptancePersistenceError) {
      throw error;
    }
    throw new HermesStagingAcceptancePersistenceError(error);
  }
}

export async function requestHermesStagingAcceptanceCleanup(input: {
  db: HermesStagingAcceptanceDatabase;
  runId: string;
  expectedGeneration: number;
  now: Date;
}): Promise<{ run: HermesStagingAcceptanceRun; changed: boolean } | null> {
  if (
    !isUuid(input.runId) ||
    !isCounter(input.expectedGeneration) ||
    input.expectedGeneration >= HERMES_STAGING_MAX_COUNTER ||
    !isValidDate(input.now)
  ) {
    throw new HermesStagingAcceptancePersistenceError(new Error("Invalid cleanup command."));
  }

  try {
    const [updated] = await input.db
      .update(hermesStagingAcceptanceRuns)
      .set({
        desiredOutcome: "cleanup",
        phase: sql`case
          when not ${hermesStagingAcceptanceRuns.workloadCleanupConfirmed} then 'cleaning_workload'::hermes_staging_acceptance_phase
          when not ${hermesStagingAcceptanceRuns.secretsCleanupConfirmed} then 'cleaning_secrets'::hermes_staging_acceptance_phase
          when not ${hermesStagingAcceptanceRuns.firewallCleanupConfirmed} then 'cleaning_firewall'::hermes_staging_acceptance_phase
          when not ${hermesStagingAcceptanceRuns.dropletCleanupConfirmed} then 'cleaning_droplet'::hermes_staging_acceptance_phase
          else 'cleaning_runner'::hermes_staging_acceptance_phase
        end`,
        state: "pending",
        terminalOutcome: sql`coalesce(${hermesStagingAcceptanceRuns.terminalOutcome}, 'cancelled')`,
        errorCode: sql`case
          when ${hermesStagingAcceptanceRuns.terminalOutcome} = 'succeeded' then null
          else coalesce(${hermesStagingAcceptanceRuns.errorCode}, 'acceptance_cancelled')
        end`,
        generation: sql`${hermesStagingAcceptanceRuns.generation} + 1`,
        attemptCount: 0,
        pendingEffect: null,
        nextAttemptAt: input.now,
        challengePurpose: null,
        stopStableSince: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(hermesStagingAcceptanceRuns.id, input.runId),
          eq(hermesStagingAcceptanceRuns.generation, input.expectedGeneration),
          notInArray(hermesStagingAcceptanceRuns.state, ["complete"]),
          sql`(${hermesStagingAcceptanceRuns.desiredOutcome} = 'acceptance' OR ${hermesStagingAcceptanceRuns.state} = 'blocked')`,
        ),
      )
      .returning();

    if (updated) {
      return { run: updated, changed: true };
    }
    const run = await readHermesStagingAcceptanceRun({ db: input.db, runId: input.runId });
    return run ? { run, changed: false } : null;
  } catch (error) {
    throw new HermesStagingAcceptancePersistenceError(error);
  }
}

export async function attestHermesStagingAcceptanceChallenge(input: {
  db: HermesStagingAcceptanceDatabase;
  runId: string;
  expectedGeneration: number;
  purpose: HermesStagingAcceptanceChallengePurpose;
  challengeDigest: string;
  attestationDigest: string;
  now: Date;
}): Promise<{ run: HermesStagingAcceptanceRun; accepted: boolean } | null> {
  if (
    !isUuid(input.runId) ||
    !isCounter(input.expectedGeneration) ||
    input.expectedGeneration >= HERMES_STAGING_MAX_COUNTER ||
    !HERMES_STAGING_ACCEPTANCE_CHALLENGE_PURPOSES.includes(input.purpose) ||
    !DIGEST_PATTERN.test(input.challengeDigest) ||
    !DIGEST_PATTERN.test(input.attestationDigest) ||
    input.challengeDigest === input.attestationDigest ||
    !isValidDate(input.now)
  ) {
    throw new HermesStagingAcceptancePersistenceError(new Error("Invalid attestation command."));
  }

  const initial = input.purpose === "initial";
  const expectedPhase = initial
    ? "awaiting_initial_human_proof"
    : "awaiting_post_restart_human_proof";
  const nextPhase = initial ? "restarting" : "auditing_diagnostics";
  const challengeColumn = initial
    ? hermesStagingAcceptanceRuns.initialChallengeDigest
    : hermesStagingAcceptanceRuns.postRestartChallengeDigest;
  const expiryColumn = initial
    ? hermesStagingAcceptanceRuns.initialChallengeExpiresAt
    : hermesStagingAcceptanceRuns.postRestartChallengeExpiresAt;
  const priorAttestationColumn = initial
    ? hermesStagingAcceptanceRuns.initialAttestationDigest
    : hermesStagingAcceptanceRuns.postRestartAttestationDigest;

  try {
    const [updated] = await input.db
      .update(hermesStagingAcceptanceRuns)
      .set(
        initial
          ? {
              phase: nextPhase,
              state: "pending" as const,
              generation: sql`${hermesStagingAcceptanceRuns.generation} + 1`,
              challengePurpose: null,
              initialAttestationDigest: input.attestationDigest,
              initialChallengeAttestedAt: input.now,
              initialHumanProofVerified: true,
              pendingEffect: null,
              attemptCount: 0,
              nextAttemptAt: input.now,
              updatedAt: input.now,
            }
          : {
              phase: nextPhase,
              state: "pending" as const,
              generation: sql`${hermesStagingAcceptanceRuns.generation} + 1`,
              challengePurpose: null,
              postRestartAttestationDigest: input.attestationDigest,
              postRestartChallengeAttestedAt: input.now,
              postRestartHumanProofVerified: true,
              pendingEffect: null,
              attemptCount: 0,
              nextAttemptAt: input.now,
              updatedAt: input.now,
            },
      )
      .where(
        and(
          eq(hermesStagingAcceptanceRuns.id, input.runId),
          eq(hermesStagingAcceptanceRuns.generation, input.expectedGeneration),
          eq(hermesStagingAcceptanceRuns.desiredOutcome, "acceptance"),
          eq(hermesStagingAcceptanceRuns.phase, expectedPhase),
          eq(hermesStagingAcceptanceRuns.state, "waiting"),
          eq(hermesStagingAcceptanceRuns.challengePurpose, input.purpose),
          eq(challengeColumn, input.challengeDigest),
          sql`${expiryColumn} > ${input.now.toISOString()}`,
          sql`${priorAttestationColumn} is null`,
          initial
            ? sql`${hermesStagingAcceptanceRuns.postRestartAttestationDigest} is null`
            : sql`${hermesStagingAcceptanceRuns.initialAttestationDigest} is distinct from ${input.attestationDigest}`,
        ),
      )
      .returning();

    if (updated) {
      return { run: updated, accepted: true };
    }
    const run = await readHermesStagingAcceptanceRun({ db: input.db, runId: input.runId });
    return run ? { run, accepted: false } : null;
  } catch (error) {
    throw new HermesStagingAcceptancePersistenceError(error);
  }
}

export async function claimNextHermesStagingAcceptanceRun(input: {
  db: HermesStagingAcceptanceDatabase;
  target: HermesStagingAcceptanceClaimTarget;
  leaseOwner: string;
  now: Date;
}): Promise<ClaimedHermesStagingAcceptanceRun | null> {
  if (
    !LEASE_OWNER_PATTERN.test(input.leaseOwner) ||
    !isValidDate(input.now) ||
    (input.target.kind === "run" && !isUuid(input.target.runId))
  ) {
    throw new HermesStagingAcceptancePersistenceError(new Error("Invalid claim command."));
  }

  const nowIso = input.now.toISOString();
  const leaseExpiresAt = new Date(
    input.now.getTime() + HERMES_STAGING_ACCEPTANCE_LEASE_MS,
  ).toISOString();
  const targetSql =
    input.target.kind === "run"
      ? sql`and ${hermesStagingAcceptanceRuns.id} = ${input.target.runId}`
      : sql``;

  try {
    const [claimed] = await input.db.execute<Record<string, unknown>>(sql`
      with next_run as (
        select ${hermesStagingAcceptanceRuns.id}
        from ${hermesStagingAcceptanceRuns}
        where ${hermesStagingAcceptanceRuns.state} in ('pending', 'executing', 'waiting')
          and ${hermesStagingAcceptanceRuns.nextAttemptAt} <= ${nowIso}
          and (${hermesStagingAcceptanceRuns.leaseExpiresAt} is null or ${hermesStagingAcceptanceRuns.leaseExpiresAt} <= ${nowIso})
          and ${hermesStagingAcceptanceRuns.leaseAttempt} < ${HERMES_STAGING_ACCEPTANCE_MAX_LEASE_ATTEMPTS}
          ${targetSql}
        order by ${hermesStagingAcceptanceRuns.nextAttemptAt}, ${hermesStagingAcceptanceRuns.createdAt}, ${hermesStagingAcceptanceRuns.id}
        for update of ${hermesStagingAcceptanceRuns} skip locked
        limit 1
      )
      update ${hermesStagingAcceptanceRuns}
      set state = 'executing',
          lease_owner = ${input.leaseOwner},
          lease_expires_at = ${leaseExpiresAt},
          lease_attempt = ${hermesStagingAcceptanceRuns.leaseAttempt} + 1,
          updated_at = ${nowIso}
      from next_run
      where ${hermesStagingAcceptanceRuns.id} = next_run.id
      returning ${hermesStagingAcceptanceRunProjection()}
    `);
    return claimed ? hydrateClaimedRun(claimed) : null;
  } catch (error) {
    throw new HermesStagingAcceptancePersistenceError(error);
  }
}

export async function persistClaimedHermesStagingAcceptanceDecision(input: {
  db: HermesStagingAcceptanceDatabase;
  claim: ClaimedHermesStagingAcceptanceRun;
  now: Date;
  workflowState: HermesStagingAcceptanceWorkflowState;
}): Promise<ClaimedHermesStagingAcceptanceRun | null> {
  const { claim, workflowState, now } = input;
  if (
    !validClaimIdentity(claim, now) ||
    claim.generation >= HERMES_STAGING_MAX_COUNTER ||
    workflowState.generation !== claim.generation ||
    workflowState.deadlineAtMs !== claim.deadlineAt.getTime() ||
    workflowState.cleanupDeadlineAtMs !== claim.cleanupDeadlineAt.getTime() ||
    !isCounter(workflowState.attemptCount) ||
    !HERMES_STAGING_ACCEPTANCE_PHASES.includes(workflowState.phase) ||
    workflowState.phase === "complete" ||
    workflowState.pendingEffect === null ||
    !PENDING_EFFECTS.includes(workflowState.pendingEffect) ||
    workflowState.nextAttemptAtMs === null ||
    !validWorkflowDates(workflowState) ||
    !validWorkflowDigests(workflowState) ||
    !workflowImmutableStateMatchesClaim(claim, workflowState) ||
    !cleanupStateMatchesClaim(claim, workflowState)
  ) {
    throw new HermesStagingAcceptancePersistenceError(new Error("Invalid claimed decision."));
  }

  try {
    const [updated] = await input.db
      .update(hermesStagingAcceptanceRuns)
      .set({
        desiredOutcome: workflowState.desiredOutcome,
        phase: workflowState.phase,
        terminalOutcome: workflowState.terminalOutcome,
        generation: claim.generation + 1,
        attemptCount: workflowState.attemptCount,
        pendingEffect: workflowState.pendingEffect,
        deploymentStageIndex: workflowState.deploymentStageIndex,
        errorCode: workflowState.errorCode,
        nextAttemptAt: new Date(workflowState.nextAttemptAtMs),
        challengePurpose: challengePurposeForWorkflow(workflowState),
        stopStableSince: toOptionalDate(workflowState.stopStableSinceMs),
        updatedAt: now,
      })
      .where(
        and(
          eq(hermesStagingAcceptanceRuns.id, claim.id),
          eq(hermesStagingAcceptanceRuns.generation, claim.generation),
          eq(hermesStagingAcceptanceRuns.attemptCount, claim.attemptCount),
          eq(hermesStagingAcceptanceRuns.leaseAttempt, claim.leaseAttempt),
          eq(hermesStagingAcceptanceRuns.desiredOutcome, claim.desiredOutcome),
          eq(hermesStagingAcceptanceRuns.phase, claim.phase),
          sql`${hermesStagingAcceptanceRuns.pendingEffect} is not distinct from ${claim.pendingEffect}`,
          eq(hermesStagingAcceptanceRuns.state, "executing"),
          eq(hermesStagingAcceptanceRuns.leaseOwner, claim.leaseOwner),
          sql`${hermesStagingAcceptanceRuns.leaseExpiresAt} > ${now.toISOString()}`,
        ),
      )
      .returning();
    return updated ? (updated as ClaimedHermesStagingAcceptanceRun) : null;
  } catch (error) {
    throw new HermesStagingAcceptancePersistenceError(error);
  }
}

export async function applyClaimedHermesStagingAcceptanceResult(input: {
  db: HermesStagingAcceptanceDatabase;
  claim: ClaimedHermesStagingAcceptanceRun;
  now: Date;
  mutation: HermesStagingAcceptanceResultMutation;
}): Promise<boolean> {
  if (!validateClaimedResult(input)) {
    throw new HermesStagingAcceptancePersistenceError(new Error("Invalid claimed result."));
  }

  const workflow = input.mutation.workflowState;
  const evidence = input.mutation.evidence ?? {};
  const nextAttemptAt = toOptionalDate(workflow.nextAttemptAtMs);
  const update: Partial<typeof hermesStagingAcceptanceRuns.$inferInsert> = {
    desiredOutcome: workflow.desiredOutcome,
    phase: workflow.phase,
    state: input.mutation.queueState,
    terminalOutcome: workflow.terminalOutcome,
    generation: input.claim.generation + 1,
    attemptCount: workflow.attemptCount,
    pendingEffect: workflow.pendingEffect,
    deploymentStageIndex: workflow.deploymentStageIndex,
    errorCode: workflow.errorCode,
    nextAttemptAt,
    leaseOwner: null,
    leaseExpiresAt: null,
    challengePurpose: challengePurposeForWorkflow(workflow),
    initialChallengeDigest: workflow.initialChallengeDigest,
    initialChallengeExpiresAt: toOptionalDate(workflow.initialChallengeExpiresAtMs),
    initialAttestationDigest: workflow.initialAttestationDigest,
    postRestartChallengeDigest: workflow.postRestartChallengeDigest,
    postRestartChallengeExpiresAt: toOptionalDate(workflow.postRestartChallengeExpiresAtMs),
    postRestartAttestationDigest: workflow.postRestartAttestationDigest,
    stopStableSince: toOptionalDate(workflow.stopStableSinceMs),
    observedImageDigest: evidence.observedImageDigest,
    agentId: evidence.agentId,
    deploymentId: evidence.deploymentId,
    runnerId: evidence.runnerId,
    providerResourceId: evidence.providerResourceId,
    providerFirewallId: evidence.providerFirewallId,
    initialChallengeAttestedAt: evidence.initialChallengeAttestedAt,
    postRestartChallengeAttestedAt: evidence.postRestartChallengeAttestedAt,
    publishedImageVerified: evidence.publishedImageVerifiedAt === undefined ? undefined : true,
    publishedImageVerifiedAt: evidence.publishedImageVerifiedAt,
    hostImageVerified: evidence.hostImageVerifiedAt === undefined ? undefined : true,
    hostImageVerifiedAt: evidence.hostImageVerifiedAt,
    agentReadyVerified: evidence.agentReadyVerifiedAt === undefined ? undefined : true,
    agentReadyVerifiedAt: evidence.agentReadyVerifiedAt,
    initialHumanProofVerified: workflow.initialAttestationDigest === null ? undefined : true,
    restartRequested: evidence.restartRequestedAt === undefined ? undefined : true,
    restartRequestedAt: evidence.restartRequestedAt,
    restartVerified: evidence.restartVerifiedAt === undefined ? undefined : true,
    restartVerifiedAt: evidence.restartVerifiedAt,
    restartedRuntimeVerified: evidence.restartedRuntimeVerifiedAt === undefined ? undefined : true,
    restartedRuntimeVerifiedAt: evidence.restartedRuntimeVerifiedAt,
    postRestartHumanProofVerified:
      workflow.postRestartAttestationDigest === null ? undefined : true,
    diagnosticsRedactedConfirmed:
      evidence.diagnosticsRedactedConfirmedAt === undefined ? undefined : true,
    diagnosticsRedactedConfirmedAt: evidence.diagnosticsRedactedConfirmedAt,
    stopVerified: evidence.stopVerifiedAt === undefined ? undefined : true,
    stopVerifiedAt: evidence.stopVerifiedAt,
    rollbackVerified: evidence.rollbackVerifiedAt === undefined ? undefined : true,
    rollbackVerifiedAt: evidence.rollbackVerifiedAt,
    workloadCleanupConfirmed: workflow.cleanupConfirmed.workload,
    workloadCleanupConfirmedAt: evidence.workloadCleanupConfirmedAt,
    secretsCleanupConfirmed: workflow.cleanupConfirmed.secrets,
    secretsCleanupConfirmedAt: evidence.secretsCleanupConfirmedAt,
    firewallCleanupConfirmed: workflow.cleanupConfirmed.firewall,
    firewallCleanupConfirmedAt: evidence.firewallCleanupConfirmedAt,
    dropletCleanupConfirmed: workflow.cleanupConfirmed.droplet,
    dropletCleanupConfirmedAt: evidence.dropletCleanupConfirmedAt,
    runnerCleanupConfirmed: workflow.cleanupConfirmed.runner,
    runnerCleanupConfirmedAt: evidence.runnerCleanupConfirmedAt,
    completedAt: input.mutation.completedAt,
    updatedAt: input.now,
  };

  try {
    const [updated] = await input.db
      .update(hermesStagingAcceptanceRuns)
      .set(update)
      .where(
        and(
          eq(hermesStagingAcceptanceRuns.id, input.claim.id),
          eq(hermesStagingAcceptanceRuns.generation, input.claim.generation),
          eq(hermesStagingAcceptanceRuns.attemptCount, input.claim.attemptCount),
          eq(hermesStagingAcceptanceRuns.leaseAttempt, input.claim.leaseAttempt),
          eq(hermesStagingAcceptanceRuns.desiredOutcome, input.claim.desiredOutcome),
          eq(hermesStagingAcceptanceRuns.phase, input.claim.phase),
          sql`${hermesStagingAcceptanceRuns.pendingEffect} is not distinct from ${input.claim.pendingEffect}`,
          eq(hermesStagingAcceptanceRuns.state, "executing"),
          eq(hermesStagingAcceptanceRuns.expectedImageDigest, input.claim.expectedImageDigest),
          eq(hermesStagingAcceptanceRuns.leaseOwner, input.claim.leaseOwner),
          sql`${hermesStagingAcceptanceRuns.leaseExpiresAt} > ${input.now.toISOString()}`,
          ...immutableMutationConditions(workflow, evidence),
        ),
      )
      .returning({ id: hermesStagingAcceptanceRuns.id });
    return updated !== undefined;
  } catch (error) {
    throw new HermesStagingAcceptancePersistenceError(error);
  }
}

export async function readHermesStagingAcceptanceRun(input: {
  db: HermesStagingAcceptanceDatabase;
  runId: string;
}): Promise<HermesStagingAcceptanceRun | null> {
  if (!isUuid(input.runId)) {
    throw new HermesStagingAcceptancePersistenceError(new Error("Invalid run identifier."));
  }
  try {
    const [run] = await input.db
      .select()
      .from(hermesStagingAcceptanceRuns)
      .where(eq(hermesStagingAcceptanceRuns.id, input.runId))
      .limit(1);
    return run ?? null;
  } catch (error) {
    throw new HermesStagingAcceptancePersistenceError(error);
  }
}

export async function readActiveHermesStagingAcceptanceRun(input: {
  db: HermesStagingAcceptanceDatabase;
}): Promise<HermesStagingAcceptanceRun | null> {
  try {
    const [run] = await input.db
      .select()
      .from(hermesStagingAcceptanceRuns)
      .where(notInArray(hermesStagingAcceptanceRuns.state, ["complete"]))
      .orderBy(asc(hermesStagingAcceptanceRuns.createdAt), asc(hermesStagingAcceptanceRuns.id))
      .limit(1);
    return run ?? null;
  } catch (error) {
    throw new HermesStagingAcceptancePersistenceError(error);
  }
}

export function toHermesStagingAcceptanceWorkflowState(
  run: HermesStagingAcceptanceRun,
): HermesStagingAcceptanceWorkflowState {
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

function validateClaimedResult(input: {
  claim: ClaimedHermesStagingAcceptanceRun;
  now: Date;
  mutation: HermesStagingAcceptanceResultMutation;
}): boolean {
  const { claim, mutation, now } = input;
  const workflow = mutation.workflowState;
  const evidence = mutation.evidence ?? {};
  if (
    !isUuid(claim.id) ||
    claim.state !== "executing" ||
    !LEASE_OWNER_PATTERN.test(claim.leaseOwner) ||
    !isValidDate(claim.leaseExpiresAt) ||
    !isValidDate(now) ||
    workflow.generation !== claim.generation ||
    claim.generation >= HERMES_STAGING_MAX_COUNTER ||
    workflow.deadlineAtMs !== claim.deadlineAt.getTime() ||
    workflow.cleanupDeadlineAtMs !== claim.cleanupDeadlineAt.getTime() ||
    !isCounter(workflow.generation) ||
    !isCounter(workflow.attemptCount) ||
    !HERMES_STAGING_ACCEPTANCE_PHASES.includes(workflow.phase) ||
    (workflow.errorCode !== null &&
      !HERMES_STAGING_ACCEPTANCE_ERROR_CODES.includes(workflow.errorCode)) ||
    (workflow.pendingEffect !== null && !PENDING_EFFECTS.includes(workflow.pendingEffect)) ||
    workflow.deploymentStageIndex < -1 ||
    workflow.deploymentStageIndex > 6 ||
    !Number.isInteger(workflow.deploymentStageIndex)
  ) {
    return false;
  }

  const complete = mutation.queueState === "complete";
  const scheduled = mutation.queueState === "pending" || mutation.queueState === "waiting";
  if (
    (complete &&
      (workflow.phase !== "complete" ||
        workflow.desiredOutcome !== "cleanup" ||
        workflow.terminalOutcome === null ||
        workflow.nextAttemptAtMs !== null ||
        workflow.pendingEffect !== null ||
        mutation.completedAt === undefined ||
        !Object.values(workflow.cleanupConfirmed).every(Boolean))) ||
    (!complete && (workflow.phase === "complete" || mutation.completedAt !== undefined)) ||
    (scheduled && workflow.nextAttemptAtMs === null) ||
    (mutation.queueState === "blocked" && workflow.nextAttemptAtMs !== null)
  ) {
    return false;
  }

  if (
    !validWorkflowDigests(workflow) ||
    !validWorkflowDates(workflow) ||
    !validEvidence(evidence, now) ||
    !cleanupEvidenceCanRepresentState(claim, workflow, evidence) ||
    (workflow.phase === "awaiting_initial_human_proof" &&
      workflow.initialChallengeDigest === null) ||
    (workflow.phase === "awaiting_post_restart_human_proof" &&
      workflow.postRestartChallengeDigest === null)
  ) {
    return false;
  }

  return (
    mutation.completedAt === undefined ||
    (isValidDate(mutation.completedAt) && mutation.completedAt.getTime() <= now.getTime())
  );
}

function validClaimIdentity(claim: ClaimedHermesStagingAcceptanceRun, now: Date): boolean {
  return (
    isUuid(claim.id) &&
    claim.state === "executing" &&
    LEASE_OWNER_PATTERN.test(claim.leaseOwner) &&
    isValidDate(claim.leaseExpiresAt) &&
    isValidDate(now) &&
    isCounter(claim.generation) &&
    isCounter(claim.attemptCount) &&
    isCounter(claim.leaseAttempt)
  );
}

function hydrateClaimedRun(row: Record<string, unknown>): ClaimedHermesStagingAcceptanceRun {
  const hydrated = { ...row };
  for (const key of [
    "nextAttemptAt",
    "leaseExpiresAt",
    "deadlineAt",
    "cleanupDeadlineAt",
    "initialChallengeExpiresAt",
    "initialChallengeAttestedAt",
    "postRestartChallengeExpiresAt",
    "postRestartChallengeAttestedAt",
    "stopStableSince",
    "publishedImageVerifiedAt",
    "hostImageVerifiedAt",
    "agentReadyVerifiedAt",
    "restartRequestedAt",
    "restartVerifiedAt",
    "restartedRuntimeVerifiedAt",
    "diagnosticsRedactedConfirmedAt",
    "stopVerifiedAt",
    "rollbackVerifiedAt",
    "workloadCleanupConfirmedAt",
    "secretsCleanupConfirmedAt",
    "firewallCleanupConfirmedAt",
    "dropletCleanupConfirmedAt",
    "runnerCleanupConfirmedAt",
    "createdAt",
    "updatedAt",
    "completedAt",
  ] as const) {
    const value = hydrated[key];
    hydrated[key] = value === null || value === undefined ? null : new Date(String(value));
  }
  return hydrated as ClaimedHermesStagingAcceptanceRun;
}

function workflowImmutableStateMatchesClaim(
  claim: ClaimedHermesStagingAcceptanceRun,
  workflow: HermesStagingAcceptanceWorkflowState,
): boolean {
  return (
    workflow.initialChallengeDigest === claim.initialChallengeDigest &&
    workflow.initialChallengeExpiresAtMs === (claim.initialChallengeExpiresAt?.getTime() ?? null) &&
    workflow.initialAttestationDigest === claim.initialAttestationDigest &&
    workflow.postRestartChallengeDigest === claim.postRestartChallengeDigest &&
    workflow.postRestartChallengeExpiresAtMs ===
      (claim.postRestartChallengeExpiresAt?.getTime() ?? null) &&
    workflow.postRestartAttestationDigest === claim.postRestartAttestationDigest
  );
}

function cleanupStateMatchesClaim(
  claim: ClaimedHermesStagingAcceptanceRun,
  workflow: HermesStagingAcceptanceWorkflowState,
): boolean {
  return (
    workflow.cleanupConfirmed.workload === claim.workloadCleanupConfirmed &&
    workflow.cleanupConfirmed.secrets === claim.secretsCleanupConfirmed &&
    workflow.cleanupConfirmed.firewall === claim.firewallCleanupConfirmed &&
    workflow.cleanupConfirmed.droplet === claim.dropletCleanupConfirmed &&
    workflow.cleanupConfirmed.runner === claim.runnerCleanupConfirmed
  );
}

function immutableMutationConditions(
  workflow: HermesStagingAcceptanceWorkflowState,
  evidence: HermesStagingAcceptanceEvidenceMutation,
) {
  const conditions = [];
  for (const [column, value] of [
    [hermesStagingAcceptanceRuns.observedImageDigest, evidence.observedImageDigest],
    [hermesStagingAcceptanceRuns.agentId, evidence.agentId],
    [hermesStagingAcceptanceRuns.deploymentId, evidence.deploymentId],
    [hermesStagingAcceptanceRuns.runnerId, evidence.runnerId],
    [hermesStagingAcceptanceRuns.providerResourceId, evidence.providerResourceId],
    [hermesStagingAcceptanceRuns.providerFirewallId, evidence.providerFirewallId],
    [hermesStagingAcceptanceRuns.initialChallengeDigest, workflow.initialChallengeDigest],
    [hermesStagingAcceptanceRuns.initialAttestationDigest, workflow.initialAttestationDigest],
    [hermesStagingAcceptanceRuns.postRestartChallengeDigest, workflow.postRestartChallengeDigest],
    [
      hermesStagingAcceptanceRuns.postRestartAttestationDigest,
      workflow.postRestartAttestationDigest,
    ],
  ] as const) {
    if (value !== undefined && value !== null) {
      conditions.push(sql`(${column} is null or ${column} = ${value})`);
    } else if (value === null) {
      conditions.push(sql`${column} is null`);
    }
  }
  for (const [column, value] of evidenceTimestampEntries(evidence)) {
    if (value !== undefined) {
      conditions.push(sql`(${column} is null or ${column} = ${value.toISOString()})`);
    }
  }
  for (const [column, value] of [
    [hermesStagingAcceptanceRuns.initialChallengeExpiresAt, workflow.initialChallengeExpiresAtMs],
    [
      hermesStagingAcceptanceRuns.postRestartChallengeExpiresAt,
      workflow.postRestartChallengeExpiresAtMs,
    ],
  ] as const) {
    if (value !== null) {
      conditions.push(sql`(${column} is null or ${column} = ${new Date(value).toISOString()})`);
    }
  }
  return conditions;
}

function hermesStagingAcceptanceRunProjection() {
  const table = hermesStagingAcceptanceRuns;
  return sql`
    ${table.id} as id, ${table.scopeKey} as "scopeKey", ${table.ownerUserId} as "ownerUserId",
    ${table.idempotencyKey} as "idempotencyKey", ${table.desiredOutcome} as "desiredOutcome",
    ${table.phase} as phase, ${table.state} as state, ${table.terminalOutcome} as "terminalOutcome",
    ${table.generation} as generation, ${table.attemptCount} as "attemptCount",
    ${table.leaseAttempt} as "leaseAttempt", ${table.pendingEffect} as "pendingEffect",
    ${table.deploymentStageIndex} as "deploymentStageIndex", ${table.errorCode} as "errorCode",
    ${table.nextAttemptAt} as "nextAttemptAt", ${table.leaseOwner} as "leaseOwner",
    ${table.leaseExpiresAt} as "leaseExpiresAt", ${table.deadlineAt} as "deadlineAt",
    ${table.cleanupDeadlineAt} as "cleanupDeadlineAt",
    ${table.expectedSourceRevision} as "expectedSourceRevision",
    ${table.expectedPublishWorkflowRunId} as "expectedPublishWorkflowRunId",
    ${table.expectedImageDigest} as "expectedImageDigest",
    ${table.observedImageDigest} as "observedImageDigest", ${table.agentId} as "agentId",
    ${table.deploymentId} as "deploymentId", ${table.runnerId} as "runnerId",
    ${table.providerResourceId} as "providerResourceId",
    ${table.providerFirewallId} as "providerFirewallId",
    ${table.challengePurpose} as "challengePurpose",
    ${table.initialChallengeDigest} as "initialChallengeDigest",
    ${table.initialChallengeExpiresAt} as "initialChallengeExpiresAt",
    ${table.initialAttestationDigest} as "initialAttestationDigest",
    ${table.initialChallengeAttestedAt} as "initialChallengeAttestedAt",
    ${table.postRestartChallengeDigest} as "postRestartChallengeDigest",
    ${table.postRestartChallengeExpiresAt} as "postRestartChallengeExpiresAt",
    ${table.postRestartAttestationDigest} as "postRestartAttestationDigest",
    ${table.postRestartChallengeAttestedAt} as "postRestartChallengeAttestedAt",
    ${table.stopStableSince} as "stopStableSince",
    ${table.publishedImageVerified} as "publishedImageVerified",
    ${table.publishedImageVerifiedAt} as "publishedImageVerifiedAt",
    ${table.hostImageVerified} as "hostImageVerified",
    ${table.hostImageVerifiedAt} as "hostImageVerifiedAt",
    ${table.agentReadyVerified} as "agentReadyVerified",
    ${table.agentReadyVerifiedAt} as "agentReadyVerifiedAt",
    ${table.initialHumanProofVerified} as "initialHumanProofVerified",
    ${table.restartRequested} as "restartRequested",
    ${table.restartRequestedAt} as "restartRequestedAt",
    ${table.restartVerified} as "restartVerified", ${table.restartVerifiedAt} as "restartVerifiedAt",
    ${table.restartedRuntimeVerified} as "restartedRuntimeVerified",
    ${table.restartedRuntimeVerifiedAt} as "restartedRuntimeVerifiedAt",
    ${table.postRestartHumanProofVerified} as "postRestartHumanProofVerified",
    ${table.diagnosticsRedactedConfirmed} as "diagnosticsRedactedConfirmed",
    ${table.diagnosticsRedactedConfirmedAt} as "diagnosticsRedactedConfirmedAt",
    ${table.stopVerified} as "stopVerified", ${table.stopVerifiedAt} as "stopVerifiedAt",
    ${table.rollbackVerified} as "rollbackVerified",
    ${table.rollbackVerifiedAt} as "rollbackVerifiedAt",
    ${table.workloadCleanupConfirmed} as "workloadCleanupConfirmed",
    ${table.workloadCleanupConfirmedAt} as "workloadCleanupConfirmedAt",
    ${table.secretsCleanupConfirmed} as "secretsCleanupConfirmed",
    ${table.secretsCleanupConfirmedAt} as "secretsCleanupConfirmedAt",
    ${table.firewallCleanupConfirmed} as "firewallCleanupConfirmed",
    ${table.firewallCleanupConfirmedAt} as "firewallCleanupConfirmedAt",
    ${table.dropletCleanupConfirmed} as "dropletCleanupConfirmed",
    ${table.dropletCleanupConfirmedAt} as "dropletCleanupConfirmedAt",
    ${table.runnerCleanupConfirmed} as "runnerCleanupConfirmed",
    ${table.runnerCleanupConfirmedAt} as "runnerCleanupConfirmedAt",
    ${table.createdAt} as "createdAt", ${table.updatedAt} as "updatedAt",
    ${table.completedAt} as "completedAt"
  `;
}

function challengePurposeForWorkflow(
  workflow: HermesStagingAcceptanceWorkflowState,
): HermesStagingAcceptanceChallengePurpose | null {
  if (
    workflow.phase === "awaiting_initial_human_proof" &&
    workflow.initialChallengeDigest !== null
  ) {
    return "initial";
  }
  if (
    workflow.phase === "awaiting_post_restart_human_proof" &&
    workflow.postRestartChallengeDigest !== null
  ) {
    return "post_restart";
  }
  return null;
}

function evidenceTimestampEntries(evidence: HermesStagingAcceptanceEvidenceMutation) {
  return [
    [hermesStagingAcceptanceRuns.initialChallengeAttestedAt, evidence.initialChallengeAttestedAt],
    [
      hermesStagingAcceptanceRuns.postRestartChallengeAttestedAt,
      evidence.postRestartChallengeAttestedAt,
    ],
    [hermesStagingAcceptanceRuns.publishedImageVerifiedAt, evidence.publishedImageVerifiedAt],
    [hermesStagingAcceptanceRuns.hostImageVerifiedAt, evidence.hostImageVerifiedAt],
    [hermesStagingAcceptanceRuns.agentReadyVerifiedAt, evidence.agentReadyVerifiedAt],
    [hermesStagingAcceptanceRuns.restartRequestedAt, evidence.restartRequestedAt],
    [hermesStagingAcceptanceRuns.restartVerifiedAt, evidence.restartVerifiedAt],
    [hermesStagingAcceptanceRuns.restartedRuntimeVerifiedAt, evidence.restartedRuntimeVerifiedAt],
    [
      hermesStagingAcceptanceRuns.diagnosticsRedactedConfirmedAt,
      evidence.diagnosticsRedactedConfirmedAt,
    ],
    [hermesStagingAcceptanceRuns.stopVerifiedAt, evidence.stopVerifiedAt],
    [hermesStagingAcceptanceRuns.rollbackVerifiedAt, evidence.rollbackVerifiedAt],
    [hermesStagingAcceptanceRuns.workloadCleanupConfirmedAt, evidence.workloadCleanupConfirmedAt],
    [hermesStagingAcceptanceRuns.secretsCleanupConfirmedAt, evidence.secretsCleanupConfirmedAt],
    [hermesStagingAcceptanceRuns.firewallCleanupConfirmedAt, evidence.firewallCleanupConfirmedAt],
    [hermesStagingAcceptanceRuns.dropletCleanupConfirmedAt, evidence.dropletCleanupConfirmedAt],
    [hermesStagingAcceptanceRuns.runnerCleanupConfirmedAt, evidence.runnerCleanupConfirmedAt],
  ] as const;
}

function validWorkflowDigests(workflow: HermesStagingAcceptanceWorkflowState): boolean {
  const values = [
    workflow.initialChallengeDigest,
    workflow.initialAttestationDigest,
    workflow.postRestartChallengeDigest,
    workflow.postRestartAttestationDigest,
  ];
  if (!values.every((value) => value === null || DIGEST_PATTERN.test(value))) return false;
  if (
    (workflow.initialChallengeDigest === null) !==
      (workflow.initialChallengeExpiresAtMs === null) ||
    (workflow.initialAttestationDigest !== null && workflow.initialChallengeDigest === null) ||
    (workflow.postRestartChallengeDigest === null) !==
      (workflow.postRestartChallengeExpiresAtMs === null) ||
    (workflow.postRestartAttestationDigest !== null && workflow.postRestartChallengeDigest === null)
  ) {
    return false;
  }
  return !(
    (workflow.initialAttestationDigest !== null &&
      workflow.initialAttestationDigest === workflow.initialChallengeDigest) ||
    (workflow.postRestartChallengeDigest !== null &&
      workflow.postRestartChallengeDigest === workflow.initialChallengeDigest) ||
    (workflow.postRestartAttestationDigest !== null &&
      (workflow.postRestartAttestationDigest === workflow.postRestartChallengeDigest ||
        workflow.postRestartAttestationDigest === workflow.initialAttestationDigest))
  );
}

function validWorkflowDates(workflow: HermesStagingAcceptanceWorkflowState): boolean {
  return [
    workflow.deadlineAtMs,
    workflow.cleanupDeadlineAtMs,
    workflow.nextAttemptAtMs,
    workflow.initialChallengeExpiresAtMs,
    workflow.postRestartChallengeExpiresAtMs,
    workflow.stopStableSinceMs,
  ].every((value) => value === null || (Number.isSafeInteger(value) && value >= 0));
}

function validEvidence(evidence: HermesStagingAcceptanceEvidenceMutation, now: Date): boolean {
  return (
    (evidence.observedImageDigest === undefined ||
      DIGEST_PATTERN.test(evidence.observedImageDigest)) &&
    validOptionalUuid(evidence.agentId) &&
    validOptionalUuid(evidence.deploymentId) &&
    validOptionalUuid(evidence.runnerId) &&
    validOptionalLocator(evidence.providerResourceId) &&
    validOptionalLocator(evidence.providerFirewallId) &&
    evidenceTimestampEntries(evidence).every(
      ([, value]) =>
        value === undefined || (isValidDate(value) && value.getTime() <= now.getTime()),
    )
  );
}

function cleanupEvidenceCanRepresentState(
  claim: ClaimedHermesStagingAcceptanceRun,
  workflow: HermesStagingAcceptanceWorkflowState,
  evidence: HermesStagingAcceptanceEvidenceMutation,
): boolean {
  return (
    (workflow.initialAttestationDigest === null ||
      claim.initialHumanProofVerified ||
      evidence.initialChallengeAttestedAt !== undefined) &&
    (workflow.postRestartAttestationDigest === null ||
      claim.postRestartHumanProofVerified ||
      evidence.postRestartChallengeAttestedAt !== undefined) &&
    (!workflow.cleanupConfirmed.workload ||
      claim.workloadCleanupConfirmed ||
      evidence.workloadCleanupConfirmedAt !== undefined) &&
    (!workflow.cleanupConfirmed.secrets ||
      claim.secretsCleanupConfirmed ||
      evidence.secretsCleanupConfirmedAt !== undefined) &&
    (!workflow.cleanupConfirmed.firewall ||
      claim.firewallCleanupConfirmed ||
      evidence.firewallCleanupConfirmedAt !== undefined) &&
    (!workflow.cleanupConfirmed.droplet ||
      claim.dropletCleanupConfirmed ||
      evidence.dropletCleanupConfirmedAt !== undefined) &&
    (!workflow.cleanupConfirmed.runner ||
      claim.runnerCleanupConfirmed ||
      evidence.runnerCleanupConfirmedAt !== undefined) &&
    (!claim.workloadCleanupConfirmed || workflow.cleanupConfirmed.workload) &&
    (!claim.secretsCleanupConfirmed || workflow.cleanupConfirmed.secrets) &&
    (!claim.firewallCleanupConfirmed || workflow.cleanupConfirmed.firewall) &&
    (!claim.dropletCleanupConfirmed || workflow.cleanupConfirmed.droplet) &&
    (!claim.runnerCleanupConfirmed || workflow.cleanupConfirmed.runner)
  );
}

function sameBeginInput(
  run: HermesStagingAcceptanceRun,
  input: {
    ownerUserId: string;
    expectedSourceRevision: string;
    expectedPublishWorkflowRunId: string;
    expectedImageDigest: string;
    deadlineAt: Date;
    cleanupDeadlineAt: Date;
  },
): boolean {
  return (
    run.ownerUserId === input.ownerUserId &&
    run.expectedSourceRevision === input.expectedSourceRevision &&
    run.expectedPublishWorkflowRunId === input.expectedPublishWorkflowRunId &&
    run.expectedImageDigest === input.expectedImageDigest &&
    run.deadlineAt.getTime() === input.deadlineAt.getTime() &&
    run.cleanupDeadlineAt.getTime() === input.cleanupDeadlineAt.getTime()
  );
}

function toOptionalDate(value: number | null): Date | null {
  return value === null ? null : new Date(value);
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isCounter(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= HERMES_STAGING_MAX_COUNTER;
}

function isValidDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function validOptionalUuid(value: string | undefined): boolean {
  return value === undefined || isUuid(value);
}

function validOptionalLocator(value: string | undefined): boolean {
  return value === undefined || PROVIDER_LOCATOR_PATTERN.test(value);
}

export type {
  HermesStagingAcceptanceEffectKind,
  HermesStagingAcceptanceErrorCode,
  HermesStagingAcceptancePhase,
  HermesStagingAcceptanceTerminalOutcome,
  HermesStagingAcceptanceWorkflowState,
};
export { HERMES_STAGING_ACCEPTANCE_ERROR_CODES, HERMES_STAGING_ACCEPTANCE_PHASES };
