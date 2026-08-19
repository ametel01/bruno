import "server-only";

import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorAiConnectionReceipts,
  operatorAiConnections,
  operatorProcessingConsents,
  operators,
} from "@/src/server/db/schema";
import type { FounderAiProvider } from "@/src/server/operators/founder-ai-routing";
import { routeFounderAiProvider } from "@/src/server/operators/founder-ai-routing";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";
import {
  deriveFounderConnectionRecovery,
  type FounderRecoveryDto,
} from "@/src/server/operators/founder-recovery";

type FounderAiConnectionTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

const OPENAI_PROVIDER = "openai" as const;
const DEFAULT_APPROVED_MODEL = "openai-codex" as const;
const ANTHROPIC_PROVIDER = "anthropic" as const;
const DEFAULT_ANTHROPIC_MODEL = "anthropic-claude" as const;

export type FounderAiConnectionStatus =
  | "authorizing"
  | "verifying"
  | "ready"
  | "needs_attention"
  | "paused"
  | "disconnected";

export type FounderAiConnectionDto = {
  provider: FounderAiProvider;
  status: FounderAiConnectionStatus;
  accountLabel: string | null;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  workState: "available" | "paused";
  recoveryMessage: string | null;
  recovery?: FounderRecoveryDto | null;
  receipt: {
    provider: FounderAiProvider;
    accountLabel: string | null;
    outcome: "connected" | "reconnected" | "disconnected" | "needs_attention";
    issuedAt: string;
  } | null;
};

export type FounderOpenAiReadinessInput = {
  providerIdentity: string | null;
  eligibleAccount: boolean;
  accountLabel: string | null;
  authorizationPersisted: boolean;
  approvedModelAssigned: boolean;
  capacity: "available" | "exhausted" | "unavailable";
  inference: "passed" | "failed";
  authorizationState?: "authorized" | "denied" | "expired";
};

export type FounderAiReadinessInput = FounderOpenAiReadinessInput & {
  billingVerified?: boolean;
  privacyAccepted?: boolean;
  retentionBounded?: boolean;
  thirdPartyPermissionGranted?: boolean;
  credentialHealthy?: boolean;
  reconnectSupported?: boolean;
  productionUseApproved?: boolean;
  processingConsentActive?: boolean;
};

export type FounderAiReadinessResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "authorization_denied"
        | "authorization_expired"
        | "provider_identity_missing"
        | "provider_identity_changed"
        | "account_label_missing"
        | "account_not_eligible"
        | "authorization_not_persisted"
        | "approved_model_missing"
        | "billing_unverified"
        | "privacy_not_accepted"
        | "retention_unbounded"
        | "third_party_permission_missing"
        | "credential_unhealthy"
        | "reconnect_unsupported"
        | "production_use_unapproved"
        | "processing_consent_missing"
        | "capacity_unavailable"
        | "inference_failed";
    };

export type FounderAnthropicCompatibilityInput = {
  subscriptionPlan: "claude_max" | "claude_pro" | "unknown";
  extraUsageCredits: boolean;
  privacyReviewed: boolean;
  retentionReviewed: boolean;
  thirdPartyPermissionReviewed: boolean;
  credentialStorageReviewed: boolean;
  reconnectReviewed: boolean;
  productionUseReviewed: boolean;
};

export type FounderAnthropicCompatibilityResult =
  | { released: true }
  | {
      released: false;
      code:
        | "subscription_ineligible"
        | "extra_usage_credits_missing"
        | "privacy_unreviewed"
        | "retention_unreviewed"
        | "third_party_permission_unreviewed"
        | "credential_storage_unreviewed"
        | "reconnect_unreviewed"
        | "production_use_unreviewed";
    };

export type FounderOpenAiReadinessResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "authorization_denied"
        | "authorization_expired"
        | "provider_identity_missing"
        | "provider_identity_changed"
        | "account_label_missing"
        | "account_not_eligible"
        | "authorization_not_persisted"
        | "approved_model_missing"
        | "billing_unverified"
        | "privacy_not_accepted"
        | "retention_unbounded"
        | "third_party_permission_missing"
        | "credential_unhealthy"
        | "reconnect_unsupported"
        | "production_use_unapproved"
        | "processing_consent_missing"
        | "capacity_unavailable"
        | "inference_failed";
    };

export type FounderOpenAiAuthorizationStart = {
  sessionId: string;
  authorizationUrl: string;
  userCode: string;
  expiresAt: Date;
};

export type FounderOpenAiAuthorizationPoll =
  | { state: "pending" }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "authorized"; providerIdentity: string; accountLabel: string | null };

export type FounderOpenAiVerification = FounderAiReadinessInput & {
  accountLabel: string | null;
};

export type FounderAiAdapter = {
  startAuthorization(input: {
    operatorId: string;
    userId: string;
    reconnecting: boolean;
  }): Promise<
    | { ok: true; authorization: FounderOpenAiAuthorizationStart }
    | { ok: false; code: string; message: string }
  >;
  pollAuthorization(input: {
    operatorId: string;
    userId: string;
    sessionId: string;
  }): Promise<FounderOpenAiAuthorizationPoll>;
  verifyConnection(input: {
    operatorId: string;
    userId: string;
    providerIdentity: string;
  }): Promise<FounderAiReadinessInput & { accountLabel: string | null }>;
  revokeAuthorization(input: {
    operatorId: string;
    userId: string;
    providerIdentity: string | null;
  }): Promise<{ providerRevoked: boolean }>;
};

export type FounderOpenAiAdapter = {
  startAuthorization(input: {
    operatorId: string;
    userId: string;
    reconnecting: boolean;
  }): Promise<
    | { ok: true; authorization: FounderOpenAiAuthorizationStart }
    | { ok: false; code: string; message: string }
  >;
  pollAuthorization(input: {
    operatorId: string;
    userId: string;
    sessionId: string;
  }): Promise<FounderOpenAiAuthorizationPoll>;
  verifyConnection(input: {
    operatorId: string;
    userId: string;
    providerIdentity: string;
  }): Promise<FounderOpenAiVerification>;
  revokeAuthorization(input: {
    operatorId: string;
    userId: string;
    providerIdentity: string | null;
  }): Promise<{ providerRevoked: boolean }>;
};

export type FounderAnthropicAdapter = FounderAiAdapter;

export type FounderAiConnectionDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  adapter?: FounderOpenAiAdapter;
  /** Test/release harness override; production keeps Anthropic hidden by default. */
  anthropicReleased?: boolean;
};

export type FounderOpenAiAuthorizationResult = {
  connection: FounderAiConnectionDto;
  authorization: {
    sessionId: string;
    authorizationUrl: string;
    userCode: string;
    expiresAt: string;
  } | null;
};

export type FounderAnthropicAuthorizationResult = FounderOpenAiAuthorizationResult;

/**
 * Anthropic remains hidden unless the deployment explicitly enables the
 * provider program. Account-level compatibility and readiness gates still
 * have to pass before a connection can become Ready.
 */
export const FOUNDER_ANTHROPIC_CONNECTION_RELEASED =
  process.env.BRUNO_ANTHROPIC_CONNECTION_RELEASED === "true";

export class FounderAiConnectionError extends Error {
  readonly code: string;
  readonly status: 400 | 409 | 503;

  constructor(code: string, message: string, status: 400 | 409 | 503 = 409) {
    super(message);
    this.name = "FounderAiConnectionError";
    this.code = code;
    this.status = status;
  }
}

