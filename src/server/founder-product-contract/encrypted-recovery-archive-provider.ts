import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  assertIndependentRecoveryArchiveStorage,
  createBackupObjectStorage,
  type DeletableBackupObjectStorage,
  readBackupStorageConfig,
} from "@/src/server/backups/backup-storage";
import { founderProductContractDigest } from "./digest";
import {
  assertFounderRecoveryArchiveDeletionIdentity,
  FOUNDER_RECOVERY_ARCHIVE_PAUSE_REASON,
  type FounderRecoveryArchiveCreationInput,
  type FounderRecoveryArchiveCreationOutcome,
  type FounderRecoveryArchiveDeletionIdentity,
  type FounderRecoveryArchiveDeletionOutcome,
  type FounderRecoveryArchiveDurableState,
  type FounderRecoveryArchiveProvider,
  founderRecoveryArchiveObjectIdentity,
} from "./recovery-archive-provider";
import {
  type FounderRecoveryArchiveRestoreBoundary,
  IsolatedFounderRecoveryArchiveRestoreBoundary,
} from "./recovery-archive-restoration";

const ARCHIVE_CONTENT_TYPE = "application/vnd.bruno.recovery-archive.encrypted+json";
const CREDENTIAL_CONTENT_TYPE = "application/vnd.bruno.recovery-credential.wrapped+json";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";

export type { FounderRecoveryArchiveDurableState } from "./recovery-archive-provider";

type ArchiveEnvelope = {
  schemaVersion: 1;
  algorithm: typeof ENCRYPTION_ALGORITHM;
  initializationVector: string;
  authenticationTag: string;
  ciphertext: string;
};

type RecoveryCredentialEnvelope = {
  schemaVersion: 1;
  algorithm: typeof ENCRYPTION_ALGORITHM;
  initializationVector: string;
  authenticationTag: string;
  wrappedDataKey: string;
};

type ProviderOperation =
  | "archive.encrypt"
  | "archive.store"
  | "archive.restore"
  | "archive.delete"
  | "archive.delete_credentials";

type ProviderDependencies = {
  storage: DeletableBackupObjectStorage;
  masterKey: Uint8Array;
  onOperation?: (operation: ProviderOperation) => void;
  restoreBoundary?: FounderRecoveryArchiveRestoreBoundary;
};

type VerifyRecoveryArchiveInput = {
  archiveId: string;
  userId: string;
  operatorId: string;
  storageObjectKey: string;
  recoveryCredentialObjectKey: string;
  ciphertextDigest: `sha256:${string}`;
  recoveryCredentialDigest: `sha256:${string}`;
  stateDigest: `sha256:${string}`;
};

export class EncryptedFounderRecoveryArchiveProvider implements FounderRecoveryArchiveProvider {
  private readonly storage: DeletableBackupObjectStorage;
  private readonly masterKey: Uint8Array;
  private readonly onOperation: (operation: ProviderOperation) => void;
  private readonly restoreBoundary: FounderRecoveryArchiveRestoreBoundary;

  constructor(dependencies: ProviderDependencies) {
    if (dependencies.masterKey.byteLength !== 32) {
      throw new Error("Recovery Archive encryption requires a 256-bit master key.");
    }
    this.storage = dependencies.storage;
    this.masterKey = new Uint8Array(dependencies.masterKey);
    this.onOperation = dependencies.onOperation ?? (() => undefined);
    this.restoreBoundary =
      dependencies.restoreBoundary ?? new IsolatedFounderRecoveryArchiveRestoreBoundary();
  }

