import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApplicationUser: vi.fn(),
  getConversation: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireApplicationUser,
}));

vi.mock("@/src/server/operators/founder-conversation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/src/server/operators/founder-conversation")>();
  return {
    ...actual,
    getFounderConversationForUser: mocks.getConversation,
    sendFounderConversationMessageForUser: mocks.sendMessage,
  };
});

const USER_ID = "00000000-0000-4000-8000-000000003401";
const CONVERSATION = {
  id: "00000000-0000-4000-8000-000000003402",
  status: "active",
  messages: [
    {
      id: "00000000-0000-4000-8000-000000003403",
      sequence: 1,
      role: "founder",
      status: "complete",
      body: "What needs my attention?",
      createdAt: "2026-08-18T02:00:00.000Z",
    },
  ],
  activeWork: null,
  createdAt: "2026-08-18T02:00:00.000Z",
  updatedAt: "2026-08-18T02:00:00.000Z",
};

describe("Founder Conversation route", () => {
  beforeEach(() => {
    mocks.requireApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
    mocks.getConversation.mockResolvedValue(CONVERSATION);
    mocks.sendMessage.mockResolvedValue(CONVERSATION);
  });

  afterEach(() => vi.clearAllMocks());

  it("returns the canonical conversation with no-store caching", async () => {
    const { GET } = await import("@/app/api/operator/conversation/route");
    const response = await GET(new Request("http://localhost/api/operator/conversation"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ conversation: CONVERSATION });
    expect(mocks.getConversation).toHaveBeenCalledWith(USER_ID);
  });

  it("passes the Founder message and idempotency key to the application seam", async () => {
    const { POST } = await import("@/app/api/operator/conversation/route");
    const response = await POST(
      new Request("http://localhost/api/operator/conversation", {
        method: "POST",
        body: JSON.stringify({ message: "  What needs my attention?  ", requestId: "request-1" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.sendMessage).toHaveBeenCalledWith(USER_ID, "What needs my attention?", {
      requestId: "request-1",
    });
  });

  it.each([
    [
      "invalid JSON",
      new Request("http://localhost/api/operator/conversation", { method: "POST", body: "{" }),
    ],
    [
      "missing message",
      new Request("http://localhost/api/operator/conversation", { method: "POST", body: "{}" }),
    ],
  ])("rejects %s without invoking the application seam", async (_name, request) => {
    const { POST } = await import("@/app/api/operator/conversation/route");
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});
