import "server-only";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { operatorPreparations, operatorRuntimes, operators, users } from "@/src/server/db/schema";
import type { FounderRecoveryArchiveDurableState } from "./recovery-archive-provider";

export type FounderRecoveryArchiveRestoreBoundary = {
  rebuild(state: FounderRecoveryArchiveDurableState): Promise<FounderRecoveryArchiveDurableState>;
};

/**
 * Rehearses restoration through Bruno's PostgreSQL tables and constraints. The
 * synthetic target always rolls back, so verification cannot mutate the live Operator.
 */
export class IsolatedFounderRecoveryArchiveRestoreBoundary
  implements FounderRecoveryArchiveRestoreBoundary
{
  constructor(
    private readonly dependencies: { createConnection?: () => DatabaseConnection } = {},
  ) {}

  async rebuild(
    state: FounderRecoveryArchiveDurableState,
  ): Promise<FounderRecoveryArchiveDurableState> {
    if (state.restoration.logicalOperatorId !== state.operator.id) {
      throw new Error("Recovery Archive logical Operator identity is invalid.");
    }
    const connection = this.dependencies.createConnection?.() ?? createDatabaseConnection();
    const ownsConnection = !this.dependencies.createConnection;
    const rollback = new Error("founder_recovery_archive_restore_rehearsal_complete");
    let rebuilt: FounderRecoveryArchiveDurableState | null = null;
    const syntheticUserId = randomUUID();
    const syntheticOperatorId = randomUUID();
    try {
      try {
        await connection.db.transaction(async (tx) => {
          const operatorCreatedAt = new Date(state.operator.createdAt);
          const timezoneConfirmedAt = new Date(state.preparation.timezoneConfirmedAt);
          await tx.insert(users).values({
            id: syntheticUserId,
            createdAt: operatorCreatedAt,
            updatedAt: operatorCreatedAt,
          });
          await tx.insert(operators).values({
            id: syntheticOperatorId,
            userId: syntheticUserId,
            status: "active",
            mailOfferDisposition: state.operator.mailOfferDisposition,
            externalActionPause: state.operator.externalActionPaused,
            externalActionPauseReason: state.operator.externalActionPauseReason,
            externalActionPausedAt: state.operator.externalActionPausedAt
              ? new Date(state.operator.externalActionPausedAt)
              : null,
            createdAt: operatorCreatedAt,
            updatedAt: operatorCreatedAt,
          });
          await tx.insert(operatorPreparations).values({
            operatorId: syntheticOperatorId,
            status: "ready",
            timezone: state.preparation.timezone,
            timezoneConfirmedAt,
            startedAt: operatorCreatedAt,
            completedAt: timezoneConfirmedAt,
            createdAt: operatorCreatedAt,
            updatedAt: timezoneConfirmedAt,
          });
          await tx.insert(operatorRuntimes).values({
            operatorId: syntheticOperatorId,
            status: "needs_attention",
            transportState: "failed",
            safetyState: "unknown",
            configRevision: state.runtime.configRevision,
            attemptCount: 0,
            recoveryMessage: "Reconnect providers after Recovery Archive restoration.",
            failureCode: "recovery_archive_restore",
            createdAt: operatorCreatedAt,
            updatedAt: timezoneConfirmedAt,
          });

          const [persistedOperator] = await tx
            .select()
            .from(operators)
            .where(eq(operators.id, syntheticOperatorId))
            .limit(1);
          const [persistedPreparation] = await tx
            .select()
            .from(operatorPreparations)
            .where(eq(operatorPreparations.operatorId, syntheticOperatorId))
            .limit(1);
          const [persistedRuntime] = await tx
            .select()
            .from(operatorRuntimes)
            .where(eq(operatorRuntimes.operatorId, syntheticOperatorId))
            .limit(1);
          if (
            !persistedOperator ||
            !persistedPreparation?.timezone ||
            !persistedPreparation.timezoneConfirmedAt ||
            !persistedRuntime?.configRevision
          ) {
            throw new Error("Recovery Archive did not rebuild a complete persisted Operator.");
          }
          if (
            persistedOperator.externalActionPauseReason !== null &&
            persistedOperator.externalActionPauseReason !==
              "recovery_archive_external_actions_paused"
          ) {
            throw new Error("Recovery Archive restored an invalid pause reason.");
          }
          rebuilt = {
            schemaVersion: 1,
            operator: {
              id: state.operator.id,
              createdAt: persistedOperator.createdAt.toISOString(),
              mailOfferDisposition: persistedOperator.mailOfferDisposition,
              externalActionPaused: persistedOperator.externalActionPause,
              externalActionPauseReason: persistedOperator.externalActionPauseReason,
              externalActionPausedAt:
                persistedOperator.externalActionPausedAt?.toISOString() ?? null,
            },
            preparation: {
              timezone: persistedPreparation.timezone,
              timezoneConfirmedAt: persistedPreparation.timezoneConfirmedAt.toISOString(),
            },
            runtime: { configRevision: persistedRuntime.configRevision },
            restoration: {
              logicalOperatorId: state.operator.id,
              providerReauthorizationRequired: true,
              reusableCredentials: [],
            },
          };
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      if (!rebuilt) throw new Error("Recovery Archive restore rehearsal did not complete.");
      return rebuilt;
    } finally {
      if (ownsConnection) await connection.close();
    }
  }
}
