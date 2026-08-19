import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApplicationUser: vi.fn(),
  getPrivacyCenter: vi.fn(),
  deleteRetainedData: vi.fn(),
  disconnectAi: vi.fn(),
  disconnectAnthropic: vi.fn(),
  disconnectCalendar: vi.fn(),
  disconnectMail: vi.fn(),
  disconnectMailSending: vi.fn(),
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireApplicationUser,
}));
vi.mock("@/src/server/operators/founder-privacy-center", () => ({
  getFounderPrivacyCenterForUser: mocks.getPrivacyCenter,
  deleteFounderRetainedDataForUser: mocks.deleteRetainedData,
}));
vi.mock("@/src/server/operators/founder-ai-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/server/operators/founder-ai-connection")>()),
  disconnectFounderOpenAiForUser: mocks.disconnectAi,
  disconnectFounderAnthropicForUser: mocks.disconnectAnthropic,
}));
vi.mock("@/src/server/operators/founder-calendar-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/server/operators/founder-calendar-connection")>()),
  disconnectFounderGoogleCalendarForUser: mocks.disconnectCalendar,
}));
vi.mock("@/src/server/operators/founder-mail-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/server/operators/founder-mail-connection")>()),
  disconnectFounderGoogleMailForUser: mocks.disconnectMail,
}));
vi.mock("@/src/server/operators/founder-mail-sending-connection", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/src/server/operators/founder-mail-sending-connection")
  >()),
  disconnectFounderGoogleMailSendingForUser: mocks.disconnectMailSending,
}));

const USER_ID = "00000000-0000-4000-8000-000000003354";

describe("Founder Privacy Center route", () => {
  beforeEach(() => {
    mocks.requireApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
    mocks.getPrivacyCenter.mockResolvedValue({
      ownerId: USER_ID,
      aiRoute: {
        provider: "openai",
        accountLabel: "founder@example.com",
        purpose: "bounded",
        policyVersion: 1,
        posture: "selected evidence",
        knownRetention: "provider policy",
        limitations: [],
      },
      connections: [],
      retainedData: [],
      restrictedCategories: [],
      deletionBoundary: "local only",
    });
    mocks.deleteRetainedData.mockResolvedValue({
      deleted: {
        conversationMessages: 2,
        conversationWorks: 1,
        conversations: 1,
        relationshipEvidence: 3,
      },
      retained: [],
    });
    mocks.disconnectAi.mockResolvedValue({ status: "disconnected" });
    mocks.disconnectAnthropic.mockResolvedValue({ status: "disconnected" });
    mocks.disconnectCalendar.mockResolvedValue({ status: "disconnected" });
    mocks.disconnectMail.mockResolvedValue({ status: "disconnected" });
    mocks.disconnectMailSending.mockResolvedValue({ status: "disconnected" });
  });

  afterEach(() => vi.clearAllMocks());

  it("returns owner-isolated privacy data without secrets", async () => {
    const { GET } = await import("@/app/api/operator/privacy/route");
    const response = await GET(new Request("http://localhost/api/operator/privacy"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.privacy.ownerId).toBe(USER_ID);
    expect(JSON.stringify(body)).not.toMatch(/token|secret|ciphertext|api.?key/i);
  });

  it("requires recent authentication before deleting retained data", async () => {
    const { POST } = await import("@/app/api/operator/privacy/route");
    const request = () =>
      new Request("http://localhost/api/operator/privacy", {
        method: "POST",
        body: JSON.stringify({ action: "delete_retained_data" }),
      });
    const denied = await POST(request(), undefined, { requireRecentAuth: async () => false });
    expect(denied.status).toBe(401);
    expect(mocks.deleteRetainedData).not.toHaveBeenCalled();
    const allowed = await POST(request(), undefined, { requireRecentAuth: async () => true });
    expect(allowed.status).toBe(200);
    expect(mocks.deleteRetainedData).toHaveBeenCalledWith(USER_ID);
  });

  it("keeps disconnect separate from retained-data deletion", async () => {
    const { POST } = await import("@/app/api/operator/privacy/route");
    const response = await POST(
      new Request("http://localhost/api/operator/privacy", {
        method: "POST",
        body: JSON.stringify({
          action: "disconnect",
          kind: "mail_sending",
          provider: "google_gmail_sending",
        }),
      }),
      undefined,
      { requireRecentAuth: async () => true },
    );
    expect(response.status).toBe(200);
    expect(mocks.disconnectMailSending).toHaveBeenCalledWith(USER_ID);
    expect(mocks.deleteRetainedData).not.toHaveBeenCalled();
  });
});
