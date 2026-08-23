import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderIdentityRecoveries,
  founderIdentityRecoveryCredentials,
  founderIdentityRecoveryReceipts,
  users,
} from "@/src/server/db/schema";
import { founderProductContractDigest } from "@/src/server/founder-product-contract/digest";
import { requireApplicationUser } from "@/src/server/users/application-user";
import {
  type FounderIdentityRecoveryError,
  getFounderIdentityRecoveryCredentialStatusForUser,
  getFounderIdentityRecoveryStatusForClerkSubject,
  issueFounderIdentityRecoveryCredentialForUser,
  recordFounderIdentityLoss,
  recoverFounderIdentity,
  recoverFounderIdentityWithCredential,
  recoverFounderIdentityWithCredentialAndStatus,
  signFounderIdentityRecoveryAssertion,
} from "@/src/server/users/founder-identity-recovery";

const OWNER_ID = "00000000-0000-4000-8000-000000000384";
const PRIOR_SUBJECT = "user_clerk_identity_lost";
const REPLACEMENT_SUBJECT = "user_clerk_identity_recovered";
const ATTACKER_SUBJECT = "user_clerk_identity_attacker";
const NOW = new Date("2026-08-23T04:00:00.000Z");
const SIGNING_SECRET = "identity-recovery-unit-signing-secret-384";