  async createRecoveryArchive(
    input: FounderRecoveryArchiveCreationInput,
  ): Promise<FounderRecoveryArchiveCreationOutcome> {
    await requirePermanentDeletionSafety(this.storage);
    const state = parseDurableState(input.state);
    if (
      state.operator.id !== input.operatorId ||
      state.restoration.logicalOperatorId !== input.operatorId
    ) {
      throw new Error("Recovery Archive state does not match the logical Operator.");
    }

    const plaintext = new TextEncoder().encode(JSON.stringify(state));
    const stateDigest = digest(plaintext);
    const dataKey = randomBytes(32);
    const { storageObjectKey: archiveObjectKey, recoveryCredentialObjectKey: credentialObjectKey } =
      founderRecoveryArchiveObjectIdentity(input.userId, input.archiveIntentId);
    const additionalData = archiveAdditionalData({
      archiveId: input.archiveIntentId,
      userId: input.userId,
      operatorId: input.operatorId,
      stateDigest,
    });

    this.onOperation("archive.encrypt");
    const archiveBody = encodeEnvelope(encrypt(plaintext, dataKey, additionalData));
    const credentialBody = encodeCredentialEnvelope(
      encrypt(dataKey, this.masterKey, credentialAdditionalData(input.archiveIntentId)),
    );
    const ciphertextDigest = digest(archiveBody);
    const recoveryCredentialDigest = digest(credentialBody);

    try {
      this.onOperation("archive.store");
      await requireUpload(
        this.storage,
        archiveObjectKey,
        archiveBody,
        ARCHIVE_CONTENT_TYPE,
        "Recovery Archive ciphertext could not be stored.",
      );
      await requireUpload(
        this.storage,
        credentialObjectKey,
        credentialBody,
        CREDENTIAL_CONTENT_TYPE,
        "Recovery Archive credential could not be stored.",
      );
      const restored = await this.verifyRecoveryArchive({
        archiveId: input.archiveIntentId,
        userId: input.userId,
        operatorId: input.operatorId,
        storageObjectKey: archiveObjectKey,
        recoveryCredentialObjectKey: credentialObjectKey,
        ciphertextDigest,
        recoveryCredentialDigest,
        stateDigest,
      });
      if (digest(new TextEncoder().encode(JSON.stringify(restored))) !== stateDigest) {
        throw new Error("Recovery Archive restore check rebuilt different durable state.");
      }
      return {
        storageObjectKey: archiveObjectKey,
        recoveryCredentialObjectKey: credentialObjectKey,
        ciphertextDigest,
        recoveryCredentialDigest,
        stateDigest,
        formatVersion: 1,
        restorableVerified: true,
        restoreVerifiedAt: input.observedAt,
        deletionIdempotencyKey: founderProductContractDigest(
          `recovery-archive-delete:${input.archiveIntentId}`,
        ),
      };
    } catch (error) {
      await Promise.allSettled([
        this.storage.delete({ key: archiveObjectKey }),
        this.storage.delete({ key: credentialObjectKey }),
      ]);
      throw error;
    } finally {
      dataKey.fill(0);
    }
  }

  async verifyRecoveryArchive(
    input: VerifyRecoveryArchiveInput,
  ): Promise<FounderRecoveryArchiveDurableState> {
    this.onOperation("archive.restore");
    const [archiveDownload, credentialDownload] = await Promise.all([
      this.storage.download({ key: input.storageObjectKey }),
      this.storage.download({ key: input.recoveryCredentialObjectKey }),
    ]);
    if (!archiveDownload.ok || !credentialDownload.ok) {
      throw new Error("Recovery Archive restore check could not read both required objects.");
    }
    if (digest(archiveDownload.body) !== input.ciphertextDigest) {
      throw new Error("Recovery Archive ciphertext digest did not match.");
    }
    if (digest(credentialDownload.body) !== input.recoveryCredentialDigest) {
      throw new Error("Recovery Archive credential digest did not match.");
    }

    const credentialEnvelope = parseCredentialEnvelope(credentialDownload.body);
    const dataKey = decrypt(
      credentialEnvelope,
      this.masterKey,
      credentialAdditionalData(input.archiveId),
    );
    try {
      const plaintext = decrypt(
        parseArchiveEnvelope(archiveDownload.body),
        dataKey,
        archiveAdditionalData({
          archiveId: input.archiveId,
          userId: input.userId,
          operatorId: input.operatorId,
          stateDigest: input.stateDigest,
        }),
      );
      if (digest(plaintext) !== input.stateDigest) {
        throw new Error("Recovery Archive restored state digest did not match.");
      }
      return await this.restoreBoundary.rebuild(parseDurableState(parseJson(plaintext)));
    } finally {
      dataKey.fill(0);
    }
  }

  async deleteRecoveryArchive(
    input: FounderRecoveryArchiveDeletionIdentity,
  ): Promise<FounderRecoveryArchiveDeletionOutcome> {
    assertFounderRecoveryArchiveDeletionIdentity(input);
    await requirePermanentDeletionSafety(this.storage);
    this.onOperation("archive.delete");
    const archiveDeletion = await this.storage.delete({ key: input.storageObjectKey });
    if (!archiveDeletion.ok) throw new Error("Recovery Archive ciphertext deletion failed.");
    this.onOperation("archive.delete_credentials");
    const credentialDeletion = await this.storage.delete({
      key: input.recoveryCredentialObjectKey,
    });
    if (!credentialDeletion.ok) throw new Error("Recovery Archive credential deletion failed.");
    await requirePermanentDeletionSafety(this.storage);
    const [archivePresence, credentialPresence] = await Promise.all([
      this.storage.exists({ key: input.storageObjectKey }),
      this.storage.exists({ key: input.recoveryCredentialObjectKey }),
    ]);
    if (!archivePresence.ok || !credentialPresence.ok) {
      throw new Error("Recovery Archive deletion could not verify provider absence.");
    }
    if (archivePresence.exists || credentialPresence.exists) {
      throw new Error("Recovery Archive deletion did not prove provider absence.");
    }
    return {
      archiveAbsent: true,
      recoveryCredentialsAbsent: true,
    };
  }
}

