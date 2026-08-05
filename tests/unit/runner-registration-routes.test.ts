import { afterEach, describe, expect, it, vi } from "vitest";
import { runnerIngressLogger } from "@/src/server/runners/runner-ingress-logging";

const USER_ID = "00000000-0000-4000-8000-000000000111";

const mocks = vi.hoisted(() => {
  class RunnerRegistrationPersistenceError extends Error {
    constructor(readonly cause?: unknown) {
      super("Runner registration persistence failed.");
      this.name = "RunnerRegistrationPersistenceError";
    }
  }

  return {
    createRunnerRegistrationTokenForUser: vi.fn(),
    exchangeRunnerRegistrationTokenForCredential: vi.fn(),
    requireConfiguredApplicationUser: vi.fn(
      async (): Promise<Record<string, unknown>> => ({ ok: true, userId: USER_ID }),
    ),
    RunnerRegistrationPersistenceError,
  };
});

vi.mock("@/src/server/runners/runner-registration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/runners/runner-registration")>();

  return {
    ...actual,
    createRunnerRegistrationTokenForUser: mocks.createRunnerRegistrationTokenForUser,
    exchangeRunnerRegistrationTokenForCredential:
      mocks.exchangeRunnerRegistrationTokenForCredential,
    RunnerRegistrationPersistenceError: mocks.RunnerRegistrationPersistenceError,
  };
});

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireConfiguredApplicationUser,
}));

