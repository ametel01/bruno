import { describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/operator/mail-sending/route";

describe("Mail Sending route boundary", () => {
  it("keeps the capability response authenticated and uncached", async () => {
    const response = await GET(
      new Request("http://localhost/api/operator/mail-sending"),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true as const, userId: "user-349" }),
        getConnection: async () => null,
        getOffer: async () => true,
        isMailSendingReleased: () => true,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ connection: null, offerAvailable: true });
  });

  it("fails closed before reading connection state when release evidence is absent", async () => {
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

  it("blocks authorization before invoking Google while preserving disconnect", async () => {
    const startAuthorization = vi.fn();
    const disconnectConnection = vi.fn(async () => null);
    const dependencies = {
      requireApplicationUser: async () => ({ ok: true as const, userId: "user-349" }),
      startAuthorization,
      disconnectConnection,
      isMailSendingReleased: () => false,
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
});
