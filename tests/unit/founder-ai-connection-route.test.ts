import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  startAuthorization: vi.fn(),
  pollAuthorization: vi.fn(),
  recheckConnection: vi.fn(),
  disconnectConnection: vi.fn(),
  requireApplicationUser: vi.fn(),
}));

vi.mock("@/src/server/operators/founder-ai-connection", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/src/server/operators/founder-ai-connection")>();
  return {
    ...actual,
    getFounderAiConnectionForUser: mocks.getConnection,
    startFounderOpenAiAuthorizationForUser: mocks.startAuthorization,
    pollFounderOpenAiAuthorizationForUser: mocks.pollAuthorization,
    recheckFounderOpenAiConnectionForUser: mocks.recheckConnection,
    disconnectFounderOpenAiForUser: mocks.disconnectConnection,
  };
});

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireApplicationUser,
}));

const USER_ID = "00000000-0000-4000-8000-000000003381";
const CONNECTION = {
  provider: "openai",
  status: "ready",
  accountLabel: "founder@example.com",
  connectedAt: "2026-08-18T01:00:00.000Z",
  lastVerifiedAt: "2026-08-18T01:00:01.000Z",
  workState: "available",
  recoveryMessage: null,
  receipt: {
    provider: "openai",
    accountLabel: "founder@example.com",
    outcome: "connected",
    issuedAt: "2026-08-18T01:00:01.000Z",
  },
};

describe("Founder AI connection route", () => {
  beforeEach(() => {
    mocks.requireApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
    mocks.getConnection.mockResolvedValue(CONNECTION);
    mocks.startAuthorization.mockResolvedValue({
      connection: { ...CONNECTION, status: "authorizing", workState: "paused", receipt: null },
      authorization: {
        authorizationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
        expiresAt: "2026-08-18T01:15:00.000Z",
      },
    });
    mocks.pollAuthorization.mockResolvedValue(CONNECTION);
    mocks.recheckConnection.mockResolvedValue(CONNECTION);
    mocks.disconnectConnection.mockResolvedValue({
      ...CONNECTION,
      status: "disconnected",
      workState: "paused",
      receipt: { ...CONNECTION.receipt, outcome: "disconnected" },
    });
  });

  afterEach(() => vi.clearAllMocks());

  it("returns a plain connection summary without model or credential fields", async () => {
    const { GET } = await import("@/app/api/operator/connections/route");
    const response = await GET(new Request("http://localhost/api/operator/connections"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ connection: CONNECTION });
    expect(JSON.stringify(body)).not.toMatch(/model|token|secret|credential|api.?key/i);
  });

  it("starts structured device authorization and returns only the browser handoff", async () => {
    const { POST } = await import("@/app/api/operator/connections/route");
    const response = await POST(
      new Request("http://localhost/api/operator/connections", {
        method: "POST",
        body: JSON.stringify({ action: "start" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      authorization: { authorizationUrl: expect.any(String), userCode: expect.any(String) },
    });
    expect(mocks.startAuthorization).toHaveBeenCalledWith(USER_ID);
  });

  it("polls, rechecks, and disconnects through explicit actions", async () => {
    const { POST } = await import("@/app/api/operator/connections/route");
    const base = "http://localhost/api/operator/connections";
    await POST(
      new Request(base, {
        method: "POST",
        body: JSON.stringify({ action: "poll", sessionId: "opaque-session" }),
      }),
    );
    await POST(new Request(base, { method: "POST", body: JSON.stringify({ action: "recheck" }) }));
    await POST(
      new Request(base, { method: "POST", body: JSON.stringify({ action: "disconnect" }) }),
    );

    expect(mocks.pollAuthorization).toHaveBeenCalledWith(USER_ID, "opaque-session");
    expect(mocks.recheckConnection).toHaveBeenCalledWith(USER_ID);
    expect(mocks.disconnectConnection).toHaveBeenCalledWith(USER_ID);
  });
});
