import { afterEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000111";

const mocks = vi.hoisted(() => {
  class RunnerProvisioningPersistenceError extends Error {
    constructor(readonly cause?: unknown) {
      super("Runner provisioning persistence failed.");
      this.name = "RunnerProvisioningPersistenceError";
    }
  }

  return {
    createDigitalOceanRunnerForUser: vi.fn(),
    requireConfiguredApplicationUser: vi.fn(
      async (): Promise<Record<string, unknown>> => ({ ok: true, userId: USER_ID }),
    ),
    RunnerProvisioningPersistenceError,
  };
});

vi.mock("@/src/server/runners/runner-provisioning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/runners/runner-provisioning")>();

  return {
    ...actual,
    createDigitalOceanRunnerForUser: mocks.createDigitalOceanRunnerForUser,
    RunnerProvisioningPersistenceError: mocks.RunnerProvisioningPersistenceError,
  };
});

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireConfiguredApplicationUser,
}));

describe("POST /api/runners route", () => {
  afterEach(() => {
    mocks.createDigitalOceanRunnerForUser.mockReset();
    mocks.requireConfiguredApplicationUser.mockReset();
    mocks.requireConfiguredApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
  });

  it("returns created provisioning runner state without registration or provider secrets", async () => {
    mocks.createDigitalOceanRunnerForUser.mockResolvedValueOnce({
      ok: true,
      duplicate: false,
      runner: safeRunnerDto({ status: "waiting_for_runner" }),
    });
    const { POST } = await import("@/app/api/runners/route");

    const response = await POST(
      new Request("http://localhost/api/runners", {
        method: "POST",
        body: JSON.stringify({ provider: "digitalocean", name: "Cloud Runner" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      ok: true,
      duplicate: false,
      runner: {
        kind: "digitalocean",
        provider: "digitalocean",
        provisioning: { status: "waiting_for_runner" },
      },
    });
    expect(mocks.createDigitalOceanRunnerForUser).toHaveBeenCalledWith(USER_ID, {
      provider: "digitalocean",
      name: "Cloud Runner",
    });
    expect(JSON.stringify(body)).not.toContain("agb_reg_");
    expect(JSON.stringify(body)).not.toContain("tokenHash");
    expect(JSON.stringify(body)).not.toContain("dop_v1");
  });

  it("returns safe failed provisioning state from provider failures", async () => {
    mocks.createDigitalOceanRunnerForUser.mockResolvedValueOnce({
      ok: true,
      duplicate: false,
      runner: safeRunnerDto({
        runnerStatus: "provision_failed",
        status: "failed",
        error:
          "DigitalOcean Droplet could not be created. Check provider quota, image, region, and token permissions.",
      }),
    });
    const { POST } = await import("@/app/api/runners/route");

    const response = await POST(
      new Request("http://localhost/api/runners", {
        method: "POST",
        body: JSON.stringify({ provider: "digitalocean" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.runner).toMatchObject({
      status: "provision_failed",
      provisioning: {
        status: "failed",
        error:
          "DigitalOcean Droplet could not be created. Check provider quota, image, region, and token permissions.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("tokenHash");
  });

  it("returns validation failures for malformed JSON and invalid input", async () => {
    const { POST } = await import("@/app/api/runners/route");

    const malformedResponse = await POST(
      new Request("http://localhost/api/runners", {
        method: "POST",
        body: "{",
      }),
    );
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toEqual({
      ok: false,
      error: {
        code: "validation_failed",
        message: "Request validation failed.",
        issues: [{ field: "body", message: "Request body must be valid JSON." }],
      },
    });
    expect(mocks.createDigitalOceanRunnerForUser).not.toHaveBeenCalled();

    mocks.createDigitalOceanRunnerForUser.mockResolvedValueOnce({
      ok: false,
      reason: "validation_failed",
      issues: [{ field: "provider", message: "Provider must be digitalocean." }],
    });

    const invalidResponse = await POST(
      new Request("http://localhost/api/runners", {
        method: "POST",
        body: JSON.stringify({ provider: "aws" }),
      }),
    );

    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toEqual({
      ok: false,
      error: {
        code: "validation_failed",
        message: "Request validation failed.",
        issues: [{ field: "provider", message: "Provider must be digitalocean." }],
      },
    });
  });

  it("returns duplicate submit state with 200 status", async () => {
    mocks.createDigitalOceanRunnerForUser.mockResolvedValueOnce({
      ok: true,
      duplicate: true,
      runner: safeRunnerDto({ status: "waiting_for_runner" }),
    });
    const { POST } = await import("@/app/api/runners/route");

    const response = await POST(
      new Request("http://localhost/api/runners", {
        method: "POST",
        body: JSON.stringify({ provider: "digitalocean" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      duplicate: true,
      runner: {
        provisioning: { status: "waiting_for_runner" },
      },
    });
  });

  it("returns safe provider configuration and persistence errors", async () => {
    mocks.createDigitalOceanRunnerForUser.mockResolvedValueOnce({
      ok: false,
      reason: "provider_not_configured",
    });
    const { POST } = await import("@/app/api/runners/route");

    const unconfiguredResponse = await POST(
      new Request("http://localhost/api/runners", {
        method: "POST",
        body: JSON.stringify({ provider: "digitalocean" }),
      }),
    );

    expect(unconfiguredResponse.status).toBe(503);
    expect(await unconfiguredResponse.json()).toEqual({
      ok: false,
      error: {
        code: "provider_not_configured",
        message: "DigitalOcean provisioning is not configured on this server.",
      },
    });

    mocks.createDigitalOceanRunnerForUser.mockRejectedValueOnce(
      new mocks.RunnerProvisioningPersistenceError({ code: "42P01" }),
    );

    const schemaResponse = await POST(
      new Request("http://localhost/api/runners", {
        method: "POST",
        body: JSON.stringify({ provider: "digitalocean" }),
      }),
    );

    expect(schemaResponse.status).toBe(503);
    expect(await schemaResponse.json()).toEqual({
      ok: false,
      error: {
        code: "database_schema_missing",
        message: "Database schema is missing. Run migrations before creating runners.",
      },
    });
  });

  it("requires one configured application user before parsing or provisioning", async () => {
    mocks.requireConfiguredApplicationUser.mockResolvedValueOnce({
      ok: false,
      status: 401,
      code: "unauthenticated",
    });
    const { POST } = await import("@/app/api/runners/route");

    const response = await POST(
      new Request("http://localhost/api/runners", { method: "POST", body: "{" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthenticated", message: "Authentication is required." },
    });
    expect(mocks.requireConfiguredApplicationUser).toHaveBeenCalledOnce();
    expect(mocks.createDigitalOceanRunnerForUser).not.toHaveBeenCalled();
  });
});

function safeRunnerDto(input: { runnerStatus?: string; status: string; error?: string | null }) {
  return {
    id: "00000000-0000-4000-8000-000000000301",
    name: "Cloud Runner",
    kind: "digitalocean",
    status: input.runnerStatus ?? "registering",
    provider: "digitalocean",
    providerResourceId: "droplet-1",
    region: "sfo3",
    sizeSlug: "s-1vcpu-1gb",
    image: "ubuntu-24-04-x64",
    provisioning: {
      status: input.status,
      error: input.error ?? null,
      startedAt: "2026-07-06T02:00:00.000Z",
      completedAt: input.status === "failed" ? "2026-07-06T02:00:03.000Z" : null,
      phases: [
        {
          phase: input.status,
          status: input.status === "failed" ? "failed" : "started",
          message: "Safe provisioning state.",
          metadata: { provider: "digitalocean" },
          createdAt: "2026-07-06T02:00:01.000Z",
        },
      ],
    },
  };
}
