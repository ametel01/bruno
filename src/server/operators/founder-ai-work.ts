import "server-only";

import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import { founderProductEntitlements, operators } from "@/src/server/db/schema";
import { founderProductEntitlementAuthorizesWork } from "@/src/server/founder-product-contract/entitlement";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";
import { ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY } from "@/src/server/operators/founder-ai-routing";

export type FounderAiWorkTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export const FOUNDER_AI_COMPATIBILITY_POLICY_VERSION =
  ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY.version;
export const FOUNDER_AI_WORK_PROVIDER = "openai" as const;

export type FounderAiRecoveryChoice = {
  kind: "reconnect" | "connect_provider" | "wait" | "upgrade";
  label: string;
  href: string | null;
};

export const FOUNDER_AI_RECOVERY_CHOICES: readonly FounderAiRecoveryChoice[] = [
  { kind: "reconnect", label: "Reconnect your AI account", href: "#connections" },
  { kind: "connect_provider", label: "Connect another released provider", href: "#connections" },
  { kind: "wait", label: "Wait for capacity", href: null },
  { kind: "upgrade", label: "Upgrade your AI plan", href: null },
];

export function buildFounderAiCheckpointIdentity(conversationId: string, sequence: number): string {
  return `bruno-ai-checkpoint-${conversationId}-${sequence}`;
}

export function buildFounderAiCompletionIdentity(workId: string): string {
  return `bruno-ai-completion-${workId}`;
}

export type FounderExternalActionPauseDto = {
  paused: boolean;
  reason: string | null;
  pausedAt: string | null;
};

export class FounderExternalActionPauseError extends Error {
  readonly code = "external_action_paused" as const;
  readonly status = 409 as const;

  constructor(reason: string) {
    super(reason);
    this.name = "FounderExternalActionPauseError";
  }
}

export async function getFounderExternalActionPauseForUser(
  userId: string,
  dependencies: { createConnection?: () => DatabaseConnection; now?: () => Date } = {},
): Promise<FounderExternalActionPauseDto> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      const operator = await selectOperator(tx, userId);
      if (!operator) return { paused: false, reason: null, pausedAt: null };
      const entitlement = await selectEntitlement(tx, userId);
      return projectEffectivePause(operator, entitlement, dependencies.now?.() ?? new Date());
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function setFounderExternalActionPauseForUser(
  userId: string,
  paused: boolean,
  dependencies: {
    createConnection?: () => DatabaseConnection;
    now?: () => Date;
    reason?: string;
  } = {},
): Promise<FounderExternalActionPauseDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  try {
    return await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const at = now();
      const reason = paused
        ? dependencies.reason?.trim() || "The Founder paused new external actions until reviewed."
        : null;
      const [saved] = await tx
        .update(operators)
        .set({
          externalActionPause: paused,
          externalActionPauseReason: reason,
          externalActionPausedAt: paused ? at : null,
          updatedAt: at,
        })
        .where(eq(operators.id, operator.id))
        .returning();
      return saved ? projectPause(saved) : { paused: false, reason: null, pausedAt: null };
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function assertFounderExternalActionsNotPaused(
  userId: string,
  dependencies: { createConnection?: () => DatabaseConnection; now?: () => Date } = {},
): Promise<void> {
  const pause = await getFounderExternalActionPauseForUser(userId, dependencies);
  if (pause.paused) {
    throw new FounderExternalActionPauseError(
      pause.reason ?? "New external actions are paused until the Founder resumes them.",
    );
  }
}

export async function assertFounderExternalActionsNotPausedInTransaction(
  tx: FounderAiWorkTransaction,
  operatorId: string,
  now = new Date(),
): Promise<void> {
  await lockOperator(tx, operatorId);
  const [operator] = await tx
    .select({
      externalActionPause: operators.externalActionPause,
      externalActionPauseReason: operators.externalActionPauseReason,
      externalActionPausedAt: operators.externalActionPausedAt,
      userId: operators.userId,
    })
    .from(operators)
    .where(and(eq(operators.id, operatorId), eq(operators.status, "active")))
    .limit(1);
  if (!operator) return;
  const entitlement = await selectEntitlement(tx, operator.userId);
  const pause = projectEffectivePause(operator, entitlement, now);
  if (pause.paused) {
    throw new FounderExternalActionPauseError(
      pause.reason ?? "New external actions are paused until the Founder resumes them.",
    );
  }
}

async function selectOperator(tx: FounderAiWorkTransaction, userId: string) {
  const [operator] = await tx
    .select()
    .from(operators)
    .where(and(eq(operators.userId, userId), eq(operators.status, "active")))
    .limit(1);
  return operator;
}

async function lockOperator(tx: FounderAiWorkTransaction, operatorId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:founder-external-action-pause:${operatorId}`}, 0))`,
  );
}

async function selectEntitlement(tx: FounderAiWorkTransaction, userId: string) {
  const [entitlement] = await tx
    .select({
      status: founderProductEntitlements.status,
      retirementDueAt: founderProductEntitlements.retirementDueAt,
      reconciledAt: founderProductEntitlements.reconciledAt,
    })
    .from(founderProductEntitlements)
    .where(eq(founderProductEntitlements.userId, userId))
    .limit(1);
  return entitlement;
}

function projectEffectivePause(
  operator: Pick<
    typeof operators.$inferSelect,
    "externalActionPause" | "externalActionPauseReason" | "externalActionPausedAt"
  >,
  entitlement:
    | Pick<
        typeof founderProductEntitlements.$inferSelect,
        "status" | "retirementDueAt" | "reconciledAt"
      >
    | undefined,
  now: Date,
): FounderExternalActionPauseDto {
  if (operator.externalActionPause) return projectPause(operator);
  if (!entitlement || founderProductEntitlementAuthorizesWork(entitlement, now)) {
    return { paused: false, reason: null, pausedAt: null };
  }
  const effectivePausedAt =
    entitlement.retirementDueAt && entitlement.retirementDueAt <= now
      ? entitlement.retirementDueAt
      : entitlement.reconciledAt;
  return {
    paused: true,
    reason: "Product Entitlement no longer authorizes external work.",
    pausedAt: effectivePausedAt.toISOString(),
  };
}

function projectPause(
  operator: Pick<
    typeof operators.$inferSelect,
    "externalActionPause" | "externalActionPauseReason" | "externalActionPausedAt"
  >,
): FounderExternalActionPauseDto {
  return {
    paused: operator.externalActionPause,
    reason: operator.externalActionPauseReason,
    pausedAt: operator.externalActionPausedAt?.toISOString() ?? null,
  };
}
