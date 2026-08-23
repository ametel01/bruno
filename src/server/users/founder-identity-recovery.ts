import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderIdentityRecoveries,
  founderIdentityRecoveryCredentials,
  founderIdentityRecoveryReceipts,
  users,
} from "@/src/server/db/schema";
import { founderProductContractDigest } from "@/src/server/founder-product-contract/digest";
import { assertClerkUserId, lockClerkUserId } from "@/src/server/users/application-user";

export const FOUNDER_IDENTITY_RECOVERY_ASSERTION_LIFETIME_MS = 15 * 60 * 1_000;
export const FOUNDER_IDENTITY_RECOVERY_CREDENTIAL_LIFETIME_MS = 365 * 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 60 * 1_000;
const ASSERTION_SCHEMA = "bruno.founder-identity-recovery.v1";
const RECOVERY_CODE_PATTERN = /^bruno_recovery_([a-f0-9-]{36})_([A-Za-z0-9_-]{43})$/;

export type FounderIdentityRecoveryStatusDto =
  | { state: "proof_required" }
  | { state: "recovery_required" }
  | { state: "current" }
  | {
      state: "recovered";
      recoveredAt: string;
      receipts: Array<{
        kind: "identity_loss_recorded" | "recovery_denied" | "identity_rebound";
        occurredAt: string;
      }>;
    };

export type FounderIdentityRecoveryAssertionPayload = {
  schema: typeof ASSERTION_SCHEMA;
  recoveryId: string;
  ownerId: string;
  priorClerkSubjectDigest: `sha256:${string}`;
  replacementClerkSubjectDigest: `sha256:${string}`;
  evidenceDigest: `sha256:${string}`;
  issuedAt: string;
  expiresAt: string;
};

export type FounderIdentityLossReason = "clerk_user_deleted" | "clerk_identity_lost";

export type FounderIdentityRecoveryCredentialStatusDto =
  | { state: "not_created" }
  | { state: "ready"; expiresAt: string }
  | { state: "expired"; expiredAt: string }
  | { state: "used"; usedAt: string };

type IdentityOnlyReceiptBoundary = {
  commerceChanged: false;
  productEntitlementChanged: false;
  accountClosureStarted: false;
  refundStarted: false;
  infrastructureRetirementStarted: false;
  brunoDataDeletionStarted: false;
};

const IDENTITY_ONLY_RECEIPT_BOUNDARY = {
  commerceChanged: false,
  productEntitlementChanged: false,
  accountClosureStarted: false,
  refundStarted: false,
  infrastructureRetirementStarted: false,
  brunoDataDeletionStarted: false,
} satisfies IdentityOnlyReceiptBoundary;

export class FounderIdentityRecoveryError extends Error {
  constructor(
    readonly code:
      | "recovery_assertion_invalid"
      | "recovery_assertion_expired"
      | "recovery_not_pending"
      | "recovery_owner_mismatch"
      | "recovery_subject_mismatch"
      | "replacement_identity_already_bound"
      | "replacement_identity_required"
      | "recovery_credential_invalid"
      | "recovery_credential_expired",
  ) {
    super(code);
    this.name = "FounderIdentityRecoveryError";
  }
}

export class FounderIdentityRecoveryReceiptError extends Error {
  constructor(readonly recovered: { ownerId: string; recoveredAt: string }) {
    super("identity_recovery_receipts_unavailable");
    this.name = "FounderIdentityRecoveryReceiptError";
  }
}

