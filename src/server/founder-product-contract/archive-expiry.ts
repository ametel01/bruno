import "server-only";

import { and, eq, isNull, lte } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { founderRecoveryArchives } from "@/src/server/db/schema";
import { expireFounderRecoveryArchivesForUser } from "./lifecycle";
import {
  createFounderRecoveryArchiveDeletionProvider,
  type FounderRecoveryArchiveDeletionProvider,
} from "./recovery-archive-provider";

export async function processFounderRecoveryArchiveExpiry(
  input: {
    now?: Date;
    provider?: FounderRecoveryArchiveDeletionProvider;
    createConnection?: () => DatabaseConnection;
  } = {},
): Promise<{ processedUsers: number; failedUsers: number }> {
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  const now = input.now ?? new Date();
  const provider = input.provider ?? createFounderRecoveryArchiveDeletionProvider();
  if (!provider) throw new Error("Recovery Archive object storage is not configured.");
  try {
    const dueUsers = await connection.db
      .selectDistinct({ userId: founderRecoveryArchives.userId })
      .from(founderRecoveryArchives)
      .where(
        and(
          eq(founderRecoveryArchives.status, "verified"),
          lte(founderRecoveryArchives.expiresAt, now),
          isNull(founderRecoveryArchives.deletedAt),
        ),
      );
    let processedUsers = 0;
    let failedUsers = 0;
    for (const { userId } of dueUsers) {
      try {
        await expireFounderRecoveryArchivesForUser(userId, now, provider, connection);
        processedUsers += 1;
      } catch {
        failedUsers += 1;
      }
    }
    if (failedUsers > 0) throw new Error("One or more Recovery Archive deletions failed.");
    return { processedUsers, failedUsers };
  } finally {
    if (ownsConnection) await connection.close();
  }
}
