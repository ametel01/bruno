import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPause: vi.fn(),
  requireApplicationUser: vi.fn(),
  setPause: vi.fn(),
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireApplicationUser,
}));

const USER_ID = "00000000-0000-4000-8000-000000003501";
const PAUSE = {
  paused: true,
  reason: "Review the proposed action first.",
  pausedAt: "2026-08-18T02:00:00.000Z",
};

describe("Founder External Action Pause route", () => {
  beforeEach(() => {
    mocks.requireApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
    mocks.getPause.mockResolvedValue(PAUSE);
    mocks.setPause.mockResolvedValue(PAUSE);
  });

  afterEach(() => {
    mocks.getPause.mockReset();
    mocks.requireApplicationUser.mockReset();
    mocks.setPause.mockReset();
  });

  it("returns the durable pause state without caching", async () => {
    const { GET } = await import("@/app/api/operator/external-action-pause/route");
    const response = await GET(
      new Request("http://localhost/api/operator/external-action-pause"),
      undefined,
      {
        getPause: mocks.getPause,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ pause: PAUSE });
    expect(mocks.getPause).toHaveBeenCalledWith(USER_ID);
  });

  it("sets a Founder-controlled pause reason", async () => {
    const { POST } = await import("@/app/api/operator/external-action-pause/route");
    const response = await POST(
      new Request("http://localhost/api/operator/external-action-pause", {
        method: "POST",
        body: JSON.stringify({ paused: true, reason: PAUSE.reason }),
      }),
      undefined,
      { setPause: mocks.setPause },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pause: PAUSE });
    expect(mocks.setPause).toHaveBeenCalledWith(USER_ID, true, { reason: PAUSE.reason });
  });

  it("fails closed for unauthenticated and invalid requests", async () => {
    const { POST } = await import("@/app/api/operator/external-action-pause/route");
    mocks.requireApplicationUser.mockResolvedValueOnce({
      ok: false,
      status: 401,
      code: "unauthenticated",
    });
    const unauthorized = await POST(
      new Request("http://localhost/api/operator/external-action-pause", {
        method: "POST",
        body: JSON.stringify({ paused: true }),
      }),
      undefined,
      { setPause: mocks.setPause },
    );
    expect(unauthorized.status).toBe(401);

    const invalid = await POST(
      new Request("http://localhost/api/operator/external-action-pause", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      undefined,
      { setPause: mocks.setPause },
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "validation_failed" } });
  });
});
