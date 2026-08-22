import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000003381";

const mocks = vi.hoisted(() => ({
  getOnboarding: vi.fn(),
  getOperator: vi.fn(),
  getOwnerPreviewAccess: vi.fn(),
  getRecoveryArchiveStatus: vi.fn(),
  readApplicationRevision: vi.fn(),
  requireApplicationUser: vi.fn(),
}));

vi.mock("@/src/auth/server-auth-mode", () => ({
  resolveAuthMode: () => ({ mode: "development" }),
}));

vi.mock("@/src/server/founder-product-contract/application-revision", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/src/server/founder-product-contract/application-revision")
    >();
  return {
    ...actual,
    readFounderApplicationRevision: mocks.readApplicationRevision,
  };
});

vi.mock("@/src/server/founder-product-contract/recovery-archive", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/src/server/founder-product-contract/recovery-archive")>();
  return { ...actual, getFounderRecoveryArchiveStatusForUser: mocks.getRecoveryArchiveStatus };
});

vi.mock("@/src/server/founder-product-contract/release-stage-access", () => ({
  getFounderOwnerPreviewAccessForUser: mocks.getOwnerPreviewAccess,
  hasFounderOwnerPreviewCapabilities: () => true,
  requiresFounderReleaseStageAuthority: () => false,
}));

vi.mock("@/src/server/operators/founder-onboarding", () => ({
  getFounderOnboardingForUser: mocks.getOnboarding,
}));

vi.mock("@/src/server/operators/founder-operator", () => ({
  getFounderOperatorForUser: mocks.getOperator,
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireApplicationUser,
}));

describe("Founder Operator page", () => {
  beforeEach(() => {
    mocks.requireApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
    mocks.getOperator.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000003391",
      userId: USER_ID,
      status: "active",
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
      preparation: {
        id: "00000000-0000-4000-8000-000000003392",
        status: "awaiting_timezone",
        timezone: null,
        timezoneConfirmedAt: null,
        startedAt: null,
        completedAt: null,
        recoveryMessage: null,
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
      },
    });
    mocks.getOnboarding.mockResolvedValue(undefined);
    mocks.readApplicationRevision.mockReturnValue(null);
    mocks.getRecoveryArchiveStatus.mockRejectedValue(
      new Error("Missing revision must not query archive status."),
    );
  });

  it("renders saved local workspace state with sanitized unavailable protection", async () => {
    const { default: FounderOperatorPage } = await import("@/app/operator/page");

    const html = renderToStaticMarkup(await FounderOperatorPage());

    expect(html).toContain("Confirm timezone");
    expect(html).toContain("Recovery Archive unavailable");
    expect(html).toContain("Unavailable");
    expect(mocks.getRecoveryArchiveStatus).not.toHaveBeenCalled();
  });
});
