import { describe, expect, it, vi } from "vitest";
import { createFounderContractIdentityHeaders } from "@/src/server/founder-product-contract/deterministic-identity";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

describe("configured application user adapter", () => {
  it("uses the shared development user path without consulting Clerk", async () => {
    const getClerkUserId = vi.fn(async () => "user_not_expected");
    const requireUser = vi.fn(async () => ({ ok: true as const, userId: "development-user-id" }));

    await expect(
      requireConfiguredApplicationUser({
        env: { NEXT_PUBLIC_APP_URL: "http://localhost:3000" },
        getClerkUserId,
        requireUser,
      }),
    ).resolves.toEqual({ ok: true, userId: "development-user-id" });

    expect(requireUser).toHaveBeenCalledWith("development", {});
    expect(getClerkUserId).not.toHaveBeenCalled();
  });

  it("uses the signed local contract identity through the Clerk mapping path", async () => {
    const env = {
      BRUNO_AUTH_MODE: "development",
      BRUNO_FOUNDER_CONTRACT_PROVIDER_MODE: "deterministic",
      BRUNO_FOUNDER_CONTRACT_RUN_ID: "fpct-configured-user",
      BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION: "a".repeat(40),
      BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET: "s".repeat(64),
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    };
    const requireUser = vi.fn(
      async (
        _mode: "clerk" | "development" | "operator",
        _dependencies?: { getClerkUserId?: () => Promise<string | null> },
      ) => ({ ok: true as const, userId: "internal-owner" }),
    );
    const requestHeaders = new Headers(
      createFounderContractIdentityHeaders("clerk:replacement", env),
    );

    await expect(
      requireConfiguredApplicationUser({
        env,
        getRequestHeaders: async () => requestHeaders,
        requireUser,
      }),
    ).resolves.toEqual({ ok: true, userId: "internal-owner" });
    expect(requireUser).toHaveBeenCalledWith("clerk", {
      getClerkUserId: expect.any(Function),
    });
    const identityProvider = requireUser.mock.calls[0]?.[1]?.getClerkUserId;
    expect(identityProvider).toBeTypeOf("function");
    if (!identityProvider) throw new Error("Contract identity provider was not forwarded.");
    await expect(identityProvider()).resolves.toBe("clerk:replacement");
  });

  it("uses the shared user path behind explicit operator auth without consulting Clerk", async () => {
    const getClerkUserId = vi.fn(async () => "user_not_expected");
    const requireUser = vi.fn(async () => ({ ok: true as const, userId: "operator-user-id" }));

    await expect(
      requireConfiguredApplicationUser({
        env: {
          BRUNO_AUTH_MODE: "operator",
          BRUNO_OPERATOR_PASSWORD: "operator-password-present",
          NEXT_PUBLIC_APP_URL: "https://getbruno.xyz",
          VERCEL_ENV: "production",
        },
        getClerkUserId,
        requireUser,
      }),
    ).resolves.toEqual({ ok: true, userId: "operator-user-id" });

    expect(requireUser).toHaveBeenCalledWith("operator", {});
    expect(getClerkUserId).not.toHaveBeenCalled();
  });

  it("passes only the request Clerk identity provider in Clerk mode", async () => {
    const getClerkUserId = vi.fn(async () => "user_opaque");
    const requireUser = vi.fn(async () => ({ ok: true as const, userId: "internal-user-id" }));

    await expect(
      requireConfiguredApplicationUser({
        env: {
          BRUNO_AUTH_MODE: "clerk",
          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "publishable-key-present",
          CLERK_SECRET_KEY: "secret-key-present",
        },
        getClerkUserId,
        requireUser,
      }),
    ).resolves.toEqual({ ok: true, userId: "internal-user-id" });

    expect(requireUser).toHaveBeenCalledWith("clerk", { getClerkUserId });
  });

  it("returns a typed safe 503 before user or Clerk resolution for invalid policy", async () => {
    const getClerkUserId = vi.fn(async () => "user_not_expected");
    const requireUser = vi.fn(async () => ({ ok: true as const, userId: "not-expected" }));

    await expect(
      requireConfiguredApplicationUser({
        env: {
          BRUNO_AUTH_MODE: "development",
          NEXT_PUBLIC_APP_URL: "https://getbruno.xyz",
        },
        getClerkUserId,
        requireUser,
      }),
    ).resolves.toEqual({
      ok: false,
      status: 503,
      code: "development_auth_not_allowed",
    });

    expect(requireUser).not.toHaveBeenCalled();
    expect(getClerkUserId).not.toHaveBeenCalled();
  });
});
