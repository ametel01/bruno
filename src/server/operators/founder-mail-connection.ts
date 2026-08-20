import "server-only";

import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  operatorCalendarConnections,
  operatorMailConnectionReceipts,
  operatorMailConnections,
  operatorMailResources,
  operatorPrimaryCommunicationsSuites,
  operators,
} from "@/src/server/db/schema";
import { reconcileFounderCoreOperationForUser } from "@/src/server/operators/founder-core-operation";
import { isFounderGoogleMailReadingReleased } from "@/src/server/operators/founder-google-reading-release";
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

type FounderMailTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

const GOOGLE_MAIL_PROVIDER = "google_gmail" as const;
export const REQUIRED_MAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly" as const;
const OIDC_SCOPES = ["openid", "email", "profile"] as const;
const ALLOWED_MAIL_SCOPES = new Set<string>([...OIDC_SCOPES, REQUIRED_MAIL_SCOPE]);
const MAX_SELECTED_RESOURCES = 50;
const MAX_PROVIDER_RESOURCES = 500;
const EVIDENCE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export const FOUNDER_GOOGLE_MAIL_RELEASE_CONTROLS = {
  disclosure:
    "Bruno reads only the selected Gmail labels, keeps bounded evidence, and may send nothing through this connection.",
  retentionDays: 90,
  deletion: "Disconnect stops access; retained Bruno data follows the staged deletion controls.",
  aiLimitedUse:
    "Selected mail evidence may be processed only to prepare the Founder workspace and its bounded briefs.",
} as const;

export { isFounderGoogleMailReadingReleased } from "@/src/server/operators/founder-google-reading-release";

export type FounderMailConnectionStatus =
  | "authorizing"
  | "selecting"
  | "verifying"
  | "ready"
  | "needs_attention"
  | "disconnected";

export type FounderMailEvidenceState = "unknown" | "current" | "unavailable";

export type FounderMailResourceDto = {
  providerResourceId: string;
  name: string;
  labelType: "system" | "user";
  messageListVisibility: string | null;
  labelListVisibility: string | null;
  selected: boolean;
  status: "available" | "removed";
};

export type FounderMailConnectionDto = {
  provider: "google_gmail";
  status: FounderMailConnectionStatus;
  accountLabel: string | null;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  evidenceState: FounderMailEvidenceState;
  workState: "available" | "paused";
  recoveryMessage: string | null;
  recovery?: FounderRecoveryDto | null;
  suite: {
    status: "calendar_unavailable" | "matched" | "mismatch";
    grouped: boolean;
    name: "Primary Communications Suite";
  };
  release: {
    qualified: true;
    requiredScope: typeof REQUIRED_MAIL_SCOPE;
    disclosure: string;
    retentionDays: number;
    deletion: string;
    aiLimitedUse: string;
  };
  resources: FounderMailResourceDto[];
  receipt: {
    provider: "google_gmail";
    accountLabel: string | null;
    outcome: "connected" | "reconnected" | "verified" | "disconnected" | "needs_attention";
    grantedScopes: string[];
    selectedResourceCount: number;
    evidenceState: FounderMailEvidenceState;
    suiteStatus: "calendar_unavailable" | "matched" | "mismatch";
    issuedAt: string;
  } | null;
};

export type FounderGoogleMailResource = {
  providerResourceId: string;
  name: string;
  labelType: "system" | "user";
  messageListVisibility: string | null;
  labelListVisibility: string | null;
};

