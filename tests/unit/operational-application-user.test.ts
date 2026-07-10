import { describe, expect, it, vi } from "vitest";
import { requireOperationalApplicationUser } from "@/src/server/users/operational-application-user";

describe("operational application user adapter", () => {
  it("preserves shared development identity in the merged operator transition mode", async () => {
    const requireUser = vi.fn(async () => ({ ok: true as const, userId: "development-user" }));

    await expect(requireOperationalApplicationUser({ env: {}, requireUser })).resolves.toEqual({
      ok: true,
      userId: "development-user",
    });
    expect(requireUser).toHaveBeenCalledWith("development", {});
  });

  it("uses the request Clerk identity only in configured Clerk mode", async () => {
    const getClerkUserId = vi.fn(async () => "user_clerk");
    const requireUser = vi.fn(async (_mode, dependencies) => ({
      ok: true as const,
      userId: await dependencies.getClerkUserId?.(),
    }));

    await expect(
      requireOperationalApplicationUser({
        env: {
          AGENTBAY_AUTH_TRANSITION_MODE: "clerk",
          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "publishable-placeholder",
          CLERK_SECRET_KEY: "secret-placeholder",
        },
        getClerkUserId,
        requireUser,
      }),
    ).resolves.toEqual({ ok: true, userId: "user_clerk" });
    expect(requireUser).toHaveBeenCalledWith("clerk", { getClerkUserId });
  });

  it("fails closed before user resolution when transition configuration is invalid", async () => {
    const requireUser = vi.fn();

    await expect(
      requireOperationalApplicationUser({
        env: { AGENTBAY_AUTH_TRANSITION_MODE: "unsafe" },
        requireUser,
      }),
    ).resolves.toEqual({
      ok: false,
      status: 503,
      code: "invalid_auth_transition_mode",
    });
    expect(requireUser).not.toHaveBeenCalled();
  });
});