export function readFounderRecoveryArchiveMasterKey(
  input: Record<string, string | undefined> = process.env,
): Uint8Array | null {
  const configured = input.BRUNO_RECOVERY_ARCHIVE_MASTER_KEY?.trim();
  if (!configured) return null;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(configured)) {
    throw new Error("BRUNO_RECOVERY_ARCHIVE_MASTER_KEY must be a base64-encoded 256-bit key.");
  }
  const key = Buffer.from(configured, "base64");
  if (key.byteLength !== 32) {
    throw new Error("BRUNO_RECOVERY_ARCHIVE_MASTER_KEY must be a base64-encoded 256-bit key.");
  }
  return new Uint8Array(key);
}

export function createEncryptedFounderRecoveryArchiveProvider(
  input: Record<string, string | undefined> = process.env,
): EncryptedFounderRecoveryArchiveProvider | null {
  const storageConfig = readBackupStorageConfig(input);
  if (storageConfig) assertIndependentRecoveryArchiveStorage(storageConfig);
  const storage = createBackupObjectStorage(storageConfig);
  const masterKey = readFounderRecoveryArchiveMasterKey(input);
  if (!storage && !masterKey) return null;
  if (!storage || !masterKey) {
    throw new Error("Recovery Archive storage and encryption must be configured together.");
  }
  return new EncryptedFounderRecoveryArchiveProvider({ storage, masterKey });
}

function encrypt(plaintext: Uint8Array, key: Uint8Array, additionalData: Uint8Array) {
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, initializationVector);
  cipher.setAAD(additionalData);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    initializationVector,
    authenticationTag: cipher.getAuthTag(),
    ciphertext,
  };
}

function decrypt(
  envelope: {
    initializationVector: Uint8Array;
    authenticationTag: Uint8Array;
    ciphertext: Uint8Array;
  },
  key: Uint8Array,
  additionalData: Uint8Array,
): Uint8Array {
  try {
    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, envelope.initializationVector);
    decipher.setAAD(additionalData);
    decipher.setAuthTag(envelope.authenticationTag);
    return new Uint8Array(Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]));
  } catch {
    throw new Error("Recovery Archive authenticated decryption failed.");
  }
}

function encodeEnvelope(encrypted: ReturnType<typeof encrypt>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      algorithm: ENCRYPTION_ALGORITHM,
      initializationVector: Buffer.from(encrypted.initializationVector).toString("base64"),
      authenticationTag: Buffer.from(encrypted.authenticationTag).toString("base64"),
      ciphertext: Buffer.from(encrypted.ciphertext).toString("base64"),
    } satisfies ArchiveEnvelope),
  );
}

function encodeCredentialEnvelope(encrypted: ReturnType<typeof encrypt>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      algorithm: ENCRYPTION_ALGORITHM,
      initializationVector: Buffer.from(encrypted.initializationVector).toString("base64"),
      authenticationTag: Buffer.from(encrypted.authenticationTag).toString("base64"),
      wrappedDataKey: Buffer.from(encrypted.ciphertext).toString("base64"),
    } satisfies RecoveryCredentialEnvelope),
  );
}

function parseArchiveEnvelope(value: Uint8Array) {
  const parsed = parseJson(value);
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      "schemaVersion",
      "algorithm",
      "initializationVector",
      "authenticationTag",
      "ciphertext",
    ]) ||
    parsed.schemaVersion !== 1 ||
    parsed.algorithm !== ENCRYPTION_ALGORITHM
  ) {
    throw new Error("Recovery Archive ciphertext envelope is invalid.");
  }
  return decodeEncryptedFields(parsed, "ciphertext");
}

function parseCredentialEnvelope(value: Uint8Array) {
  const parsed = parseJson(value);
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      "schemaVersion",
      "algorithm",
      "initializationVector",
      "authenticationTag",
      "wrappedDataKey",
    ]) ||
    parsed.schemaVersion !== 1 ||
    parsed.algorithm !== ENCRYPTION_ALGORITHM
  ) {
    throw new Error("Recovery Archive credential envelope is invalid.");
  }
  return decodeEncryptedFields(parsed, "wrappedDataKey");
}

function decodeEncryptedFields(value: Record<string, unknown>, ciphertextField: string) {
  const initializationVector = decodeBase64(value.initializationVector);
  const authenticationTag = decodeBase64(value.authenticationTag);
  const ciphertext = decodeBase64(value[ciphertextField]);
  if (
    initializationVector.byteLength !== 12 ||
    authenticationTag.byteLength !== 16 ||
    ciphertext.byteLength === 0
  ) {
    throw new Error("Recovery Archive encrypted fields are invalid.");
  }
  return { initializationVector, authenticationTag, ciphertext };
}

