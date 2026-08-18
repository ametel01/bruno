import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApplicationUser: vi.fn(),
  getPreview: vi.fn(),
  editPreview: vi.fn(),
  dismissMailOffer: vi.fn(),
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireApplicationUser,
}));

vi.mock("@/src/server/operators/founder-action-previews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/server/operators/founder-action-previews")>()),
  getFounderActionPreviewForUser: mocks.getPreview,
  editFounderActionPreviewForUser: mocks.editPreview,
  dismissFounderMailSendingOfferForUser: mocks.dismissMailOffer,
}));

const USER_ID = "00000000-0000-4000-8000-000000003461";
const PREVIEW = {
  id: "00000000-0000-4000-8000-000000003463",
  current: {
    id: "00000000-0000-4000-8000-000000003464",
    revision: 1,
    state: "draft",
    recipient: { name: "Recipient", address: "recipient@example.com" },
    content: "Draft",
    supportingEvidence: [{ label: "Calendar", detail: "Call" }],
    expectedExternalEffect: "Nothing is sent.",
    createdAt: "2026-08-19T02:00:00.000Z",
  },
  history: [],
  authority: "none",
  executable: false,
  mailSendingOffer: "available",
  createdAt: "2026-08-19T02:00:00.000Z",
  updatedAt: "2026-08-19T02:00:00.000Z",
};

describe("Action Preview route", () => {
  beforeEach(() => {
    mocks.requireApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
    mocks.getPreview.mockResolvedValue(PREVIEW);
    mocks.editPreview.mockResolvedValue(PREVIEW);
    mocks.dismissMailOffer.mockResolvedValue({ ...PREVIEW, mailSendingOffer: "dismissed" });
  });

  afterEach(() => vi.clearAllMocks());

  it("returns the owner-scoped canonical preview without cache", async () => {
    const { GET } = await import("@/app/api/operator/action-preview/route");
    const response = await GET(new Request("http://localhost/api/operator/action-preview"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ preview: PREVIEW });
    expect(mocks.getPreview).toHaveBeenCalledWith(USER_ID);
  });

  it("only supports append-only draft edits and never calls an execution seam", async () => {
    const { POST } = await import("@/app/api/operator/action-preview/route");
    const response = await POST(
      new Request("http://localhost/api/operator/action-preview", {
        method: "POST",
        body: JSON.stringify({
          action: "edit",
          recipient: { name: "Ada", address: "ada@example.com" },
          content: "Hello",
          supportingEvidence: [{ label: "Mail", detail: "Thread" }],
          expectedExternalEffect: "Nothing is sent.",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.editPreview).toHaveBeenCalledWith(USER_ID, {
      recipientName: "Ada",
      recipientAddress: "ada@example.com",
      content: "Hello",
      supportingEvidence: [{ label: "Mail", detail: "Thread" }],
      expectedExternalEffect: "Nothing is sent.",
    });
  });

  it("rejects an Approve action", async () => {
    const { POST } = await import("@/app/api/operator/action-preview/route");
    const response = await POST(
      new Request("http://localhost/api/operator/action-preview", {
        method: "POST",
        body: JSON.stringify({ action: "approve" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.editPreview).not.toHaveBeenCalled();
  });

  it("persists dismissal of the contextual Mail Sending offer", async () => {
    const { POST } = await import("@/app/api/operator/action-preview/route");
    const response = await POST(
      new Request("http://localhost/api/operator/action-preview", {
        method: "POST",
        body: JSON.stringify({ action: "dismiss_mail_offer" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.dismissMailOffer).toHaveBeenCalledWith(USER_ID);
  });
});
