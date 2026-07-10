import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isBrowserApiPath,
  isClerkAuthPagePath,
  isPublicInfrastructurePath,
  isRunnerMachineAuthPath,
  resolveClerkTransition,
} from "@/src/auth/clerk-transition";

describe("Clerk authentication transition", () => {
  it("defaults only an unset transition to the existing operator barrier", () => {
    expect(resolveClerkTransition({})).toEqual({ mode: "operator" });
    expect(resolveClerkTransition({ AGENTBAY_AUTH_TRANSITION_MODE: "operator" })).toEqual({
      mode: "operator",
    });
  });

  it.each([
    "",
    " ",
    "development",
    "CLERK",
    "operator ",
  ])("fails closed for unsupported transition value %j", (mode) => {
    expect(resolveClerkTransition({ AGENTBAY_AUTH_TRANSITION_MODE: mode })).toEqual({
      mode: "invalid",
      code: "invalid_auth_transition_mode",
    });
  });

  it("requires both Clerk key variables before enabling Clerk mode", () => {
    expect(resolveClerkTransition({ AGENTBAY_AUTH_TRANSITION_MODE: "clerk" })).toEqual({
      mode: "invalid",
      code: "clerk_auth_not_configured",
    });
    expect(
      resolveClerkTransition({
        AGENTBAY_AUTH_TRANSITION_MODE: "clerk",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "publishable-key-present",
      }),
    ).toEqual({ mode: "invalid", code: "clerk_auth_not_configured" });
  });

  it("enables Clerk mode only with the explicit mode and complete configuration", () => {
    expect(
      resolveClerkTransition({
        AGENTBAY_AUTH_TRANSITION_MODE: "clerk",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "publishable-key-present",
        CLERK_SECRET_KEY: "secret-key-present",
      }),
    ).toEqual({
      mode: "clerk",
      publishableKey: "publishable-key-present",
    });
  });
});

describe("Clerk route matrix", () => {
  it.each([
    "/sign-in",
    "/sign-in/factor-one",
    "/sign-up",
    "/sign-up/verify",
  ])("recognizes public authentication page %s", (pathname) => {
    expect(isClerkAuthPagePath(pathname)).toBe(true);
  });

  it.each([
    "/runner/v1/register",
    "/runner/v1/heartbeat",
    "/runner/v1/bootstrap-events",
  ])("bypasses Clerk for documented runner machine route %s", (pathname) => {
    expect(isRunnerMachineAuthPath(pathname)).toBe(true);
  });

  it.each([
    "/runner/v1/register/extra",
    "/runner/v1/future",
    "/runner/v2/heartbeat",
  ])("does not broaden the runner bypass to %s", (pathname) => {
    expect(isRunnerMachineAuthPath(pathname)).toBe(false);
  });

  it.each([
    "/health",
    "/_next/static/app.js",
    "/favicon.ico",
    "/robots.txt",
    "/logo.svg",
  ])("recognizes public infrastructure path %s", (pathname) => {
    expect(isPublicInfrastructurePath(pathname)).toBe(true);
  });

  it.each([
    "/api/agents",
    "/api/runners/one",
    "/api",
  ])("recognizes browser API path %s", (pathname) => {
    expect(isBrowserApiPath(pathname)).toBe(true);
  });

  it("uses exactly one Next.js 16 proxy entrypoint and the locked Clerk dependency", () => {
    expect(existsSync("proxy.ts")).toBe(true);
    expect(existsSync("middleware.ts")).toBe(false);

    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies["@clerk/nextjs"]).toBe("7.5.16");
  });
});
