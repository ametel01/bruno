import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestGoogleConnectedAcceptanceRelease } from "@/scripts/founder-google-test-release";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorCalendarConnections,
  operatorMailConnections,
  operatorMailResources,
  operatorPreparations,
  operatorPrimaryCommunicationsSuites,
  operatorRuntimes,
  operators,
  users,
} from "@/src/server/db/schema";
import {
  completeFounderGoogleMailAuthorizationForState,
  createGoogleMailAdapter,
  denyFounderGoogleMailAuthorizationForState,
  disconnectFounderGoogleMailForUser,
  type FounderGoogleMailAdapter,
  getFounderGoogleMailConnectionForUser,
  getFounderGoogleMailOfferDispositionForUser,
  REQUIRED_MAIL_SCOPE,
  selectFounderGoogleMailResourcesForUser,
  setFounderGoogleMailOfferDispositionForUser,
  startFounderGoogleMailAuthorizationForUser,
  verifyFounderGoogleMailForUser,
} from "@/src/server/operators/founder-mail-connection";
import {
  confirmFounderTimezoneForUser,
  ensureFounderOperatorForUser,
} from "@/src/server/operators/founder-operator";
import {
  encryptOperatorSecret,
  type OperatorSecretKeyring,
} from "@/src/server/secrets/operator-secret-keyring";

const OWNER_ID = "00000000-0000-4000-8000-000000003430";
const NOW = new Date("2026-08-19T01:00:00.000Z");
const KEYRING: OperatorSecretKeyring = {
  activeVersion: "test-v1",
  keys: new Map([["test-v1", Buffer.alloc(32, 7)]]),
};
const GOOGLE_RELEASE_REVISION = "d".repeat(40);
const ENV = {
  BRUNO_GOOGLE_MAIL_READING_CONNECTED_ACCEPTANCE_RELEASE: buildTestGoogleConnectedAcceptanceRelease(
    "gmail_reading",
    NOW,
    GOOGLE_RELEASE_REVISION,
  ),
  VERCEL_GIT_COMMIT_SHA: GOOGLE_RELEASE_REVISION,
};

