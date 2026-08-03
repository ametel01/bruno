import { describe, expect, it, vi } from "vitest";
import * as cronRoute from "@/app/api/internal/agent-deployments/reconcile/route";
import { GET } from "@/app/api/internal/agent-deployments/reconcile/route";

const SECRET = "abcdefghijklmnopqrstuvwxyzABCDEF012345";

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

  it("processes at most one item and returns only the safe summary", async () => {
    const reconcile = vi.fn(async () => ({
      processed: 1 as const,
      outcome: "advanced" as const,
    }));
    const response = await GET(
      new Request("http://localhost/api/internal/agent-deployments/reconcile", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      undefined,
      { readConfig: () => ({ ok: true, secret: SECRET }), reconcile },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, processed: 1, outcome: "advanced" });
    expect(reconcile).toHaveBeenCalledOnce();
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
