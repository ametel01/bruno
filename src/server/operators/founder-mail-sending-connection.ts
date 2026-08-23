import "server-only";

import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  operatorActionPreviews,
  operatorMailConnections,
  operatorMailSendingConnectionReceipts,
  operatorMailSendingConnections,
  operatorPrimaryCommunicationsSuites,
  operators,
} from "@/src/server/db/schema";
import { isFounderGoogleMailSendingReleased } from "@/src/server/operators/founder-google-mail-sending-release";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";
import {
  deriveFounderConnectionRecovery,
  type FounderRecoveryDto,
} from "@/src/server/operators/founder-recovery";
import {
  decryptOperatorSecret,
  digestOperatorSecret,
  encryptOperatorSecret,
  type OperatorSecretKeyring,
  parseOperatorSecretKeyring,
} from "@/src/server/secrets/operator-secret-keyring";

type FounderMailSendingTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export const GOOGLE_MAIL_SENDING_PROVIDER = "google_gmail_sending" as const;
export const REQUIRED_MAIL_SENDING_SCOPE = "https://www.googleapis.com/auth/gmail.send" as const;
const OIDC_SCOPES = ["openid", "email", "profile"] as const;
const ALLOWED_SCOPES = new Set<string>([...OIDC_SCOPES, REQUIRED_MAIL_SENDING_SCOPE]);

export const FOUNDER_GOOGLE_MAIL_SENDING_RELEASE_CONTROLS = {
  disclosure:
    "Optional send-only Gmail access. Bruno cannot read, modify, or delete mail through this connection.",
  deletion:
    "Disconnect revokes only this send-only grant; Gmail reading and Calendar remain unchanged.",
} as const;

export { isFounderGoogleMailSendingReleased } from "@/src/server/operators/founder-google-mail-sending-release";

export type FounderMailSendingConnectionStatus =
  | "authorizing"
  | "verifying"
  | "ready"
  | "needs_attention"
  | "disconnected";
export type FounderMailSendingConnectionDto = {
  provider: typeof GOOGLE_MAIL_SENDING_PROVIDER;
  status: FounderMailSendingConnectionStatus;
  accountLabel: string | null;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  workState: "available" | "paused";
  recoveryMessage: string | null;
  recovery?: FounderRecoveryDto | null;
  release: {
    qualified: true;
    requiredScope: typeof REQUIRED_MAIL_SENDING_SCOPE;
    disclosure: string;
    deletion: string;
  };
  receipt: {
    outcome:
      | "connected"
      | "reconnected"
      | "verified"
      | "denied"
      | "disconnected"
      | "needs_attention";
    providerSubjectId: string | null;
    accountLabel: string | null;
    grantedScopes: string[];
    issuedAt: string;
  } | null;
};

export type FounderGoogleMailSendingAdapter = {
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
  revokeAuthorization(input: {
    accessToken: string | null;
    refreshToken: string | null;
  }): Promise<{ providerRevoked: boolean }>;
  sendMessage?: (input: {
    accessToken: string;
    rawMessage: string;
  }) => Promise<
    | { ok: true; providerMessageId: string; providerThreadId: string | null }
    | { ok: false; kind: "rejected"; code: string; message: string }
  >;
};

export type FounderMailSendingConnectionDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  adapter?: FounderGoogleMailSendingAdapter;
  keyring?: OperatorSecretKeyring;
  env?: Record<string, string | undefined>;
  randomBytes?: (size: number) => Buffer;
  preserveCredentialsOnUnconfirmedRevocation?: boolean;
};

export class FounderMailSendingConnectionError extends Error {
  readonly code: string;
  readonly status: 400 | 409 | 503;
  constructor(code: string, message: string, status: 400 | 409 | 503 = 409) {
    super(message);
    this.name = "FounderMailSendingConnectionError";
    this.code = code;
    this.status = status;
  }
}

