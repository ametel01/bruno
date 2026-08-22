import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  operatorActionAuthorizations,
  operatorActionDecisions,
  operatorActionExecutionAttempts,
  operatorActionReceipts,
  operatorMailConnections,
  operatorMailSendingConnections,
  operatorPrimaryCommunicationsSuites,
  operatorProposedActions,
} from "@/src/server/db/schema";
import { FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS } from "@/src/server/founder-product-contract/preview-qualification";
import {
  requireFounderOwnerPreviewAccessForUser,
  requireFounderOwnerPreviewAccessInTransaction,
} from "@/src/server/founder-product-contract/release-stage-access";
import {
  assertFounderExternalActionsNotPausedInTransaction,
  type FounderAiWorkTransaction,
} from "@/src/server/operators/founder-ai-work";
import {
  createGoogleMailSendingAdapter,
  decryptFounderGoogleMailSendingAccessToken,
  type FounderGoogleMailSendingAdapter,
  type FounderMailSendingConnectionDependencies,
  GOOGLE_MAIL_SENDING_PROVIDER,
  isFounderGoogleMailSendingReleased,
  REQUIRED_MAIL_SENDING_SCOPE,
} from "@/src/server/operators/founder-mail-sending-connection";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";
import {
  claimFounderActionAuthorizationForUser,
  type FounderProposedActionDependencies,
  recheckFounderProposedActionForExecution,
  startsFounderExternalEffect,
} from "@/src/server/operators/founder-proposed-actions";

type ExecutionTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

const FOUNDER_MAIL_RECONCILIATION_LEASE_MS = 5 * 60 * 1000;

export type FounderMailExecutionDependencies = FounderProposedActionDependencies &
  Pick<FounderMailSendingConnectionDependencies, "keyring" | "env"> & {
    adapter?: FounderGoogleMailSendingAdapter;
    requireReleaseStageAccess?: typeof requireFounderOwnerPreviewAccessInTransaction;
    requireReleaseStageAccessForUser?: typeof requireFounderOwnerPreviewAccessForUser;
  };

export type FounderActionReceiptDto = {
  id: string;
  proposedActionId: string;
  proposedActionVersion: number;
  provider: typeof GOOGLE_MAIL_SENDING_PROVIDER;
  messageIdentity: string;
  providerMessageId: string | null;
  providerThreadId: string | null;
  attemptCount: number;
  outcome: "succeeded" | "failed" | "outcome_uncertain";
  outcomeReason: string | null;
  createdAt: string;
};

export type FounderMailExecutionResult = {
  status: "succeeded" | "failed" | "outcome_uncertain" | "in_progress";
  receipt: FounderActionReceiptDto | null;
  duplicate: boolean;
};

export class FounderMailExecutionError extends Error {
  readonly code:
    | "mail_sending_not_released"
    | "execution_blocked"
    | "execution_unavailable"
    | "message_invalid";
  readonly status = 409 as const;

  constructor(code: FounderMailExecutionError["code"], message: string) {
    super(message);
    this.name = "FounderMailExecutionError";
    this.code = code;
  }
}