export function evaluateFounderOpenAiReadiness(
  input: FounderOpenAiReadinessInput,
): FounderOpenAiReadinessResult {
  if (input.authorizationState === "denied") return { ok: false, code: "authorization_denied" };
  if (input.authorizationState === "expired") {
    return { ok: false, code: "authorization_expired" };
  }
  if (!input.providerIdentity) return { ok: false, code: "provider_identity_missing" };
  if (!input.accountLabel) return { ok: false, code: "account_label_missing" };
  if (!input.eligibleAccount) return { ok: false, code: "account_not_eligible" };
  if (!input.authorizationPersisted) {
    return { ok: false, code: "authorization_not_persisted" };
  }
  if (!input.approvedModelAssigned) return { ok: false, code: "approved_model_missing" };
  if (input.capacity !== "available") return { ok: false, code: "capacity_unavailable" };
  if (input.inference !== "passed") return { ok: false, code: "inference_failed" };
  return { ok: true };
}

export function evaluateFounderAiReadiness(
  input: FounderAiReadinessInput,
  provider: FounderAiProvider,
): FounderAiReadinessResult {
  const legacy = evaluateFounderOpenAiReadiness(input);
  if (!legacy.ok) return legacy;
  if (provider === "openai") return { ok: true };
  if (input.billingVerified !== true) return { ok: false, code: "billing_unverified" };
  if (input.privacyAccepted !== true) return { ok: false, code: "privacy_not_accepted" };
  if (input.retentionBounded !== true) return { ok: false, code: "retention_unbounded" };
  if (input.thirdPartyPermissionGranted !== true) {
    return { ok: false, code: "third_party_permission_missing" };
  }
  if (input.credentialHealthy !== true) return { ok: false, code: "credential_unhealthy" };
  if (input.reconnectSupported !== true) return { ok: false, code: "reconnect_unsupported" };
  if (input.productionUseApproved !== true) {
    return { ok: false, code: "production_use_unapproved" };
  }
  if (input.processingConsentActive !== true) {
    return { ok: false, code: "processing_consent_missing" };
  }
  return { ok: true };
}

export function evaluateFounderAnthropicCompatibility(
  input: FounderAnthropicCompatibilityInput,
): FounderAnthropicCompatibilityResult {
  if (input.subscriptionPlan !== "claude_max") {
    return { released: false, code: "subscription_ineligible" };
  }
  if (!input.extraUsageCredits) return { released: false, code: "extra_usage_credits_missing" };
  if (!input.privacyReviewed) return { released: false, code: "privacy_unreviewed" };
  if (!input.retentionReviewed) return { released: false, code: "retention_unreviewed" };
  if (!input.thirdPartyPermissionReviewed) {
    return { released: false, code: "third_party_permission_unreviewed" };
  }
  if (!input.credentialStorageReviewed) {
    return { released: false, code: "credential_storage_unreviewed" };
  }
  if (!input.reconnectReviewed) return { released: false, code: "reconnect_unreviewed" };
  if (!input.productionUseReviewed) {
    return { released: false, code: "production_use_unreviewed" };
  }
  return { released: true };
}

export async function getFounderAiConnectionForUser(
  userId: string,
  dependencies: Pick<FounderAiConnectionDependencies, "createConnection"> = {},
): Promise<FounderAiConnectionDto | null> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      const operator = await selectOperator(tx, userId);
      if (!operator) return null;
      const row = await selectConnection(tx, operator.id);
      return row ? toConnectionDto(row.connection, row.receipt) : null;
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

/**
 * Downstream work must use this gate rather than selecting an alternate or
 * Bruno-funded provider when OpenAI is unavailable.
 */
export async function requireReadyFounderOpenAiConnectionForUser(
  userId: string,
  dependencies: FounderAiConnectionDependencies = {},
): Promise<FounderAiConnectionDto> {
  const connection = await recheckFounderOpenAiConnectionForUser(userId, dependencies);
  if (connection?.status !== "ready") {
    throw new FounderAiConnectionError(
      "ai_connection_paused",
      connection?.recoveryMessage ?? "OpenAI is not ready. Bruno paused work until you reconnect.",
      409,
    );
  }
  return connection;
}

/**
 * General work must route through the active compatibility policy rather than
 * assuming that the OpenAI OAuth connection is the only released account.
 */
