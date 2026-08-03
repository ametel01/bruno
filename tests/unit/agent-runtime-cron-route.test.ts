import { describe, expect, it, vi } from "vitest";
import * as cronRoute from "@/app/api/internal/agent-runtime/reconcile/route";
import { GET } from "@/app/api/internal/agent-runtime/reconcile/route";

const SECRET = "abcdefghijklmnopqrstuvwxyzABCDEF012345";
const URL = "http://localhost/api/internal/agent-runtime/reconcile";

describe("GET /api/internal/agent-runtime/reconcile", () => {
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
    expect(await unauthorized.json()).toEqual({
      error: { code: "cron_unauthorized", message: "Cron authorization is invalid." },
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each([
    [0, "idle"],
    [1, "observed"],
    [1, "recovering"],
    [1, "stopped"],
    [1, "circuit_open"],
  ] as const)("returns only the exact one-row summary %s/%s", async (processed, outcome) => {
    const reconcile = vi.fn(async () => ({ processed, outcome }));
    const response = await GET(
      new Request(URL, { headers: { authorization: `Bearer ${SECRET}` } }),
      undefined,
      { readConfig: () => ({ ok: true, secret: SECRET }), reconcile },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, processed, outcome });
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("rejects body/query controls and redacts reconcile failures", async () => {
    const query = await GET(
      new Request(`${URL}?agentId=private`, {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      undefined,
      { readConfig: () => ({ ok: true, secret: SECRET }), reconcile: vi.fn() },
    );
    expect(query.status).toBe(400);

    const body = await GET(
      {
        url: URL,
        headers: new Headers({ authorization: `Bearer ${SECRET}` }),
        body: new ReadableStream(),
      } as Request,
      undefined,
      { readConfig: () => ({ ok: true, secret: SECRET }), reconcile: vi.fn() },
    );
    expect(body.status).toBe(400);

    const failed = await GET(
      new Request(URL, { headers: { authorization: `Bearer ${SECRET}` } }),
      undefined,
      {
        readConfig: () => ({ ok: true, secret: SECRET }),
        reconcile: async () => {
          throw new Error("private-runtime-evidence");
        },
      },
    );
    const payload = await failed.json();
    expect(failed.status).toBe(500);
    expect(payload).toEqual({
      error: { code: "cron_reconcile_failed", message: "Cron reconciliation failed safely." },
    });
    expect(JSON.stringify(payload)).not.toContain("private-runtime-evidence");
  });
});
