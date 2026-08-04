import "server-only";

import { and, eq, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  agentDeploymentReplacementBudgets,
  agentDeployments,
  agents,
  runnerReplacements,
  runners,
} from "@/src/server/db/schema";
import {
  isRunnerReplacementReason,
  isRunnerReplacementState,
  type RunnerReplacementAction,
  type RunnerReplacementReason,
  transitionRunnerReplacement,
} from "@/src/server/runners/runner-replacement-state";

type RunnerReplacementTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type RunnerReplacementDatabase =
  | PostgresJsDatabase<typeof schema>
  | RunnerReplacementTransaction;

export const RUNNER_REPLACEMENT_LEASE_MS = 90_000;
export const RUNNER_REPLACEMENT_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const MAX_DEPLOYMENT_REPLACEMENTS_PER_WINDOW = 2;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_KEY_PATTERN = /^agentbay-replace-[0-9a-f]{32}$/;
const LEASE_OWNER_PATTERN =
  /^runner-replacement:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_COUNTER = 2_147_483_647;
const BUDGET_EXHAUSTED_SUMMARY = "Automatic runner replacement budget was exhausted.";

export type RunnerReplacementRecord = typeof runnerReplacements.$inferSelect;

export type ClaimedRunnerReplacement = RunnerReplacementRecord & {
  leaseOwner: string;
  leaseExpiresAt: Date | string;
};

export type RunnerReplacementClaimTarget =
  | { kind: "global" }
  | { kind: "source"; sourceRunnerId: string }
  | { kind: "replacement"; replacementId: string };

export class RunnerReplacementPersistenceError extends Error {
  constructor(cause?: unknown) {
    super("Runner replacement persistence failed.");
    this.name = "RunnerReplacementPersistenceError";
    this.cause = cause;
  }
}

export async function createOrGetRunnerReplacement(input: {
  db: RunnerReplacementDatabase;
  sourceRunnerId: string;
  triggerDeploymentId: string | null;
  reason: RunnerReplacementReason;
  operationKey: string;
  now: Date;
}): Promise<{ created: boolean; replacement: RunnerReplacementRecord }> {
  if (!validateCreateInput(input)) {
    throw new RunnerReplacementPersistenceError(new Error("Invalid replacement creation input."));
  }

  try {
    const inserted = await input.db.execute<RunnerReplacementRecord>(sql`
      insert into ${runnerReplacements} (
        source_runner_id,
        trigger_deployment_id,
        reason,
        operation_key,
        next_attempt_at,
        started_at,
        created_at,
        updated_at
      )
      select
        ${runners.id},
        ${input.triggerDeploymentId},
        ${input.reason},
        ${input.operationKey},
        ${input.now.toISOString()},
        ${input.now.toISOString()},
        ${input.now.toISOString()},
        ${input.now.toISOString()}
      from ${runners}
      where ${runners.id} = ${input.sourceRunnerId}
        and ${runners.kind} = 'digitalocean'
        and ${runners.provider} = 'digitalocean'
        and ${runners.deletedAt} is null
        and (
          ${input.triggerDeploymentId}::uuid is null
          or exists (
            select 1
            from ${agentDeployments}
            inner join ${agents}
              on ${agents.id} = ${agentDeployments.agentId}
             and ${agents.userId} = ${agentDeployments.userId}
            where ${agentDeployments.id} = ${input.triggerDeploymentId}
              and ${agentDeployments.stage} <> 'failed'
              and ${agents.userId} = ${runners.userId}
              and ${agents.runnerId} = ${runners.id}
              and ${agents.deletedAt} is null
              and ${agents.desiredStatus} = 'running'
          )
        )
      on conflict do nothing
      returning ${runnerReplacementReturningFields()}
    `);

    if (inserted[0]) return { created: true, replacement: inserted[0] };

    const [existing] = await input.db
      .select()
      .from(runnerReplacements)
      .where(
        or(
          eq(runnerReplacements.operationKey, input.operationKey),
          and(
            eq(runnerReplacements.sourceRunnerId, input.sourceRunnerId),
            sql`${runnerReplacements.state} NOT IN ('complete', 'failed')`,
          ),
          ...(input.triggerDeploymentId
            ? [
                and(
                  eq(runnerReplacements.triggerDeploymentId, input.triggerDeploymentId),
                  sql`${runnerReplacements.state} NOT IN ('complete', 'failed')`,
                ),
              ]
            : []),
        ),
      )
      .orderBy(runnerReplacements.createdAt, runnerReplacements.id)
      .limit(1);

    if (!existing || existing.sourceRunnerId !== input.sourceRunnerId) {
      throw new Error("Replacement creation did not resolve to the requested source.");
    }
    return { created: false, replacement: existing };
  } catch (error) {
    if (error instanceof RunnerReplacementPersistenceError) throw error;
    throw new RunnerReplacementPersistenceError(error);
  }
}