export async function requireReadyFounderAiConnectionForUser(
  userId: string,
  dependencies: Pick<FounderAiConnectionDependencies, "createConnection" | "now"> = {},
): Promise<FounderAiConnectionDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const routed = await connection.db.transaction(async (tx) => {
      const decision = await routeFounderAiProvider(tx, operator.id, {
        now: dependencies.now?.() ?? new Date(),
      });
      if (!decision) return null;
      const [row] = await tx
        .select()
        .from(operatorAiConnections)
        .where(eq(operatorAiConnections.id, decision.connectionId))
        .limit(1);
      if (!row) return null;
      const [receipt] = await tx
        .select()
        .from(operatorAiConnectionReceipts)
        .where(eq(operatorAiConnectionReceipts.connectionId, row.id))
        .orderBy(
          desc(operatorAiConnectionReceipts.createdAt),
          desc(operatorAiConnectionReceipts.id),
        )
        .limit(1);
      return { connection: row, receipt: receipt ?? null };
    });
    if (!routed) {
      throw new FounderAiConnectionError(
        "ai_connection_paused",
        "No connected compatible AI provider is ready. Bruno paused work until one is available.",
        409,
      );
    }
    return toConnectionDto(routed.connection, routed.receipt);
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function startFounderOpenAiAuthorizationForUser(
  userId: string,
  dependencies: FounderAiConnectionDependencies = {},
): Promise<FounderOpenAiAuthorizationResult> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  if (operator.preparation.status !== "ready" || operator.runtime?.status !== "ready") {
    throw new FounderAiConnectionError(
      "operator_not_ready",
      "Bruno is still preparing your private workspace. Try again when it is ready.",
      409,
    );
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createHermesOpenAiAdapter();

  try {
    const current = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      return selectConnection(tx, operator.id, true, "openai");
    });
    if (current?.connection.status === "ready") {
      return {
        connection: toConnectionDto(current.connection, current.receipt),
        authorization: null,
      };
    }

    const started = await adapter.startAuthorization({
      operatorId: operator.id,
      userId,
      reconnecting: Boolean(current?.connection.providerSubjectId),
    });
    if (!started.ok) {
      const failed = await updateConnectionFailure({
        connection,
        operatorId: operator.id,
        now: now(),
        code: started.code,
        message: started.message,
        authorizationState: "pending",
      });
      return { connection: failed, authorization: null };
    }

    const startedAt = now();
    const generation = current
      ? current.connection.status === "authorizing"
        ? current.connection.authorizationGeneration
        : current.connection.authorizationGeneration + 1
      : 1;
    const sessionHash = digestOpaqueValue(started.authorization.sessionId);
    const row = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const existing = await selectConnection(tx, operator.id, true, "openai");
      if (existing) {
        const [updated] = await tx
          .update(operatorAiConnections)
          .set({
            status: "authorizing",
            authorizationState: "pending",
            authorizationSessionHash: sessionHash,
            authorizationExpiresAt: started.authorization.expiresAt,
            authorizationGeneration: generation,
            failureCode: null,
            recoveryMessage: null,
            workPausedReason: null,
            updatedAt: startedAt,
          })
          .where(eq(operatorAiConnections.id, existing.connection.id))
          .returning();
        return updated;
      }
      const [created] = await tx
        .insert(operatorAiConnections)
        .values({
          operatorId: operator.id,
          provider: OPENAI_PROVIDER,
          status: "authorizing",
          authorizationState: "pending",
          authorizationSessionHash: sessionHash,
          authorizationExpiresAt: started.authorization.expiresAt,
          authorizationGeneration: generation,
          createdAt: startedAt,
          updatedAt: startedAt,
        })
        .returning();
      return created;
    });
    if (!row)
      throw new FounderAiConnectionError(
        "connection_unavailable",
        "Connection could not be started.",
        503,
      );
    return {
      connection: toConnectionDto(row, null),
      authorization: {
        sessionId: started.authorization.sessionId,
        authorizationUrl: started.authorization.authorizationUrl,
        userCode: started.authorization.userCode,
        expiresAt: started.authorization.expiresAt.toISOString(),
      },
    };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function pollFounderOpenAiAuthorizationForUser(
  userId: string,
  sessionId: string,
  dependencies: FounderAiConnectionDependencies = {},
): Promise<FounderAiConnectionDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createHermesOpenAiAdapter();

  try {
    const current = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      return selectConnection(tx, operator.id, true, "openai");
    });
    if (!current?.connection.authorizationSessionHash) {
      throw new FounderAiConnectionError(
        "authorization_not_found",
        "That authorization has expired.",
        400,
      );
    }
    if (current.connection.authorizationSessionHash !== digestOpaqueValue(sessionId)) {
      throw new FounderAiConnectionError(
        "authorization_session_mismatch",
        "That authorization is no longer active.",
        400,
      );
    }

    const outcome = await adapter.pollAuthorization({ operatorId: operator.id, userId, sessionId });
    if (outcome.state === "pending") return toConnectionDto(current.connection, current.receipt);
    if (outcome.state === "denied" || outcome.state === "expired") {
      return updateConnectionFailure({
        connection,
        operatorId: operator.id,
        now: now(),
        code: outcome.state === "denied" ? "authorization_denied" : "authorization_expired",
        message:
          outcome.state === "denied"
            ? "OpenAI authorization was declined. You can try connecting again."
            : "OpenAI authorization expired. Start again to reconnect.",
        authorizationState: outcome.state,
      });
    }

    const verification = await adapter.verifyConnection({
      operatorId: operator.id,
      userId,
      providerIdentity: outcome.providerIdentity,
    });
    if (verification.providerIdentity !== outcome.providerIdentity) {
      return updateConnectionFailure({
        connection,
        operatorId: operator.id,
        now: now(),
        code: "provider_identity_changed",
        message:
          "OpenAI returned a different account identity. Reconnect the account already connected to Bruno.",
        authorizationState: "authorized",
        providerIdentity: current.connection.providerSubjectId,
        accountLabel: current.connection.accountLabel,
      });
    }
    const readiness = evaluateFounderOpenAiReadiness(verification);
    if (
      current.connection.providerSubjectId &&
      current.connection.providerSubjectId !== outcome.providerIdentity
    ) {
      return updateConnectionFailure({
        connection,
        operatorId: operator.id,
        now: now(),
        code: "provider_identity_changed",
        message:
          "This is a different OpenAI account. Reconnect the account already connected to Bruno.",
        authorizationState: "authorized",
        providerIdentity: current.connection.providerSubjectId,
        accountLabel: current.connection.accountLabel,
      });
    }

    const at = now();
    const status: FounderAiConnectionStatus = readiness.ok
      ? "ready"
      : readiness.code === "capacity_unavailable"
        ? "paused"
        : "needs_attention";
    const message = readiness.ok ? null : readinessMessage(readiness.code);
    const receiptKind = readiness.ok
      ? current.connection.providerSubjectId
        ? "reauthorized"
        : "authorized"
      : "verification_failed";
    const updated = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const [saved] = await tx
        .update(operatorAiConnections)
        .set({
          providerSubjectId: outcome.providerIdentity,
          accountLabel: verification.accountLabel ?? outcome.accountLabel,
          status,
          authorizationState: "authorized",
          capacityState: verification.capacity,
          inferenceState: verification.inference,
          eligibleAccount: verification.eligibleAccount,
          authorizationPersisted: verification.authorizationPersisted,
          authorizationSessionHash: null,
          authorizationExpiresAt: null,
          approvedModelAssignment: verification.approvedModelAssigned
            ? DEFAULT_APPROVED_MODEL
            : null,
          authorizedAt: current.connection.authorizedAt ?? at,
          lastVerifiedAt: readiness.ok ? at : null,
          failureCode: readiness.ok ? null : readiness.code,
          recoveryMessage: message,
          workPausedReason: readiness.ok ? null : message,
          updatedAt: at,
        })
        .where(eq(operatorAiConnections.id, current.connection.id))
        .returning();
      if (!saved)
        throw new FounderAiConnectionError(
          "connection_unavailable",
          "Connection could not be saved.",
          503,
        );
      await insertReceipt(tx, saved, receiptKind, at);
      const selected = await selectConnection(tx, operator.id, false, "openai");
      return selected;
    });
    if (!updated)
      throw new FounderAiConnectionError(
        "connection_unavailable",
        "Connection could not be reloaded.",
        503,
      );
    return toConnectionDto(updated.connection, updated.receipt);
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function recheckFounderOpenAiConnectionForUser(
  userId: string,
  dependencies: FounderAiConnectionDependencies = {},
): Promise<FounderAiConnectionDto | null> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createHermesOpenAiAdapter();
  try {
    const current = await connection.db.transaction((tx) =>
      selectConnection(tx, operator.id, true, "openai"),
    );
    if (!current) return null;
    if (!current.connection.providerSubjectId) {
      return toConnectionDto(current.connection, current.receipt);
    }
    const verification = await adapter.verifyConnection({
      operatorId: operator.id,
      userId,
      providerIdentity: current.connection.providerSubjectId,
    });
    if (verification.providerIdentity !== current.connection.providerSubjectId) {
      const failed = await updateConnectionFailure({
        connection,
        operatorId: operator.id,
        now: now(),
        code: "provider_identity_changed",
        message:
          "OpenAI returned a different account identity. Reconnect the account already connected to Bruno.",
        authorizationState: "authorized",
        providerIdentity: current.connection.providerSubjectId,
        accountLabel: current.connection.accountLabel,
      });
      return failed;
    }
    const readiness = evaluateFounderOpenAiReadiness(verification);
    const at = now();
    const status: FounderAiConnectionStatus = readiness.ok
      ? "ready"
      : readiness.code === "capacity_unavailable"
        ? "paused"
        : "needs_attention";
    const updated = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const [saved] = await tx
        .update(operatorAiConnections)
        .set({
          status,
          capacityState: verification.capacity,
          inferenceState: verification.inference,
          eligibleAccount: verification.eligibleAccount,
          authorizationPersisted: verification.authorizationPersisted,
          lastVerifiedAt: readiness.ok ? at : current.connection.lastVerifiedAt,
          failureCode: readiness.ok ? null : readiness.code,
          recoveryMessage: readiness.ok ? null : readinessMessage(readiness.code),
          workPausedReason: readiness.ok ? null : readinessMessage(readiness.code),
          updatedAt: at,
        })
        .where(eq(operatorAiConnections.id, current.connection.id))
        .returning();
      if (!saved) return null;
      if (!readiness.ok) await insertReceipt(tx, saved, "verification_failed", at);
      return selectConnection(tx, operator.id, false, "openai");
    });
    return updated ? toConnectionDto(updated.connection, updated.receipt) : null;
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function disconnectFounderOpenAiForUser(
  userId: string,
  dependencies: FounderAiConnectionDependencies = {},
): Promise<FounderAiConnectionDto | null> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createHermesOpenAiAdapter();
  try {
    const current = await connection.db.transaction((tx) =>
      selectConnection(tx, operator.id, true, "openai"),
    );
    if (!current) return null;
    const revocation = await adapter.revokeAuthorization({
      operatorId: operator.id,
      userId,
      providerIdentity: current.connection.providerSubjectId,
    });
    const at = now();
    const updated = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const providerRevokedMessage = revocation.providerRevoked
        ? null
        : "OpenAI was disconnected locally, but provider revocation could not be confirmed. Bruno paused work that needs it.";
      const [saved] = await tx
        .update(operatorAiConnections)
        .set({
          status: "disconnected",
          authorizationState: revocation.providerRevoked ? "revoked" : "revocation_unconfirmed",
          capacityState: "unknown",
          inferenceState: "unknown",
          authorizationPersisted: false,
          authorizationSessionHash: null,
          authorizationExpiresAt: null,
          approvedModelAssignment: null,
          disconnectedAt: at,
          revokedAt: revocation.providerRevoked ? at : null,
          failureCode: revocation.providerRevoked ? null : "provider_revocation_unconfirmed",
          recoveryMessage: providerRevokedMessage,
          workPausedReason: "OpenAI is disconnected. Bruno paused work that needs it.",
          updatedAt: at,
        })
        .where(eq(operatorAiConnections.id, current.connection.id))
        .returning();
      if (!saved) return null;
      await insertReceipt(tx, saved, revocation.providerRevoked ? "revoked" : "disconnected", at);
      return selectConnection(tx, operator.id, false, "openai");
    });
    return updated ? toConnectionDto(updated.connection, updated.receipt) : null;
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function startFounderAnthropicAuthorizationForUser(
  userId: string,
  dependencies: FounderAiConnectionDependencies = {},
): Promise<FounderAnthropicAuthorizationResult> {
  if (!dependencies.anthropicReleased && !FOUNDER_ANTHROPIC_CONNECTION_RELEASED) {
    throw new FounderAiConnectionError(
      "provider_not_released",
      "Anthropic remains unavailable until its privacy, billing, credential, and production-use gates pass.",
      409,
    );
  }
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  if (operator.preparation.status !== "ready" || operator.runtime?.status !== "ready") {
    throw new FounderAiConnectionError(
      "operator_not_ready",
      "Bruno is still preparing your private workspace. Try again when it is ready.",
      409,
    );
  }
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createHermesAnthropicAdapter();
  try {
    const current = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      return selectConnection(tx, operator.id, true, ANTHROPIC_PROVIDER);
    });
    if (current?.connection.status === "ready") {
      return {
        connection: toConnectionDto(current.connection, current.receipt),
        authorization: null,
      };
    }
    const started = await adapter.startAuthorization({
      operatorId: operator.id,
      userId,
      reconnecting: Boolean(current?.connection.providerSubjectId),
    });
    if (!started.ok) {
      const failed = await updateConnectionFailure({
        connection,
        operatorId: operator.id,
        provider: ANTHROPIC_PROVIDER,
        now: now(),
        code: started.code,
        message: started.message,
        authorizationState: "pending",
      });
      return { connection: failed, authorization: null };
    }
    const startedAt = now();
    const generation = current
      ? current.connection.status === "authorizing"
        ? current.connection.authorizationGeneration
        : current.connection.authorizationGeneration + 1
      : 1;
    const sessionHash = digestOpaqueValue(started.authorization.sessionId);
    const row = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const existing = await selectConnection(tx, operator.id, true, ANTHROPIC_PROVIDER);
      if (existing) {
        const [updated] = await tx
          .update(operatorAiConnections)
          .set({
            status: "authorizing",
            authorizationState: "pending",
            authorizationSessionHash: sessionHash,
            authorizationExpiresAt: started.authorization.expiresAt,
            authorizationGeneration: generation,
            failureCode: null,
            recoveryMessage: null,
            workPausedReason: null,
            updatedAt: startedAt,
          })
          .where(eq(operatorAiConnections.id, existing.connection.id))
          .returning();
        return updated;
      }
      const [created] = await tx
        .insert(operatorAiConnections)
        .values({
          operatorId: operator.id,
          provider: ANTHROPIC_PROVIDER,
          status: "authorizing",
          authorizationState: "pending",
          authorizationSessionHash: sessionHash,
          authorizationExpiresAt: started.authorization.expiresAt,
          authorizationGeneration: generation,
          createdAt: startedAt,
          updatedAt: startedAt,
        })
        .returning();
      return created;
    });
    if (!row)
      throw new FounderAiConnectionError(
        "connection_unavailable",
        "Connection could not be started.",
        503,
      );
    return {
      connection: toConnectionDto(row, null),
      authorization: {
        sessionId: started.authorization.sessionId,
        authorizationUrl: started.authorization.authorizationUrl,
        userCode: started.authorization.userCode,
        expiresAt: started.authorization.expiresAt.toISOString(),
      },
    };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function pollFounderAnthropicAuthorizationForUser(
  userId: string,
  sessionId: string,
  dependencies: FounderAiConnectionDependencies = {},
): Promise<FounderAiConnectionDto> {
  if (!dependencies.anthropicReleased && !FOUNDER_ANTHROPIC_CONNECTION_RELEASED) {
    throw new FounderAiConnectionError("provider_not_released", "Anthropic is not released.", 409);
  }
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createHermesAnthropicAdapter();
  try {
    const current = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      return selectConnection(tx, operator.id, true, ANTHROPIC_PROVIDER);
    });
    if (!current?.connection.authorizationSessionHash) {
      throw new FounderAiConnectionError(
        "authorization_not_found",
        "That authorization has expired.",
        400,
      );
    }
    if (current.connection.authorizationSessionHash !== digestOpaqueValue(sessionId)) {
      throw new FounderAiConnectionError(
        "authorization_session_mismatch",
        "That authorization is no longer active.",
        400,
      );
    }
    const outcome = await adapter.pollAuthorization({ operatorId: operator.id, userId, sessionId });
    if (outcome.state === "pending") return toConnectionDto(current.connection, current.receipt);
    if (outcome.state === "denied" || outcome.state === "expired") {
      return updateConnectionFailure({
        connection,
        operatorId: operator.id,
        provider: ANTHROPIC_PROVIDER,
        now: now(),
        code: outcome.state === "denied" ? "authorization_denied" : "authorization_expired",
        message:
          outcome.state === "denied"
            ? "Anthropic authorization was declined. You can try connecting again."
            : "Anthropic authorization expired. Start again to reconnect.",
        authorizationState: outcome.state,
      });
    }
    const verification = await adapter.verifyConnection({
      operatorId: operator.id,
      userId,
      providerIdentity: outcome.providerIdentity,
    });
    if (verification.providerIdentity !== outcome.providerIdentity) {
      return updateConnectionFailure({
        connection,
        operatorId: operator.id,
        provider: ANTHROPIC_PROVIDER,
        now: now(),
        code: "provider_identity_changed",
        message: "Anthropic returned a different account identity. Reconnect the same account.",
        authorizationState: "authorized",
        providerIdentity: current.connection.providerSubjectId,
        accountLabel: current.connection.accountLabel,
      });
    }
    const processingConsentActive = await connection.db.transaction((tx) =>
      hasActiveProcessingConsent(tx, operator.id, current.connection.id),
    );
    const readiness = evaluateFounderAiReadiness(
      { ...verification, processingConsentActive },
      ANTHROPIC_PROVIDER,
    );
    if (
      current.connection.providerSubjectId &&
      current.connection.providerSubjectId !== outcome.providerIdentity
    ) {
      return updateConnectionFailure({
        connection,
        operatorId: operator.id,
        provider: ANTHROPIC_PROVIDER,
        now: now(),
        code: "provider_identity_changed",
        message: "This is a different Anthropic account. Reconnect the same account.",
        authorizationState: "authorized",
        providerIdentity: current.connection.providerSubjectId,
        accountLabel: current.connection.accountLabel,
      });
    }
    const at = now();
    const status: FounderAiConnectionStatus = readiness.ok
      ? "ready"
      : readiness.code === "capacity_unavailable"
        ? "paused"
        : "needs_attention";
    const message = readiness.ok
      ? null
      : readinessMessageForProvider(ANTHROPIC_PROVIDER, readiness.code);
    const receiptKind = readiness.ok
      ? current.connection.providerSubjectId
        ? "reauthorized"
        : "authorized"
      : "verification_failed";
    const updated = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const [saved] = await tx
        .update(operatorAiConnections)
        .set({
          providerSubjectId: outcome.providerIdentity,
          accountLabel: verification.accountLabel ?? outcome.accountLabel,
          status,
          authorizationState: "authorized",
          capacityState: verification.capacity,
          inferenceState: verification.inference,
          eligibleAccount: verification.eligibleAccount,
          billingVerified: verification.billingVerified ?? false,
          privacyAccepted: verification.privacyAccepted ?? false,
          retentionBounded: verification.retentionBounded ?? false,
          thirdPartyPermissionGranted: verification.thirdPartyPermissionGranted ?? false,
          credentialHealthy: verification.credentialHealthy ?? false,
          reconnectSupported: verification.reconnectSupported ?? false,
          productionUseApproved: verification.productionUseApproved ?? false,
          processingConsentActive,
          authorizationPersisted: verification.authorizationPersisted,
          authorizationSessionHash: null,
          authorizationExpiresAt: null,
          approvedModelAssignment: verification.approvedModelAssigned
            ? DEFAULT_ANTHROPIC_MODEL
            : null,
          authorizedAt: current.connection.authorizedAt ?? at,
          lastVerifiedAt: readiness.ok ? at : null,
          failureCode: readiness.ok ? null : readiness.code,
          recoveryMessage: message,
          workPausedReason: readiness.ok ? null : message,
          updatedAt: at,
        })
        .where(eq(operatorAiConnections.id, current.connection.id))
        .returning();
      if (!saved)
        throw new FounderAiConnectionError(
          "connection_unavailable",
          "Connection could not be saved.",
          503,
        );
      await insertReceipt(tx, saved, receiptKind, at);
      return selectConnection(tx, operator.id, false, ANTHROPIC_PROVIDER);
    });
    if (!updated)
      throw new FounderAiConnectionError(
        "connection_unavailable",
        "Connection could not be reloaded.",
        503,
      );
    return toConnectionDto(updated.connection, updated.receipt);
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function recheckFounderAnthropicConnectionForUser(
  userId: string,
  dependencies: FounderAiConnectionDependencies = {},
): Promise<FounderAiConnectionDto | null> {
  if (!dependencies.anthropicReleased && !FOUNDER_ANTHROPIC_CONNECTION_RELEASED) return null;
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createHermesAnthropicAdapter();
  try {
    const current = await connection.db.transaction((tx) =>
      selectConnection(tx, operator.id, true, ANTHROPIC_PROVIDER),
    );
    if (!current) return null;
    if (!current.connection.providerSubjectId)
      return toConnectionDto(current.connection, current.receipt);
    const verification = await adapter.verifyConnection({
      operatorId: operator.id,
      userId,
      providerIdentity: current.connection.providerSubjectId,
    });
    if (verification.providerIdentity !== current.connection.providerSubjectId) {
      return updateConnectionFailure({
        connection,
        operatorId: operator.id,
        provider: ANTHROPIC_PROVIDER,
        now: now(),
        code: "provider_identity_changed",
        message: "Anthropic returned a different account identity. Reconnect the same account.",
        authorizationState: "authorized",
        providerIdentity: current.connection.providerSubjectId,
        accountLabel: current.connection.accountLabel,
      });
    }
    const processingConsentActive = await connection.db.transaction((tx) =>
      hasActiveProcessingConsent(tx, operator.id, current.connection.id),
    );
    const readiness = evaluateFounderAiReadiness(
      { ...verification, processingConsentActive },
      ANTHROPIC_PROVIDER,
    );
    const at = now();
    const status: FounderAiConnectionStatus = readiness.ok
      ? "ready"
      : readiness.code === "capacity_unavailable"
        ? "paused"
        : "needs_attention";
    const updated = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const [saved] = await tx
        .update(operatorAiConnections)
        .set({
          status,
          capacityState: verification.capacity,
          inferenceState: verification.inference,
          eligibleAccount: verification.eligibleAccount,
          billingVerified: verification.billingVerified ?? false,
          privacyAccepted: verification.privacyAccepted ?? false,
          retentionBounded: verification.retentionBounded ?? false,
          thirdPartyPermissionGranted: verification.thirdPartyPermissionGranted ?? false,
          credentialHealthy: verification.credentialHealthy ?? false,
          reconnectSupported: verification.reconnectSupported ?? false,
          productionUseApproved: verification.productionUseApproved ?? false,
          processingConsentActive,
          authorizationPersisted: verification.authorizationPersisted,
          lastVerifiedAt: readiness.ok ? at : current.connection.lastVerifiedAt,
          failureCode: readiness.ok ? null : readiness.code,
          recoveryMessage: readiness.ok
            ? null
            : readinessMessageForProvider(ANTHROPIC_PROVIDER, readiness.code),
          workPausedReason: readiness.ok
            ? null
            : readinessMessageForProvider(ANTHROPIC_PROVIDER, readiness.code),
          updatedAt: at,
        })
        .where(eq(operatorAiConnections.id, current.connection.id))
        .returning();
      if (!saved) return null;
      if (!readiness.ok) await insertReceipt(tx, saved, "verification_failed", at);
      return selectConnection(tx, operator.id, false, ANTHROPIC_PROVIDER);
    });
    return updated ? toConnectionDto(updated.connection, updated.receipt) : null;
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function disconnectFounderAnthropicForUser(
  userId: string,
  dependencies: FounderAiConnectionDependencies = {},
): Promise<FounderAiConnectionDto | null> {
  if (!dependencies.anthropicReleased && !FOUNDER_ANTHROPIC_CONNECTION_RELEASED) return null;
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createHermesAnthropicAdapter();
  try {
    const current = await connection.db.transaction((tx) =>
      selectConnection(tx, operator.id, true, ANTHROPIC_PROVIDER),
    );
    if (!current) return null;
    const revocation = await adapter.revokeAuthorization({
      operatorId: operator.id,
      userId,
      providerIdentity: current.connection.providerSubjectId,
    });
    const at = now();
    const updated = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const providerRevokedMessage = revocation.providerRevoked
        ? null
        : "Anthropic was disconnected locally, but provider revocation could not be confirmed. Bruno paused work that needs it.";
      const [saved] = await tx
        .update(operatorAiConnections)
        .set({
          status: "disconnected",
          authorizationState: revocation.providerRevoked ? "revoked" : "revocation_unconfirmed",
          capacityState: "unknown",
          inferenceState: "unknown",
          authorizationPersisted: false,
          authorizationSessionHash: null,
          authorizationExpiresAt: null,
          approvedModelAssignment: null,
          disconnectedAt: at,
          revokedAt: revocation.providerRevoked ? at : null,
          failureCode: revocation.providerRevoked ? null : "provider_revocation_unconfirmed",
          recoveryMessage: providerRevokedMessage,
          workPausedReason: "Anthropic is disconnected. Bruno paused work that needs it.",
          updatedAt: at,
        })
        .where(eq(operatorAiConnections.id, current.connection.id))
        .returning();
      if (!saved) return null;
      await insertReceipt(tx, saved, revocation.providerRevoked ? "revoked" : "disconnected", at);
      return selectConnection(tx, operator.id, false, ANTHROPIC_PROVIDER);
    });
    return updated ? toConnectionDto(updated.connection, updated.receipt) : null;
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function updateConnectionFailure(input: {
  connection: DatabaseConnection;
  operatorId: string;
  provider?: FounderAiProvider;
  now: Date;
  code: string;
  message: string;
  authorizationState: "pending" | "denied" | "expired" | "authorized";
  providerIdentity?: string | null;
  accountLabel?: string | null;
}): Promise<FounderAiConnectionDto> {
  const provider = input.provider ?? OPENAI_PROVIDER;
  const result = await input.connection.db.transaction(async (tx) => {
    await lockOperator(tx, input.operatorId);
    const current = await selectConnection(tx, input.operatorId, true, provider);
    if (!current) {
      const [created] = await tx
        .insert(operatorAiConnections)
        .values({
          operatorId: input.operatorId,
          provider,
          status: "needs_attention",
          authorizationState: input.authorizationState,
          providerSubjectId: input.providerIdentity,
          accountLabel: input.accountLabel,
          failureCode: input.code,
          recoveryMessage: input.message,
          workPausedReason: input.message,
          updatedAt: input.now,
        })
        .returning();
      if (!created)
        throw new FounderAiConnectionError(
          "connection_unavailable",
          "Connection could not be saved.",
          503,
        );
      await insertReceipt(tx, created, "verification_failed", input.now);
      return selectConnection(tx, input.operatorId, false, provider);
    }
    const [saved] = await tx
      .update(operatorAiConnections)
      .set({
        status: "needs_attention",
        authorizationState: input.authorizationState,
        providerSubjectId: input.providerIdentity ?? current.connection.providerSubjectId,
        accountLabel: input.accountLabel ?? current.connection.accountLabel,
        authorizationSessionHash: null,
        authorizationExpiresAt: null,
        failureCode: input.code,
        recoveryMessage: input.message,
        workPausedReason: input.message,
        updatedAt: input.now,
      })
      .where(eq(operatorAiConnections.id, current.connection.id))
      .returning();
    if (!saved)
      throw new FounderAiConnectionError(
        "connection_unavailable",
        "Connection could not be saved.",
        503,
      );
    await insertReceipt(tx, saved, "verification_failed", input.now);
    return selectConnection(tx, input.operatorId, false, provider);
  });
  if (!result)
    throw new FounderAiConnectionError(
      "connection_unavailable",
      "Connection could not be reloaded.",
      503,
    );
  return toConnectionDto(result.connection, result.receipt);
}