export async function executeFounderApprovedGmailActionForUser(
  userId: string,
  actionId: string,
  expectedVersion: number,
  dependencies: FounderMailExecutionDependencies = {},
): Promise<FounderMailExecutionResult> {
  if (!isFounderGoogleMailSendingReleased(dependencies.env))
    throw new FounderMailExecutionError(
      "mail_sending_not_released",
      "Mail Sending is not available in this Bruno release.",
    );
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createGoogleMailSendingAdapter({ env: dependencies.env });
  if (!adapter.sendMessage)
    throw new FounderMailExecutionError(
      "execution_unavailable",
      "The released Gmail sending transport is not configured safely.",
    );

  try {
    const preflightAt = now();
    if (dependencies.requireReleaseStageAccessForUser) {
      await dependencies.requireReleaseStageAccessForUser(
        userId,
        preflightAt,
        {
          createConnection: () => connection,
          ...(dependencies.env ? { env: dependencies.env } : {}),
        },
        FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.forbidden,
      );
    } else if (!dependencies.requireReleaseStageAccess) {
      await requireFounderOwnerPreviewAccessForUser(
        userId,
        preflightAt,
        {
          createConnection: () => connection,
          ...(dependencies.env ? { env: dependencies.env } : {}),
        },
        FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.forbidden,
      );
    }
    const prepared = await connection.db.transaction(async (tx) => {
      await (
        dependencies.requireReleaseStageAccess ?? requireFounderOwnerPreviewAccessInTransaction
      )(tx, {
        userId,
        now: preflightAt,
        applicationRevision: resolveApplicationRevision(dependencies.env),
        requiredCapabilities: FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.forbidden,
      });
      const [action] = await tx
        .select()
        .from(operatorProposedActions)
        .where(
          and(
            eq(operatorProposedActions.id, actionId),
            eq(operatorProposedActions.operatorId, operator.id),
          ),
        )
        .limit(1);
      if (!action || action.version !== expectedVersion)
        throw new FounderMailExecutionError(
          "execution_blocked",
          "This Proposed Action version is no longer current.",
        );
      if (!startsFounderExternalEffect(action) || action.actionFamily !== "external_communication")
        throw new FounderMailExecutionError(
          "execution_blocked",
          "Only one-to-one external communication can be sent through Gmail.",
        );
      const existing = await selectReceipt(tx, action.id);
      if (existing) return { kind: "receipt" as const, receipt: existing };
      const [started] = await tx
        .select({ attemptNumber: operatorActionExecutionAttempts.attemptNumber })
        .from(operatorActionExecutionAttempts)
        .where(
          and(
            eq(operatorActionExecutionAttempts.proposedActionId, action.id),
            eq(operatorActionExecutionAttempts.phase, "started"),
          ),
        )
        .orderBy(desc(operatorActionExecutionAttempts.attemptNumber))
        .limit(1);
      if (started) return { kind: "in_progress" as const };
      const checkedAt = now();
      const check = await recheckFounderProposedActionForExecution(
        tx,
        operator.id,
        action,
        checkedAt,
      );
      if (check.reason) throw new FounderMailExecutionError("execution_blocked", check.reason);
      await assertFounderExternalActionsNotPausedInTransaction(tx, operator.id, checkedAt);
      const email = parseExactEmail(action.destination, action.materialContent);
      const sending = await selectReadySending(tx, operator.id, checkedAt);
      if (!sending) {
        throw new FounderMailExecutionError(
          "execution_blocked",
          "Mail Sending is Off or its Ready send-only connection is no longer usable.",
        );
      }
      for (const precondition of action.preconditions) {
        if (
          precondition.key !== "mail_sending_ready" &&
          precondition.key !== "external_action_pause_clear"
        )
          throw new FounderMailExecutionError(
            "execution_blocked",
            `The precondition “${precondition.key}” cannot be verified safely at execution time.`,
          );
      }
      const authorization = await selectValidAuthorization(tx, operator.id, action);
      if (!authorization)
        throw new FounderMailExecutionError(
          "execution_blocked",
          "This Proposed Action has no durable authorization.",
        );
      return {
        kind: "ready" as const,
        action,
        authorization,
        sending,
        email,
      };
    });

    if (prepared.kind === "receipt")
      return {
        status: prepared.receipt.outcome,
        receipt: toReceiptDto(prepared.receipt),
        duplicate: true,
      };
    if (prepared.kind === "in_progress")
      return { status: "in_progress", receipt: null, duplicate: true };

    const claim = await claimFounderActionAuthorizationForUser(userId, actionId, expectedVersion, {
      createConnection: () => connection,
      now,
      ...(dependencies.randomUUID ? { randomUUID: dependencies.randomUUID } : {}),
    });

    if (claim.duplicate) {
      const receipt = await connection.db.transaction((tx) => selectReceipt(tx, actionId));
      return receipt
        ? {
            status: receipt.outcome,
            receipt: toReceiptDto(receipt),
            duplicate: true,
          }
        : { status: "in_progress", receipt: null, duplicate: true };
    }

    const started = await connection.db.transaction(async (tx) => {
      const [action] = await tx
        .select()
        .from(operatorProposedActions)
        .where(eq(operatorProposedActions.id, actionId))
        .limit(1);
      if (!action)
        throw new FounderMailExecutionError("execution_unavailable", "Action disappeared.");
      const existing = await selectReceipt(tx, action.id);
      if (existing) return { kind: "receipt" as const, receipt: existing };
      const [existingStart] = await tx
        .select()
        .from(operatorActionExecutionAttempts)
        .where(
          and(
            eq(operatorActionExecutionAttempts.proposedActionId, action.id),
            eq(operatorActionExecutionAttempts.phase, "started"),
          ),
        )
        .orderBy(desc(operatorActionExecutionAttempts.attemptNumber))
        .limit(1);
      if (existingStart) return { kind: "in_progress" as const };
      const checkedAt = now();
      await (
        dependencies.requireReleaseStageAccess ?? requireFounderOwnerPreviewAccessInTransaction
      )(tx, {
        userId,
        now: checkedAt,
        applicationRevision: resolveApplicationRevision(dependencies.env),
        requiredCapabilities: FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.forbidden,
      });
      await assertFounderExternalActionsNotPausedInTransaction(tx, operator.id, checkedAt);
      const check = await recheckFounderProposedActionForExecution(
        tx,
        operator.id,
        action,
        checkedAt,
      );
      if (check.reason) {
        await tx
          .update(operatorProposedActions)
          .set({ state: "blocked", updatedAt: checkedAt })
          .where(eq(operatorProposedActions.id, action.id));
        throw new FounderMailExecutionError("execution_blocked", check.reason);
      }
      const sending = await selectReadySending(tx, operator.id, checkedAt);
      if (!sending) {
        await tx
          .update(operatorProposedActions)
          .set({ state: "blocked", updatedAt: checkedAt })
          .where(eq(operatorProposedActions.id, action.id));
        throw new FounderMailExecutionError(
          "execution_blocked",
          "Mail Sending is Off or its Ready send-only connection is no longer usable.",
        );
      }
      const authorization = await selectValidAuthorization(tx, operator.id, action);
      if (!authorization)
        throw new FounderMailExecutionError("execution_blocked", "Authorization disappeared.");
      const email = parseExactEmail(action.destination, action.materialContent);
      const messageIdentity = buildMessageIdentity(action.id, action.version);
      const rawMessage = buildRawMessage(messageIdentity, email);
      const [attempt] = await tx
        .select({ attemptNumber: operatorActionExecutionAttempts.attemptNumber })
        .from(operatorActionExecutionAttempts)
        .where(eq(operatorActionExecutionAttempts.proposedActionId, action.id))
        .orderBy(desc(operatorActionExecutionAttempts.attemptNumber))
        .limit(1);
      const attemptNumber = (attempt?.attemptNumber ?? 0) + 1;
      await tx.insert(operatorActionExecutionAttempts).values({
        id: (dependencies.randomUUID ?? randomUUID)(),
        operatorId: operator.id,
        proposedActionId: action.id,
        authorizationId: authorization.id,
        attemptNumber,
        phase: "started",
        provider: GOOGLE_MAIL_SENDING_PROVIDER,
        messageIdentity,
        requestDigest: digest(rawMessage),
        createdAt: checkedAt,
      });
      return {
        kind: "started" as const,
        action,
        authorization,
        sending,
        email,
        messageIdentity,
        rawMessage,
        attemptNumber,
      };
    });

    if (started.kind === "receipt")
      return {
        status: started.receipt.outcome,
        receipt: toReceiptDto(started.receipt),
        duplicate: true,
      };
    if (started.kind === "in_progress")
      return { status: "in_progress", receipt: null, duplicate: true };

    await assertFounderMailSubmissionStillReady(
      connection,
      userId,
      operator.id,
      actionId,
      expectedVersion,
      started,
      now,
      dependencies.env,
      dependencies.requireReleaseStageAccess,
    );

    let result: Awaited<ReturnType<NonNullable<FounderGoogleMailSendingAdapter["sendMessage"]>>>;
    try {
      result = await adapter.sendMessage({
        accessToken: decryptFounderGoogleMailSendingAccessToken(started.sending, dependencies),
        rawMessage: started.rawMessage,
      });
    } catch (error) {
      return finalizeExecution(
        connection,
        operator.id,
        started,
        {
          outcome: "outcome_uncertain",
          reason: error instanceof Error ? error.message : "Gmail did not prove the outcome.",
        },
        now,
      );
    }
    if (!result.ok)
      return finalizeExecution(
        connection,
        operator.id,
        started,
        {
          outcome: "failed",
          reason: result.message,
          errorCode: result.code,
        },
        now,
      );
    return finalizeExecution(
      connection,
      operator.id,
      started,
      {
        outcome: "succeeded",
        providerMessageId: result.providerMessageId,
        providerThreadId: result.providerThreadId,
        reason: null,
      },
      now,
    );
  } finally {
    if (ownsConnection) await connection.close();
  }
}

