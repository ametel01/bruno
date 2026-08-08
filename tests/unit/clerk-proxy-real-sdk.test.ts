import { type NextFetchEvent, NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const SYNTHETIC_PUBLISHABLE_KEY = `pk_${"test"}_${globalThis
  .btoa("fake-fake-1.clerk.accounts.dev$")
  .replace(/=+$/, "")}`;
const SYNTHETIC_SECRET_KEY = ["sk", "test", "synthetic"].join("_");

describe("real Clerk SDK proxy configuration", () => {
  const originalEnv = {
    BRUNO_AUTH_MODE: process.env.BRUNO_AUTH_MODE,
    BRUNO_OPERATOR_PASSWORD: process.env.BRUNO_OPERATOR_PASSWORD,
    BRUNO_PREVIEW_PROTECTION_VERIFIED: process.env.BRUNO_PREVIEW_PROTECTION_VERIFIED,
    CLERK_ENCRYPTION_KEY: process.env.CLERK_ENCRYPTION_KEY,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED: process.env.NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
    VERCEL_URL: process.env.VERCEL_URL,
  };

  afterEach(() => {
    restoreEnv("BRUNO_AUTH_MODE", originalEnv.BRUNO_AUTH_MODE);
    restoreEnv("BRUNO_OPERATOR_PASSWORD", originalEnv.BRUNO_OPERATOR_PASSWORD);
    restoreEnv("BRUNO_PREVIEW_PROTECTION_VERIFIED", originalEnv.BRUNO_PREVIEW_PROTECTION_VERIFIED);
    restoreEnv("CLERK_ENCRYPTION_KEY", originalEnv.CLERK_ENCRYPTION_KEY);
    restoreEnv("CLERK_SECRET_KEY", originalEnv.CLERK_SECRET_KEY);
    restoreEnv("NEXT_PUBLIC_APP_URL", originalEnv.NEXT_PUBLIC_APP_URL);
    restoreEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", originalEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
    restoreEnv(
      "NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED",
      originalEnv.NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED,
    );
    restoreEnv("VERCEL", originalEnv.VERCEL);
    restoreEnv("VERCEL_ENV", originalEnv.VERCEL_ENV);
    restoreEnv("VERCEL_PROJECT_PRODUCTION_URL", originalEnv.VERCEL_PROJECT_PRODUCTION_URL);
    restoreEnv("VERCEL_URL", originalEnv.VERCEL_URL);
    vi.resetModules();
  });

  it("serves the public sign-in request with only standard publishable and secret keys", async () => {
    process.env.BRUNO_AUTH_MODE = "clerk";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = SYNTHETIC_PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED = "1";
    process.env.CLERK_SECRET_KEY = SYNTHETIC_SECRET_KEY;
    delete process.env.CLERK_ENCRYPTION_KEY;
    delete process.env.BRUNO_OPERATOR_PASSWORD;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;
    vi.resetModules();

    const { proxy } = await import("@/proxy");
    const response = await proxy(new NextRequest("http://localhost/sign-in"), {} as NextFetchEvent);

    expect(response.status).toBe(200);
  });

  it("uses complete standard Clerk keys for an unset Vercel preview", async () => {
    delete process.env.BRUNO_AUTH_MODE;
    process.env.NEXT_PUBLIC_APP_URL = "https://bruno-git-feature.example.vercel.app";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = SYNTHETIC_PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED = "1";
    process.env.CLERK_SECRET_KEY = SYNTHETIC_SECRET_KEY;
    delete process.env.CLERK_ENCRYPTION_KEY;
    delete process.env.BRUNO_OPERATOR_PASSWORD;
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    process.env.VERCEL_URL = "bruno-git-feature.example.vercel.app";
    vi.resetModules();

    const { proxy } = await import("@/proxy");
    const response = await proxy(
      new NextRequest("https://caller-controlled.example/sign-in"),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(200);
  });

  it("serves a local development request without Clerk keys or SDK network work", async () => {
    process.env.BRUNO_AUTH_MODE = "development";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_ENCRYPTION_KEY;
    delete process.env.BRUNO_OPERATOR_PASSWORD;
    delete process.env.BRUNO_PREVIEW_PROTECTION_VERIFIED;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;
    vi.resetModules();

    const { proxy } = await import("@/proxy");
    const response = await proxy(
      new NextRequest("https://caller-controlled.example/dashboard"),
      {} as NextFetchEvent,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