describe("Founder identity recovery", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await connection.client.unsafe("truncate table users restart identity cascade");
    await connection.db.insert(users).values({
      id: OWNER_ID,
      clerkUserId: PRIOR_SUBJECT,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  afterEach(async () => {
    await connection.client.unsafe("truncate table users restart identity cascade");
    await connection.close();
  });

  it("denies Operator access while preserving the internal Owner mapping and idempotent loss receipt", async () => {
    const first = await recordFounderIdentityLoss({
      clerkUserId: PRIOR_SUBJECT,
      providerEventId: "clerk-event-384",
      reason: "clerk_user_deleted",
      observedAt: NOW,
      createConnection: () => connection,
    });
    const duplicate = await recordFounderIdentityLoss({
      clerkUserId: PRIOR_SUBJECT,
      providerEventId: "clerk-event-384",
      reason: "clerk_user_deleted",
      observedAt: NOW,
      createConnection: () => connection,
    });
    expect(duplicate).toEqual(first);
    await expect(
      recordFounderIdentityLoss({
        clerkUserId: PRIOR_SUBJECT,
        providerEventId: "clerk-event-384",
        reason: "clerk_identity_lost",
        observedAt: NOW,
        createConnection: () => connection,
      }),
    ).rejects.toThrow("event replay did not match");

    await expect(
      requireApplicationUser("clerk", {
        createConnection: () => connection,
        getClerkUserId: async () => PRIOR_SUBJECT,
      }),
    ).resolves.toEqual({ ok: false, status: 401, code: "unauthenticated" });
    await expect(
      getFounderIdentityRecoveryStatusForClerkSubject(PRIOR_SUBJECT, {
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ state: "recovery_required" });
    await expect(getFounderIdentityRecoveryStatusForClerkSubject(PRIOR_SUBJECT)).resolves.toEqual({
      state: "recovery_required",
    });

    const [owner] = await connection.db.select().from(users);
    expect(owner).toMatchObject({ id: OWNER_ID, clerkUserId: PRIOR_SUBJECT });
    expect(await connection.db.select().from(founderIdentityRecoveries)).toHaveLength(1);
    const receipts = await connection.db.select().from(founderIdentityRecoveryReceipts);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ kind: "identity_loss_recorded" });
    expect(JSON.stringify(receipts)).not.toMatch(/checkout|email|session|refund.{0,8}true/i);
  });

  it("records takeover denial and rebinds only the signed replacement identity to the same Owner", async () => {
    const loss = await recordFounderIdentityLoss({
      clerkUserId: PRIOR_SUBJECT,
      providerEventId: "clerk-event-recover-384",
      reason: "clerk_user_deleted",
      observedAt: NOW,
      createConnection: () => connection,
    });
    if (!loss) throw new Error("Expected identity recovery state.");
    const proof = signFounderIdentityRecoveryAssertion(
      {
        schema: "bruno.founder-identity-recovery.v1",
        recoveryId: loss.recoveryId,
        ownerId: OWNER_ID,
        priorClerkSubjectDigest: founderProductContractDigest(`clerk:${PRIOR_SUBJECT}`),
        replacementClerkSubjectDigest: founderProductContractDigest(`clerk:${REPLACEMENT_SUBJECT}`),
        evidenceDigest: founderProductContractDigest("strong-same-owner-evidence"),
        issuedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.valueOf() + 15 * 60 * 1_000).toISOString(),
      },
      SIGNING_SECRET,
    );

    await expect(
      recoverFounderIdentity({
        replacementClerkUserId: ATTACKER_SUBJECT,
        assertion: proof,
        signingSecret: SIGNING_SECRET,
        now: NOW,
        createConnection: () => connection,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<FounderIdentityRecoveryError>>({
        code: "recovery_subject_mismatch",
      }),
    );
    expect(
      (await connection.db.select().from(founderIdentityRecoveryReceipts)).map((r) => r.kind),
    ).toEqual(["identity_loss_recorded", "recovery_denied"]);

    await expect(
      recoverFounderIdentity({
        replacementClerkUserId: REPLACEMENT_SUBJECT,
        assertion: proof,
        signingSecret: SIGNING_SECRET,
        now: NOW,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ ownerId: OWNER_ID, recoveredAt: NOW.toISOString() });
    await expect(
      requireApplicationUser("clerk", {
        createConnection: () => connection,
        getClerkUserId: async () => REPLACEMENT_SUBJECT,
      }),
    ).resolves.toEqual({ ok: true, userId: OWNER_ID });
    await expect(
      getFounderIdentityRecoveryStatusForClerkSubject(REPLACEMENT_SUBJECT, {
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({
      state: "recovered",
      receipts: [
        { kind: "identity_loss_recorded" },
        { kind: "recovery_denied" },
        { kind: "identity_rebound" },
      ],
    });
    expect(await connection.db.select().from(users)).toEqual([
      expect.objectContaining({ id: OWNER_ID, clerkUserId: REPLACEMENT_SUBJECT }),
    ]);
  });

  it("uses a recently issued one-time credential for the production replacement journey", async () => {
    const issued = await issueFounderIdentityRecoveryCredentialForUser({
      userId: OWNER_ID,
      now: NOW,
      randomBytes: () => Buffer.alloc(32, 0x38),
      createConnection: () => connection,
    });
    expect(issued.recoveryCode).toMatch(/^bruno_recovery_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}$/);
    expect(
      JSON.stringify(await connection.db.select().from(founderIdentityRecoveryCredentials)),
    ).not.toContain(issued.recoveryCode);
    await recordFounderIdentityLoss({
      clerkUserId: PRIOR_SUBJECT,
      providerEventId: "clerk-event-credential-384",
      reason: "clerk_identity_lost",
      observedAt: NOW,
      createConnection: () => connection,
    });

    const wrongCode = `${issued.recoveryCode.slice(0, -1)}x`;
    await expect(
      recoverFounderIdentityWithCredential({
        replacementClerkUserId: ATTACKER_SUBJECT,
        recoveryCode: wrongCode,
        signingSecret: SIGNING_SECRET,
        now: NOW,
        createConnection: () => connection,
      }),
    ).rejects.toMatchObject({ code: "recovery_credential_invalid" });

    await expect(
      recoverFounderIdentityWithCredentialAndStatus({
        replacementClerkUserId: REPLACEMENT_SUBJECT,
        recoveryCode: issued.recoveryCode,
        signingSecret: SIGNING_SECRET,
        now: NOW,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({
      recovered: { ownerId: OWNER_ID, recoveredAt: NOW.toISOString() },
      recovery: {
        state: "recovered",
        recoveredAt: NOW.toISOString(),
        receipts: [
          { kind: "identity_loss_recorded", occurredAt: NOW.toISOString() },
          { kind: "recovery_denied", occurredAt: NOW.toISOString() },
          { kind: "identity_rebound", occurredAt: NOW.toISOString() },
        ],
      },
    });
    await expect(
      getFounderIdentityRecoveryCredentialStatusForUser(OWNER_ID, {
        now: () => NOW,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ state: "used", usedAt: NOW.toISOString() });
    expect(
      (await connection.db.select().from(founderIdentityRecoveryReceipts)).map((r) => r.kind),
    ).toEqual(["identity_loss_recorded", "recovery_denied", "identity_rebound"]);
  });

  it("rejects expired proof without changing identity authority", async () => {
    const loss = await recordFounderIdentityLoss({
      clerkUserId: PRIOR_SUBJECT,
      providerEventId: "clerk-event-expired-384",
      reason: "clerk_identity_lost",
      observedAt: NOW,
      createConnection: () => connection,
    });
    if (!loss) throw new Error("Expected identity recovery state.");
    const proof = signFounderIdentityRecoveryAssertion(
      {
        schema: "bruno.founder-identity-recovery.v1",
        recoveryId: loss.recoveryId,
        ownerId: OWNER_ID,
        priorClerkSubjectDigest: founderProductContractDigest(`clerk:${PRIOR_SUBJECT}`),
        replacementClerkSubjectDigest: founderProductContractDigest(`clerk:${REPLACEMENT_SUBJECT}`),
        evidenceDigest: founderProductContractDigest("expired-same-owner-evidence"),
        issuedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.valueOf() + 15 * 60 * 1_000).toISOString(),
      },
      SIGNING_SECRET,
    );
    await expect(
      recoverFounderIdentity({
        replacementClerkUserId: REPLACEMENT_SUBJECT,
        assertion: proof,
        signingSecret: SIGNING_SECRET,
        now: new Date(NOW.valueOf() + 15 * 60 * 1_000),
        createConnection: () => connection,
      }),
    ).rejects.toMatchObject({ code: "recovery_assertion_expired" });
    expect((await connection.db.select().from(users))[0]?.clerkUserId).toBe(PRIOR_SUBJECT);
  });
});
