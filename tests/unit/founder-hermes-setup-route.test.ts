import { describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/operator/troubleshooting/hermes-setup-session/route";
import type { DatabaseConnection } from "@/src/server/db/client";

const USER_ID = "00000000-0000-4000-8000-000000003611";
const OPERATOR_ID = "00000000-0000-4000-8000-000000003612";

describe("Founder Full Hermes Setup route", () => {
  it("requires recent authentication and a desktop viewport before touching the operator", async () => {
    const getOperator = vi.fn();
    const request = new Request(
      "http://localhost/api/operator/troubleshooting/hermes-setup-session",
      {
        method: "POST",
        headers: { "x-bruno-viewport-width": "1280" },
      },
    );

    const unauthenticated = await POST(request, undefined, {
      createConnection: () => ({}) as DatabaseConnection,
      requireApplicationUser: async () => ({ ok: false, status: 401, code: "unauthenticated" }),
      requireRecentAuth: async () => true,
      getOperator,
    });
    expect(unauthenticated.status).toBe(401);
    expect(getOperator).not.toHaveBeenCalled();

    const stale = await POST(request, undefined, {
      createConnection: () => ({}) as DatabaseConnection,
      requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
      requireRecentAuth: async () => false,
      getOperator,
    });
    expect(stale.status).toBe(401);
    expect(getOperator).not.toHaveBeenCalled();

    const mobile = await POST(
      new Request(request, {
        headers: {
          "sec-ch-ua-mobile": "?1",
          "x-bruno-viewport-width": "1280",
        },
      }),
      undefined,
      {
        createConnection: () => ({}) as DatabaseConnection,
        requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
        requireRecentAuth: async () => true,
        getOperator,
      },
    );
    expect(mobile.status).toBe(400);
    await expect(mobile.json()).resolves.toMatchObject({
      error: { code: "desktop_viewport_required" },
    });
    expect(getOperator).not.toHaveBeenCalled();

    const narrow = await POST(
      new Request(request, { headers: { "x-bruno-viewport-width": "390" } }),
      undefined,
      {
        createConnection: () => ({}) as DatabaseConnection,
        requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
        requireRecentAuth: async () => true,
        getOperator,
      },
    );
    expect(narrow.status).toBe(400);
  });

  it("opens a runner session only for a ready, stopped Operator", async () => {
    const fetchRunner = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      expect(String(request)).toBe(
        `https://runner.example.com/runner/v1/agents/${OPERATOR_ID}/setup-sessions`,
      );
      expect(init?.headers).toMatchObject({ Authorization: "Bearer runner-secret" });
      return Response.json(
        {
          ok: true,
          session: {
            id: "00000000-0000-4000-8000-000000003613",
            websocketPath: "/runner/v1/hermes-setup-sessions/00000000-0000-4000-8000-000000003613",
            websocketProtocol: "bruno.hermes.setup.one-time-token",
            expiresAt: "2026-08-20T01:15:00.000Z",
          },
        },
        { status: 201 },
      );
    });
    const response = await POST(
      new Request("http://localhost/api/operator/troubleshooting/hermes-setup-session", {
        method: "POST",
        headers: { "x-bruno-viewport-width": "1280" },
      }),
      undefined,
      {
        createConnection: () => ({}) as DatabaseConnection,
        requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
        requireRecentAuth: async () => true,
        getTroubleshooting: async () => exhaustedTroubleshooting(),
        getOperator: async () => readyOperator(),
        getRunner: async () => runner(),
        env: { BRUNO_RUNNER_BEARER_TOKEN: "runner-secret" },
        fetch: fetchRunner as typeof fetch,
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      session: {
        id: "00000000-0000-4000-8000-000000003613",
        websocketUrl:
          "wss://runner.example.com/runner/v1/hermes-setup-sessions/00000000-0000-4000-8000-000000003613",
        websocketProtocol: "bruno.hermes.setup.one-time-token",
        expiresAt: "2026-08-20T01:15:00.000Z",
      },
    });
  });

  it("keeps direct authenticated requests behind an exhausted Troubleshooting Incident", async () => {
    const getOperator = vi.fn();
    const response = await POST(
      new Request("http://localhost/api/operator/troubleshooting/hermes-setup-session", {
        method: "POST",
        headers: { "x-bruno-viewport-width": "1280" },
      }),
      undefined,
      {
        createConnection: () => ({}) as DatabaseConnection,
        requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
        requireRecentAuth: async () => true,
        getTroubleshooting: async () => ({
          help: {
            capability: null,
            state: "recovering" as const,
            title: "Recovery in progress",
            impact: "Bruno is recovering.",
            action: null,
            technicalEvidenceAvailable: false,
            incidentId: null,
          },
          incidents: [],
        }),
        getOperator,
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "troubleshooting_required" },
    });
    expect(getOperator).not.toHaveBeenCalled();
  });

  it("maps stopped-Operator and session-collision responses without exposing runner details", async () => {
    const response = await POST(
      new Request("http://localhost/api/operator/troubleshooting/hermes-setup-session", {
        method: "POST",
        headers: { "x-bruno-viewport-width": "1280" },
      }),
      undefined,
      {
        createConnection: () => ({}) as DatabaseConnection,
        requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
        requireRecentAuth: async () => true,
        getTroubleshooting: async () => exhaustedTroubleshooting(),
        getOperator: async () => readyOperator(),
        getRunner: async () => runner(),
        env: { BRUNO_RUNNER_BEARER_TOKEN: "runner-secret" },
        fetch: async () =>
          Response.json(
            { error: { code: "agent_running", message: "container id and token=secret" } },
            { status: 409 },
          ),
      },
    );

    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).toContain("operator_running");
    expect(body).not.toContain("container");
    expect(body).not.toContain("token=");
  });
});

function readyOperator() {
  return {
    id: OPERATOR_ID,
    userId: USER_ID,
    status: "active" as const,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    preparation: {
      id: "00000000-0000-4000-8000-000000003614",
      status: "ready" as const,
      timezone: "Asia/Manila",
      timezoneConfirmedAt: "2026-08-20T00:00:00.000Z",
      startedAt: "2026-08-20T00:00:00.000Z",
      completedAt: "2026-08-20T00:01:00.000Z",
      recoveryMessage: null,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:01:00.000Z",
    },
    runtime: { status: "ready" as const, recoveryMessage: null },
  };
}

function runner() {
  return {
    id: "00000000-0000-4000-8000-000000003615",
    userId: USER_ID,
    name: "Founder runner",
    kind: "manual_vps" as const,
    endpointUrl: "https://runner.example.com",
    status: "online" as const,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    deletedAt: null,
  };
}

function exhaustedTroubleshooting() {
  return {
    help: {
      capability: "ai" as const,
      state: "recovery_exhausted" as const,
      title: "AI responses need troubleshooting",
      impact: "AI responses are paused.",
      action: null,
      technicalEvidenceAvailable: true,
      incidentId: "00000000-0000-4000-8000-000000003616",
    },
    incidents: [],
  };
}
