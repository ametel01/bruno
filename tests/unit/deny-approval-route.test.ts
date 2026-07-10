import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000101";

const mocks = vi.hoisted(() => {
  class AgentApprovalPersistenceError extends Error {
    constructor() {
      super("Approval request failed.");
      this.name = "AgentApprovalPersistenceError";
    }
  }

  return {
    AgentApprovalPersistenceError,
    denyApprovalForUser: vi.fn(),
    requireConfiguredApplicationUser: vi.fn(),
  };
});

vi.mock("@/src/server/approvals/agent-approvals", () => ({
  AgentApprovalPersistenceError: mocks.AgentApprovalPersistenceError,
  denyApprovalForUser: mocks.denyApprovalForUser,
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireConfiguredApplicationUser,
}));

describe("POST /api/approvals/[approvalId]/deny route", () => {
  beforeEach(() => {
    mocks.requireConfiguredApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
  });

  afterEach(() => {
    mocks.denyApprovalForUser.mockReset();
    mocks.requireConfiguredApplicationUser.mockReset();
  });

  it("returns validation JSON for malformed percent-encoded approval IDs", async () => {
    const { POST } = await import("@/app/api/approvals/[approvalId]/deny/route");

    const response = await POST(new Request("http://localhost/api/approvals/deny"), {
      params: Promise.resolve({ approvalId: "%E0%A4%A" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "validation_failed",
        message: "Approval ID must be a valid UUID.",
      },
    });
    expect(mocks.denyApprovalForUser).not.toHaveBeenCalled();
  });

  it("maps malformed approval ids to stable validation JSON", async () => {
    mocks.denyApprovalForUser.mockResolvedValueOnce({
      ok: false,
      reason: "malformed_approval_id",
    });
    const { POST } = await import("@/app/api/approvals/[approvalId]/deny/route");

    const response = await POST(new Request("http://localhost/api/approvals/deny"), {
      params: Promise.resolve({ approvalId: "not-a-uuid" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "validation_failed",
        message: "Approval ID must be a valid UUID.",
      },
    });
  });

  it("maps not-found and inaccessible approvals to safe 404 JSON", async () => {
    mocks.denyApprovalForUser.mockResolvedValueOnce({
      ok: false,
      reason: "approval_not_found",
    });
    const { POST } = await import("@/app/api/approvals/[approvalId]/deny/route");

    const response = await POST(new Request("http://localhost/api/approvals/deny"), {
      params: Promise.resolve({ approvalId: "00000000-0000-4000-8000-000000000511" }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: {
        code: "approval_not_found",
        message: "Approval could not be found.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("payload_json");
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });

  it("maps already resolved approvals to reusable safe conflict JSON", async () => {
    mocks.denyApprovalForUser.mockResolvedValueOnce({
      ok: false,
      reason: "approval_already_resolved",
      status: "approved",
    });
    const { POST } = await import("@/app/api/approvals/[approvalId]/deny/route");

    const response = await POST(new Request("http://localhost/api/approvals/deny"), {
      params: Promise.resolve({ approvalId: "00000000-0000-4000-8000-000000000511" }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: {
        code: "approval_already_resolved",
        message: "Approval has already been resolved.",
        status: "approved",
      },
    });
    expect(JSON.stringify(body)).not.toContain("payload_json");
  });

  it("returns success JSON for a denied approval", async () => {
    mocks.denyApprovalForUser.mockResolvedValueOnce({
      ok: true,
      approval: {
        id: "00000000-0000-4000-8000-000000000511",
        agentId: "00000000-0000-4000-8000-000000000201",
        status: "denied",
        resolvedBy: "00000000-0000-4000-8000-000000000101",
        resolvedAt: "2026-07-04T08:45:00.000Z",
      },
      event: {
        type: "approval.denied",
      },
    });
    const { POST } = await import("@/app/api/approvals/[approvalId]/deny/route");

    const response = await POST(new Request("http://localhost/api/approvals/deny"), {
      params: Promise.resolve({ approvalId: "00000000-0000-4000-8000-000000000511" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      approval: {
        status: "denied",
      },
      event: {
        type: "approval.denied",
      },
    });
    expect(JSON.stringify(body)).not.toContain("resolvedBy");
    expect(mocks.denyApprovalForUser).toHaveBeenCalledWith(
      USER_ID,
      "00000000-0000-4000-8000-000000000511",
    );
  });

  it("returns a safe persistence error response", async () => {
    mocks.denyApprovalForUser.mockRejectedValueOnce(new mocks.AgentApprovalPersistenceError());
    const { POST } = await import("@/app/api/approvals/[approvalId]/deny/route");

    const response = await POST(new Request("http://localhost/api/approvals/deny"), {
      params: Promise.resolve({ approvalId: "00000000-0000-4000-8000-000000000511" }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "approval_deny_failed",
        message: "Approval could not be denied.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(JSON.stringify(body)).not.toContain("agent_approvals");
  });
});
