import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { founderRecoveryArchives, founderReleaseDecisions } from "@/src/server/db/schema";
import { founderProductContractDigest } from "./digest";
import { createEncryptedFounderRecoveryArchiveProvider } from "./encrypted-recovery-archive-provider";
import { requireReadyFounderOperatorAuthorityInTransaction } from "./operator-authority";
import { createDurableRecoveryArchive } from "./recovery-archive";
import type { FounderRecoveryArchiveProvider } from "./recovery-archive-provider";

export type FounderOwnerPreviewAdmissionDependencies = {
  applicationRevision?: string;
  createConnection?: () => DatabaseConnection;
  createProvider?: () => FounderRecoveryArchiveProvider | null;
  now?: () => Date;
};

export async function admitFounderOperatorToOwnerPreview(
  userId: string,
  dependencies: FounderOwnerPreviewAdmissionDependencies = {},
): Promise<{ archiveId: string }> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  const applicationRevision =
    dependencies.applicationRevision ?? process.env.VERCEL_GIT_COMMIT_SHA?.trim() ?? "";
  if (!/^[a-f0-9]{40}$/.test(applicationRevision)) {
    throw new Error("Owner Preview application revision is unavailable.");
  }
  const provider = dependencies.createProvider
    ? dependencies.createProvider()
    : createEncryptedFounderRecoveryArchiveProvider();
  if (!provider) throw new Error("Recovery Archive provider is unavailable.");

  try {
    const archiveId = await createDurableRecoveryArchive(
      { action: "release_stage_admission", userId, now },
      provider,
      connection,
    );
    await connection.db.transaction(async (tx) => {
      const { operatorId, runtimeRevision } =
        await requireReadyFounderOperatorAuthorityInTransaction(tx, userId);
      const [archive] = await tx
        .select({ id: founderRecoveryArchives.id })
        .from(founderRecoveryArchives)
        .where(
          and(
            eq(founderRecoveryArchives.id, archiveId),
            eq(founderRecoveryArchives.userId, userId),
            eq(founderRecoveryArchives.status, "verified"),
            eq(founderRecoveryArchives.formatVersion, 1),
            eq(founderRecoveryArchives.restorableVerified, true),
          ),
        )
        .limit(1);
      if (!archive) throw new Error("A verified-restorable Recovery Archive is required.");
      const [existing] = await tx
        .select({ id: founderReleaseDecisions.id })
        .from(founderReleaseDecisions)
        .where(
          and(
            eq(founderReleaseDecisions.userId, userId),
            eq(founderReleaseDecisions.operatorId, operatorId),
            eq(founderReleaseDecisions.stage, "owner_preview"),
            eq(founderReleaseDecisions.outcome, "enter"),
            eq(founderReleaseDecisions.applicationRevision, applicationRevision),
            eq(founderReleaseDecisions.runtimeRevision, runtimeRevision),
          ),
        )
        .orderBy(desc(founderReleaseDecisions.decidedAt))
        .limit(1);
      if (existing) return;
      await tx.insert(founderReleaseDecisions).values({
        userId,
        operatorId,
        stage: "owner_preview",
        outcome: "enter",
        applicationRevision,
        runtimeRevision,
        capabilityManifest: ["recovery_archive_v1"],
        evidenceDigests: [founderProductContractDigest(`recovery-archive:${archiveId}`)],
        decidedAt: now,
        createdAt: now,
      });
    });
    return { archiveId };
  } finally {
    if (ownsConnection) await connection.close();
  }
}
