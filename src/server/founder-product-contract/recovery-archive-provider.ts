import "server-only";

import { createHash } from "node:crypto";
import {
  readBackupStorageConfig,
  S3CompatibleBackupObjectStorage,
} from "@/src/server/backups/backup-storage";

export type FounderRecoveryArchiveDeletionProvider = {
  deleteRecoveryArchive(input: {
    archiveId: string;
    storageObjectKey: string;
    idempotencyKey: string;
  }): Promise<{ absent: true }>;
};

export function createFounderRecoveryArchiveDeletionProvider(): FounderRecoveryArchiveDeletionProvider | null {
  const config = readBackupStorageConfig();
  if (!config) return null;
  const storage = new S3CompatibleBackupObjectStorage(config);
  return {
    async deleteRecoveryArchive({ archiveId, storageObjectKey, idempotencyKey }) {
      assertFounderRecoveryArchiveDeletionIdentity({
        archiveId,
        storageObjectKey,
        idempotencyKey,
      });
      const result = await storage.delete({ key: storageObjectKey });
      if (!result.ok || !result.absent) {
        throw new Error("Recovery Archive deletion was not confirmed by object storage.");
      }
      return { absent: true };
    },
  };
}

export function assertFounderRecoveryArchiveDeletionIdentity(input: {
  archiveId: string;
  storageObjectKey: string;
  idempotencyKey: string;
}): void {
  const expectedIdempotencyKey = `sha256:${createHash("sha256")
    .update(`recovery-archive-delete:${input.archiveId}`)
    .digest("hex")}`;
  const keyParts = input.storageObjectKey.split("/");
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      input.archiveId,
    ) ||
    keyParts.length !== 3 ||
    keyParts[0] !== "founder-recovery" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(keyParts[1] ?? "") ||
    keyParts[1]?.includes("..") ||
    keyParts[2] !== `${input.archiveId}.age` ||
    input.idempotencyKey !== expectedIdempotencyKey
  ) {
    throw new Error("Recovery Archive deletion identity is invalid.");
  }
}