/**
 * Resolve a durable started attempt after a worker restart without contacting Gmail again.
 * The provider result is intentionally marked uncertain because the request may already have
 * been accepted before the worker lost its response.
 */
export async function reconcileFounderGmailActionForUser(
  userId: string,
  actionId: string,
  dependencies: FounderMailExecutionDependencies = {},
): Promise<FounderMailExecutionResult> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  try {
    const pending = await connection.db.transaction(async (tx) => {
      const [action] = await tx
        .select()
        .from(operatorProposedActions)
        .where(
          and(
            eq(operatorProposedActions.id, actionId),
            eq(operatorProposedActions.operatorId, operator.id),
          ),
        )
        .limit(1);
      if (!action)
        throw new FounderMailExecutionError("execution_unavailable", "Action disappeared.");
      const existing = await selectReceipt(tx, action.id);
      if (existing) return { kind: "receipt" as const, receipt: existing };
      const [started] = await tx
        .select()
        .from(operatorActionExecutionAttempts)
        .where(
          and(
            eq(operatorActionExecutionAttempts.proposedActionId, action.id),
            eq(operatorActionExecutionAttempts.phase, "started"),
          ),
        )
        .orderBy(desc(operatorActionExecutionAttempts.attemptNumber))
        .limit(1);
      if (!started)
        throw new FounderMailExecutionError(
          "execution_unavailable",
          "No pending execution needs reconciliation.",
        );
      if (started.createdAt.getTime() > now().getTime() - FOUNDER_MAIL_RECONCILIATION_LEASE_MS)
        throw new FounderMailExecutionError(
          "execution_unavailable",
          "This execution is still within its provider response lease.",
        );
      const [[authorization], [sending]] = await Promise.all([
        tx
          .select()
          .from(operatorActionAuthorizations)
          .where(eq(operatorActionAuthorizations.id, started.authorizationId))
          .limit(1),
        tx
          .select()
          .from(operatorMailSendingConnections)
          .where(
            and(
              eq(operatorMailSendingConnections.operatorId, operator.id),
              eq(operatorMailSendingConnections.provider, GOOGLE_MAIL_SENDING_PROVIDER),
            ),
          )
          .limit(1),
      ]);
      if (!authorization || !sending)
        throw new FounderMailExecutionError(
          "execution_unavailable",
          "Execution evidence is incomplete.",
        );
      const email = parseExactEmail(action.destination, action.materialContent);
      return {
        kind: "started" as const,
        action,
        authorization,
        sending,
        messageIdentity: started.messageIdentity,
        attemptNumber: started.attemptNumber,
        rawMessage: buildRawMessage(started.messageIdentity, email),
      };
    });
    if (pending.kind === "receipt")
      return {
        status: pending.receipt.outcome,
        receipt: toReceiptDto(pending.receipt),
        duplicate: true,
      };
    return finalizeExecution(
      connection,
      operator.id,
      pending,
      {
        outcome: "outcome_uncertain",
        reason: "The execution worker stopped before Gmail provided a verifiable outcome.",
      },
      now,
    );
  } finally {
    if (ownsConnection) await connection.close();
  }
}

