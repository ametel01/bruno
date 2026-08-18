import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/operator/mail-sending/route";

describe("Mail Sending route boundary", () => {
  it("keeps the capability response authenticated and uncached", async () => {
    const response = await GET(
      new Request("http://localhost/api/operator/mail-sending"),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true as const, userId: "user-349" }),
        getConnection: async () => null,
        getOffer: async () => true,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ connection: null, offerAvailable: true });
  });
});
