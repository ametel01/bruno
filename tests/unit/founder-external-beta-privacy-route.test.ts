import { describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/operator/external-beta/privacy/route";

const USER_ID = "00000000-0000-4000-8000-000000003799";
const NOW = new Date("2026-08-23T00:00:00.000Z");

describe("External Beta privacy route", () => {
  it("returns the private-by-default no-store projection", async () => {
    const response = await GET(
      new Request("http://localhost/api/operator/external-beta/privacy"),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true as const, userId: USER_ID }),
        getStatus: async () => ({ state: "unavailable" as const }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ privacy: { state: "unavailable" } });
  });

  it("keeps every consent purpose separate and rejects unrestricted request properties", async () => {
    const decideConsent = vi.fn(async () => undefined);
    const getStatus = vi.fn(async () => ({ state: "unavailable" as const }));
    const accepted = await POST(
      request({ action: "decide_consent", purpose: "recording", decision: "refuse" }),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true as const, userId: USER_ID }),
        decideConsent,
        getStatus,
        now: () => NOW,
      },
    );
    expect(accepted.status).toBe(200);
    expect(decideConsent).toHaveBeenCalledWith(USER_ID, {
      purpose: "recording",
      decision: "refuse",
      decidedAt: NOW,
    });

    const rejected = await POST(
      request({
        action: "decide_consent",
        purpose: "recording",
        decision: "grant",
        metadata: { messageBody: "private" },
      }),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true as const, userId: USER_ID }),
        decideConsent,
        getStatus,
      },
    );
    expect(rejected.status).toBe(400);
    expect(decideConsent).toHaveBeenCalledTimes(1);
  });

  it("keeps measurement capture off the participant-facing endpoint", async () => {
    const response = await POST(
      request({
        action: "capture_measurement",
        measurement: { event: "safe_failure_observed", safeFailureCategory: "support_required" },
      }),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true as const, userId: USER_ID }),
        now: () => NOW,
      },
    );
    expect(response.status).toBe(400);
  });

  it("preserves explicit export and deletion controls", async () => {
    const exportData = vi.fn(async () => ({
      schemaVersion: "bruno.external-beta-privacy-export.v1" as const,
      evidenceClassification: "product_hardening" as const,
      consent: [],
      measurements: [],
      recordings: [],
    }));
    const deleteMeasurements = vi.fn(async () => ({ deleted: 2 }));
    const dependencies = {
      requireApplicationUser: async () => ({ ok: true as const, userId: USER_ID }),
      exportData,
      deleteMeasurements,
    };
    const exported = await POST(request({ action: "export" }), undefined, dependencies);
    expect(exported.status).toBe(200);
    await expect(exported.json()).resolves.toMatchObject({
      privacyExport: { evidenceClassification: "product_hardening" },
    });
    const deleted = await POST(request({ action: "delete_measurements" }), undefined, dependencies);
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ deleted: { deleted: 2 } });
  });
});

function request(body: unknown): Request {
  return new Request("http://localhost/api/operator/external-beta/privacy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