function parseDurableState(value: unknown): FounderRecoveryArchiveDurableState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "operator", "preparation", "runtime", "restoration"])
  ) {
    throw new Error("Recovery Archive contains non-allowlisted or credential-bearing state.");
  }
  const { operator, preparation, runtime, restoration } = value;
  if (
    value.schemaVersion !== 1 ||
    !isRecord(operator) ||
    !hasExactKeys(operator, [
      "id",
      "createdAt",
      "mailOfferDisposition",
      "externalActionPaused",
      "externalActionPauseReason",
      "externalActionPausedAt",
    ]) ||
    !isUuid(operator.id) ||
    !isIsoDate(operator.createdAt) ||
    ![null, "enabled", "dismissed"].includes(operator.mailOfferDisposition as never) ||
    typeof operator.externalActionPaused !== "boolean" ||
    !isPersistableExternalActionPause(operator) ||
    !isRecord(preparation) ||
    !hasExactKeys(preparation, ["timezone", "timezoneConfirmedAt"]) ||
    typeof preparation.timezone !== "string" ||
    !isTimezone(preparation.timezone) ||
    !isIsoDate(preparation.timezoneConfirmedAt) ||
    !isRecord(runtime) ||
    !hasExactKeys(runtime, ["configRevision"]) ||
    typeof runtime.configRevision !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(runtime.configRevision) ||
    !isRecord(restoration) ||
    !hasExactKeys(restoration, [
      "logicalOperatorId",
      "providerReauthorizationRequired",
      "reusableCredentials",
    ]) ||
    !isUuid(restoration.logicalOperatorId) ||
    restoration.providerReauthorizationRequired !== true ||
    !Array.isArray(restoration.reusableCredentials) ||
    restoration.reusableCredentials.length !== 0
  ) {
    throw new Error("Recovery Archive contains non-allowlisted or credential-bearing state.");
  }
  if (containsRawCredentialMaterial(value)) {
    throw new Error("Recovery Archive contains non-allowlisted or credential-bearing state.");
  }
  return value as FounderRecoveryArchiveDurableState;
}

function isPersistableExternalActionPause(operator: Record<string, unknown>): boolean {
  if (operator.externalActionPaused === false) {
    return operator.externalActionPauseReason === null && operator.externalActionPausedAt === null;
  }
  return (
    operator.externalActionPaused === true &&
    operator.externalActionPauseReason === FOUNDER_RECOVERY_ARCHIVE_PAUSE_REASON &&
    isIsoDate(operator.externalActionPausedAt)
  );
}

async function requireUpload(
  storage: DeletableBackupObjectStorage,
  key: string,
  body: Uint8Array,
  contentType: string,
  message: string,
) {
  const result = await storage.upload({ key, body, contentType });
  if (!result.ok) throw new Error(message);
}

async function requirePermanentDeletionSafety(
  storage: DeletableBackupObjectStorage,
): Promise<void> {
  const safety = await storage.verifyDeletionSafety();
  if (!safety.ok || safety.versioning !== "disabled") {
    throw new Error("Recovery Archive storage cannot prove permanent object deletion.");
  }
}

function archiveAdditionalData(input: {
  archiveId: string;
  userId: string;
  operatorId: string;
  stateDigest: string;
}) {
  return new TextEncoder().encode(
    `bruno.recovery-archive.v1:${input.archiveId}:${input.userId}:${input.operatorId}:${input.stateDigest}`,
  );
}

function credentialAdditionalData(archiveId: string) {
  return new TextEncoder().encode(`bruno.recovery-credential.v1:${archiveId}`);
}

function digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseJson(value: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } catch {
    throw new Error("Recovery Archive JSON is invalid.");
  }
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Recovery Archive encrypted fields are invalid.");
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !Number.isNaN(new Date(value).valueOf()) &&
    new Date(value).toISOString() === value
  );
}

function isTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 120) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function containsRawCredentialMaterial(value: unknown): boolean {
  if (typeof value === "string") {
    return (
      /^Bearer\s+\S+/i.test(value) ||
      /^sk-[A-Za-z0-9_-]{8,}/.test(value) ||
      /^dop_v1_[A-Za-z0-9_-]{8,}/.test(value) ||
      /^bruno_(run|reg)_[A-Za-z0-9_-]{8,}/.test(value) ||
      /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/.test(value)
    );
  }
  if (Array.isArray(value)) return value.some(containsRawCredentialMaterial);
  return isRecord(value) && Object.values(value).some(containsRawCredentialMaterial);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  );
}