export async function issueFounderIdentityRecoveryCredentialForUser(input: {
  userId: string;
  now: Date;
  randomBytes?: (size: number) => Buffer;
  createConnection?: () => DatabaseConnection;
}): Promise<{ recoveryCode: string; expiresAt: string }> {
  if (!isUuid(input.userId)) throw new Error("Identity Recovery Owner is invalid.");
  assertInstant(input.now);
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  const secret = (input.randomBytes ?? randomBytes)(32).toString("base64url");
  if (secret.length !== 43) throw new Error("Identity Recovery credential entropy is invalid.");
  const expiresAt = new Date(
    input.now.valueOf() + FOUNDER_IDENTITY_RECOVERY_CREDENTIAL_LIFETIME_MS,
  );
  try {
    return await connection.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:identity-recovery-credential:${input.userId}`}, 0))`,
      );
      const [credential] = await tx
        .insert(founderIdentityRecoveryCredentials)
        .values({
          userId: input.userId,
          credentialDigest: founderProductContractDigest(
            `identity-recovery-credential:${input.userId}:${secret}`,
          ),
          issuedAt: input.now,
          expiresAt,
          usedAt: null,
          revokedAt: null,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: founderIdentityRecoveryCredentials.userId,
          set: {
            credentialDigest: founderProductContractDigest(
              `identity-recovery-credential:${input.userId}:${secret}`,
            ),
            issuedAt: input.now,
            expiresAt,
            usedAt: null,
            revokedAt: null,
            updatedAt: input.now,
          },
        })
        .returning({ id: founderIdentityRecoveryCredentials.id });
      if (!credential) throw new Error("Identity Recovery credential was not persisted.");
      return {
        recoveryCode: `bruno_recovery_${credential.id}_${secret}`,
        expiresAt: expiresAt.toISOString(),
      };
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function getFounderIdentityRecoveryCredentialStatusForUser(
  userId: string,
  dependencies: { now?: () => Date; createConnection?: () => DatabaseConnection } = {},
): Promise<FounderIdentityRecoveryCredentialStatusDto> {
  if (!isUuid(userId)) throw new Error("Identity Recovery Owner is invalid.");
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  try {
    const [credential] = await connection.db
      .select({
        expiresAt: founderIdentityRecoveryCredentials.expiresAt,
        usedAt: founderIdentityRecoveryCredentials.usedAt,
        revokedAt: founderIdentityRecoveryCredentials.revokedAt,
      })
      .from(founderIdentityRecoveryCredentials)
      .where(eq(founderIdentityRecoveryCredentials.userId, userId))
      .limit(1);
    if (!credential || credential.revokedAt) return { state: "not_created" };
    if (credential.usedAt) return { state: "used", usedAt: credential.usedAt.toISOString() };
    if (credential.expiresAt <= now) {
      return { state: "expired", expiredAt: credential.expiresAt.toISOString() };
    }
    return { state: "ready", expiresAt: credential.expiresAt.toISOString() };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function recoverFounderIdentityWithCredential(input: {
  replacementClerkUserId: string;
  recoveryCode: string;
  signingSecret: string;
  now: Date;
  includeRecoveryStatus?: boolean;
  createConnection?: () => DatabaseConnection;
}): Promise<{
  ownerId: string;
  recoveredAt: string;
  recovery?: FounderIdentityRecoveryStatusDto;
}> {
  assertClerkUserId(input.replacementClerkUserId);
  assertInstant(input.now);
  const parsed = parseRecoveryCode(input.recoveryCode);
  if (!parsed) throw new FounderIdentityRecoveryError("recovery_credential_invalid");
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  const replacementDigest = founderProductContractDigest(`clerk:${input.replacementClerkUserId}`);
  try {
    const [credential] = await connection.db
      .select()
      .from(founderIdentityRecoveryCredentials)
      .where(eq(founderIdentityRecoveryCredentials.id, parsed.credentialId))
      .limit(1);
    if (!credential) throw new FounderIdentityRecoveryError("recovery_credential_invalid");
    const [recovery] = await connection.db
      .select()
      .from(founderIdentityRecoveries)
      .where(
        and(
          eq(founderIdentityRecoveries.userId, credential.userId),
          eq(founderIdentityRecoveries.status, "pending"),
        ),
      )
      .limit(1);
    if (!recovery) throw new FounderIdentityRecoveryError("recovery_not_pending");
    const attemptedDigest = founderProductContractDigest(
      `identity-recovery-credential:${credential.userId}:${parsed.secret}`,
    );
    if (
      credential.credentialDigest !== attemptedDigest ||
      credential.issuedAt > input.now ||
      credential.usedAt ||
      credential.revokedAt ||
      credential.expiresAt <= input.now
    ) {
      await connection.db.transaction((tx) =>
        recordDeniedRecovery(tx, recovery, replacementDigest, attemptedDigest, input.now),
      );
      throw new FounderIdentityRecoveryError(
        credential.expiresAt <= input.now
          ? "recovery_credential_expired"
          : "recovery_credential_invalid",
      );
    }
    const issuedAt = input.now;
    const assertion = signFounderIdentityRecoveryAssertion(
      {
        schema: ASSERTION_SCHEMA,
        recoveryId: recovery.id,
        ownerId: recovery.userId,
        priorClerkSubjectDigest: recovery.priorClerkSubjectDigest as `sha256:${string}`,
        replacementClerkSubjectDigest: replacementDigest,
        evidenceDigest: credential.credentialDigest as `sha256:${string}`,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(
          issuedAt.valueOf() + FOUNDER_IDENTITY_RECOVERY_ASSERTION_LIFETIME_MS,
        ).toISOString(),
      },
      input.signingSecret,
    );
    return await recoverFounderIdentity({
      replacementClerkUserId: input.replacementClerkUserId,
      assertion,
      signingSecret: input.signingSecret,
      now: input.now,
      credentialId: credential.id,
      credentialDigest: credential.credentialDigest as `sha256:${string}`,
      ...(input.includeRecoveryStatus ? { includeRecoveryStatus: true } : {}),
      createConnection: () => connection,
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function recoverFounderIdentityWithCredentialAndStatus(input: {
  replacementClerkUserId: string;
  recoveryCode: string;
  signingSecret: string;
  now: Date;
  createConnection?: () => DatabaseConnection;
}): Promise<{
  recovered: { ownerId: string; recoveredAt: string };
  recovery: FounderIdentityRecoveryStatusDto;
}> {
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  try {
    const recovered = await recoverFounderIdentityWithCredential({
      ...input,
      includeRecoveryStatus: true,
      createConnection: () => connection,
    });
    if (!recovered.recovery) {
      throw new FounderIdentityRecoveryReceiptError(recovered);
    }
    return {
      recovered: { ownerId: recovered.ownerId, recoveredAt: recovered.recoveredAt },
      recovery: recovered.recovery,
    };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function recordFounderIdentityLoss(input: {
  clerkUserId: string;
  providerEventId: string;
  reason: FounderIdentityLossReason;
  observedAt: Date;
  createConnection?: () => DatabaseConnection;
}): Promise<{ recoveryId: string; ownerId: string } | null> {
  assertClerkUserId(input.clerkUserId);
  if (!/^[\x21-\x7e]{1,255}$/.test(input.providerEventId)) {
    throw new Error("Identity provider event ID is invalid.");
  }
  assertInstant(input.observedAt);
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  const priorDigest = founderProductContractDigest(`clerk:${input.clerkUserId}`);
  const providerEventDigest = founderProductContractDigest(
    `clerk:${input.providerEventId}:${input.clerkUserId}:${input.reason}`,
  );

  try {
    return await connection.db.transaction(async (tx) => {
      const [duplicate] = await tx
        .select({
          id: founderIdentityRecoveries.id,
          userId: founderIdentityRecoveries.userId,
          providerEventDigest: founderIdentityRecoveries.providerEventDigest,
        })
        .from(founderIdentityRecoveries)
        .where(eq(founderIdentityRecoveries.providerEventId, input.providerEventId))
        .limit(1);
      if (duplicate) {
        if (duplicate.providerEventDigest !== providerEventDigest) {
          throw new Error("Identity provider event replay did not match its original evidence.");
        }
        return { recoveryId: duplicate.id, ownerId: duplicate.userId };
      }

      await lockClerkUserId(tx, input.clerkUserId);
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkUserId, input.clerkUserId))
        .limit(1)
        .for("update");
      if (!owner) {
        const [pending] = await tx
          .select({ id: founderIdentityRecoveries.id, userId: founderIdentityRecoveries.userId })
          .from(founderIdentityRecoveries)
          .where(
            and(
              eq(founderIdentityRecoveries.status, "pending"),
              eq(founderIdentityRecoveries.priorClerkSubjectDigest, priorDigest),
            ),
          )
          .limit(1);
        return pending ? { recoveryId: pending.id, ownerId: pending.userId } : null;
      }

      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:identity-recovery:${owner.id}`}, 0))`,
      );
      const [existing] = await tx
        .select({ id: founderIdentityRecoveries.id })
        .from(founderIdentityRecoveries)
        .where(
          and(
            eq(founderIdentityRecoveries.userId, owner.id),
            eq(founderIdentityRecoveries.status, "pending"),
          ),
        )
        .limit(1)
        .for("update");
      if (existing) {
        return { recoveryId: existing.id, ownerId: owner.id };
      }

      const [recovery] = await tx
        .insert(founderIdentityRecoveries)
        .values({
          userId: owner.id,
          reason: input.reason,
          priorClerkSubjectDigest: priorDigest,
          providerEventId: input.providerEventId,
          providerEventDigest,
          lossObservedAt: input.observedAt,
          createdAt: input.observedAt,
          updatedAt: input.observedAt,
        })
        .returning({ id: founderIdentityRecoveries.id });
      if (!recovery) throw new Error("Identity recovery state was not persisted.");

      await tx.insert(founderIdentityRecoveryReceipts).values({
        recoveryId: recovery.id,
        userId: owner.id,
        kind: "identity_loss_recorded",
        subjectDigest: priorDigest,
        evidenceDigest: providerEventDigest,
        details: {
          identityProvider: "clerk",
          reason: input.reason,
          operatorAccess: "denied_until_recovered",
          ...IDENTITY_ONLY_RECEIPT_BOUNDARY,
        },
        occurredAt: input.observedAt,
        createdAt: input.observedAt,
      });
      return { recoveryId: recovery.id, ownerId: owner.id };
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function recoverFounderIdentity(input: {
  replacementClerkUserId: string;
  assertion: string;
  signingSecret: string;
  now: Date;
  credentialId?: string;
  credentialDigest?: `sha256:${string}`;
  includeRecoveryStatus?: boolean;
  createConnection?: () => DatabaseConnection;
}): Promise<{
  ownerId: string;
  recoveredAt: string;
  recovery?: FounderIdentityRecoveryStatusDto;
}> {
  assertClerkUserId(input.replacementClerkUserId);
  assertInstant(input.now);
  const payload = verifyFounderIdentityRecoveryAssertion(input.assertion, input.signingSecret);
  const issuedAt = new Date(payload.issuedAt);
  const expiresAt = new Date(payload.expiresAt);
  if (
    issuedAt.valueOf() > input.now.valueOf() + CLOCK_SKEW_MS ||
    expiresAt.valueOf() < input.now.valueOf() ||
    expiresAt.valueOf() - issuedAt.valueOf() > FOUNDER_IDENTITY_RECOVERY_ASSERTION_LIFETIME_MS
  ) {
    throw new FounderIdentityRecoveryError("recovery_assertion_expired");
  }

  const replacementDigest = founderProductContractDigest(`clerk:${input.replacementClerkUserId}`);
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  try {
    const outcome = await connection.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:identity-recovery:${payload.ownerId}`}, 0))`,
      );
      await lockClerkUserId(tx, input.replacementClerkUserId);
      const [recovery] = await tx
        .select()
        .from(founderIdentityRecoveries)
        .where(eq(founderIdentityRecoveries.id, payload.recoveryId))
        .limit(1)
        .for("update");
      if (recovery?.status !== "pending") {
        return { ok: false as const, code: "recovery_not_pending" as const };
      }
      if (recovery.userId !== payload.ownerId) {
        await recordDeniedRecovery(
          tx,
          recovery,
          replacementDigest,
          payload.evidenceDigest,
          input.now,
        );
        return { ok: false as const, code: "recovery_owner_mismatch" as const };
      }
      if (recovery.priorClerkSubjectDigest !== payload.priorClerkSubjectDigest) {
        await recordDeniedRecovery(
          tx,
          recovery,
          replacementDigest,
          payload.evidenceDigest,
          input.now,
        );
        return { ok: false as const, code: "recovery_owner_mismatch" as const };
      }
      if (input.credentialId || input.credentialDigest) {
        if (!input.credentialId || !input.credentialDigest) {
          return { ok: false as const, code: "recovery_credential_invalid" as const };
        }
        const [credential] = await tx
          .select()
          .from(founderIdentityRecoveryCredentials)
          .where(eq(founderIdentityRecoveryCredentials.id, input.credentialId))
          .limit(1)
          .for("update");
        if (
          !credential ||
          credential.userId !== recovery.userId ||
          credential.credentialDigest !== input.credentialDigest ||
          payload.evidenceDigest !== input.credentialDigest ||
          credential.usedAt ||
          credential.revokedAt ||
          credential.expiresAt <= input.now
        ) {
          return { ok: false as const, code: "recovery_credential_invalid" as const };
        }
      }
      if (payload.replacementClerkSubjectDigest !== replacementDigest) {
        await recordDeniedRecovery(
          tx,
          recovery,
          replacementDigest,
          payload.evidenceDigest,
          input.now,
        );
        return { ok: false as const, code: "recovery_subject_mismatch" as const };
      }
      if (replacementDigest === recovery.priorClerkSubjectDigest) {
        await recordDeniedRecovery(
          tx,
          recovery,
          replacementDigest,
          payload.evidenceDigest,
          input.now,
        );
        return { ok: false as const, code: "replacement_identity_required" as const };
      }
      const [mapped] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkUserId, input.replacementClerkUserId))
        .limit(1)
        .for("update");
      if (mapped) {
        await recordDeniedRecovery(
          tx,
          recovery,
          replacementDigest,
          payload.evidenceDigest,
          input.now,
        );
        return { ok: false as const, code: "replacement_identity_already_bound" as const };
      }
      const [currentOwner] = await tx
        .select({ clerkUserId: users.clerkUserId })
        .from(users)
        .where(eq(users.id, recovery.userId))
        .limit(1)
        .for("update");
      if (
        !currentOwner?.clerkUserId ||
        founderProductContractDigest(`clerk:${currentOwner.clerkUserId}`) !==
          recovery.priorClerkSubjectDigest
      ) {
        return { ok: false as const, code: "recovery_not_pending" as const };
      }
      const rebound = await tx
        .update(users)
        .set({ clerkUserId: input.replacementClerkUserId, updatedAt: input.now })
        .where(and(eq(users.id, recovery.userId), eq(users.clerkUserId, currentOwner.clerkUserId)))
        .returning({ id: users.id });
      if (rebound.length !== 1) {
        return { ok: false as const, code: "recovery_not_pending" as const };
      }
      await tx
        .update(founderIdentityRecoveries)
        .set({
          status: "recovered",
          replacementClerkSubjectDigest: replacementDigest,
          recoveredAt: input.now,
          updatedAt: input.now,
        })
        .where(eq(founderIdentityRecoveries.id, recovery.id));
      if (input.credentialId) {
        await tx
          .update(founderIdentityRecoveryCredentials)
          .set({ usedAt: input.now, updatedAt: input.now })
          .where(eq(founderIdentityRecoveryCredentials.id, input.credentialId));
      }
      await tx.insert(founderIdentityRecoveryReceipts).values({
        recoveryId: recovery.id,
        userId: recovery.userId,
        kind: "identity_rebound",
        subjectDigest: replacementDigest,
        evidenceDigest: founderProductContractDigest(
          `identity-rebound:${recovery.id}:${payload.evidenceDigest}:${replacementDigest}`,
        ),
        details: {
          identityProvider: "clerk",
          sameInternalOwnerVerified: true,
          operatorAccess: "restored",
          ...IDENTITY_ONLY_RECEIPT_BOUNDARY,
        },
        occurredAt: input.now,
        createdAt: input.now,
      });
      const receipts = await tx
        .select({
          kind: founderIdentityRecoveryReceipts.kind,
          occurredAt: founderIdentityRecoveryReceipts.occurredAt,
        })
        .from(founderIdentityRecoveryReceipts)
        .where(eq(founderIdentityRecoveryReceipts.recoveryId, recovery.id))
        .orderBy(
          founderIdentityRecoveryReceipts.occurredAt,
          sql`case ${founderIdentityRecoveryReceipts.kind}
            when 'identity_loss_recorded' then 1
            when 'recovery_denied' then 2
            when 'identity_rebound' then 3
          end`,
        );
      return {
        ok: true as const,
        ownerId: recovery.userId,
        recoveredAt: input.now.toISOString(),
        recovery: {
          state: "recovered" as const,
          recoveredAt: input.now.toISOString(),
          receipts: receipts.map((receipt) => ({
            kind: receipt.kind,
            occurredAt: receipt.occurredAt.toISOString(),
          })),
        },
      };
    });
    if (!outcome.ok) throw new FounderIdentityRecoveryError(outcome.code);
    return {
      ownerId: outcome.ownerId,
      recoveredAt: outcome.recoveredAt,
      ...(input.includeRecoveryStatus ? { recovery: outcome.recovery } : {}),
    };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function getFounderIdentityRecoveryStatusForClerkSubject(
  clerkUserId: string,
  dependencies: { createConnection?: () => DatabaseConnection } = {},
): Promise<FounderIdentityRecoveryStatusDto> {
  assertClerkUserId(clerkUserId);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const [owner] = await connection.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkUserId, clerkUserId))
      .limit(1);
    if (!owner) return { state: "proof_required" };
    return await getFounderIdentityRecoveryStatusForUser(owner.id, {
      createConnection: () => connection,
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function getFounderIdentityRecoveryStatusForUser(
  userId: string,
  dependencies: { createConnection?: () => DatabaseConnection } = {},
): Promise<FounderIdentityRecoveryStatusDto> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const [recovery] = await connection.db
      .select()
      .from(founderIdentityRecoveries)
      .where(eq(founderIdentityRecoveries.userId, userId))
      .orderBy(desc(founderIdentityRecoveries.updatedAt))
      .limit(1);
    if (recovery?.status === "pending") return { state: "recovery_required" };
    if (!recovery?.recoveredAt) {
      return { state: "current" };
    }
    const receipts = await connection.db
      .select({
        kind: founderIdentityRecoveryReceipts.kind,
        occurredAt: founderIdentityRecoveryReceipts.occurredAt,
      })
      .from(founderIdentityRecoveryReceipts)
      .where(eq(founderIdentityRecoveryReceipts.recoveryId, recovery.id))
      .orderBy(founderIdentityRecoveryReceipts.occurredAt);
    return {
      state: "recovered",
      recoveredAt: recovery.recoveredAt.toISOString(),
      receipts: receipts.map((receipt) => ({
        kind: receipt.kind,
        occurredAt: receipt.occurredAt.toISOString(),
      })),
    };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export function signFounderIdentityRecoveryAssertion(
  payload: FounderIdentityRecoveryAssertionPayload,
  signingSecret: string,
): string {
  validateAssertionPayload(payload);
  assertSigningSecret(signingSecret);
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", signingSecret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifyFounderIdentityRecoveryAssertion(
  assertion: string,
  signingSecret: string,
): FounderIdentityRecoveryAssertionPayload {
  assertSigningSecret(signingSecret);
  if (assertion.length > 4_096) {
    throw new FounderIdentityRecoveryError("recovery_assertion_invalid");
  }
  const [encodedPayload, encodedSignature, extra] = assertion.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) {
    throw new FounderIdentityRecoveryError("recovery_assertion_invalid");
  }
  const expected = createHmac("sha256", signingSecret).update(encodedPayload).digest();
  let received: Buffer;
  try {
    received = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new FounderIdentityRecoveryError("recovery_assertion_invalid");
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new FounderIdentityRecoveryError("recovery_assertion_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new FounderIdentityRecoveryError("recovery_assertion_invalid");
  }
  validateAssertionPayload(value);
  return value;
}

function validateAssertionPayload(
  value: unknown,
): asserts value is FounderIdentityRecoveryAssertionPayload {
  const allowedKeys = [
    "evidenceDigest",
    "expiresAt",
    "issuedAt",
    "ownerId",
    "priorClerkSubjectDigest",
    "recoveryId",
    "replacementClerkSubjectDigest",
    "schema",
  ];
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== allowedKeys.join("\0") ||
    value.schema !== ASSERTION_SCHEMA ||
    typeof value.recoveryId !== "string" ||
    !isUuid(value.recoveryId) ||
    typeof value.ownerId !== "string" ||
    !isUuid(value.ownerId) ||
    !isDigest(value.priorClerkSubjectDigest) ||
    !isDigest(value.replacementClerkSubjectDigest) ||
    !isDigest(value.evidenceDigest) ||
    !isIsoInstant(value.issuedAt) ||
    !isIsoInstant(value.expiresAt)
  ) {
    throw new FounderIdentityRecoveryError("recovery_assertion_invalid");
  }
}

async function recordDeniedRecovery(
  tx: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  recovery: typeof founderIdentityRecoveries.$inferSelect,
  replacementDigest: `sha256:${string}`,
  proofEvidenceDigest: `sha256:${string}`,
  now: Date,
): Promise<void> {
  await tx
    .insert(founderIdentityRecoveryReceipts)
    .values({
      recoveryId: recovery.id,
      userId: recovery.userId,
      kind: "recovery_denied",
      subjectDigest: replacementDigest,
      evidenceDigest: founderProductContractDigest(
        `identity-recovery-denied:${recovery.id}:${replacementDigest}:${proofEvidenceDigest}`,
      ),
      details: {
        identityProvider: "clerk",
        reason: "strong_same_owner_proof_mismatch",
        operatorAccess: "denied",
        ...IDENTITY_ONLY_RECEIPT_BOUNDARY,
      },
      occurredAt: now,
      createdAt: now,
    })
    .onConflictDoNothing({ target: founderIdentityRecoveryReceipts.evidenceDigest });
}

function assertSigningSecret(value: string): void {
  if (value.length < 32 || value.length > 4_096) {
    throw new FounderIdentityRecoveryError("recovery_assertion_invalid");
  }
}

function assertInstant(value: Date): void {
  if (Number.isNaN(value.valueOf())) throw new Error("Identity recovery time is invalid.");
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseRecoveryCode(value: string): { credentialId: string; secret: string } | null {
  const match = RECOVERY_CODE_PATTERN.exec(value);
  if (!match?.[1] || !match[2] || !isUuid(match[1])) return null;
  return { credentialId: match[1], secret: match[2] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
