import { describe, expect, it, vi } from "vitest";

describe("Founder Recovery Archive expiry route", () => {
  it("requires cron authorization and rejects caller controls", async () => {
    const { GET } = await import(
      "@/app/api/internal/operator/founder-recovery-archive-expiry/route"
    );
    const process = vi.fn().mockResolvedValue({ processedUsers: 1, failedUsers: 0 });
    const readCron = () => ({ ok: true as const, secret: "cron-secret" });
    const authorize = ({ authorizationHeader }: { authorizationHeader: string | null }) =>
      authorizationHeader === "Bearer cron-secret";

    const unauthorized = await GET(
      new Request("http://localhost/api/internal/operator/founder-recovery-archive-expiry"),
      undefined,
      { readCron, authorize, process },
    );
    expect(unauthorized.status).toBe(401);
    expect(process).not.toHaveBeenCalled();

    const controlled = await GET(
      new Request(
        "http://localhost/api/internal/operator/founder-recovery-archive-expiry?now=tomorrow",
        { headers: { authorization: "Bearer cron-secret" } },
      ),
      undefined,
      { readCron, authorize, process },
    );
    expect(controlled.status).toBe(400);
    expect(process).not.toHaveBeenCalled();

    const allowed = await GET(
      new Request("http://localhost/api/internal/operator/founder-recovery-archive-expiry", {
        headers: { authorization: "Bearer cron-secret" },
      }),
      undefined,
      { readCron, authorize, process },
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    await expect(allowed.json()).resolves.toEqual({
      ok: true,
      processedUsers: 1,
      failedUsers: 0,
    });
  });
});
