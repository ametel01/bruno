import { describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/operator/mail-sending/route";

describe("Mail Sending route boundary", () => {
  it("keeps Gmail sending hidden during Owner Preview", async () => {
    const response = await GET(
      new Request("http://localhost/api/operator/mail-sending"),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true as const, userId: "user-349" }),
        getConnection: async () => null,
        getOffer: async () => true,
        isMailSendingReleased: () => true,
        hasGeneralReleaseSetupAccess: async () => false,
      },
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "owner_preview_capability_unavailable" },
    });
  });

  it("fails closed before reading connection state when provider evidence is absent", async () => {
    const getConnection = vi.fn(async () => null);
    const getOffer = vi.fn(async () => true);
    const response = await GET(
      new Request("http://localhost/api/operator/mail-sending"),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true as const, userId: "user-349" }),
        getConnection,
        getOffer,
        isMailSendingReleased: () => false,
        hasGeneralReleaseSetupAccess: async () => true,
      },
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "mail_sending_not_released" },
    });
    expect(getConnection).not.toHaveBeenCalled();
    expect(getOffer).not.toHaveBeenCalled();
  });

  it("serves the optional connection only to exact-bound qualified General Release setup", async () => {
    const connection = { status: "ready" } as never;
    const response = await GET(
      new Request("http://localhost/api/operator/mail-sending"),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true as const, userId: "user-349" }),
        getConnection: async () => connection,
        getOffer: async () => true,
        isMailSendingReleased: () => true,
        hasGeneralReleaseSetupAccess: async () => true,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ connection, offerAvailable: true });
  });

  it("blocks authorization during a capability Hold while preserving disconnect", async () => {
    const startAuthorization = vi.fn();
    const disconnectConnection = vi.fn(async () => null);
    const dependencies = {
      requireApplicationUser: async () => ({ ok: true as const, userId: "user-349" }),
      startAuthorization,
      disconnectConnection,
      isMailSendingReleased: () => true,
      hasGeneralReleaseSetupAccess: async () => false,
    };
    const blocked = await POST(
      new Request("http://localhost/api/operator/mail-sending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      }),
      undefined,
      dependencies,
    );
    const disconnected = await POST(
      new Request("http://localhost/api/operator/mail-sending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disconnect" }),
      }),
      undefined,
      dependencies,
    );

    expect(blocked.status).toBe(409);
    expect(startAuthorization).not.toHaveBeenCalled();
    expect(disconnected.status).toBe(200);
    expect(disconnectConnection).toHaveBeenCalledWith("user-349");
  });

  it("starts and verifies only after the exact Gmail Sending authority check", async () => {
    const startAuthorization = vi.fn(async () => ({ connection: null, authorization: null }));
    const verifyConnection = vi.fn(async () => null);
    const dependencies = {
      requireApplicationUser: async () => ({ ok: true as const, userId: "user-349" }),
      startAuthorization,
      verifyConnection,
      isMailSendingReleased: () => true,
      hasGeneralReleaseSetupAccess: async () => true,
    };
    const start = await POST(
      new Request("http://localhost/api/operator/mail-sending", {
        method: "POST",
        body: JSON.stringify({ action: "start" }),
      }),
      undefined,
      dependencies,
    );
    const verify = await POST(
      new Request("http://localhost/api/operator/mail-sending", {
        method: "POST",
        body: JSON.stringify({ action: "verify" }),
      }),
      undefined,
      dependencies,
    );

    expect(start.status).toBe(200);
    expect(verify.status).toBe(200);
    expect(startAuthorization).toHaveBeenCalledWith("user-349");
    expect(verifyConnection).toHaveBeenCalledWith("user-349");
  });
});
