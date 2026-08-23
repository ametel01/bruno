import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { GET, POST as recover } from "@/app/api/identity-recovery/route";
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
    const response = await recover(
      new Request("https://bruno.example/api/identity-recovery", {
        method: "POST",
        body: JSON.stringify({ assertion: "signed-recovery-proof" }),
      }),
      undefined,
      {
        getClerkUserId: async () => "user_replacement",
        readSigningSecret: () => "a".repeat(32),
        recover: recoverIdentity,
        now: () => new Date("2026-08-23T04:00:00.000Z"),
      },
    );
    expect(response.status).toBe(200);
    expect(recoverIdentity).toHaveBeenCalledWith({
      replacementClerkUserId: "user_replacement",
      assertion: "signed-recovery-proof",
      signingSecret: "a".repeat(32),
      now: new Date("2026-08-23T04:00:00.000Z"),
    });
    expect(JSON.stringify(await response.json())).not.toMatch(/owner|assertion|email|checkout/i);
  });
});
