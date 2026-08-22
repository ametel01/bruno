import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeBackupObjectStorage } from "@/src/server/backups/backup-storage";
import {
  createEncryptedFounderRecoveryArchiveProvider,
  EncryptedFounderRecoveryArchiveProvider,
  type FounderRecoveryArchiveDurableState,
  readFounderRecoveryArchiveMasterKey,
} from "@/src/server/founder-product-contract/encrypted-recovery-archive-provider";
import { FOUNDER_RECOVERY_ARCHIVE_PAUSE_REASON } from "@/src/server/founder-product-contract/recovery-archive-provider";

const USER_ID = "00000000-0000-4000-8000-000000003730";
const OPERATOR_ID = "00000000-0000-4000-8000-000000003731";
const OBSERVED_AT = new Date("2026-08-22T00:00:00.000Z");
const MASTER_KEY = new Uint8Array(32).fill(37);

describe("encrypted Founder Recovery Archive provider", () => {
  it("stores ciphertext and a separate wrapped recovery credential, then rebuilds durable state", async () => {
    const storage = new FakeBackupObjectStorage("founder-recovery-test");
    const rebuiltStates: FounderRecoveryArchiveDurableState[] = [];
    const provider = new EncryptedFounderRecoveryArchiveProvider({
      storage,
      masterKey: MASTER_KEY,
      restoreBoundary: {
        async rebuild(state) {
          rebuiltStates.push(state);
          return structuredClone(state);
        },
      },
    });
    const archiveId = randomUUID();

    const created = await provider.createRecoveryArchive({
      archiveIntentId: archiveId,
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      observedAt: OBSERVED_AT,
      state: durableState(),
    });

    expect(created).toMatchObject({
      storageObjectKey: `founder-recovery/${USER_ID}/${archiveId}.age`,
      recoveryCredentialObjectKey: `founder-recovery/${USER_ID}/${archiveId}.key`,
      formatVersion: 1,
      restorableVerified: true,
      restoreVerifiedAt: OBSERVED_AT,
    });
    expect(created.ciphertextDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(created.stateDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(created.recoveryCredentialDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const archiveObject = await storage.download({ key: created.storageObjectKey });
    const credentialObject = await storage.download({ key: created.recoveryCredentialObjectKey });
    if (!archiveObject.ok || !credentialObject.ok) throw new Error("Expected stored objects.");
    const storedText = `${new TextDecoder().decode(archiveObject.body)}${new TextDecoder().decode(
      credentialObject.body,
    )}`;
    expect(storedText).not.toContain("Asia/Manila");
    expect(storedText).not.toContain("runtime-v1");
    expect(storedText).not.toContain("founder@example.com");

    await expect(
      provider.verifyRecoveryArchive({
        archiveId,
        userId: USER_ID,
        operatorId: OPERATOR_ID,
        storageObjectKey: created.storageObjectKey,
        recoveryCredentialObjectKey: created.recoveryCredentialObjectKey,
        ciphertextDigest: created.ciphertextDigest,
        recoveryCredentialDigest: created.recoveryCredentialDigest,
        stateDigest: created.stateDigest,
      }),
    ).resolves.toEqual(durableState());
    expect(rebuiltStates).toEqual([durableState(), durableState()]);
  });

  it("rejects raw credentials and corrupt ciphertext instead of certifying a manifest", async () => {
    const storage = new FakeBackupObjectStorage("founder-recovery-test");
    const provider = new EncryptedFounderRecoveryArchiveProvider({
      storage,
      masterKey: MASTER_KEY,
    });

    await expect(
      provider.createRecoveryArchive({
        archiveIntentId: randomUUID(),
        userId: USER_ID,
        operatorId: OPERATOR_ID,
        observedAt: OBSERVED_AT,
        state: {
          ...durableState(),
          providerCredential: "sk-this-must-never-be-archived",
        } as never,
      }),
    ).rejects.toThrow("non-allowlisted or credential-bearing state");

    const archiveId = randomUUID();
    const created = await provider.createRecoveryArchive({
      archiveIntentId: archiveId,
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      observedAt: OBSERVED_AT,
      state: durableState(),
    });
    await storage.upload({
      key: created.storageObjectKey,
      body: new TextEncoder().encode('{"schemaVersion":1,"ciphertext":"corrupt"}'),
    });

    await expect(
      provider.verifyRecoveryArchive({
        archiveId,
        userId: USER_ID,
        operatorId: OPERATOR_ID,
        storageObjectKey: created.storageObjectKey,
        recoveryCredentialObjectKey: created.recoveryCredentialObjectKey,
        ciphertextDigest: created.ciphertextDigest,
        recoveryCredentialDigest: created.recoveryCredentialDigest,
        stateDigest: created.stateDigest,
      }),
    ).rejects.toThrow("ciphertext digest");
  });

  it("rejects a paused Operator state that cannot be persisted after restoration", async () => {
    const provider = new EncryptedFounderRecoveryArchiveProvider({
      storage: new FakeBackupObjectStorage("founder-recovery-test"),
      masterKey: MASTER_KEY,
    });

    await expect(
      provider.createRecoveryArchive({
        archiveIntentId: randomUUID(),
        userId: USER_ID,
        operatorId: OPERATOR_ID,
        observedAt: OBSERVED_AT,
        state: {
          ...durableState(),
          operator: { ...durableState().operator, externalActionPaused: true },
        },
      }),
    ).rejects.toThrow("non-allowlisted or credential-bearing state");

    const unsafeState = {
      ...durableState(),
      operator: {
        ...durableState().operator,
        externalActionPaused: true,
        externalActionPauseReason: "Bearer embedded-secret-must-not-be-archived",
        externalActionPausedAt: OBSERVED_AT.toISOString(),
      },
    } as unknown as FounderRecoveryArchiveDurableState;
    await expect(
      provider.createRecoveryArchive({
        archiveIntentId: randomUUID(),
        userId: USER_ID,
        operatorId: OPERATOR_ID,
        observedAt: OBSERVED_AT,
        state: unsafeState,
      }),
    ).rejects.toThrow("non-allowlisted or credential-bearing state");

    await expect(
      provider.createRecoveryArchive({
        archiveIntentId: randomUUID(),
        userId: USER_ID,
        operatorId: OPERATOR_ID,
        observedAt: OBSERVED_AT,
        state: {
          ...durableState(),
          operator: {
            ...durableState().operator,
            externalActionPaused: true,
            externalActionPauseReason: FOUNDER_RECOVERY_ARCHIVE_PAUSE_REASON,
            externalActionPausedAt: OBSERVED_AT.toISOString(),
          },
        },
      }),
    ).resolves.toMatchObject({ restorableVerified: true });
  });

  it("deletes and verifies absence of both the archive and its recovery-only credential", async () => {
    const storage = new FakeBackupObjectStorage("founder-recovery-test");
    const provider = new EncryptedFounderRecoveryArchiveProvider({
      storage,
      masterKey: MASTER_KEY,
      restoreBoundary: { rebuild: async (state) => structuredClone(state) },
    });
    const archiveId = randomUUID();
    const created = await provider.createRecoveryArchive({
      archiveIntentId: archiveId,
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      observedAt: OBSERVED_AT,
      state: durableState(),
    });

    await expect(
      provider.deleteRecoveryArchive({
        archiveId,
        storageObjectKey: created.storageObjectKey,
        recoveryCredentialObjectKey: created.recoveryCredentialObjectKey,
        idempotencyKey: created.deletionIdempotencyKey,
      }),
    ).resolves.toEqual({ archiveAbsent: true, recoveryCredentialsAbsent: true });
    await expect(storage.download({ key: created.storageObjectKey })).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      storage.download({ key: created.recoveryCredentialObjectKey }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("fails publication when bucket versioning changes during archive upload", async () => {
    const underlyingStorage = new FakeBackupObjectStorage("founder-recovery-test");
    let safetyChecks = 0;
    const storage = {
      upload: (input: Parameters<typeof underlyingStorage.upload>[0]) =>
        underlyingStorage.upload(input),
      download: (input: Parameters<typeof underlyingStorage.download>[0]) =>
        underlyingStorage.download(input),
      delete: (input: Parameters<typeof underlyingStorage.delete>[0]) =>
        underlyingStorage.delete(input),
      exists: (input: Parameters<typeof underlyingStorage.exists>[0]) =>
        underlyingStorage.exists(input),
      async verifyDeletionSafety() {
        safetyChecks += 1;
        return safetyChecks === 1
          ? ({ ok: true, versioning: "disabled" } as const)
          : ({
              ok: false,
              status: "failed",
              message: "Bucket versioning changed during archive publication.",
            } as const);
      },
    };
    const provider = new EncryptedFounderRecoveryArchiveProvider({
      storage,
      masterKey: MASTER_KEY,
      restoreBoundary: { rebuild: async (state) => structuredClone(state) },
    });

    await expect(
      provider.createRecoveryArchive({
        archiveIntentId: randomUUID(),
        userId: USER_ID,
        operatorId: OPERATOR_ID,
        observedAt: OBSERVED_AT,
        state: durableState(),
      }),
    ).rejects.toThrow("cannot prove permanent object deletion");
    expect(safetyChecks).toBe(2);
  });

  it("fails deletion when bucket versioning changes during the deletion attempt", async () => {
    const underlyingStorage = new FakeBackupObjectStorage("founder-recovery-test");
    let safetyChecks = 0;
    const storage = {
      upload: (input: Parameters<typeof underlyingStorage.upload>[0]) =>
        underlyingStorage.upload(input),
      download: (input: Parameters<typeof underlyingStorage.download>[0]) =>
        underlyingStorage.download(input),
      delete: (input: Parameters<typeof underlyingStorage.delete>[0]) =>
        underlyingStorage.delete(input),
      exists: (input: Parameters<typeof underlyingStorage.exists>[0]) =>
        underlyingStorage.exists(input),
      async verifyDeletionSafety() {
        safetyChecks += 1;
        return safetyChecks <= 3
          ? ({ ok: true, versioning: "disabled" } as const)
          : ({
              ok: false,
              status: "failed",
              message: "Bucket versioning changed during deletion.",
            } as const);
      },
    };
    const provider = new EncryptedFounderRecoveryArchiveProvider({
      storage,
      masterKey: MASTER_KEY,
      restoreBoundary: { rebuild: async (state) => structuredClone(state) },
    });
    const archiveId = randomUUID();
    const created = await provider.createRecoveryArchive({
      archiveIntentId: archiveId,
      userId: USER_ID,
      operatorId: OPERATOR_ID,
      observedAt: OBSERVED_AT,
      state: durableState(),
    });

    await expect(
      provider.deleteRecoveryArchive({
        archiveId,
        storageObjectKey: created.storageObjectKey,
        recoveryCredentialObjectKey: created.recoveryCredentialObjectKey,
        idempotencyKey: created.deletionIdempotencyKey,
      }),
    ).rejects.toThrow("cannot prove permanent object deletion");
    expect(safetyChecks).toBe(4);
  });

  it("requires storage and a 256-bit server-only master key together", () => {
    expect(readFounderRecoveryArchiveMasterKey({})).toBeNull();
    expect(() =>
      readFounderRecoveryArchiveMasterKey({ BRUNO_RECOVERY_ARCHIVE_MASTER_KEY: "not-a-key" }),
    ).toThrow("base64-encoded 256-bit key");
    expect(
      readFounderRecoveryArchiveMasterKey({
        BRUNO_RECOVERY_ARCHIVE_MASTER_KEY: Buffer.from(MASTER_KEY).toString("base64"),
      }),
    ).toEqual(MASTER_KEY);
    expect(() =>
      createEncryptedFounderRecoveryArchiveProvider({
        BRUNO_RECOVERY_ARCHIVE_MASTER_KEY: Buffer.from(MASTER_KEY).toString("base64"),
      }),
    ).toThrow("storage and encryption must be configured together");
  });
});

function durableState(): FounderRecoveryArchiveDurableState {
  return {
    schemaVersion: 1,
    operator: {
      id: OPERATOR_ID,
      createdAt: "2026-08-18T00:00:00.000Z",
      mailOfferDisposition: null,
      externalActionPaused: false,
      externalActionPauseReason: null,
      externalActionPausedAt: null,
    },
    preparation: {
      timezone: "Asia/Manila",
      timezoneConfirmedAt: "2026-08-18T00:01:00.000Z",
    },
    runtime: { configRevision: "runtime-v1" },
    restoration: {
      logicalOperatorId: OPERATOR_ID,
      providerReauthorizationRequired: true,
      reusableCredentials: [],
    },
  };
}
