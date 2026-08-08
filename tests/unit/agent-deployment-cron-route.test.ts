import { describe, expect, it, vi } from "vitest";
import * as cronRoute from "@/app/api/internal/agent-deployments/reconcile/route";
import { GET } from "@/app/api/internal/agent-deployments/reconcile/route";

const SECRET = "abcdefghijklmnopqrstuvwxyzABCDEF012345";
const QSTASH_CONFIG = {
  ok: true,
  mode: "qstash",
  token: "qstash_token_abcdefghijklmnopqrstuvwxyz012345",
  currentSigningKey: "current_signing_key_abcdefghijklmnopqrstuvwxyz012345",
  nextSigningKey: "next_signing_key_abcdefghijklmnopqrstuvwxyz012345",
  callbackBaseUrl: "https://app.example.test",
  maxPublishAttempts: 12,
} as const;

describe("GET /api/internal/agent-deployments/reconcile", () => {
  it("exports only the protected GET handler", () => {
    expect("POST" in cronRoute).toBe(false);
    expect("PUT" in cronRoute).toBe(false);
    expect("DELETE" in cronRoute).toBe(false);
  });

  it("fails closed for missing server configuration before credential handling", async () => {
    const reconcile = vi.fn();
    const response = await GET(
      new Request("http://localhost/api/internal/agent-deployments/reconcile"),
      undefined,
      {
        readConfig: () => ({ ok: false, reason: "cron_configuration_invalid" }),
        reconcile,
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "cron_configuration_invalid",
        message: "Cron is not configured safely.",
      },
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    `Basic ${SECRET}`,
    `Bearer ${SECRET.slice(0, -1)}x`,
  ])("returns one fixed unauthorized response for credential %s", async (authorization) => {
    const reconcile = vi.fn();
    const response = await GET(
      new Request("http://localhost/api/internal/agent-deployments/reconcile", {
        ...(authorization ? { headers: { authorization } } : {}),
      }),
      undefined,
      { readConfig: () => ({ ok: true, secret: SECRET }), reconcile },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "cron_unauthorized", message: "Cron authorization is invalid." },
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("recovers a backlog but stops after 25 items", async () => {
    const calls: string[] = [];
    const sweepWakeups = vi.fn(async () => {
      calls.push("sweep");
      return { published: 1 };
    });
    const reconcile = vi.fn(async () => {
      calls.push("reconcile");
      return {
        processed: 1 as const,
        outcome: "advanced" as const,
      };
    });
    const response = await GET(
      new Request("http://localhost/api/internal/agent-deployments/reconcile", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      undefined,
      {
        readConfig: () => ({ ok: true, secret: SECRET }),
        readDispatchConfig: () => ({ ok: true, mode: "cron" }),
        reconcile,
        sweepWakeups,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, processed: 25, outcome: "advanced" });
    expect(sweepWakeups).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledTimes(25);
    expect(calls).toEqual([...Array.from({ length: 25 }, () => "reconcile"), "sweep"]);
  });

  it("counts a QStash sweep inside the 25-item bound", async () => {
    const sweepWakeups = vi.fn(async () => ({ published: 1 }));
    const reconcile = vi.fn(async () => ({
      processed: 1 as const,
      outcome: "advanced" as const,
    }));

    const response = await GET(
      new Request("http://localhost/api/internal/agent-deployments/reconcile", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      undefined,
      {
        readConfig: () => ({ ok: true, secret: SECRET }),
        readDispatchConfig: () => QSTASH_CONFIG,
        reconcile,
        sweepWakeups,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, processed: 24, outcome: "advanced" });
    expect(reconcile).toHaveBeenCalledTimes(24);
    expect(sweepWakeups).toHaveBeenCalledOnce();
  });

  it("stops recovery at the shared 40-second deadline", async () => {
    const startedAt = new Date("2026-08-09T00:00:00.000Z");
    let current = startedAt;
    const reconcile = vi.fn(async () => {
      current = new Date(startedAt.getTime() + 40_000);
      return { processed: 1 as const, outcome: "retry_scheduled" as const };
    });
    const sweepWakeups = vi.fn(async () => ({ published: 0 }));

    const response = await GET(
      new Request("http://localhost/api/internal/agent-deployments/reconcile", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      undefined,
      {
        readConfig: () => ({ ok: true, secret: SECRET }),
        sweepWakeups,
        reconcile,
        now: () => current,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      processed: 1,
      outcome: "retry_scheduled",
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        deadlineAt: new Date(startedAt.getTime() + 40_000),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(sweepWakeups).not.toHaveBeenCalled();
  });

  it("continues bounded PostgreSQL recovery when QStash is unavailable", async () => {
    const sweepWakeups = vi.fn(async () => ({ published: 0 }));
    const reconcile = vi
      .fn()
      .mockResolvedValueOnce({ processed: 1 as const, outcome: "advanced" as const })
      .mockResolvedValueOnce({ processed: 0 as const, outcome: "idle" as const });

    const response = await GET(
      new Request("http://localhost/api/internal/agent-deployments/reconcile", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      undefined,
      {
        readConfig: () => ({ ok: true, secret: SECRET }),
        sweepWakeups,
        reconcile,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, processed: 1, outcome: "advanced" });
    expect(sweepWakeups).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("rejects query controls and contains dependency errors without IDs or detail", async () => {
    const queryReconcile = vi.fn();
    const queryResponse = await GET(
      new Request(
        "http://localhost/api/internal/agent-deployments/reconcile?deploymentId=private",
        {
          headers: { authorization: `Bearer ${SECRET}` },
        },
      ),
      undefined,
      { readConfig: () => ({ ok: true, secret: SECRET }), reconcile: queryReconcile },
    );
    expect(queryResponse.status).toBe(400);
    expect(await queryResponse.json()).toEqual({
      error: {
        code: "cron_request_invalid",
        message: "Cron request controls are not accepted.",
      },
    });
    expect(queryReconcile).not.toHaveBeenCalled();

    const bodyReconcile = vi.fn();
    const bodyResponse = await GET(
      {
        url: "http://localhost/api/internal/agent-deployments/reconcile",
        headers: new Headers({ authorization: `Bearer ${SECRET}` }),
        body: new ReadableStream(),
      } as Request,
      undefined,
      { readConfig: () => ({ ok: true, secret: SECRET }), reconcile: bodyReconcile },
    );
    expect(bodyResponse.status).toBe(400);
    expect(bodyReconcile).not.toHaveBeenCalled();

    const failedResponse = await GET(
      new Request("http://localhost/api/internal/agent-deployments/reconcile", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      undefined,
      {
        readConfig: () => ({ ok: true, secret: SECRET }),
        reconcile: async () => {
          throw new Error("private-id-and-secret");
        },
      },
    );
    const failedBody = await failedResponse.json();
    expect(failedResponse.status).toBe(500);
    expect(failedBody).toEqual({
      error: { code: "cron_reconcile_failed", message: "Cron reconciliation failed safely." },
    });
    expect(JSON.stringify(failedBody)).not.toContain("private-id-and-secret");
  });
});
