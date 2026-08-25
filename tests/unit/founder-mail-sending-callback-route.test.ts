import { describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/operator/mail-sending/oauth/callback/route";

describe("Mail Sending OAuth callback boundary", () => {
  it("completes the send-only grant for an exact-bound qualified General Release setup", async () => {
    const completeAuthorization = vi.fn(async () => ({ status: "ready" }) as never);
    const response = await GET(
      new Request("http://localhost/api/operator/mail-sending/oauth/callback?state=s&code=c"),
      undefined,
      {
        resolveAuthorizationUser: async () => "user-387",
        hasGeneralReleaseSetupAccess: async () => true,
        isMailSendingReleased: () => true,
        completeAuthorization,
      },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost/operator?mail_sending=connected#mail-sending",
    );
    expect(completeAuthorization).toHaveBeenCalledWith("s", "c");
  });

  it("denies a held or unbound setup before exchanging the provider code", async () => {
    const completeAuthorization = vi.fn();
    const response = await GET(
      new Request("http://localhost/api/operator/mail-sending/oauth/callback?state=s&code=c"),
      undefined,
      {
        resolveAuthorizationUser: async () => "user-387",
        hasGeneralReleaseSetupAccess: async () => false,
        isMailSendingReleased: () => true,
        completeAuthorization,
      },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain(
      "mail_sending=owner_preview_capability_unavailable",
    );
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("records a provider denial without requiring live release authority", async () => {
    const denyAuthorization = vi.fn(async () => null);
    const response = await GET(
      new Request(
        "http://localhost/api/operator/mail-sending/oauth/callback?state=s&error=access_denied",
      ),
      undefined,
      { denyAuthorization },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("mail_sending=authorization_denied");
    expect(denyAuthorization).toHaveBeenCalledWith("s");
  });
});
