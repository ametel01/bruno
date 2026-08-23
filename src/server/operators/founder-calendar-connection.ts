import "server-only";

import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  operatorCalendarConnectionReceipts,
  operatorCalendarConnections,
  operatorCalendarResources,
  operators,
} from "@/src/server/db/schema";
import {
  type FounderOwnerPreviewAccess,
  FounderReleaseStageAccessError,
  getFounderOwnerPreviewAccessForUser,
} from "@/src/server/founder-product-contract/release-stage-access";
import { reconcileFounderLimitedOperationForUser } from "@/src/server/operators/founder-limited-operation";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";
import {
  deriveFounderConnectionRecovery,
  type FounderRecoveryDto,
} from "@/src/server/operators/founder-recovery";
import {
  type FounderRelationshipObservation,
  ingestFounderRelationshipEvidenceForUser,
} from "@/src/server/operators/founder-relationships";
import {
  decryptOperatorSecret,
  digestOperatorSecret,
  encryptOperatorSecret,
  type OperatorSecretKeyring,
  parseOperatorSecretKeyring,
} from "@/src/server/secrets/operator-secret-keyring";

type FounderCalendarTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

const GOOGLE_CALENDAR_PROVIDER = "google_calendar" as const;
const REQUIRED_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const OIDC_SCOPES = ["openid", "email", "profile"] as const;
const MAX_SELECTED_RESOURCES = 50;
const MAX_PROVIDER_RESOURCES = 250;

export type FounderCalendarConnectionStatus =
  | "authorizing"
  | "selecting"
  | "verifying"
  | "ready"
  | "needs_attention"
  | "disconnected";

export type FounderCalendarEvidenceState = "unknown" | "current" | "unavailable";

export type FounderCalendarResourceDto = {
  providerResourceId: string;
  summary: string;
  timeZone: string | null;
  accessRole: string | null;
  primaryCalendar: boolean;
  selected: boolean;
  status: "available" | "removed";
};

export type FounderCalendarConnectionDto = {
  provider: "google_calendar";
  status: FounderCalendarConnectionStatus;
  accountLabel: string | null;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  evidenceState: FounderCalendarEvidenceState;
  workState: "available" | "paused";
  recoveryMessage: string | null;
  recovery?: FounderRecoveryDto | null;
  resources: FounderCalendarResourceDto[];
  receipt: {
    provider: "google_calendar";
    accountLabel: string | null;
    outcome: "connected" | "reconnected" | "verified" | "disconnected" | "needs_attention";
    grantedScopes: string[];
    selectedResourceCount: number;
    evidenceState: FounderCalendarEvidenceState;
    issuedAt: string;
  } | null;
};

export type FounderGoogleCalendarResource = {
  providerResourceId: string;
  summary: string;
  timeZone: string | null;
  accessRole: string | null;
  primaryCalendar: boolean;
};

export type FounderGoogleCalendarAdapter = {
  createAuthorizationUrl(input: {
    state: string;
    reconnecting: boolean;
  }): Promise<{ authorizationUrl: string; expiresAt: Date }>;
  exchangeAuthorizationCode(input: { code: string }): Promise<{
    accessToken: string;
    refreshToken: string | null;
    tokenExpiresAt: Date;
    grantedScopes: string[];
  }>;
  getIdentity(input: {
    accessToken: string;
  }): Promise<{ providerSubjectId: string; accountLabel: string | null }>;
  listCalendars(input: { accessToken: string }): Promise<FounderGoogleCalendarResource[]>;
  verifySelectedResources(input: {
    accessToken: string;
    refreshToken: string;
    resources: FounderGoogleCalendarResource[];
    timeMin: Date;
    timeMax: Date;
  }): Promise<{
    providerSubjectId: string;
    accountLabel: string | null;
    evidenceState: "current" | "unavailable";
    attentionCount?: number;
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: Date;
  }>;
  readSelectedResources?(input: {
    accessToken: string;
    resources: FounderGoogleCalendarResource[];
    timeMin: Date;
    timeMax: Date;
  }): Promise<
    Array<
      Pick<
        FounderRelationshipObservation,
        | "providerItemId"
        | "providerIdentity"
        | "email"
        | "displayName"
        | "company"
        | "domain"
        | "excerpt"
        | "sourceMetadata"
        | "observedAt"
      >
    >
  >;
  revokeAuthorization(input: {
    accessToken: string | null;
    refreshToken: string | null;
  }): Promise<{ providerRevoked: boolean }>;
};

export type FounderCalendarConnectionDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  adapter?: FounderGoogleCalendarAdapter;
  keyring?: OperatorSecretKeyring;
  env?: Record<string, string | undefined>;
  randomBytes?: (size: number) => Buffer;
  getOwnerPreviewAccess?: (userId: string, now: Date) => Promise<FounderOwnerPreviewAccess>;
  preserveCredentialsOnUnconfirmedRevocation?: boolean;
};

export type FounderGoogleCalendarAuthorizationResult = {
  connection: FounderCalendarConnectionDto;
  authorization: { authorizationUrl: string; expiresAt: string } | null;
};

export class FounderCalendarConnectionError extends Error {
  readonly code: string;
  readonly status: 400 | 401 | 409 | 503;

  constructor(code: string, message: string, status: 400 | 401 | 409 | 503 = 409) {
    super(message);
    this.name = "FounderCalendarConnectionError";
    this.code = code;
    this.status = status;
  }
}

