import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { GET, POST as recover } from "@/app/api/identity-recovery/route";
import {
  GET as getRecoveryCredential,
  POST as issueRecoveryCredential,
} from "@/app/api/operator/identity-recovery/route";
import { POST as receiveClerkWebhook } from "@/app/api/webhooks/clerk/route";

describe("Founder identity recovery routes", () => {
  it("verifies Clerk delivery before recording only a user deletion", async () => {
    const recordLoss = vi.fn(async () => ({ recoveryId: "recovery", ownerId: "owner" }));
    const invalid = await receiveClerkWebhook(
      new NextRequest("https://bruno.example/api/webhooks/clerk", { method: "POST", body: "{}" }),
      undefined,
      {
        verify: vi.fn(async () => {
          throw new Error("invalid signature");
        }),
        recordLoss,
      },
    );
    expect(invalid.status).toBe(401);
    expect(recordLoss).not.toHaveBeenCalled();

    const accepted = await receiveClerkWebhook(
      new NextRequest("https://bruno.example/api/webhooks/clerk", {
        method: "POST",
        headers: { "svix-id": "delivery-384" },
        body: "{}",
      }),
      undefined,
      {
        verify: vi.fn(async () => ({
          type: "user.deleted" as const,
          object: "event" as const,
          data: { object: "user", id: "user_deleted", deleted: true },
          event_attributes: { http_request: { client_ip: "", user_agent: "" } },
        })),
        recordLoss,
        now: () => new Date("2026-08-23T04:00:00.000Z"),
      },
    );
    expect(accepted.status).toBe(202);
    expect(recordLoss).toHaveBeenCalledWith({
      clerkUserId: "user_deleted",
      providerEventId: "delivery-384",
      reason: "clerk_user_deleted",
      observedAt: new Date("2026-08-23T04:00:00.000Z"),
    });
  });

  it("records provider-confirmed identity loss without treating ordinary profile updates as loss", async () => {
    const recordLoss = vi.fn(async () => ({ recoveryId: "recovery", ownerId: "owner" }));
    const banned = await receiveClerkWebhook(
      new NextRequest("https://bruno.example/api/webhooks/clerk", {
        method: "POST",
        headers: { "svix-id": "delivery-banned-384" },
        body: "{}",
      }),
      undefined,
      {
        verify: vi.fn(
          async () =>
            ({
              type: "user.updated",
              data: { id: "user_lost", banned: true },
            }) as never,
        ),
        recordLoss,
        now: () => new Date("2026-08-23T04:00:00.000Z"),
      },
    );
    expect(banned.status).toBe(202);
    expect(recordLoss).toHaveBeenCalledWith({
      clerkUserId: "user_lost",
      providerEventId: "delivery-banned-384",
      reason: "clerk_identity_lost",
      observedAt: new Date("2026-08-23T04:00:00.000Z"),
    });

    recordLoss.mockClear();
    const ordinaryUpdate = await receiveClerkWebhook(
      new NextRequest("https://bruno.example/api/webhooks/clerk", {
        method: "POST",
        headers: { "svix-id": "delivery-updated-384" },
        body: "{}",
      }),
      undefined,
      {
        verify: vi.fn(
          async () =>
            ({
              type: "user.updated",
              data: { id: "user_current", banned: false },
            }) as never,
        ),
        recordLoss,
      },
    );
    expect(ordinaryUpdate.status).toBe(202);
    expect(recordLoss).not.toHaveBeenCalled();
  });

  it("requires a Clerk session and exposes only bounded recovery state", async () => {
    const getStatus = vi.fn(async () => ({ state: "proof_required" as const }));
    const denied = await GET(
      new Request("https://bruno.example/api/identity-recovery"),
      undefined,
      {
        getClerkUserId: async () => null,
        getStatus,
      },
    );
    expect(denied.status).toBe(401);
    const response = await GET(
      new Request("https://bruno.example/api/identity-recovery"),
      undefined,
      { getClerkUserId: async () => "user_new", getStatus },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ recovery: { state: "proof_required" } });
    expect(getStatus).toHaveBeenCalledWith("user_new");
  });

  it("binds POST recovery to the authenticated replacement subject", async () => {
    const recoverIdentity = vi.fn(async () => ({
      ownerId: "owner",
      recoveredAt: "2026-08-23T04:00:00.000Z",
    }));
    const getStatus = vi.fn(async () => ({
      state: "recovered" as const,
      recoveredAt: "2026-08-23T04:00:00.000Z",
      receipts: [
        {
          kind: "identity_rebound" as const,
          occurredAt: "2026-08-23T04:00:00.000Z",
        },
      ],
    }));
    const response = await recover(
      new Request("https://bruno.example/api/identity-recovery", {
        method: "POST",
        body: JSON.stringify({ recoveryCode: "one-time-recovery-code" }),
      }),
      undefined,
      {
        getClerkUserId: async () => "user_replacement",
        readSigningSecret: () => "a".repeat(32),
        recover: recoverIdentity,
        getStatus,
        now: () => new Date("2026-08-23T04:00:00.000Z"),
      },
    );
    expect(response.status).toBe(200);
    expect(recoverIdentity).toHaveBeenCalledWith({
      replacementClerkUserId: "user_replacement",
      recoveryCode: "one-time-recovery-code",
      signingSecret: "a".repeat(32),
      now: new Date("2026-08-23T04:00:00.000Z"),
    });
    const body = await response.json();
    expect(body).toMatchObject({
      recovery: {
        state: "recovered",
        receipts: [{ kind: "identity_rebound" }],
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/owner|assertion|email|checkout/i);
  });

  it("never reports denial after recovery succeeded but receipt observation failed", async () => {
    const response = await recover(
      new Request("https://bruno.example/api/identity-recovery", {
        method: "POST",
        body: JSON.stringify({ recoveryCode: "one-time-recovery-code" }),
      }),
      undefined,
      {
        getClerkUserId: async () => "user_replacement",
        readSigningSecret: () => "a".repeat(32),
        recover: async () => ({
          ownerId: "owner",
          recoveredAt: "2026-08-23T04:00:00.000Z",
        }),
        getStatus: async () => {
          throw new Error("temporary database read failure");
        },
      },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "identity_recovery_receipts_unavailable",
        message: expect.stringContaining("Identity was recovered"),
      },
    });
  });

  it("issues a one-time recovery credential only after recent reauthentication", async () => {
    const owner = { ok: true as const, userId: "00000000-0000-4000-8000-000000000384" };
    const issueCredential = vi.fn(async () => ({
      recoveryCode: "bruno_recovery_credential",
      expiresAt: "2027-08-23T04:00:00.000Z",
    }));
    const denied = await issueRecoveryCredential(
      new Request("https://bruno.example/api/operator/identity-recovery", { method: "POST" }),
      undefined,
      {
        requireApplicationUser: async () => owner,
        requireRecentAuth: async () => false,
        issueCredential,
      },
    );
    expect(denied.status).toBe(401);
    expect(issueCredential).not.toHaveBeenCalled();

    const issued = await issueRecoveryCredential(
      new Request("https://bruno.example/api/operator/identity-recovery", { method: "POST" }),
      undefined,
      {
        requireApplicationUser: async () => owner,
        requireRecentAuth: async () => true,
        issueCredential,
        now: () => new Date("2026-08-23T04:00:00.000Z"),
      },
    );
    expect(issued.status).toBe(200);
    expect(issueCredential).toHaveBeenCalledWith({
      userId: owner.userId,
      now: new Date("2026-08-23T04:00:00.000Z"),
    });
    await expect(issued.json()).resolves.toEqual({
      credential: {
        recoveryCode: "bruno_recovery_credential",
        expiresAt: "2027-08-23T04:00:00.000Z",
      },
    });

    const status = await getRecoveryCredential(
      new Request("https://bruno.example/api/operator/identity-recovery"),
      undefined,
      {
        requireApplicationUser: async () => owner,
        getStatus: async () => ({ state: "ready", expiresAt: "2027-08-23T04:00:00.000Z" }),
        getRecoveryStatus: async () => ({
          state: "recovered",
          recoveredAt: "2026-08-23T04:00:00.000Z",
          receipts: [
            { kind: "identity_loss_recorded", occurredAt: "2026-08-23T03:00:00.000Z" },
            { kind: "identity_rebound", occurredAt: "2026-08-23T04:00:00.000Z" },
          ],
        }),
      },
    );
    await expect(status.json()).resolves.toEqual({
      credential: { state: "ready", expiresAt: "2027-08-23T04:00:00.000Z" },
      recovery: {
        state: "recovered",
        recoveredAt: "2026-08-23T04:00:00.000Z",
        receipts: [
          { kind: "identity_loss_recorded", occurredAt: "2026-08-23T03:00:00.000Z" },
          { kind: "identity_rebound", occurredAt: "2026-08-23T04:00:00.000Z" },
        ],
      },
    });
  });
});
