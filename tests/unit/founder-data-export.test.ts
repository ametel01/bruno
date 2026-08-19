import { describe, expect, it, vi } from "vitest";
import {
  buildFounderDataExportPayloadForTest,
  FOUNDER_DATA_EXPORT_TTL_MS,
  renderFounderDataExportHtml,
} from "@/src/server/operators/founder-data-export";

const OWNER_ID = "00000000-0000-4000-8000-000000003355";
const OTHER_OWNER_ID = "00000000-0000-4000-8000-000000003356";
const GENERATED_AT = new Date("2026-08-19T00:00:00.000Z");

describe("Founder Data Export payload", () => {
  it("represents an empty Founder workspace without technical records", () => {
    const payload = buildFounderDataExportPayloadForTest({
      ownerId: OWNER_ID,
      exportId: "00000000-0000-4000-8000-000000003357",
      generatedAt: GENERATED_AT,
      expiresAt: new Date(GENERATED_AT.getTime() + FOUNDER_DATA_EXPORT_TTL_MS),
    });

    expect(payload.owner.ownerId).toBe(OWNER_ID);
    expect(payload.records.relationshipEvidence).toEqual([]);
    expect(payload.decisions.proposedActions).toEqual([]);
    expect(payload.receipts.action).toEqual([]);
    expect(payload.exclusions.join(" ")).toMatch(/credentials|logs/i);
    expect(renderFounderDataExportHtml(payload)).toContain("Founder Data Export");
  });

  it("keeps a disconnected evidence pointer but never recreates source content", () => {
    const payload = buildFounderDataExportPayloadForTest({
      ownerId: OWNER_ID,
      exportId: "00000000-0000-4000-8000-000000003358",
      generatedAt: GENERATED_AT,
      expiresAt: new Date(GENERATED_AT.getTime() + FOUNDER_DATA_EXPORT_TTL_MS),
      relationshipEvidence: [
        {
          id: "evidence-disconnected",
          provider: "google_gmail",
          providerItemId: "message-1",
          providerIdentity: "provider-person-1",
          email: "person@example.com",
          displayName: "Person Example",
          company: "Example Co",
          evidenceState: "disconnected",
          excerpt: "This source excerpt must not be exported after disconnect.",
          observedAt: GENERATED_AT,
          sourceFingerprint: "sha256:disconnected",
        },
      ],
    });

    expect(payload.records.relationshipEvidence).toEqual([
      expect.objectContaining({
        sourceAvailability: "disconnected",
        contentStatus: "tombstone",
        excerpt: null,
        providerItemId: "message-1",
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain("must not be exported");
  });

  it("preserves a tombstoned pointer as content-free evidence", () => {
    const payload = buildFounderDataExportPayloadForTest({
      ownerId: OWNER_ID,
      exportId: "00000000-0000-4000-8000-000000003359",
      generatedAt: GENERATED_AT,
      expiresAt: new Date(GENERATED_AT.getTime() + FOUNDER_DATA_EXPORT_TTL_MS),
      relationshipEvidence: [
        {
          id: "evidence-tombstone",
          provider: "google_calendar",
          providerItemId: "event-1",
          providerIdentity: null,
          email: null,
          displayName: "Former meeting",
          company: null,
          evidenceState: "unavailable",
          excerpt: null,
          observedAt: GENERATED_AT,
          sourceFingerprint: "sha256:tombstone",
        },
      ],
    });

    expect(payload.records.relationshipEvidence[0]).toEqual(
      expect.objectContaining({
        sourceAvailability: "unavailable",
        contentStatus: "tombstone",
        excerpt: null,
      }),
    );
  });
});

describe("Founder Data Export routes", () => {
  it("requires recent authentication before creating an export", async () => {
    const { POST } = await import("@/app/api/operator/privacy/export/route");
    const createExport = vi.fn();
    const response = await POST(
      new Request("http://localhost/api/operator/privacy/export", { method: "POST" }),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true, userId: OWNER_ID }),
        requireRecentAuth: async () => false,
        createExport,
      },
    );

    expect(response.status).toBe(401);
    expect(createExport).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "recent_authentication_required" },
    });
  });

  it("returns both portable formats with a 24-hour expiry", async () => {
    const { POST } = await import("@/app/api/operator/privacy/export/route");
    const response = await POST(
      new Request("http://localhost/api/operator/privacy/export", { method: "POST" }),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true, userId: OWNER_ID }),
        requireRecentAuth: async () => true,
        createExport: async () => ({
          exportId: "export-1",
          token: "token-1",
          createdAt: GENERATED_AT.toISOString(),
          expiresAt: new Date(GENERATED_AT.getTime() + FOUNDER_DATA_EXPORT_TTL_MS).toISOString(),
        }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.export.expiresAfterHours).toBe(24);
    expect(body.export.downloads.json).toContain("format=json");
    expect(body.export.downloads.html).toContain("format=html");
  });

  it("returns an auditable expiry failure instead of export content", async () => {
    const { GET } = await import("@/app/api/operator/privacy/export/[token]/route");
    const response = await GET(
      new Request("http://localhost/api/operator/privacy/export/token?format=json"),
      { params: Promise.resolve({ token: "token" }) },
      {
        requireApplicationUser: async () => ({ ok: true, userId: OWNER_ID }),
        requireRecentAuth: async () => true,
        downloadExport: async () => ({ ok: false, code: "export_expired", status: 410 }),
      },
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "export_expired" },
    });
  });

  it("does not disclose an export to another Owner", async () => {
    const { GET } = await import("@/app/api/operator/privacy/export/[token]/route");
    const response = await GET(
      new Request("http://localhost/api/operator/privacy/export/token?format=html"),
      { params: Promise.resolve({ token: "token" }) },
      {
        requireApplicationUser: async () => ({ ok: true, userId: OTHER_OWNER_ID }),
        requireRecentAuth: async () => true,
        downloadExport: async () => ({ ok: false, code: "owner_mismatch", status: 404 }),
      },
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("<h1>");
  });

  it("serves an audited JSON or HTML download with no-store headers", async () => {
    const { GET } = await import("@/app/api/operator/privacy/export/[token]/route");
    const response = await GET(
      new Request("http://localhost/api/operator/privacy/export/token?format=html"),
      { params: Promise.resolve({ token: "token" }) },
      {
        requireApplicationUser: async () => ({ ok: true, userId: OWNER_ID }),
        requireRecentAuth: async () => true,
        downloadExport: async () => ({
          ok: true,
          format: "html",
          body: "<!doctype html><h1>Founder Data Export</h1>",
          contentType: "text/html; charset=utf-8",
          fileName: "bruno-founder-data-export.html",
          expiresAt: new Date(GENERATED_AT.getTime() + FOUNDER_DATA_EXPORT_TTL_MS).toISOString(),
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toContain(".html");
    expect(await response.text()).toContain("Founder Data Export");
  });
});
