import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApplicationUser: vi.fn(),
  getActions: vi.fn(),
  createAction: vi.fn(),
  decideAction: vi.fn(),
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireApplicationUser,
}));

vi.mock("@/src/server/operators/founder-proposed-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/server/operators/founder-proposed-actions")>()),
  getFounderProposedActionsForUser: mocks.getActions,
  createFounderProposedActionForUser: mocks.createAction,
  decideFounderProposedActionForUser: mocks.decideAction,
}));

const USER_ID = "00000000-0000-4000-8000-000000003471";
const ACTION_ID = "00000000-0000-4000-8000-000000003476";
const ACTION = {
  id: ACTION_ID,
  version: 1,
  state: "awaiting_approval",
  actionFamily: "external_communication",
};

describe("Founder Proposed Action routes", () => {
  beforeEach(() => {
    mocks.requireApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
    mocks.getActions.mockResolvedValue([ACTION]);
    mocks.createAction.mockResolvedValue(ACTION);
    mocks.decideAction.mockResolvedValue({
      action: { ...ACTION, state: "authorized" },
      decision: { kind: "approve" },
      duplicate: false,
    });
  });

  afterEach(() => vi.clearAllMocks());

  it("projects owner-scoped actions without caching", async () => {
    const { GET } = await import("@/app/api/operator/proposed-actions/route");
    const response = await GET(new Request("http://localhost/api/operator/proposed-actions"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ actions: [ACTION] });
    expect(mocks.getActions).toHaveBeenCalledWith(USER_ID);
  });

  it("creates a structured proposal with the exact material envelope", async () => {
    const { POST } = await import("@/app/api/operator/proposed-actions/route");
    const response = await POST(
      new Request("http://localhost/api/operator/proposed-actions", {
        method: "POST",
        body: JSON.stringify({
          action: "create",
          actionFamily: "external_communication",
          businessOutcome: "Send one follow-up",
          destination: { recipient: "ada@example.com" },
          materialContent: { body: "Hello Ada" },
          validUntil: "2026-08-20T04:00:00.000Z",
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(mocks.createAction).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        actionFamily: "external_communication",
        destination: { recipient: "ada@example.com" },
        materialContent: { body: "Hello Ada" },
      }),
    );
  });

  it("records a decision against one exact version", async () => {
    const { POST } = await import("@/app/api/operator/proposed-actions/[actionId]/decision/route");
    const response = await POST(
      new Request(`http://localhost/api/operator/proposed-actions/${ACTION_ID}/decision`, {
        method: "POST",
        body: JSON.stringify({ kind: "approve", expectedVersion: 1 }),
      }),
      { params: Promise.resolve({ actionId: ACTION_ID }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.decideAction).toHaveBeenCalledWith(USER_ID, ACTION_ID, "approve", 1, null);
  });

  it("does not provide a generic approve or send action", async () => {
    const { POST } = await import("@/app/api/operator/proposed-actions/route");
    const response = await POST(
      new Request("http://localhost/api/operator/proposed-actions", {
        method: "POST",
        body: JSON.stringify({ action: "approve", id: ACTION_ID }),
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.createAction).not.toHaveBeenCalled();
  });
});
