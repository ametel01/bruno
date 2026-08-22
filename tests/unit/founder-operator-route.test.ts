import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admitOwnerPreview: vi.fn(),
  confirmTimezone: vi.fn(),
  ensureOperator: vi.fn(),
  getRecoveryArchiveStatus: vi.fn(),
  prepareRuntime: vi.fn(),
  requireApplicationUser: vi.fn(),
}));

vi.mock("@/src/server/operators/founder-operator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/operators/founder-operator")>();

  return {
    ...actual,
    confirmFounderTimezoneForUser: mocks.confirmTimezone,
    ensureFounderOperatorForUser: mocks.ensureOperator,
  };
});

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireApplicationUser,
}));

const USER_ID = "00000000-0000-4000-8000-000000003381";
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
    mocks.requireApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
    mocks.ensureOperator.mockResolvedValue(OPERATOR);
    mocks.getRecoveryArchiveStatus.mockResolvedValue({
      state: "current",
      lastVerifiedAt: "2026-08-22T00:00:00.000Z",
      restoreVerifiedAt: "2026-08-22T00:00:00.000Z",
      nextArchiveDueAt: "2026-08-23T00:00:00.000Z",
      retentionEndsAt: "2026-09-21T00:00:00.000Z",
      deletion: null,
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
    mocks.confirmTimezone.mockReset();
    mocks.ensureOperator.mockReset();
    mocks.getRecoveryArchiveStatus.mockReset();
    mocks.prepareRuntime.mockReset();
    mocks.requireApplicationUser.mockReset();
  });

  it("returns the authenticated Owner's resumable Operator projection", async () => {
    const { GET } = await import("@/app/api/operator/route");

    const response = await GET(new Request("http://localhost/api/operator"), undefined, {
      getRecoveryArchiveStatus: mocks.getRecoveryArchiveStatus,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      operator: OPERATOR,
      ownerPreviewAdmitted: true,
      ownerPreviewWorkAllowed: true,
      recoveryArchive: expect.objectContaining({
        state: "current",
        restoreVerifiedAt: "2026-08-22T00:00:00.000Z",
      }),
    });
    expect(mocks.ensureOperator).toHaveBeenCalledWith(USER_ID);
    expect(mocks.getRecoveryArchiveStatus).toHaveBeenCalledWith(USER_ID, expect.any(Date));
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

  it("starts idempotent runtime preparation without exposing infrastructure phases", async () => {
    const { POST } = await import("@/app/api/operator/route");
    const response = await POST(
      new Request("http://localhost/api/operator", {
        method: "POST",
        body: JSON.stringify({ action: "prepare" }),
      }),
      undefined,
      {
        admitOwnerPreview: mocks.admitOwnerPreview,
        prepareRuntime: mocks.prepareRuntime,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runtime: { status: "ready", transportState: "connected", safetyState: "verified" },
    });
    expect(mocks.prepareRuntime).toHaveBeenCalledWith(USER_ID);
    expect(mocks.admitOwnerPreview).toHaveBeenCalledWith(USER_ID);
  });

  it("fails Owner Preview admission closed when no verified Recovery Archive can be created", async () => {
    const { POST } = await import("@/app/api/operator/route");
    mocks.admitOwnerPreview.mockRejectedValueOnce(
      new Error("Recovery Archive storage unavailable"),
    );

    const response = await POST(
      new Request("http://localhost/api/operator", {
        method: "POST",
        body: JSON.stringify({ action: "prepare" }),
      }),
      undefined,
      {
        admitOwnerPreview: mocks.admitOwnerPreview,
        prepareRuntime: mocks.prepareRuntime,
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "owner_preview_unavailable" },
    });
  });
});
