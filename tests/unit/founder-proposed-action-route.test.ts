import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FounderReleaseStageAccessError } from "@/src/server/founder-product-contract/release-stage-access";

const mocks = vi.hoisted(() => ({
  requireApplicationUser: vi.fn(),
  getActions: vi.fn(),
  createAction: vi.fn(),
  decideAction: vi.fn(),
  executeAction: vi.fn(),
  reconcileAction: vi.fn(),
  requireWorkspaceAccess: vi.fn(),
  accessErrorResponse: vi.fn(),
}));

vi.mock("@/app/api/operator/_shared/owner-preview-access", () => ({
  requireFounderOperatorWorkspaceAccess: mocks.requireWorkspaceAccess,
  founderOperatorAccessErrorResponse: mocks.accessErrorResponse,
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
    mocks.requireWorkspaceAccess.mockResolvedValue(null);
    mocks.accessErrorResponse.mockImplementation((error) =>
      error instanceof FounderReleaseStageAccessError
        ? Response.json({ error: { code: error.code } }, { status: error.status })
        : null,
    );
    mocks.getActions.mockResolvedValue([ACTION]);
    mocks.createAction.mockResolvedValue(ACTION);
    mocks.decideAction.mockResolvedValue({
      action: { ...ACTION, state: "authorized" },
      decision: { kind: "approve" },
      duplicate: false,
    });
    mocks.executeAction.mockResolvedValue({
      status: "succeeded",
      duplicate: false,
      receipt: { id: "receipt-351" },
    });
    mocks.reconcileAction.mockResolvedValue({
      status: "succeeded",
      duplicate: false,
      receipt: { id: "receipt-352" },
    });
  });

  afterEach(() => vi.clearAllMocks());

  it("projects owner-scoped actions without caching", async () => {
    const { GET } = await import("@/app/api/operator/proposed-actions/route");
    const response = await GET(new Request("http://localhost/api/operator/proposed-actions"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ actions: [ACTION] });
    expect(mocks.requireWorkspaceAccess).toHaveBeenCalledWith(USER_ID, "workspace", {
      allowGeneralReleaseSetup: true,
    });
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
    expect(mocks.requireWorkspaceAccess).toHaveBeenCalledWith(USER_ID, "ai_provider", {
      allowGeneralReleaseSetup: true,
    });
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

  it("returns a sanitized denial when Request changes loses current protection", async () => {
    mocks.decideAction.mockRejectedValueOnce(new FounderReleaseStageAccessError());
    const { POST } = await import("@/app/api/operator/proposed-actions/[actionId]/decision/route");
    const response = await POST(
      new Request(`http://localhost/api/operator/proposed-actions/${ACTION_ID}/decision`, {
        method: "POST",
        body: JSON.stringify({
          kind: "request_changes",
          expectedVersion: 1,
          changes: {
            actionFamily: "external_communication",
            businessOutcome: "Revise one follow-up",
            destination: { recipient: "ada@example.com" },
            materialContent: { body: "Hello Ada" },
            validUntil: "2026-08-20T04:00:00.000Z",
          },
        }),
      }),
      { params: Promise.resolve({ actionId: ACTION_ID }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "owner_preview_access_required" },
    });
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

  it("executes only the exact approved version through the dedicated route", async () => {
    const { POST } = await import("@/app/api/operator/proposed-actions/[actionId]/execute/route");
    const response = await POST(
      new Request(`http://localhost/api/operator/proposed-actions/${ACTION_ID}/execute`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: 1 }),
      }),
      { params: Promise.resolve({ actionId: ACTION_ID }) },
      { executeAction: mocks.executeAction },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.executeAction).toHaveBeenCalledWith(USER_ID, ACTION_ID, 1);
  });

  it("rejects a non-integer execution version before reaching the executor", async () => {
    const { POST } = await import("@/app/api/operator/proposed-actions/[actionId]/execute/route");
    const response = await POST(
      new Request(`http://localhost/api/operator/proposed-actions/${ACTION_ID}/execute`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: 1.5 }),
      }),
      { params: Promise.resolve({ actionId: ACTION_ID }) },
      { executeAction: mocks.executeAction },
    );
    expect(response.status).toBe(400);
    expect(mocks.executeAction).not.toHaveBeenCalled();
  });

  it("reconciles an uncertain action through General Release setup access", async () => {
    mocks.requireWorkspaceAccess.mockImplementation(async (_userId, requirement) =>
      requirement === "core_operation" ||
      (Array.isArray(requirement) &&
        (requirement.includes("calendar_reading") || requirement.includes("gmail_reading")))
        ? Response.json({ error: { code: "owner_preview_access_required" } }, { status: 403 })
        : null,
    );
    const { POST } = await import("@/app/api/operator/proposed-actions/[actionId]/reconcile/route");
    const response = await POST(
      new Request(`http://localhost/api/operator/proposed-actions/${ACTION_ID}/reconcile`, {
        method: "POST",
      }),
      { params: Promise.resolve({ actionId: ACTION_ID }) },
      { reconcileAction: mocks.reconcileAction },
    );

    expect(response.status).toBe(200);
    expect(mocks.requireWorkspaceAccess).toHaveBeenCalledWith(USER_ID, ["gmail_sending"], {
      allowGeneralReleaseSetup: true,
    });
    expect(mocks.reconcileAction).toHaveBeenCalledWith(USER_ID, ACTION_ID);
  });
});
