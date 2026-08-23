import { describe, expect, it, vi } from "vitest";
import { GET as GET_EXTERNAL_BETA, POST } from "@/app/api/operator/external-beta/route";
import { GET as GET_RETIREMENTS } from "@/app/api/internal/operator/external-beta/route";
import { FOUNDER_EXTERNAL_BETA_COMPACT_VERSION } from "@/src/server/founder-product-contract/external-beta-admission";

const USER_ID = "00000000-0000-4000-8000-000000003780";
const REVISION = "d".repeat(40);

describe("Founder External Beta route", () => {
  it("returns only the no-store Founder projection", async () => {
    const response = await GET_EXTERNAL_BETA(
      new Request("http://localhost/api/operator/external-beta"),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true as const, userId: USER_ID }),
        readApplicationRevision: () => REVISION,
        getStatus: async () => ({
          state: "active" as const,
          stage: "External Beta" as const,
          admittedAt: "2026-08-23T00:00:00.000Z",
          accessExpiresAt: "2026-09-06T00:00:00.000Z",
          workStoppedAt: null,
          retirementDueAt: "2026-09-06T01:00:00.000Z",
          remainingSeconds: 1,
          support: "Self-serve onboarding and ordinary use, with reactive support" as const,
          payment: "Free, no card, no renewal, and no automatic paid conversion" as const,
          evidenceClassification:
            "Product-hardening only; never Founder Acceptance Evidence" as const,
          availableCapabilities: [],
          unavailableCapabilities: [],
          withdrawalAvailable: true,
          exportAvailable: true as const,
          deletionAvailable: true as const,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).not.toMatch(
      /cohort|digest|clerk|workspace|runtime|token/i,
    );
  });

  it("requires the complete Beta Compact before calling admission", async () => {
    const admit = vi.fn();
    const partial = await POST(
      request({
        action: "accept_invitation",
        invitationToken: "a".repeat(43),
        workspaceReference: "founder-workspace",
        compact: { version: FOUNDER_EXTERNAL_BETA_COMPACT_VERSION },
      }),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true as const, userId: USER_ID }),
        admit,
      },
    );
    expect(partial.status).toBe(400);
    expect(admit).not.toHaveBeenCalled();

    const accepted = await POST(
      request({
        action: "accept_invitation",
        invitationToken: "a".repeat(43),
        workspaceReference: "founder-workspace",
        compact: compact(),
      }),
      undefined,
      {
        requireApplicationUser: async () => ({ ok: true as const, userId: USER_ID }),
        admit: async () => ({
          accessExpiresAt: "2026-09-06T00:00:00.000Z",
          retirementDueAt: "2026-09-06T01:00:00.000Z",
        }),
      },
    );
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      externalBeta: { state: "active" },
    });
  });
});

describe("Founder External Beta retirement route", () => {
  it("fails closed before processing an unauthorized request", async () => {
    const reconcile = vi.fn();
    const response = await GET_RETIREMENTS(
      new Request("http://localhost/api/internal/operator/external-beta"),
      undefined,
      {
        readCron: () => ({ ok: true as const, secret: "a".repeat(32) }),
        authorize: () => false,
        reconcile,
      },
    );
    expect(response.status).toBe(401);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("passes the exact revision and minute observation to retirement reconciliation", async () => {
    const now = new Date("2026-09-06T00:00:00.000Z");
    const providers = {
      createRecoveryArchive: vi.fn(),
      deleteRecoveryArchive: vi.fn(),
      digitalOcean: {} as never,
      calls: () => [],
    };
    const reconcile = vi.fn(async () => ({ expired: 1, retired: 1, failed: 0 }));
    const reconcileRecordings = vi.fn(async () => ({ deleted: 1, late: 0, failed: 0 }));
    const recordingProvider = { deleteAndVerifyAbsent: vi.fn() };
    const response = await GET_RETIREMENTS(
      new Request("http://localhost/api/internal/operator/external-beta"),
      undefined,
      {
        readCron: () => ({ ok: true as const, secret: "a".repeat(32) }),
        authorize: () => true,
        readApplicationRevision: () => REVISION,
        createProviders: () => providers,
        reconcile,
        reconcileRecordings,
        createRecordingProvider: () => recordingProvider,
        now: () => now,
      },
    );
    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith({
      applicationRevision: REVISION,
      now,
      providers,
    });
    expect(reconcileRecordings).toHaveBeenCalledWith(now, recordingProvider);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      expired: 1,
      retired: 1,
      failed: 0,
      recordingDeletion: { deleted: 1, late: 0, failed: 0 },
    });
  });

  it("does not couple recording deletion to infrastructure retirement configuration", async () => {
    const now = new Date("2026-09-06T00:00:00.000Z");
    const reconcileRecordings = vi.fn(async () => ({ deleted: 1, late: 0, failed: 0 }));
    const recordingProvider = { deleteAndVerifyAbsent: vi.fn() };
    const response = await GET_RETIREMENTS(
      new Request("http://localhost/api/internal/operator/external-beta"),
      undefined,
      {
        readCron: () => ({ ok: true as const, secret: "a".repeat(32) }),
        authorize: () => true,
        readApplicationRevision: () => null,
        createProviders: () => null,
        reconcileRecordings,
        createRecordingProvider: () => recordingProvider,
        now: () => now,
      },
    );
    expect(response.status).toBe(503);
    expect(reconcileRecordings).toHaveBeenCalledWith(now, recordingProvider);
  });

  it("runs Infrastructure Retirement and reports both outcomes when recording deletion fails", async () => {
    const now = new Date("2026-09-06T00:00:00.000Z");
    const providers = {
      createRecoveryArchive: vi.fn(),
      deleteRecoveryArchive: vi.fn(),
      digitalOcean: {} as never,
      calls: () => [],
    };
    const reconcile = vi.fn(async () => ({ expired: 1, retired: 1, failed: 0 }));
    const response = await GET_RETIREMENTS(
      new Request("http://localhost/api/internal/operator/external-beta"),
      undefined,
      {
        readCron: () => ({ ok: true as const, secret: "a".repeat(32) }),
        authorize: () => true,
        readApplicationRevision: () => REVISION,
        createProviders: () => providers,
        reconcile,
        reconcileRecordings: async () => ({ deleted: 0, late: 0, failed: 1 }),
        createRecordingProvider: () => ({ deleteAndVerifyAbsent: vi.fn() }),
        now: () => now,
      },
    );
    expect(response.status).toBe(500);
    expect(reconcile).toHaveBeenCalledWith({ applicationRevision: REVISION, now, providers });
    await expect(response.json()).resolves.toMatchObject({
      retirement: { ok: true, expired: 1, retired: 1, failed: 0 },
      recordingDeletion: { deleted: 0, late: 0, failed: 1 },
      error: { code: "external_beta_recording_deletion_failed" },
    });
  });
});

function request(body: unknown): Request {
  return new Request("http://localhost/api/operator/external-beta", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function compact() {
  return {
    version: FOUNDER_EXTERNAL_BETA_COMPACT_VERSION,
    instabilityAccepted: true,
    capabilityBoundaryAccepted: true,
    reactiveSupportAccepted: true,
    companyDataHandlingAccepted: true,
    feedbackBoundaryAccepted: true,
    withdrawalExportDeletionAccepted: true,
    freeNonconvertingBoundaryAccepted: true,
  } as const;
}
