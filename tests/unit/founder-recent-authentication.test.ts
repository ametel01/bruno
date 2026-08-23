import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({
  userId: "user_founder" as string | null,
  has: vi.fn(() => false),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: clerk.userId, has: clerk.has }),
}));

import { requireRecentFounderAuthentication } from "@/src/server/operators/founder-recent-authentication";

describe("Founder recent authentication", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      BRUNO_AUTH_MODE: "clerk",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
      CLERK_SECRET_KEY: "sk_test_example",
    };
    clerk.userId = "user_founder";
    clerk.has.mockReset();
    clerk.has.mockReturnValue(false);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("requires Clerk strict reverification instead of accepting session freshness", async () => {
    expect(
      await requireRecentFounderAuthentication(
        new Request("https://bruno.example/api/operator/privacy"),
        "/api/operator/privacy",
      ),
    ).toBe(false);
    expect(clerk.has).toHaveBeenCalledWith({ reverification: "strict" });

    clerk.has.mockReturnValue(true);
    expect(
      await requireRecentFounderAuthentication(
        new Request("https://bruno.example/api/operator/privacy"),
        "/api/operator/privacy",
      ),
    ).toBe(true);
  });

  it("fails closed when Clerk reports no signed-in identity", async () => {
    clerk.userId = null;
    clerk.has.mockReturnValue(true);

    expect(
      await requireRecentFounderAuthentication(
        new Request("https://bruno.example/api/operator/identity-recovery"),
        "/api/operator/identity-recovery",
      ),
    ).toBe(false);
  });
});
