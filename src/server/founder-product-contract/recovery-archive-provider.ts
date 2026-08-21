import "server-only";

import { founderProductContractDigest } from "./digest";

export type FounderRecoveryArchiveDeletionIdentity = {
  archiveId: string;
  storageObjectKey: string;
  recoveryCredentialDigest: string;
  idempotencyKey: string;
};

export type FounderRecoveryArchiveDeletionOutcome = {
  archiveAbsent: true;
  recoveryCredentialsAbsent: true;
};

export type FounderRecoveryArchiveDeletionProvider = {
  deleteRecoveryArchive(
    input: FounderRecoveryArchiveDeletionIdentity,
  ): Promise<FounderRecoveryArchiveDeletionOutcome>;
};

export function assertFounderRecoveryArchiveDeletionIdentity(
  input: FounderRecoveryArchiveDeletionIdentity,
): void {
  const expectedIdempotencyKey = founderProductContractDigest(
    `recovery-archive-delete:${input.archiveId}`,
  );
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
    !/^sha256:[a-f0-9]{64}$/.test(input.recoveryCredentialDigest) ||
    input.idempotencyKey !== expectedIdempotencyKey
  ) {
    throw new Error("Recovery Archive deletion identity is invalid.");
  }
}
