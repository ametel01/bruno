import { describe, expect, it } from "vitest";
import { type NextFetchEvent, NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { evaluateOperatorAccess, isOperatorProtectedPath } from "@/src/auth/operator-access";

describe("operator access path decisions", () => {
  it.each([
    "/",
    "/dashboard",
    "/dashboard/runners",
    "/agents",
    "/agents/abc",
    "/settings",
  ])("protects app path %s", (pathname) => {
    expect(isOperatorProtectedPath(pathname)).toBe(true);
  });

  it.each([
    "/api/agents",
    "/api/runners",
    "/api/runners/registration-tokens",
  ])("protects app-side API path %s", (pathname) => {
    expect(isOperatorProtectedPath(pathname)).toBe(true);
  });

  it.each([
    "/_next/static/chunks/app.js",
    "/favicon.ico",
    "/health",
    "/sign-in",
    "/sign-in/factor-one",
    "/sign-up",
    "/sign-up/verify-email-address",
    "/runner/v1/register",
    "/runner/v1/heartbeat",
    "/runner/v1/bootstrap-events",
    "/robots.txt",
    "/images/logo.svg",
  ])("leaves public path %s outside the operator gate", (pathname) => {
    expect(isOperatorProtectedPath(pathname)).toBe(false);
  });
});

describe("evaluateOperatorAccess", () => {
  it("allows local development with no operator password configured", () => {
    expect(
      evaluateOperatorAccess({
        pathname: "/dashboard",
        authorizationHeader: null,
        env: { NODE_ENV: "development" },
      }),
    ).toEqual({ ok: true });
  });

  it("allows test runs with no operator password configured", () => {
    expect(
      evaluateOperatorAccess({
        pathname: "/api/agents",
        authorizationHeader: null,
        env: { NODE_ENV: "test" },
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    [{ VERCEL: "1" }],
    [{ VERCEL_ENV: "production" }],
    [{ NODE_ENV: "production" }],
  ])("fails closed in production-like env %o when no password is configured", (env) => {
    expect(
      evaluateOperatorAccess({
        pathname: "/api/runners",
        authorizationHeader: null,
        env,
      }),
    ).toEqual({
      ok: false,
      status: 503,
      code: "operator_auth_not_configured",
    });
  });

  it("allows valid Basic auth with the default operator username", () => {
    expect(
      evaluateOperatorAccess({
        pathname: "/settings",
        authorizationHeader: basicAuth("agentbay", "correct horse battery staple"),
        env: { AGENTBAY_OPERATOR_PASSWORD: "correct horse battery staple", VERCEL: "1" },
      }),
    ).toEqual({ ok: true });
  });

  it("allows valid Basic auth with a configured operator username", () => {
    expect(
      evaluateOperatorAccess({
        pathname: "/api/agents",
        authorizationHeader: basicAuth("operator", "secret"),
        env: {
          AGENTBAY_OPERATOR_USERNAME: "operator",
          AGENTBAY_OPERATOR_PASSWORD: "secret",
          VERCEL_ENV: "production",
        },
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    ["missing credentials", null],
    ["bad scheme", "Bearer token"],
    ["malformed base64", "Basic !!!"],
    ["missing separator", `Basic ${globalThis.btoa("agentbay")}`],
    ["wrong username", basicAuth("other", "secret")],
    ["wrong password", basicAuth("agentbay", "wrong")],
  ])("requires operator auth for %s", (_label, authorizationHeader) => {
    expect(
      evaluateOperatorAccess({
        pathname: "/api/runners",
        authorizationHeader,
        env: { AGENTBAY_OPERATOR_PASSWORD: "secret", VERCEL: "1" },
      }),
    ).toEqual({
      ok: false,
      status: 401,
      code: "operator_auth_required",
    });
  });

  it("does not require credentials for public runner token endpoints in production", () => {
    expect(
      evaluateOperatorAccess({
        pathname: "/runner/v1/register",
        authorizationHeader: null,
        env: { VERCEL: "1" },
      }),
    ).toEqual({ ok: true });
  });
});

describe("operator access proxy responses", () => {
  it("returns safe JSON 401 responses for protected API paths", async () => {
    await withOperatorEnv(
      { AGENTBAY_OPERATOR_PASSWORD: "test-password", VERCEL: "1" },
      async () => {
        const response = await proxy(
          new NextRequest("http://localhost/api/agents"),
          {} as NextFetchEvent,
        );
        const body = await response.json();

        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toBe('Basic realm="AgentBay"');
        expect(body).toEqual({
          error: {
            code: "operator_auth_required",
            message: "Operator credentials are required.",
          },
        });
        expect(JSON.stringify(body)).not.toContain("test-password");
      },
    );
  });

  it("returns safe 401 text responses for protected page paths", async () => {
    await withOperatorEnv(
      { AGENTBAY_OPERATOR_PASSWORD: "test-password", VERCEL: "1" },
      async () => {
        const response = await proxy(
          new NextRequest("http://localhost/dashboard"),
          {} as NextFetchEvent,
        );

        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toBe('Basic realm="AgentBay"');
        expect(await response.text()).toBe("Operator credentials are required.");
      },
    );
  });

  it("returns safe 503 responses when production operator access is not configured", async () => {
    await withOperatorEnv({ AGENTBAY_OPERATOR_PASSWORD: undefined, VERCEL: "1" }, async () => {
      const response = await proxy(
        new NextRequest("http://localhost/api/runners"),
        {} as NextFetchEvent,
      );
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(response.headers.has("WWW-Authenticate")).toBe(false);
      expect(body).toEqual({
        error: {
          code: "operator_auth_not_configured",
          message: "Operator access is not configured.",
        },
      });
    });
  });
});

function basicAuth(username: string, password: string): string {
  return `Basic ${globalThis.btoa(`${username}:${password}`)}`;
}

async function withOperatorEnv(
  values: {
    AGENTBAY_OPERATOR_PASSWORD?: string | undefined;
    VERCEL?: string | undefined;
  },
  callback: () => Promise<void>,
) {
  const original = {
    AGENTBAY_OPERATOR_PASSWORD: process.env.AGENTBAY_OPERATOR_PASSWORD,
    VERCEL: process.env.VERCEL,
  };

  setOptionalEnv("AGENTBAY_OPERATOR_PASSWORD", values.AGENTBAY_OPERATOR_PASSWORD);
  setOptionalEnv("VERCEL", values.VERCEL);

  try {
    await callback();
  } finally {
    setOptionalEnv("AGENTBAY_OPERATOR_PASSWORD", original.AGENTBAY_OPERATOR_PASSWORD);
    setOptionalEnv("VERCEL", original.VERCEL);
  }
}

function setOptionalEnv(name: "AGENTBAY_OPERATOR_PASSWORD" | "VERCEL", value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
