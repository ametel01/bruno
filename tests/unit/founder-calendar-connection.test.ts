import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeFounderGoogleCalendarAuthorizationForState,
  disconnectFounderGoogleCalendarForUser,
  selectFounderGoogleCalendarResourcesForUser,
  startFounderGoogleCalendarAuthorizationForUser,
  verifyFounderGoogleCalendarForUser,
  type FounderGoogleCalendarAdapter,
} from "@/src/server/operators/founder-calendar-connection";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorCalendarConnectionReceipts,
  operatorCalendarConnections,
  operatorPreparations,
  operatorRuntimes,
  users,
} from "@/src/server/db/schema";
import {
  confirmFounderTimezoneForUser,
  ensureFounderOperatorForUser,
} from "@/src/server/operators/founder-operator";
import type { OperatorSecretKeyring } from "@/src/server/secrets/operator-secret-keyring";

const OWNER_ID = "00000000-0000-4000-8000-000000003410";
const NOW = new Date("2026-08-19T01:00:00.000Z");
const KEYRING: OperatorSecretKeyring = {
  activeVersion: "test-v1",
  keys: new Map([["test-v1", Buffer.alloc(32, 7)]]),
};
const CURRENT_CALENDAR_ACCESS = async () => ({
  admitted: true as const,
  availableCapabilities: ["calendar_reading" as const],
});

describe("Founder Google Calendar connection application seam", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await connection.db.insert(users).values({ id: OWNER_ID });
    await ensureFounderOperatorForUser(OWNER_ID, {
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
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("records the Google grant and identity while leaving every discovered calendar unselected", async () => {
    const adapter = calendarAdapter();
    const started = await startFounderGoogleCalendarAuthorizationForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      now: () => NOW,
    });
    const state = new URL(started.authorization?.authorizationUrl ?? "").searchParams.get("state");
    expect(state).toBeTruthy();

    const result = await completeFounderGoogleCalendarAuthorizationForState(
      state ?? "",
      "google-code",
      {
        createConnection: () => connection,
        adapter,
        keyring: KEYRING,
        now: () => NOW,
        getOwnerPreviewAccess: CURRENT_CALENDAR_ACCESS,
      },
    );

    expect(result).toMatchObject({
      provider: "google_calendar",
      status: "selecting",
      accountLabel: "founder@example.com",
      evidenceState: "unknown",
      receipt: { outcome: "connected" },
    });
    expect(result.resources).toEqual([
      expect.objectContaining({ providerResourceId: "primary", selected: false }),
      expect.objectContaining({ providerResourceId: "team", selected: false }),
    ]);
    const [row] = await connection.db.select().from(operatorCalendarConnections);
    expect(row?.providerSubjectId).toBe("google-sub-123");
    expect(row?.accessTokenCiphertext).not.toBe("access-token");
    expect(row?.refreshTokenCiphertext).not.toBe("refresh-token");
    expect(await connection.db.select().from(operatorCalendarConnectionReceipts)).toHaveLength(1);
  });

  it("does not exchange a previously issued authorization code after Calendar enters Hold", async () => {
    const adapter = calendarAdapter();
    const exchangeAuthorizationCode = vi.fn(adapter.exchangeAuthorizationCode);
    adapter.exchangeAuthorizationCode = exchangeAuthorizationCode;
    const started = await startFounderGoogleCalendarAuthorizationForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      now: () => NOW,
      getOwnerPreviewAccess: CURRENT_CALENDAR_ACCESS,
    });
    const state = new URL(started.authorization?.authorizationUrl ?? "").searchParams.get("state");

    const result = await completeFounderGoogleCalendarAuthorizationForState(
      state ?? "",
      "google-code",
      {
        createConnection: () => connection,
        adapter,
        keyring: KEYRING,
        now: () => NOW,
        getOwnerPreviewAccess: async () => ({ admitted: true, availableCapabilities: [] }),
      },
    );

    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "needs_attention",
      evidenceState: "unavailable",
      recoveryMessage: "Google Calendar authorization paused under the current Release Decision.",
    });
  });

  it("requires explicit resource selection and accepts a live calendar with zero events as current", async () => {
    const adapter = calendarAdapter();
    const connected = await connect(adapter);
    await expect(
      verifyFounderGoogleCalendarForUser(OWNER_ID, {
        createConnection: () => connection,
        adapter,
        keyring: KEYRING,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ status: "needs_attention", evidenceState: "unknown" });

    await selectFounderGoogleCalendarResourcesForUser(OWNER_ID, ["primary"], {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      now: () => NOW,
      getOwnerPreviewAccess: CURRENT_CALENDAR_ACCESS,
    });
    const result = await verifyFounderGoogleCalendarForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      now: () => NOW,
    });

    expect(result).toMatchObject({
      status: "ready",
      evidenceState: "current",
      workState: "available",
      receipt: {
        outcome: "verified",
        selectedResourceCount: 1,
        evidenceState: "current",
      },
    });
    expect(
      connected.resources.find((resource) => resource.providerResourceId === "team")?.selected,
    ).toBe(false);
  });

  it("preserves reviewed selection for the same Google identity while leaving new calendars unselected", async () => {
    const adapter = calendarAdapter();
    await connect(adapter);
    await selectFounderGoogleCalendarResourcesForUser(OWNER_ID, ["primary"], {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      now: () => NOW,
    });
    await disconnectFounderGoogleCalendarForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      now: () => NOW,
    });
    adapter.calendars = [
      ...adapter.calendars,
      {
        providerResourceId: "new-calendar",
        summary: "New Calendar",
        timeZone: "UTC",
        accessRole: "reader",
        primaryCalendar: false,
      },
    ];
    const reconnected = await reconnect(adapter);

    expect(reconnected.receipt?.outcome).toBe("reconnected");
    expect(reconnected.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerResourceId: "primary", selected: true }),
        expect.objectContaining({ providerResourceId: "new-calendar", selected: false }),
      ]),
    );
  });

  it("disconnects locally even when remote revocation cannot be confirmed", async () => {
    const adapter = calendarAdapter({ providerRevoked: false });
    await connect(adapter);
    const result = await disconnectFounderGoogleCalendarForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      now: () => NOW,
    });

    expect(result).toMatchObject({
      status: "disconnected",
      workState: "paused",
      recoveryMessage: expect.stringContaining("could not be confirmed"),
      receipt: { outcome: "disconnected" },
    });
    const [row] = await connection.db.select().from(operatorCalendarConnections);
    expect(row?.accessTokenCiphertext).toBeNull();
    expect(row?.refreshTokenCiphertext).toBeNull();
    expect(row?.revokedAt).toBeNull();
  });

  it("retains encrypted revocation authority only for a coordinated retry", async () => {
    const adapter = calendarAdapter({ providerRevoked: false });
    await connect(adapter);
    await disconnectFounderGoogleCalendarForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      now: () => NOW,
      preserveCredentialsOnUnconfirmedRevocation: true,
    });
    const [unconfirmed] = await connection.db.select().from(operatorCalendarConnections);
    expect(unconfirmed).toEqual(
      expect.objectContaining({
        status: "disconnected",
        authorizationState: "revocation_unconfirmed",
        accessTokenCiphertext: expect.any(String),
        refreshTokenCiphertext: expect.any(String),
      }),
    );

    adapter.providerRevoked = true;
    await disconnectFounderGoogleCalendarForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      now: () => new Date(NOW.valueOf() + 60_000),
      preserveCredentialsOnUnconfirmedRevocation: true,
    });
    const [confirmed] = await connection.db.select().from(operatorCalendarConnections);
    expect(confirmed).toEqual(
      expect.objectContaining({
        authorizationState: "revoked",
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
      }),
    );
  });

  async function connect(adapter: CalendarAdapter): Promise<CalendarDto> {
    const started = await startFounderGoogleCalendarAuthorizationForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      now: () => NOW,
    });
    const state = new URL(started.authorization?.authorizationUrl ?? "").searchParams.get("state");
    return completeFounderGoogleCalendarAuthorizationForState(state ?? "", "google-code", {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      now: () => NOW,
      getOwnerPreviewAccess: CURRENT_CALENDAR_ACCESS,
    });
  }

  async function reconnect(adapter: CalendarAdapter): Promise<CalendarDto> {
    const started = await startFounderGoogleCalendarAuthorizationForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      now: () => NOW,
    });
    const state = new URL(started.authorization?.authorizationUrl ?? "").searchParams.get("state");
    return completeFounderGoogleCalendarAuthorizationForState(state ?? "", "google-code-2", {
      createConnection: () => connection,
      adapter,
      keyring: KEYRING,
      now: () => NOW,
      getOwnerPreviewAccess: CURRENT_CALENDAR_ACCESS,
    });
  }
});

