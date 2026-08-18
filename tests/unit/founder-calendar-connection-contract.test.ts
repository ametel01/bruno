import { describe, expect, it } from "vitest";
import { createGoogleCalendarAdapter } from "@/src/server/operators/founder-calendar-connection";

describe("Google Calendar provider contract", () => {
  it("uses a dedicated Google OAuth client, read-only Calendar scope, and offline grant", async () => {
    const adapter = createGoogleCalendarAdapter({
      env: {
        BRUNO_GOOGLE_CALENDAR_CLIENT_ID: "calendar-client-id",
        BRUNO_GOOGLE_CALENDAR_CLIENT_SECRET: "calendar-client-secret",
        BRUNO_GOOGLE_CALENDAR_REDIRECT_URI:
          "https://bruno.example/api/operator/calendar/oauth/callback",
      },
      request: async () => new Response(JSON.stringify({}), { status: 200 }),
    });

    const result = await adapter.createAuthorizationUrl({
      state: "opaque-state",
      reconnecting: false,
    });
    const url = new URL(result.authorizationUrl);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("calendar-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://bruno.example/api/operator/calendar/oauth/callback",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(url.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/calendar.readonly",
    );
  });

  it("lists Calendar resources and treats a successful empty event window as current", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const adapter = createGoogleCalendarAdapter({
      env: {
        BRUNO_GOOGLE_CALENDAR_CLIENT_ID: "calendar-client-id",
        BRUNO_GOOGLE_CALENDAR_CLIENT_SECRET: "calendar-client-secret",
        BRUNO_GOOGLE_CALENDAR_REDIRECT_URI:
          "https://bruno.example/api/operator/calendar/oauth/callback",
      },
      request: async (input, init) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? "GET" });
        if (url.includes("userinfo")) {
          return new Response(
            JSON.stringify({ sub: "google-sub-123", email: "founder@example.com" }),
            { status: 200 },
          );
        }
        if (url.includes("calendarList")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "primary",
                  summary: "Primary",
                  primary: true,
                  accessRole: "owner",
                  timeZone: "Asia/Manila",
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      },
    });

    await expect(adapter.listCalendars({ accessToken: "access-token" })).resolves.toEqual([
      expect.objectContaining({ providerResourceId: "primary", summary: "Primary" }),
    ]);
    await expect(
      adapter.verifySelectedResources({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        resources: [
          {
            providerResourceId: "primary",
            summary: "Primary",
            timeZone: "Asia/Manila",
            accessRole: "owner",
            primaryCalendar: true,
          },
        ],
        timeMin: new Date("2026-08-18T00:00:00.000Z"),
        timeMax: new Date("2026-08-26T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ evidenceState: "current", providerSubjectId: "google-sub-123" });
    expect(requests.some(({ url }) => url.includes("timeMin") && url.includes("timeMax"))).toBe(
      true,
    );
  });
});