export async function claimNextRunnerReplacement(input: {
  db: RunnerReplacementDatabase;
  target: RunnerReplacementClaimTarget;
  leaseOwner: string;
  now: Date;
}): Promise<ClaimedRunnerReplacement | null> {
  if (!validateClaimInput(input)) {
    throw new RunnerReplacementPersistenceError(new Error("Invalid replacement claim input."));
  }
  const targetSql =
    input.target.kind === "source"
      ? sql`and ${runnerReplacements.sourceRunnerId} = ${input.target.sourceRunnerId}`
      : input.target.kind === "replacement"
        ? sql`and ${runnerReplacements.id} = ${input.target.replacementId}`
        : sql``;
  const leaseExpiresAt = new Date(input.now.getTime() + RUNNER_REPLACEMENT_LEASE_MS);

  try {
    const [claimed] = await input.db.execute<ClaimedRunnerReplacement>(sql`
      with next_replacement as (
        select ${runnerReplacements.id}, ${runnerReplacements.generation}
        from ${runnerReplacements}
        inner join ${runners} as source_runner
          on source_runner.id = ${runnerReplacements.sourceRunnerId}
         and source_runner.deleted_at is null
        where ${runnerReplacements.state} not in ('complete', 'failed')
          and (
            ${runnerReplacements.nextAttemptAt} <= ${input.now.toISOString()}
            or ${runnerReplacements.leaseExpiresAt} <= ${input.now.toISOString()}
          )
          and (${runnerReplacements.leaseExpiresAt} is null or ${runnerReplacements.leaseExpiresAt} <= ${input.now.toISOString()})
          and ${runnerReplacements.attemptCount} < ${MAX_COUNTER}
          ${targetSql}
        order by ${runnerReplacements.nextAttemptAt}, ${runnerReplacements.createdAt}, ${runnerReplacements.id}
        for update of ${runnerReplacements} skip locked
        limit 1
      )
      update ${runnerReplacements}
      set lease_owner = ${input.leaseOwner},
          lease_expires_at = ${leaseExpiresAt.toISOString()},
          attempt_count = ${runnerReplacements.attemptCount} + 1,
          next_attempt_at = null,
          updated_at = ${input.now.toISOString()}
      from next_replacement
      where ${runnerReplacements.id} = next_replacement.id
        and ${runnerReplacements.generation} = next_replacement.generation
      returning ${runnerReplacementReturningFields()}
    `);
    return claimed ?? null;
  } catch (error) {
    throw new RunnerReplacementPersistenceError(error);
  }
}

export async function applyClaimedRunnerReplacementTransition(input: {
  db: RunnerReplacementDatabase;
  claim: ClaimedRunnerReplacement;
  action: RunnerReplacementAction;
  now: Date;
}): Promise<boolean> {
  if (!validateClaim(input.claim) || !isValidDate(input.now)) {
    throw new RunnerReplacementPersistenceError(new Error("Invalid replacement result input."));
  }
  const transition = transitionRunnerReplacement({
    current: input.claim,
    action: input.action,
    now: input.now,
  });
  if (!transition) {
    throw new RunnerReplacementPersistenceError(new Error("Invalid replacement transition."));
  }

  try {
    const [updated] = await input.db
      .update(runnerReplacements)
      .set({
        state: transition.state,
        generation: transition.generation,
        targetRunnerId: transition.targetRunnerId,
        nextAttemptAt: transition.nextAttemptAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        terminalCode: transition.terminalCode,
        terminalSummary: transition.terminalSummary,
        completedAt: transition.completedAt,
        failedAt: transition.failedAt,
        updatedAt: input.now,
      })
      .where(sql`
        ${runnerReplacements.id} = ${input.claim.id}
        and ${runnerReplacements.sourceRunnerId} = ${input.claim.sourceRunnerId}
        and ${runnerReplacements.generation} = ${input.claim.generation}
        and ${runnerReplacements.state} = ${input.claim.state}
        and ${runnerReplacements.targetRunnerId} is not distinct from ${input.claim.targetRunnerId}
        and ${runnerReplacements.leaseOwner} = ${input.claim.leaseOwner}
        and ${runnerReplacements.leaseExpiresAt} = ${dateIso(input.claim.leaseExpiresAt)}
        and ${runnerReplacements.leaseExpiresAt} > ${input.now.toISOString()}
        and exists (
          select 1 from ${runners}
          where ${runners.id} = ${input.claim.sourceRunnerId}
            and ${runners.deletedAt} is null
        )
        and (
          ${transition.targetRunnerId}::uuid is null
          or exists (
            select 1
            from runners as source_owner
            inner join runners as target_runner
              on target_runner.user_id = source_owner.user_id
            where source_owner.id = ${input.claim.sourceRunnerId}
              and target_runner.id = ${transition.targetRunnerId}
              and target_runner.kind = 'digitalocean'
              and target_runner.provider = 'digitalocean'
              and target_runner.deleted_at is null
          )
        )
      `)
      .returning({ id: runnerReplacements.id });
    return updated !== undefined;
  } catch (error) {
    throw new RunnerReplacementPersistenceError(error);
  }
}

