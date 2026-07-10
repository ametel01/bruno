import { type NextFetchEvent, NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const SYNTHETIC_PUBLISHABLE_KEY = `pk_${"test"}_${globalThis
  .btoa("fake-fake-1.clerk.accounts.dev$")
  .replace(/=+$/, "")}`;
const SYNTHETIC_SECRET_KEY = ["sk", "test", "synthetic"].join("_");

describe("real Clerk SDK proxy configuration", () => {
  const originalEnv = {
    AGENTBAY_AUTH_TRANSITION_MODE: process.env.AGENTBAY_AUTH_TRANSITION_MODE,
    AGENTBAY_OPERATOR_PASSWORD: process.env.AGENTBAY_OPERATOR_PASSWORD,
    CLERK_ENCRYPTION_KEY: process.env.CLERK_ENCRYPTION_KEY,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED: process.env.NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };

  afterEach(() => {
    restoreEnv("AGENTBAY_AUTH_TRANSITION_MODE", originalEnv.AGENTBAY_AUTH_TRANSITION_MODE);
    restoreEnv("AGENTBAY_OPERATOR_PASSWORD", originalEnv.AGENTBAY_OPERATOR_PASSWORD);
    restoreEnv("CLERK_ENCRYPTION_KEY", originalEnv.CLERK_ENCRYPTION_KEY);
    restoreEnv("CLERK_SECRET_KEY", originalEnv.CLERK_SECRET_KEY);
    restoreEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", originalEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
    restoreEnv(
      "NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED",
      originalEnv.NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED,
    );
    restoreEnv("VERCEL", originalEnv.VERCEL);
    restoreEnv("VERCEL_ENV", originalEnv.VERCEL_ENV);
    vi.resetModules();
  });

  it("serves the public sign-in request with only standard publishable and secret keys", async () => {
    process.env.AGENTBAY_AUTH_TRANSITION_MODE = "clerk";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = SYNTHETIC_PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED = "1";
    process.env.CLERK_SECRET_KEY = SYNTHETIC_SECRET_KEY;
    delete process.env.CLERK_ENCRYPTION_KEY;
    delete process.env.AGENTBAY_OPERATOR_PASSWORD;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    vi.resetModules();

    const { proxy } = await import("@/proxy");
    const response = await proxy(new NextRequest("http://localhost/sign-in"), {} as NextFetchEvent);

    expect(response.status).toBe(200);
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
