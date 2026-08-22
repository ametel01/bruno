import { describe, expect, it, vi } from "vitest";
import {
  founderOperatorAccessErrorResponse,
  requireFounderOperatorWorkspaceAccess,
} from "@/app/api/operator/_shared/owner-preview-access";
import { FounderReleaseStageAccessError } from "@/src/server/founder-product-contract/release-stage-access";

const USER_ID = "00000000-0000-4000-8000-000000003381";
const NOW = new Date("2026-08-22T00:00:00.000Z");

describe("Founder Owner Preview route access", () => {
  it("enforces persisted authority in operator and Clerk production modes", async () => {
    for (const authMode of ["operator", "clerk"] as const) {
      const requireAccess = vi.fn(async () => {
        throw new FounderReleaseStageAccessError();
      });

      const response = await requireFounderOperatorWorkspaceAccess(USER_ID, "workspace", {
        authMode,
        now: () => NOW,
        requireAccess,
      });

      expect(response?.status).toBe(403);
      expect(requireAccess).toHaveBeenCalledWith(USER_ID, NOW, {}, "workspace");
    }
  });

  it("keeps the explicit development-only bypass", async () => {
    const requireAccess = vi.fn();

    await expect(
      requireFounderOperatorWorkspaceAccess(USER_ID, "workspace", {
        authMode: "development",
        requireAccess,
      }),
    ).resolves.toBeNull();
    expect(requireAccess).not.toHaveBeenCalled();
  });

  it("sanitizes a deep work-authority denial for route adapters", async () => {
    const response = founderOperatorAccessErrorResponse(new FounderReleaseStageAccessError());

    expect(response?.status).toBe(403);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    await expect(response?.json()).resolves.toEqual({
      error: {
        code: "owner_preview_access_required",
        message:
          "Owner Preview is unavailable until exact-revision admission and current Recovery Archive protection are verified.",
      },
    });
    expect(founderOperatorAccessErrorResponse(new Error("unexpected"))).toBeNull();
  });

  it("names the Trusted Preview invitation boundary without exposing internals", async () => {
    const response = founderOperatorAccessErrorResponse(
      new FounderReleaseStageAccessError("trusted_preview"),
    );

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: {
        code: "trusted_preview_access_required",
        message:
          "Trusted Preview is unavailable until Clerk identity, invitation admission, exact-revision authority, and current Recovery Archive protection are verified.",
      },
    });
  });
});