export async function reserveClaimedRunnerReplacementBudget(input: {
  connection: DatabaseConnection;
  claim: ClaimedRunnerReplacement;
  now: Date;
}): Promise<{ reserved: boolean; replacementCount: number }> {
  if (!validateClaim(input.claim) || !input.claim.triggerDeploymentId || !isValidDate(input.now)) {
    throw new RunnerReplacementPersistenceError(new Error("Invalid replacement budget input."));
  }

  try {
    return await input.connection.db.transaction(async (tx) => {
      const [locked] = await tx.execute<{
        id: string;
        replacementCount: number;
      }>(sql`
        select
          ${runnerReplacements.id} as id,
          ${runnerReplacements.replacementCount} as "replacementCount"
        from ${runnerReplacements}
        where ${runnerReplacements.id} = ${input.claim.id}
          and ${runnerReplacements.generation} = ${input.claim.generation}
          and ${runnerReplacements.state} = ${input.claim.state}
          and ${runnerReplacements.leaseOwner} = ${input.claim.leaseOwner}
          and ${runnerReplacements.leaseExpiresAt} = ${dateIso(input.claim.leaseExpiresAt)}
          and ${runnerReplacements.leaseExpiresAt} > ${input.now.toISOString()}
        for update
      `);
      if (!locked) throw new Error("Replacement budget claim fence was lost.");

      const windowFloor = new Date(input.now.getTime() - RUNNER_REPLACEMENT_BUDGET_WINDOW_MS);
      const [budget] = await tx.execute<{
        replacementCount: number;
        windowStartedAt: Date | string;
      }>(sql`
        insert into ${agentDeploymentReplacementBudgets} (
          deployment_id, window_started_at, replacement_count, created_at, updated_at
        ) values (
          ${input.claim.triggerDeploymentId}, ${input.now.toISOString()}, 1,
          ${input.now.toISOString()}, ${input.now.toISOString()}
        )
        on conflict (deployment_id) do update
        set window_started_at = case
              when ${agentDeploymentReplacementBudgets.windowStartedAt} <= ${windowFloor.toISOString()}
                then excluded.window_started_at
              else ${agentDeploymentReplacementBudgets.windowStartedAt}
            end,
            replacement_count = case
              when ${agentDeploymentReplacementBudgets.windowStartedAt} <= ${windowFloor.toISOString()}
                then 1
              else ${agentDeploymentReplacementBudgets.replacementCount} + 1
            end,
            updated_at = excluded.updated_at
        where ${agentDeploymentReplacementBudgets.windowStartedAt} <= ${windowFloor.toISOString()}
           or ${agentDeploymentReplacementBudgets.replacementCount} < ${MAX_DEPLOYMENT_REPLACEMENTS_PER_WINDOW}
        returning
          ${agentDeploymentReplacementBudgets.replacementCount} as "replacementCount",
          ${agentDeploymentReplacementBudgets.windowStartedAt} as "windowStartedAt"
      `);

      if (!budget) {
        await failBudgetExhausted(tx, input.claim, input.now);
        return {
          reserved: false,
          replacementCount: MAX_DEPLOYMENT_REPLACEMENTS_PER_WINDOW,
        };
      }

      const [updated] = await tx
        .update(runnerReplacements)
        .set({
          replacementCount: budget.replacementCount,
          replacementWindowStartedAt: new Date(budget.windowStartedAt),
          updatedAt: input.now,
        })
        .where(
          and(
            eq(runnerReplacements.id, input.claim.id),
            eq(runnerReplacements.generation, input.claim.generation),
            eq(runnerReplacements.leaseOwner, input.claim.leaseOwner),
          ),
        )
        .returning({ id: runnerReplacements.id });
      if (!updated) throw new Error("Replacement budget workflow update lost its fence.");
      return { reserved: true, replacementCount: budget.replacementCount };
    });
  } catch (error) {
    throw new RunnerReplacementPersistenceError(error);
  }
}

