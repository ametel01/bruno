import "server-only";

import { and, eq, sql } from "drizzle-orm";
import type { DatabaseConnection } from "@/src/server/db/client";
import { founderRecoveryArchives, operatorPreparations, operators } from "@/src/server/db/schema";
import { requireOperationalEntitlement } from "./entitlement";
import type {
  FounderLifecycleProviderBoundary,
  FounderProductContractLifecycleAction,
} from "./lifecycle";

type ArchiveLifecycleInput = {
  action: FounderProductContractLifecycleAction;
  userId: string;
  now: Date;
};

export async function createDurableRecoveryArchive(
  input: ArchiveLifecycleInput,
  providers: FounderLifecycleProviderBoundary,
  connection: DatabaseConnection,
): Promise<string> {
  const intent = await connection.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:founder-lifecycle:${input.userId}`}, 0))`,
    );
    const [operator] = await tx
      .select({ id: operators.id })
      .from(operators)
      .where(and(eq(operators.userId, input.userId), eq(operators.status, "active")))
      .limit(1)
      .for("update");
    if (!operator) throw new Error("An active persisted Operator is required.");
    const [preparation] = await tx
      .select({ status: operatorPreparations.status })
      .from(operatorPreparations)
      .where(eq(operatorPreparations.operatorId, operator.id))
      .limit(1);
    if (preparation?.status !== "ready") {
      throw new Error("A ready persisted Operator preparation is required.");
    }
    if (input.action === "recovery_archive_lifecycle") {
      await requireOperationalEntitlement(tx, input.userId, input.now);
    }
    const [record] = await tx
      .insert(founderRecoveryArchives)
      .values({
        userId: input.userId,
        operatorId: operator.id,
        status: "pending",
        storageObjectKey: null,
        ciphertextDigest: null,
        recoveryCredentialDigest: null,
        restorableVerified: false,
        failureCode: null,
        observedAt: input.now,
        expiresAt: new Date(input.now.valueOf() + 30 * 24 * 60 * 60 * 1_000),
        createdAt: input.now,
      })
      .returning({ id: founderRecoveryArchives.id });
    if (!record) throw new Error("Recovery Archive intent was not persisted.");
    return { archiveId: record.id, operatorId: operator.id };
  });

  await fulfillRecoveryArchiveIntent(
    input,
    providers,
    connection,
    intent.archiveId,
    intent.operatorId,
    true,
  );
  return intent.archiveId;
}

export async function fulfillRecoveryArchiveIntent(
  input: Pick<ArchiveLifecycleInput, "userId" | "now">,
  providers: FounderLifecycleProviderBoundary,
  connection: DatabaseConnection,
  archiveId: string,
  operatorId: string,
  failClosed: boolean,
): Promise<void> {
  try {
    const archive = await providers.createRecoveryArchive({
      archiveIntentId: archiveId,
      userId: input.userId,
      operatorId,
      observedAt: input.now,
    });
    await connection.db
      .update(founderRecoveryArchives)
      .set({
        status: "verified",
        storageObjectKey: archive.storageObjectKey,
        ciphertextDigest: archive.ciphertextDigest,
        recoveryCredentialDigest: archive.recoveryCredentialDigest,
        restorableVerified: archive.restorableVerified,
        failureCode: null,
      })
      .where(eq(founderRecoveryArchives.id, archiveId));
  } catch (error) {
    await connection.db
      .update(founderRecoveryArchives)
      .set({
        status: "failed",
        recoveryCredentialDigest: null,
        restorableVerified: false,
        failureCode: "archive_create_failed",
      })
      .where(eq(founderRecoveryArchives.id, archiveId));
    if (failClosed) throw error;
  }
}
