import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FounderReleaseStageAccessError } from "@/src/server/founder-product-contract/release-stage-access";

const mocks = vi.hoisted(() => ({
  requireApplicationUser: vi.fn(),
  requireWorkspaceAccess: vi.fn(),
  ingestEvidence: vi.fn(),
  accessErrorResponse: vi.fn(),
}));

vi.mock("@/app/api/operator/_shared/owner-preview-access", () => ({
  requireFounderOperatorWorkspaceAccess: mocks.requireWorkspaceAccess,
  founderOperatorAccessErrorResponse: mocks.accessErrorResponse,
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireApplicationUser,
}));

vi.mock("@/src/server/operators/founder-relationships", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/server/operators/founder-relationships")>()),
  ingestFounderRelationshipEvidenceForUser: mocks.ingestEvidence,
}));

const USER_ID = "00000000-0000-4000-8000-000000003451";
const NOW = "2026-08-19T02:00:00.000Z";

describe("Founder Relationships route", () => {
  beforeEach(() => {
    mocks.requireApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
    mocks.requireWorkspaceAccess.mockResolvedValue(null);
    mocks.ingestEvidence.mockResolvedValue({ records: [], candidates: [], generatedAt: NOW });
    mocks.accessErrorResponse.mockReturnValue(null);
  });

  afterEach(() => vi.clearAllMocks());

  it("forbids retained Mail evidence at the route capability boundary", async () => {
    const blocked = Response.json(
      { error: { code: "owner_preview_access_required" } },
      { status: 403 },
    );
    mocks.requireWorkspaceAccess.mockImplementation(async (_userId, requirement) =>
      Array.isArray(requirement) && requirement.length === 0 ? blocked : null,
    );
    const { POST } = await import("@/app/api/operator/relationships/route");

    const response = await POST(ingestRequest("mail"));

    expect(response.status).toBe(403);
    expect(mocks.requireWorkspaceAccess).toHaveBeenNthCalledWith(1, USER_ID, "workspace");
    expect(mocks.requireWorkspaceAccess).toHaveBeenNthCalledWith(2, USER_ID, []);
    expect(mocks.ingestEvidence).not.toHaveBeenCalled();
  });

  it("requires Calendar capability before Calendar evidence reaches the application seam", async () => {
    const { POST } = await import("@/app/api/operator/relationships/route");

    const response = await POST(ingestRequest("calendar"));

    expect(response.status).toBe(200);
    expect(mocks.requireWorkspaceAccess).toHaveBeenNthCalledWith(2, USER_ID, ["calendar_reading"]);
    expect(mocks.ingestEvidence).toHaveBeenCalledOnce();
  });

  it("returns a sanitized denial when protection expires inside ingestion", async () => {
    const accessError = new FounderReleaseStageAccessError();
    mocks.ingestEvidence.mockRejectedValueOnce(accessError);
    mocks.accessErrorResponse.mockImplementationOnce((error) =>
      error === accessError
        ? Response.json(
            { error: { code: "owner_preview_access_required" } },
            { status: 403, headers: { "Cache-Control": "no-store" } },
          )
        : null,
    );
    const { POST } = await import("@/app/api/operator/relationships/route");

    const response = await POST(ingestRequest("calendar"));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

function ingestRequest(sourceKind: "calendar" | "mail"): Request {
  return new Request("http://localhost/api/operator/relationships", {
    method: "POST",
    body: JSON.stringify({
      action: "ingest_evidence",
      observations: [
        {
          sourceKind,
          connectionId: "connection-1",
          provider: sourceKind === "calendar" ? "google_calendar" : "google_gmail",
          providerItemId: "provider-item-1",
          observedAt: NOW,
        },
      ],
    }),
  });
}
