import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FounderReleaseStageAccessError } from "@/src/server/founder-product-contract/release-stage-access";

const mocks = vi.hoisted(() => ({
  requireWorkspaceAccess: vi.fn(),
  accessErrorResponse: vi.fn(),
}));

vi.mock("@/app/api/operator/_shared/owner-preview-access", () => ({
  requireFounderOperatorWorkspaceAccess: mocks.requireWorkspaceAccess,
  founderOperatorAccessErrorResponse: mocks.accessErrorResponse,
}));

const USER_ID = "00000000-0000-4000-8000-000000003492";
const PREFERENCES = {
  operatorId: "00000000-0000-4000-8000-000000003493",
  localTime: "07:30",
  nextDeliveryAt: "2026-08-24T23:30:00.000Z",
  timezone: "Asia/Manila",
};

describe("Founder Morning Brief settings route", () => {
  beforeEach(() => {
    mocks.requireWorkspaceAccess.mockResolvedValue(null);
    mocks.accessErrorResponse.mockImplementation((error) =>
      error instanceof FounderReleaseStageAccessError
        ? Response.json(
            { error: { code: error.code, message: error.message } },
            { status: error.status, headers: { "Cache-Control": "no-store" } },
          )
        : null,
    );
  });

  afterEach(() => vi.clearAllMocks());

  it("reads settings through General Release setup access", async () => {
    const getPreferences = vi.fn().mockResolvedValue(PREFERENCES);
    const requireApplicationUser = vi.fn().mockResolvedValue({ ok: true, userId: USER_ID });
    const { GET } = await import("@/app/api/operator/morning-brief/settings/route");

    const response = await GET(
      new Request("http://localhost/api/operator/morning-brief/settings"),
      undefined,
      { requireApplicationUser, getPreferences },
    );

    expect(response.status).toBe(200);
    expect(mocks.requireWorkspaceAccess).toHaveBeenCalledWith(USER_ID, "workspace", {
      allowGeneralReleaseSetup: true,
    });
    expect(getPreferences).toHaveBeenCalledWith(USER_ID);
  });

  it("updates settings through General Release setup access", async () => {
    const updatePreferences = vi.fn().mockResolvedValue(PREFERENCES);
    const requireApplicationUser = vi.fn().mockResolvedValue({ ok: true, userId: USER_ID });
    const { POST } = await import("@/app/api/operator/morning-brief/settings/route");

    const response = await POST(
      new Request("http://localhost/api/operator/morning-brief/settings", {
        method: "POST",
        body: JSON.stringify({ deliveryLocalTime: "07:30" }),
      }),
      undefined,
      { requireApplicationUser, updatePreferences },
    );

    expect(response.status).toBe(200);
    expect(mocks.requireWorkspaceAccess).toHaveBeenCalledWith(USER_ID, "workspace", {
      allowGeneralReleaseSetup: true,
    });
    expect(updatePreferences).toHaveBeenCalledWith(USER_ID, "07:30");
  });

  it("returns a sanitized denial when work authority expires during update", async () => {
    const updatePreferences = vi.fn().mockRejectedValue(new FounderReleaseStageAccessError());
    const requireApplicationUser = vi.fn().mockResolvedValue({ ok: true, userId: USER_ID });
    const { POST } = await import("@/app/api/operator/morning-brief/settings/route");

    const response = await POST(
      new Request("http://localhost/api/operator/morning-brief/settings", {
        method: "POST",
        body: JSON.stringify({ deliveryLocalTime: "07:30" }),
      }),
      undefined,
      { requireApplicationUser, updatePreferences },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "owner_preview_access_required" },
    });
  });
});