describe("Founder Google Gmail reading application seam", () => {
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
    await insertReadyCalendar(connection, operator.id, "google-sub-123");
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("keeps Gmail hidden and unavailable until the release controls qualify it", async () => {
    await expect(
      startFounderGoogleMailAuthorizationForUser(OWNER_ID, {
        createConnection: () => connection,
        adapter: mailAdapter(),
        env: {},
        keyring: KEYRING,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "mail_reading_not_released", status: 409 });
    await expect(
      getFounderGoogleMailConnectionForUser(OWNER_ID, {
        createConnection: () => connection,
        env: {},
      }),
    ).resolves.toBeNull();
  });

  it("preserves saved state, denial cleanup, and disconnect after reading qualification expires", async () => {
    const adapter = mailAdapter();
    const started = await startFounderGoogleMailAuthorizationForUser(
      OWNER_ID,
      dependencies(adapter),
    );
    const deniedState = new URL(started.authorization?.authorizationUrl ?? "").searchParams.get(
      "state",
    );
    await expect(
      denyFounderGoogleMailAuthorizationForState(deniedState ?? "", {
        createConnection: () => connection,
        env: {},
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ status: "needs_attention" });

    await connect(adapter);
    await expect(
      getFounderGoogleMailConnectionForUser(OWNER_ID, {
        createConnection: () => connection,
        env: {},
      }),
    ).resolves.toMatchObject({ status: "selecting", accountLabel: "founder@example.com" });
    await expect(
      disconnectFounderGoogleMailForUser(OWNER_ID, {
        createConnection: () => connection,
        adapter,
        env: {},
        keyring: KEYRING,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ status: "disconnected" });
  });

  it("persists a contextual offer decision on the Founder operator", async () => {
    await expect(
      getFounderGoogleMailOfferDispositionForUser(OWNER_ID, dependenciesForOffer()),
    ).resolves.toBeNull();
    await expect(
      setFounderGoogleMailOfferDispositionForUser(OWNER_ID, "dismissed", dependenciesForOffer()),
    ).resolves.toBe("dismissed");
    await expect(
      getFounderGoogleMailOfferDispositionForUser(OWNER_ID, dependenciesForOffer()),
    ).resolves.toBe("dismissed");
  });

  it("rechecks Gmail capability while holding the Founder lifecycle lock", async () => {
    const competingConnection = createDatabaseConnection();
    let checkedInsideLock = false;
    try {
      await expect(
        startFounderGoogleMailAuthorizationForUser(OWNER_ID, {
          ...dependencies(mailAdapter()),
          getOwnerPreviewAccess: async () => {
            const rows = await competingConnection.db.execute<{ acquired: boolean }>(
              sql`select pg_try_advisory_xact_lock(hashtextextended(${`bruno:founder-lifecycle:${OWNER_ID}`}, 0)) as acquired`,
            );
            expect(rows[0]?.acquired).toBe(false);
            checkedInsideLock = true;
            return { admitted: true, availableCapabilities: ["gmail_reading"] };
          },
        }),
      ).resolves.toMatchObject({ connection: { status: "authorizing" } });
      expect(checkedInsideLock).toBe(true);
    } finally {
      await competingConnection.close();
    }
  });

  it("uses a separate read-only grant, keeps labels unselected, and accepts empty live evidence", async () => {
    const adapter = mailAdapter({ attentionCount: 0 });
    const connected = await connect(adapter);

    expect(connected).toMatchObject({
      provider: "google_gmail",
      status: "selecting",
      accountLabel: "founder@example.com",
      suite: { status: "matched", grouped: false },
      receipt: {
        outcome: "connected",
        grantedScopes: [
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/gmail.readonly",
        ],
      },
    });
    expect(connected.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerResourceId: "INBOX", selected: false }),
        expect.objectContaining({ providerResourceId: "STARRED", selected: false }),
        expect.objectContaining({ providerResourceId: "Client leads", selected: false }),
      ]),
    );
    expect(adapter.requestedScopes).toEqual([
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
    expect(JSON.stringify(connected)).not.toMatch(/gmail\.modify|gmail\.send|mail\.google\.com/i);

    await selectFounderGoogleMailResourcesForUser(OWNER_ID, ["INBOX"], dependencies(adapter));
    const verified = await verifyFounderGoogleMailForUser(OWNER_ID, dependencies(adapter));

    expect(verified).toMatchObject({
      status: "ready",
      evidenceState: "current",
      workState: "available",
      suite: { status: "matched", grouped: true },
      receipt: { outcome: "verified", selectedResourceCount: 1, evidenceState: "current" },
    });
    const [mail] = await connection.db.select().from(operatorMailConnections);
    const [suite] = await connection.db.select().from(operatorPrimaryCommunicationsSuites);
    const [calendar] = await connection.db.select().from(operatorCalendarConnections);
    expect(mail?.lastEvidenceCount).toBe(0);
    expect(suite?.status).toBe("active");
    expect(calendar?.status).toBe("ready");
    expect(calendar?.evidenceState).toBe("current");
  });

  it("requires the immutable Calendar subject before grouping and never degrades Calendar", async () => {
    const adapter = mailAdapter({ attentionCount: 2 });
    await connect(adapter);
    await selectFounderGoogleMailResourcesForUser(OWNER_ID, ["INBOX"], dependencies(adapter));
    await connection.db.delete(operatorPrimaryCommunicationsSuites);
    await connection.db.delete(operatorCalendarConnections);
    const [operator] = await connection.db.select().from(operators);
    if (!operator) throw new Error("Test operator was not created.");
    await insertReadyCalendar(connection, operator.id, "different-google-subject");
    const mismatch = await verifyFounderGoogleMailForUser(OWNER_ID, dependencies(adapter));
    expect(mismatch).toMatchObject({
      status: "ready",
      suite: { status: "mismatch", grouped: false },
    });
    const [calendar] = await connection.db.select().from(operatorCalendarConnections);
    expect(calendar?.status).toBe("ready");
    expect(calendar?.evidenceState).toBe("current");
    expect(await connection.db.select().from(operatorPrimaryCommunicationsSuites)).toHaveLength(0);
  });

  it("keeps new labels off across same-identity reauthorization and isolates stale, denial, and disconnect paths", async () => {
    const adapter = mailAdapter({ attentionCount: 1 });
    await connect(adapter);
    await selectFounderGoogleMailResourcesForUser(OWNER_ID, ["INBOX"], dependencies(adapter));
    await verifyFounderGoogleMailForUser(OWNER_ID, dependencies(adapter));

    adapter.resources = [...adapter.resources, resource("PROJECTS", "Projects", "user")];
    await disconnectFounderGoogleMailForUser(OWNER_ID, dependencies(adapter));
    const reconnected = await connect(adapter);
    expect(reconnected.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerResourceId: "INBOX", selected: true }),
        expect.objectContaining({ providerResourceId: "PROJECTS", selected: false }),
      ]),
    );

    adapter.evidenceState = "unavailable";
    await selectFounderGoogleMailResourcesForUser(OWNER_ID, ["INBOX"], dependencies(adapter));
    const stale = await verifyFounderGoogleMailForUser(OWNER_ID, dependencies(adapter));
    expect(stale.status).toBe("needs_attention");
    const staleCalendar = await connection.db.select().from(operatorCalendarConnections);
    expect(staleCalendar[0]?.status).toBe("ready");

    const started = await startFounderGoogleMailAuthorizationForUser(
      OWNER_ID,
      dependencies(adapter),
    );
    const state = new URL(started.authorization?.authorizationUrl ?? "").searchParams.get("state");
    const denied = await denyFounderGoogleMailAuthorizationForState(
      state ?? "",
      dependencies(adapter),
    );
    expect(denied?.recoveryMessage).toContain("Calendar Connection is unchanged");
    const disconnected = await disconnectFounderGoogleMailForUser(OWNER_ID, dependencies(adapter));
    expect(disconnected?.status).toBe("disconnected");
    const [calendar] = await connection.db.select().from(operatorCalendarConnections);
    expect(calendar?.status).toBe("ready");
  });

  it("rejects broader Gmail grants before storing a usable connection", async () => {
    const adapter = mailAdapter({
      grantedScopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
    });
    const result = await connect(adapter);
    expect(result.status).toBe("needs_attention");
    expect(result.recoveryMessage).toContain("broader Gmail access");
    expect(await connection.db.select().from(operatorMailResources)).toHaveLength(0);
  });

  it("builds authorization from the separate Gmail project with only released read scope", async () => {
    const adapter = createGoogleMailAdapter({
      env: {
        BRUNO_GOOGLE_MAIL_CLIENT_ID: "mail-client",
        BRUNO_GOOGLE_MAIL_CLIENT_SECRET: "mail-secret",
        BRUNO_GOOGLE_MAIL_REDIRECT_URI: "https://bruno.example/api/operator/mail/oauth/callback",
      },
    });
    const authorization = await adapter.createAuthorizationUrl({
      state: "mail-state",
      reconnecting: false,
    });
    const url = new URL(authorization.authorizationUrl);
    const scopes = url.searchParams.get("scope")?.split(" ") ?? [];

    expect(url.searchParams.get("client_id")).toBe("mail-client");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://bruno.example/api/operator/mail/oauth/callback",
    );
    expect(scopes).toEqual(
      expect.arrayContaining(["openid", "email", "profile", REQUIRED_MAIL_SCOPE]),
    );
    expect(scopes).not.toEqual(
      expect.arrayContaining([
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.send",
        "https://mail.google.com/",
      ]),
    );
    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
  });

  async function connect(adapter: MailAdapter) {
    const started = await startFounderGoogleMailAuthorizationForUser(
      OWNER_ID,
      dependencies(adapter),
    );
    const state = new URL(started.authorization?.authorizationUrl ?? "").searchParams.get("state");
    return completeFounderGoogleMailAuthorizationForState(
      state ?? "",
      "google-code",
      dependencies(adapter),
    );
  }

  function dependencies(adapter: MailAdapter) {
    return {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      now: () => NOW,
      env: ENV,
      getOwnerPreviewAccess: async () => ({
        admitted: true as const,
        availableCapabilities: ["gmail_reading" as const],
      }),
    };
  }

  function dependenciesForOffer() {
    return {
      createConnection: () => connection,
      now: () => NOW,
      env: ENV,
    };
  }
});