type CalendarAdapter = FounderGoogleCalendarAdapter & {
  calendars: CalendarResource[];
  providerRevoked: boolean;
};
type CalendarResource = {
  providerResourceId: string;
  summary: string;
  timeZone: string | null;
  accessRole: string | null;
  primaryCalendar: boolean;
};
type CalendarDto = Awaited<ReturnType<typeof completeFounderGoogleCalendarAuthorizationForState>>;

function calendarAdapter(input: { providerRevoked?: boolean } = {}): CalendarAdapter {
  let adapter: CalendarAdapter;
  adapter = {
    providerRevoked: input.providerRevoked ?? true,
    calendars: [
      {
        providerResourceId: "primary",
        summary: "Primary",
        timeZone: "Asia/Manila",
        accessRole: "owner",
        primaryCalendar: true,
      },
      {
        providerResourceId: "team",
        summary: "Team",
        timeZone: "UTC",
        accessRole: "reader",
        primaryCalendar: false,
      },
    ],
    createAuthorizationUrl: async ({ state }: { state: string; reconnecting: boolean }) => ({
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(state)}`,
      expiresAt: new Date("2026-08-19T01:15:00.000Z"),
    }),
    exchangeAuthorizationCode: async () => ({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenExpiresAt: new Date("2026-08-19T02:00:00.000Z"),
      grantedScopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/calendar.readonly",
      ],
    }),
    getIdentity: async () => ({
      providerSubjectId: "google-sub-123",
      accountLabel: "founder@example.com",
    }),
    listCalendars: async () => adapter.calendars,
    verifySelectedResources: async () => ({
      providerSubjectId: "google-sub-123",
      accountLabel: "founder@example.com",
      evidenceState: "current" as const,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenExpiresAt: new Date("2026-08-19T02:00:00.000Z"),
    }),
    revokeAuthorization: async () => ({ providerRevoked: adapter.providerRevoked }),
  } as CalendarAdapter;
  return adapter;
}

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table operator_calendar_connection_receipts, operator_calendar_resources, operator_calendar_connections, operator_runtimes, operator_preparations, operators, users restart identity cascade",
  );
}
