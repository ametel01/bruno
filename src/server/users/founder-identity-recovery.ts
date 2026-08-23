import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderIdentityRecoveries,
  founderIdentityRecoveryReceipts,
  users,
} from "@/src/server/db/schema";
import { founderProductContractDigest } from "@/src/server/founder-product-contract/digest";
import { assertClerkUserId, lockClerkUserId } from "@/src/server/users/application-user";

export const FOUNDER_IDENTITY_RECOVERY_ASSERTION_LIFETIME_MS = 15 * 60 * 1_000;
const CLOCK_SKEW_MS = 60 * 1_000;
const ASSERTION_SCHEMA = "bruno.founder-identity-recovery.v1";

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

export class FounderIdentityRecoveryError extends Error {
  constructor(
    readonly code:
      | "recovery_assertion_invalid"
      | "recovery_assertion_expired"
      | "recovery_not_pending"
      | "recovery_owner_mismatch"
      | "recovery_subject_mismatch"
      | "replacement_identity_already_bound"
      | "replacement_identity_required",
  ) {
    super(code);
    this.name = "FounderIdentityRecoveryError";
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
          commerceChanged: false,
          productEntitlementChanged: false,
          accountClosureStarted: false,
          refundStarted: false,
          infrastructureRetirementStarted: false,
          brunoDataDeletionStarted: false,
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
  createConnection?: () => DatabaseConnection;
}): Promise<{ ownerId: string; recoveredAt: string }> {
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
          commerceChanged: false,
          productEntitlementChanged: false,
          accountClosureStarted: false,
          refundStarted: false,
          infrastructureRetirementStarted: false,
          brunoDataDeletionStarted: false,
        },
        occurredAt: input.now,
        createdAt: input.now,
      });
      return {
        ok: true as const,
        ownerId: recovery.userId,
        recoveredAt: input.now.toISOString(),
      };
    });
    if (!outcome.ok) throw new FounderIdentityRecoveryError(outcome.code);
    return { ownerId: outcome.ownerId, recoveredAt: outcome.recoveredAt };
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
    const [recovery] = await connection.db
      .select()
      .from(founderIdentityRecoveries)
      .where(eq(founderIdentityRecoveries.userId, owner.id))
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
        commerceChanged: false,
        productEntitlementChanged: false,
        accountClosureStarted: false,
        refundStarted: false,
        infrastructureRetirementStarted: false,
        brunoDataDeletionStarted: false,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
