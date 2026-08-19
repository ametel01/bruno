import { describe, expect, it, vi } from "vitest";

describe("Founder retention route", () => {
  it("requires cron authorization and rejects request controls", async () => {
    const { GET } = await import("@/app/api/internal/operator/retention/route");
    const process = vi.fn().mockResolvedValue({ processed: 0, failed: 0, results: [] });
    const readCron = () => ({ ok: true as const, secret: "cron-secret" });
    const authorize = ({ authorizationHeader }: { authorizationHeader: string | null }) =>
      authorizationHeader === "Bearer cron-secret";

    const unauthorized = await GET(
      new Request("http://localhost/api/internal/operator/retention"),
      undefined,
      { readCron, authorize, process },
    );
    expect(unauthorized.status).toBe(401);
    expect(process).not.toHaveBeenCalled();

    const malformed = await GET(
      new Request("http://localhost/api/internal/operator/retention?run=now", {
        headers: { authorization: "Bearer cron-secret" },
      }),
      undefined,
      { readCron, authorize, process },
    );
    expect(malformed.status).toBe(400);
    expect(process).not.toHaveBeenCalled();

    const allowed = await GET(
      new Request("http://localhost/api/internal/operator/retention", {
        headers: { authorization: "Bearer cron-secret" },
      }),
      undefined,
      { readCron, authorize, process },
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    await expect(allowed.json()).resolves.toMatchObject({ ok: true, processed: 0 });
  });
});
