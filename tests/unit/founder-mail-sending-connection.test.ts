import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestGoogleMailSendingAcceptanceRelease } from "@/scripts/founder-google-mail-sending-test-release";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorCalendarConnections,
  operatorMailConnections,
  operatorMailSendingConnections,
  operatorPreparations,
  operatorPrimaryCommunicationsSuites,
  operatorRuntimes,
  users,
} from "@/src/server/db/schema";
import {
  completeFounderGoogleMailSendingAuthorizationForState,
  createGoogleMailSendingAdapter,
  denyFounderGoogleMailSendingAuthorizationForState,
  disconnectFounderGoogleMailSendingForUser,
  type FounderGoogleMailSendingAdapter,
  getFounderGoogleMailSendingConnectionForUser,
  getFounderGoogleMailSendingOfferForUser,
  REQUIRED_MAIL_SENDING_SCOPE,
  startFounderGoogleMailSendingAuthorizationForUser,
} from "@/src/server/operators/founder-mail-sending-connection";
import {
  confirmFounderTimezoneForUser,
  ensureFounderOperatorForUser,
} from "@/src/server/operators/founder-operator";
import {
  encryptOperatorSecret,
  type OperatorSecretKeyring,
} from "@/src/server/secrets/operator-secret-keyring";

const OWNER_ID = "00000000-0000-4000-8000-000000003490";
const NOW = new Date("2026-08-19T01:00:00.000Z");
const REVISION = "a".repeat(40);
const KEYRING: OperatorSecretKeyring = {
  activeVersion: "test-v1",
  keys: new Map([["test-v1", Buffer.alloc(32, 9)]]),
};
const ENV = {
  BRUNO_GOOGLE_MAIL_SENDING_CONNECTED_ACCEPTANCE_RELEASE:
    buildTestGoogleMailSendingAcceptanceRelease(NOW, REVISION),
  VERCEL_GIT_COMMIT_SHA: REVISION,
};