describe("POST /api/runners/registration-tokens route", () => {
  afterEach(() => {
    mocks.createRunnerRegistrationTokenForUser.mockReset();
    mocks.exchangeRunnerRegistrationTokenForCredential.mockReset();
    mocks.requireConfiguredApplicationUser.mockReset();
    mocks.requireConfiguredApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
  });

  it("returns one visible-once raw registration token without hash material", async () => {
    mocks.createRunnerRegistrationTokenForUser.mockResolvedValueOnce({
      registrationToken: {
        id: "00000000-0000-4000-8000-000000000101",
        token: "agb_reg_1234567890123456789012345678901234567890123",
        prefix: "agb_reg_12345678",
        expiresAt: "2026-07-05T08:15:00.000Z",
      },
    });
    const { POST } = await import("@/app/api/runners/registration-tokens/route");

    const response = await POST(
      new Request("http://localhost/api/runners/registration-tokens", { method: "POST" }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      registrationToken: {
        id: "00000000-0000-4000-8000-000000000101",
        token: "agb_reg_1234567890123456789012345678901234567890123",
        prefix: "agb_reg_12345678",
        expiresAt: "2026-07-05T08:15:00.000Z",
      },
    });
    expect(JSON.stringify(body)).not.toContain("tokenHash");
    expect(JSON.stringify(body)).not.toContain("credentialHash");
    expect(mocks.createRunnerRegistrationTokenForUser).toHaveBeenCalledWith(USER_ID);
  });

  it("returns safe persistence errors", async () => {
    mocks.createRunnerRegistrationTokenForUser.mockRejectedValueOnce(
      new mocks.RunnerRegistrationPersistenceError({ code: "42P01" }),
    );
    const { POST } = await import("@/app/api/runners/registration-tokens/route");

    const response = await POST(
      new Request("http://localhost/api/runners/registration-tokens", { method: "POST" }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: {
        code: "database_schema_missing",
        message: "Database schema is missing. Run migrations before registering runners.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });

  it("rejects signed-out browser token creation before generating a token", async () => {
    mocks.requireConfiguredApplicationUser.mockResolvedValueOnce({
      ok: false,
      status: 401,
      code: "unauthenticated",
    });
    const { POST } = await import("@/app/api/runners/registration-tokens/route");

    const response = await POST(
      new Request("http://localhost/api/runners/registration-tokens", { method: "POST" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthenticated", message: "Authentication is required." },
    });
    expect(mocks.createRunnerRegistrationTokenForUser).not.toHaveBeenCalled();
  });
});

describe("POST /runner/v1/register route", () => {
  afterEach(() => {
    mocks.createRunnerRegistrationTokenForUser.mockReset();
    mocks.exchangeRunnerRegistrationTokenForCredential.mockReset();
    vi.restoreAllMocks();
  });

  it("returns runner identity and one visible-once credential for a valid exchange", async () => {
    const infoSpy = vi.spyOn(runnerIngressLogger, "info").mockImplementation(() => {});
    const scheduleReconciliations = vi.fn();

    mocks.exchangeRunnerRegistrationTokenForCredential.mockResolvedValueOnce({
      ok: true,
      runner: {
        id: "00000000-0000-4000-8000-000000000201",
      },
      credential: {
        token: "agb_run_1234567890123456789012345678901234567890123",
        prefix: "agb_run_12345678",
      },
    });
    const { POST } = await import("@/app/runner/v1/register/route");

    const response = await POST(
      new Request("http://localhost/runner/v1/register", {
        method: "POST",
        body: JSON.stringify({
          registrationToken: "agb_reg_1234567890123456789012345678901234567890123",
          endpointUrl: "http://127.0.0.1:8787",
          name: "Registered Runner",
        }),
      }),
      undefined,
      { scheduleReconciliations },
    );
    const body = await response.json();
    const ingressLogs = infoSpy.mock.calls.map(([event, metadata]) => ({ ...metadata, event }));

    expect(response.status).toBe(201);
    expect(body).toEqual({
      ok: true,
      runner: {
        id: "00000000-0000-4000-8000-000000000201",
      },
      credential: {
        token: "agb_run_1234567890123456789012345678901234567890123",
        prefix: "agb_run_12345678",
      },
    });
    expect(mocks.exchangeRunnerRegistrationTokenForCredential).toHaveBeenCalledWith({
      registrationToken: "agb_reg_1234567890123456789012345678901234567890123",
      endpointUrl: "http://127.0.0.1:8787",
      name: "Registered Runner",
    });
    expect(scheduleReconciliations).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000201");
    expect(ingressLogs).toContainEqual(
      expect.objectContaining({
        endpoint: "register",
        event: "request_validated",
        endpointHostname: "127.0.0.1",
        hasName: true,
      }),
    );
    expect(ingressLogs).toContainEqual(
      expect.objectContaining({
        endpoint: "register",
        event: "runner_registered",
        runnerId: "00000000-0000-4000-8000-000000000201",
        endpointHostname: "127.0.0.1",
      }),
    );
    expect(JSON.stringify(body)).not.toContain("tokenHash");
    expect(JSON.stringify(body)).not.toContain("credentialHash");
    expect(JSON.stringify(ingressLogs)).not.toContain("agb_reg_");
    expect(JSON.stringify(ingressLogs)).not.toContain("agb_run_");
    expect(mocks.requireConfiguredApplicationUser).not.toHaveBeenCalled();
  });

  it("returns safe validation failures for missing, malformed, and wrong-prefix tokens", async () => {
    const { POST } = await import("@/app/runner/v1/register/route");

    for (const registrationToken of [
      "",
      "agb_reg_short",
      "agb_run_1234567890123456789012345678901234567890123",
    ]) {
      const response = await POST(
        new Request("http://localhost/runner/v1/register", {
          method: "POST",
          body: JSON.stringify({
            registrationToken,
            endpointUrl: "http://127.0.0.1:8787",
          }),
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        ok: false,
        error: {
          code: "validation_failed",
        },
      });
      expect(JSON.stringify(body)).not.toContain("tokenHash");
      expect(JSON.stringify(body)).not.toContain("credentialHash");
    }

    expect(mocks.exchangeRunnerRegistrationTokenForCredential).not.toHaveBeenCalled();
  });

  it("returns one generic safe failure for unknown, expired, revoked, and used tokens", async () => {
    const { POST } = await import("@/app/runner/v1/register/route");

    for (const reason of [
      "unknown_registration_token",
      "expired_registration_token",
      "revoked_registration_token",
      "used_registration_token",
    ]) {
      mocks.exchangeRunnerRegistrationTokenForCredential.mockResolvedValueOnce({
        ok: false,
        reason,
      });

      const response = await POST(
        new Request("http://localhost/runner/v1/register", {
          method: "POST",
          body: JSON.stringify({
            registrationToken: "agb_reg_1234567890123456789012345678901234567890123",
            endpointUrl: "http://127.0.0.1:8787",
          }),
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body).toEqual({
        ok: false,
        error: {
          code: "invalid_registration_token",
          message: "Registration token is invalid or no longer usable.",
        },
      });
      expect(JSON.stringify(body)).not.toContain(
        "agb_reg_1234567890123456789012345678901234567890123",
      );
    }
  });

  it("returns safe validation JSON for malformed request bodies", async () => {
    const { POST } = await import("@/app/runner/v1/register/route");

    const response = await POST(
      new Request("http://localhost/runner/v1/register", {
        method: "POST",
        body: "{",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: {
        code: "validation_failed",
        message: "Request validation failed.",
        issues: [{ field: "body", message: "Request body must be valid JSON." }],
      },
    });
    expect(mocks.exchangeRunnerRegistrationTokenForCredential).not.toHaveBeenCalled();
  });
});
