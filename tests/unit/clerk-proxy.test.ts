import { type NextFetchEvent, NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  clerkOptions: undefined as unknown,
  clerkInvocations: 0,
  redirectToSignIn: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: (
    handler: (auth: typeof mocks.auth, request: NextRequest) => Promise<Response>,
    options: unknown,
  ) => {
    mocks.clerkOptions = options;

    return async (request: NextRequest) => {
      mocks.clerkInvocations += 1;
      return handler(mocks.auth, request);
    };
  },
}));

import { proxy } from "@/proxy";

describe("Clerk session proxy", () => {
  const originalEnv = {
    AGENTBAY_AUTH_TRANSITION_MODE: process.env.AGENTBAY_AUTH_TRANSITION_MODE,
    AGENTBAY_OPERATOR_PASSWORD: process.env.AGENTBAY_OPERATOR_PASSWORD,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };

  beforeEach(() => {
    process.env.AGENTBAY_AUTH_TRANSITION_MODE = "clerk";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "publishable-key-present";
    process.env.CLERK_SECRET_KEY = "secret-key-present";
    delete process.env.AGENTBAY_OPERATOR_PASSWORD;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    mocks.clerkInvocations = 0;
    mocks.auth.mockReset();
    mocks.redirectToSignIn.mockReset();
    mocks.redirectToSignIn.mockReturnValue(NextResponse.redirect("http://localhost/sign-in"));
  });

  afterEach(() => {
    restoreEnv("AGENTBAY_AUTH_TRANSITION_MODE", originalEnv.AGENTBAY_AUTH_TRANSITION_MODE);
    restoreEnv("AGENTBAY_OPERATOR_PASSWORD", originalEnv.AGENTBAY_OPERATOR_PASSWORD);
    restoreEnv("CLERK_SECRET_KEY", originalEnv.CLERK_SECRET_KEY);
    restoreEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", originalEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
    restoreEnv("VERCEL", originalEnv.VERCEL);
    restoreEnv("VERCEL_ENV", originalEnv.VERCEL_ENV);
  });

  it("uses standard Clerk environment keys instead of propagating dynamic key options", () => {
    expect(mocks.clerkOptions).toEqual({
      signInUrl: "/sign-in",
      signUpUrl: "/sign-up",
    });
  });

  it("redirects a signed-out browser page to sign-in", async () => {
    mocks.auth.mockResolvedValueOnce({
      isAuthenticated: false,
      redirectToSignIn: mocks.redirectToSignIn,
    });

    const response = await proxy(
      new NextRequest("http://localhost/dashboard"),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/sign-in");
    expect(mocks.redirectToSignIn).toHaveBeenCalledWith({
      returnBackUrl: "http://localhost/dashboard",
    });
  });

  it("returns a safe JSON 401 for a signed-out browser API", async () => {
    mocks.auth.mockResolvedValueOnce({
      isAuthenticated: false,
      redirectToSignIn: mocks.redirectToSignIn,
    });

    const response = await proxy(
      new NextRequest("http://localhost/api/agents"),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "clerk_auth_required", message: "Authentication is required." },
    });
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
    expect(mocks.redirectToSignIn).not.toHaveBeenCalled();
  });

  it("allows an authenticated browser request", async () => {
    mocks.auth.mockResolvedValueOnce({ isAuthenticated: true });

    const response = await proxy(
      new NextRequest("http://localhost/settings"),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    "/sign-in",
    "/sign-in/factor-one",
    "/sign-up",
    "/sign-up/verify",
  ])("keeps public auth page %s outside session enforcement", async (pathname) => {
    const response = await proxy(
      new NextRequest(`http://localhost${pathname}`),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(mocks.clerkInvocations).toBe(1);
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it.each([
    "/health",
    "/_next/static/app.js",
    "/favicon.ico",
    "/runner/v1/register",
    "/runner/v1/heartbeat",
    "/runner/v1/bootstrap-events",
  ])("bypasses Clerk entirely for infrastructure or machine route %s", async (pathname) => {
    const response = await proxy(
      new NextRequest(`http://localhost${pathname}`),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(mocks.clerkInvocations).toBe(0);
  });

  it("protects future runner routes instead of broadening the machine bypass", async () => {
    mocks.auth.mockResolvedValueOnce({
      isAuthenticated: false,
      redirectToSignIn: mocks.redirectToSignIn,
    });

    const response = await proxy(
      new NextRequest("http://localhost/runner/v1/future"),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(307);
    expect(mocks.clerkInvocations).toBe(1);
  });

  it("fails closed when Clerk mode is missing configuration", async () => {
    delete process.env.CLERK_SECRET_KEY;

    const response = await proxy(
      new NextRequest("http://localhost/api/agents"),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "clerk_auth_not_configured",
        message: "Authentication is not configured.",
      },
    });
    expect(mocks.clerkInvocations).toBe(0);
  });

  it("fails closed for an unsupported transition value", async () => {
    process.env.AGENTBAY_AUTH_TRANSITION_MODE = "unexpected";

    const response = await proxy(
      new NextRequest("http://localhost/dashboard"),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Authentication mode is not configured safely.");
    expect(mocks.clerkInvocations).toBe(0);
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
