import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RunnerRegistrationPersistenceError extends Error {
    constructor(readonly cause?: unknown) {
      super("Runner registration persistence failed.");
      this.name = "RunnerRegistrationPersistenceError";
    }
  }

  return {
    createRunnerRegistrationTokenForDevelopmentUser: vi.fn(),
    exchangeRunnerRegistrationTokenForCredential: vi.fn(),
    RunnerRegistrationPersistenceError,
  };
});

vi.mock("@/src/server/runners/runner-registration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/runners/runner-registration")>();

  return {
    ...actual,
    createRunnerRegistrationTokenForDevelopmentUser:
      mocks.createRunnerRegistrationTokenForDevelopmentUser,
    exchangeRunnerRegistrationTokenForCredential:
      mocks.exchangeRunnerRegistrationTokenForCredential,
    RunnerRegistrationPersistenceError: mocks.RunnerRegistrationPersistenceError,
  };
});

describe("POST /api/runners/registration-tokens route", () => {
  afterEach(() => {
    mocks.createRunnerRegistrationTokenForDevelopmentUser.mockReset();
    mocks.exchangeRunnerRegistrationTokenForCredential.mockReset();
  });

  it("returns one visible-once raw registration token without hash material", async () => {
    mocks.createRunnerRegistrationTokenForDevelopmentUser.mockResolvedValueOnce({
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
  });

  it("returns safe persistence errors", async () => {
    mocks.createRunnerRegistrationTokenForDevelopmentUser.mockRejectedValueOnce(
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
});

describe("POST /runner/v1/register route", () => {
  afterEach(() => {
    mocks.createRunnerRegistrationTokenForDevelopmentUser.mockReset();
    mocks.exchangeRunnerRegistrationTokenForCredential.mockReset();
  });

  it("returns runner identity and one visible-once credential for a valid exchange", async () => {
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
    );
    const body = await response.json();

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
    expect(JSON.stringify(body)).not.toContain("tokenHash");
    expect(JSON.stringify(body)).not.toContain("credentialHash");
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
