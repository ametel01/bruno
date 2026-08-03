import { describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/agents/[agentId]/deployment/retry/route";

const USER_ID = "00000000-0000-4000-8000-000000000781";
const AGENT_ID = "00000000-0000-4000-8000-000000000782";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000783";
const DEPLOYMENT = {
  id: DEPLOYMENT_ID,
  agentId: AGENT_ID,
  stage: "pending" as const,
  configRevision: "cfg-1784000000000",
  attemptCount: 0,
  error: null,
  nextAttemptAt: null,
  startedAt: null,
  completedAt: null,
  failedAt: null,
  createdAt: "2026-08-03T08:00:00.000Z",
  updatedAt: "2026-08-03T08:00:00.000Z",
};

describe("POST /api/agents/:agentId/deployment/retry", () => {
  it("returns the exact deployment body and schedules only after persistence commits", async () => {
    const schedule = vi.fn();
    const retryDeployment = vi.fn(async (input) => {
      input.dependencies?.onDeploymentCommitted?.(DEPLOYMENT_ID);
      return { ok: true as const, deployment: DEPLOYMENT };
    });
    const response = await POST(
      retryRequest({ idempotencyKey: "Retry-Key-001" }),
      { params: Promise.resolve({ agentId: AGENT_ID }) },
      {
        requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
        retryDeployment,
        scheduleDeploymentReconcile: schedule,
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ deployment: DEPLOYMENT });
    expect(retryDeployment).toHaveBeenCalledWith({
      userId: USER_ID,
      agentId: AGENT_ID,
      idempotencyKey: "Retry-Key-001",
      dependencies: { onDeploymentCommitted: schedule },
    });
    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith(DEPLOYMENT_ID);
  });

  it.each([
    [null],
    [{}],
    [{ idempotencyKey: "Retry-Key-001", extra: true }],
    [{ idempotencyKey: 42 }],
  ])("rejects malformed exact-body input %#", async (body) => {
    const retryDeployment = vi.fn();
    const response = await POST(
      retryRequest(body),
      { params: Promise.resolve({ agentId: AGENT_ID }) },
      {
        requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
        retryDeployment,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "validation_failed", message: "Request validation failed." },
    });
    expect(retryDeployment).not.toHaveBeenCalled();
  });

  it.each([
    ["agent_not_found", 404, "agent_not_found"],
    ["deployment_not_retryable", 409, "deployment_not_retryable"],
    ["persistence_failed", 500, "deployment_retry_failed"],
  ] as const)("maps %s to a fixed owner-safe response", async (reason, status, code) => {
    const response = await POST(
      retryRequest({ idempotencyKey: "Retry-Key-001" }),
      { params: Promise.resolve({ agentId: AGENT_ID }) },
      {
        requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
        retryDeployment: async () => ({ ok: false, reason }),
        scheduleDeploymentReconcile: vi.fn(),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body.error.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain("Retry-Key-001");
    expect(JSON.stringify(body)).not.toContain(AGENT_ID);
  });

  it("rejects malformed path IDs without touching persistence", async () => {
    const retryDeployment = vi.fn();
    const response = await POST(
      retryRequest({ idempotencyKey: "Retry-Key-001" }),
      { params: Promise.resolve({ agentId: "not-a-uuid" }) },
      {
        requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
        retryDeployment,
      },
    );

    expect(response.status).toBe(400);
    expect(retryDeployment).not.toHaveBeenCalled();
  });
});

function retryRequest(body: unknown): Request {
  return new Request(`http://localhost/api/agents/${AGENT_ID}/deployment/retry`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