async function insertReceipt(
  tx: FounderAiConnectionTransaction,
  connection: typeof operatorAiConnections.$inferSelect,
  kind: "authorized" | "reauthorized" | "verification_failed" | "revoked" | "disconnected",
  at: Date,
): Promise<void> {
  const [latest] = await tx
    .select({ createdAt: operatorAiConnectionReceipts.createdAt })
    .from(operatorAiConnectionReceipts)
    .where(eq(operatorAiConnectionReceipts.connectionId, connection.id))
    .orderBy(desc(operatorAiConnectionReceipts.createdAt), desc(operatorAiConnectionReceipts.id))
    .limit(1);
  const createdAt =
    latest && latest.createdAt.getTime() >= at.getTime()
      ? new Date(latest.createdAt.getTime() + 1)
      : at;
  const evidenceDigest = digestOpaqueValue(
    JSON.stringify({
      connectionId: connection.id,
      generation: connection.authorizationGeneration,
      kind,
      provider: connection.provider,
      providerSubjectId: connection.providerSubjectId,
      status: connection.status,
      at: createdAt.toISOString(),
    }),
  );
  await tx
    .insert(operatorAiConnectionReceipts)
    .values({
      connectionId: connection.id,
      generation: connection.authorizationGeneration,
      kind,
      provider: connection.provider,
      providerSubjectId: connection.providerSubjectId,
      accountLabel: connection.accountLabel,
      status: connection.status,
      evidenceDigest: `sha256:${evidenceDigest}`,
      createdAt,
    })
    .onConflictDoNothing();
}