export async function getFounderGoogleCalendarConnectionForUser(
  userId: string,
  dependencies: Pick<FounderCalendarConnectionDependencies, "createConnection"> = {},
): Promise<FounderCalendarConnectionDto | null> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      const operator = await selectOperator(tx, userId);
      if (!operator) return null;
      const bundle = await selectConnectionBundle(tx, operator.id);
      return bundle ? toDto(bundle) : null;
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function startFounderGoogleCalendarAuthorizationForUser(
  userId: string,
  dependencies: FounderCalendarConnectionDependencies = {},
): Promise<FounderGoogleCalendarAuthorizationResult> {
  const operator = await ensureReadyOperator(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createAdapterForEnv(dependencies.env);
  const state = (dependencies.randomBytes ?? randomBytes)(32).toString("base64url");

  try {
    const current = await connection.db.transaction((tx) =>
      selectConnectionBundle(tx, operator.id, true),
    );
    let authorization: { authorizationUrl: string; expiresAt: Date };
    try {
      authorization = await adapter.createAuthorizationUrl({
        state,
        reconnecting: Boolean(current?.connection.providerSubjectId),
      });
    } catch {
      const failed = await persistConnectionFailure({
        connection,
        operatorId: operator.id,
        now: now(),
        code: "authorization_unavailable",
        message: "Bruno could not start Google Calendar authorization. Try again shortly.",
        authorizationState: "pending",
      });
      return { connection: failed, authorization: null };
    }

    const generation = current
      ? current.connection.status === "authorizing"
        ? current.connection.authorizationGeneration
        : current.connection.authorizationGeneration + 1
      : 1;
    const at = now();
    const saved = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const existing = await selectConnectionBundle(tx, operator.id, true);
      if (existing) {
        const [updated] = await tx
          .update(operatorCalendarConnections)
          .set({
            status: "authorizing",
            authorizationState: "pending",
            authorizationSessionHash: digestOperatorSecret(state),
            authorizationExpiresAt: authorization.expiresAt,
            authorizationGeneration: generation,
            failureCode: null,
            recoveryMessage: null,
            updatedAt: at,
          })
          .where(eq(operatorCalendarConnections.id, existing.connection.id))
          .returning();
        return updated;
      }
      const [created] = await tx
        .insert(operatorCalendarConnections)
        .values({
          operatorId: operator.id,
          provider: GOOGLE_CALENDAR_PROVIDER,
          status: "authorizing",
          authorizationState: "pending",
          authorizationSessionHash: digestOperatorSecret(state),
          authorizationExpiresAt: authorization.expiresAt,
          authorizationGeneration: generation,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      return created;
    });
    if (!saved) {
      throw new FounderCalendarConnectionError(
        "connection_unavailable",
        "Google Calendar connection could not be saved.",
        503,
      );
    }
    const result = await connection.db.transaction(async (tx) => {
      const bundle = await selectConnectionBundle(tx, operator.id);
      if (!bundle)
        throw new FounderCalendarConnectionError(
          "connection_unavailable",
          "Connection could not be reloaded.",
          503,
        );
      return toDto(bundle);
    });
    return {
      connection: result,
      authorization: {
        authorizationUrl: authorization.authorizationUrl,
        expiresAt: authorization.expiresAt.toISOString(),
      },
    };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function completeFounderGoogleCalendarAuthorizationForState(
  state: string,
  code: string,
  dependencies: FounderCalendarConnectionDependencies = {},
): Promise<FounderCalendarConnectionDto> {
  if (!state.trim() || !code.trim()) {
    throw new FounderCalendarConnectionError(
      "authorization_invalid",
      "Google Calendar authorization is missing its state or code.",
      400,
    );
  }
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createAdapterForEnv(dependencies.env);
  const stateHash = digestOperatorSecret(state);

  try {
    const pending = await connection.db.transaction(async (tx) => {
      const [found] = await tx
        .select()
        .from(operatorCalendarConnections)
        .where(eq(operatorCalendarConnections.authorizationSessionHash, stateHash))
        .for("update");
      if (!found) {
        throw new FounderCalendarConnectionError(
          "authorization_invalid",
          "That Google Calendar authorization is no longer active.",
          400,
        );
      }
      if (!found.authorizationExpiresAt || found.authorizationExpiresAt <= now()) {
        throw new FounderCalendarConnectionError(
          "authorization_expired",
          "Google Calendar authorization expired. Start again to reconnect.",
          400,
        );
      }
      await tx
        .update(operatorCalendarConnections)
        .set({
          status: "verifying",
          authorizationSessionHash: null,
          authorizationExpiresAt: null,
          updatedAt: now(),
        })
        .where(eq(operatorCalendarConnections.id, found.id));
      return found;
    });

    const [owner] = await connection.db
      .select({ userId: operators.userId })
      .from(operators)
      .where(eq(operators.id, pending.operatorId))
      .limit(1);
    if (!owner) {
      throw new FounderCalendarConnectionError(
        "connection_unavailable",
        "Calendar connection owner could not be verified.",
        503,
      );
    }
    const ownerPreviewAccess = dependencies.getOwnerPreviewAccess
      ? await dependencies.getOwnerPreviewAccess(owner.userId, now())
      : await getFounderOwnerPreviewAccessForUser(owner.userId, now(), {
          createConnection: () => connection,
          ...(dependencies.env ? { env: dependencies.env } : {}),
        });
    if (
      !ownerPreviewAccess.admitted ||
      !ownerPreviewAccess.availableCapabilities.includes("calendar_reading")
    ) {
      return await persistConnectionFailure({
        connection,
        operatorId: pending.operatorId,
        connectionId: pending.id,
        now: now(),
        code: "owner_preview_access_required",
        message: "Google Calendar authorization paused under the current Release Decision.",
        authorizationState: "pending",
        evidenceState: "unavailable",
      });
    }

    try {
      const keyring = resolveKeyring(dependencies);
      const tokens = await adapter.exchangeAuthorizationCode({ code });
      const previousRefreshToken = pending.refreshTokenCiphertext
        ? decryptToken(
            pending.refreshTokenCiphertext,
            pending.refreshTokenIv,
            pending.refreshTokenAuthTag,
            pending.secretKeyVersion,
            keyring,
            "google-calendar-refresh",
          )
        : null;
      const refreshToken = tokens.refreshToken ?? previousRefreshToken;
      if (!refreshToken) {
        return await persistConnectionFailure({
          connection,
          operatorId: pending.operatorId,
          connectionId: pending.id,
          now: now(),
          code: "refresh_token_missing",
          message: "Google did not provide a durable refresh grant. Try connecting again.",
          authorizationState: "authorized",
        });
      }
      if (!tokens.grantedScopes.includes(REQUIRED_CALENDAR_SCOPE)) {
        return await persistConnectionFailure({
          connection,
          operatorId: pending.operatorId,
          connectionId: pending.id,
          now: now(),
          code: "calendar_scope_missing",
          message:
            "Google Calendar access was not granted. Try connecting again and allow Calendar access.",
          authorizationState: "authorized",
        });
      }
      const identity = await adapter.getIdentity({ accessToken: tokens.accessToken });
      if (pending.providerSubjectId && pending.providerSubjectId !== identity.providerSubjectId) {
        return await persistConnectionFailure({
          connection,
          operatorId: pending.operatorId,
          connectionId: pending.id,
          now: now(),
          code: "provider_identity_changed",
          message:
            "This is a different Google account. Reconnect the account already connected to Bruno.",
          authorizationState: "authorized",
        });
      }
      const calendars = await adapter.listCalendars({ accessToken: tokens.accessToken });
      if (calendars.length > MAX_PROVIDER_RESOURCES) {
        throw new FounderCalendarConnectionError(
          "calendar_list_too_large",
          "Google returned too many calendars to review safely.",
          409,
        );
      }
      const accessToken = encryptOperatorSecret({
        value: tokens.accessToken,
        scope: "google-calendar-access",
        keyring,
      });
      const encryptedRefreshToken = encryptOperatorSecret({
        value: refreshToken,
        scope: "google-calendar-refresh",
        keyring,
      });
      const at = now();
      return await connection.db.transaction(async (tx) => {
        await lockOperator(tx, pending.operatorId);
        const [saved] = await tx
          .update(operatorCalendarConnections)
          .set({
            providerSubjectId: identity.providerSubjectId,
            accountLabel: identity.accountLabel,
            status: "selecting",
            authorizationState: "authorized",
            accessTokenCiphertext: accessToken.ciphertext,
            accessTokenIv: accessToken.iv,
            accessTokenAuthTag: accessToken.authTag,
            refreshTokenCiphertext: encryptedRefreshToken.ciphertext,
            refreshTokenIv: encryptedRefreshToken.iv,
            refreshTokenAuthTag: encryptedRefreshToken.authTag,
            secretKeyVersion: accessToken.keyVersion,
            tokenExpiresAt: tokens.tokenExpiresAt,
            grantedScopes: tokens.grantedScopes,
            authorizedAt: pending.authorizedAt ?? at,
            evidenceState: "unknown",
            failureCode: null,
            recoveryMessage: null,
            updatedAt: at,
          })
          .where(eq(operatorCalendarConnections.id, pending.id))
          .returning();
        if (!saved)
          throw new FounderCalendarConnectionError(
            "connection_unavailable",
            "Connection could not be saved.",
            503,
          );
        await upsertCalendarResources(tx, saved.id, calendars, at);
        await insertCalendarReceipt(
          tx,
          saved,
          pending.providerSubjectId ? "reauthorized" : "authorized",
          at,
          "unknown",
        );
        const bundle = await selectConnectionBundle(tx, pending.operatorId);
        if (!bundle)
          throw new FounderCalendarConnectionError(
            "connection_unavailable",
            "Connection could not be reloaded.",
            503,
          );
        return toDto(bundle);
      });
    } catch (error) {
      if (
        error instanceof FounderCalendarConnectionError &&
        error.code !== "calendar_list_too_large"
      ) {
        throw error;
      }
      return await persistConnectionFailure({
        connection,
        operatorId: pending.operatorId,
        connectionId: pending.id,
        now: now(),
        code:
          error instanceof FounderCalendarConnectionError
            ? error.code
            : "authorization_verification_failed",
        message:
          error instanceof FounderCalendarConnectionError
            ? error.message
            : "Bruno could not verify the Google Calendar connection. Try again.",
        authorizationState: "authorized",
      });
    }
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function selectFounderGoogleCalendarResourcesForUser(
  userId: string,
  resourceIds: string[],
  dependencies: FounderCalendarConnectionDependencies = {},
): Promise<FounderCalendarConnectionDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const normalizedIds = [...new Set(resourceIds.map((value) => value.trim()).filter(Boolean))];
  if (normalizedIds.length === 0 || normalizedIds.length > MAX_SELECTED_RESOURCES) {
    throw new FounderCalendarConnectionError(
      "calendar_selection_required",
      "Select at least one calendar to continue.",
      400,
    );
  }
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  try {
    const result = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const current = await selectConnectionBundle(tx, operator.id, true);
      if (!current?.connection.providerSubjectId) {
        throw new FounderCalendarConnectionError(
          "calendar_not_connected",
          "Connect Google Calendar before selecting calendars.",
          409,
        );
      }
      const available = current.resources.filter((resource) => resource.status === "available");
      const availableIds = new Set(available.map((resource) => resource.providerResourceId));
      if (normalizedIds.some((id) => !availableIds.has(id))) {
        throw new FounderCalendarConnectionError(
          "calendar_selection_invalid",
          "Choose only calendars Bruno found in your Google account.",
          400,
        );
      }
      await tx
        .update(operatorCalendarResources)
        .set({ selected: false, updatedAt: now() })
        .where(eq(operatorCalendarResources.connectionId, current.connection.id));
      await tx
        .update(operatorCalendarResources)
        .set({ selected: true, selectionReviewedAt: now(), updatedAt: now() })
        .where(
          and(
            eq(operatorCalendarResources.connectionId, current.connection.id),
            inArray(operatorCalendarResources.providerResourceId, normalizedIds),
          ),
        );
      const [saved] = await tx
        .update(operatorCalendarConnections)
        .set({
          status: "verifying",
          evidenceState: "unknown",
          failureCode: null,
          recoveryMessage: null,
          updatedAt: now(),
        })
        .where(eq(operatorCalendarConnections.id, current.connection.id))
        .returning();
      if (!saved)
        throw new FounderCalendarConnectionError(
          "connection_unavailable",
          "Calendar selection could not be saved.",
          503,
        );
      const bundle = await selectConnectionBundle(tx, operator.id);
      if (!bundle)
        throw new FounderCalendarConnectionError(
          "connection_unavailable",
          "Connection could not be reloaded.",
          503,
        );
      return toDto(bundle);
    });
    return result;
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function verifyFounderGoogleCalendarForUser(
  userId: string,
  dependencies: FounderCalendarConnectionDependencies = {},
): Promise<FounderCalendarConnectionDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createAdapterForEnv(dependencies.env);
  try {
    const current = await connection.db.transaction((tx) =>
      selectConnectionBundle(tx, operator.id, true),
    );
    if (!current?.connection.providerSubjectId) {
      throw new FounderCalendarConnectionError(
        "calendar_not_connected",
        "Connect Google Calendar before verifying it.",
        409,
      );
    }
    const selected = current.resources.filter(
      (resource) => resource.selected && resource.status === "available",
    );
    if (selected.length === 0) {
      return await persistConnectionFailure({
        connection,
        operatorId: operator.id,
        connectionId: current.connection.id,
        now: now(),
        code: "calendar_selection_required",
        message: "Select at least one calendar before Bruno verifies the connection.",
        authorizationState: "authorized",
        evidenceState: "unknown",
      });
    }
    const keyring = resolveKeyring(dependencies);
    const accessToken = decryptToken(
      current.connection.accessTokenCiphertext,
      current.connection.accessTokenIv,
      current.connection.accessTokenAuthTag,
      current.connection.secretKeyVersion,
      keyring,
      "google-calendar-access",
    );
    const refreshToken = decryptToken(
      current.connection.refreshTokenCiphertext,
      current.connection.refreshTokenIv,
      current.connection.refreshTokenAuthTag,
      current.connection.secretKeyVersion,
      keyring,
      "google-calendar-refresh",
    );
    let verification: Awaited<ReturnType<FounderGoogleCalendarAdapter["verifySelectedResources"]>>;
    try {
      verification = await adapter.verifySelectedResources({
        accessToken,
        refreshToken,
        resources: selected.map(toProviderResource),
        timeMin: new Date(now().getTime() - 24 * 60 * 60 * 1000),
        timeMax: new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000),
      });
    } catch {
      return await persistConnectionFailure({
        connection,
        operatorId: operator.id,
        connectionId: current.connection.id,
        now: now(),
        code: "calendar_live_check_failed",
        message: "Bruno could not complete the live Google Calendar check. Try again shortly.",
        authorizationState: "authorized",
        evidenceState: "unavailable",
      });
    }
    if (verification.providerSubjectId !== current.connection.providerSubjectId) {
      return await persistConnectionFailure({
        connection,
        operatorId: operator.id,
        connectionId: current.connection.id,
        now: now(),
        code: "provider_identity_changed",
        message:
          "Google returned a different account identity. Reconnect the account already connected to Bruno.",
        authorizationState: "authorized",
        evidenceState: "unavailable",
      });
    }
    const at = now();
    const updated = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const tokenUpdate = verification.accessToken
        ? encryptOperatorSecret({
            value: verification.accessToken,
            scope: "google-calendar-access",
            keyring,
          })
        : null;
      const refreshUpdate = verification.refreshToken
        ? encryptOperatorSecret({
            value: verification.refreshToken,
            scope: "google-calendar-refresh",
            keyring,
          })
        : null;
      const [saved] = await tx
        .update(operatorCalendarConnections)
        .set({
          status: verification.evidenceState === "current" ? "ready" : "needs_attention",
          accountLabel: verification.accountLabel ?? current.connection.accountLabel,
          evidenceState: verification.evidenceState,
          lastVerifiedAt:
            verification.evidenceState === "current" ? at : current.connection.lastVerifiedAt,
          lastEvidenceAt: at,
          lastEvidenceCount: verification.attentionCount ?? current.connection.lastEvidenceCount,
          tokenExpiresAt: verification.tokenExpiresAt ?? current.connection.tokenExpiresAt,
          ...(tokenUpdate
            ? {
                accessTokenCiphertext: tokenUpdate.ciphertext,
                accessTokenIv: tokenUpdate.iv,
                accessTokenAuthTag: tokenUpdate.authTag,
              }
            : {}),
          ...(refreshUpdate
            ? {
                refreshTokenCiphertext: refreshUpdate.ciphertext,
                refreshTokenIv: refreshUpdate.iv,
                refreshTokenAuthTag: refreshUpdate.authTag,
              }
            : {}),
          failureCode:
            verification.evidenceState === "current" ? null : "calendar_evidence_unavailable",
          recoveryMessage:
            verification.evidenceState === "current"
              ? null
              : "Google Calendar could not be checked right now. Bruno paused calendar work until it is current.",
          updatedAt: at,
        })
        .where(eq(operatorCalendarConnections.id, current.connection.id))
        .returning();
      if (!saved)
        throw new FounderCalendarConnectionError(
          "connection_unavailable",
          "Calendar connection could not be updated.",
          503,
        );
      await insertCalendarReceipt(
        tx,
        saved,
        verification.evidenceState === "current" ? "verified" : "verification_failed",
        at,
        verification.evidenceState,
      );
      const bundle = await selectConnectionBundle(tx, operator.id);
      if (!bundle)
        throw new FounderCalendarConnectionError(
          "connection_unavailable",
          "Connection could not be reloaded.",
          503,
        );
      return toDto(bundle);
    });
    if (verification.evidenceState === "current" && adapter.readSelectedResources) {
      try {
        const observations = await adapter.readSelectedResources({
          accessToken: verification.accessToken ?? accessToken,
          resources: selected.map(toProviderResource),
          timeMin: new Date(now().getTime() - 24 * 60 * 60 * 1000),
          timeMax: new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000),
        });
        await ingestFounderRelationshipEvidenceForUser(
          userId,
          observations.map((observation) => ({
            ...observation,
            sourceKind: "calendar" as const,
            connectionId: current.connection.id,
            provider: current.connection.provider,
          })),
          { createConnection: () => connection, now },
        );
      } catch {
        // A successful connection check remains authoritative even if the bounded
        // relationship projection could not be refreshed in this attempt.
      }
    }
    try {
      await reconcileFounderLimitedOperationForUser(userId, {
        createConnection: () => connection,
        now,
      });
    } catch (error) {
      if (!(error instanceof FounderReleaseStageAccessError)) throw error;
      // Calendar readiness is an admission prerequisite. Before admission, there
      // is no authorized Limited Operation to reconcile yet.
    }
    return updated;
  } catch (error) {
    if (error instanceof FounderCalendarConnectionError) throw error;
    return await persistConnectionFailure({
      connection,
      operatorId: operator.id,
      now: now(),
      code: "calendar_secret_unavailable",
      message:
        "Bruno could not safely access the stored Google Calendar grant. Reconnect Google Calendar.",
      authorizationState: "authorized",
      evidenceState: "unavailable",
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function disconnectFounderGoogleCalendarForUser(
  userId: string,
  dependencies: FounderCalendarConnectionDependencies = {},
): Promise<FounderCalendarConnectionDto | null> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createAdapterForEnv(dependencies.env);
  let providerRevoked = false;
  try {
    const current = await connection.db.transaction((tx) =>
      selectConnectionBundle(tx, operator.id, true),
    );
    if (!current) return null;
    let accessToken: string | null = null;
    let refreshToken: string | null = null;
    try {
      const keyring = resolveKeyring(dependencies);
      accessToken = current.connection.accessTokenCiphertext
        ? decryptToken(
            current.connection.accessTokenCiphertext,
            current.connection.accessTokenIv,
            current.connection.accessTokenAuthTag,
            current.connection.secretKeyVersion,
            keyring,
            "google-calendar-access",
          )
        : null;
      refreshToken = current.connection.refreshTokenCiphertext
        ? decryptToken(
            current.connection.refreshTokenCiphertext,
            current.connection.refreshTokenIv,
            current.connection.refreshTokenAuthTag,
            current.connection.secretKeyVersion,
            keyring,
            "google-calendar-refresh",
          )
        : null;
    } catch {
      // Local access is still revoked below; remote revocation cannot be claimed.
    }
    if (accessToken || refreshToken) {
      try {
        providerRevoked = (await adapter.revokeAuthorization({ accessToken, refreshToken }))
          .providerRevoked;
      } catch {
        providerRevoked = false;
      }
    }
    const at = now();
    return await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const message = providerRevoked
        ? null
        : "Google access was disconnected locally, but provider revocation could not be confirmed. Bruno will not use the stored grant.";
      const [saved] = await tx
        .update(operatorCalendarConnections)
        .set({
          status: "disconnected",
          authorizationState: providerRevoked ? "revoked" : "revocation_unconfirmed",
          authorizationSessionHash: null,
          authorizationExpiresAt: null,
          ...(providerRevoked || !dependencies.preserveCredentialsOnUnconfirmedRevocation
            ? {
                accessTokenCiphertext: null,
                accessTokenIv: null,
                accessTokenAuthTag: null,
                refreshTokenCiphertext: null,
                refreshTokenIv: null,
                refreshTokenAuthTag: null,
                secretKeyVersion: null,
                tokenExpiresAt: null,
              }
            : {}),
          evidenceState: "unknown",
          lastEvidenceAt: null,
          failureCode: providerRevoked ? null : "provider_revocation_unconfirmed",
          recoveryMessage: message,
          disconnectedAt: at,
          revokedAt: providerRevoked ? at : null,
          updatedAt: at,
        })
        .where(eq(operatorCalendarConnections.id, current.connection.id))
        .returning();
      if (!saved) return null;
      await insertCalendarReceipt(
        tx,
        saved,
        providerRevoked ? "revoked" : "disconnected",
        at,
        "unknown",
      );
      const bundle = await selectConnectionBundle(tx, operator.id);
      return bundle ? toDto(bundle) : null;
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

function createAdapterForEnv(
  env: Record<string, string | undefined> | undefined,
): FounderGoogleCalendarAdapter {
  return env ? createGoogleCalendarAdapter({ env }) : createGoogleCalendarAdapter();
}

export function createGoogleCalendarAdapter(
  input: { env?: Record<string, string | undefined>; request?: typeof fetch } = {},
): FounderGoogleCalendarAdapter {
  const env = input.env ?? process.env;
  const clientId = env.BRUNO_GOOGLE_CALENDAR_CLIENT_ID?.trim();
  const clientSecret = env.BRUNO_GOOGLE_CALENDAR_CLIENT_SECRET?.trim();
  const redirectUri = env.BRUNO_GOOGLE_CALENDAR_REDIRECT_URI?.trim();
  const request = input.request ?? fetch;
  const requireConfig = () => {
    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error("Google Calendar OAuth is not configured safely.");
    }
    return { clientId, clientSecret, redirectUri };
  };

  return {
    async createAuthorizationUrl({ state }) {
      const config = requireConfig();
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", [...OIDC_SCOPES, REQUIRED_CALENDAR_SCOPE].join(" "));
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("include_granted_scopes", "true");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("state", state);
      return { authorizationUrl: url.toString(), expiresAt: new Date(Date.now() + 10 * 60 * 1000) };
    },
    async exchangeAuthorizationCode({ code }) {
      const config = requireConfig();
      const response = await request("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          grant_type: "authorization_code",
        }),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error("Google authorization code exchange failed.");
      const accessToken = readString(body.access_token);
      const refreshToken = readString(body.refresh_token);
      const expiresIn = readNumber(body.expires_in);
      if (!accessToken || !expiresIn)
        throw new Error("Google returned an invalid authorization grant.");
      return {
        accessToken,
        refreshToken,
        tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        grantedScopes: readString(body.scope)?.split(" ").filter(Boolean) ?? [],
      };
    },
    async getIdentity({ accessToken }) {
      const response = await request("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error("Google identity verification failed.");
      const providerSubjectId = readString(body.sub);
      if (!providerSubjectId) throw new Error("Google did not return a subject identity.");
      return { providerSubjectId, accountLabel: readString(body.email) };
    },
    async listCalendars({ accessToken }) {
      const resources: FounderGoogleCalendarResource[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const url = new URL("https://www.googleapis.com/calendar/v3/users/me/calendarList");
        url.searchParams.set("maxResults", "250");
        url.searchParams.set("showDeleted", "false");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await request(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const body = await readJson(response);
        if (!response.ok) throw new Error("Google Calendar list request failed.");
        const items = Array.isArray(body.items) ? body.items : [];
        for (const item of items) {
          if (!isRecord(item)) continue;
          const providerResourceId = readString(item.id);
          const summary = readString(item.summaryOverride) ?? readString(item.summary);
          if (!providerResourceId || !summary) continue;
          resources.push({
            providerResourceId,
            summary,
            timeZone: readString(item.timeZone),
            accessRole: readString(item.accessRole),
            primaryCalendar: item.primary === true,
          });
        }
        pageToken = readString(body.nextPageToken) ?? undefined;
        if (!pageToken) break;
      }
      return resources;
    },
    async verifySelectedResources({ accessToken, refreshToken, resources, timeMin, timeMax }) {
      let currentAccessToken = accessToken;
      let currentRefreshToken = refreshToken;
      let tokenExpiresAt: Date | undefined;
      let refreshed = false;
      let attentionCount = 0;
      for (const resource of resources) {
        const url = new URL(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(resource.providerResourceId)}/events`,
        );
        url.searchParams.set("timeMin", timeMin.toISOString());
        url.searchParams.set("timeMax", timeMax.toISOString());
        url.searchParams.set("maxResults", "1");
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("orderBy", "startTime");
        let response = await request(url, {
          headers: { Authorization: `Bearer ${currentAccessToken}` },
        });
        if (response.status === 401 && !refreshed) {
          const token = await refreshAccessToken(currentRefreshToken, configFor(env), request);
          currentAccessToken = token.accessToken;
          currentRefreshToken = token.refreshToken ?? currentRefreshToken;
          tokenExpiresAt = token.tokenExpiresAt;
          refreshed = true;
          response = await request(url, {
            headers: { Authorization: `Bearer ${currentAccessToken}` },
          });
        }
        const body = await readJson(response);
        if (!response.ok) {
          const identity = await this.getIdentity({ accessToken: currentAccessToken });
          return {
            ...identity,
            evidenceState: "unavailable" as const,
            attentionCount,
            ...(refreshed && tokenExpiresAt
              ? {
                  accessToken: currentAccessToken,
                  refreshToken: currentRefreshToken,
                  tokenExpiresAt,
                }
              : {}),
          };
        }
        if (isRecord(body) && Array.isArray(body.items)) attentionCount += body.items.length;
      }
      const identity = await this.getIdentity({ accessToken: currentAccessToken });
      return {
        ...identity,
        evidenceState: "current" as const,
        attentionCount,
        ...(refreshed && tokenExpiresAt
          ? { accessToken: currentAccessToken, refreshToken: currentRefreshToken, tokenExpiresAt }
          : {}),
      };
    },
    async readSelectedResources({ accessToken, resources, timeMin, timeMax }) {
      const observations: Array<
        Pick<
          FounderRelationshipObservation,
          | "providerItemId"
          | "providerIdentity"
          | "email"
          | "displayName"
          | "company"
          | "domain"
          | "excerpt"
          | "sourceMetadata"
          | "observedAt"
        >
      > = [];
      for (const resource of resources) {
        const url = new URL(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(resource.providerResourceId)}/events`,
        );
        url.searchParams.set("timeMin", timeMin.toISOString());
        url.searchParams.set("timeMax", timeMax.toISOString());
        url.searchParams.set("maxResults", "100");
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("orderBy", "startTime");
        const response = await request(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const body = await readJson(response);
        if (!response.ok) throw new Error("Google Calendar evidence request failed.");
        const items = Array.isArray(body.items) ? body.items : [];
        for (const item of items) {
          if (!isRecord(item)) continue;
          const eventId = readString(item.id);
          if (!eventId) continue;
          const summary = readString(item.summary);
          const start = readCalendarDate(item.start);
          const end = readCalendarDate(item.end);
          const attendees = Array.isArray(item.attendees) ? item.attendees : [];
          for (const attendee of attendees) {
            if (!isRecord(attendee)) continue;
            const email = readString(attendee.email)?.toLowerCase();
            if (!email || attendee.self === true) continue;
            const displayName = readString(attendee.displayName) ?? email;
            observations.push({
              providerItemId: `${eventId}:${email}`,
              email,
              displayName,
              excerpt: summary,
              observedAt: new Date(),
              sourceMetadata: {
                kind: "calendar_event",
                eventId,
                eventStartAt: start?.toISOString() ?? null,
                eventEndAt: end?.toISOString() ?? null,
                external: true,
              },
            });
          }
        }
      }
      return observations;
    },
    async revokeAuthorization({ accessToken, refreshToken }) {
      const token = refreshToken ?? accessToken;
      if (!token) return { providerRevoked: false };
      const response = await request("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });
      return { providerRevoked: response.ok };
    },
  };
}

async function refreshAccessToken(
  refreshToken: string,
  config: { clientId: string; clientSecret: string; redirectUri: string },
  request: typeof fetch,
): Promise<{ accessToken: string; refreshToken: string | null; tokenExpiresAt: Date }> {
  const response = await request("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const body = await readJson(response);
  const accessToken = readString(body.access_token);
  const expiresIn = readNumber(body.expires_in);
  if (!response.ok || !accessToken || !expiresIn) throw new Error("Google token refresh failed.");
  return {
    accessToken,
    refreshToken: readString(body.refresh_token),
    tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}

function configFor(env: Record<string, string | undefined>) {
  const clientId = env.BRUNO_GOOGLE_CALENDAR_CLIENT_ID?.trim();
  const clientSecret = env.BRUNO_GOOGLE_CALENDAR_CLIENT_SECRET?.trim();
  const redirectUri = env.BRUNO_GOOGLE_CALENDAR_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri)
    throw new Error("Google Calendar OAuth is not configured safely.");
  return { clientId, clientSecret, redirectUri };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as unknown;
  return isRecord(body) ? body : {};
}

function resolveKeyring(
  dependencies: FounderCalendarConnectionDependencies,
): OperatorSecretKeyring {
  return dependencies.keyring ?? parseOperatorSecretKeyring(dependencies.env);
}

function decryptToken(
  ciphertext: string | null,
  iv: string | null,
  authTag: string | null,
  keyVersion: string | null,
  keyring: OperatorSecretKeyring,
  scope: string,
): string {
  if (!ciphertext || !iv || !authTag || !keyVersion)
    throw new Error("Stored calendar grant is incomplete.");
  return decryptOperatorSecret({
    encrypted: { ciphertext, iv, authTag, keyVersion },
    scope,
    keyring,
  });
}

async function ensureReadyOperator(
  userId: string,
  dependencies: FounderCalendarConnectionDependencies,
) {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  if (operator.preparation.status !== "ready" || operator.runtime?.status !== "ready") {
    throw new FounderCalendarConnectionError(
      "operator_not_ready",
      "Bruno is still preparing your private workspace. Try again when it is ready.",
      409,
    );
  }
  return operator;
}

async function selectOperator(tx: FounderCalendarTransaction, userId: string) {
  const [operator] = await tx
    .select()
    .from(operators)
    .where(and(eq(operators.userId, userId), eq(operators.status, "active")))
    .limit(1);
  return operator;
}

async function selectConnectionBundle(
  tx: FounderCalendarTransaction,
  operatorId: string,
  forUpdate = false,
): Promise<{
  connection: typeof operatorCalendarConnections.$inferSelect;
  resources: (typeof operatorCalendarResources.$inferSelect)[];
  receipt: typeof operatorCalendarConnectionReceipts.$inferSelect | null;
} | null> {
  let query = tx
    .select()
    .from(operatorCalendarConnections)
    .where(eq(operatorCalendarConnections.operatorId, operatorId))
    .limit(1);
  if (forUpdate) query = query.for("update") as typeof query;
  const [connection] = await query;
  if (!connection) return null;
  const resources = await tx
    .select()
    .from(operatorCalendarResources)
    .where(eq(operatorCalendarResources.connectionId, connection.id))
    .orderBy(
      asc(operatorCalendarResources.summary),
      asc(operatorCalendarResources.providerResourceId),
    );
  const [receipt] = await tx
    .select()
    .from(operatorCalendarConnectionReceipts)
    .where(eq(operatorCalendarConnectionReceipts.connectionId, connection.id))
    .orderBy(
      desc(operatorCalendarConnectionReceipts.createdAt),
      desc(operatorCalendarConnectionReceipts.id),
    )
    .limit(1);
  return { connection, resources, receipt: receipt ?? null };
}

async function upsertCalendarResources(
  tx: FounderCalendarTransaction,
  connectionId: string,
  resources: FounderGoogleCalendarResource[],
  at: Date,
): Promise<void> {
  const ids = resources.map((resource) => resource.providerResourceId);
  if (ids.length > 0) {
    await tx
      .update(operatorCalendarResources)
      .set({ status: "removed", selected: false, updatedAt: at })
      .where(
        and(
          eq(operatorCalendarResources.connectionId, connectionId),
          notInArray(operatorCalendarResources.providerResourceId, ids),
        ),
      );
  } else {
    await tx
      .update(operatorCalendarResources)
      .set({ status: "removed", selected: false, updatedAt: at })
      .where(eq(operatorCalendarResources.connectionId, connectionId));
  }
  for (const resource of resources) {
    await tx
      .insert(operatorCalendarResources)
      .values({
        connectionId,
        providerResourceId: resource.providerResourceId,
        summary: resource.summary,
        timeZone: resource.timeZone,
        accessRole: resource.accessRole,
        primaryCalendar: resource.primaryCalendar,
        status: "available",
        discoveredAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [
          operatorCalendarResources.connectionId,
          operatorCalendarResources.providerResourceId,
        ],
        set: {
          summary: resource.summary,
          timeZone: resource.timeZone,
          accessRole: resource.accessRole,
          primaryCalendar: resource.primaryCalendar,
          status: "available",
          updatedAt: at,
        },
      });
  }
}

async function persistConnectionFailure(input: {
  connection: DatabaseConnection;
  operatorId: string;
  connectionId?: string;
  now: Date;
  code: string;
  message: string;
  authorizationState: "pending" | "authorized";
  evidenceState?: FounderCalendarEvidenceState;
}): Promise<FounderCalendarConnectionDto> {
  const result = await input.connection.db.transaction(async (tx) => {
    await lockOperator(tx, input.operatorId);
    const current = input.connectionId
      ? await tx
          .select()
          .from(operatorCalendarConnections)
          .where(eq(operatorCalendarConnections.id, input.connectionId))
          .limit(1)
          .then((rows) => rows[0])
      : (await selectConnectionBundle(tx, input.operatorId, true))?.connection;
    if (!current)
      throw new FounderCalendarConnectionError(
        "connection_unavailable",
        "Calendar connection could not be reloaded.",
        503,
      );
    const [saved] = await tx
      .update(operatorCalendarConnections)
      .set({
        status: "needs_attention",
        authorizationState: input.authorizationState,
        authorizationSessionHash: null,
        authorizationExpiresAt: null,
        evidenceState: input.evidenceState ?? current.evidenceState,
        failureCode: input.code,
        recoveryMessage: input.message,
        updatedAt: input.now,
      })
      .where(eq(operatorCalendarConnections.id, current.id))
      .returning();
    if (!saved)
      throw new FounderCalendarConnectionError(
        "connection_unavailable",
        "Calendar connection could not be saved.",
        503,
      );
    await insertCalendarReceipt(
      tx,
      saved,
      "verification_failed",
      input.now,
      input.evidenceState ?? "unavailable",
    );
    const bundle = await selectConnectionBundle(tx, input.operatorId);
    if (!bundle)
      throw new FounderCalendarConnectionError(
        "connection_unavailable",
        "Calendar connection could not be reloaded.",
        503,
      );
    return toDto(bundle);
  });
  return result;
}

async function insertCalendarReceipt(
  tx: FounderCalendarTransaction,
  connection: typeof operatorCalendarConnections.$inferSelect,
  kind:
    | "authorized"
    | "reauthorized"
    | "verified"
    | "verification_failed"
    | "revoked"
    | "disconnected",
  at: Date,
  evidenceState: FounderCalendarEvidenceState,
): Promise<void> {
  const [latest] = await tx
    .select({ createdAt: operatorCalendarConnectionReceipts.createdAt })
    .from(operatorCalendarConnectionReceipts)
    .where(eq(operatorCalendarConnectionReceipts.connectionId, connection.id))
    .orderBy(
      desc(operatorCalendarConnectionReceipts.createdAt),
      desc(operatorCalendarConnectionReceipts.id),
    )
    .limit(1);
  const createdAt =
    latest && latest.createdAt.getTime() >= at.getTime()
      ? new Date(latest.createdAt.getTime() + 1)
      : at;
  const selected = await tx
    .select({ providerResourceId: operatorCalendarResources.providerResourceId })
    .from(operatorCalendarResources)
    .where(
      and(
        eq(operatorCalendarResources.connectionId, connection.id),
        eq(operatorCalendarResources.selected, true),
      ),
    );
  const selectedResourceDigest = `sha256:${digestOperatorSecret(
    selected
      .map((row) => row.providerResourceId)
      .sort()
      .join("\0"),
  )}`;
  const evidenceDigest = `sha256:${digestOperatorSecret(JSON.stringify({ connectionId: connection.id, generation: connection.authorizationGeneration, kind, providerSubjectId: connection.providerSubjectId, selectedResourceDigest, evidenceState, at: createdAt.toISOString() }))}`;
  await tx
    .insert(operatorCalendarConnectionReceipts)
    .values({
      connectionId: connection.id,
      generation: connection.authorizationGeneration,
      kind,
      provider: GOOGLE_CALENDAR_PROVIDER,
      providerSubjectId: connection.providerSubjectId,
      accountLabel: connection.accountLabel,
      grantedScopes: connection.grantedScopes,
      selectedResourceCount: selected.length,
      selectedResourceDigest,
      evidenceState,
      status: connection.status,
      evidenceDigest,
      createdAt,
    })
    .onConflictDoNothing();
}

function toDto(bundle: {
  connection: typeof operatorCalendarConnections.$inferSelect;
  resources: (typeof operatorCalendarResources.$inferSelect)[];
  receipt: typeof operatorCalendarConnectionReceipts.$inferSelect | null;
}): FounderCalendarConnectionDto {
  return {
    provider: "google_calendar",
    status: bundle.connection.status,
    accountLabel: bundle.connection.accountLabel,
    connectedAt: bundle.connection.authorizedAt?.toISOString() ?? null,
    lastVerifiedAt: bundle.connection.lastVerifiedAt?.toISOString() ?? null,
    evidenceState: bundle.connection.evidenceState,
    workState: bundle.connection.status === "ready" ? "available" : "paused",
    recoveryMessage: bundle.connection.recoveryMessage,
    recovery: deriveFounderConnectionRecovery({
      capability: "calendar",
      status: bundle.connection.status,
      evidenceState: bundle.connection.evidenceState,
      failureCode: bundle.connection.failureCode,
      recoveryMessage: bundle.connection.recoveryMessage,
      createdAt: bundle.connection.createdAt,
      updatedAt: bundle.connection.updatedAt,
      ...(bundle.receipt?.generation ? { attemptCount: bundle.receipt.generation } : {}),
    }),
    resources: bundle.resources.map((resource) => ({
      providerResourceId: resource.providerResourceId,
      summary: resource.summary,
      timeZone: resource.timeZone,
      accessRole: resource.accessRole,
      primaryCalendar: resource.primaryCalendar,
      selected: resource.selected,
      status: resource.status,
    })),
    receipt: bundle.receipt
      ? {
          provider: "google_calendar",
          accountLabel: bundle.receipt.accountLabel,
          outcome:
            bundle.receipt.kind === "reauthorized"
              ? "reconnected"
              : bundle.receipt.kind === "verified"
                ? "verified"
                : bundle.receipt.kind === "revoked" || bundle.receipt.kind === "disconnected"
                  ? "disconnected"
                  : bundle.receipt.kind === "verification_failed"
                    ? "needs_attention"
                    : "connected",
          grantedScopes: bundle.receipt.grantedScopes,
          selectedResourceCount: bundle.receipt.selectedResourceCount,
          evidenceState: bundle.receipt.evidenceState,
          issuedAt: bundle.receipt.createdAt.toISOString(),
        }
      : null,
  };
}

function toProviderResource(
  resource: typeof operatorCalendarResources.$inferSelect,
): FounderGoogleCalendarResource {
  return {
    providerResourceId: resource.providerResourceId,
    summary: resource.summary,
    timeZone: resource.timeZone,
    accessRole: resource.accessRole,
    primaryCalendar: resource.primaryCalendar,
  };
}

async function lockOperator(tx: FounderCalendarTransaction, operatorId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:operator-calendar:${operatorId}`}, 0))`,
  );
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readCalendarDate(value: unknown): Date | null {
  if (!isRecord(value)) return null;
  const dateTime = readString(value.dateTime) ?? readString(value.date);
  if (!dateTime) return null;
  const date = new Date(dateTime);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