async function failBudgetExhausted(
  tx: RunnerReplacementTransaction,
  claim: ClaimedRunnerReplacement,
  now: Date,
): Promise<void> {
  const [updated] = await tx
    .update(runnerReplacements)
    .set({
      state: "failed",
      generation: claim.generation + 1,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      terminalCode: "replacement_budget_exhausted",
      terminalSummary: BUDGET_EXHAUSTED_SUMMARY,
      failedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(runnerReplacements.id, claim.id),
        eq(runnerReplacements.generation, claim.generation),
        eq(runnerReplacements.leaseOwner, claim.leaseOwner),
      ),
    )
    .returning({ id: runnerReplacements.id });
  if (!updated) throw new Error("Replacement budget failure lost its fence.");
}

function validateCreateInput(input: {
  sourceRunnerId: string;
  triggerDeploymentId: string | null;
  reason: string;
  operationKey: string;
  now: Date;
}): boolean {
  return (
    UUID_PATTERN.test(input.sourceRunnerId) &&
    (input.triggerDeploymentId === null || UUID_PATTERN.test(input.triggerDeploymentId)) &&
    isRunnerReplacementReason(input.reason) &&
    (input.reason === "gateway_deadline" ? input.triggerDeploymentId !== null : true) &&
    OPERATION_KEY_PATTERN.test(input.operationKey) &&
    isValidDate(input.now)
  );
}

function validateClaimInput(input: {
  target: RunnerReplacementClaimTarget;
  leaseOwner: string;
  now: Date;
}): boolean {
  if (!LEASE_OWNER_PATTERN.test(input.leaseOwner) || !isValidDate(input.now)) return false;
  if (input.target.kind === "source") return UUID_PATTERN.test(input.target.sourceRunnerId);
  if (input.target.kind === "replacement") return UUID_PATTERN.test(input.target.replacementId);
  return input.target.kind === "global";
}

function validateClaim(claim: ClaimedRunnerReplacement): boolean {
  return (
    UUID_PATTERN.test(claim.id) &&
    UUID_PATTERN.test(claim.sourceRunnerId) &&
    (claim.targetRunnerId === null || UUID_PATTERN.test(claim.targetRunnerId)) &&
    (claim.triggerDeploymentId === null || UUID_PATTERN.test(claim.triggerDeploymentId)) &&
    isRunnerReplacementState(claim.state) &&
    claim.state !== "complete" &&
    claim.state !== "failed" &&
    Number.isInteger(claim.generation) &&
    claim.generation >= 0 &&
    claim.generation < MAX_COUNTER &&
    LEASE_OWNER_PATTERN.test(claim.leaseOwner) &&
    Boolean(dateIso(claim.leaseExpiresAt))
  );
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function dateIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RunnerReplacementPersistenceError(new Error("Invalid replacement timestamp."));
  }
  return date.toISOString();
}

function runnerReplacementReturningFields() {
  return sql`
    ${runnerReplacements.id} as id,
    ${runnerReplacements.sourceRunnerId} as "sourceRunnerId",
    ${runnerReplacements.targetRunnerId} as "targetRunnerId",
    ${runnerReplacements.triggerDeploymentId} as "triggerDeploymentId",
    ${runnerReplacements.reason} as reason,
    ${runnerReplacements.state} as state,
    ${runnerReplacements.operationKey} as "operationKey",
    ${runnerReplacements.generation} as generation,
    ${runnerReplacements.attemptCount} as "attemptCount",
    ${runnerReplacements.replacementCount} as "replacementCount",
    ${runnerReplacements.replacementWindowStartedAt} as "replacementWindowStartedAt",
    ${runnerReplacements.nextAttemptAt} as "nextAttemptAt",
    ${runnerReplacements.leaseOwner} as "leaseOwner",
    ${runnerReplacements.leaseExpiresAt} as "leaseExpiresAt",
    ${runnerReplacements.terminalCode} as "terminalCode",
    ${runnerReplacements.terminalSummary} as "terminalSummary",
    ${runnerReplacements.startedAt} as "startedAt",
    ${runnerReplacements.completedAt} as "completedAt",
    ${runnerReplacements.failedAt} as "failedAt",
    ${runnerReplacements.createdAt} as "createdAt",
    ${runnerReplacements.updatedAt} as "updatedAt"
  `;
}