async function selectOperator(
  tx: FounderAiConnectionTransaction,
  userId: string,
): Promise<typeof operators.$inferSelect | undefined> {
  const [operator] = await tx
    .select()
    .from(operators)
    .where(and(eq(operators.userId, userId), eq(operators.status, "active")))
    .limit(1);
  return operator;
}

async function selectConnection(
  tx: FounderAiConnectionTransaction,
  operatorId: string,
  forUpdate = false,
  provider?: FounderAiProvider,
): Promise<{
  connection: typeof operatorAiConnections.$inferSelect;
  receipt: typeof operatorAiConnectionReceipts.$inferSelect | null;
} | null> {
  let connectionQuery = tx
    .select()
    .from(operatorAiConnections)
    .where(
      provider
        ? and(
            eq(operatorAiConnections.operatorId, operatorId),
            eq(operatorAiConnections.provider, provider),
          )
        : eq(operatorAiConnections.operatorId, operatorId),
    )
    .orderBy(desc(operatorAiConnections.updatedAt))
    .limit(1);
  if (forUpdate) connectionQuery = connectionQuery.for("update") as typeof connectionQuery;
  const [connection] = await connectionQuery;
  if (!connection) return null;
  const [receipt] = await tx
    .select()
    .from(operatorAiConnectionReceipts)
    .where(eq(operatorAiConnectionReceipts.connectionId, connection.id))
    .orderBy(desc(operatorAiConnectionReceipts.createdAt), desc(operatorAiConnectionReceipts.id))
    .limit(1);
  return { connection, receipt: receipt ?? null };
}