type PreparedEmail = { recipient: string; subject: string; body: string };

function parseExactEmail(
  destination: Record<string, unknown>,
  materialContent: Record<string, unknown>,
): PreparedEmail {
  const recipient = typeof destination.recipient === "string" ? destination.recipient.trim() : "";
  const subject = typeof materialContent.subject === "string" ? materialContent.subject : "";
  const body = typeof materialContent.body === "string" ? materialContent.body : "";
  if (!recipient || recipient.includes(",") || recipient.includes("\n") || recipient.includes("\r"))
    throw new FounderMailExecutionError(
      "message_invalid",
      "Exactly one valid Gmail recipient is required.",
    );
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))
    throw new FounderMailExecutionError("message_invalid", "The Gmail recipient is invalid.");
  if (!subject.trim() || subject.includes("\n") || subject.includes("\r") || !body.trim())
    throw new FounderMailExecutionError(
      "message_invalid",
      "Subject and message content are required.",
    );
  if (destination.cc || destination.bcc || Array.isArray(destination.recipients))
    throw new FounderMailExecutionError(
      "message_invalid",
      "One approved message cannot contain batch recipients.",
    );
  return { recipient, subject, body };
}

function buildRawMessage(identity: string, email: PreparedEmail): string {
  return [
    `To: ${email.recipient}`,
    `Subject: ${email.subject}`,
    `Message-ID: <${identity}@bruno.ai>`,
    `X-Bruno-Message-Identity: ${identity}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    email.body,
  ].join("\r\n");
}

function buildMessageIdentity(actionId: string, version: number): string {
  return `bruno-gmail-message-${actionId}-v${version}`;
}

async function selectReadySending(tx: FounderAiWorkTransaction, operatorId: string, at: Date) {
  const [sending] = await tx
    .select()
    .from(operatorMailSendingConnections)
    .where(
      and(
        eq(operatorMailSendingConnections.operatorId, operatorId),
        eq(operatorMailSendingConnections.provider, GOOGLE_MAIL_SENDING_PROVIDER),
        eq(operatorMailSendingConnections.status, "ready"),
        eq(operatorMailSendingConnections.authorizationState, "authorized"),
      ),
    )
    .limit(1);
  if (
    !sending?.accessTokenCiphertext ||
    !sending.refreshTokenCiphertext ||
    !sending.grantedScopes.includes(REQUIRED_MAIL_SENDING_SCOPE) ||
    sending.revokedAt ||
    !sending.tokenExpiresAt ||
    sending.tokenExpiresAt <= at
  )
    return null;
  const [[mail], [suite]] = await Promise.all([
    tx
      .select()
      .from(operatorMailConnections)
      .where(eq(operatorMailConnections.operatorId, operatorId))
      .limit(1),
    tx
      .select()
      .from(operatorPrimaryCommunicationsSuites)
      .where(eq(operatorPrimaryCommunicationsSuites.operatorId, operatorId))
      .limit(1),
  ]);
  if (
    mail?.status !== "ready" ||
    mail.authorizationState !== "authorized" ||
    mail.revokedAt ||
    mail.providerSubjectId !== sending.providerSubjectId ||
    suite?.status !== "active" ||
    suite.mailConnectionId !== mail.id ||
    sending.mailConnectionId !== mail.id
  )
    return null;
  return sending;
}

async function selectValidAuthorization(
  tx: ExecutionTransaction,
  operatorId: string,
  action: typeof operatorProposedActions.$inferSelect,
) {
  const [authorization] = await tx
    .select({ authorization: operatorActionAuthorizations })
    .from(operatorActionAuthorizations)
    .innerJoin(
      operatorActionDecisions,
      eq(operatorActionDecisions.id, operatorActionAuthorizations.decisionId),
    )
    .where(
      and(
        eq(operatorActionAuthorizations.operatorId, operatorId),
        eq(operatorActionAuthorizations.proposedActionId, action.id),
        eq(operatorActionDecisions.operatorId, operatorId),
        eq(operatorActionDecisions.proposedActionId, action.id),
        eq(operatorActionDecisions.proposedActionVersion, action.version),
        eq(operatorActionDecisions.kind, "approve"),
      ),
    )
    .limit(1);
  return authorization?.authorization ?? null;
}

async function selectReceipt(tx: ExecutionTransaction, proposedActionId: string) {
  const [receipt] = await tx
    .select()
    .from(operatorActionReceipts)
    .where(eq(operatorActionReceipts.proposedActionId, proposedActionId))
    .limit(1);
  return receipt ?? null;
}

async function assertFounderMailSubmissionStillReady(
  connection: DatabaseConnection,
  userId: string,
  operatorId: string,
  actionId: string,
  expectedVersion: number,
  started: {
    action: typeof operatorProposedActions.$inferSelect;
    authorization: typeof operatorActionAuthorizations.$inferSelect;
    sending: typeof operatorMailSendingConnections.$inferSelect;
  },
  now: () => Date,
  environment: Record<string, string | undefined> | undefined,
  requireReleaseStageAccess: typeof requireFounderOwnerPreviewAccessInTransaction | undefined,
): Promise<void> {
  await connection.db.transaction(async (tx) => {
    const checkedAt = now();
    await (requireReleaseStageAccess ?? requireFounderOwnerPreviewAccessInTransaction)(tx, {
      userId,
      now: checkedAt,
      applicationRevision: resolveApplicationRevision(environment),
      requiredCapabilities: FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.forbidden,
    });
    const [action] = await tx
      .select()
      .from(operatorProposedActions)
      .where(
        and(
          eq(operatorProposedActions.id, actionId),
          eq(operatorProposedActions.operatorId, operatorId),
        ),
      )
      .limit(1);
    if (!action || action.version !== expectedVersion)
      throw new FounderMailExecutionError("execution_blocked", "The approved action changed.");
    const check = await recheckFounderProposedActionForExecution(tx, operatorId, action, checkedAt);
    if (check.reason) throw new FounderMailExecutionError("execution_blocked", check.reason);
    await assertFounderExternalActionsNotPausedInTransaction(tx, operatorId, checkedAt);
    const sending = await selectReadySending(tx, operatorId, checkedAt);
    if (
      !sending ||
      sending.id !== started.sending.id ||
      sending.authorizationGeneration !== started.sending.authorizationGeneration
    )
      throw new FounderMailExecutionError(
        "execution_blocked",
        "The Ready send-only connection changed before submission.",
      );
    const authorization = await selectValidAuthorization(tx, operatorId, action);
    if (!authorization || authorization.id !== started.authorization.id)
      throw new FounderMailExecutionError(
        "execution_blocked",
        "The approval changed before submission.",
      );
  });
}

function resolveApplicationRevision(
  environment: Record<string, string | undefined> | undefined,
): string {
  return (
    environment?.VERCEL_GIT_COMMIT_SHA?.trim() ?? process.env.VERCEL_GIT_COMMIT_SHA?.trim() ?? ""
  );
}

async function finalizeExecution(
  connection: DatabaseConnection,
  operatorId: string,
  started: {
    action: typeof operatorProposedActions.$inferSelect;
    authorization: typeof operatorActionAuthorizations.$inferSelect;
    sending: typeof operatorMailSendingConnections.$inferSelect;
    messageIdentity: string;
    attemptNumber: number;
    rawMessage: string;
  },
  result: {
    outcome: "succeeded" | "failed" | "outcome_uncertain";
    providerMessageId?: string;
    providerThreadId?: string | null;
    reason: string | null;
    errorCode?: string;
  },
  now: () => Date,
): Promise<FounderMailExecutionResult> {
  const receipt = await connection.db.transaction(async (tx) => {
    const existing = await selectReceipt(tx, started.action.id);
    if (existing) return existing;
    const at = now();
    const phase =
      result.outcome === "succeeded"
        ? "acknowledged"
        : result.outcome === "failed"
          ? "rejected"
          : "ambiguous";
    await tx.insert(operatorActionExecutionAttempts).values({
      id: randomUUID(),
      operatorId,
      proposedActionId: started.action.id,
      authorizationId: started.authorization.id,
      attemptNumber: started.attemptNumber,
      phase,
      provider: GOOGLE_MAIL_SENDING_PROVIDER,
      messageIdentity: started.messageIdentity,
      providerMessageId: result.providerMessageId ?? null,
      providerThreadId: result.providerThreadId ?? null,
      requestDigest: digest(started.rawMessage),
      responseDigest: result.providerMessageId
        ? digest({ id: result.providerMessageId, threadId: result.providerThreadId ?? null })
        : null,
      errorCode: result.errorCode,
      createdAt: at,
    });
    const [saved] = await tx
      .insert(operatorActionReceipts)
      .values({
        id: randomUUID(),
        operatorId,
        proposedActionId: started.action.id,
        proposedActionVersion: started.action.version,
        authorityPolicyId: started.action.authorityPolicyId,
        authorityPolicyVersion: started.action.authorityPolicyVersion,
        decisionId: started.authorization.decisionId,
        authorizationId: started.authorization.id,
        provider: GOOGLE_MAIL_SENDING_PROVIDER,
        providerConnectionId: started.sending.id,
        providerConnectionGeneration: started.sending.authorizationGeneration,
        connectionAccessVersion: started.action.connectionAccessVersion,
        connectionResourceId: started.action.connectionResourceId,
        processingConsentId: started.action.processingConsentId,
        processingConsentVersion: started.action.processingConsentVersion,
        messageIdentity: started.messageIdentity,
        contentDigest: digest(started.action.materialContent),
        destinationDigest: digest(started.action.destination),
        providerMessageId: result.providerMessageId ?? null,
        providerThreadId: result.providerThreadId ?? null,
        attemptCount: started.attemptNumber,
        outcome: result.outcome,
        outcomeReason: result.reason,
        acknowledgedAt: result.outcome === "succeeded" ? at : null,
        evidenceDigest: digest({
          proposedActionId: started.action.id,
          version: started.action.version,
          policyVersion: started.action.authorityPolicyVersion,
          decisionId: started.authorization.decisionId,
          attemptNumber: started.attemptNumber,
          messageIdentity: started.messageIdentity,
          providerMessageId: result.providerMessageId ?? null,
          outcome: result.outcome,
        }),
        createdAt: at,
      })
      .returning();
    if (!saved)
      throw new FounderMailExecutionError(
        "execution_unavailable",
        "Action Receipt could not be saved.",
      );
    await tx
      .update(operatorProposedActions)
      .set({ state: result.outcome === "succeeded" ? "succeeded" : result.outcome, updatedAt: at })
      .where(eq(operatorProposedActions.id, started.action.id));
    return saved;
  });
  return {
    status: receipt.outcome,
    receipt: toReceiptDto(receipt),
    duplicate: false,
  };
}

function toReceiptDto(
  receipt: typeof operatorActionReceipts.$inferSelect,
): FounderActionReceiptDto {
  return {
    id: receipt.id,
    proposedActionId: receipt.proposedActionId,
    proposedActionVersion: receipt.proposedActionVersion,
    provider: GOOGLE_MAIL_SENDING_PROVIDER,
    messageIdentity: receipt.messageIdentity,
    providerMessageId: receipt.providerMessageId,
    providerThreadId: receipt.providerThreadId,
    attemptCount: receipt.attemptCount,
    outcome: receipt.outcome,
    outcomeReason: receipt.outcomeReason,
    createdAt: receipt.createdAt.toISOString(),
  };
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