export async function getFounderGoogleMailSendingConnectionForUser(
  userId: string,
  dependencies: FounderMailSendingConnectionDependencies = {},
): Promise<FounderMailSendingConnectionDto | null> {
  if (!isFounderGoogleMailSendingReleased(dependencies.env)) return null;
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      const operator = await selectOperator(tx, userId);
      if (!operator) return null;
      const bundle = await selectBundle(tx, operator.id);
      return bundle ? toDto(bundle) : null;
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function getFounderGoogleMailSendingOfferForUser(
  userId: string,
  dependencies: FounderMailSendingConnectionDependencies = {},
): Promise<boolean> {
  if (!isFounderGoogleMailSendingReleased(dependencies.env)) return false;
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      const operator = await selectOperator(tx, userId);
      if (!operator) return false;
      const [preview] = await tx
        .select()
        .from(operatorActionPreviews)
        .where(eq(operatorActionPreviews.operatorId, operator.id))
        .limit(1);
      const [mail] = await tx
        .select()
        .from(operatorMailConnections)
        .where(eq(operatorMailConnections.operatorId, operator.id))
        .limit(1);
      const [suite] = await tx
        .select()
        .from(operatorPrimaryCommunicationsSuites)
        .where(eq(operatorPrimaryCommunicationsSuites.operatorId, operator.id))
        .limit(1);
      return (
        !preview?.mailSendingOfferDismissedAt &&
        mail?.status === "ready" &&
        suite?.status === "active" &&
        suite.mailConnectionId === mail.id
      );
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function startFounderGoogleMailSendingAuthorizationForUser(
  userId: string,
  dependencies: FounderMailSendingConnectionDependencies = {},
): Promise<{
  connection: FounderMailSendingConnectionDto | null;
  authorization: { authorizationUrl: string; expiresAt: string } | null;
}> {
  assertReleased(dependencies.env);
  const operator = await ensureReadyOperator(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createGoogleMailSendingAdapter({ env: dependencies.env });
  try {
    const current = await connection.db.transaction((tx) => selectBundle(tx, operator.id, true));
    if (
      !current?.mail?.status ||
      current.mail.status !== "ready" ||
      current.suite?.status !== "active" ||
      current.suite.mailConnectionId !== current.mail.id
    ) {
      throw new FounderMailSendingConnectionError(
        "mail_reading_required",
        "Connect and verify Gmail reading before enabling optional Mail Sending.",
      );
    }
    const state = (dependencies.randomBytes ?? randomBytes)(32).toString("base64url");
    const authorization = await adapter.createAuthorizationUrl({
      state,
      reconnecting: Boolean(current.sending?.providerSubjectId),
    });
    const generation = current.sending
      ? current.sending.status === "authorizing"
        ? current.sending.authorizationGeneration
        : current.sending.authorizationGeneration + 1
      : 1;
    await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const [saved] = await tx
        .insert(operatorMailSendingConnections)
        .values({
          operatorId: operator.id,
          mailConnectionId: current.mail?.id,
          provider: GOOGLE_MAIL_SENDING_PROVIDER,
          status: "authorizing",
          authorizationState: "pending",
          authorizationSessionHash: digestOperatorSecret(state),
          authorizationExpiresAt: authorization.expiresAt,
          authorizationGeneration: generation,
          createdAt: now(),
          updatedAt: now(),
        })
        .onConflictDoUpdate({
          target: operatorMailSendingConnections.operatorId,
          set: {
            mailConnectionId: current.mail?.id,
            status: "authorizing",
            authorizationState: "pending",
            authorizationSessionHash: digestOperatorSecret(state),
            authorizationExpiresAt: authorization.expiresAt,
            authorizationGeneration: generation,
            failureCode: null,
            recoveryMessage: null,
            updatedAt: now(),
          },
        })
        .returning();
      if (!saved)
        throw new FounderMailSendingConnectionError(
          "connection_unavailable",
          "Mail Sending connection could not be saved.",
          503,
        );
    });
    const saved = await connection.db.transaction((tx) => selectBundle(tx, operator.id));
    return {
      connection: saved ? toDto(saved) : null,
      authorization: {
        authorizationUrl: authorization.authorizationUrl,
        expiresAt: authorization.expiresAt.toISOString(),
      },
    };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function completeFounderGoogleMailSendingAuthorizationForState(
  state: string,
  code: string,
  dependencies: FounderMailSendingConnectionDependencies = {},
): Promise<FounderMailSendingConnectionDto> {
  assertReleased(dependencies.env);
  if (!state.trim() || !code.trim())
    throw new FounderMailSendingConnectionError(
      "authorization_invalid",
      "Mail Sending authorization is missing its state or code.",
      400,
    );
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const adapter = dependencies.adapter ?? createGoogleMailSendingAdapter({ env: dependencies.env });
  try {
    const stateHash = digestOperatorSecret(state);
    const pending = await connection.db.transaction(async (tx) => {
      const [found] = await tx
        .select()
        .from(operatorMailSendingConnections)
        .where(eq(operatorMailSendingConnections.authorizationSessionHash, stateHash))
        .for("update");
      if (!found)
        throw new FounderMailSendingConnectionError(
          "authorization_invalid",
          "That Mail Sending authorization is no longer active.",
          400,
        );
      if (!found.authorizationExpiresAt || found.authorizationExpiresAt <= now())
        throw new FounderMailSendingConnectionError(
          "authorization_expired",
          "Mail Sending authorization expired. Start again to reconnect.",
          400,
        );
      await tx
        .update(operatorMailSendingConnections)
        .set({
          status: "verifying",
          authorizationSessionHash: null,
          authorizationExpiresAt: null,
          updatedAt: now(),
        })
        .where(eq(operatorMailSendingConnections.id, found.id));
      return found;
    });
    try {
      const tokens = await adapter.exchangeAuthorizationCode({ code });
      const keyring = resolveKeyring(dependencies);
      const previousRefresh = pending.refreshTokenCiphertext
        ? decryptStoredSecret(pending, "refresh", keyring)
        : null;
      const refreshToken = tokens.refreshToken ?? previousRefresh;
      if (!refreshToken)
        return fail(
          connection,
          pending,
          now,
          "refresh_token_missing",
          "Google did not provide a durable send-only grant. Try connecting again.",
        );
      if (!tokens.grantedScopes.includes(REQUIRED_MAIL_SENDING_SCOPE))
        return fail(
          connection,
          pending,
          now,
          "mail_send_scope_missing",
          "Google did not grant the released send-only Gmail access.",
        );
      if (tokens.grantedScopes.some((scope) => !ALLOWED_SCOPES.has(scope)))
        return fail(
          connection,
          pending,
          now,
          "mail_scope_too_broad",
          "Google returned broader Gmail access than Bruno is released to use. No sending access was enabled.",
        );
      const identity = await adapter.getIdentity({ accessToken: tokens.accessToken });
      if (!identity.providerSubjectId || !identity.accountLabel)
        return fail(
          connection,
          pending,
          now,
          "mail_identity_missing",
          "Google did not return the sending account identity.",
        );
      const identityMatch = await connection.db.transaction(async (tx) => {
        const [mail] = await tx
          .select()
          .from(operatorMailConnections)
          .where(eq(operatorMailConnections.operatorId, pending.operatorId))
          .limit(1);
        const [suite] = await tx
          .select()
          .from(operatorPrimaryCommunicationsSuites)
          .where(eq(operatorPrimaryCommunicationsSuites.operatorId, pending.operatorId))
          .limit(1);
        return Boolean(
          mail?.status === "ready" &&
            suite?.status === "active" &&
            suite.mailConnectionId === mail.id &&
            mail.providerSubjectId === identity.providerSubjectId,
        );
      });
      if (!identityMatch)
        return fail(
          connection,
          pending,
          now,
          "provider_identity_mismatch",
          "Connect the send-only grant for the same Google account as Primary Communications Suite Mail.",
        );
      const access = encryptOperatorSecret({
        value: tokens.accessToken,
        scope: "google-mail-sending-access",
        keyring,
      });
      const refresh = encryptOperatorSecret({
        value: refreshToken,
        scope: "google-mail-sending-refresh",
        keyring,
      });
      return await connection.db.transaction(async (tx) => {
        await lockOperator(tx, pending.operatorId);
        const [saved] = await tx
          .update(operatorMailSendingConnections)
          .set({
            mailConnectionId:
              (
                await tx
                  .select({ id: operatorMailConnections.id })
                  .from(operatorMailConnections)
                  .where(
                    and(
                      eq(operatorMailConnections.operatorId, pending.operatorId),
                      eq(operatorMailConnections.provider, "google_gmail"),
                    ),
                  )
                  .limit(1)
              )[0]?.id ?? null,
            providerSubjectId: identity.providerSubjectId,
            accountLabel: identity.accountLabel,
            status: "ready",
            authorizationState: "authorized",
            accessTokenCiphertext: access.ciphertext,
            accessTokenIv: access.iv,
            accessTokenAuthTag: access.authTag,
            refreshTokenCiphertext: refresh.ciphertext,
            refreshTokenIv: refresh.iv,
            refreshTokenAuthTag: refresh.authTag,
            secretKeyVersion: access.keyVersion,
            tokenExpiresAt: tokens.tokenExpiresAt,
            grantedScopes: tokens.grantedScopes,
            authorizedAt: pending.authorizedAt ?? now(),
            lastVerifiedAt: now(),
            failureCode: null,
            recoveryMessage: null,
            disconnectedAt: null,
            revokedAt: null,
            updatedAt: now(),
          })
          .where(eq(operatorMailSendingConnections.id, pending.id))
          .returning();
        if (!saved)
          throw new FounderMailSendingConnectionError(
            "connection_unavailable",
            "Mail Sending connection could not be saved.",
            503,
          );
        await insertReceipt(
          tx,
          saved,
          pending.providerSubjectId ? "reauthorized" : "authorized",
          now(),
        );
        const bundle = await selectBundle(tx, pending.operatorId);
        if (!bundle)
          throw new FounderMailSendingConnectionError(
            "connection_unavailable",
            "Mail Sending connection could not be reloaded.",
            503,
          );
        return toDto(bundle);
      });
    } catch (error) {
      if (
        error instanceof FounderMailSendingConnectionError &&
        error.code !== "connection_unavailable"
      )
        throw error;
      return fail(
        connection,
        pending,
        now,
        "authorization_verification_failed",
        "Bruno could not verify the Mail Sending connection. Try again.",
      );
    }
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function denyFounderGoogleMailSendingAuthorizationForState(
  state: string,
  dependencies: FounderMailSendingConnectionDependencies = {},
): Promise<FounderMailSendingConnectionDto | null> {
  if (!isFounderGoogleMailSendingReleased(dependencies.env) || !state.trim()) return null;
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const hash = digestOperatorSecret(state);
    return await connection.db.transaction(async (tx) => {
      const [pending] = await tx
        .select()
        .from(operatorMailSendingConnections)
        .where(eq(operatorMailSendingConnections.authorizationSessionHash, hash))
        .limit(1);
      if (!pending) return null;
      const [saved] = await tx
        .update(operatorMailSendingConnections)
        .set({
          status: "needs_attention",
          authorizationState: "denied",
          authorizationSessionHash: null,
          authorizationExpiresAt: null,
          failureCode: "authorization_denied",
          recoveryMessage:
            "Mail Sending was not enabled. Gmail reading and Calendar are unchanged.",
          updatedAt: (dependencies.now ?? (() => new Date()))(),
        })
        .where(eq(operatorMailSendingConnections.id, pending.id))
        .returning();
      if (saved) await insertReceipt(tx, saved, "denied", dependencies.now?.() ?? new Date());
      const bundle = await selectBundle(tx, pending.operatorId);
      return bundle ? toDto(bundle) : null;
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function verifyFounderGoogleMailSendingForUser(
  userId: string,
  dependencies: FounderMailSendingConnectionDependencies = {},
): Promise<FounderMailSendingConnectionDto | null> {
  assertReleased(dependencies.env);
  const operator = await ensureReadyOperator(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      const bundle = await selectBundle(tx, operator.id, true);
      if (!bundle?.sending) return null;
      if (!bundle.sending.accessTokenCiphertext) return toDto(bundle);
      const identity = await (
        dependencies.adapter ?? createGoogleMailSendingAdapter({ env: dependencies.env })
      ).getIdentity({
        accessToken: decryptStoredSecret(bundle.sending, "access", resolveKeyring(dependencies)),
      });
      const at = (dependencies.now ?? (() => new Date()))();
      const matches = identity.providerSubjectId === bundle.mail?.providerSubjectId;
      const [saved] = await tx
        .update(operatorMailSendingConnections)
        .set({
          status: matches ? "ready" : "needs_attention",
          lastVerifiedAt: matches ? at : bundle.sending.lastVerifiedAt,
          failureCode: matches ? null : "provider_identity_mismatch",
          recoveryMessage: matches
            ? null
            : "Connect the same Google account as Primary Communications Suite Mail.",
          updatedAt: at,
        })
        .where(eq(operatorMailSendingConnections.id, bundle.sending.id))
        .returning();
      if (saved) await insertReceipt(tx, saved, matches ? "verified" : "verification_failed", at);
      const result = await selectBundle(tx, operator.id);
      return result ? toDto(result) : null;
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function disconnectFounderGoogleMailSendingForUser(
  userId: string,
  dependencies: FounderMailSendingConnectionDependencies = {},
): Promise<FounderMailSendingConnectionDto | null> {
  assertReleased(dependencies.env);
  const operator = await ensureReadyOperator(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  let providerRevoked = false;
  try {
    const current = await connection.db.transaction((tx) => selectBundle(tx, operator.id, true));
    if (!current?.sending) return null;
    const sending = current.sending;
    let accessToken: string | null = null;
    let refreshToken: string | null = null;
    try {
      const keyring = resolveKeyring(dependencies);
      if (current.sending.accessTokenCiphertext)
        accessToken = decryptStoredSecret(current.sending, "access", keyring);
      if (current.sending.refreshTokenCiphertext)
        refreshToken = decryptStoredSecret(current.sending, "refresh", keyring);
    } catch {
      /* clear locally; do not claim provider revocation */
    }
    if (accessToken || refreshToken) {
      try {
        providerRevoked = (
          await (
            dependencies.adapter ?? createGoogleMailSendingAdapter({ env: dependencies.env })
          ).revokeAuthorization({ accessToken, refreshToken })
        ).providerRevoked;
      } catch {
        providerRevoked = false;
      }
    }
    return await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const at = now();
      const [saved] = await tx
        .update(operatorMailSendingConnections)
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
          failureCode: providerRevoked ? null : "provider_revocation_unconfirmed",
          recoveryMessage: providerRevoked
            ? null
            : "Mail Sending was disconnected locally, but provider revocation could not be confirmed.",
          disconnectedAt: at,
          revokedAt: providerRevoked ? at : null,
          updatedAt: at,
        })
        .where(eq(operatorMailSendingConnections.id, sending.id))
        .returning();
      if (saved) await insertReceipt(tx, saved, providerRevoked ? "revoked" : "disconnected", at);
      const bundle = await selectBundle(tx, operator.id);
      return bundle ? toDto(bundle) : null;
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export function createGoogleMailSendingAdapter(
  input: { env?: Record<string, string | undefined> | undefined; request?: typeof fetch } = {},
): FounderGoogleMailSendingAdapter {
  const env = input.env ?? process.env;
  const clientId = env.BRUNO_GOOGLE_MAIL_SENDING_CLIENT_ID?.trim();
  const clientSecret = env.BRUNO_GOOGLE_MAIL_SENDING_CLIENT_SECRET?.trim();
  const redirectUri = env.BRUNO_GOOGLE_MAIL_SENDING_REDIRECT_URI?.trim();
  const request = input.request ?? fetch;
  const config = () => {
    if (!clientId || !clientSecret || !redirectUri)
      throw new Error("Google Mail Sending OAuth is not configured safely.");
    return { clientId, clientSecret, redirectUri };
  };
  return {
    async createAuthorizationUrl({ state }) {
      const c = config();
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", c.clientId);
      url.searchParams.set("redirect_uri", c.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", [...OIDC_SCOPES, REQUIRED_MAIL_SENDING_SCOPE].join(" "));
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("include_granted_scopes", "false");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("state", state);
      return { authorizationUrl: url.toString(), expiresAt: new Date(Date.now() + 10 * 60 * 1000) };
    },
    async exchangeAuthorizationCode({ code }) {
      const c = config();
      const response = await request("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: c.clientId,
          client_secret: c.clientSecret,
          redirect_uri: c.redirectUri,
          grant_type: "authorization_code",
        }),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const accessToken = typeof body.access_token === "string" ? body.access_token : null;
      const expiresIn =
        typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in);
      if (!response.ok || !accessToken || !Number.isFinite(expiresIn))
        throw new Error("Google returned an invalid send-only Gmail grant.");
      return {
        accessToken,
        refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
        tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        grantedScopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [],
      };
    },
    async getIdentity({ accessToken }) {
      const response = await request("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const providerSubjectId = typeof body.sub === "string" ? body.sub : "";
      if (!response.ok || !providerSubjectId)
        throw new Error("Google Mail Sending identity verification failed.");
      return {
        providerSubjectId,
        accountLabel: typeof body.email === "string" ? body.email : null,
      };
    },
    async revokeAuthorization({ accessToken, refreshToken }) {
      const token = refreshToken ?? accessToken;
      if (!token) return { providerRevoked: false };
      const response = await request(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
        { method: "POST" },
      );
      return { providerRevoked: response.ok };
    },
    async sendMessage({ accessToken, rawMessage }) {
      const response = await request(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw: encodeBase64Url(rawMessage) }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        if (response.status >= 500 || response.status === 429)
          throw new Error("Google did not prove whether the Gmail message was accepted.");
        return {
          ok: false,
          kind: "rejected",
          code:
            typeof body.error === "object"
              ? "gmail_send_rejected"
              : `gmail_http_${response.status}`,
          message: "Google rejected the Gmail message before it was accepted.",
        };
      }
      const providerMessageId = typeof body.id === "string" ? body.id : null;
      if (!providerMessageId)
        throw new Error("Google accepted the request without returning a message identity.");
      return {
        ok: true,
        providerMessageId,
        providerThreadId: typeof body.threadId === "string" ? body.threadId : null,
      };
    },
  };
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function fail(
  connection: DatabaseConnection,
  pending: typeof operatorMailSendingConnections.$inferSelect,
  now: () => Date,
  code: string,
  message: string,
): Promise<FounderMailSendingConnectionDto> {
  return connection.db.transaction(async (tx) => {
    const at = now();
    const [saved] = await tx
      .update(operatorMailSendingConnections)
      .set({
        status: "needs_attention",
        authorizationState: "authorized",
        failureCode: code,
        recoveryMessage: message,
        authorizationSessionHash: null,
        authorizationExpiresAt: null,
        updatedAt: at,
      })
      .where(eq(operatorMailSendingConnections.id, pending.id))
      .returning();
    if (saved)
      await insertReceipt(
        tx,
        saved,
        code === "authorization_denied" ? "denied" : "verification_failed",
        at,
      );
    const bundle = await selectBundle(tx, pending.operatorId);
    if (!bundle)
      throw new FounderMailSendingConnectionError(
        "connection_unavailable",
        "Mail Sending connection could not be reloaded.",
        503,
      );
    return toDto(bundle);
  });
}

async function selectOperator(tx: FounderMailSendingTransaction, userId: string) {
  const [operator] = await tx
    .select()
    .from(operators)
    .where(and(eq(operators.userId, userId), eq(operators.status, "active")))
    .limit(1);
  return operator;
}
async function selectBundle(
  tx: FounderMailSendingTransaction,
  operatorId: string,
  forUpdate = false,
) {
  let query = tx
    .select()
    .from(operatorMailSendingConnections)
    .where(eq(operatorMailSendingConnections.operatorId, operatorId))
    .limit(1);
  if (forUpdate) query = query.for("update") as typeof query;
  const [sending] = await query;
  const [mail] = await tx
    .select()
    .from(operatorMailConnections)
    .where(eq(operatorMailConnections.operatorId, operatorId))
    .limit(1);
  const [suite] = await tx
    .select()
    .from(operatorPrimaryCommunicationsSuites)
    .where(eq(operatorPrimaryCommunicationsSuites.operatorId, operatorId))
    .limit(1);
  const [receipt] = sending
    ? await tx
        .select()
        .from(operatorMailSendingConnectionReceipts)
        .where(eq(operatorMailSendingConnectionReceipts.connectionId, sending.id))
        .orderBy(
          desc(operatorMailSendingConnectionReceipts.createdAt),
          desc(operatorMailSendingConnectionReceipts.id),
        )
        .limit(1)
    : [];
  return {
    sending: sending ?? null,
    mail: mail ?? null,
    suite: suite ?? null,
    receipt: receipt ?? null,
  };
}
async function insertReceipt(
  tx: FounderMailSendingTransaction,
  connection: typeof operatorMailSendingConnections.$inferSelect,
  kind:
    | "authorized"
    | "reauthorized"
    | "verified"
    | "verification_failed"
    | "denied"
    | "revoked"
    | "disconnected",
  at: Date,
) {
  await tx.insert(operatorMailSendingConnectionReceipts).values({
    connectionId: connection.id,
    generation: connection.authorizationGeneration,
    kind,
    provider: GOOGLE_MAIL_SENDING_PROVIDER,
    providerSubjectId: connection.providerSubjectId,
    accountLabel: connection.accountLabel,
    grantedScopes: connection.grantedScopes,
    status: connection.status,
    evidenceDigest: `sha256:${digestOperatorSecret(JSON.stringify({ kind, generation: connection.authorizationGeneration, subject: connection.providerSubjectId, scopes: connection.grantedScopes }))}`,
    createdAt: at,
  });
}
async function lockOperator(tx: FounderMailSendingTransaction, operatorId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bruno:founder-mail-sending:${operatorId}`}, 0))`,
  );
}
function resolveKeyring(dependencies: FounderMailSendingConnectionDependencies) {
  return dependencies.keyring ?? parseOperatorSecretKeyring(dependencies.env);
}

export function decryptFounderGoogleMailSendingAccessToken(
  row: typeof operatorMailSendingConnections.$inferSelect,
  dependencies: FounderMailSendingConnectionDependencies,
): string {
  return decryptStoredSecret(row, "access", resolveKeyring(dependencies));
}

function decryptStoredSecret(
  row: typeof operatorMailSendingConnections.$inferSelect,
  kind: "access" | "refresh",
  keyring: OperatorSecretKeyring,
): string {
  const ciphertext = kind === "access" ? row.accessTokenCiphertext : row.refreshTokenCiphertext;
  const iv = kind === "access" ? row.accessTokenIv : row.refreshTokenIv;
  const authTag = kind === "access" ? row.accessTokenAuthTag : row.refreshTokenAuthTag;
  const scope = kind === "access" ? "google-mail-sending-access" : "google-mail-sending-refresh";
  if (!ciphertext || !iv || !authTag || !row.secretKeyVersion) {
    throw new Error("Stored Mail Sending credential is incomplete.");
  }
  return decryptOperatorSecret({
    encrypted: { ciphertext, iv, authTag, keyVersion: row.secretKeyVersion },
    scope,
    keyring,
  });
}
function assertReleased(env: Record<string, string | undefined> | undefined) {
  if (!isFounderGoogleMailSendingReleased(env))
    throw new FounderMailSendingConnectionError(
      "mail_sending_not_released",
      "Mail Sending is not available in this Bruno release.",
    );
}
async function ensureReadyOperator(
  userId: string,
  dependencies: FounderMailSendingConnectionDependencies,
) {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  if (operator.preparation.status !== "ready" || operator.runtime?.status !== "ready")
    throw new FounderMailSendingConnectionError(
      "operator_not_ready",
      "Bruno is still preparing your private workspace. Try again when it is ready.",
    );
  return operator;
}
function toDto(bundle: Awaited<ReturnType<typeof selectBundle>>): FounderMailSendingConnectionDto {
  const s = bundle.sending;
  const paused =
    bundle.mail?.status !== "ready" ||
    !bundle.suite ||
    bundle.suite.status !== "active" ||
    bundle.suite.mailConnectionId !== bundle.mail.id;
  return {
    provider: GOOGLE_MAIL_SENDING_PROVIDER,
    status: s?.status ?? "disconnected",
    accountLabel: s?.accountLabel ?? null,
    connectedAt: s?.authorizedAt?.toISOString() ?? null,
    lastVerifiedAt: s?.lastVerifiedAt?.toISOString() ?? null,
    workState: paused ? "paused" : "available",
    recoveryMessage: s?.recoveryMessage ?? null,
    recovery: deriveFounderConnectionRecovery({
      capability: "mail_sending",
      status: s?.status ?? "disconnected",
      failureCode: s?.failureCode ?? null,
      recoveryMessage: s?.recoveryMessage ?? null,
      createdAt: s?.createdAt ?? null,
      updatedAt: s?.updatedAt ?? new Date(),
      ...(bundle.receipt?.generation ? { attemptCount: bundle.receipt.generation } : {}),
    }),
    release: {
      qualified: true,
      requiredScope: REQUIRED_MAIL_SENDING_SCOPE,
      ...FOUNDER_GOOGLE_MAIL_SENDING_RELEASE_CONTROLS,
    },
    receipt: bundle.receipt
      ? {
          outcome:
            bundle.receipt.kind === "authorized"
              ? "connected"
              : bundle.receipt.kind === "reauthorized"
                ? "reconnected"
                : bundle.receipt.kind === "verified"
                  ? "verified"
                  : bundle.receipt.kind === "denied"
                    ? "denied"
                    : bundle.receipt.kind === "disconnected" || bundle.receipt.kind === "revoked"
                      ? "disconnected"
                      : "needs_attention",
          providerSubjectId: bundle.receipt.providerSubjectId,
          accountLabel: bundle.receipt.accountLabel,
          grantedScopes: bundle.receipt.grantedScopes,
          issuedAt: bundle.receipt.createdAt.toISOString(),
        }
      : null,
  };
}
