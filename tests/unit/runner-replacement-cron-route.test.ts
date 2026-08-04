import { describe, expect, it, vi } from "vitest";
import * as cronRoute from "@/app/api/internal/runner-replacements/reconcile/route";
import { GET } from "@/app/api/internal/runner-replacements/reconcile/route";

const SECRET = "abcdefghijklmnopqrstuvwxyzABCDEF012345";

describe("GET /api/internal/runner-replacements/reconcile", () => {
  it("exports only the protected GET handler", () => {
    expect("POST" in cronRoute).toBe(false);
    expect("PUT" in cronRoute).toBe(false);
    expect("DELETE" in cronRoute).toBe(false);
  });

  it("fails closed before reconciliation when configuration or credentials are invalid", async () => {
    const reconcile = vi.fn();
    const unconfigured = await GET(
      new Request("http://localhost/api/internal/runner-replacements/reconcile"),
      undefined,
      {
        readConfig: () => ({ ok: false, reason: "cron_configuration_invalid" }),
        reconcile,
      },
    );
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({
      error: {
        code: "cron_configuration_invalid",
        message: "Cron is not configured safely.",
      },
    });

    const unauthorized = await GET(
      new Request("http://localhost/api/internal/runner-replacements/reconcile", {
        headers: { authorization: `Bearer ${SECRET.slice(0, -1)}x` },
      }),
      undefined,
      { readConfig: () => ({ ok: true, secret: SECRET }), reconcile },
    );
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({
      error: { code: "cron_unauthorized", message: "Cron authorization is invalid." },
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each([
    ["idle", undefined, 0],
    ["advanced", "provisioning_target", 1],
    ["retry_scheduled", "waiting_for_target", 1],
    ["failed", "failed", 1],
  ])("returns a safe %s summary for one bounded item", async (outcome, state, processed) => {
    const reconcile = vi.fn(async () => ({
      outcome,
      ...(state ? { state } : {}),
      replacementId: "private-replacement-id",
      sourceRunnerId: "private-runner-id",
    }));
    const response = await GET(
      new Request("http://localhost/api/internal/runner-replacements/reconcile", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      undefined,
      { readConfig: () => ({ ok: true, secret: SECRET }), reconcile },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      ok: true,
      processed,
      outcome,
      ...(state ? { state } : {}),
    });
    expect(JSON.stringify(body)).not.toMatch(/private|replacementId|runnerId/);
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("rejects request controls and redacts reconciliation failures", async () => {
    const controlled = await GET(
      new Request(
        "http://localhost/api/internal/runner-replacements/reconcile?replacementId=private",
        { headers: { authorization: `Bearer ${SECRET}` } },
      ),
      undefined,
      { readConfig: () => ({ ok: true, secret: SECRET }), reconcile: vi.fn() },
    );
    expect(controlled.status).toBe(400);
    expect(await controlled.json()).toEqual({
      error: {
        code: "cron_request_invalid",
        message: "Cron request controls are not accepted.",
      },
    });

    const failed = await GET(
      new Request("http://localhost/api/internal/runner-replacements/reconcile", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      undefined,
      {
        readConfig: () => ({ ok: true, secret: SECRET }),
        reconcile: async () => {
          throw new Error("private-replacement-detail");
        },
      },
    );
    const body = await failed.json();
    expect(failed.status).toBe(500);
    expect(body).toEqual({
      error: { code: "cron_reconcile_failed", message: "Cron reconciliation failed safely." },
    });
    expect(JSON.stringify(body)).not.toContain("private-replacement-detail");
  });
});