async function hasActiveProcessingConsent(
  tx: FounderAiConnectionTransaction,
  operatorId: string,
  aiConnectionId: string,
): Promise<boolean> {
  const [consent] = await tx
    .select({ id: operatorProcessingConsents.id })
    .from(operatorProcessingConsents)
    .where(
      and(
        eq(operatorProcessingConsents.operatorId, operatorId),
        eq(operatorProcessingConsents.aiConnectionId, aiConnectionId),
        eq(operatorProcessingConsents.status, "active"),
        inArray(operatorProcessingConsents.purpose, ["calendar_morning_brief", "core_operation"]),
      ),
    )
    .orderBy(desc(operatorProcessingConsents.version))
    .limit(1);
  return Boolean(consent);
}

async function lockOperator(tx: FounderAiConnectionTransaction, operatorId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:operator-ai:${operatorId}`}, 0))`,
  );
}

function toConnectionDto(
  connection: typeof operatorAiConnections.$inferSelect,
  receipt: typeof operatorAiConnectionReceipts.$inferSelect | null,
): FounderAiConnectionDto {
  return {
    provider: connection.provider as FounderAiProvider,
    status: connection.status,
    accountLabel: connection.accountLabel,
    connectedAt: connection.authorizedAt?.toISOString() ?? null,
    lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null,
    workState: connection.status === "ready" ? "available" : "paused",
    recoveryMessage: connection.recoveryMessage,
    recovery: deriveFounderConnectionRecovery({
      capability: "ai",
      status: connection.status,
      failureCode: connection.failureCode,
      recoveryMessage: connection.recoveryMessage,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
      ...(receipt?.generation ? { attemptCount: receipt.generation } : {}),
    }),
    receipt: receipt
      ? {
          provider: receipt.provider as FounderAiProvider,
          accountLabel: receipt.accountLabel,
          outcome:
            receipt.kind === "reauthorized"
              ? "reconnected"
              : receipt.kind === "revoked" || receipt.kind === "disconnected"
                ? "disconnected"
                : receipt.kind === "verification_failed"
                  ? "needs_attention"
                  : "connected",
          issuedAt: receipt.createdAt.toISOString(),
        }
      : null,
  };
}