type MailAdapter = FounderGoogleMailAdapter & {
  resources: MailResource[];
  requestedScopes: string[];
  attentionCount: number;
  evidenceState: "current" | "unavailable";
};

type MailResource = {
  providerResourceId: string;
  name: string;
  labelType: "system" | "user";
  messageListVisibility: string | null;
  labelListVisibility: string | null;
};

function resource(
  providerResourceId: string,
  name: string,
  labelType: "system" | "user",
): MailResource {
  return {
    providerResourceId,
    name,
    labelType,
    messageListVisibility: "show",
    labelListVisibility: "labelShow",
  };
}

function mailAdapter(
  input: {
    attentionCount?: number;
    evidenceState?: "current" | "unavailable";
    grantedScopes?: string[];
  } = {},
): MailAdapter {
  const adapter = {
    resources: [
      resource("INBOX", "Inbox", "system"),
      resource("STARRED", "Starred", "system"),
      resource("Client leads", "Client leads", "user"),
    ],
    requestedScopes: [],
    attentionCount: input.attentionCount ?? 1,
    evidenceState: input.evidenceState ?? "current",
    createAuthorizationUrl: async ({ state }: { state: string; reconnecting: boolean }) => ({
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(state)}`,
      expiresAt: new Date("2026-08-19T01:15:00.000Z"),
    }),
    exchangeAuthorizationCode: async () => {
      adapter.requestedScopes = input.grantedScopes ?? [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.readonly",
      ];
      return {
        accessToken: "mail-access-token",
        refreshToken: "mail-refresh-token",
        tokenExpiresAt: new Date("2026-08-19T02:00:00.000Z"),
        grantedScopes: adapter.requestedScopes,
      };
    },
    getIdentity: async () => ({
      providerSubjectId: "google-sub-123",
      accountLabel: "founder@example.com",
    }),
    listResources: async () => adapter.resources,
    verifySelectedResources: async () => ({
      providerSubjectId: "google-sub-123",
      accountLabel: "founder@example.com",
      evidenceState: adapter.evidenceState,
      attentionCount: adapter.attentionCount,
      accessToken: "mail-access-token",
      refreshToken: "mail-refresh-token",
      tokenExpiresAt: new Date("2026-08-19T02:00:00.000Z"),
    }),
    revokeAuthorization: async () => ({ providerRevoked: true }),
  } as MailAdapter;
  return adapter;
}

async function insertReadyCalendar(
  connection: DatabaseConnection,
  operatorId: string,
  providerSubjectId: string,
): Promise<void> {
  const access = encryptOperatorSecret({
    value: "calendar-access",
    scope: "google-calendar-access",
    keyring: KEYRING,
  });
  const refresh = encryptOperatorSecret({
    value: "calendar-refresh",
    scope: "google-calendar-refresh",
    keyring: KEYRING,
  });
  await connection.db.insert(operatorCalendarConnections).values({
    operatorId,
    providerSubjectId,
    accountLabel: "founder@example.com",
    status: "ready",
    authorizationState: "authorized",
    accessTokenCiphertext: access.ciphertext,
    accessTokenIv: access.iv,
    accessTokenAuthTag: access.authTag,
    refreshTokenCiphertext: refresh.ciphertext,
    refreshTokenIv: refresh.iv,
    refreshTokenAuthTag: refresh.authTag,
    secretKeyVersion: KEYRING.activeVersion,
    grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    authorizedAt: NOW,
    lastVerifiedAt: NOW,
    lastEvidenceAt: NOW,
    evidenceState: "current",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table operator_primary_communications_suites, operator_mail_connection_receipts, operator_mail_resources, operator_mail_connections, operator_calendar_connection_receipts, operator_calendar_resources, operator_calendar_connections, operator_runtimes, operator_preparations, operators, users restart identity cascade",
  );
}
