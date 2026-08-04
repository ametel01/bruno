import { describe, expect, it, vi } from "vitest";
import * as cronRoute from "@/app/api/internal/runner-infrastructure/reconcile/route";
import { GET } from "@/app/api/internal/runner-infrastructure/reconcile/route";

const SECRET = "abcdefghijklmnopqrstuvwxyzABCDEF012345";
const URL = "http://localhost/api/internal/runner-infrastructure/reconcile";

describe("GET /api/internal/runner-infrastructure/reconcile", () => {
  it("exports only GET and fails closed before reconciliation", async () => {
    expect("POST" in cronRoute).toBe(false);
    expect("PUT" in cronRoute).toBe(false);
    expect("DELETE" in cronRoute).toBe(false);

    const reconcile = vi.fn();
    const unconfigured = await GET(new Request(URL), undefined, {
      readConfig: () => ({ ok: false, reason: "cron_configuration_invalid" }),
      reconcile,
    });
    expect(unconfigured.status).toBe(503);

    const unauthorized = await GET(new Request(URL), undefined, {
      readConfig: () => ({ ok: true, secret: SECRET }),
      reconcile,
    });
    expect(unauthorized.status).toBe(401);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each([
    [0, "idle"],
    [1, "exact_match"],
    [1, "replacement_started"],
    [1, "orphan_observed"],
    [1, "ambiguous_resource"],
  ] as const)("returns only the bounded summary %s/%s", async (processed, outcome) => {
    const response = await GET(
      new Request(URL, { headers: { authorization: `Bearer ${SECRET}` } }),
      undefined,
      {
        readConfig: () => ({ ok: true, secret: SECRET }),
        reconcile: async () => ({ processed, outcome }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json();
    expect(payload).toEqual({ ok: true, processed, outcome });
    expect(JSON.stringify(payload)).not.toMatch(/droplet|providerResource|firewall|lease|token/i);
  });

  it("rejects controls and redacts reconciliation failures", async () => {
    const query = await GET(
      new Request(`${URL}?runnerId=private`, {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      undefined,
      { readConfig: () => ({ ok: true, secret: SECRET }), reconcile: vi.fn() },
    );
    expect(query.status).toBe(400);

    const failed = await GET(
      new Request(URL, { headers: { authorization: `Bearer ${SECRET}` } }),
      undefined,
      {
        readConfig: () => ({ ok: true, secret: SECRET }),
        reconcile: async () => {
          throw new Error("private-provider-token-and-droplet-id");
        },
      },
    );
    const payload = await failed.json();
    expect(failed.status).toBe(500);
    expect(payload).toEqual({
      error: { code: "cron_reconcile_failed", message: "Cron reconciliation failed safely." },
    });
    expect(JSON.stringify(payload)).not.toContain("private-provider");
  });

  it("halts before reconciliation when the release rollout batch is zero", async () => {
    const reconcile = vi.fn();
    const response = await GET(
      new Request(URL, { headers: { authorization: `Bearer ${SECRET}` } }),
      undefined,
      {
        readConfig: () => ({ ok: true, secret: SECRET }),
        readRolloutBatchSize: () => 0,
        reconcile,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, processed: 0, outcome: "rollout_halted" });
    expect(reconcile).not.toHaveBeenCalled();
  });
});
