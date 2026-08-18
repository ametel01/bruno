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
  it("returns a no-store business summary without credentials", async () => {
    const response = await GET(new Request("http://localhost/api/operator/mail"), undefined, {
      requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
      getConnection: async () => CONNECTION,
      getOfferDisposition: async () => null,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ connection: CONNECTION, offerDisposition: null });
    expect(JSON.stringify(CONNECTION)).not.toMatch(/token|secret|credential|client.?secret/i);
  });

  it("routes start, selection, verification, and disconnect explicitly", async () => {
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
    expect(start).toHaveBeenCalledWith(USER_ID);
    expect(select).toHaveBeenCalledWith(USER_ID, ["INBOX"]);
    expect(verify).toHaveBeenCalledWith(USER_ID);
    expect(disconnect).toHaveBeenCalledWith(USER_ID);
    expect(setOffer).toHaveBeenCalledWith(USER_ID, "enabled");
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
      },
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "validation_failed" } });
  });
});
