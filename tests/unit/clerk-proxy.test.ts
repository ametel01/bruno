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
    AGENTBAY_AUTH_MODE: process.env.AGENTBAY_AUTH_MODE,
    AGENTBAY_OPERATOR_PASSWORD: process.env.AGENTBAY_OPERATOR_PASSWORD,
    AGENTBAY_PREVIEW_PROTECTION_VERIFIED: process.env.AGENTBAY_PREVIEW_PROTECTION_VERIFIED,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
    VERCEL_URL: process.env.VERCEL_URL,
  };

  beforeEach(() => {
    process.env.AGENTBAY_AUTH_MODE = "clerk";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "publishable-key-present";
    process.env.CLERK_SECRET_KEY = "secret-key-present";
    delete process.env.AGENTBAY_OPERATOR_PASSWORD;
    delete process.env.AGENTBAY_PREVIEW_PROTECTION_VERIFIED;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;
    mocks.clerkInvocations = 0;
    mocks.auth.mockReset();
    mocks.redirectToSignIn.mockReset();
    mocks.redirectToSignIn.mockReturnValue(NextResponse.redirect("http://localhost/sign-in"));
  });

  afterEach(() => {
    restoreEnv("AGENTBAY_AUTH_MODE", originalEnv.AGENTBAY_AUTH_MODE);
    restoreEnv("AGENTBAY_OPERATOR_PASSWORD", originalEnv.AGENTBAY_OPERATOR_PASSWORD);
    restoreEnv(
      "AGENTBAY_PREVIEW_PROTECTION_VERIFIED",
      originalEnv.AGENTBAY_PREVIEW_PROTECTION_VERIFIED,
    );
    restoreEnv("CLERK_SECRET_KEY", originalEnv.CLERK_SECRET_KEY);
    restoreEnv("NEXT_PUBLIC_APP_URL", originalEnv.NEXT_PUBLIC_APP_URL);
    restoreEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", originalEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
    restoreEnv("VERCEL", originalEnv.VERCEL);
    restoreEnv("VERCEL_ENV", originalEnv.VERCEL_ENV);
    restoreEnv("VERCEL_PROJECT_PRODUCTION_URL", originalEnv.VERCEL_PROJECT_PRODUCTION_URL);
    restoreEnv("VERCEL_URL", originalEnv.VERCEL_URL);
  });

  it("uses standard Clerk environment keys instead of propagating dynamic key options", () => {
    expect(mocks.clerkOptions).toEqual({
      signInUrl: "/sign-in",
      signUpUrl: "/sign-up",
    });
  });

  it.each([
    "/dashboard",
    "/api/agents",
  ])("allows registration-free local development on %s without invoking Clerk", async (pathname) => {
    process.env.AGENTBAY_AUTH_MODE = "development";
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_SECRET_KEY;

    const response = await proxy(
      new NextRequest(`https://caller-controlled.example${pathname}`),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(mocks.clerkInvocations).toBe(0);
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it.each([
    "/",
    "/dashboard",
    "/agents",
    "/agents/00000000-0000-4000-8000-000000000001",
    "/settings",
  ])("redirects the signed-out protected page %s to sign-in", async (pathname) => {
    mocks.auth.mockResolvedValueOnce({
      isAuthenticated: false,
      redirectToSignIn: mocks.redirectToSignIn,
    });

    const response = await proxy(
      new NextRequest(`http://localhost${pathname}`),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/sign-in");
    expect(mocks.redirectToSignIn).toHaveBeenCalledWith({
      returnBackUrl: `http://localhost${pathname}`,
    });
  });

  it.each([
    "/api/agents",
    "/api/agents/00000000-0000-4000-8000-000000000001",
    "/api/agents/00000000-0000-4000-8000-000000000001/actions/start",
    "/api/agents/00000000-0000-4000-8000-000000000001/actions/stop",
    "/api/agents/00000000-0000-4000-8000-000000000001/actions/restart",
    "/api/agents/00000000-0000-4000-8000-000000000001/actions/simulate-error",
    "/api/agents/00000000-0000-4000-8000-000000000001/events",
    "/api/agents/00000000-0000-4000-8000-000000000001/logs",
    "/api/agents/00000000-0000-4000-8000-000000000001/backups",
    "/api/agents/00000000-0000-4000-8000-000000000001/backups/00000000-0000-4000-8000-000000000002/restore",
    "/api/approvals/00000000-0000-4000-8000-000000000003/approve",
    "/api/approvals/00000000-0000-4000-8000-000000000003/deny",
    "/api/runners",
    "/api/runners/registration-tokens",
    "/api/runners/00000000-0000-4000-8000-000000000004/credentials/rotate",
    "/api/runners/00000000-0000-4000-8000-000000000004/credentials/revoke",
  ])("returns the same safe JSON 401 for signed-out browser API %s", async (pathname) => {
    mocks.auth.mockResolvedValueOnce({
      isAuthenticated: false,
      redirectToSignIn: mocks.redirectToSignIn,
    });

    const response = await proxy(
      new NextRequest(`http://localhost${pathname}`),
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
    expect(mocks.clerkInvocations).toBe(0);
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
    process.env.AGENTBAY_AUTH_MODE = "invalid";
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_SECRET_KEY;

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
        message: "Clerk authentication is not configured.",
      },
    });
    expect(mocks.clerkInvocations).toBe(0);
  });

  it("defaults an unset Vercel preview to Clerk session enforcement", async () => {
    delete process.env.AGENTBAY_AUTH_MODE;
    process.env.AGENTBAY_OPERATOR_PASSWORD = "operator-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://agentbay-git-feature.example.vercel.app";
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "agentbay-git-feature.example.vercel.app";
    mocks.auth.mockResolvedValueOnce({
      isAuthenticated: false,
      redirectToSignIn: mocks.redirectToSignIn,
    });

    const response = await proxy(
      new NextRequest("https://caller-controlled.example/api/agents", {
        headers: { authorization: basicAuth("agentbay", "operator-secret") },
      }),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "clerk_auth_required", message: "Authentication is required." },
    });
    expect(mocks.clerkInvocations).toBe(1);
  });

  it("fails an unset Vercel preview closed before Clerk when keys are incomplete", async () => {
    delete process.env.AGENTBAY_AUTH_MODE;
    process.env.AGENTBAY_OPERATOR_PASSWORD = "operator-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://agentbay-git-feature.example.vercel.app";
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "agentbay-git-feature.example.vercel.app";
    delete process.env.CLERK_SECRET_KEY;

    const response = await proxy(
      new NextRequest("https://caller-controlled.example/api/agents", {
        headers: { authorization: basicAuth("agentbay", "operator-secret") },
      }),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "clerk_auth_not_configured",
        message: "Clerk authentication is not configured.",
      },
    });
    expect(mocks.clerkInvocations).toBe(0);
  });

  it("fails closed for an unsupported authentication mode", async () => {
    process.env.AGENTBAY_AUTH_MODE = "unexpected";

    const response = await proxy(
      new NextRequest("http://localhost/dashboard"),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Authentication mode must be development or clerk.");
    expect(mocks.clerkInvocations).toBe(0);
  });

  it("does not treat a DNS name beginning 127 as a local development host", async () => {
    process.env.AGENTBAY_AUTH_MODE = "development";
    process.env.NEXT_PUBLIC_APP_URL = "https://127.attacker.example";
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_SECRET_KEY;

    const response = await proxy(
      new NextRequest("https://127.attacker.example/dashboard"),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe(
      "Development authentication is not allowed in this environment.",
    );
    expect(mocks.clerkInvocations).toBe(0);
  });

  it("permits only an attested development preview after the independent operator barrier", async () => {
    process.env.AGENTBAY_AUTH_MODE = "development";
    process.env.AGENTBAY_PREVIEW_PROTECTION_VERIFIED = "true";
    process.env.AGENTBAY_OPERATOR_PASSWORD = "operator-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://agentbay-git-feature.example.vercel.app";
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "agentbay-git-feature.example.vercel.app";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "agentbay.example.vercel.app";
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_SECRET_KEY;

    const response = await proxy(
      new NextRequest("https://caller-controlled.example/dashboard", {
        headers: { authorization: basicAuth("agentbay", "operator-secret") },
      }),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(mocks.clerkInvocations).toBe(0);
  });

  it("fails a development preview closed when protection is not attested", async () => {
    process.env.AGENTBAY_AUTH_MODE = "development";
    process.env.AGENTBAY_OPERATOR_PASSWORD = "operator-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://agentbay-git-feature.example.vercel.app";
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "agentbay-git-feature.example.vercel.app";
    delete process.env.AGENTBAY_PREVIEW_PROTECTION_VERIFIED;

    const response = await proxy(
      new NextRequest("https://localhost/api/agents", {
        headers: { authorization: basicAuth("agentbay", "operator-secret") },
      }),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "preview_protection_not_verified",
        message: "Preview development authentication requires verified deployment protection.",
      },
    });
    expect(mocks.clerkInvocations).toBe(0);
  });
});

function basicAuth(username: string, password: string): string {
  return `Basic ${globalThis.btoa(`${username}:${password}`)}`;
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
