import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import { operatorPreparations, operatorRuntimes, operators } from "@/src/server/db/schema";

export type FounderProductContractTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export async function lockFounderProductContractLifecycleInTransaction(
  tx: FounderProductContractTransaction,
  userId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:founder-lifecycle:${userId}`}, 0))`,
  );
}

export async function requireActiveFounderOperatorAuthorityInTransaction(
  tx: FounderProductContractTransaction,
  userId: string,
): Promise<{ operatorId: string }> {
  await lockFounderProductContractLifecycleInTransaction(tx, userId);
  const [operator] = await tx
    .select({ id: operators.id })
    .from(operators)
    .where(and(eq(operators.userId, userId), eq(operators.status, "active")))
    .limit(1)
    .for("update");
  if (!operator) throw new Error("An active persisted Operator is required.");
  return { operatorId: operator.id };
}

export async function requireReadyFounderOperatorAuthorityInTransaction(
  tx: FounderProductContractTransaction,
  userId: string,
): Promise<{ operatorId: string; runtimeRevision: string }> {
  const { operatorId } = await requireActiveFounderOperatorAuthorityInTransaction(tx, userId);
  const [preparation] = await tx
    .select({
      status: operatorPreparations.status,
      timezone: operatorPreparations.timezone,
      timezoneConfirmedAt: operatorPreparations.timezoneConfirmedAt,
    })
    .from(operatorPreparations)
    .where(eq(operatorPreparations.operatorId, operatorId))
    .limit(1);
  if (
    preparation?.status !== "ready" ||
    !preparation.timezone ||
    !preparation.timezoneConfirmedAt
  ) {
    throw new Error("A ready persisted Operator preparation is required.");
  }
  const [runtime] = await tx
    .select({ configRevision: operatorRuntimes.configRevision })
    .from(operatorRuntimes)
    .where(and(eq(operatorRuntimes.operatorId, operatorId), eq(operatorRuntimes.status, "ready")))
    .orderBy(desc(operatorRuntimes.updatedAt))
    .limit(1);
  if (!runtime?.configRevision) {
    throw new Error("A ready persisted Operator runtime is required.");
  }
  return { operatorId, runtimeRevision: runtime.configRevision };
}
