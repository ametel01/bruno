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
    approvePendingApprovalForUser: vi.fn(),
    requireOperationalApplicationUser: vi.fn(),
  };
});

vi.mock("@/src/server/approvals/agent-approvals", () => ({
  AgentApprovalPersistenceError: mocks.AgentApprovalPersistenceError,
  approvePendingApprovalForUser: mocks.approvePendingApprovalForUser,
}));

vi.mock("@/src/server/users/operational-application-user", () => ({
  requireOperationalApplicationUser: mocks.requireOperationalApplicationUser,
}));

describe("POST /api/approvals/[approvalId]/approve route", () => {
  beforeEach(() => {
    mocks.requireOperationalApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
  });

  afterEach(() => {
    mocks.approvePendingApprovalForUser.mockReset();
    mocks.requireOperationalApplicationUser.mockReset();
  });

  it("returns validation JSON for malformed percent-encoded approval IDs", async () => {
    const { POST } = await import("@/app/api/approvals/[approvalId]/approve/route");

    const response = await POST(new Request("http://localhost/api/approvals/approve"), {
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
    expect(mocks.approvePendingApprovalForUser).not.toHaveBeenCalled();
  });

  it("returns validation JSON for invalid approval IDs", async () => {
    mocks.approvePendingApprovalForUser.mockResolvedValueOnce({
      ok: false,
      reason: "malformed_approval_id",
    });
    const { POST } = await import("@/app/api/approvals/[approvalId]/approve/route");

    const response = await POST(new Request("http://localhost/api/approvals/not-a-uuid/approve"), {
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

  it("returns safe not-found JSON for missing or inaccessible approvals", async () => {
    mocks.approvePendingApprovalForUser.mockResolvedValueOnce({
      ok: false,
      reason: "approval_not_found",
    });
    const { POST } = await import("@/app/api/approvals/[approvalId]/approve/route");

    const response = await POST(new Request("http://localhost/api/approvals/missing/approve"), {
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
  });

  it("returns the shared safe conflict shape for already resolved approvals", async () => {
    mocks.approvePendingApprovalForUser.mockResolvedValueOnce({
      ok: false,
      reason: "approval_already_resolved",
      status: "approved",
    });
    const { POST } = await import("@/app/api/approvals/[approvalId]/approve/route");

    const response = await POST(new Request("http://localhost/api/approvals/resolved/approve"), {
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
  });

  it("returns a safe persistence error response", async () => {
    mocks.approvePendingApprovalForUser.mockRejectedValueOnce(
      new mocks.AgentApprovalPersistenceError(),
    );
    const { POST } = await import("@/app/api/approvals/[approvalId]/approve/route");

    const response = await POST(new Request("http://localhost/api/approvals/failing/approve"), {
      params: Promise.resolve({ approvalId: "00000000-0000-4000-8000-000000000511" }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "approval_approve_failed",
        message: "Approval could not be approved.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(JSON.stringify(body)).not.toContain("payload_json");
  });

  it("returns safe approval and event JSON after approval succeeds", async () => {
    mocks.approvePendingApprovalForUser.mockResolvedValueOnce({
      ok: true,
      approval: {
        id: "00000000-0000-4000-8000-000000000511",
        agentId: "00000000-0000-4000-8000-000000000201",
        agentName: "Approval Agent",
        title: "Review outbound message",
        status: "approved",
        resolvedBy: USER_ID,
        resolvedAt: "2026-07-04T10:00:00.000Z",
      },
      event: {
        type: "approval.approved",
      },
    });
    const { POST } = await import("@/app/api/approvals/[approvalId]/approve/route");

    const response = await POST(new Request("http://localhost/api/approvals/pending/approve"), {
      params: Promise.resolve({ approvalId: "00000000-0000-4000-8000-000000000511" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      approval: {
        id: "00000000-0000-4000-8000-000000000511",
        agentId: "00000000-0000-4000-8000-000000000201",
        agentName: "Approval Agent",
        title: "Review outbound message",
        status: "approved",
        resolvedAt: "2026-07-04T10:00:00.000Z",
      },
      event: {
        type: "approval.approved",
      },
    });
    expect(JSON.stringify(body)).not.toContain("payload_json");
    expect(JSON.stringify(body)).not.toContain("resolvedBy");
    expect(mocks.approvePendingApprovalForUser).toHaveBeenCalledWith(
      USER_ID,
      "00000000-0000-4000-8000-000000000511",
    );
  });
});
