import { describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/operator/calendar/route";

const USER_ID = "00000000-0000-4000-8000-000000003410";
const CONNECTION = {
  provider: "google_calendar" as const,
  status: "selecting" as const,
  accountLabel: "founder@example.com",
  connectedAt: "2026-08-19T01:00:00.000Z",
  lastVerifiedAt: null,
  evidenceState: "unknown" as const,
  workState: "paused" as const,
  recoveryMessage: null,
  resources: [
    {
      providerResourceId: "primary",
      summary: "Primary",
      timeZone: "Asia/Manila",
      accessRole: "owner",
      primaryCalendar: true,
      selected: false,
      status: "available" as const,
    },
  ],
  receipt: null,
};

describe("Founder Google Calendar route", () => {
  it("returns a no-store business summary without tokens or provider credentials", async () => {
    const response = await GET(new Request("http://localhost/api/operator/calendar"), undefined, {
      requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
      getConnection: async () => CONNECTION,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ connection: CONNECTION });
    expect(JSON.stringify(body)).not.toMatch(/token|secret|credential|client.?secret/i);
  });

  it("routes start, selection, verification, and disconnect as explicit founder actions", async () => {
    const start = vi.fn(async () => ({
      connection: { ...CONNECTION, status: "authorizing" as const },
      authorization: {
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=opaque",
        expiresAt: "2026-08-19T01:15:00.000Z",
      },
    }));
    const select = vi.fn(async () => ({ ...CONNECTION, status: "verifying" as const }));
    const verify = vi.fn(async () => ({
      ...CONNECTION,
      status: "ready" as const,
      workState: "available" as const,
    }));
    const disconnect = vi.fn(async () => ({ ...CONNECTION, status: "disconnected" as const }));
    const dependencies = {
      requireApplicationUser: async () => ({ ok: true as const, userId: USER_ID }),
      startAuthorization: start,
      selectResources: select,
      verifyConnection: verify,
      disconnectConnection: disconnect,
    };
    const base = "http://localhost/api/operator/calendar";

    await POST(
      new Request(base, { method: "POST", body: JSON.stringify({ action: "start" }) }),
      undefined,
      dependencies,
    );
    await POST(
      new Request(base, {
        method: "POST",
        body: JSON.stringify({ action: "select", resourceIds: ["primary"] }),
      }),
      undefined,
      dependencies,
    );
    await POST(
      new Request(base, { method: "POST", body: JSON.stringify({ action: "verify" }) }),
      undefined,
      dependencies,
    );
    await POST(
      new Request(base, { method: "POST", body: JSON.stringify({ action: "disconnect" }) }),
      undefined,
      dependencies,
    );

    expect(start).toHaveBeenCalledWith(USER_ID);
    expect(select).toHaveBeenCalledWith(USER_ID, ["primary"]);
    expect(verify).toHaveBeenCalledWith(USER_ID);
    expect(disconnect).toHaveBeenCalledWith(USER_ID);
  });

  it("rejects unauthenticated and malformed resource-selection requests", async () => {
    const unauthenticated = await GET(
      new Request("http://localhost/api/operator/calendar"),
      undefined,
      {
        requireApplicationUser: async () => ({
          ok: false as const,
          status: 401 as const,
          code: "unauthenticated" as const,
        }),
      },
    );
    expect(unauthenticated.status).toBe(401);

    const malformed = await POST(
      new Request("http://localhost/api/operator/calendar", {
        method: "POST",
        body: JSON.stringify({ action: "select", resourceIds: [] }),
      }),
      undefined,
      { requireApplicationUser: async () => ({ ok: true as const, userId: USER_ID }) },
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "validation_failed" } });
  });
});
