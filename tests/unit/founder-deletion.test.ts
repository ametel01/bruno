import { describe, expect, it, vi } from "vitest";
import {
  FOUNDER_ACTIVE_PURGE_WINDOW_MS,
  FOUNDER_BACKUP_EXPIRY_WINDOW_MS,
  FOUNDER_REVOCATION_RETRY_MS,
} from "@/src/server/operators/founder-deletion";

describe("Founder deletion schedule", () => {
  it("keeps the active purge and backup expiry windows explicit", () => {
    expect(FOUNDER_ACTIVE_PURGE_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(FOUNDER_BACKUP_EXPIRY_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(FOUNDER_REVOCATION_RETRY_MS).toBe(60 * 60 * 1000);
  });
});

describe("Founder deletion cron route", () => {
  it("fails closed before processing when the cron secret is invalid or unauthorized", async () => {
    const { GET } = await import("@/app/api/internal/operator/deletion/route");
    const process = vi.fn();
    const invalid = await GET(
      new Request("http://localhost/api/internal/operator/deletion"),
      undefined,
      {
        readCron: () => ({ ok: false as const, reason: "cron_configuration_invalid" as const }),
        process,
      },
    );
    expect(invalid.status).toBe(503);
    const unauthorized = await GET(
      new Request("http://localhost/api/internal/operator/deletion"),
      undefined,
      {
        readCron: () => ({ ok: true as const, secret: "secret" }),
        authorize: () => false,
        process,
      },
    );
    expect(unauthorized.status).toBe(401);
    expect(process).not.toHaveBeenCalled();
  });

  it("returns processed and failed owner counts", async () => {
    const { GET } = await import("@/app/api/internal/operator/deletion/route");
    const response = await GET(
      new Request("http://localhost/api/internal/operator/deletion"),
      undefined,
      {
        readCron: () => ({ ok: true as const, secret: "secret" }),
        authorize: () => true,
        process: async () => ({ processed: 2, failed: 1 }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, processed: 2, failed: 1 });
  });
});
