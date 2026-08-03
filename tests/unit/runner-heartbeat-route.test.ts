import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RunnerHeartbeatPersistenceError extends Error {
    constructor() {
      super("Runner heartbeat failed.");
      this.name = "RunnerHeartbeatPersistenceError";
    }
  }

  return {
    confirmCloudRunnerReadiness: vi.fn(),
    recordRunnerHeartbeat: vi.fn(),
    RunnerHeartbeatPersistenceError,
  };
});

vi.mock("@/src/server/runners/runner-heartbeat", () => ({
  confirmCloudRunnerReadiness: mocks.confirmCloudRunnerReadiness,
  recordRunnerHeartbeat: mocks.recordRunnerHeartbeat,
  RunnerHeartbeatPersistenceError: mocks.RunnerHeartbeatPersistenceError,
}));

describe("POST /runner/v1/heartbeat route", () => {
  afterEach(() => {
    mocks.confirmCloudRunnerReadiness.mockReset();
    mocks.recordRunnerHeartbeat.mockReset();
    vi.restoreAllMocks();
  });

  it("returns safe JSON for accepted authenticated heartbeats", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const scheduleReconciliations = vi.fn();

    mocks.recordRunnerHeartbeat.mockResolvedValueOnce({
      ok: true,
      runner: {
        id: "00000000-0000-4000-8000-000000000130",
        status: "online",
        observedAt: "2026-07-05T08:00:00.000Z",
      },
    });
    mocks.confirmCloudRunnerReadiness.mockResolvedValueOnce({
      outcome: "pending",
      reason: "network_error",
    });
    const { POST } = await import("@/app/runner/v1/heartbeat/route");

    const response = await POST(
      new Request("http://localhost/runner/v1/heartbeat", {
        method: "POST",
        headers: { authorization: "Bearer agb_run_secret" },
        body: JSON.stringify({ runnerId: "00000000-0000-4000-8000-000000000130" }),
      }),
      undefined,
      { scheduleReconciliations },
    );
    const body = await response.json();
    const ingressLogs = infoSpy.mock.calls
      .filter(([scope]) => scope === "[agentbay] runner.ingress")
      .map(([, payload]) => payload);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      runner: {
        id: "00000000-0000-4000-8000-000000000130",
        status: "online",
        observedAt: "2026-07-05T08:00:00.000Z",
      },
    });
    expect(mocks.recordRunnerHeartbeat).toHaveBeenCalledWith({
      authorizationHeader: "Bearer agb_run_secret",
      payload: { runnerId: "00000000-0000-4000-8000-000000000130" },
    });
    expect(mocks.confirmCloudRunnerReadiness).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000130",
    );
    expect(scheduleReconciliations).toHaveBeenCalledOnce();
    expect(scheduleReconciliations).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000130");
    expect(ingressLogs).toContainEqual(
      expect.objectContaining({
        endpoint: "heartbeat",
        event: "request_received",
        runnerId: "00000000-0000-4000-8000-000000000130",
      }),
    );
    expect(ingressLogs).toContainEqual(
      expect.objectContaining({
        endpoint: "heartbeat",
        event: "readiness_probe_completed",
        runnerId: "00000000-0000-4000-8000-000000000130",
        outcome: "pending",
        reason: "network_error",
      }),
    );
    expect(ingressLogs).toContainEqual(
      expect.objectContaining({
        endpoint: "heartbeat",
        event: "heartbeat_recorded",
        runnerId: "00000000-0000-4000-8000-000000000130",
        runnerStatus: "online",
        observedAt: "2026-07-05T08:00:00.000Z",
      }),
    );
    expect(JSON.stringify(body)).not.toContain("agb_run_secret");
    expect(JSON.stringify(ingressLogs)).not.toContain("agb_run_secret");
  });

  it.each([
    ["missing_credential", 401, "runner_unauthorized"],
    ["malformed_credential", 401, "runner_unauthorized"],
    ["invalid_credential", 401, "runner_unauthorized"],
    ["wrong_runner", 403, "runner_forbidden"],
  ])("maps %s failures to safe responses", async (reason, status, code) => {
    mocks.recordRunnerHeartbeat.mockResolvedValueOnce({ ok: false, reason });
    const { POST } = await import("@/app/runner/v1/heartbeat/route");

    const response = await POST(
      new Request("http://localhost/runner/v1/heartbeat", {
        method: "POST",
        headers: { authorization: "Bearer agb_run_secret" },
        body: JSON.stringify({ runnerId: "00000000-0000-4000-8000-000000000130" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body.error.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain("agb_run_secret");
  });

  it.each([
    ["missing authorization", undefined],
    ["malformed authorization", "Basic agb_run_secret"],
  ])("returns safe 401 before parsing malformed JSON with %s", async (_label, authorization) => {
    const { POST } = await import("@/app/runner/v1/heartbeat/route");

    const response = await POST(
      new Request("http://localhost/runner/v1/heartbeat", {
        method: "POST",
        ...(authorization ? { headers: { authorization } } : {}),
        body: "{",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: {
        code: "runner_unauthorized",
        message: "Runner credentials are invalid.",
      },
    });
    expect(mocks.recordRunnerHeartbeat).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("agb_run_secret");
  });

  it("returns validation JSON for malformed request bodies", async () => {
    const { POST } = await import("@/app/runner/v1/heartbeat/route");

    const response = await POST(
      new Request("http://localhost/runner/v1/heartbeat", {
        method: "POST",
        headers: { authorization: "Bearer agb_run_secret" },
        body: "{",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "validation_failed",
        message: "Request validation failed.",
        issues: [{ field: "body", message: "Request body must be valid JSON." }],
      },
    });
    expect(mocks.recordRunnerHeartbeat).not.toHaveBeenCalled();
  });

  it("returns a safe persistence error response", async () => {
    mocks.recordRunnerHeartbeat.mockRejectedValueOnce(new mocks.RunnerHeartbeatPersistenceError());
    const { POST } = await import("@/app/runner/v1/heartbeat/route");

    const response = await POST(
      new Request("http://localhost/runner/v1/heartbeat", {
        method: "POST",
        headers: { authorization: "Bearer agb_run_secret" },
        body: JSON.stringify({ runnerId: "00000000-0000-4000-8000-000000000130" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "runner_heartbeat_failed",
        message: "Runner heartbeat could not be recorded.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(JSON.stringify(body)).not.toContain("agb_run_secret");
  });
});