function readinessMessage(
  code: Exclude<FounderOpenAiReadinessResult, { ok: true }>["code"],
): string {
  switch (code) {
    case "authorization_denied":
      return "OpenAI authorization was declined. Try connecting again when you are ready.";
    case "authorization_expired":
      return "OpenAI authorization expired. Start again to reconnect.";
    case "capacity_unavailable":
      return "OpenAI capacity is unavailable right now. Bruno paused work until it returns.";
    case "account_label_missing":
      return "Bruno could not confirm which OpenAI account was authorized. Try connecting again.";
    case "authorization_not_persisted":
      return "OpenAI authorization did not persist in the private workspace. Try connecting again.";
    case "provider_identity_changed":
      return "This is a different OpenAI account. Reconnect the account already connected to Bruno.";
    default:
      return "Bruno could not verify this OpenAI connection. Try connecting again.";
  }
}

function readinessMessageForProvider(
  provider: FounderAiProvider,
  code: Exclude<FounderAiReadinessResult, { ok: true }>["code"],
): string {
  if (provider === "anthropic") {
    switch (code) {
      case "authorization_denied":
        return "Anthropic authorization was declined. Try connecting again when you are ready.";
      case "authorization_expired":
        return "Anthropic authorization expired. Start again to reconnect.";
      case "billing_unverified":
        return "Bruno could not verify an eligible Claude Max plan with extra usage credits.";
      case "privacy_not_accepted":
        return "Anthropic privacy requirements are not yet proven for this connection.";
      case "retention_unbounded":
        return "Anthropic retention requirements are not yet proven for this connection.";
      case "third_party_permission_missing":
        return "Anthropic third-party processing permission is not yet proven.";
      case "credential_unhealthy":
        return "Anthropic credentials could not be confirmed healthy. Reconnect to try again.";
      case "reconnect_unsupported":
        return "Anthropic reconnect behavior is not yet proven for this connection.";
      case "production_use_unapproved":
        return "Anthropic production-use approval is not yet proven for this connection.";
      case "processing_consent_missing":
        return "Confirm active Processing Consent before Bruno uses Anthropic for company work.";
      case "capacity_unavailable":
        return "Anthropic capacity is unavailable right now. Bruno paused work until it returns.";
      default:
        return "Bruno could not verify this Anthropic connection. Try connecting again.";
    }
  }
  return readinessMessage(code);
}

function digestOpaqueValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createHermesOpenAiAdapter(
  input: {
    baseUrl?: string;
    request?: (path: string, init?: RequestInit) => Promise<unknown>;
  } = {},
): FounderOpenAiAdapter {
  const baseUrl = input.baseUrl ?? process.env.BRUNO_HERMES_CONTROL_URL?.trim();
  const request =
    input.request ??
    (baseUrl
      ? async (path, init) => {
          const token = process.env.BRUNO_HERMES_CONTROL_TOKEN?.trim();
          const response = await fetch(new URL(path, baseUrl), {
            ...init,
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(init?.headers ?? {}),
            },
          });
          const body = (await response.json().catch(() => null)) as unknown;
          if (!response.ok) throw new Error(`Hermes request failed (${response.status}).`);
          return body;
        }
      : async () => {
          throw new Error("Hermes structured authorization is not configured.");
        });

  return {
    async startAuthorization() {
      try {
        const body = (await request("/api/providers/oauth/openai-codex/start", {
          method: "POST",
        })) as Record<string, unknown>;
        const authorizationUrl = readString(
          body.verification_url ?? body.authorizationUrl ?? body.url,
        );
        const userCode = readString(body.user_code ?? body.userCode ?? body.code);
        const sessionId = readString(body.session_id ?? body.sessionId ?? body.id);
        const expiresIn = readNumber(body.expires_in);
        const expiresAt =
          readDate(body.expiresAt) ?? (expiresIn ? new Date(Date.now() + expiresIn * 1000) : null);
        if (!authorizationUrl || !userCode || !sessionId || !expiresAt)
          throw new Error("invalid authorization response");
        return {
          ok: true as const,
          authorization: { authorizationUrl, userCode, sessionId, expiresAt },
        };
      } catch {
        return {
          ok: false as const,
          code: "authorization_unavailable",
          message: "Bruno could not start OpenAI authorization. Try again shortly.",
        };
      }
    },
    async pollAuthorization({ sessionId }) {
      try {
        const body = (await request(
          `/api/providers/oauth/openai-codex/poll/${encodeURIComponent(sessionId)}`,
        )) as Record<string, unknown>;
        const state = readString(body.state ?? body.status);
        if (state === "pending" || state === "authorization_pending")
          return { state: "pending" as const };
        if (state === "denied" || state === "access_denied") return { state: "denied" as const };
        if (state === "expired" || state === "authorization_expired")
          return { state: "expired" as const };
        let providerIdentity = readString(
          body.providerIdentity ??
            body.provider_identity ??
            body.subject ??
            body.accountId ??
            body.account_id,
        );
        if (!providerIdentity) {
          const statusBody = (await request("/api/providers/oauth")) as Record<string, unknown>;
          const provider = findOpenAiProvider(statusBody);
          providerIdentity = readString(
            provider?.account_id ?? provider?.provider_identity ?? provider?.subject,
          );
        }
        if (!providerIdentity) return { state: "pending" as const };
        return {
          state: "authorized" as const,
          providerIdentity,
          accountLabel: readString(body.accountLabel ?? body.email ?? body.account),
        };
      } catch {
        return { state: "pending" as const };
      }
    },
    async verifyConnection({ providerIdentity }) {
      try {
        const providerBody = (await request("/api/providers/oauth")) as Record<string, unknown>;
        const provider = findOpenAiProvider(providerBody);
        const modelBody = (await request("/api/model/info")) as Record<string, unknown>;
        const statusBody = (await request("/api/status")) as Record<string, unknown>;
        const providerStatus = (provider?.status ?? {}) as Record<string, unknown>;
        const modelProvider = readString(modelBody.provider);
        const modelName = readString(modelBody.model ?? modelBody.name);
        return {
          providerIdentity:
            readString(provider?.account_id ?? provider?.provider_identity ?? provider?.subject) ??
            providerIdentity,
          accountLabel: readString(provider?.account_label ?? provider?.email ?? provider?.account),
          eligibleAccount: providerStatus.logged_in === true && providerStatus.eligible !== false,
          authorizationPersisted: providerStatus.logged_in === true,
          approvedModelAssigned:
            modelProvider === "openai-codex" &&
            modelName !== null &&
            isApprovedOpenAiModel(modelName),
          capacity:
            statusBody.capacity === "available" || statusBody.capacity === "exhausted"
              ? statusBody.capacity
              : "unavailable",
          inference:
            statusBody.inference === "passed" || statusBody.inferencePassed === true
              ? "passed"
              : "failed",
        };
      } catch {
        return {
          providerIdentity,
          accountLabel: null,
          eligibleAccount: false,
          authorizationPersisted: false,
          approvedModelAssigned: false,
          capacity: "unavailable",
          inference: "failed",
        };
      }
    },
    async revokeAuthorization() {
      try {
        await request("/api/providers/oauth/openai-codex", { method: "DELETE" });
        return { providerRevoked: true };
      } catch {
        return { providerRevoked: false };
      }
    },
  };
}

/**
 * Hermes owns Anthropic OAuth and credential persistence. Bruno only receives
 * the browser handoff and bounded verification facts; raw OAuth/setup tokens
 * never cross this boundary or enter the Founder-facing DTO.
 */
