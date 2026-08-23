import { describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/operator/mail/oauth/callback/route";

describe("Gmail reading OAuth callback boundary", () => {
  it("completes a released General Release Gmail-reading grant", async () => {
    const completeAuthorization = vi.fn(async () => ({ status: "selecting" }) as never);
    const response = await GET(
      new Request("http://localhost/api/operator/mail/oauth/callback?state=s&code=c"),
      undefined,
      { isMailReadingReleased: () => true, completeAuthorization },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost/operator?mail=connected#mail");
    expect(completeAuthorization).toHaveBeenCalledWith("s", "c");
  });

  it("records provider denial without attempting code exchange", async () => {
    const denyAuthorization = vi.fn(async () => null);
    const completeAuthorization = vi.fn();
    const response = await GET(
      new Request("http://localhost/api/operator/mail/oauth/callback?state=s&error=access_denied"),
      undefined,
      { denyAuthorization, completeAuthorization },
    );

    expect(response.headers.get("location")).toContain("mail=authorization_denied");
    expect(denyAuthorization).toHaveBeenCalledWith("s");
    expect(completeAuthorization).not.toHaveBeenCalled();
  });
});
