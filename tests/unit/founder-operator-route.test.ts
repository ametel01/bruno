import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admitOwnerPreview: vi.fn(),
  admitTrustedPreview: vi.fn(),
  enterTrustedPreviewStage: vi.fn(),
  issueTrustedPreviewInvitation: vi.fn(),
  confirmTimezone: vi.fn(),
  ensureOperator: vi.fn(),
  getOperator: vi.fn(),
  getInfrastructureRetirementStatus: vi.fn(),
  getRecoveryArchiveStatus: vi.fn(),
  getOwnerPreviewAccess: vi.fn(),
  prepareRuntime: vi.fn(),
  requireApplicationUser: vi.fn(),
}));

vi.mock("@/src/server/operators/founder-operator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/operators/founder-operator")>();

  return {
    ...actual,
    confirmFounderTimezoneForUser: mocks.confirmTimezone,
    ensureFounderOperatorForUser: mocks.ensureOperator,
    getFounderOperatorForUser: mocks.getOperator,
  };
});

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireApplicationUser,
}));

const USER_ID = "00000000-0000-4000-8000-000000003381";
const APPLICATION_REVISION = "b".repeat(40);
const OPERATOR = {
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
};

describe("Founder Operator route", () => {
  beforeEach(() => {
    mocks.admitOwnerPreview.mockResolvedValue({ archiveId: "archive-373" });
    mocks.admitTrustedPreview.mockResolvedValue({ archiveId: "archive-376", cohortSlot: 1 });
    mocks.enterTrustedPreviewStage.mockResolvedValue({ decisionId: "decision-376" });
    mocks.issueTrustedPreviewInvitation.mockResolvedValue({
      invitationToken: "C".repeat(43),
      cohortSlot: 1,
    });
    mocks.requireApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
    mocks.ensureOperator.mockRejectedValue(new Error("GET must not create Operator state"));
    mocks.getOperator.mockResolvedValue(OPERATOR);
    mocks.getInfrastructureRetirementStatus.mockResolvedValue({ state: "unavailable" });
    mocks.getRecoveryArchiveStatus.mockResolvedValue({
      state: "current",
      lastVerifiedAt: "2026-08-22T00:00:00.000Z",
      restoreVerifiedAt: "2026-08-22T00:00:00.000Z",
      nextArchiveDueAt: "2026-08-23T00:00:00.000Z",
      retentionEndsAt: "2026-09-21T00:00:00.000Z",
      latestAttempt: {
        status: "verified",
        observedAt: "2026-08-22T00:00:00.000Z",
      },
      deletion: null,
    });
    mocks.getOwnerPreviewAccess.mockResolvedValue({
      admitted: true,
      availableCapabilities: ["calendar_reading"],
    });
    mocks.confirmTimezone.mockResolvedValue({
      ...OPERATOR,
      preparation: {
        ...OPERATOR.preparation,
        status: "preparing",
        timezone: "Asia/Manila",
        timezoneConfirmedAt: "2026-08-18T01:00:00.000Z",
      },
    });
    mocks.prepareRuntime.mockResolvedValue({
      operator: {
        ...OPERATOR,
        preparation: { ...OPERATOR.preparation, status: "ready" },
        runtime: {
          id: "00000000-0000-4000-8000-000000003393",
          status: "ready",
          transportState: "connected",
          safetyState: "verified",
          configRevision: "operator-runtime-1-1723939200000",
          runtimeIdentity: "bruno-operator-test",
          attemptCount: 1,
          startedAt: "2026-08-18T01:00:00.000Z",
          readyAt: "2026-08-18T01:00:01.000Z",
          recoveryMessage: null,
          failureCode: null,
          createdAt: "2026-08-18T00:00:00.000Z",
          updatedAt: "2026-08-18T01:00:01.000Z",
        },
      },
      runtime: {
        id: "00000000-0000-4000-8000-000000003393",
        status: "ready",
        transportState: "connected",
        safetyState: "verified",
        configRevision: "operator-runtime-1-1723939200000",
        runtimeIdentity: "bruno-operator-test",
        attemptCount: 1,
        startedAt: "2026-08-18T01:00:00.000Z",
        readyAt: "2026-08-18T01:00:01.000Z",
        recoveryMessage: null,
        failureCode: null,
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T01:00:01.000Z",
      },
    });
  });

  afterEach(() => {
    mocks.admitOwnerPreview.mockReset();
    mocks.admitTrustedPreview.mockReset();
    mocks.enterTrustedPreviewStage.mockReset();
    mocks.issueTrustedPreviewInvitation.mockReset();
    mocks.confirmTimezone.mockReset();
    mocks.ensureOperator.mockReset();
    mocks.getOperator.mockReset();
    mocks.getInfrastructureRetirementStatus.mockReset();
    mocks.getRecoveryArchiveStatus.mockReset();
    mocks.getOwnerPreviewAccess.mockReset();
    mocks.prepareRuntime.mockReset();
    mocks.requireApplicationUser.mockReset();
  });

  it("returns the authenticated Owner's resumable Operator projection", async () => {
    const { GET } = await import("@/app/api/operator/route");

    const response = await GET(new Request("http://localhost/api/operator"), undefined, {
      authMode: "development",
      getInfrastructureRetirementStatus: mocks.getInfrastructureRetirementStatus,
      getRecoveryArchiveStatus: mocks.getRecoveryArchiveStatus,
      readApplicationRevision: () => APPLICATION_REVISION,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      operator: OPERATOR,
      infrastructureRetirement: { state: "unavailable" },
      ownerPreviewAdmitted: true,
      ownerPreviewWorkAllowed: true,
      ownerPreview: {
        stage: "Owner Preview",
        state: "active",
        availableCapabilities: ["OpenAI", "Calendar reading"],
        supportBoundary: "Fully attended",
        evidenceClassification: "Learning Round",
        automaticPromotion: false,
      },
      recoveryArchive: expect.objectContaining({
        state: "current",
        restoreVerifiedAt: "2026-08-22T00:00:00.000Z",
      }),
    });
    expect(mocks.getOperator).toHaveBeenCalledWith(USER_ID);
    expect(mocks.ensureOperator).not.toHaveBeenCalled();
    expect(mocks.getRecoveryArchiveStatus).toHaveBeenCalledWith(USER_ID, expect.any(Date), {
      applicationRevision: APPLICATION_REVISION,
    });
  });

  it("returns an empty projection without creating workspace state before preparation", async () => {
    const { GET } = await import("@/app/api/operator/route");
    mocks.getOperator.mockResolvedValueOnce(null);

    const response = await GET(new Request("http://localhost/api/operator"), undefined, {
      getInfrastructureRetirementStatus: mocks.getInfrastructureRetirementStatus,
      getRecoveryArchiveStatus: mocks.getRecoveryArchiveStatus,
      readApplicationRevision: () => APPLICATION_REVISION,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ operator: null });
    expect(mocks.getOperator).toHaveBeenCalledWith(USER_ID);
    expect(mocks.ensureOperator).not.toHaveBeenCalled();
  });

  it("enforces persisted Release Stage authority in supported production operator mode", async () => {
    const { GET } = await import("@/app/api/operator/route");

    const response = await GET(new Request("http://localhost/api/operator"), undefined, {
      authMode: "operator",
      getInfrastructureRetirementStatus: mocks.getInfrastructureRetirementStatus,
      getOwnerPreviewAccess: mocks.getOwnerPreviewAccess,
      getRecoveryArchiveStatus: mocks.getRecoveryArchiveStatus,
      readApplicationRevision: () => APPLICATION_REVISION,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ownerPreviewAdmitted: true,
      ownerPreviewWorkAllowed: false,
    });
    expect(mocks.getOwnerPreviewAccess).toHaveBeenCalledWith(USER_ID, expect.any(Date));
  });

  it("fails closed when the executing application revision is unavailable", async () => {
    const { GET } = await import("@/app/api/operator/route");

    const response = await GET(new Request("http://localhost/api/operator"), undefined, {
      getInfrastructureRetirementStatus: mocks.getInfrastructureRetirementStatus,
      getRecoveryArchiveStatus: mocks.getRecoveryArchiveStatus,
      readApplicationRevision: () => null,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "operator_configuration_unavailable",
        message: "Founder workspace protection cannot be verified for this application release.",
      },
    });
    expect(mocks.getRecoveryArchiveStatus).not.toHaveBeenCalled();
  });

  it("confirms a plain-language timezone for the authenticated Owner", async () => {
    const { POST } = await import("@/app/api/operator/route");

    const response = await POST(
      new Request("http://localhost/api/operator", {
        method: "POST",
        body: JSON.stringify({ timezone: "Asia/Manila" }),
      }),
      undefined,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.operator.preparation).toMatchObject({
      status: "preparing",
      timezone: "Asia/Manila",
    });
    expect(mocks.confirmTimezone).toHaveBeenCalledWith(USER_ID, "Asia/Manila");
  });

  it("fails closed for unauthenticated requests and invalid input", async () => {
    const { POST } = await import("@/app/api/operator/route");

    mocks.requireApplicationUser.mockResolvedValueOnce({
      ok: false,
      status: 401,
      code: "unauthenticated",
    });
    const unauthorized = await POST(
      new Request("http://localhost/api/operator", { method: "POST", body: "{}" }),
      undefined,
    );
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ error: { code: "unauthenticated" } });

    mocks.requireApplicationUser.mockResolvedValueOnce({ ok: true, userId: USER_ID });
    const invalid = await POST(
      new Request("http://localhost/api/operator", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      undefined,
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "validation_failed" } });
  });

  it("prepares the runtime without automatically entering Owner Preview", async () => {
    const { POST } = await import("@/app/api/operator/route");
    const response = await POST(
      new Request("http://localhost/api/operator", {
        method: "POST",
        body: JSON.stringify({ action: "prepare" }),
      }),
      undefined,
      {
        admitOwnerPreview: mocks.admitOwnerPreview,
        getOwnerPreviewAccess: mocks.getOwnerPreviewAccess,
        prepareRuntime: mocks.prepareRuntime,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runtime: { status: "ready", transportState: "connected", safetyState: "verified" },
    });
    expect(mocks.prepareRuntime).toHaveBeenCalledWith(USER_ID);
    expect(mocks.admitOwnerPreview).not.toHaveBeenCalled();
  });

  it("enters Owner Preview only after an explicit exact-revision decision", async () => {
    const { POST } = await import("@/app/api/operator/route");

    const response = await POST(
      new Request("http://localhost/api/operator", {
        method: "POST",
        body: JSON.stringify({ action: "enter_owner_preview" }),
      }),
      undefined,
      {
        admitOwnerPreview: mocks.admitOwnerPreview,
        getOwnerPreviewAccess: mocks.getOwnerPreviewAccess,
        prepareRuntime: mocks.prepareRuntime,
      },
    );

    expect(response.status).toBe(200);
    expect(mocks.admitOwnerPreview).toHaveBeenCalledWith(USER_ID);
    expect(await response.json()).toMatchObject({
      ownerPreviewAdmitted: true,
      ownerPreview: { stage: "Owner Preview", evidenceClassification: "Learning Round" },
    });
  });

  it("persists a fail-closed denial when explicit Owner Preview evidence is unavailable", async () => {
    const { POST } = await import("@/app/api/operator/route");
    mocks.admitOwnerPreview.mockRejectedValueOnce(
      new Error("Recovery Archive storage unavailable"),
    );
    const response = await POST(
      new Request("http://localhost/api/operator", {
        method: "POST",
        body: JSON.stringify({ action: "enter_owner_preview" }),
      }),
      undefined,
      { admitOwnerPreview: mocks.admitOwnerPreview },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "owner_preview_unavailable" },
    });
  });

  it("accepts Trusted Preview only through the identity-bound invitation authority", async () => {
    const { POST } = await import("@/app/api/operator/route");
    mocks.getOwnerPreviewAccess.mockResolvedValueOnce({
      admitted: true,
      availableCapabilities: ["openai", "calendar_reading"],
      stage: "trusted_preview",
      cohortSlot: 1,
    });
    const response = await POST(
      new Request("http://localhost/api/operator", {
        method: "POST",
        body: JSON.stringify({
          action: "accept_trusted_preview_invitation",
          invitationToken: "A".repeat(43),
        }),
      }),
      undefined,
      {
        admitTrustedPreview: mocks.admitTrustedPreview,
        getOwnerPreviewAccess: mocks.getOwnerPreviewAccess,
      },
    );

    expect(response.status).toBe(200);
    expect(mocks.admitTrustedPreview).toHaveBeenCalledWith(USER_ID, "A".repeat(43));
    await expect(response.json()).resolves.toMatchObject({
      ownerPreviewAdmitted: true,
      ownerPreviewWorkAllowed: true,
      ownerPreview: {
        stage: "Trusted Preview",
        evidenceClassification: "Learning Round",
        founderAcceptanceEligible: false,
        cohortSlot: 1,
      },
    });
  });

  it("does not let a Clerk session without an invitation create Trusted Preview access", async () => {
    const { POST } = await import("@/app/api/operator/route");
    const missing = await POST(
      new Request("http://localhost/api/operator", {
        method: "POST",
        body: JSON.stringify({ action: "accept_trusted_preview_invitation" }),
      }),
      undefined,
      { admitTrustedPreview: mocks.admitTrustedPreview },
    );
    expect(missing.status).toBe(400);
    expect(mocks.admitTrustedPreview).not.toHaveBeenCalled();

    mocks.admitTrustedPreview.mockRejectedValueOnce(new Error("identity mismatch"));
    const mismatched = await POST(
      new Request("http://localhost/api/operator", {
        method: "POST",
        body: JSON.stringify({
          action: "accept_trusted_preview_invitation",
          invitationToken: "B".repeat(43),
        }),
      }),
      undefined,
      { admitTrustedPreview: mocks.admitTrustedPreview },
    );
    expect(mismatched.status).toBe(403);
    await expect(mismatched.json()).resolves.toMatchObject({
      error: { code: "trusted_preview_unavailable" },
    });
  });

  it("exposes explicit Owner-only cohort decision and invitation operations", async () => {
    const { POST } = await import("@/app/api/operator/route");
    const entered = await POST(
      new Request("http://localhost/api/operator", {
        method: "POST",
        body: JSON.stringify({ action: "enter_trusted_preview_stage" }),
      }),
      undefined,
      { enterTrustedPreviewStage: mocks.enterTrustedPreviewStage },
    );
    expect(entered.status).toBe(200);
    expect(mocks.enterTrustedPreviewStage).toHaveBeenCalledWith(USER_ID);
    await expect(entered.json()).resolves.toEqual({
      trustedPreview: { state: "entered", decisionId: "decision-376" },
    });

    const invited = await POST(
      new Request("http://localhost/api/operator", {
        method: "POST",
        body: JSON.stringify({
          action: "issue_trusted_preview_invitation",
          invitedClerkSubject: "user_trusted_contact",
          serviceBusinessEvidenceDigest: `sha256:${"d".repeat(64)}`,
        }),
      }),
      undefined,
      { issueTrustedPreviewInvitation: mocks.issueTrustedPreviewInvitation },
    );
    expect(invited.status).toBe(200);
    expect(mocks.issueTrustedPreviewInvitation).toHaveBeenCalledWith({
      cohortOwnerUserId: USER_ID,
      invitedClerkSubject: "user_trusted_contact",
      serviceBusinessEvidenceDigest: `sha256:${"d".repeat(64)}`,
    });
    await expect(invited.json()).resolves.toEqual({
      trustedPreviewInvitation: { invitationToken: "C".repeat(43), cohortSlot: 1 },
    });
  });
});
