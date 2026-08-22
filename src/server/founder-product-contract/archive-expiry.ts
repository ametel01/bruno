import "server-only";

import { and, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { DatabaseConnection } from "@/src/server/db/client";
import {
  founderRecoveryArchiveDeletionReceipts,
  founderRecoveryArchives,
} from "@/src/server/db/schema";
import { founderProductContractDigest } from "./digest";
import type { FounderRecoveryArchiveDeletionProvider } from "./recovery-archive-provider";

export async function expireFounderRecoveryArchivesForUser(
  userId: string,
  now: Date,
  providers: FounderRecoveryArchiveDeletionProvider,
  connection: DatabaseConnection,
): Promise<number> {
  let deletedCount = 0;
  while (true) {
    const work = await connection.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:founder-lifecycle:${userId}`}, 0))`,
      );
      const [archive] = await tx
        .select({
          id: founderRecoveryArchives.id,
          status: founderRecoveryArchives.status,
          storageObjectKey: founderRecoveryArchives.storageObjectKey,
          recoveryCredentialObjectKey: founderRecoveryArchives.recoveryCredentialObjectKey,
        })
        .from(founderRecoveryArchives)
        .where(
          and(
            eq(founderRecoveryArchives.userId, userId),
            inArray(founderRecoveryArchives.status, ["pending", "verified", "failed"]),
            isNotNull(founderRecoveryArchives.storageObjectKey),
            lte(founderRecoveryArchives.expiresAt, now),
            isNull(founderRecoveryArchives.deletedAt),
          ),
        )
        .orderBy(founderRecoveryArchives.expiresAt)
        .limit(1)
        .for("update");
      if (!archive?.storageObjectKey) return null;
      const recoveryCredentialObjectKey =
        archive.recoveryCredentialObjectKey ?? archive.storageObjectKey.replace(/\.age$/, ".key");
      const idempotencyKey = founderProductContractDigest(`recovery-archive-delete:${archive.id}`);
      const [existingDeletion] = await tx
        .select({
          status: founderRecoveryArchiveDeletionReceipts.status,
          attemptedAt: founderRecoveryArchiveDeletionReceipts.attemptedAt,
          failureCode: founderRecoveryArchiveDeletionReceipts.failureCode,
        })
        .from(founderRecoveryArchiveDeletionReceipts)
        .where(eq(founderRecoveryArchiveDeletionReceipts.archiveId, archive.id))
        .limit(1)
        .for("update");
      if (
        existingDeletion?.status === "pending" &&
        existingDeletion.failureCode === null &&
        existingDeletion.attemptedAt > new Date(now.valueOf() - 5 * 60 * 1_000)
      ) {
        throw new Error("Recovery Archive deletion is already in progress.");
      }
      await tx
        .insert(founderRecoveryArchiveDeletionReceipts)
        .values({
          archiveId: archive.id,
          userId,
          idempotencyKey,
          status: "pending",
          archiveProviderConfirmed: false,
          recoveryCredentialsConfirmed: false,
          attemptedAt: now,
          completedAt: null,
          failureCode: null,
        })
        .onConflictDoUpdate({
          target: founderRecoveryArchiveDeletionReceipts.archiveId,
          set: {
            archiveProviderConfirmed: false,
            recoveryCredentialsConfirmed: false,
            attemptedAt: now,
            failureCode: null,
          },
        });
      return {
        archiveId: archive.id,
        archiveStatus: archive.status,
        storageObjectKey: archive.storageObjectKey,
        recoveryCredentialObjectKey,
        idempotencyKey,
      };
    });
    if (!work) return deletedCount;
    try {
      const deleted = await providers.deleteRecoveryArchive(work);
      if (!deleted.archiveAbsent || !deleted.recoveryCredentialsAbsent) {
        throw new Error("Recovery Archive and credential absence were not both confirmed.");
      }
      await connection.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:founder-lifecycle:${userId}`}, 0))`,
        );
        const [expiredArchive] = await tx
          .update(founderRecoveryArchives)
          .set({
            status: "deleted",
            storageObjectKey: null,
            recoveryCredentialObjectKey: null,
            recoveryCredentialDigest: null,
            restorableVerified: false,
            failureCode: null,
            deletedAt: now,
          })
          .where(
            and(
              eq(founderRecoveryArchives.id, work.archiveId),
              eq(founderRecoveryArchives.status, work.archiveStatus),
              isNull(founderRecoveryArchives.deletedAt),
            ),
          )
          .returning({ id: founderRecoveryArchives.id });
        if (!expiredArchive) {
          throw new Error("Recovery Archive changed while deletion was being verified.");
        }
        await tx
          .update(founderRecoveryArchiveDeletionReceipts)
          .set({
            status: "completed",
            archiveProviderConfirmed: true,
            recoveryCredentialsConfirmed: true,
            completedAt: now,
            failureCode: null,
          })
          .where(eq(founderRecoveryArchiveDeletionReceipts.archiveId, work.archiveId));
      });
      deletedCount += 1;
    } catch (error) {
      await connection.db
        .update(founderRecoveryArchiveDeletionReceipts)
        .set({ failureCode: "archive_delete_failed", attemptedAt: now })
        .where(eq(founderRecoveryArchiveDeletionReceipts.archiveId, work.archiveId));
      throw error;
    }
  }
}
