import { describe, expect, it, vi } from "vitest";

describe("Founder Recovery Archive cron route", () => {
  it("authorizes a bodyless run and returns only sanitized counts", async () => {
    const { GET } = await import("@/app/api/internal/operator/recovery-archives/route");
    const reconcile = vi.fn().mockResolvedValue({
      eligible: 3,
      created: 1,
      failed: 0,
      deleted: 2,
    });
    const provider = {} as never;
    const applicationRevision = "b".repeat(40);

    const response = await GET(
      new Request("http://localhost/api/internal/operator/recovery-archives", {
        headers: { authorization: "Bearer cron-secret" },
      }),
      undefined,
      {
        readCron: () => ({ ok: true, secret: "cron-secret" }),
        authorize: () => true,
        createProvider: () => provider,
        readApplicationRevision: () => applicationRevision,
        reconcile,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      eligible: 3,
      created: 1,
      failed: 0,
      deleted: 2,
    });
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ applicationRevision, provider }),
    );
  });

  it("fails closed for missing authority, provider configuration, and request controls", async () => {
    const { GET } = await import("@/app/api/internal/operator/recovery-archives/route");
    const base = new Request("http://localhost/api/internal/operator/recovery-archives");

    await expect(
      GET(base, undefined, {
        readCron: () => ({ ok: false, reason: "cron_configuration_invalid" }),
      }),
    ).resolves.toMatchObject({ status: 503 });
    await expect(
      GET(base, undefined, {
        readCron: () => ({ ok: true, secret: "cron-secret" }),
        authorize: () => false,
      }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      GET(base, undefined, {
        readCron: () => ({ ok: true, secret: "cron-secret" }),
        authorize: () => true,
        readApplicationRevision: () => null,
      }),
    ).resolves.toMatchObject({ status: 503 });
    await expect(
      GET(base, undefined, {
        readCron: () => ({ ok: true, secret: "cron-secret" }),
        authorize: () => true,
        createProvider: () => null,
        readApplicationRevision: () => "b".repeat(40),
      }),
    ).resolves.toMatchObject({ status: 503 });
    await expect(
      GET(
        new Request("http://localhost/api/internal/operator/recovery-archives?force=true"),
        undefined,
        {
          readCron: () => ({ ok: true, secret: "cron-secret" }),
          authorize: () => true,
          createProvider: () => ({}) as never,
        },
      ),
    ).resolves.toMatchObject({ status: 400 });
  });
});
