import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isBrowserApiPath,
  isClerkAuthPagePath,
  isInternalServiceAuthPath,
  isPublicInfrastructurePath,
  isRunnerMachineAuthPath,
} from "@/src/auth/clerk-transition";

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
    "/api/internal/agent-deployments/reconcile",
    "/api/internal/agent-deployments/wakeup",
    "/api/internal/agent-runtime/reconcile",
    "/api/internal/cold-deployment-slo/evaluate",
    "/api/internal/hermes-staging/acceptance",
    "/api/internal/hermes-staging/reconcile",
    "/api/internal/runner-infrastructure/reconcile",
    "/api/internal/runner-release/required",
    "/api/internal/runner-replacements/reconcile",
  ])("recognizes independently authenticated internal route %s", (pathname) => {
    expect(isInternalServiceAuthPath(pathname)).toBe(true);
  });

  it.each([
    "/api/internal",
    "/api/internal/future",
    "/api/internal/runner-release/required/extra",
  ])("does not broaden the internal service bypass to %s", (pathname) => {
    expect(isInternalServiceAuthPath(pathname)).toBe(false);
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