export type FounderGoogleMailAdapter = {
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
  getIdentity(input: { accessToken: string }): Promise<{
    providerSubjectId: string;
    accountLabel: string | null;
  }>;
  listResources(input: { accessToken: string }): Promise<FounderGoogleMailResource[]>;
  verifySelectedResources(input: {
    accessToken: string;
    refreshToken: string;
    resources: FounderGoogleMailResource[];
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
    resources: FounderGoogleMailResource[];
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

export type FounderMailConnectionDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  adapter?: FounderGoogleMailAdapter;
  keyring?: OperatorSecretKeyring;
  env?: Record<string, string | undefined>;
  randomBytes?: (size: number) => Buffer;
};

export type FounderMailOfferDisposition = "enabled" | "dismissed";

export type FounderGoogleMailAuthorizationResult = {
  connection: FounderMailConnectionDto;
  authorization: { authorizationUrl: string; expiresAt: string } | null;
};

export class FounderMailConnectionError extends Error {
  readonly code: string;
  readonly status: 400 | 401 | 409 | 503;

  constructor(code: string, message: string, status: 400 | 401 | 409 | 503 = 409) {
    super(message);
    this.name = "FounderMailConnectionError";
    this.code = code;
    this.status = status;
  }
}

export async function getFounderGoogleMailConnectionForUser(
  userId: string,
  dependencies: FounderMailConnectionDependencies = {},
): Promise<FounderMailConnectionDto | null> {
  if (!isFounderGoogleMailReadingReleased(dependencies.env)) return null;
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

export async function getFounderGoogleMailOfferDispositionForUser(
  userId: string,
  dependencies: FounderMailConnectionDependencies = {},
): Promise<FounderMailOfferDisposition | null> {
  if (!isFounderGoogleMailReadingReleased(dependencies.env)) return null;
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      const operator = await selectOperator(tx, userId);
      return operator?.mailOfferDisposition ?? null;
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function setFounderGoogleMailOfferDispositionForUser(
  userId: string,
  disposition: FounderMailOfferDisposition,
  dependencies: FounderMailConnectionDependencies = {},
): Promise<FounderMailOfferDisposition> {
  assertReleased(dependencies.env);
  const operator = await ensureReadyOperator(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  try {
    await connection.db
      .update(operators)
      .set({ mailOfferDisposition: disposition, updatedAt: now() })
      .where(eq(operators.id, operator.id));
    return disposition;
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function startFounderGoogleMailAuthorizationForUser(
  userId: string,
  dependencies: FounderMailConnectionDependencies = {},
): Promise<FounderGoogleMailAuthorizationResult> {
  assertReleased(dependencies.env);
  const operator = await ensureReadyOperator(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createGoogleMailAdapter({ env: dependencies.env });
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
        message: "Bruno could not start Gmail reading authorization. Try again shortly.",
        authorizationState: "pending",
        env: dependencies.env,
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
          .update(operatorMailConnections)
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
          .where(eq(operatorMailConnections.id, existing.connection.id))
          .returning();
        return updated;
      }
      const [created] = await tx
        .insert(operatorMailConnections)
        .values({
          operatorId: operator.id,
          provider: GOOGLE_MAIL_PROVIDER,
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
      throw new FounderMailConnectionError(
        "connection_unavailable",
        "Gmail reading connection could not be saved.",
        503,
      );
    }
    const result = await connection.db.transaction(async (tx) => {
      const bundle = await selectConnectionBundle(tx, operator.id);
      if (!bundle)
        throw new FounderMailConnectionError(
          "connection_unavailable",
          "Gmail reading connection could not be reloaded.",
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

export async function completeFounderGoogleMailAuthorizationForState(
  state: string,
  code: string,
  dependencies: FounderMailConnectionDependencies = {},
): Promise<FounderMailConnectionDto> {
  assertReleased(dependencies.env);
  if (!state.trim() || !code.trim()) {
    throw new FounderMailConnectionError(
      "authorization_invalid",
      "Gmail authorization is missing its state or code.",
      400,
    );
  }
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createGoogleMailAdapter({ env: dependencies.env });
  const stateHash = digestOperatorSecret(state);

  try {
    const pending = await connection.db.transaction(async (tx) => {
      const [found] = await tx
        .select()
        .from(operatorMailConnections)
        .where(eq(operatorMailConnections.authorizationSessionHash, stateHash))
        .for("update");
      if (!found) {
        throw new FounderMailConnectionError(
          "authorization_invalid",
          "That Gmail authorization is no longer active.",
          400,
        );
      }
      if (!found.authorizationExpiresAt || found.authorizationExpiresAt <= now()) {
        throw new FounderMailConnectionError(
          "authorization_expired",
          "Gmail authorization expired. Start again to reconnect.",
          400,
        );
      }
      await tx
        .update(operatorMailConnections)
        .set({
          status: "verifying",
          authorizationSessionHash: null,
          authorizationExpiresAt: null,
          updatedAt: now(),
        })
        .where(eq(operatorMailConnections.id, found.id));
      return found;
    });

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
            "google-mail-refresh",
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
          message: "Google did not provide a durable Gmail grant. Try connecting again.",
          authorizationState: "authorized",
          env: dependencies.env,
        });
      }
      if (!tokens.grantedScopes.includes(REQUIRED_MAIL_SCOPE)) {
        return await persistConnectionFailure({
          connection,
          operatorId: pending.operatorId,
          connectionId: pending.id,
          now: now(),
          code: "mail_scope_missing",
          message: "Google did not grant the released read-only Gmail access.",
          authorizationState: "authorized",
          env: dependencies.env,
        });
      }
      if (tokens.grantedScopes.some((scope) => !ALLOWED_MAIL_SCOPES.has(scope))) {
        return await persistConnectionFailure({
          connection,
          operatorId: pending.operatorId,
          connectionId: pending.id,
          now: now(),
          code: "mail_scope_too_broad",
          message:
            "Google returned broader Gmail access than Bruno is released to use. No Gmail access was enabled.",
          authorizationState: "authorized",
          env: dependencies.env,
        });
      }
      const identity = await adapter.getIdentity({ accessToken: tokens.accessToken });
      if (!identity.providerSubjectId || !identity.accountLabel) {
        return await persistConnectionFailure({
          connection,
          operatorId: pending.operatorId,
          connectionId: pending.id,
          now: now(),
          code: "mail_identity_missing",
          message: "Google did not return the Gmail account identity Bruno needs.",
          authorizationState: "authorized",
          env: dependencies.env,
        });
      }
      if (pending.providerSubjectId && pending.providerSubjectId !== identity.providerSubjectId) {
        return await persistConnectionFailure({
          connection,
          operatorId: pending.operatorId,
          connectionId: pending.id,
          now: now(),
          code: "provider_identity_changed",
          message:
            "This is a different Google account. Reconnect the Gmail account already reviewed by Bruno.",
          authorizationState: "authorized",
          env: dependencies.env,
        });
      }
      const resources = await adapter.listResources({ accessToken: tokens.accessToken });
      if (resources.length > MAX_PROVIDER_RESOURCES) {
        throw new FounderMailConnectionError(
          "mail_resource_list_too_large",
          "Google returned too many Gmail labels to review safely.",
          409,
        );
      }
      const accessToken = encryptOperatorSecret({
        value: tokens.accessToken,
        scope: "google-mail-access",
        keyring,
      });
      const encryptedRefreshToken = encryptOperatorSecret({
        value: refreshToken,
        scope: "google-mail-refresh",
        keyring,
      });
      const at = now();
      return await connection.db.transaction(async (tx) => {
        await lockOperator(tx, pending.operatorId);
        const [saved] = await tx
          .update(operatorMailConnections)
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
          .where(eq(operatorMailConnections.id, pending.id))
          .returning();
        if (!saved)
          throw new FounderMailConnectionError(
            "connection_unavailable",
            "Gmail reading connection could not be saved.",
            503,
          );
        await upsertMailResources(tx, saved.id, resources, at);
        const suiteStatus = await reconcilePrimarySuite(tx, saved, at);
        await insertMailReceipt(
          tx,
          saved,
          pending.providerSubjectId ? "reauthorized" : "authorized",
          at,
          "unknown",
          suiteStatus,
        );
        const bundle = await selectConnectionBundle(tx, pending.operatorId);
        if (!bundle)
          throw new FounderMailConnectionError(
            "connection_unavailable",
            "Gmail reading connection could not be reloaded.",
            503,
          );
        return toDto(bundle);
      });
    } catch (error) {
      if (
        error instanceof FounderMailConnectionError &&
        error.code !== "mail_resource_list_too_large"
      ) {
        throw error;
      }
      return await persistConnectionFailure({
        connection,
        operatorId: pending.operatorId,
        connectionId: pending.id,
        now: now(),
        code:
          error instanceof FounderMailConnectionError
            ? error.code
            : "authorization_verification_failed",
        message:
          error instanceof FounderMailConnectionError
            ? error.message
            : "Bruno could not verify the Gmail connection. Try again.",
        authorizationState: "authorized",
        env: dependencies.env,
      });
    }
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function denyFounderGoogleMailAuthorizationForState(
  state: string,
  dependencies: FounderMailConnectionDependencies = {},
): Promise<FounderMailConnectionDto | null> {
  if (!isFounderGoogleMailReadingReleased(dependencies.env) || !state.trim()) return null;
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await persistConnectionFailure({
      connection,
      now: (dependencies.now ?? (() => new Date()))(),
      stateHash: digestOperatorSecret(state),
      code: "authorization_denied",
      message: "Gmail reading was not enabled. Your Calendar Connection is unchanged.",
      authorizationState: "denied",
      env: dependencies.env,
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function selectFounderGoogleMailResourcesForUser(
  userId: string,
  resourceIds: string[],
  dependencies: FounderMailConnectionDependencies = {},
): Promise<FounderMailConnectionDto> {
  assertReleased(dependencies.env);
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const normalizedIds = [...new Set(resourceIds.map((value) => value.trim()).filter(Boolean))];
  if (normalizedIds.length === 0 || normalizedIds.length > MAX_SELECTED_RESOURCES) {
    throw new FounderMailConnectionError(
      "mail_selection_required",
      "Select at least one Gmail label to continue.",
      400,
    );
  }
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  try {
    return await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const current = await selectConnectionBundle(tx, operator.id, true);
      if (!current?.connection.providerSubjectId) {
        throw new FounderMailConnectionError(
          "mail_not_connected",
          "Connect Gmail reading before selecting labels.",
          409,
        );
      }
      const available = current.resources.filter((resource) => resource.status === "available");
      const availableIds = new Set(available.map((resource) => resource.providerResourceId));
      if (normalizedIds.some((id) => !availableIds.has(id))) {
        throw new FounderMailConnectionError(
          "mail_selection_invalid",
          "Choose only Gmail labels Bruno found in your account.",
          400,
        );
      }
      const at = now();
      await tx
        .update(operatorMailResources)
        .set({ selected: false, updatedAt: at })
        .where(eq(operatorMailResources.connectionId, current.connection.id));
      await tx
        .update(operatorMailResources)
        .set({ selected: true, selectionReviewedAt: at, updatedAt: at })
        .where(
          and(
            eq(operatorMailResources.connectionId, current.connection.id),
            inArray(operatorMailResources.providerResourceId, normalizedIds),
          ),
        );
      const [saved] = await tx
        .update(operatorMailConnections)
        .set({
          status: "verifying",
          evidenceState: "unknown",
          failureCode: null,
          recoveryMessage: null,
          updatedAt: at,
        })
        .where(eq(operatorMailConnections.id, current.connection.id))
        .returning();
      if (!saved)
        throw new FounderMailConnectionError(
          "connection_unavailable",
          "Gmail label selection could not be saved.",
          503,
        );
      const bundle = await selectConnectionBundle(tx, operator.id);
      if (!bundle)
        throw new FounderMailConnectionError(
          "connection_unavailable",
          "Gmail reading connection could not be reloaded.",
          503,
        );
      return toDto(bundle);
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function verifyFounderGoogleMailForUser(
  userId: string,
  dependencies: FounderMailConnectionDependencies = {},
): Promise<FounderMailConnectionDto> {
  assertReleased(dependencies.env);
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createGoogleMailAdapter({ env: dependencies.env });
  try {
    const current = await connection.db.transaction((tx) =>
      selectConnectionBundle(tx, operator.id, true),
    );
    if (!current?.connection.providerSubjectId) {
      throw new FounderMailConnectionError(
        "mail_not_connected",
        "Connect Gmail reading before verifying it.",
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
        code: "mail_selection_required",
        message: "Select at least one Gmail label before Bruno verifies the connection.",
        authorizationState: "authorized",
        env: dependencies.env,
      });
    }
    const keyring = resolveKeyring(dependencies);
    const accessToken = decryptToken(
      current.connection.accessTokenCiphertext,
      current.connection.accessTokenIv,
      current.connection.accessTokenAuthTag,
      current.connection.secretKeyVersion,
      keyring,
      "google-mail-access",
    );
    const refreshToken = decryptToken(
      current.connection.refreshTokenCiphertext,
      current.connection.refreshTokenIv,
      current.connection.refreshTokenAuthTag,
      current.connection.secretKeyVersion,
      keyring,
      "google-mail-refresh",
    );
    let verification: Awaited<ReturnType<FounderGoogleMailAdapter["verifySelectedResources"]>>;
    try {
      verification = await adapter.verifySelectedResources({
        accessToken,
        refreshToken,
        resources: selected.map(toProviderResource),
        timeMin: new Date(now().getTime() - EVIDENCE_WINDOW_MS),
        timeMax: now(),
      });
    } catch {
      return await persistConnectionFailure({
        connection,
        operatorId: operator.id,
        connectionId: current.connection.id,
        now: now(),
        code: "mail_live_check_failed",
        message: "Bruno could not complete the live Gmail check. Try again shortly.",
        authorizationState: "authorized",
        evidenceState: "unavailable",
        env: dependencies.env,
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
          "Google returned a different Gmail account identity. Reconnect the account already reviewed by Bruno.",
        authorizationState: "authorized",
        evidenceState: "unavailable",
        env: dependencies.env,
      });
    }
    const at = now();
    const updated = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const keyring = resolveKeyring(dependencies);
      const tokenUpdate = verification.accessToken
        ? encryptOperatorSecret({
            value: verification.accessToken,
            scope: "google-mail-access",
            keyring,
          })
        : null;
      const refreshUpdate = verification.refreshToken
        ? encryptOperatorSecret({
            value: verification.refreshToken,
            scope: "google-mail-refresh",
            keyring,
          })
        : null;
      const [saved] = await tx
        .update(operatorMailConnections)
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
            verification.evidenceState === "current" ? null : "mail_evidence_unavailable",
          recoveryMessage:
            verification.evidenceState === "current"
              ? null
              : "Gmail could not be checked right now. Bruno paused mail work until it is current.",
          updatedAt: at,
        })
        .where(eq(operatorMailConnections.id, current.connection.id))
        .returning();
      if (!saved)
        throw new FounderMailConnectionError(
          "connection_unavailable",
          "Gmail reading connection could not be updated.",
          503,
        );
      const suiteStatus = await reconcilePrimarySuite(tx, saved, at);
      await insertMailReceipt(
        tx,
        saved,
        verification.evidenceState === "current" ? "verified" : "verification_failed",
        at,
        verification.evidenceState,
        suiteStatus,
      );
      const bundle = await selectConnectionBundle(tx, operator.id);
      if (!bundle)
        throw new FounderMailConnectionError(
          "connection_unavailable",
          "Gmail reading connection could not be reloaded.",
          503,
        );
      return toDto(bundle);
    });
    if (verification.evidenceState === "current" && adapter.readSelectedResources) {
      try {
        const observations = await adapter.readSelectedResources({
          accessToken: verification.accessToken ?? accessToken,
          resources: selected.map(toProviderResource),
          timeMin: new Date(now().getTime() - EVIDENCE_WINDOW_MS),
          timeMax: now(),
        });
        await ingestFounderRelationshipEvidenceForUser(
          userId,
          observations.map((observation) => ({
            ...observation,
            sourceKind: "mail" as const,
            connectionId: current.connection.id,
            provider: current.connection.provider,
          })),
          { createConnection: () => connection, now },
        );
        await reconcileFounderCoreOperationForUser(userId, {
          createConnection: () => connection,
          now,
        });
      } catch {
        // Keep the verified source state even if this bounded projection refresh fails.
      }
    }
    return updated;
  } catch (error) {
    if (error instanceof FounderMailConnectionError) throw error;
    return await persistConnectionFailure({
      connection,
      operatorId: operator.id,
      now: now(),
      code: "mail_secret_unavailable",
      message: "Bruno could not safely access the stored Gmail grant. Reconnect Gmail reading.",
      authorizationState: "authorized",
      evidenceState: "unavailable",
      env: dependencies.env,
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function disconnectFounderGoogleMailForUser(
  userId: string,
  dependencies: FounderMailConnectionDependencies = {},
): Promise<FounderMailConnectionDto | null> {
  assertReleased(dependencies.env);
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createGoogleMailAdapter({ env: dependencies.env });
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
            "google-mail-access",
          )
        : null;
      refreshToken = current.connection.refreshTokenCiphertext
        ? decryptToken(
            current.connection.refreshTokenCiphertext,
            current.connection.refreshTokenIv,
            current.connection.refreshTokenAuthTag,
            current.connection.secretKeyVersion,
            keyring,
            "google-mail-refresh",
          )
        : null;
    } catch {
      // Local credentials are cleared below; provider revocation is not claimed.
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
        : "Gmail access was disconnected locally, but provider revocation could not be confirmed. Bruno will not use the stored grant.";
      const [saved] = await tx
        .update(operatorMailConnections)
        .set({
          status: "disconnected",
          authorizationState: providerRevoked ? "revoked" : "revocation_unconfirmed",
          authorizationSessionHash: null,
          authorizationExpiresAt: null,
          accessTokenCiphertext: null,
          accessTokenIv: null,
          accessTokenAuthTag: null,
          refreshTokenCiphertext: null,
          refreshTokenIv: null,
          refreshTokenAuthTag: null,
          secretKeyVersion: null,
          tokenExpiresAt: null,
          evidenceState: "unknown",
          lastEvidenceAt: null,
          failureCode: providerRevoked ? null : "provider_revocation_unconfirmed",
          recoveryMessage: message,
          disconnectedAt: at,
          revokedAt: providerRevoked ? at : null,
          updatedAt: at,
        })
        .where(eq(operatorMailConnections.id, current.connection.id))
        .returning();
      if (!saved) return null;
      await tx
        .update(operatorPrimaryCommunicationsSuites)
        .set({ status: "needs_attention", updatedAt: at })
        .where(eq(operatorPrimaryCommunicationsSuites.mailConnectionId, current.connection.id));
      const suiteStatus = current.connection.suiteStatus;
      await insertMailReceipt(
        tx,
        saved,
        providerRevoked ? "revoked" : "disconnected",
        at,
        "unknown",
        suiteStatus,
      );
      const bundle = await selectConnectionBundle(tx, operator.id);
      return bundle ? toDto(bundle) : null;
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export function createGoogleMailAdapter(
  input: { env?: Record<string, string | undefined> | undefined; request?: typeof fetch } = {},
): FounderGoogleMailAdapter {
  const env = input.env ?? process.env;
  const clientId = env.BRUNO_GOOGLE_MAIL_CLIENT_ID?.trim();
  const clientSecret = env.BRUNO_GOOGLE_MAIL_CLIENT_SECRET?.trim();
  const redirectUri = env.BRUNO_GOOGLE_MAIL_REDIRECT_URI?.trim();
  const request = input.request ?? fetch;
  const requireConfig = () => {
    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error("Google Gmail OAuth is not configured safely.");
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
      url.searchParams.set("scope", [...OIDC_SCOPES, REQUIRED_MAIL_SCOPE].join(" "));
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("include_granted_scopes", "false");
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
      if (!response.ok) throw new Error("Google Gmail authorization code exchange failed.");
      const accessToken = readString(body.access_token);
      const refreshToken = readString(body.refresh_token);
      const expiresIn = readNumber(body.expires_in);
      if (!accessToken || !expiresIn) throw new Error("Google returned an invalid Gmail grant.");
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
      if (!response.ok) throw new Error("Google Gmail identity verification failed.");
      const providerSubjectId = readString(body.sub);
      if (!providerSubjectId) throw new Error("Google did not return a Gmail subject identity.");
      return { providerSubjectId, accountLabel: readString(body.email) };
    },
    async listResources({ accessToken }) {
      const response = await request("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error("Google Gmail label list request failed.");
      const items = Array.isArray(body.labels) ? body.labels : [];
      return items.flatMap((item) => {
        if (!isRecord(item)) return [];
        const providerResourceId = readString(item.id);
        const name = readString(item.name);
        const labelType = item.type === "system" ? "system" : item.type === "user" ? "user" : null;
        if (!providerResourceId || !name || !labelType) return [];
        return [
          {
            providerResourceId,
            name,
            labelType,
            messageListVisibility: readString(item.messageListVisibility),
            labelListVisibility: readString(item.labelListVisibility),
          } satisfies FounderGoogleMailResource,
        ];
      });
    },
    async verifySelectedResources({ accessToken, refreshToken, resources, timeMin, timeMax }) {
      let currentAccessToken = accessToken;
      let currentRefreshToken = refreshToken;
      let tokenExpiresAt: Date | undefined;
      let refreshed = false;
      let attentionCount = 0;
      for (const resource of resources) {
        const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
        url.searchParams.set("labelIds", resource.providerResourceId);
        url.searchParams.set("maxResults", "1");
        url.searchParams.set("includeSpamTrash", "false");
        url.searchParams.set(
          "q",
          `after:${Math.floor(timeMin.getTime() / 1000)} before:${Math.floor(timeMax.getTime() / 1000)}`,
        );
        let response = await request(url, {
          headers: { Authorization: `Bearer ${currentAccessToken}` },
        });
        if (response.status === 401 && !refreshed) {
          const token = await refreshAccessToken(currentRefreshToken, requireConfig(), request);
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
        if (isRecord(body) && Array.isArray(body.messages)) attentionCount += body.messages.length;
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
        const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
        listUrl.searchParams.set("labelIds", resource.providerResourceId);
        listUrl.searchParams.set("maxResults", "50");
        listUrl.searchParams.set("includeSpamTrash", "false");
        listUrl.searchParams.set(
          "q",
          `after:${Math.floor(timeMin.getTime() / 1000)} before:${Math.floor(timeMax.getTime() / 1000)}`,
        );
        const listResponse = await request(listUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const listBody = await readJson(listResponse);
        if (!listResponse.ok) throw new Error("Gmail evidence list request failed.");
        const messages = Array.isArray(listBody.messages) ? listBody.messages : [];
        for (const message of messages) {
          if (!isRecord(message)) continue;
          const messageId = readString(message.id);
          if (!messageId) continue;
          const detailUrl = new URL(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
          );
          detailUrl.searchParams.set("format", "metadata");
          detailUrl.searchParams.set("metadataHeaders", "From");
          for (const header of [
            "Subject",
            "To",
            "Date",
            "Message-ID",
            "In-Reply-To",
            "References",
          ]) {
            detailUrl.searchParams.append("metadataHeaders", header);
          }
          const detailResponse = await request(detailUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const detailBody = await readJson(detailResponse);
          if (!detailResponse.ok || !isRecord(detailBody)) continue;
          const payload = isRecord(detailBody.payload) ? detailBody.payload : null;
          const headers = payload && Array.isArray(payload.headers) ? payload.headers : [];
          const from = headerValue(headers, "From");
          const email =
            from
              ?.match(/<([^>]+)>/)?.[1]
              ?.trim()
              .toLowerCase() ?? from?.trim().toLowerCase();
          if (!email?.includes("@")) continue;
          const displayName =
            from
              ?.replace(/<[^>]+>/, "")
              .replace(/"/g, "")
              .trim() || email;
          const messageAt = headerValue(headers, "Date");
          const sent = Array.isArray(detailBody.labelIds) && detailBody.labelIds.includes("SENT");
          observations.push({
            providerItemId: messageId,
            email,
            displayName,
            excerpt: headerValue(headers, "Subject"),
            observedAt: new Date(),
            sourceMetadata: {
              kind: "mail_message",
              threadId: readString(message.threadId) ?? messageId,
              direction: sent ? "outbound" : "inbound",
              messageAt:
                messageAt && !Number.isNaN(Date.parse(messageAt))
                  ? new Date(messageAt).toISOString()
                  : null,
              to: headerValue(headers, "To"),
              messageId: headerValue(headers, "Message-ID"),
              inReplyTo: headerValue(headers, "In-Reply-To"),
              references: headerValue(headers, "References"),
            },
          });
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
  if (!response.ok || !accessToken || !expiresIn)
    throw new Error("Google Gmail token refresh failed.");
  return {
    accessToken,
    refreshToken: readString(body.refresh_token),
    tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}

function assertReleased(env: Record<string, string | undefined> | undefined): void {
  if (!isFounderGoogleMailReadingReleased(env)) {
    throw new FounderMailConnectionError(
      "mail_reading_not_released",
      "Gmail reading is not available in this Bruno release.",
      409,
    );
  }
}

function headerValue(headers: unknown[], name: string): string | null {
  const header = headers.find(
    (value) => isRecord(value) && readString(value.name)?.toLowerCase() === name.toLowerCase(),
  );
  return isRecord(header) ? readString(header.value) : null;
}

async function ensureReadyOperator(
  userId: string,
  dependencies: FounderMailConnectionDependencies,
) {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  if (operator.preparation.status !== "ready" || operator.runtime?.status !== "ready") {
    throw new FounderMailConnectionError(
      "operator_not_ready",
      "Bruno is still preparing your private workspace. Try again when it is ready.",
      409,
    );
  }
  return operator;
}

async function selectOperator(tx: FounderMailTransaction, userId: string) {
  const [operator] = await tx
    .select()
    .from(operators)
    .where(and(eq(operators.userId, userId), eq(operators.status, "active")))
    .limit(1);
  return operator;
}

async function selectConnectionBundle(
  tx: FounderMailTransaction,
  operatorId: string,
  forUpdate = false,
): Promise<{
  connection: typeof operatorMailConnections.$inferSelect;
  resources: (typeof operatorMailResources.$inferSelect)[];
  receipt: typeof operatorMailConnectionReceipts.$inferSelect | null;
  suite: typeof operatorPrimaryCommunicationsSuites.$inferSelect | null;
} | null> {
  let query = tx
    .select()
    .from(operatorMailConnections)
    .where(eq(operatorMailConnections.operatorId, operatorId))
    .limit(1);
  if (forUpdate) query = query.for("update") as typeof query;
  const [connection] = await query;
  if (!connection) return null;
  const resources = await tx
    .select()
    .from(operatorMailResources)
    .where(eq(operatorMailResources.connectionId, connection.id))
    .orderBy(asc(operatorMailResources.name), asc(operatorMailResources.providerResourceId));
  const [receipt] = await tx
    .select()
    .from(operatorMailConnectionReceipts)
    .where(eq(operatorMailConnectionReceipts.connectionId, connection.id))
    .orderBy(
      desc(operatorMailConnectionReceipts.createdAt),
      desc(operatorMailConnectionReceipts.id),
    )
    .limit(1);
  const [suite] = await tx
    .select()
    .from(operatorPrimaryCommunicationsSuites)
    .where(eq(operatorPrimaryCommunicationsSuites.operatorId, operatorId))
    .limit(1);
  return { connection, resources, receipt: receipt ?? null, suite: suite ?? null };
}

async function upsertMailResources(
  tx: FounderMailTransaction,
  connectionId: string,
  resources: FounderGoogleMailResource[],
  at: Date,
): Promise<void> {
  const ids = resources.map((resource) => resource.providerResourceId);
  if (ids.length > 0) {
    await tx
      .update(operatorMailResources)
      .set({ status: "removed", selected: false, updatedAt: at })
      .where(
        and(
          eq(operatorMailResources.connectionId, connectionId),
          notInArray(operatorMailResources.providerResourceId, ids),
        ),
      );
  } else {
    await tx
      .update(operatorMailResources)
      .set({ status: "removed", selected: false, updatedAt: at })
      .where(eq(operatorMailResources.connectionId, connectionId));
  }
  for (const resource of resources) {
    await tx
      .insert(operatorMailResources)
      .values({
        connectionId,
        providerResourceId: resource.providerResourceId,
        name: resource.name,
        labelType: resource.labelType,
        messageListVisibility: resource.messageListVisibility,
        labelListVisibility: resource.labelListVisibility,
        status: "available",
        discoveredAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [operatorMailResources.connectionId, operatorMailResources.providerResourceId],
        set: {
          name: resource.name,
          labelType: resource.labelType,
          messageListVisibility: resource.messageListVisibility,
          labelListVisibility: resource.labelListVisibility,
          status: "available",
          updatedAt: at,
        },
      });
  }
}

async function reconcilePrimarySuite(
  tx: FounderMailTransaction,
  connection: typeof operatorMailConnections.$inferSelect,
  at: Date,
): Promise<"calendar_unavailable" | "matched" | "mismatch"> {
  const [calendar] = await tx
    .select()
    .from(operatorCalendarConnections)
    .where(eq(operatorCalendarConnections.operatorId, connection.operatorId))
    .limit(1);
  let suiteStatus: "calendar_unavailable" | "matched" | "mismatch" = "calendar_unavailable";
  if (
    calendar?.status === "ready" &&
    calendar.evidenceState === "current" &&
    calendar.providerSubjectId
  ) {
    suiteStatus =
      calendar.providerSubjectId === connection.providerSubjectId ? "matched" : "mismatch";
  }
  if (suiteStatus === "matched" && calendar && connection.status === "ready") {
    const [existing] = await tx
      .select()
      .from(operatorPrimaryCommunicationsSuites)
      .where(eq(operatorPrimaryCommunicationsSuites.operatorId, connection.operatorId))
      .limit(1);
    if (existing) {
      await tx
        .update(operatorPrimaryCommunicationsSuites)
        .set({
          calendarConnectionId: calendar.id,
          mailConnectionId: connection.id,
          providerSubjectId: connection.providerSubjectId ?? "",
          status: "active",
          updatedAt: at,
        })
        .where(eq(operatorPrimaryCommunicationsSuites.id, existing.id));
    } else {
      await tx.insert(operatorPrimaryCommunicationsSuites).values({
        operatorId: connection.operatorId,
        calendarConnectionId: calendar.id,
        mailConnectionId: connection.id,
        providerSubjectId: connection.providerSubjectId ?? "",
        status: "active",
        createdAt: at,
        updatedAt: at,
      });
    }
  } else {
    await tx
      .update(operatorPrimaryCommunicationsSuites)
      .set({ status: "needs_attention", updatedAt: at })
      .where(eq(operatorPrimaryCommunicationsSuites.operatorId, connection.operatorId));
  }
  await tx
    .update(operatorMailConnections)
    .set({ suiteStatus, updatedAt: at })
    .where(eq(operatorMailConnections.id, connection.id));
  return suiteStatus;
}

async function insertMailReceipt(
  tx: FounderMailTransaction,
  connection: typeof operatorMailConnections.$inferSelect,
  outcome:
    | "authorized"
    | "reauthorized"
    | "verified"
    | "verification_failed"
    | "revoked"
    | "disconnected",
  at: Date,
  evidenceState: "unknown" | "current" | "unavailable",
  suiteStatus: "calendar_unavailable" | "matched" | "mismatch",
): Promise<void> {
  const existingReceipts = await tx
    .select({ id: operatorMailConnectionReceipts.id })
    .from(operatorMailConnectionReceipts)
    .where(eq(operatorMailConnectionReceipts.connectionId, connection.id));
  const issuedAt = new Date(at.getTime() + existingReceipts.length);
  const resources = await tx
    .select({
      id: operatorMailResources.providerResourceId,
      selected: operatorMailResources.selected,
    })
    .from(operatorMailResources)
    .where(eq(operatorMailResources.connectionId, connection.id));
  const selected = resources
    .filter((resource) => resource.selected)
    .map((resource) => resource.id)
    .sort();
  await tx.insert(operatorMailConnectionReceipts).values({
    connectionId: connection.id,
    generation: connection.authorizationGeneration,
    kind:
      outcome === "authorized"
        ? "authorized"
        : outcome === "reauthorized"
          ? "reauthorized"
          : outcome === "verified"
            ? "verified"
            : outcome === "revoked"
              ? "revoked"
              : outcome === "disconnected"
                ? "disconnected"
                : "verification_failed",
    provider: GOOGLE_MAIL_PROVIDER,
    providerSubjectId: connection.providerSubjectId,
    accountLabel: connection.accountLabel,
    grantedScopes: connection.grantedScopes,
    selectedResourceCount: selected.length,
    selectedResourceDigest: digest(selected),
    evidenceState,
    suiteStatus,
    status: connection.status,
    evidenceDigest: digest({
      connectionId: connection.id,
      generation: connection.authorizationGeneration,
      outcome,
      evidenceState,
      suiteStatus,
      selected,
      at: at.toISOString(),
    }),
    createdAt: issuedAt,
  });
}

async function persistConnectionFailure(input: {
  connection: DatabaseConnection;
  operatorId?: string;
  connectionId?: string;
  stateHash?: string;
  now: Date;
  code: string;
  message: string;
  authorizationState: "pending" | "authorized" | "denied";
  evidenceState?: FounderMailEvidenceState;
  env?: Record<string, string | undefined> | undefined;
}): Promise<FounderMailConnectionDto> {
  const result = await input.connection.db.transaction(async (tx) => {
    await lockOperatorIfKnown(tx, input.operatorId);
    const current = input.connectionId
      ? await tx
          .select()
          .from(operatorMailConnections)
          .where(eq(operatorMailConnections.id, input.connectionId))
          .limit(1)
          .then((rows) => rows[0])
      : input.stateHash
        ? await tx
            .select()
            .from(operatorMailConnections)
            .where(eq(operatorMailConnections.authorizationSessionHash, input.stateHash))
            .limit(1)
            .then((rows) => rows[0])
        : input.operatorId
          ? (await selectConnectionBundle(tx, input.operatorId, true))?.connection
          : undefined;
    if (!current)
      throw new FounderMailConnectionError(
        "connection_unavailable",
        "Gmail reading connection could not be reloaded.",
        503,
      );
    const [saved] = await tx
      .update(operatorMailConnections)
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
      .where(eq(operatorMailConnections.id, current.id))
      .returning();
    if (!saved)
      throw new FounderMailConnectionError(
        "connection_unavailable",
        "Gmail reading connection could not be saved.",
        503,
      );
    const suiteStatus = await reconcilePrimarySuite(tx, saved, input.now);
    await insertMailReceipt(
      tx,
      saved,
      "verification_failed",
      input.now,
      input.evidenceState ?? "unavailable",
      suiteStatus,
    );
    const bundle = await selectConnectionBundle(tx, saved.operatorId);
    if (!bundle)
      throw new FounderMailConnectionError(
        "connection_unavailable",
        "Gmail reading connection could not be reloaded.",
        503,
      );
    return toDto(bundle);
  });
  return result;
}

function toDto(bundle: {
  connection: typeof operatorMailConnections.$inferSelect;
  resources: (typeof operatorMailResources.$inferSelect)[];
  receipt: typeof operatorMailConnectionReceipts.$inferSelect | null;
  suite: typeof operatorPrimaryCommunicationsSuites.$inferSelect | null;
}): FounderMailConnectionDto {
  return {
    provider: "google_gmail",
    status: bundle.connection.status,
    accountLabel: bundle.connection.accountLabel,
    connectedAt: bundle.connection.authorizedAt?.toISOString() ?? null,
    lastVerifiedAt: bundle.connection.lastVerifiedAt?.toISOString() ?? null,
    evidenceState: bundle.connection.evidenceState,
    workState: bundle.connection.status === "ready" ? "available" : "paused",
    recoveryMessage: bundle.connection.recoveryMessage,
    recovery: deriveFounderConnectionRecovery({
      capability: "mail",
      status: bundle.connection.status,
      evidenceState: bundle.connection.evidenceState,
      failureCode: bundle.connection.failureCode,
      recoveryMessage: bundle.connection.recoveryMessage,
      createdAt: bundle.connection.createdAt,
      updatedAt: bundle.connection.updatedAt,
      ...(bundle.receipt?.generation ? { attemptCount: bundle.receipt.generation } : {}),
    }),
    suite: {
      status: bundle.connection.suiteStatus,
      grouped: bundle.connection.suiteStatus === "matched" && bundle.suite?.status === "active",
      name: "Primary Communications Suite",
    },
    release: {
      qualified: true,
      requiredScope: REQUIRED_MAIL_SCOPE,
      ...FOUNDER_GOOGLE_MAIL_RELEASE_CONTROLS,
    },
    resources: bundle.resources.map((resource) => ({
      providerResourceId: resource.providerResourceId,
      name: resource.name,
      labelType: resource.labelType === "system" ? "system" : "user",
      messageListVisibility: resource.messageListVisibility,
      labelListVisibility: resource.labelListVisibility,
      selected: resource.selected,
      status: resource.status === "available" ? "available" : "removed",
    })),
    receipt: bundle.receipt
      ? {
          provider: "google_gmail",
          accountLabel: bundle.receipt.accountLabel,
          outcome:
            bundle.receipt.kind === "authorized"
              ? "connected"
              : bundle.receipt.kind === "reauthorized"
                ? "reconnected"
                : bundle.receipt.kind === "verified"
                  ? "verified"
                  : bundle.receipt.kind === "disconnected" || bundle.receipt.kind === "revoked"
                    ? "disconnected"
                    : "needs_attention",
          grantedScopes: bundle.receipt.grantedScopes,
          selectedResourceCount: bundle.receipt.selectedResourceCount,
          evidenceState: bundle.receipt.evidenceState,
          suiteStatus: bundle.receipt.suiteStatus,
          issuedAt: bundle.receipt.createdAt.toISOString(),
        }
      : null,
  };
}

async function lockOperator(tx: FounderMailTransaction, operatorId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:founder-operator:${operatorId}`}, 0))`,
  );
}

async function lockOperatorIfKnown(
  tx: FounderMailTransaction,
  operatorId: string | undefined,
): Promise<void> {
  if (operatorId) await lockOperator(tx, operatorId);
}

function resolveKeyring(dependencies: FounderMailConnectionDependencies): OperatorSecretKeyring {
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
    throw new Error("Stored Gmail grant is incomplete.");
  return decryptOperatorSecret({
    encrypted: { ciphertext, iv, authTag, keyVersion },
    scope,
    keyring,
  });
}

function digest(value: unknown): string {
  return `sha256:${digestOperatorSecret(JSON.stringify(value))}`;
}

function toProviderResource(
  resource: typeof operatorMailResources.$inferSelect,
): FounderGoogleMailResource {
  return {
    providerResourceId: resource.providerResourceId,
    name: resource.name,
    labelType: resource.labelType === "system" ? "system" : "user",
    messageListVisibility: resource.messageListVisibility,
    labelListVisibility: resource.labelListVisibility,
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as unknown;
  return isRecord(body) ? body : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
