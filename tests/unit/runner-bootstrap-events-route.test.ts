import { afterEach, describe, expect, it, vi } from "vitest";
import { runnerIngressLogger } from "@/src/server/runners/runner-ingress-logging";

const mocks = vi.hoisted(() => {
  class RunnerBootstrapEventPersistenceError extends Error {
    constructor(readonly cause?: unknown) {
      super("Runner bootstrap event persistence failed.");
      this.name = "RunnerBootstrapEventPersistenceError";
    }
  }

  return {
    recordRunnerBootstrapEvent: vi.fn(),
    RunnerBootstrapEventPersistenceError,
  };
});

vi.mock("@/src/server/runners/runner-bootstrap-events", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/src/server/runners/runner-bootstrap-events")>();

  return {
    ...actual,
    recordRunnerBootstrapEvent: mocks.recordRunnerBootstrapEvent,
    RunnerBootstrapEventPersistenceError: mocks.RunnerBootstrapEventPersistenceError,
  };
});

describe("POST /runner/v1/bootstrap-events route", () => {
  afterEach(() => {
    mocks.recordRunnerBootstrapEvent.mockReset();
    vi.restoreAllMocks();
  });

  it("records safe bootstrap telemetry for a valid registration token", async () => {
    const infoSpy = vi.spyOn(runnerIngressLogger, "info").mockImplementation(() => {});

    mocks.recordRunnerBootstrapEvent.mockResolvedValueOnce({
      ok: true,
      runnerId: "00000000-0000-4000-8000-000000000301",
    });
    const { POST } = await import("@/app/runner/v1/bootstrap-events/route");

    const response = await POST(
      new Request("http://localhost/runner/v1/bootstrap-events", {
        method: "POST",
        body: JSON.stringify({
          registrationToken: "agb_reg_1234567890123456789012345678901234567890123",
          phase: "bootstrapping",
          status: "completed",
          message: "Docker apt repository was configured.",
          metadata: { step: "docker_apt_repository" },
        }),
      }),
    );
    const body = await response.json();
    const ingressLogs = infoSpy.mock.calls.map(([event, metadata]) => ({ ...metadata, event }));

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      runner: {
        id: "00000000-0000-4000-8000-000000000301",
      },
    });
    expect(mocks.recordRunnerBootstrapEvent).toHaveBeenCalledWith({
      registrationToken: "agb_reg_1234567890123456789012345678901234567890123",
      phase: "bootstrapping",
      status: "completed",
      message: "Docker apt repository was configured.",
      metadata: { step: "docker_apt_repository" },
    });
    expect(ingressLogs).toContainEqual(
      expect.objectContaining({
        endpoint: "bootstrap_events",
        event: "request_validated",
        phase: "bootstrapping",
        status: "completed",
        metadataStep: "docker_apt_repository",
      }),
    );
    expect(ingressLogs).toContainEqual(
      expect.objectContaining({
        endpoint: "bootstrap_events",
        event: "event_recorded",
        runnerId: "00000000-0000-4000-8000-000000000301",
        phase: "bootstrapping",
        status: "completed",
      }),
    );
    expect(JSON.stringify(body)).not.toContain("agb_reg_");
    expect(JSON.stringify(ingressLogs)).not.toContain("agb_reg_");
  });

  it("returns safe validation failures", async () => {
    const { POST } = await import("@/app/runner/v1/bootstrap-events/route");

    const response = await POST(
      new Request("http://localhost/runner/v1/bootstrap-events", {
        method: "POST",
        body: JSON.stringify({
          registrationToken: "agb_run_wrong",
          phase: "creating",
          status: "done",
          message: "",
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
    expect(mocks.recordRunnerBootstrapEvent).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("agb_run_wrong");
  });

  it("returns a generic unauthorized response for unknown registration tokens", async () => {
    mocks.recordRunnerBootstrapEvent.mockResolvedValueOnce({
      ok: false,
      reason: "unknown_registration_token",
    });
    const { POST } = await import("@/app/runner/v1/bootstrap-events/route");

    const response = await POST(
      new Request("http://localhost/runner/v1/bootstrap-events", {
        method: "POST",
        body: JSON.stringify({
          registrationToken: "agb_reg_1234567890123456789012345678901234567890123",
          phase: "bootstrapping",
          status: "failed",
          message: "Cloud runner bootstrap failed during docker_container_start.",
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
  });
});
