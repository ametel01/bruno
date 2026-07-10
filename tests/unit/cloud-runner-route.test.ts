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

  it("returns the safe #152-compatible create runner DTO", async () => {
    mocks.createDigitalOceanRunnerForUser.mockResolvedValueOnce({
      ok: true,
      duplicate: false,
      runner: {
        id: "00000000-0000-4000-8000-000000000154",
        name: "DigitalOcean Runner",
        kind: "digitalocean",
        status: "provisioning",
        provider: "digitalocean",
        providerResourceId: null,
        region: "nyc3",
        sizeSlug: "s-1vcpu-1gb",
        image: "ubuntu-24-04-x64",
        provisioning: {
          status: "pending",
          error: null,
          startedAt: "2026-07-06T01:00:00.000Z",
          completedAt: null,
          phases: [
            {
              name: "pending",
              status: "current",
              startedAt: "2026-07-06T01:00:00.000Z",
              completedAt: null,
            },
          ],
        },
      },
    });
    const { POST } = await import("@/app/api/runners/route");

    const response = await POST(
      new Request("http://localhost/api/runners", {
        method: "POST",
        body: JSON.stringify({ provider: "digitalocean", name: "DigitalOcean Runner" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      ok: true,
      duplicate: false,
      runner: {
        id: "00000000-0000-4000-8000-000000000154",
        provider: "digitalocean",
        region: "nyc3",
        sizeSlug: "s-1vcpu-1gb",
        image: "ubuntu-24-04-x64",
        provisioning: {
          status: "pending",
        },
      },
    });
    expect(mocks.createDigitalOceanRunnerForUser).toHaveBeenCalledWith(USER_ID, {
      provider: "digitalocean",
      name: "DigitalOcean Runner",
    });
    expect(JSON.stringify(body)).not.toContain("registrationToken");
    expect(JSON.stringify(body)).not.toContain("agb_reg_");
    expect(JSON.stringify(body)).not.toContain("agb_run_");
    expect(JSON.stringify(body)).not.toContain("credentialHash");
    expect(JSON.stringify(body)).not.toContain("AGENTBAY_DIGITALOCEAN_TOKEN");
  });

  it("returns duplicate create runner state safely", async () => {
    mocks.createDigitalOceanRunnerForUser.mockResolvedValueOnce({
      ok: true,
      duplicate: true,
      runner: {
        id: "00000000-0000-4000-8000-000000000154",
        provisioning: {
          status: "waiting_for_runner",
        },
      },
    });
    const { POST } = await import("@/app/api/runners/route");

    const response = await POST(
      new Request("http://localhost/api/runners", {
        method: "POST",
        body: JSON.stringify({ provider: "digitalocean" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      duplicate: true,
      runner: {
        provisioning: {
          status: "waiting_for_runner",
        },
      },
    });
  });

  it("returns safe persistence errors without echoing cause details", async () => {
    mocks.createDigitalOceanRunnerForUser.mockRejectedValueOnce(
      new mocks.RunnerProvisioningPersistenceError({
        code: "ECONNREFUSED",
        message: "postgres://user:pass@localhost/db agb_reg_should_not_render",
      }),
    );
    const { POST } = await import("@/app/api/runners/route");

    const response = await POST(
      new Request("http://localhost/api/runners", {
        method: "POST",
        body: JSON.stringify({ provider: "digitalocean" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      ok: false,
      error: {
        code: "database_unavailable",
        message:
          "Database is unavailable. Start Postgres and run migrations before creating runners.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(JSON.stringify(body)).not.toContain("agb_reg_should_not_render");
  });
});