describe("Founder Google Mail Sending connection", () => {
  let connection: DatabaseConnection;
  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await connection.db.insert(users).values({ id: OWNER_ID });
    const operator = await ensureFounderOperatorForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    await confirmFounderTimezoneForUser(OWNER_ID, "Asia/Manila", {
      createConnection: () => connection,
      now: () => NOW,
    });
    await connection.db.update(operatorPreparations).set({ status: "ready", completedAt: NOW });
    await connection.db
      .update(operatorRuntimes)
      .set({ status: "ready", transportState: "connected", safetyState: "verified", readyAt: NOW });
    const calendarAccess = encryptOperatorSecret({
      value: "calendar-access",
      scope: "google-calendar-access",
      keyring: KEYRING,
    });
    const calendarRefresh = encryptOperatorSecret({
      value: "calendar-refresh",
      scope: "google-calendar-refresh",
      keyring: KEYRING,
    });
    const calendar = await connection.db
      .insert(operatorCalendarConnections)
      .values({
        operatorId: operator.id,
        providerSubjectId: "google-sub-349",
        accountLabel: "founder@example.com",
        status: "ready",
        authorizationState: "authorized",
        accessTokenCiphertext: calendarAccess.ciphertext,
        accessTokenIv: calendarAccess.iv,
        accessTokenAuthTag: calendarAccess.authTag,
        refreshTokenCiphertext: calendarRefresh.ciphertext,
        refreshTokenIv: calendarRefresh.iv,
        refreshTokenAuthTag: calendarRefresh.authTag,
        secretKeyVersion: KEYRING.activeVersion,
        grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
        authorizedAt: NOW,
        lastVerifiedAt: NOW,
        lastEvidenceAt: NOW,
        evidenceState: "current",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();
    const mailAccess = encryptOperatorSecret({
      value: "mail-access",
      scope: "google-mail-access",
      keyring: KEYRING,
    });
    const mailRefresh = encryptOperatorSecret({
      value: "mail-refresh",
      scope: "google-mail-refresh",
      keyring: KEYRING,
    });
    const mail = await connection.db
      .insert(operatorMailConnections)
      .values({
        operatorId: operator.id,
        providerSubjectId: "google-sub-349",
        accountLabel: "founder@example.com",
        status: "ready",
        authorizationState: "authorized",
        accessTokenCiphertext: mailAccess.ciphertext,
        accessTokenIv: mailAccess.iv,
        accessTokenAuthTag: mailAccess.authTag,
        refreshTokenCiphertext: mailRefresh.ciphertext,
        refreshTokenIv: mailRefresh.iv,
        refreshTokenAuthTag: mailRefresh.authTag,
        secretKeyVersion: KEYRING.activeVersion,
        grantedScopes: [
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/gmail.readonly",
        ],
        authorizedAt: NOW,
        lastVerifiedAt: NOW,
        lastEvidenceAt: NOW,
        evidenceState: "current",
        suiteStatus: "matched",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();
    await connection.db.insert(operatorPrimaryCommunicationsSuites).values({
      operatorId: operator.id,
      calendarConnectionId: calendar[0]!.id,
      mailConnectionId: mail[0]!.id,
      providerSubjectId: "google-sub-349",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("requests a separate send-only project and rejects broad or read scopes", async () => {
    const adapter = sendingAdapter();
    const result = await startFounderGoogleMailSendingAuthorizationForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      env: ENV,
      now: () => NOW,
      randomBytes: () => Buffer.alloc(32, 4),
    });
    const url = new URL(result.authorization!.authorizationUrl);
    expect(
      await getFounderGoogleMailSendingConnectionForUser(OWNER_ID, {
        createConnection: () => connection,
        env: ENV,
      }),
    ).toMatchObject({ status: "authorizing" });
    expect(url.searchParams.get("client_id")).toBe("sending-client");
    expect(adapter.requestedScopes).toEqual([
      "openid",
      "email",
      "profile",
      REQUIRED_MAIL_SENDING_SCOPE,
    ]);
    expect(adapter.requestedScopes).not.toContain("https://www.googleapis.com/auth/gmail.readonly");
    adapter.grantedScopes = [
      ...adapter.requestedScopes,
      "https://www.googleapis.com/auth/gmail.modify",
    ];
    const failed = await completeFounderGoogleMailSendingAuthorizationForState(
      url.searchParams.get("state")!,
      "code",
      { createConnection: () => connection, adapter, keyring: KEYRING, env: ENV, now: () => NOW },
    );
    expect(failed.status).toBe("needs_attention");
    expect(failed.recoveryMessage).toMatch(/broader Gmail access/i);
    expect(
      (await connection.db.select().from(operatorMailSendingConnections))[0]?.accessTokenCiphertext,
    ).toBeNull();
  });

  it("persists denial without changing the reading connection", async () => {
    const adapter = sendingAdapter();
    const result = await startFounderGoogleMailSendingAuthorizationForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      env: ENV,
      now: () => NOW,
      randomBytes: () => Buffer.alloc(32, 7),
    });
    const denied = await denyFounderGoogleMailSendingAuthorizationForState(
      new URL(result.authorization!.authorizationUrl).searchParams.get("state")!,
      { createConnection: () => connection, env: ENV, now: () => NOW },
    );
    expect(denied).toMatchObject({
      status: "needs_attention",
      recoveryMessage: expect.stringMatching(/unchanged/i),
    });
    expect((await connection.db.select().from(operatorMailConnections))[0]?.status).toBe("ready");
  });

  it("uses the dedicated production OAuth configuration and exact send-only scope", async () => {
    const adapter = createGoogleMailSendingAdapter({
      env: {
        BRUNO_GOOGLE_MAIL_SENDING_CLIENT_ID: "production-sending-client",
        BRUNO_GOOGLE_MAIL_SENDING_CLIENT_SECRET: "production-sending-secret",
        BRUNO_GOOGLE_MAIL_SENDING_REDIRECT_URI:
          "https://bruno.example.test/api/operator/mail-sending/oauth/callback",
      },
    });
    const result = await adapter.createAuthorizationUrl({ state: "state", reconnecting: false });
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get("client_id")).toBe("production-sending-client");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "email",
      "profile",
      REQUIRED_MAIL_SENDING_SCOPE,
    ]);
    expect(url.searchParams.get("scope")).not.toMatch(
      /gmail\.readonly|gmail\.modify|mail\.google\.com/,
    );
  });

  it("requires same immutable identity and disconnects without changing reading or Calendar", async () => {
    const adapter = sendingAdapter();
    const first = await startFounderGoogleMailSendingAuthorizationForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      env: ENV,
      now: () => NOW,
      randomBytes: () => Buffer.alloc(32, 5),
    });
    adapter.subject = "different-subject";
    const mismatch = await completeFounderGoogleMailSendingAuthorizationForState(
      new URL(first.authorization!.authorizationUrl).searchParams.get("state")!,
      "code",
      { createConnection: () => connection, adapter, keyring: KEYRING, env: ENV, now: () => NOW },
    );
    expect(mismatch.status).toBe("needs_attention");
    adapter.subject = "google-sub-349";
    const second = await startFounderGoogleMailSendingAuthorizationForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      env: ENV,
      now: () => NOW,
      randomBytes: () => Buffer.alloc(32, 6),
    });
    const ready = await completeFounderGoogleMailSendingAuthorizationForState(
      new URL(second.authorization!.authorizationUrl).searchParams.get("state")!,
      "code",
      { createConnection: () => connection, adapter, keyring: KEYRING, env: ENV, now: () => NOW },
    );
    expect(ready.status).toBe("ready");
    expect(
      await getFounderGoogleMailSendingOfferForUser(OWNER_ID, {
        createConnection: () => connection,
        env: ENV,
      }),
    ).toBe(true);
    const disconnected = await disconnectFounderGoogleMailSendingForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      env: ENV,
      now: () => NOW,
    });
    expect(disconnected?.status).toBe("disconnected");
    expect(adapter.revoked).toBe(1);
    expect((await connection.db.select().from(operatorMailConnections))[0]?.status).toBe("ready");
    expect(
      (await connection.db.select().from(operatorPrimaryCommunicationsSuites))[0]?.status,
    ).toBe("active");
    expect((await connection.db.select().from(operatorCalendarConnections))[0]?.status).toBe(
      "ready",
    );
  });
});

