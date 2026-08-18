import { describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/operator/limited-operation/route";

const USER_ID = "00000000-0000-4000-8000-000000003420";
const OPERATION = {
  name: "Calendar-only Limited Operation" as const,
  status: "awaiting_consent" as const,
  mailIncluded: false as const,
  access: { ai: "ready" as const, calendar: "ready" as const, evidence: "current" as const },
  consent: {
    status: "missing" as const,
    purpose: "calendar_morning_brief" as const,
    confirmedAt: null,
  },
  authorityPolicy: null,
  brief: null,
  activatedAt: null,
};

describe("Founder Limited Operation route", () => {
  it("returns a no-store operation summary", async () => {
    const response = await GET(
      new Request("http://localhost/api/operator/limited-operation"),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true as const, userId: USER_ID }),
        getOperation: async () => OPERATION,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ operation: OPERATION });
  });

  it("routes consent and brief opening as separate explicit actions", async () => {
    const confirmConsent = vi.fn(async () => ({ ...OPERATION, status: "limited" as const }));
    const openBrief = vi.fn(async () => ({
      ...OPERATION,
      status: "limited" as const,
      activatedAt: "2026-08-19T01:00:00.000Z",
    }));
    const dependencies = {
      requireApplicationUser: async () => ({ ok: true as const, userId: USER_ID }),
      confirmConsent,
      openBrief,
    };
    await POST(
      new Request("http://localhost/api/operator/limited-operation", {
        method: "POST",
        body: JSON.stringify({ action: "confirm_consent" }),
      }),
      undefined,
      dependencies,
    );
    await POST(
      new Request("http://localhost/api/operator/limited-operation", {
        method: "POST",
        body: JSON.stringify({ action: "open_brief" }),
      }),
      undefined,
      dependencies,
    );
    expect(confirmConsent).toHaveBeenCalledWith(USER_ID);
    expect(openBrief).toHaveBeenCalledWith(USER_ID);
  });

  it("rejects an unsupported action", async () => {
    const response = await POST(
      new Request("http://localhost/api/operator/limited-operation", {
        method: "POST",
        body: JSON.stringify({ action: "delete" }),
      }),
      undefined,
      { requireApplicationUser: async () => ({ ok: true as const, userId: USER_ID }) },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
  });
});
