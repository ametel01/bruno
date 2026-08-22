import "server-only";

import { and, eq, inArray, lte } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { founderExternalBetaInvitations } from "@/src/server/db/schema";
import {
  executeFounderInfrastructureRetirement,
  type FounderInfrastructureRetirementProvider,
} from "./infrastructure-retirement";
import { reconcileFounderExternalBetaExpiry } from "./external-beta-admission";

export async function reconcileFounderExternalBetaRetirements(input: {
  applicationRevision: string;
  now: Date;
  providers: FounderInfrastructureRetirementProvider;
  createConnection?: () => DatabaseConnection;
}): Promise<{ expired: number; retired: number; failed: number }> {
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  let expired = 0;
  let retired = 0;
  let failed = 0;
  try {
    const expiring = await connection.db
      .select({ userId: founderExternalBetaInvitations.participantUserId })
      .from(founderExternalBetaInvitations)
      .where(
        and(
          eq(founderExternalBetaInvitations.status, "admitted"),
          lte(founderExternalBetaInvitations.accessExpiresAt, input.now),
        ),
      );
    for (const membership of expiring) {
      if (!membership.userId) continue;
      if (
        await reconcileFounderExternalBetaExpiry(membership.userId, input.now, {
          createConnection: () => connection,
        })
      ) {
        expired += 1;
      }
    }
    const due = await connection.db
      .select({ userId: founderExternalBetaInvitations.participantUserId })
      .from(founderExternalBetaInvitations)
      .where(
        and(
          inArray(founderExternalBetaInvitations.status, ["expired", "withdrawn"]),
          lte(founderExternalBetaInvitations.withdrawnAt, input.now),
        ),
      );
    const dueExpired = await connection.db
      .select({ userId: founderExternalBetaInvitations.participantUserId })
      .from(founderExternalBetaInvitations)
      .where(
        and(
          eq(founderExternalBetaInvitations.status, "expired"),
          lte(founderExternalBetaInvitations.expiredAt, input.now),
        ),
      );
    const userIds = new Set(
      [...due, ...dueExpired].flatMap((membership) =>
        membership.userId ? [membership.userId] : [],
      ),
    );
    for (const userId of userIds) {
      try {
        await executeFounderInfrastructureRetirement(
          {
            action: "infrastructure_retirement",
            runId: `external-beta:${userId}`,
            userId,
            now: input.now,
          },
          { providers: input.providers, applicationRevision: input.applicationRevision },
          connection,
        );
        retired += 1;
      } catch {
        failed += 1;
      }
    }
    return { expired, retired, failed };
  } finally {
    if (ownsConnection) await connection.close();
  }
}
