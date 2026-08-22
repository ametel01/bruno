import "server-only";

import { founderProductContractDigest } from "./digest";
export type FounderRecoveryArchiveDurableState = {
  schemaVersion: 1;
  operator: {
    id: string;
    createdAt: string;
    mailOfferDisposition: "enabled" | "dismissed" | null;
    externalActionPaused: boolean;
    externalActionPauseReason: string | null;
    externalActionPausedAt: string | null;
  };
  preparation: {
    timezone: string;
    timezoneConfirmedAt: string;
  };
  runtime: {
    configRevision: string;
  };
  restoration: {
    logicalOperatorId: string;
    providerReauthorizationRequired: true;
    reusableCredentials: readonly [];
  };
};

export type FounderRecoveryArchiveCreationInput = {
  archiveIntentId: string;
  userId: string;
  operatorId: string;
  observedAt: Date;
  state: FounderRecoveryArchiveDurableState;
};

export type FounderRecoveryArchiveCreationOutcome = {
  storageObjectKey: string;
  recoveryCredentialObjectKey: string;
  ciphertextDigest: `sha256:${string}`;
  recoveryCredentialDigest: `sha256:${string}`;
  stateDigest: `sha256:${string}`;
  formatVersion: 1;
  restorableVerified: true;
  restoreVerifiedAt: Date;
  deletionIdempotencyKey: string;
};

export type FounderRecoveryArchiveDeletionIdentity = {
  archiveId: string;
  storageObjectKey: string;
  recoveryCredentialObjectKey: string;
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

export type FounderRecoveryArchiveCreationProvider = {
  createRecoveryArchive(
    input: FounderRecoveryArchiveCreationInput,
  ): Promise<FounderRecoveryArchiveCreationOutcome>;
};

export type FounderRecoveryArchiveProvider = FounderRecoveryArchiveCreationProvider &
  FounderRecoveryArchiveDeletionProvider;

export function assertFounderRecoveryArchiveDeletionIdentity(
  input: FounderRecoveryArchiveDeletionIdentity,
): void {
  const expectedIdempotencyKey = founderProductContractDigest(
    `recovery-archive-delete:${input.archiveId}`,
  );
  const keyParts = input.storageObjectKey.split("/");
  const credentialKeyParts = input.recoveryCredentialObjectKey.split("/");
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      input.archiveId,
    ) ||
    keyParts.length !== 3 ||
    keyParts[0] !== "founder-recovery" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(keyParts[1] ?? "") ||
    keyParts[1]?.includes("..") ||
    keyParts[2] !== `${input.archiveId}.age` ||
    credentialKeyParts.length !== 3 ||
    credentialKeyParts[0] !== "founder-recovery" ||
    credentialKeyParts[1] !== keyParts[1] ||
    credentialKeyParts[2] !== `${input.archiveId}.key` ||
    input.idempotencyKey !== expectedIdempotencyKey
  ) {
    throw new Error("Recovery Archive deletion identity is invalid.");
  }
}

export function founderRecoveryArchiveObjectIdentity(
  userId: string,
  archiveId: string,
): {
  storageObjectKey: string;
  recoveryCredentialObjectKey: string;
} {
  if (!isUuid(userId) || !isUuid(archiveId)) {
    throw new Error("Recovery Archive object identity is invalid.");
  }
  return {
    storageObjectKey: `founder-recovery/${userId}/${archiveId}.age`,
    recoveryCredentialObjectKey: `founder-recovery/${userId}/${archiveId}.key`,
  };
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}
