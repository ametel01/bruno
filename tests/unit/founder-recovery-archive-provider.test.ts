import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertFounderRecoveryArchiveDeletionIdentity } from "@/src/server/founder-product-contract/recovery-archive-provider";

const ARCHIVE_ID = "00000000-0000-4000-8000-000000003721";
const IDEMPOTENCY_KEY = `sha256:${createHash("sha256")
  .update(`recovery-archive-delete:${ARCHIVE_ID}`)
  .digest("hex")}`;
const RECOVERY_CREDENTIAL_DIGEST = `sha256:${"c".repeat(64)}`;

describe("Founder Recovery Archive deletion identity", () => {
  it("allows only the exact archive object in the reserved namespace", () => {
    expect(() =>
      assertFounderRecoveryArchiveDeletionIdentity({
        archiveId: ARCHIVE_ID,
        storageObjectKey: `founder-recovery/run-372/${ARCHIVE_ID}.age`,
        recoveryCredentialDigest: RECOVERY_CREDENTIAL_DIGEST,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).not.toThrow();

    for (const storageObjectKey of [
      `backups/run-372/${ARCHIVE_ID}.age`,
      "founder-recovery/run-372/unrelated.age",
      `founder-recovery/../${ARCHIVE_ID}.age`,
    ]) {
      expect(() =>
        assertFounderRecoveryArchiveDeletionIdentity({
          archiveId: ARCHIVE_ID,
          storageObjectKey,
          recoveryCredentialDigest: RECOVERY_CREDENTIAL_DIGEST,
          idempotencyKey: IDEMPOTENCY_KEY,
        }),
      ).toThrow("deletion identity is invalid");
    }

    expect(() =>
      assertFounderRecoveryArchiveDeletionIdentity({
        archiveId: ARCHIVE_ID,
        storageObjectKey: `founder-recovery/run-372/${ARCHIVE_ID}.age`,
        recoveryCredentialDigest: RECOVERY_CREDENTIAL_DIGEST,
        idempotencyKey: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow("deletion identity is invalid");

    expect(() =>
      assertFounderRecoveryArchiveDeletionIdentity({
        archiveId: ARCHIVE_ID,
        storageObjectKey: `founder-recovery/run-372/${ARCHIVE_ID}.age`,
        recoveryCredentialDigest: "credential-value",
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).toThrow("deletion identity is invalid");
  });
});