function sendingAdapter(): FounderGoogleMailSendingAdapter & {
  requestedScopes: string[];
  grantedScopes: string[];
  subject: string;
  revoked: number;
} {
  const adapter = {
    requestedScopes: [] as string[],
    grantedScopes: ["openid", "email", "profile", REQUIRED_MAIL_SENDING_SCOPE],
    subject: "google-sub-349",
    revoked: 0,
    async createAuthorizationUrl({ state }: { state: string }) {
      this.requestedScopes = ["openid", "email", "profile", REQUIRED_MAIL_SENDING_SCOPE];
      return {
        authorizationUrl: `https://accounts.google.test/authorize?client_id=sending-client&state=${state}`,
        expiresAt: new Date("2026-08-19T02:00:00.000Z"),
      };
    },
    async exchangeAuthorizationCode() {
      return {
        accessToken: "sending-access",
        refreshToken: "sending-refresh",
        tokenExpiresAt: new Date("2026-08-19T03:00:00.000Z"),
        grantedScopes: this.grantedScopes,
      };
    },
    async getIdentity() {
      return { providerSubjectId: this.subject, accountLabel: "founder@example.com" };
    },
    async revokeAuthorization() {
      this.revoked += 1;
      return { providerRevoked: true };
    },
  };
  return adapter;
}

async function reset(connection: DatabaseConnection) {
  await connection.client.unsafe(
    "truncate table operator_mail_sending_connection_receipts, operator_mail_sending_connections, operator_primary_communications_suites, operator_mail_connection_receipts, operator_mail_resources, operator_mail_connections, operator_calendar_connection_receipts, operator_calendar_resources, operator_calendar_connections, operator_runtimes, operator_preparations, operators, users restart identity cascade",
  );
}
