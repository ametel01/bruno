import { describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/operator/mail/route";

const USER_ID = "00000000-0000-4000-8000-000000003430";
const CONNECTION = {
  provider: "google_gmail" as const,
  status: "selecting" as const,
  accountLabel: "founder@example.com",
  connectedAt: "2026-08-19T01:00:00.000Z",
  lastVerifiedAt: null,
  evidenceState: "unknown" as const,
  workState: "paused" as const,
  recoveryMessage: null,
  suite: {
    status: "matched" as const,
    grouped: false,
    name: "Primary Communications Suite" as const,
  },
  release: {
    qualified: true as const,
    requiredScope: "https://www.googleapis.com/auth/gmail.readonly" as const,
    disclosure: "bounded",
    retentionDays: 90,
    deletion: "staged",
    aiLimitedUse: "bounded",
  },
  resources: [
    {
      providerResourceId: "INBOX",
      name: "Inbox",
      labelType: "system" as const,
      messageListVisibility: "show",
      labelListVisibility: "labelShow",
      selected: false,
      status: "available" as const,
    },
  ],
  receipt: null,
};

describe("Founder Gmail reading route", () => {
  it("keeps Gmail reading hidden during Owner Preview", async () => {
    const response = await GET(new Request("http://localhost/api/operator/mail"), undefined, {
      requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
      getConnection: async () => CONNECTION,
      getOfferDisposition: async () => null,
      isMailReadingReleased: () => true,
    });
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      error: { code: "owner_preview_capability_unavailable" },
    });
  });

  it("blocks setup actions while preserving safe disconnect", async () => {
    const start = vi.fn(async () => ({
      connection: { ...CONNECTION, status: "authorizing" as const },
      authorization: {
        authorizationUrl: "https://accounts.google.com/?state=opaque",
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
    const setOffer = vi.fn(async () => "enabled" as const);
    const dependencies = {
      requireApplicationUser: async () => ({ ok: true as const, userId: USER_ID }),
      startAuthorization: start,
      selectResources: select,
      verifyConnection: verify,
      disconnectConnection: disconnect,
      setOfferDisposition: setOffer,
      isMailReadingReleased: () => true,
    };
    const base = "http://localhost/api/operator/mail";
    await POST(
      new Request(base, { method: "POST", body: JSON.stringify({ action: "start" }) }),
      undefined,
      dependencies,
    );
    await POST(
      new Request(base, {
        method: "POST",
        body: JSON.stringify({ action: "select", resourceIds: ["INBOX"] }),
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
    await POST(
      new Request(base, {
        method: "POST",
        body: JSON.stringify({ action: "offer", disposition: "enabled" }),
      }),
      undefined,
      dependencies,
    );
    expect(start).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledWith(USER_ID);
    expect(setOffer).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated and malformed selection requests", async () => {
    const unauthenticated = await GET(
      new Request("http://localhost/api/operator/mail"),
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
      new Request("http://localhost/api/operator/mail", {
        method: "POST",
        body: JSON.stringify({ action: "select", resourceIds: [] }),
      }),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true as const, userId: USER_ID }),
        isMailReadingReleased: () => true,
      },
    );
    expect(malformed.status).toBe(409);
    expect(await malformed.json()).toMatchObject({
      error: { code: "owner_preview_capability_unavailable" },
    });
  });

  it("fails closed before exposing or starting unqualified Gmail reading", async () => {
    const getConnection = vi.fn(async () => CONNECTION);
    const startAuthorization = vi.fn();
    const dependencies = {
      requireApplicationUser: async () => ({ ok: true as const, userId: USER_ID }),
      getConnection,
      getOfferDisposition: vi.fn(async () => null),
      startAuthorization,
      isMailReadingReleased: () => false,
      hasGeneralReleaseSetupAccess: async () => true,
    };

    const getResponse = await GET(
      new Request("http://localhost/api/operator/mail"),
      undefined,
      dependencies,
    );
    const startResponse = await POST(
      new Request("http://localhost/api/operator/mail", {
        method: "POST",
        body: JSON.stringify({ action: "start" }),
      }),
      undefined,
      dependencies,
    );

    expect(getResponse.status).toBe(409);
    expect(startResponse.status).toBe(409);
    expect(await startResponse.json()).toMatchObject({
      error: { code: "provider_not_released" },
    });
    expect(getConnection).not.toHaveBeenCalled();
    expect(startAuthorization).not.toHaveBeenCalled();
  });

  it("exposes released Gmail reading during public General Release setup", async () => {
    const getConnection = vi.fn(async () => CONNECTION);
    const response = await GET(new Request("http://localhost/api/operator/mail"), undefined, {
      requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
      getConnection,
      getOfferDisposition: async () => "enabled" as const,
      isMailReadingReleased: () => true,
      hasGeneralReleaseSetupAccess: async () => true,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ connection: CONNECTION });
    expect(getConnection).toHaveBeenCalledWith(USER_ID);
  });
});
