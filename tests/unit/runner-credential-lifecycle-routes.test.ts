import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RunnerCredentialLifecyclePersistenceError extends Error {
    constructor(readonly cause?: unknown) {
      super("Runner credential lifecycle persistence failed.");
      this.name = "RunnerCredentialLifecyclePersistenceError";
    }
  }

  return {
    rotateRunnerCredentialForDevelopmentUser: vi.fn(),
    revokeRunnerCredentialForDevelopmentUser: vi.fn(),
    RunnerCredentialLifecyclePersistenceError,
  };
});

vi.mock("@/src/server/runners/runner-credential-lifecycle", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/src/server/runners/runner-credential-lifecycle")>();

  return {
    ...actual,
    rotateRunnerCredentialForDevelopmentUser: mocks.rotateRunnerCredentialForDevelopmentUser,
    revokeRunnerCredentialForDevelopmentUser: mocks.revokeRunnerCredentialForDevelopmentUser,
    RunnerCredentialLifecyclePersistenceError: mocks.RunnerCredentialLifecyclePersistenceError,
  };
});

describe("POST /api/runners/:runnerId/credentials/rotate route", () => {
  afterEach(() => {
    mocks.rotateRunnerCredentialForDevelopmentUser.mockReset();
    mocks.revokeRunnerCredentialForDevelopmentUser.mockReset();
  });

  it("returns one visible-once rotated credential without hash or old raw credential material", async () => {
    mocks.rotateRunnerCredentialForDevelopmentUser.mockResolvedValueOnce({
      ok: true,
      runner: { id: "00000000-0000-4000-8000-000000000131" },
      credential: {
        token: "agb_run_newvisibleonce_123456789012345678901234567890",
        prefix: "agb_run_newvisib",
        rotatedAt: "2026-07-05T08:01:00.000Z",
      },
    });
    const { POST } = await import("@/app/api/runners/[runnerId]/credentials/rotate/route");

    const response = await POST(
      new Request(
        "http://localhost/api/runners/00000000-0000-4000-8000-000000000131/credentials/rotate",
        { method: "POST" },
      ),
      { params: Promise.resolve({ runnerId: "00000000-0000-4000-8000-000000000131" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      ok: true,
      runner: { id: "00000000-0000-4000-8000-000000000131" },
      credential: {
        token: "agb_run_newvisibleonce_123456789012345678901234567890",
        prefix: "agb_run_newvisib",
        rotatedAt: "2026-07-05T08:01:00.000Z",
      },
    });
    expect(mocks.rotateRunnerCredentialForDevelopmentUser).toHaveBeenCalledWith({
      runnerId: "00000000-0000-4000-8000-000000000131",
    });
    expect(JSON.stringify(body)).not.toContain("credentialHash");
    expect(JSON.stringify(body)).not.toContain("tokenHash");
    expect(JSON.stringify(body)).not.toContain(
      "agb_run_oldvisibleonce_123456789012345678901234567890",
    );
  });

  it("returns safe management errors", async () => {
    const { POST } = await import("@/app/api/runners/[runnerId]/credentials/rotate/route");

    const malformed = await POST(
      new Request("http://localhost/api/runners/not-a-runner-id/credentials/rotate", {
        method: "POST",
      }),
      { params: Promise.resolve({ runnerId: "not-a-runner-id" }) },
    );
    const malformedBody = await malformed.json();

    expect(malformed.status).toBe(400);
    expect(malformedBody).toEqual({
      ok: false,
      error: {
        code: "validation_failed",
        message: "Runner ID must be a valid UUID.",
      },
    });

    for (const [reason, expectedStatus, expectedCode] of [
      ["runner_not_found", 404, "runner_not_found"],
      ["runner_credential_already_revoked", 409, "runner_credential_already_revoked"],
    ] as const) {
      mocks.rotateRunnerCredentialForDevelopmentUser.mockResolvedValueOnce({ ok: false, reason });

      const response = await POST(
        new Request(
          "http://localhost/api/runners/00000000-0000-4000-8000-000000000131/credentials/rotate",
          { method: "POST" },
        ),
        { params: Promise.resolve({ runnerId: "00000000-0000-4000-8000-000000000131" }) },
      );
      const body = await response.json();

      expect(response.status).toBe(expectedStatus);
      expect(body).toMatchObject({
        ok: false,
        error: {
          code: expectedCode,
        },
      });
      expect(JSON.stringify(body)).not.toContain("credentialHash");
    }
  });

  it("returns a safe persistence error", async () => {
    mocks.rotateRunnerCredentialForDevelopmentUser.mockRejectedValueOnce(
      new mocks.RunnerCredentialLifecyclePersistenceError({ code: "42P01" }),
    );
    const { POST } = await import("@/app/api/runners/[runnerId]/credentials/rotate/route");

    const response = await POST(
      new Request(
        "http://localhost/api/runners/00000000-0000-4000-8000-000000000131/credentials/rotate",
        { method: "POST" },
      ),
      { params: Promise.resolve({ runnerId: "00000000-0000-4000-8000-000000000131" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      ok: false,
      error: {
        code: "runner_credential_rotate_failed",
        message: "Runner credential could not be rotated.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });
});

describe("POST /api/runners/:runnerId/credentials/revoke route", () => {
  afterEach(() => {
    mocks.rotateRunnerCredentialForDevelopmentUser.mockReset();
    mocks.revokeRunnerCredentialForDevelopmentUser.mockReset();
  });

  it("revokes credentials without returning raw credential or hash material", async () => {
    mocks.revokeRunnerCredentialForDevelopmentUser.mockResolvedValueOnce({
      ok: true,
      runner: { id: "00000000-0000-4000-8000-000000000131" },
      credential: {
        revokedAt: "2026-07-05T09:00:00.000Z",
        revokedCredentialCount: 1,
      },
    });
    const { POST } = await import("@/app/api/runners/[runnerId]/credentials/revoke/route");

    const response = await POST(
      new Request(
        "http://localhost/api/runners/00000000-0000-4000-8000-000000000131/credentials/revoke",
        { method: "POST" },
      ),
      { params: Promise.resolve({ runnerId: "00000000-0000-4000-8000-000000000131" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      runner: { id: "00000000-0000-4000-8000-000000000131" },
      credential: {
        revokedAt: "2026-07-05T09:00:00.000Z",
        revokedCredentialCount: 1,
      },
    });
    expect(mocks.revokeRunnerCredentialForDevelopmentUser).toHaveBeenCalledWith({
      runnerId: "00000000-0000-4000-8000-000000000131",
    });
    expect(JSON.stringify(body)).not.toContain("agb_run_");
    expect(JSON.stringify(body)).not.toContain("credentialHash");
    expect(JSON.stringify(body)).not.toContain("tokenHash");
  });

  it("returns safe management errors", async () => {
    const { POST } = await import("@/app/api/runners/[runnerId]/credentials/revoke/route");

    const malformed = await POST(
      new Request("http://localhost/api/runners/%E0%A4%A/credentials/revoke", {
        method: "POST",
      }),
      { params: Promise.resolve({ runnerId: "%E0%A4%A" }) },
    );
    const malformedBody = await malformed.json();

    expect(malformed.status).toBe(400);
    expect(malformedBody).toMatchObject({
      ok: false,
      error: {
        code: "validation_failed",
      },
    });

    for (const [reason, expectedStatus, expectedCode] of [
      ["runner_not_found", 404, "runner_not_found"],
      ["runner_credential_already_revoked", 409, "runner_credential_already_revoked"],
    ] as const) {
      mocks.revokeRunnerCredentialForDevelopmentUser.mockResolvedValueOnce({ ok: false, reason });

      const response = await POST(
        new Request(
          "http://localhost/api/runners/00000000-0000-4000-8000-000000000131/credentials/revoke",
          { method: "POST" },
        ),
        { params: Promise.resolve({ runnerId: "00000000-0000-4000-8000-000000000131" }) },
      );
      const body = await response.json();

      expect(response.status).toBe(expectedStatus);
      expect(body).toMatchObject({
        ok: false,
        error: {
          code: expectedCode,
        },
      });
      expect(JSON.stringify(body)).not.toContain("agb_run_");
      expect(JSON.stringify(body)).not.toContain("credentialHash");
    }
  });
});