export function createHermesAnthropicAdapter(
  input: {
    baseUrl?: string;
    request?: (path: string, init?: RequestInit) => Promise<unknown>;
  } = {},
): FounderAnthropicAdapter {
  const baseUrl = input.baseUrl ?? process.env.BRUNO_HERMES_CONTROL_URL?.trim();
  const request =
    input.request ??
    (baseUrl
      ? async (path, init) => {
          const token = process.env.BRUNO_HERMES_CONTROL_TOKEN?.trim();
          const response = await fetch(new URL(path, baseUrl), {
            ...init,
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(init?.headers ?? {}),
            },
          });
          const body = (await response.json().catch(() => null)) as unknown;
          if (!response.ok) throw new Error(`Hermes request failed (${response.status}).`);
          return body;
        }
      : async () => {
          throw new Error("Hermes structured authorization is not configured.");
        });

  return {
    async startAuthorization() {
      try {
        const body = (await request("/api/providers/oauth/anthropic/start", {
          method: "POST",
        })) as Record<string, unknown>;
        const authorizationUrl = readString(
          body.verification_url ?? body.authorizationUrl ?? body.url,
        );
        const userCode = readString(body.user_code ?? body.userCode ?? body.code);
        const sessionId = readString(body.session_id ?? body.sessionId ?? body.id);
        const expiresIn = readNumber(body.expires_in);
        const expiresAt =
          readDate(body.expiresAt) ?? (expiresIn ? new Date(Date.now() + expiresIn * 1000) : null);
        if (!authorizationUrl || !userCode || !sessionId || !expiresAt)
          throw new Error("invalid authorization response");
        return {
          ok: true as const,
          authorization: { authorizationUrl, userCode, sessionId, expiresAt },
        };
      } catch {
        return {
          ok: false as const,
          code: "authorization_unavailable",
          message: "Bruno could not start Anthropic authorization. Try again shortly.",
        };
      }
    },
    async pollAuthorization({ sessionId }) {
      try {
        const body = (await request(
          `/api/providers/oauth/anthropic/poll/${encodeURIComponent(sessionId)}`,
        )) as Record<string, unknown>;
        const state = readString(body.state ?? body.status);
        if (state === "pending" || state === "authorization_pending")
          return { state: "pending" as const };
        if (state === "denied" || state === "access_denied") return { state: "denied" as const };
        if (state === "expired" || state === "authorization_expired")
          return { state: "expired" as const };
        const providerIdentity = readString(
          body.providerIdentity ??
            body.provider_identity ??
            body.subject ??
            body.accountId ??
            body.account_id,
        );
        if (!providerIdentity) return { state: "pending" as const };
        return {
          state: "authorized" as const,
          providerIdentity,
          accountLabel: readString(body.accountLabel ?? body.email ?? body.account),
        };
      } catch {
        return { state: "pending" as const };
      }
    },
    async verifyConnection({ providerIdentity }) {
      try {
        const providerBody = (await request("/api/providers/oauth")) as Record<string, unknown>;
        const provider = findAnthropicProvider(providerBody);
        const modelBody = (await request("/api/model/info")) as Record<string, unknown>;
        const statusBody = (await request("/api/status")) as Record<string, unknown>;
        const providerStatus = (provider?.status ?? {}) as Record<string, unknown>;
        const modelProvider = readString(modelBody.provider);
        const modelName = readString(modelBody.model ?? modelBody.name);
        const compatibility = evaluateFounderAnthropicCompatibility({
          subscriptionPlan:
            readString(providerStatus.subscription_plan ?? providerStatus.plan) === "claude_max"
              ? "claude_max"
              : readString(providerStatus.subscription_plan ?? providerStatus.plan) === "claude_pro"
                ? "claude_pro"
                : "unknown",
          extraUsageCredits:
            providerStatus.extra_usage_credits === true || statusBody.extra_usage_credits === true,
          privacyReviewed: statusBody.privacy_accepted === true,
          retentionReviewed: statusBody.retention_bounded === true,
          thirdPartyPermissionReviewed: statusBody.third_party_permission_granted === true,
          credentialStorageReviewed: statusBody.credential_healthy === true,
          reconnectReviewed: statusBody.reconnect_supported === true,
          productionUseReviewed: statusBody.production_use_approved === true,
        });
        return {
          providerIdentity:
            readString(provider?.account_id ?? provider?.provider_identity ?? provider?.subject) ??
            providerIdentity,
          accountLabel: readString(provider?.account_label ?? provider?.email ?? provider?.account),
          eligibleAccount:
            providerStatus.logged_in === true &&
            providerStatus.eligible === true &&
            compatibility.released,
          billingVerified:
            providerStatus.billing_verified === true &&
            (providerStatus.extra_usage_credits === true ||
              statusBody.extra_usage_credits === true),
          privacyAccepted: statusBody.privacy_accepted === true,
          retentionBounded: statusBody.retention_bounded === true,
          thirdPartyPermissionGranted: statusBody.third_party_permission_granted === true,
          credentialHealthy: statusBody.credential_healthy === true,
          reconnectSupported: statusBody.reconnect_supported === true,
          productionUseApproved: statusBody.production_use_approved === true,
          processingConsentActive: statusBody.processing_consent_active === true,
          authorizationPersisted: providerStatus.logged_in === true,
          approvedModelAssigned:
            modelProvider === "anthropic" &&
            modelName !== null &&
            isApprovedAnthropicModel(modelName),
          capacity:
            statusBody.capacity === "available" || statusBody.capacity === "exhausted"
              ? statusBody.capacity
              : "unavailable",
          inference:
            statusBody.inference === "passed" || statusBody.inferencePassed === true
              ? "passed"
              : "failed",
        };
      } catch {
        return {
          providerIdentity,
          accountLabel: null,
          eligibleAccount: false,
          billingVerified: false,
          privacyAccepted: false,
          retentionBounded: false,
          thirdPartyPermissionGranted: false,
          credentialHealthy: false,
          reconnectSupported: false,
          productionUseApproved: false,
          processingConsentActive: false,
          authorizationPersisted: false,
          approvedModelAssigned: false,
          capacity: "unavailable" as const,
          inference: "failed" as const,
        };
      }
    },
    async revokeAuthorization() {
      try {
        await request("/api/providers/oauth/anthropic", { method: "DELETE" });
        return { providerRevoked: true };
      } catch {
        return { providerRevoked: false };
      }
    },
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function findOpenAiProvider(body: Record<string, unknown>): Record<string, unknown> | null {
  const providers = Array.isArray(body.providers) ? body.providers : [];
  const provider = providers.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as Record<string, unknown>).id === "openai-codex",
  );
  return provider && typeof provider === "object" ? (provider as Record<string, unknown>) : null;
}

function findAnthropicProvider(body: Record<string, unknown>): Record<string, unknown> | null {
  const providers = Array.isArray(body.providers) ? body.providers : [];
  const provider = providers.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as Record<string, unknown>).id === ANTHROPIC_PROVIDER,
  );
  return provider && typeof provider === "object" ? (provider as Record<string, unknown>) : null;
}

function isApprovedOpenAiModel(model: string): boolean {
  const configured = process.env.BRUNO_APPROVED_OPENAI_MODELS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const approved = configured?.length
    ? configured
    : ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.4"];
  return approved.includes(model);
}

function isApprovedAnthropicModel(model: string): boolean {
  const configured = process.env.BRUNO_APPROVED_ANTHROPIC_MODELS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const approved = configured?.length ? configured : ["claude-sonnet-4-6", "claude-3-7-sonnet"];
  return approved.includes(model);
}

function readDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
