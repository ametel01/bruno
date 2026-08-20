import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  startAuthorization: vi.fn(),
  pollAuthorization: vi.fn(),
  recheckConnection: vi.fn(),
  disconnectConnection: vi.fn(),
  startAnthropicAuthorization: vi.fn(),
  pollAnthropicAuthorization: vi.fn(),
  recheckAnthropicConnection: vi.fn(),
  disconnectAnthropicConnection: vi.fn(),
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
    startFounderAnthropicAuthorizationForUser: mocks.startAnthropicAuthorization,
    pollFounderAnthropicAuthorizationForUser: mocks.pollAnthropicAuthorization,
    recheckFounderAnthropicConnectionForUser: mocks.recheckAnthropicConnection,
    disconnectFounderAnthropicForUser: mocks.disconnectAnthropicConnection,
  };
});

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireApplicationUser,
}));

vi.mock("@/src/server/operators/founder-openai-release", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/server/operators/founder-openai-release")>()),
  isFounderOpenAiReleased: () => true,
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
    mocks.startAnthropicAuthorization.mockResolvedValue({
      connection: {
        ...CONNECTION,
        provider: "anthropic",
        status: "authorizing",
        workState: "paused",
        receipt: null,
      },
      authorization: {
        authorizationUrl: "https://console.anthropic.com/oauth/authorize",
        userCode: "CLAUDE-CODE",
        expiresAt: "2026-08-18T01:15:00.000Z",
      },
    });
    mocks.pollAnthropicAuthorization.mockResolvedValue({ ...CONNECTION, provider: "anthropic" });
    mocks.recheckAnthropicConnection.mockResolvedValue({ ...CONNECTION, provider: "anthropic" });
    mocks.disconnectAnthropicConnection.mockResolvedValue({
      ...CONNECTION,
      provider: "anthropic",
      status: "disconnected",
      workState: "paused",
      receipt: { ...CONNECTION.receipt, provider: "anthropic", outcome: "disconnected" },
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

  it("fails closed before starting a new OpenAI connection without current acceptance", async () => {
    const { POST } = await import("@/app/api/operator/connections/route");
    const response = await POST(
      new Request("http://localhost/api/operator/connections", {
        method: "POST",
        body: JSON.stringify({ action: "start" }),
      }),
      undefined,
      { isOpenAiReleased: () => false },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "provider_not_released",
        message: "OpenAI is unavailable until current Connected Acceptance passes.",
      },
    });
    expect(mocks.startAuthorization).not.toHaveBeenCalled();
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

  it("dispatches Anthropic actions through the same route contract without exposing credentials", async () => {
    const { POST } = await import("@/app/api/operator/connections/route");
    const base = "http://localhost/api/operator/connections";
    const started = await POST(
      new Request(base, {
        method: "POST",
        body: JSON.stringify({ action: "start", provider: "anthropic" }),
      }),
      undefined,
      { isAnthropicReleased: () => true },
    );
    expect(started.status).toBe(200);
    expect(mocks.startAnthropicAuthorization).toHaveBeenCalledWith(USER_ID);
    const polled = await POST(
      new Request(base, {
        method: "POST",
        body: JSON.stringify({
          action: "poll",
          provider: "anthropic",
          sessionId: "claude-session",
        }),
      }),
      undefined,
      { isAnthropicReleased: () => true },
    );
    expect(polled.status).toBe(200);
    expect(mocks.pollAnthropicAuthorization).toHaveBeenCalledWith(USER_ID, "claude-session");
    expect(JSON.stringify(await polled.json())).not.toMatch(/token|secret|setup-token|api.?key/i);
  });

  it("fails closed before invoking Anthropic without exact acceptance", async () => {
    const { GET, POST } = await import("@/app/api/operator/connections/route");
    const base = "http://localhost/api/operator/connections";
    const read = await GET(new Request(`${base}?provider=anthropic`), undefined, {
      isAnthropicReleased: () => false,
    });
    const start = await POST(
      new Request(base, {
        method: "POST",
        body: JSON.stringify({ action: "start", provider: "anthropic" }),
      }),
      undefined,
      { isAnthropicReleased: () => false },
    );

    expect(read.status).toBe(409);
    expect(start.status).toBe(409);
    await expect(start.json()).resolves.toEqual({
      error: {
        code: "provider_not_released",
        message: "Anthropic is unavailable until current Connected Acceptance passes.",
      },
    });
    expect(mocks.recheckAnthropicConnection).not.toHaveBeenCalled();
    expect(mocks.startAnthropicAuthorization).not.toHaveBeenCalled();
  });

  it("does not let missing Anthropic evidence block released OpenAI", async () => {
    const { POST } = await import("@/app/api/operator/connections/route");
    const response = await POST(
      new Request("http://localhost/api/operator/connections", {
        method: "POST",
        body: JSON.stringify({ action: "start", provider: "openai" }),
      }),
      undefined,
      { isOpenAiReleased: () => true, isAnthropicReleased: () => false },
    );

    expect(response.status).toBe(200);
    expect(mocks.startAuthorization).toHaveBeenCalledWith(USER_ID);
    expect(mocks.startAnthropicAuthorization).not.toHaveBeenCalled();
  });

  it("keeps Anthropic disconnect available after release evidence expires", async () => {
    const { POST } = await import("@/app/api/operator/connections/route");
    const response = await POST(
      new Request("http://localhost/api/operator/connections", {
        method: "POST",
        body: JSON.stringify({ action: "disconnect", provider: "anthropic" }),
      }),
      undefined,
      { isAnthropicReleased: () => false },
    );

    expect(response.status).toBe(200);
    expect(mocks.disconnectAnthropicConnection).toHaveBeenCalledWith(USER_ID);
  });
});
