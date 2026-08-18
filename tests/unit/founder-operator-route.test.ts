import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  confirmTimezone: vi.fn(),
  ensureOperator: vi.fn(),
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
    mocks.requireApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
    mocks.ensureOperator.mockResolvedValue(OPERATOR);
    mocks.confirmTimezone.mockResolvedValue({
      ...OPERATOR,
      preparation: {
        ...OPERATOR.preparation,
        status: "preparing",
        timezone: "Asia/Manila",
        timezoneConfirmedAt: "2026-08-18T01:00:00.000Z",
      },
    });
  });

  afterEach(() => {
    mocks.confirmTimezone.mockReset();
    mocks.ensureOperator.mockReset();
    mocks.requireApplicationUser.mockReset();
  });

  it("returns the authenticated Owner's resumable Operator projection", async () => {
    const { GET } = await import("@/app/api/operator/route");

    const response = await GET(new Request("http://localhost/api/operator"), undefined);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ operator: OPERATOR });
    expect(mocks.ensureOperator).toHaveBeenCalledWith(USER_ID);
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
});
