import "server-only";

import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import {
  founderCheckoutCorrelations,
  operatorDeletionCommerceCancellations,
  operatorDeletionRequests,
  operators,
} from "@/src/server/db/schema";

type Transaction = Parameters<Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]>[0];

export type FounderAccountClosureCommerceFence = {
  requestId: string;
  operatorId: string;
};

export const FOUNDER_COMMERCE_WEBHOOK_INTAKE_PENDING_CODE = "webhook_intake_pending";

export async function lockFounderCommerceWebhookIntakeInTransaction(
  tx: Transaction,
  userId: string,
  mode: "intake" | "settlement",
): Promise<void> {
  const key = `bruno:commerce-webhook-intake:${userId}`;
  if (mode === "intake") {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`);
    return;
  }
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export async function getFounderAccountClosureCommerceFenceInTransaction(
  tx: Transaction,
  userId: string,
): Promise<FounderAccountClosureCommerceFence | null> {
  const [fence] = await tx
    .select({
      requestId: operatorDeletionRequests.id,
      operatorId: operatorDeletionRequests.operatorId,
    })
    .from(operatorDeletionRequests)
    .innerJoin(operators, eq(operators.id, operatorDeletionRequests.operatorId))
    .where(and(eq(operators.userId, userId), eq(operatorDeletionRequests.kind, "account_closure")))
    .limit(1);
  return fence ?? null;
}

export async function isFounderAccountClosureSubscriptionInTransaction(
  tx: Transaction,
  requestId: string,
  providerSubscriptionId: string,
): Promise<boolean> {
  const [cancellation] = await tx
    .select({ id: operatorDeletionCommerceCancellations.id })
    .from(operatorDeletionCommerceCancellations)
    .where(
      and(
        eq(operatorDeletionCommerceCancellations.requestId, requestId),
        eq(operatorDeletionCommerceCancellations.providerSubscriptionId, providerSubscriptionId),
      ),
    )
    .limit(1);
  return Boolean(cancellation);
}

export async function closePendingFounderCheckoutCorrelationsForAccountClosureInTransaction(
  tx: Transaction,
  userId: string,
  closedAt: Date,
): Promise<void> {
  await tx
    .update(founderCheckoutCorrelations)
    .set({ status: "closed", closedAt, closureReason: "account_closure" })
    .where(
      and(
        eq(founderCheckoutCorrelations.userId, userId),
        eq(founderCheckoutCorrelations.status, "pending"),
      ),
    );
}
